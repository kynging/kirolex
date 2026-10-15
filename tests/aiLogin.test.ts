import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickClaudeEnv, mergeClaudeSettings, pickCodexProvider, applyCodexProvider, buildCodexProvider,
  topLevelValue, providerSection, parseClaudeStatus, parseCodexStatus, codexGateway,
} from '../src/main/aiLogin.ts';

/** 和这台电脑上那份一个形状（值是假的）。 */
const LOCAL_TOML = `model = "gpt-6.1-sol"
model_provider = "workshop"
approval_policy = "never"

[model_providers.workshop]
name = "AWS Workshop Gateway"
base_url = "https://gw.example/openai/v1"
wire_api = "responses"
http_headers = { Authorization = "Bearer sk-FAKE" }

[projects.'c:\\users\\me']
trust_level = "trusted"

[windows]
sandbox = "elevated"
`;

describe('Claude Code：只搬 settings.json 的 env 那几项', () => {
  test('取：只要网关那几个变量', () => {
    const env = pickClaudeEnv(JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'u', ANTHROPIC_API_KEY: 'k', OTHER: 'x' }, permissions: {} }));
    assert.deepEqual(env, { ANTHROPIC_BASE_URL: 'u', ANTHROPIC_API_KEY: 'k' });
  });
  test('合并：只覆盖给出的键，那台机器自己的设置原样保留；坏 JSON 当空', () => {
    const merged = JSON.parse(mergeClaudeSettings(JSON.stringify({ permissions: { allow: ['x'] }, env: { KEEP: '1', ANTHROPIC_API_KEY: 'old' } }), { ANTHROPIC_API_KEY: 'new' }));
    assert.deepEqual(merged.permissions, { allow: ['x'] });
    assert.deepEqual(merged.env, { KEEP: '1', ANTHROPIC_API_KEY: 'new' });
    assert.deepEqual(JSON.parse(mergeClaudeSettings('{oops', { A: 'b' })), { env: { A: 'b' } });
  });
});

describe('Codex：只认、只改顶层两行和一个 provider 段', () => {
  test('从本机取出当前在用的 provider（含整段原文）', () => {
    const p = pickCodexProvider(LOCAL_TOML)!;
    assert.equal(p.id, 'workshop');
    assert.equal(p.model, 'gpt-6.1-sol');
    assert.match(p.section, /^\[model_providers\.workshop\]\nname = "AWS Workshop Gateway"/);
    assert.doesNotMatch(p.section, /\[windows\]/, '段到下一个表头为止');
    assert.equal(pickCodexProvider('model = "x"\n'), undefined, '没有自定义 provider = 没东西可搬');
  });

  test('写进一份已有的 config：顶层两行换掉、旧段换新段，别的逐字保留', () => {
    const remote = `model = "old"\nmodel_provider = "openai"\nsandbox_mode = "workspace-write"\n\n[mcp_servers.foo]\ncommand = "bar"\n`;
    const out = applyCodexProvider(remote, pickCodexProvider(LOCAL_TOML)!);
    assert.equal(topLevelValue(out, 'model_provider'), 'workshop');
    assert.equal(topLevelValue(out, 'model'), 'gpt-6.1-sol');
    assert.equal(topLevelValue(out, 'sandbox_mode'), 'workspace-write', '那台机器自己的顶层设置不动');
    assert.match(out, /\[mcp_servers\.foo\]\ncommand = "bar"/);
    assert.match(providerSection(out, 'workshop'), /base_url = "https:\/\/gw\.example\/openai\/v1"/);
    assert.doesNotMatch(out, /\[windows\]/, '本机的 Windows 段不搬');
    /* 再写一次不重复（「安装 AI 工具」和这一页都可以反复点） */
    const again = applyCodexProvider(out, pickCodexProvider(LOCAL_TOML)!);
    assert.equal((again.match(/\[model_providers\.workshop\]/g) || []).length, 1);
    assert.equal((again.match(/^model_provider =/gm) || []).length, 1);
  });

  test('空文件也能写；手填的网关是一个 Bearer 头的 provider', () => {
    const p = buildCodexProvider({ baseUrl: ' https://gw.example/v1 ', token: ' sk-X ', model: 'gpt-x' });
    const out = applyCodexProvider('', p);
    assert.equal(topLevelValue(out, 'model_provider'), 'kirolex');
    assert.equal(topLevelValue(out, 'model'), 'gpt-x');
    assert.match(out, /http_headers = \{ Authorization = "Bearer sk-X" \}/);
    assert.deepEqual(codexGateway(out), { id: 'kirolex', baseUrl: 'https://gw.example/v1' });
  });
});

