/**
 * 远程机器的 Claude Code / Codex 统一配置（`src/main/agentProfile.ts`）。
 *
 * 守的是：种子能读（几种写法都认）、差异计算、settings 合并保留远端独有键 / 凭证键、占位按机器填、
 * `excludeLocalOnly`（含本机 MCP）永远不下发、备份先于一切写入、探测不把凭证的值带出远端。
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  parseClaudeProfile, parseCodexProfile, readProfileFile, saveProfileText, readLocalRules, profileFile, rulesDir,
  desiredSettings, mergeSettings, fillPlaceholders, matchesExcluded, excludedPatterns, isCredentialKey, CRED_KEY_RE_SRC,
  computeDiff, buildSyncPlan, backupScript, runProfileSync, applyJs, probeJs, parseProbeOutput, parseApplyOutput,
  mergeCodexTopKeys, onlyTopKeyLinesChanged, codexPlan, resolveMarketplace, collectMarketplaceFiles, pinsEnv, remotePinCommand, remoteApplyCommand, normalizeVersions, replaceHome, planHasWork, tomlLineStates,
  CLAUDE_PROFILE_TEMPLATE, CODEX_PROFILE_TEMPLATE, type ProbeResult, type ClaudeProfile,
} from '../src/main/agentProfile.ts';

const tmps: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-agentprofile-'));
  tmps.push(d);
  return d;
}
afterEach(() => { while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true }); });

/** 和用户那份种子同一个形状（本机助手生成的 profile.json）。 */
const SEED = {
  versions: { 'claude-code': '2.1.308', 'claude-agent-acp': '0.94.0', codex: '0.163.0', 'codex-acp': '2.2.2' },
  settings: {
    env: {
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_REGION: '{{AWS_REGION}}',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'global.anthropic.claude-opus-5-5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'global.anthropic.claude-sonnet-5-5',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'global.anthropic.claude-haiku-5-5',
    },
    model: 'opus',
    permissions: { deny: ['Read(~/.aws/**)', 'Read(~/.ssh/**)'] },
    outputStyle: 'Explanatory',
    includeCoAuthoredBy: false,
    skipDangerousModePermissionPrompt: true,
    theme: 'dark',
    enabledPlugins: { 'superpowers@aim': true, 'frontend@claude-plugins-official': true },
    mcpServers: { local: { command: '/Users/me/bin/mcp' } },
    statusLine: { type: 'command', command: '/Users/me/.claude/statusline.sh' },
    _meshclaw_managed_hooks: { a: 1 },
  },
  marketplaces: {
    aim: { copyFrom: '~/.aim/cc-plugins' },
    'claude-plugins-official': { source: { source: 'github', repo: 'anthropics/claude-plugins-official' } },
  },
  excludeLocalOnly: ['mcpServers（本机 MCP）', 'statusLine', '_meshclaw_managed*', 'env.ANTHROPIC_BASE_URL', { key: 'env.ANTHROPIC_SMALL_FAST_MODEL', why: 'Mac 网关专用' }],
};

function seedProfile(): ClaudeProfile {
  const r = parseClaudeProfile(JSON.stringify(SEED));
  assert.ok(r.ok);
  return r.profile;
}

function probe(over: Partial<ProbeResult> = {}): ProbeResult {
  return {
    home: '/home/ec2-user', user: 'ec2-user', region: 'ap-northeast-1',
    tools: {
      'claude-code': { path: '/home/ec2-user/.local/bin/claude', version: '2.1.289' },
      'claude-agent-acp': { path: '/home/ec2-user/.local/bin/claude-agent-acp', version: '0.85.1' },
      codex: { path: null, version: null },
      'codex-acp': { path: null, version: null },
    },
    settingsExists: true,
    settings: { model: 'sonnet', theme: 'light', env: { AWS_PROFILE: 'work' } },
    secretEnvKeys: ['ANTHROPIC_API_KEY'],
    plugins: ['frontend@claude-plugins-official'],
    marketplaces: ['claude-plugins-official'],
    rules: [],
    codexTop: null,
    codexProviders: [],
    ...over,
  };
}

describe('种子能读', () => {
  test('用户那份种子：版本、settings、市场、排除项都认得', () => {
    const p = seedProfile();
    assert.deepEqual(p.versions, SEED.versions);
    assert.equal(p.settings.model, 'opus');
    assert.deepEqual(p.marketplaces.map((m) => m.name), ['aim', 'claude-plugins-official']);
    assert.equal(p.marketplaces[0].copyFrom, '~/.aim/cc-plugins');
    /* 说明文字被去掉，只留键；对象形式也认 */
    assert.deepEqual(p.excludeLocalOnly, ['mcpServers', 'statusLine', '_meshclaw_managed*', 'env.ANTHROPIC_BASE_URL', 'env.ANTHROPIC_SMALL_FAST_MODEL']);
  });

  test('版本键可以写包名或命令名；不像版本号的值不收（它要拼进远端命令行）', () => {
    assert.deepEqual(normalizeVersions({ '@anthropic-ai/claude-code': 'v2.1.308', 'codex-acp': '2.2.2; rm -rf ~', claude: 'latest' }), { 'claude-code': '2.1.308' });
  });

  test('分组写法的 excludeLocalOnly（env 一组）也认；市场写成列表 / 字符串也认', () => {
    const r = parseClaudeProfile(JSON.stringify({ excludeLocalOnly: { env: ['ANTHROPIC_BASE_URL'], settings: ['statusLine'] }, marketplaces: ['aim', { name: 'x', repo: 'o/r' }] }));
    assert.ok(r.ok);
    assert.deepEqual(r.profile.excludeLocalOnly, ['env.ANTHROPIC_BASE_URL', 'statusLine']);
    assert.deepEqual(r.profile.marketplaces, [{ name: 'aim' }, { name: 'x', source: { source: 'github', repo: 'o/r' } }]);
  });

  test('从磁盘读：profile.json + rules/*.md', () => {
    const home = tmp();
    fs.mkdirSync(rulesDir(home), { recursive: true });
    fs.writeFileSync(profileFile(home, 'claude'), JSON.stringify(SEED));
    fs.writeFileSync(path.join(rulesDir(home), 'prod-safety.md'), '# 生产安全\n');
    fs.writeFileSync(path.join(rulesDir(home), 'notes.txt'), 'not a rule');
    const f = readProfileFile(home, 'claude');
    assert.equal(f.exists, true);
    assert.equal(f.error, undefined);
    assert.deepEqual(readLocalRules(home).map((r) => r.name), ['prod-safety.md']);
  });

  test('两份模板本身都能通过解析', () => {
    assert.ok(parseClaudeProfile(CLAUDE_PROFILE_TEMPLATE).ok);
    const c = parseCodexProfile(CODEX_PROFILE_TEMPLATE);
    assert.ok(c.ok);
    assert.equal(c.profile.config.model_provider, 'amazon-bedrock');
  });
});