describe('状态（给人看的那一句里不能有密钥）', () => {
  test('claude auth status --json', () => {
    const s = parseClaudeStatus('{"loggedIn":true,"authMethod":"api_key","apiKeySource":"ANTHROPIC_API_KEY"}', 'https://gw.example/v1');
    assert.deepEqual([s.installed, s.loggedIn, s.gateway], [true, true, 'gw.example']);
    assert.equal(parseClaudeStatus('bash: claude: command not found').installed, false);
    assert.equal(parseClaudeStatus('{"loggedIn":false}').loggedIn, false);
  });
  test('codex login status：自定义网关不需要 login；key 那一截不出来', () => {
    assert.equal(parseCodexStatus('Not logged in', { id: 'workshop', baseUrl: 'https://gw.example/v1' }).loggedIn, true);
    const s = parseCodexStatus('Logged in using an API key - sk-SECRET***');
    assert.equal(s.loggedIn, true);
    assert.doesNotMatch(s.detail, /SECRET/);
    assert.equal(parseCodexStatus('Not logged in').loggedIn, false);
  });
});

describe('接线：只对远端，这台电脑上什么都不改', () => {
  const M = require_('src/main/index.ts');
  function require_(p: string): string { return (globalThis as any).process.getBuiltinModule('node:fs').readFileSync(p, 'utf8'); }
  test('四个 IPC 都要一台远端机器（findRemoteTarget），不接受本机', () => {
    /* 会话 id → 它跑的那台远端（本机会话报错）；否则按机器 id 找 —— 两条路都落到一台远端上 */
    const at = M.indexOf('const aiLoginTarget = (machine: string): RemoteTarget => {');
    assert.ok(at > 0);
    const body = M.slice(at, at + 1200);
    assert.match(body, /const r = kiroConfigTargetFor\(machine\);\s*if \(!r\) throw new Error\(tr\('This session runs on this computer\./);
    assert.match(body, /const t = findRemoteTarget\(KIROLEX_CONFIG_PATH, machine\);/);
    for (const ch of ['ai-login:status', 'ai-login:apply', 'ai-login:run']) {
      const at = M.indexOf(`ipcMain.handle('${ch}'`);
      assert.ok(at > 0, ch);
      assert.match(M.slice(at, at + 400), /aiLoginTarget\(machine\)/, `${ch} 只认远端`);
    }
  });
  test('「装没装」和「登没登」分开判（没登录时 codex login status 退出码非 0）', () => {
    assert.match(M, /if command -v codex >\/dev\/null 2>&1; then codex login status <\/dev\/null 2>&1; else echo KX_NO_CODEX; fi/);
  });
  test('写之前备份；手动填写就是那个编辑器（Claude 是 JSON、Codex 是 TOML 片段）', () => {
    assert.match(M, /cp -p \$\{file\} \$\{file\}\.kirolex-bak/);
    assert.match(M, /const env = parseClaudeEditor\(String\(input\.text \|\| ''\)\);/);
    assert.match(M, /const provider = parseCodexEditor\(String\(input\.text \|\| ''\)\);/);
    /* 「本机配置这个方法先不要了」：一键搬本机配置的那条路没了，只剩「拷入本机配置」把它放进编辑器 */
    assert.doesNotMatch(M, /mode: 'copy-local'/);
    assert.match(M, /ipcMain\.handle\('ai-login:local-config'/);
  });

  test('登录在 Claude Code / Codex 会话左下角的机器人面板里（不在设置里）', () => {
    const SD = require_('src/renderer/components/SettingsDialog.tsx');
    assert.doesNotMatch(SD, /id: 'login'/);
    const CA = require_('src/renderer/components/ChatArea.tsx');
    assert.match(CA, /onClick=\{\(\) => \{ setEngineConfigTab\('login'\); setEngineConfigOpen\(true\); \}\}/);
    assert.match(CA, /<EngineLoginPane sessionId=\{currentSessionId\} tool=\{engine as 'claude' \| 'codex'\} \/>/);
    assert.match(CA, /kiroConfigCategories\?\.\(engine\)/, '面板的配置 tab 按这条会话的引擎拿');
    /* 主进程按会话 id 找它跑的那台机器；本机会话不在这里登录 */
    assert.match(M, /if \(\/\^s_\/\.test\(machine\)\) \{\s*const r = kiroConfigTargetFor\(machine\);/);
  });
});

describe('编辑器 ——「提供一个按钮把本机配置直接拷过来，放到手动填写这个 json 编辑器中」', () => {
  test('Claude：拷入的是本机 env 那几项；写回时只认字符串、空值不写、至少要有 key', async () => {
    const { claudeEditorText, parseClaudeEditor } = await import('../src/main/aiLogin.ts');
    const text = claudeEditorText(JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'u', ANTHROPIC_API_KEY: 'k', OTHER: 'x' } }));
    assert.deepEqual(JSON.parse(text), { ANTHROPIC_BASE_URL: 'u', ANTHROPIC_API_KEY: 'k' });
    assert.deepEqual(parseClaudeEditor(text), { ANTHROPIC_BASE_URL: 'u', ANTHROPIC_API_KEY: 'k' });
    assert.deepEqual(parseClaudeEditor('{"env":{"ANTHROPIC_API_KEY":"k","ANTHROPIC_MODEL":""}}'), { ANTHROPIC_API_KEY: 'k' }, '整份 settings.json 贴进来也认；空值不写');
    assert.throws(() => parseClaudeEditor('{oops'), /不是合法的 JSON/);
    assert.throws(() => parseClaudeEditor('{"ANTHROPIC_BASE_URL":"u"}'), /ANTHROPIC_API_KEY/);
    assert.throws(() => parseClaudeEditor('{"ANTHROPIC_API_KEY":1}'), /要是字符串/);
    assert.ok(JSON.parse(claudeEditorText('')).ANTHROPIC_API_KEY === '', '本机没有就给一个带键名的空模板');
  });

  test('Codex：拷入的是顶层两行 + 那一段；写回时缺哪样就说哪样', async () => {
    const { codexEditorText, parseCodexEditor } = await import('../src/main/aiLogin.ts');
    const text = codexEditorText(LOCAL_TOML);
    assert.match(text, /^model = "gpt-6\.1-sol"\nmodel_provider = "workshop"\n\n\[model_providers\.workshop\]/);
    assert.doesNotMatch(text, /\[windows\]|\[projects/, 'Windows 段、项目信任不拷');
    const p = parseCodexEditor(text);
    assert.deepEqual([p.id, p.model], ['workshop', 'gpt-6.1-sol']);
    assert.throws(() => parseCodexEditor('[model_providers.x]\nbase_url = "u"\n'), /model_provider/);
    assert.throws(() => parseCodexEditor('model_provider = "x"\n'), /\[model_providers\.x\]/);
    assert.throws(() => parseCodexEditor(codexEditorText('')), /base_url 不能为空/, '空模板不能直接写过去');
  });
});

describe('默认走 Amazon Bedrock ——「默认将模型设置为 bedrock 的 global endpoint」', () => {
  test('Claude：去掉网关项、写 Bedrock + global 推理配置文件，别的设置原样保留', async () => {
    const { claudeBedrockSettings, claudeBedrockOf, BEDROCK_DEFAULTS } = await import('../src/main/aiLogin.ts');
    const out = JSON.parse(claudeBedrockSettings(JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'u', ANTHROPIC_API_KEY: 'k', KEEP: '1' }, permissions: { allow: ['x'] } }), 'ap-northeast-1'));
    assert.equal(out.env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(out.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(out.env.KEEP, '1');
    assert.deepEqual(out.permissions, { allow: ['x'] });
    assert.equal(out.env.CLAUDE_CODE_USE_BEDROCK, '1');
    assert.equal(out.env.AWS_REGION, 'ap-northeast-1');
    assert.equal(out.env.ANTHROPIC_BEDROCK_REGION_PREFIX, 'global');
    assert.match(out.env.ANTHROPIC_MODEL, /^global\.anthropic\./);
    assert.equal(out.env.ANTHROPIC_MODEL, BEDROCK_DEFAULTS.claude.opus);
    assert.deepEqual(claudeBedrockOf(JSON.stringify(out)), { region: 'ap-northeast-1' });
    assert.equal(claudeBedrockOf('{"env":{"ANTHROPIC_BASE_URL":"u"}}'), undefined);
  });
  test('Codex：顶层两行换成 amazon-bedrock，旧网关段保留；反复写不重复（子表也认得）', async () => {
    const { codexBedrockToml, codexBedrockOf } = await import('../src/main/aiLogin.ts');
    const once = codexBedrockToml(LOCAL_TOML);
    assert.equal(topLevelValue(once, 'model_provider'), 'amazon-bedrock');
    assert.equal(topLevelValue(once, 'model'), 'openai.gpt-6.1-sol');
    assert.match(once, /\[model_providers\.workshop\]/, '原来的网关那一段留着，切回去改一行就行');
    assert.equal(codexBedrockToml(once), once);
    assert.equal((once.match(/\[model_providers\.amazon-bedrock\.aws\]/g) || []).length, 1);
    assert.deepEqual(codexBedrockOf(once), { region: 'us-east-1', model: 'openai.gpt-6.1-sol' });
    assert.equal(codexBedrockOf(LOCAL_TOML), undefined);
  });
  test('接线：apply 有 bedrock 模式、状态认得 Bedrock；登录页有这个选项；安装脚本只给没配过的工具写默认', () => {
    const require_ = (p: string): string => (globalThis as any).process.getBuiltinModule('node:fs').readFileSync(p, 'utf8');
    const M2 = require_('src/main/index.ts');
    assert.match(M2, /if \(input\.mode === 'bedrock'\) \{/);
    assert.match(M2, /const cb = claudeBedrockOf\(settings \|\| ''\);/);
    const L = require_('src/renderer/components/LoginSettings.tsx');
    assert.match(L, />\{t\('Use Amazon Bedrock \(recommended\)'\)\}</);
    assert.match(require_('src/renderer/i18nZh/settingsPanels.ts'), /'Use Amazon Bedrock \(recommended\)': '用 Amazon Bedrock（推荐）'/);
    assert.match(L, /aiLoginApply\?\.\(machine, \{ tool, mode: 'bedrock' \}\)/);
    const SH = require_('scripts/remote-bootstrap.sh');
    assert.match(SH, /step "默认模型：Amazon Bedrock"/);
    assert.match(SH, /Claude Code 已经配过（网关 \/ Bedrock \/ 官方登录），不动/);
    assert.match(SH, /Codex 已经配过（provider \/ 官方登录），不动/);
    assert.match(SH, /ANTHROPIC_MODEL: "global\.anthropic\.claude-opus-5-5"/);
  });
});