describe('保存：坏 JSON 不保存', () => {
  test('解析不过 → 不写盘，原文件不动', () => {
    const home = tmp();
    assert.ok(saveProfileText(home, 'claude', JSON.stringify(SEED)).ok);
    const before = fs.readFileSync(profileFile(home, 'claude'), 'utf-8');
    const r = saveProfileText(home, 'claude', '{ "versions": ');
    assert.equal(r.ok, false);
    assert.equal(fs.readFileSync(profileFile(home, 'claude'), 'utf-8'), before);
    assert.equal(saveProfileText(home, 'claude', '[1,2]').ok, false);
    assert.equal(saveProfileText(home, 'codex', '{"config": 3}').ok, false);
  });
});

describe('env 不能被整份换掉（连带删掉远端凭证）', () => {
  test('保存时 settings.env 是 null / 字符串 / 数组 → 拒绝', () => {
    for (const env of [null, 'x', [1]]) {
      const r = parseClaudeProfile(JSON.stringify({ settings: { env } }));
      assert.equal(r.ok, false, JSON.stringify(env));
      assert.equal(saveProfileText(tmp(), 'claude', JSON.stringify({ settings: { env } })).ok, false);
    }
  });

  test('合并时 patch 的 env 不是对象 → 远端 env（含凭证）原样保留', () => {
    const remote = { env: { ANTHROPIC_API_KEY: 'sk-remote', AWS_PROFILE: 'w' }, model: 'sonnet' };
    for (const env of [null, 'x', [1], 0]) {
      const { merged, changed } = mergeSettings(remote, { env, model: 'opus' }, { excluded: [], credRe: CRED_KEY_RE_SRC });
      assert.deepEqual(merged.env, { ANTHROPIC_API_KEY: 'sk-remote', AWS_PROFILE: 'w' }, JSON.stringify(env));
      assert.deepEqual(changed.map((c) => c.key), ['model']);
    }
  });
});

describe('保存时磁盘上的文件已经被换过 → 不覆盖', () => {
  test('打开时的原文和磁盘上不一样了 → 拒绝、文件不动；一样 → 照常写', () => {
    const home = tmp();
    assert.ok(saveProfileText(home, 'claude', '{"versions":{}}').ok);
    fs.writeFileSync(profileFile(home, 'claude'), '{"pulled":"from S3"}');
    const r = saveProfileText(home, 'claude', '{"mine":1}', { expected: '{"versions":{}}' });
    assert.equal(r.ok, false);
    assert.equal(fs.readFileSync(profileFile(home, 'claude'), 'utf-8'), '{"pulled":"from S3"}');
    assert.ok(saveProfileText(home, 'claude', '{"mine":1}', { expected: '{"pulled":"from S3"}' }).ok);
    /* 打开时还没有文件（expected = null），存之前却被拉回来一份 → 也不盖 */
    const h2 = tmp();
    fs.mkdirSync(path.dirname(profileFile(h2, 'codex')), { recursive: true });
    fs.writeFileSync(profileFile(h2, 'codex'), '{}');
    assert.equal(saveProfileText(h2, 'codex', '{"config":{}}', { expected: null }).ok, false);
    assert.ok(saveProfileText(tmp(), 'codex', '{"config":{}}', { expected: null }).ok);
  });
});

describe('排除 / 凭证 / 占位', () => {
  test('凭证键按词认', () => {
    for (const k of ['ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'experimental_bearer_token']) assert.ok(isCredentialKey(k), k);
    for (const k of ['MAX_THINKING_TOKENS', 'AWS_REGION', 'CLAUDE_CODE_USE_BEDROCK', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SKIP_BEDROCK_AUTH']) assert.ok(!isCredentialKey(k), k);
  });

  test('排除模式：前缀、通配、不带点的模式也管 env 的同名键', () => {
    const pats = ['mcpServers', '_meshclaw_managed*', 'ANTHROPIC_BASE_URL'];
    assert.ok(matchesExcluded('mcpServers', pats));
    assert.ok(matchesExcluded('mcpServers.local', pats));
    assert.ok(matchesExcluded('_meshclaw_managed_hooks', pats));
    assert.ok(matchesExcluded('env.ANTHROPIC_BASE_URL', pats));
    assert.ok(!matchesExcluded('env.AWS_REGION', pats));
    assert.ok(!matchesExcluded('model', pats));
  });

  test('占位：有值就填，没值记下来', () => {
    assert.deepEqual(fillPlaceholders('{{AWS_REGION}}', { AWS_REGION: 'ap-northeast-1' }), { value: 'ap-northeast-1', unresolved: [] });
    assert.deepEqual(fillPlaceholders('a {{ NOPE }} b', {}), { value: 'a {{ NOPE }} b', unresolved: ['NOPE'] });
  });

  test('desiredSettings：AWS_REGION 按机器填；本机专用 MCP / statusLine / _meshclaw_managed* / 网关地址永不下发；凭证类 env 不下发', () => {
    const p = seedProfile();
    (p.settings.env as any).ANTHROPIC_BASE_URL = 'https://gw.mac.local';
    (p.settings.env as any).ANTHROPIC_API_KEY = 'sk-mac';
    const { patch, skipped } = desiredSettings(p, { AWS_REGION: 'ap-northeast-1' });
    assert.equal((patch.env as any).AWS_REGION, 'ap-northeast-1');
    for (const k of ['mcpServers', 'statusLine', '_meshclaw_managed_hooks']) assert.ok(!(k in patch), k);
    assert.ok(!('ANTHROPIC_BASE_URL' in (patch.env as any)));
    assert.ok(!('ANTHROPIC_API_KEY' in (patch.env as any)));
    assert.ok(!JSON.stringify(patch).includes('sk-mac'));
    assert.ok(skipped.some((s) => s.key === 'env.ANTHROPIC_API_KEY' && s.why === 'credential'));
  });

  test('mcpServers 就算种子的 excludeLocalOnly 里没写也永不下发', () => {
    const r = parseClaudeProfile(JSON.stringify({ settings: { mcpServers: { a: { command: 'x' } }, apiKeyHelper: '/Users/me/key.sh', theme: 'dark' } }));
    assert.ok(r.ok);
    const { patch } = desiredSettings(r.profile, {});
    assert.deepEqual(patch, { theme: 'dark' });
    assert.ok(excludedPatterns(r.profile).includes('mcpServers'));
  });

  test('占位填不上的那个键这次不下发（不把 {{AWS_REGION}} 原样写到远端）', () => {
    const { patch, skipped } = desiredSettings(seedProfile(), {});
    assert.ok(!('AWS_REGION' in (patch.env as any)));
    assert.deepEqual(skipped.find((s) => s.why === 'placeholder'), { key: 'env.AWS_REGION', why: 'placeholder', names: ['AWS_REGION'] });
  });

  test('settings 里的本机家目录换成远端家目录', () => {
    const r = parseClaudeProfile(JSON.stringify({ settings: { hooks: { Stop: [{ command: '/Users/me/.claude/hooks/stop.sh' }] } } }));
    assert.ok(r.ok);
    const { patch } = desiredSettings(r.profile, {}, { localHome: '/Users/me', remoteHome: '/home/ec2-user' });
    assert.equal((patch.hooks as any).Stop[0].command, '/home/ec2-user/.claude/hooks/stop.sh');
  });
});

describe('settings 合并', () => {
  const opts = { excluded: ['mcpServers', 'statusLine'], credRe: CRED_KEY_RE_SRC };

  test('配置里有的键覆盖，远端独有的保留；env 逐键合并', () => {
    const remote = { model: 'sonnet', feedbackSurveyState: { x: 1 }, env: { AWS_PROFILE: 'work', AWS_REGION: 'us-west-2' }, permissions: { allow: ['Bash(ls)'], deny: ['old'] } };
    const { merged, changed } = mergeSettings(remote, { model: 'opus', env: { AWS_REGION: 'ap-northeast-1', CLAUDE_CODE_USE_BEDROCK: '1' }, permissions: { deny: ['Read(~/.aws/**)'] } }, opts);
    assert.deepEqual(merged, {
      model: 'opus', feedbackSurveyState: { x: 1 },
      env: { AWS_PROFILE: 'work', AWS_REGION: 'ap-northeast-1', CLAUDE_CODE_USE_BEDROCK: '1' },
      permissions: { allow: ['Bash(ls)'], deny: ['Read(~/.aws/**)'] },
    });
    assert.deepEqual(changed.map((c) => c.key).sort(), ['env.AWS_REGION', 'env.CLAUDE_CODE_USE_BEDROCK', 'model', 'permissions.deny']);
  });

  test('凭证类 env 不删不改（哪怕 patch 里有同名键 —— 双保险）', () => {
    const remote = { env: { ANTHROPIC_API_KEY: 'sk-remote', AWS_SECRET_ACCESS_KEY: 'remote-secret' } };
    const { merged, changed } = mergeSettings(remote, { env: { ANTHROPIC_API_KEY: 'sk-mac', X: '1' } }, opts);
    assert.equal(merged.env.ANTHROPIC_API_KEY, 'sk-remote');
    assert.equal(merged.env.AWS_SECRET_ACCESS_KEY, 'remote-secret');
    assert.deepEqual(changed.map((c) => c.key), ['env.X']);
  });

  test('被排除的键不碰：远端自己的 mcpServers 原样留着', () => {
    const remote = { mcpServers: { remoteOnly: { command: 'r' } } };
    const { merged, changed } = mergeSettings(remote, { mcpServers: { mac: { command: 'm' } }, statusLine: { x: 1 } }, opts);
    assert.deepEqual(merged, { mcpServers: { remoteOnly: { command: 'r' } } });
    assert.equal(changed.length, 0);
  });

  test('一样的就不算改动（键顺序无关）', () => {
    const { changed } = mergeSettings({ permissions: { deny: ['a'] }, x: { b: 1, a: 2 } }, { permissions: { deny: ['a'] }, x: { a: 2, b: 1 } }, opts);
    assert.equal(changed.length, 0);
  });
});

describe('差异', () => {
  test('tokyo-ec2 那样的机器：版本、settings 各键、插件、市场、rules、适配器都列出来', () => {
    const items = computeDiff({ claude: seedProfile(), codex: null, localRules: [{ name: 'prod-safety.md', hash: 'h1' }], probe: probe() });
    const by = (area: string) => items.filter((i) => i.area === area).map((i) => `${i.key}:${i.status}`);
    assert.deepEqual(by('version'), ['claude-code:different', 'claude-agent-acp:different', 'codex:missing']);
    assert.deepEqual(by('adapter'), ['codex-acp:missing']);
    assert.ok(by('settings').includes('model:different'));
    assert.ok(by('settings').includes('env.AWS_REGION:missing'));
    assert.ok(by('settings').includes('outputStyle:missing'));
    assert.deepEqual(by('plugin'), ['superpowers@aim:missing', 'frontend@claude-plugins-official:different']);
    assert.deepEqual(by('marketplace'), ['aim:missing']);
    assert.deepEqual(by('rule'), ['prod-safety.md:missing']);
    /* 本机专用的永远不出现在差异里 */
    assert.ok(!items.some((i) => /mcpServers|statusLine|_meshclaw/.test(i.key)));
    const region = items.find((i) => i.key === 'env.AWS_REGION');
    assert.equal(region?.want, 'ap-northeast-1');
  });

  test('凭证类 env 根本不在比较里（远端只报了键名）', () => {
    const items = computeDiff({ claude: seedProfile(), codex: null, localRules: [], probe: probe() });
    assert.ok(!items.some((i) => /API_KEY/.test(i.key)));
  });

  test('和配置一致 → 差异为空', () => {
    const p = seedProfile();
    const { patch } = desiredSettings(p, { AWS_REGION: 'ap-northeast-1' });
    const synced = probe({
      tools: {
        'claude-code': { path: '/x/claude', version: '2.1.308' }, 'claude-agent-acp': { path: '/x/a', version: '0.94.0' },
        codex: { path: '/x/codex', version: '0.163.0' }, 'codex-acp': { path: '/x/c', version: '2.2.2' },
      },
      settings: mergeSettings({ env: { AWS_PROFILE: 'work' } }, patch, { excluded: excludedPatterns(p), credRe: CRED_KEY_RE_SRC }).merged,
      plugins: ['superpowers@aim', 'frontend@claude-plugins-official'],
      marketplaces: ['aim', 'claude-plugins-official'],
      rules: [{ name: 'prod-safety.md', hash: 'h1' }, { name: 'remote-extra.md', hash: 'zz' }],
    });
    assert.deepEqual(computeDiff({ claude: p, codex: null, localRules: [{ name: 'prod-safety.md', hash: 'h1' }], probe: synced }), []);
  });

  test('区域拿不到 → 报一条「占位填不上」，不当成要写的值', () => {
    const items = computeDiff({ claude: seedProfile(), codex: null, localRules: [], probe: probe({ region: null }) });
    assert.ok(items.some((i) => i.area === 'warning' && i.key === 'env.AWS_REGION' && i.status === 'unresolved'));
    assert.ok(!items.some((i) => i.area === 'settings' && i.key === 'env.AWS_REGION'));
  });

  test('远端 settings.json 坏了 → 报错误，不报一堆假差异', () => {
    const items = computeDiff({ claude: seedProfile(), codex: null, localRules: [], probe: probe({ settings: null, settingsError: 'unparsable' }) });
    assert.ok(items.some((i) => i.area === 'settings' && i.status === 'error'));
    assert.ok(!items.some((i) => i.area === 'settings' && i.key === 'model'));
  });

  test('Codex：版本 + 顶层的 model / model_provider；provider 的嵌套项远端没有那张表 →「需手动配置」', () => {
    const c = parseCodexProfile(CODEX_PROFILE_TEMPLATE);
    assert.ok(c.ok);
    const items = computeDiff({
      claude: null, codex: c.profile, localRules: [],
      probe: probe({ codexTop: [{ key: 'model', value: 'gpt-5', plain: true }], codexProviders: [] }),
    });
    assert.deepEqual(items.map((i) => `${i.area}:${i.key}:${i.status}`), [
      'version:codex:missing', 'adapter:codex-acp:missing', 'codex:model:different', 'codex:model_provider:missing',
      'codex:model_providers.amazon-bedrock.aws.region:manual',
    ]);
    /* 远端已经有 [model_providers.amazon-bedrock]：不读它的内容、不比较 → 嵌套项不再报 */
    const withTable = computeDiff({ claude: null, codex: c.profile, localRules: [], probe: probe({ codexTop: [], codexProviders: ['amazon-bedrock'] }) });
    assert.ok(!withTable.some((i) => i.status === 'manual'));
    /* 顶层那一行不是单行普通字符串 / 写了两次 →「需手动配置」，同步不碰 */
    const odd = computeDiff({ claude: null, codex: c.profile, localRules: [], probe: probe({ codexTop: [{ key: 'model', value: "model = 'x'", plain: false }], codexProviders: ['amazon-bedrock'] }) });
    assert.deepEqual(odd.filter((i) => i.area === 'codex').map((i) => `${i.key}:${i.status}`), ['model:manual', 'model_provider:missing']);
    const plan = buildSyncPlan({ claude: null, codex: c.profile, localRules: [], localRulesFull: [], probe: probe(), items: odd, now: new Date(2026, 9, 22, 9, 5, 7) });
    assert.deepEqual(plan.codexEntries, [{ key: 'model_provider', value: 'amazon-bedrock' }]);
  });

  test('只剩「需手动配置」的差异 → 没有要同步的', () => {
    const c = parseCodexProfile(CODEX_PROFILE_TEMPLATE);
    assert.ok(c.ok);
    const items = [{ area: 'codex' as const, key: 'model_providers.amazon-bedrock.aws.region', status: 'manual' as const, want: 'us-east-1' }];
    const plan = buildSyncPlan({ claude: null, codex: c.profile, localRules: [], localRulesFull: [], probe: probe({ tools: { codex: { path: '/x', version: '0.163.0' }, 'codex-acp': { path: '/y', version: '2.2.2' } } }), items, now: new Date() });
    assert.equal(planHasWork(plan), false);
  });
});

describe('Codex 下发范围：只有顶层 model / model_provider，本机 MCP 和认证头永不下发', () => {
  test('codexPlan：只有顶层两项会自动同步；嵌套项只列为手动；mcp_servers、认证头、bearer token、范围外的键都不出现', () => {
    const c = parseCodexProfile(JSON.stringify({ config: {
      model: 'openai.gpt-6.1-sol', model_provider: 'bedrock', approval_policy: 'never',
      mcp_servers: { local: { command: '/Users/me/bin/mcp' } },
      model_providers: { bedrock: { name: 'Bedrock', aws: { region: 'us-east-1' }, http_headers: { Authorization: 'Bearer secret' }, experimental_bearer_token: 'tok', env_http_headers: { X: 'Y' } } },
    } }));
    assert.ok(c.ok);
    const p = codexPlan(c.profile);
    assert.deepEqual(p.top, [{ key: 'model', value: 'openai.gpt-6.1-sol' }, { key: 'model_provider', value: 'bedrock' }]);
    assert.deepEqual(p.manual.map((m) => m.path).sort(), ['model_providers.bedrock.aws.region', 'model_providers.bedrock.name']);
    const items = computeDiff({ claude: null, codex: c.profile, localRules: [], probe: probe({ codexTop: [], codexProviders: [] }) });
    const plan = buildSyncPlan({ claude: null, codex: c.profile, localRules: [], localRulesFull: [], probe: probe(), items, now: new Date(2026, 9, 22, 9, 5, 7) });
    const js = applyJs({ stamp: plan.stamp, settingsPatch: null, excluded: [], credRe: CRED_KEY_RE_SRC, rules: [], files: [], marketplaces: [], plugins: [], codexEntries: plan.codexEntries });
    assert.ok(!js.includes('Bearer secret') && !js.includes('/Users/me/bin/mcp') && !js.includes('"tok"'));
    /* 嵌套项不进下发列表（只在差异里提示手动配） */
    assert.deepEqual(plan.codexEntries.map((e) => e.key), ['model', 'model_provider']);
    assert.ok(!items.some((i) => /mcp_servers|http_headers|bearer|approval/.test(i.key)));
  });

  test('isCredentialKey 认 Authorization / *_HEADERS', () => {
    assert.ok(isCredentialKey('Authorization'));
    assert.ok(isCredentialKey('http_headers'));
    assert.ok(isCredentialKey('ANTHROPIC_CUSTOM_HEADERS'));
  });
});

describe('关闭插件也要同步', () => {
  test('配置里 x@aim=false、远端还是 true → 列为差异、要执行，写进去的是 false', () => {
    const r = parseClaudeProfile(JSON.stringify({ settings: { enabledPlugins: { 'x@aim': false } } }));
    assert.ok(r.ok);
    const pr = probe({ settings: { enabledPlugins: { 'x@aim': true } }, plugins: ['x@aim'], marketplaces: ['aim'] });
    const items = computeDiff({ claude: r.profile, codex: null, localRules: [], probe: pr });
    const plugin = items.filter((i) => i.area === 'plugin');
    assert.deepEqual(plugin, [{ area: 'plugin', key: 'x@aim', status: 'different', want: 'disabled', have: 'enabled' }]);
    const plan = buildSyncPlan({ claude: r.profile, codex: null, localRules: [], localRulesFull: [], probe: pr, items, now: new Date(2026, 9, 22, 9, 5, 7) });
    assert.ok(planHasWork(plan));
    assert.deepEqual(plan.plugins, []);
    assert.deepEqual(plan.settingsPatch.enabledPlugins, { 'x@aim': false });
    assert.equal(mergeSettings(pr.settings, plan.settingsPatch, { excluded: plan.excluded, credRe: CRED_KEY_RE_SRC }).merged.enabledPlugins['x@aim'], false);
    /* 远端已经是 false → 没有差异 */
    assert.deepEqual(computeDiff({ claude: r.profile, codex: null, localRules: [], probe: probe({ settings: { enabledPlugins: { 'x@aim': false } }, plugins: ['x@aim'], marketplaces: ['aim'] }) }).filter((i) => i.area !== 'version' && i.area !== 'adapter'), []);
  });
});

describe('config.toml：只改最顶层的 model / model_provider 两行', () => {
  const ENTRIES = [{ key: 'model', value: 'new-model' }, { key: 'model_provider', value: 'amazon-bedrock' }];
  /** 去掉顶层的 model / model_provider 行之后剩下的（逐字节比较「其余行不变」用） */
  const rest = (s: string) => {
    const lines = s.split('\n');
    const st = tomlLineStates(lines.map((l) => l.replace(/\r$/, '')));
    let header = false;
    return lines.filter((l, i) => {
      if (!st.inside[i] && /^\s*\[/.test(l)) header = true;
      return header || st.inside[i] || !/^\s*"?(model|model_provider)"?\s*=\s*"/.test(l);
    }).join('\n');
  };

  /* 以前写坏过文件的 5 类原文（多行字符串、点号键、内联表、数组表、转义引号），外加一个带转义引号的键 */
  const BROKE_BEFORE: Record<string, string> = {
    '多行字符串': '[model_providers.amazon-bedrock]\nname = """\nAmazon Bedrock\n"""\n',
    '点号键': '[model_providers.amazon-bedrock]\naws.profile = "x"\naws.region = "us-west-2"\n',
    '内联表': '[model_providers]\namazon-bedrock = { aws = { region = "us-west-2" } }\n',
    '数组表': '[[model_providers.b.aws]]\nregion = "us-west-2"\n',
    '转义引号': 'instructions = """\na \\""" b\nmodel = "inside"\n"""\nmodel = "old"\n[t]\nx = 1\n',
    '转义引号的键': '"we\\"ird" = 1\n[model_providers.x]\nname = "X"\n',
  };
  for (const [name, before] of Object.entries(BROKE_BEFORE)) {
    test(`以前写坏过的写法（${name}）：同步后除了那两行，其余逐字节不变；任何表 / 表头都没动`, () => {
      const r = mergeCodexTopKeys(before, ENTRIES);
      assert.equal(rest(r.text), rest(before), name);
      assert.ok(onlyTopKeyLinesChanged(before, r.text), name);
      assert.equal((r.text.match(/^\s*\[/gm) || []).length, (before.match(/^\s*\[/gm) || []).length, name);
      assert.deepEqual(r.skipped, [], name);
      assert.deepEqual(r.changed.sort(), ['model', 'model_provider'], name);
    });
  }

  test('转义引号那份：改的是字符串后面真正的顶层 model，字符串里的那行原样', () => {
    const before = BROKE_BEFORE['转义引号'];
    const r = mergeCodexTopKeys(before, [{ key: 'model', value: 'new' }]);
    assert.equal(r.text, before.replace('\nmodel = "old"\n', '\nmodel = "new"\n'));
  });

  /** 顶层有几个键解出来是 model（含带转义的引号键）—— 同步后必须还是至多一个 */
  const modelKeys = (s: string) => s.split('\n').filter((l) => {
    const q = /^\s*("(?:[^"\\]|\\.)*")\s*[.=]/.exec(l);
    if (q) { try { return JSON.parse(q[1]) === 'model'; } catch { return false; } }
    return /^\s*model\s*[.=]/.test(l);
  }).length;

  test('带 Unicode 转义的引号键（"mo\\u0064el" 就是 model）→ model 不改不插、原文那行不动；model_provider 照常', () => {
    const before = '"mo\\u0064el" = "old"\n[t]\nx = 1\n';
    const r = mergeCodexTopKeys(before, ENTRIES);
    assert.deepEqual(r.skipped, ['model']);
    assert.deepEqual(r.changed, ['model_provider']);
    assert.equal(r.text, 'model_provider = "amazon-bedrock"\n' + before);
    assert.equal(modelKeys(r.text), 1);
    /* 只同步 model 时：原文一个字不动 */
    const only = mergeCodexTopKeys(before, [{ key: 'model', value: 'new' }]);
    assert.deepEqual(only, { text: before, changed: [], skipped: ['model'] });
  });

  test('转义解不出来（\\U…）→ 说不准是哪个键：两项都不动、原文不动', () => {
    const before = '"\\U0000006Dodel" = "old"\n';
    assert.deepEqual(mergeCodexTopKeys(before, ENTRIES), { text: before, changed: [], skipped: ['model', 'model_provider'] });
  });

  test('点号键的第一段是带转义的 model（"mo\\u0064el".x）→ model 也不插', () => {
    const before = '"mo\\u0064el".x = 1\n';
    const r = mergeCodexTopKeys(before, [{ key: 'model', value: 'new' }]);
    assert.equal(r.text, before);
    assert.deepEqual(r.skipped, ['model']);
  });

  test('严格校验：原文顶层有解出来是 model 的转义引号键时，插 model 不认；解不出来的转义键时任何改动都不认', () => {
    assert.equal(onlyTopKeyLinesChanged('"mo\\u0064el" = "old"\n', 'model = "new"\n"mo\\u0064el" = "old"\n'), false);
    assert.equal(onlyTopKeyLinesChanged('"mo\\u0064el" = "old"\n', 'model_provider = "p"\n"mo\\u0064el" = "old"\n'), true);
    assert.equal(onlyTopKeyLinesChanged('"\\U0000006Dodel" = "old"\n', 'model_provider = "p"\n"\\U0000006Dodel" = "old"\n'), false);
  });

  test('差异：远端顶层是带转义的 model 引号键 →「需手动配置」，同步计划里没有它', () => {
    const c = parseCodexProfile(CODEX_PROFILE_TEMPLATE);
    assert.ok(c.ok);
    const items = computeDiff({ claude: null, codex: c.profile, localRules: [], probe: probe({ codexTop: [{ key: 'model', value: '"mo\\u0064el" = "old"', plain: false }], codexProviders: ['amazon-bedrock'] }) });
    assert.deepEqual(items.filter((i) => i.area === 'codex').map((i) => `${i.key}:${i.status}`), ['model:manual', 'model_provider:missing']);
    const plan = buildSyncPlan({ claude: null, codex: c.profile, localRules: [], localRulesFull: [], probe: probe(), items, now: new Date() });
    assert.deepEqual(plan.codexEntries.map((e) => e.key), ['model_provider']);
  });

  test('顶层多行字符串里有像表头的行、真正的 model 在它后面 → 严格校验不认（它不解析字符串），整份不改、记成跳过', () => {
    const before = 'instructions = """\n[model_providers.fake]\n"""\nmodel = "old"\n';
    const r = mergeCodexTopKeys(before, [{ key: 'model', value: 'new' }]);
    assert.equal(r.text, before);
    assert.deepEqual(r.skipped, ['model']);
  });

  test('已有一行普通字符串 → 只换值：缩进、等号两边的空白、行尾注释原样', () => {
    const before = '# 头注释\n  model   =  "gpt-5"   # 旧的\nmodel_provider="openai"\n[x]\nmodel = "under-table"\n';
    const r = mergeCodexTopKeys(before, ENTRIES);
    assert.equal(r.text, '# 头注释\n  model   =  "new-model"   # 旧的\nmodel_provider="amazon-bedrock"\n[x]\nmodel = "under-table"\n');
  });

  test('没有 → 插到文件最开头（在第一个表头之前）；表里同名的键不算顶层的', () => {
    const before = '# c\n[x]\nmodel = "under-table"\n';
    const r = mergeCodexTopKeys(before, ENTRIES);
    assert.equal(r.text, 'model = "new-model"\nmodel_provider = "amazon-bedrock"\n# c\n[x]\nmodel = "under-table"\n');
    assert.equal(mergeCodexTopKeys('', [{ key: 'model', value: 'm' }]).text, 'model = "m"\n');
  });

  test('一样的就不动；值里的特殊字符正确转义', () => {
    const same = 'model = "new-model"\nmodel_provider = "amazon-bedrock"\n';
    assert.deepEqual(mergeCodexTopKeys(same, ENTRIES), { text: same, changed: [], skipped: [] });
    const r = mergeCodexTopKeys('', [{ key: 'model', value: 'a"b\\c' }]);
    assert.equal(r.text, 'model = "a\\"b\\\\c"\n');
  });

  test('顶层那一行不是单行普通字符串 / 写了两次 / 点号键 → 不动、记进 skipped', () => {
    for (const before of [
      "model = 'literal'\n",
      'model = """\nmulti\n"""\n',
      'model = "a"\nmodel = "b"\n',
      'model.x = 1\n',
      "'model' = \"q\"\n",
    ]) {
      const r = mergeCodexTopKeys(before, [{ key: 'model', value: 'new' }]);
      assert.equal(r.text, before, before);
      assert.deepEqual(r.skipped, ['model'], before);
    }
  });

  test('只认 model / model_provider 两个字符串键：别的键、嵌套路径、非字符串值一律跳过，不加任何表', () => {
    const before = '[a]\nx = 1\n';
    const r = mergeCodexTopKeys(before, [{ key: 'region', value: 'us-east-1' }, { key: 'model_providers.b.aws.region', value: 'x' }, { key: 'model', value: 3 }, { key: 'model', value: 'a\nb' }]);
    assert.equal(r.text, before);
    assert.equal(r.skipped.length, 4);
  });

  test('CRLF 文件逐字节保留；BOM 开头的文件不往最前面插', () => {
    const before = 'model = "old"\r\n[t]\r\nx = 1\r\n';
    assert.equal(mergeCodexTopKeys(before, [{ key: 'model', value: 'new' }]).text, 'model = "new"\r\n[t]\r\nx = 1\r\n');
    assert.equal(mergeCodexTopKeys('[t]\r\n', [{ key: 'model', value: 'm' }]).text, 'model = "m"\r\n[t]\r\n');
    const bom = '\ufeff[t]\nx = 1\n';
    const r = mergeCodexTopKeys(bom, [{ key: 'model', value: 'm' }]);
    assert.equal(r.text, bom);
    assert.deepEqual(r.skipped, ['model']);
  });

  test('严格校验：除了那两行还有任何不同 → false', () => {
    const o = 'model = "a"\n[t]\nx = 1\n';
    assert.ok(onlyTopKeyLinesChanged(o, 'model = "b"\n[t]\nx = 1\n'));
    assert.ok(onlyTopKeyLinesChanged(o, 'model_provider = "p"\nmodel = "b"\n[t]\nx = 1\n'));
    for (const bad of [
      'model = "a"\n[t]\nx = 2\n',                  // 别的行变了
      'model = "a"\n[t]\nx = 1\n[u]\n',             // 多了表头
      '[s]\nmodel = "a"\n[t]\nx = 1\n',             // 插的不是那两个键
      'model = "a"\nmodel = "c"\n[t]\nx = 1\n',     // 同一个键出现两次
      'model = "b"\r\n[t]\nx = 1\n',                // 换行符变了
      'model = "a"\n[t]\nx = 1',                     // 少了最后的换行
    ]) assert.equal(onlyTopKeyLinesChanged(o, bad), false, bad);
    /* 表头之后的同名行改了也不行 */
    assert.equal(onlyTopKeyLinesChanged('[t]\nmodel = "a"\n', '[t]\nmodel = "b"\n'), false);
  });

  test('兜底：严格校验不通过 → 整份不改、全部记成跳过', () => {
    const before = 'model = "a"\n';
    const r = mergeCodexTopKeys(before, ENTRIES, tomlLineStates, () => false);
    assert.deepEqual(r, { text: before, changed: [], skipped: ['model', 'model_provider'] });
  });

  test('tomlLineStates：跨行数组 / 内联表 / 多行字符串的范围', () => {
    const lines = ['a = [', '  "x", # ]', '  { b = [1, 2] },', ']', 'c = """', 'd = 1', '"""', '[t]', 'e = 1'];
    const s = tomlLineStates(lines);
    assert.deepEqual(s.inside, [false, true, true, true, false, true, true, false, false]);
    assert.deepEqual(s.multi, [true, false, false, false, true, false, false, false, false]);
  });
});

describe('同步计划与编排', () => {
  test('计划：只钉版本不一样的；rules 只带有差异的；市场从本机拷，路径落到远端家目录', () => {
    const p = seedProfile();
    const pr = probe();
    const localRules = [{ name: 'prod-safety.md', content: '# 生产安全', hash: 'h1' }, { name: 'same.md', content: 'x', hash: 'h2' }];
    pr.rules = [{ name: 'same.md', hash: 'h2' }];
    const items = computeDiff({ claude: p, codex: null, localRules, probe: pr });
    const plan = buildSyncPlan({ claude: p, codex: null, localRules, localRulesFull: localRules, probe: pr, items, now: new Date(2026, 9, 22, 9, 5, 7), localHome: '/Users/me' });
    assert.equal(plan.stamp, '20261022-090507');
    assert.equal(plan.backupDir, '~/.claude/.kirolex-backup-20261022-090507');
    assert.deepEqual(plan.pins.map((x) => `${x.pkg}@${x.version}`), ['@anthropic-ai/claude-code@2.1.308', '@agentclientprotocol/claude-agent-acp@0.94.0', '@openai/codex@0.163.0', '@agentclientprotocol/codex-acp@2.2.2']);
    assert.deepEqual(plan.rules.map((r) => r.name), ['prod-safety.md']);
    assert.deepEqual(plan.plugins, ['superpowers@aim']);
    assert.deepEqual(plan.marketplaces, [{ name: 'aim', arg: '.aim/cc-plugins', copy: { localDir: path.join('/Users/me', '.aim/cc-plugins'), remoteDir: '.aim/cc-plugins' } }]);
    assert.ok(!('mcpServers' in plan.settingsPatch));
    assert.equal(pinsEnv(plan.pins).split(' ').length, 4);
    assert.match(remotePinCommand('/tmp/x.sh', plan.pins), /^cat > \/tmp\/x\.sh && PINS='@anthropic-ai\/claude-code@2\.1\.308=claude /);
  });

  test('写入脚本在登录 shell 里找 node（fnm / nvm 管的 node 只有登录 shell 看得到）', () => {
    assert.equal(remoteApplyCommand('/tmp/kirolex-profile-1.js'), "cat > /tmp/kirolex-profile-1.js && bash -lc 'node /tmp/kirolex-profile-1.js'; rc=$?; rm -f /tmp/kirolex-profile-1.js; exit $rc");
    assert.throws(() => remoteApplyCommand("/tmp/x'; rm -rf ~"));
  });

  test('只写了名字的市场去本机 known_marketplaces.json 查；查不到就跳过并说明', () => {
    const r = resolveMarketplace('aim', null, { aim: { source: { source: 'directory', path: '/Users/me/.aim/cc-plugins' } } }, '/Users/me');
    assert.equal(r?.arg, '.aim/cc-plugins');
    assert.equal(resolveMarketplace('nowhere', null, {}, '/Users/me'), null);
    assert.equal(resolveMarketplace('claude-plugins-official', null, null, '/Users/me')?.arg, 'anthropics/claude-plugins-official');
  });

  test('备份脚本：先 mkdir 备份目录，settings.json / rules / plugins 都拷，失败就非零退出', () => {
    const s = backupScript('20261022-090507');
    const mk = s.indexOf('mkdir -p "$B"');
    assert.ok(mk >= 0 && mk < s.indexOf('cp -a'));
    assert.match(s, /B="\$HOME\/\.claude\/\.kirolex-backup-20261022-090507"/);
    assert.match(s, /for x in settings\.json rules plugins/);
    assert.match(s, /exit 3/);
    assert.throws(() => backupScript('$(rm -rf ~)'));
  });

  const plan0 = () => {
    const p = seedProfile();
    const pr = probe();
    const items = computeDiff({ claude: p, codex: null, localRules: [], probe: pr });
    return buildSyncPlan({ claude: p, codex: null, localRules: [], localRulesFull: [], probe: pr, items, now: new Date(2026, 9, 22, 9, 5, 7), localHome: '/Users/me' });
  };

  test('备份不成功 → 什么都不装、什么都不写', async () => {
    const calls: string[] = [];
    const r = await runProfileSync(plan0(), {
      log: () => {},
      backup: async () => { calls.push('backup'); return { ok: false, output: 'KX_BACKUP_FAIL mkdir' }; },
      installVersions: async () => { calls.push('versions'); return { ok: true }; },
      apply: async () => { calls.push('apply'); return { ok: true, output: '' }; },
      reprobe: async () => { calls.push('reprobe'); return []; },
      payloadExtras: async () => ({ files: [], errors: [] }),
    });
    assert.equal(r.ok, false);
    assert.deepEqual(calls, ['backup']);
  });

  test('顺序：备份 → 版本 → 写入 → 重新比较；写入的 payload 不含本机 MCP', async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    let js = '';
    const r = await runProfileSync(plan0(), {
      log: (l) => logs.push(l),
      backup: async () => { calls.push('backup'); return { ok: true, output: 'KX_BACKUP_OK /home/ec2-user/.claude/.kirolex-backup-20261022-090507\n' }; },
      installVersions: async () => { calls.push('versions'); return { ok: true }; },
      apply: async (s) => { calls.push('apply'); js = s; return { ok: true, output: 'KX_APPLY {"step":"settings","ok":true}\nKX_APPLY_DONE\n' }; },
      reprobe: async () => { calls.push('reprobe'); return []; },
      payloadExtras: async () => ({ files: [], errors: [] }),
    });
    assert.deepEqual(calls, ['backup', 'versions', 'apply', 'reprobe']);
    assert.equal(r.ok, true);
    assert.deepEqual(r.after, []);
    assert.ok(!js.includes('/Users/me/bin/mcp'));
    assert.ok(!js.includes('statusline.sh'));
    assert.ok(logs.some((l) => l.includes('kirolex-backup-20261022-090507')));
  });
});

describe('远端脚本真跑一遍（本机 node，临时家目录）', () => {
  const runJs = (home: string, js: string): string => {
    const f = path.join(home, 'script.js');
    fs.writeFileSync(f, js);
    return execFileSync(process.execPath, [f], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, PATH: '' }, timeout: 60_000 });
  };

  test('探测：凭证类 env 只报键名，值不出现在输出里；本机专用键的值也不带', () => {
    const home = tmp();
    fs.mkdirSync(path.join(home, '.claude', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      model: 'sonnet', env: { ANTHROPIC_API_KEY: 'sk-SECRET-1', AWS_SECRET_ACCESS_KEY: 'SECRET-2', AWS_REGION: 'us-west-2' },
      mcpServers: { x: { headers: { Authorization: 'Bearer SECRET-3' } } }, apiKeyHelper: '/secret/helper',
    }));
    fs.writeFileSync(path.join(home, '.claude', 'rules', 'a.md'), 'A');
    fs.mkdirSync(path.join(home, '.codex'));
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "gpt-5"\nexperimental_bearer_token = "SECRET-4"\n[model_providers.amazon-bedrock.aws]\nregion = "us-east-1"\n'
      + '[model_providers.gw]\nhttp_headers = { Authorization = "Bearer SECRET-5" }\n[model_providers.gw.http_headers]\nAuthorization = "Bearer SECRET-6"\n[mcp_servers.local]\ncommand = "SECRET-7-mcp"\n'
      + '[model_providers.ml]\nname = """\n[model_providers.inner]\nregion = "SECRET-8-inside-string"\n"""\n'
      + '[model_providers.dot]\naws.region = "us-west-2"\n'
      /* 转义三引号不结束多行字符串：正文里的 model 不能被当成配置 */
      + '[model_providers.esc]\nnote = """\na \\""" b\nmodel = "SECRET-9-inside"\n"""\nname = "Esc"\n');
    const out = runJs(home, probeJs({ imds: false }));
    assert.ok(!/SECRET-\d|secret\/helper/.test(out), out);
    const p = parseProbeOutput(out);
    assert.ok(p);
    assert.deepEqual(p.secretEnvKeys.sort(), ['ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY']);
    assert.equal(p.settings?.env?.AWS_REGION, 'us-west-2');
    assert.equal(p.region, 'us-west-2');
    assert.equal(p.settings?.mcpServers, '<redacted>');
    assert.deepEqual(p.rules.map((r) => r.name), ['a.md']);
    /* 只读顶层的 model / model_provider，和有哪些 provider 表（不读表的内容；字符串里像表头的不算） */
    assert.deepEqual(p.codexTop, [{ key: 'model', value: 'gpt-5', plain: true }]);
    assert.deepEqual(p.codexProviders, ['amazon-bedrock', 'gw', 'ml', 'dot', 'esc']);
  });

  test('探测：顶层带转义的 model 引号键 → 回报成「不是普通写法」，差异里是「需手动配置」', () => {
    const home = tmp();
    fs.mkdirSync(path.join(home, '.codex'));
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '"mo\\u0064el" = "old"\n[model_providers.amazon-bedrock]\nname = "B"\n');
    const p = parseProbeOutput(runJs(home, probeJs({ imds: false })));
    assert.ok(p);
    assert.deepEqual(p.codexTop?.map((x) => `${x.key}:${x.plain}`), ['model:false']);
    const c = parseCodexProfile(CODEX_PROFILE_TEMPLATE);
    assert.ok(c.ok);
    const items = computeDiff({ claude: null, codex: c.profile, localRules: [], probe: p });
    assert.ok(items.some((i) => i.area === 'codex' && i.key === 'model' && i.status === 'manual'));
  });

  test('写入：没有备份目录就什么都不写', () => {
    const home = tmp();
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{"model":"sonnet"}');
    const js = applyJs({ stamp: '20261022-090507', settingsPatch: { model: 'opus' }, excluded: [], credRe: CRED_KEY_RE_SRC, rules: [{ name: 'r.md', content: 'x' }], files: [], marketplaces: [], plugins: [], codexEntries: null });
    let out = '';
    try { runJs(home, js); } catch (err: any) { out = String(err.stdout || ''); }
    const r = parseApplyOutput(out);
    assert.deepEqual(r.steps.map((s) => `${s.step}:${s.ok}`), ['backup-check:false']);
    assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf-8'), '{"model":"sonnet"}');
    assert.ok(!fs.existsSync(path.join(home, '.claude', 'rules')));
  });

  test('写入：合并 settings（凭证 / 远端独有键原样）、rules 同名覆盖不删多的、config.toml 合并', () => {
    const home = tmp();
    fs.mkdirSync(path.join(home, '.claude', '.kirolex-backup-20261022-090507'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude', 'rules'));
    fs.writeFileSync(path.join(home, '.claude', 'rules', 'old.md'), 'keep me');
    fs.writeFileSync(path.join(home, '.claude', 'rules', 'prod.md'), 'v1');
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'sonnet', env: { ANTHROPIC_API_KEY: 'sk-remote', AWS_PROFILE: 'w' }, mcpServers: { r: {} } }));
    fs.mkdirSync(path.join(home, '.codex'));
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "gpt-5"\n');
    const js = applyJs({
      stamp: '20261022-090507',
      settingsPatch: { model: 'opus', env: { AWS_REGION: 'ap-northeast-1' } },
      excluded: ['mcpServers'], credRe: CRED_KEY_RE_SRC,
      rules: [{ name: 'prod.md', content: 'v2' }, { name: '../evil.md', content: 'x' }],
      files: [{ rel: '.aim/cc-plugins/m.json', b64: Buffer.from('{"p":"/home/u"}').toString('base64') }, { rel: '../outside.txt', b64: '' }],
      marketplaces: [], plugins: [],
      codexEntries: [{ key: 'model_provider', value: 'amazon-bedrock' }],
    });
    const out = runJs(home, js);
    const r = parseApplyOutput(out);
    assert.equal(r.done, true);
    const s = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf-8'));
    assert.deepEqual(s, { model: 'opus', env: { ANTHROPIC_API_KEY: 'sk-remote', AWS_PROFILE: 'w', AWS_REGION: 'ap-northeast-1' }, mcpServers: { r: {} } });
    assert.equal(fs.readFileSync(path.join(home, '.claude', 'rules', 'prod.md'), 'utf-8'), 'v2');
    assert.equal(fs.readFileSync(path.join(home, '.claude', 'rules', 'old.md'), 'utf-8'), 'keep me');
    assert.ok(r.steps.some((x) => x.step === 'rule:../evil.md' && !x.ok));
    assert.ok(r.steps.some((x) => x.step === 'file:../outside.txt' && !x.ok));
    assert.ok(!fs.existsSync(path.join(path.dirname(home), 'outside.txt')));
    assert.equal(fs.readFileSync(path.join(home, '.aim', 'cc-plugins', 'm.json'), 'utf-8'), '{"p":"/home/u"}');
    /* 顶层没有 model_provider → 插到文件最开头 */
    assert.equal(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf-8'), 'model_provider = "amazon-bedrock"\nmodel = "gpt-5"\n');
  });

  test('写入：远端 settings.json 解析不了 → 不改它', () => {
    const home = tmp();
    fs.mkdirSync(path.join(home, '.claude', '.kirolex-backup-20261022-090507'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{ broken');
    const out = runJs(home, applyJs({ stamp: '20261022-090507', settingsPatch: { model: 'opus' }, excluded: [], credRe: CRED_KEY_RE_SRC, rules: [], files: [], marketplaces: [], plugins: [], codexEntries: null }));
    assert.ok(parseApplyOutput(out).steps.some((x) => x.step === 'settings' && !x.ok));
    assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf-8'), '{ broken');
  });
});

describe('目录型市场从本机拷', () => {
  test('文本里的本机家目录换成远端家目录；.git 不拷', () => {
    const home = tmp();
    const dir = path.join(home, '.aim', 'cc-plugins');
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref');
    fs.writeFileSync(path.join(dir, '.claude-plugin', 'marketplace.json'), JSON.stringify({ path: path.join(home, '.aim', 'x') }));
    fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0, 1, 2]));
    const r = collectMarketplaceFiles(dir, '.aim/cc-plugins', home, '/home/ec2-user');
    assert.ok(r.ok);
    const rels = r.files.map((f) => f.rel).sort();
    assert.deepEqual(rels, ['.aim/cc-plugins/.claude-plugin/marketplace.json', '.aim/cc-plugins/bin.dat']);
    const m = JSON.parse(Buffer.from(r.files.find((f) => f.rel.endsWith('marketplace.json'))!.b64, 'base64').toString());
    assert.ok(m.path.startsWith('/home/ec2-user'), m.path);
    assert.equal(collectMarketplaceFiles(path.join(home, 'nope'), 'x', home, '/h').ok, false);
  });

  test('家目录替换：Mac 路径直接换；JSON 转义过的 Windows 路径换进去也保持转义（不改出坏 JSON）', () => {
    assert.equal(replaceHome('{"p":"/Users/me/.aim/x"}', '/Users/me', '/home/ec2-user'), '{"p":"/home/ec2-user/.aim/x"}');
    const out = replaceHome(JSON.stringify({ p: 'C:\\Users\\me\\.aim' }), 'C:\\Users\\me', 'D:\\r\\h');
    assert.equal(JSON.parse(out).p, 'D:\\r\\h\\.aim');
    assert.equal(replaceHome('x', '/', '/h'), 'x');
  });
});
