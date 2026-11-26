import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localizeCombo, type McpCombo } from '../src/main/mcpCombos.ts';
import { serverTrustKey, withholdUntrusted, withholdUntrustedLocal } from '../src/main/mcpComboTrust.ts';
import { untrustedItem, mcpUnavailableNotice } from '../src/main/mcpUnavailable.ts';
import { trIn } from '../src/main/uiText.ts';
import { planUpload, keyFor } from '../src/main/s3Sync.ts';
import { runAppearanceSync, APPEARANCE_REL } from '../src/main/appearanceSync.ts';
import { syncProfileFiles, listLocalProfileFiles } from '../src/main/agentProfileSync.ts';
import { AGENT_PROFILES_REL } from '../src/main/agentProfile.ts';
import { syncComboFile } from '../src/main/mcpCombosSync.ts';

/**
 * MCP 配置（mcp-combos.json）只存本机，不再跟着 S3 同步（2026-11-26）：每台电脑各配各的。
 * 以前同步来、还没确认的照旧要确认（mcp-combos-untrusted.json 不变）；本机已 disabled 的不再列进「没确认」；
 * 提示点名是哪个 MCP 配置里的哪一个，不让人误以为整条会话是别的电脑同步来的。
 */
const ROOT = path.join(import.meta.dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.ts'), 'utf-8');
const win = { hostname: 'WIN-BOX', platform: 'win32' };

const macProxy = { command: '/Users/keyinan/.local/bin/mcp-proxy-for-aws', args: ['x'], perMachine: { win32: { disabled: true } } };
const pw = { command: '/Users/keyinan/.kirolex/tools/pw-agent-chrome.sh' };
const mine = { command: 'node', args: ['srv.js'] };
const combo: McpCombo = { id: 'default', name: '通用', mcpServers: { proxy: macProxy, pw, mine } };

describe('sessionCombo 先按本机套 perMachine，再算没确认的', () => {
  test('本机已 disabled 的不进 withheld；没 disabled 的照旧拦下', () => {
    const untrusted = new Set([serverTrustKey(macProxy), serverTrustKey(pw)]);
    const r = withholdUntrustedLocal(combo, untrusted, win);
    assert.deepEqual(r.withheld, ['pw']);
    assert.deepEqual(Object.keys(r.combo.mcpServers), ['mine']);
    /* 交出去的就是本机那份（和原来 localize(withhold(combo)) 一样） */
    assert.deepEqual(r.combo, localizeCombo(withholdUntrusted(combo, untrusted).combo, win));
  });
  test('信任判定仍按文件里原样那条：perMachine 改了命令的没确认项照样拦下', () => {
    const over = { command: '/mac/x', perMachine: { win32: { command: 'C:\\x.exe' } } };
    const c = { id: 'r', name: '投研', mcpServers: { over } };
    const r = withholdUntrustedLocal(c, new Set([serverTrustKey(over)]), win);
    assert.deepEqual(r.withheld, ['over']);
    assert.deepEqual(r.combo.mcpServers, {});
  });
  test('记录读不了（null）= 全都不挂，但本机 disabled 的不提示', () => {
    const r = withholdUntrustedLocal(combo, null, win);
    assert.deepEqual(r.withheld, ['pw', 'mine']);
    assert.deepEqual(r.combo.mcpServers, {});
  });
  test('接线：sessionCombo 用 withholdUntrustedLocal，并记下组合名', () => {
    const at = M.indexOf('function sessionCombo(');
    const body = M.slice(at, M.indexOf('\n}\n', at));
    assert.match(body, /withholdUntrustedLocal\(combo, readUntrusted\(os\.homedir\(\)\), thisMachine\(\)\)/);
    assert.match(body, /withheldBySession\.set\(sessionId, \{ combo: comboDisplayName\(combo\), names: trusted\.withheld \}\)/);
  });
});

describe('提示点名 MCP 配置', () => {
  test('中英文都含配置名和 MCP 名', () => {
    const zh = untrustedItem('pw', '通用');
    assert.equal(zh.name, 'pw');
    assert.equal(zh.kind, 'skipped');
    assert.equal(trIn('zh', 'The MCP "{name}" in MCP profile "{combo}" came from another computer and is not confirmed on this computer yet; review it in Settings → MCP profiles and save to use it', { name: 'pw', combo: '通用' }),
      'MCP 配置『通用』里的 pw 来自别的电脑，这台电脑上还没确认；到设置 → MCP 配置里看过并保存后才会用');
    assert.equal(trIn('en', 'The MCP "{name}" in MCP profile "{combo}" came from another computer and is not confirmed on this computer yet; review it in Settings → MCP profiles and save to use it', { name: 'pw', combo: '通用' }),
      'The MCP "pw" in MCP profile "通用" came from another computer and is not confirmed on this computer yet; review it in Settings → MCP profiles and save to use it');
    assert.match(mcpUnavailableNotice([zh]), /pw/);
  });
  test('不再说「经 S3 同步来的」', () => {
    assert.doesNotMatch(M, /synced from another computer via S3 and not confirmed/);
    assert.match(M, /withheldBySession\.get\(sessionId\)[\s\S]{0,200}untrustedItem\(name, w\.combo\)/);
  });
});

describe('一轮同步不碰 mcp-combos.json', () => {
  const at = M.indexOf('async function runS3Sync(');
  const body = M.slice(at, M.indexOf('function rescheduleS3Sync', at));
  test('runS3Sync 不再调 syncMcpCombosWithBucket，也不读写组合文件的 key', () => {
    assert.ok(at > 0);
    assert.doesNotMatch(body, /syncMcpCombosWithBucket/);
    assert.doesNotMatch(body, /MCP_COMBOS_REL|mcp-combos\.json'|syncComboFile/);
    /* 整个主进程都不再有组合文件的 S3 读写（函数和 import 都去掉了） */
    assert.doesNotMatch(M, /async function syncMcpCombosWithBucket\(/);
    assert.doesNotMatch(M, /from '\.\/mcpCombosSync\.ts'/);
    assert.doesNotMatch(M, /markPulledUntrusted\(/);
  });
  test('启动后第一轮同步记一行「MCP 组合只存本机，不再同步」（只记一次）', () => {
    assert.match(body, /if \(!mcpCombosNoSyncLogged\) \{\s*mcpCombosNoSyncLogged = true;\s*logger\.info\('s3', 'MCP 组合只存本机，不再同步/);
    assert.match(M, /let mcpCombosNoSyncLogged = false;/);
  });
  test('s3Sync.ts 文件头不再写 mcp-combos 共用', () => {
    const S = fs.readFileSync(path.join(ROOT, 'src', 'main', 's3Sync.ts'), 'utf-8');
    const head = S.slice(0, S.indexOf('*/'));
    assert.doesNotMatch(head, /mcp-combos\.json` —— .*共用/);
    assert.match(head, /mcp-combos\.json[^\n]*只存本机/);
  });
  test('mcpCombosSync.ts 标注不再使用', () => {
    const S = fs.readFileSync(path.join(ROOT, 'src', 'main', 'mcpCombosSync.ts'), 'utf-8');
    assert.match(S.slice(0, 400), /不再使用/);
  });
  test('设置里说明改成只存本机', () => {
    const P = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'components', 'McpCombosPane.tsx'), 'utf-8');
    assert.doesNotMatch(P, /also synced to your other computers/);
    assert.match(P, /t\('Shared by all sessions; stored only on this computer \(not synced\)'\)/);
  });
});

/**
 * 真跑一轮（假桶记下每次 get / put / list）：照 index.ts runS3Sync 的顺序，用真的 planUpload（会话 + 记忆 + 附件）、
 * syncProfileFiles（agent-profiles）、runAppearanceSync（外观）。桶里和本机都有 mcp-combos.json，
 * 一轮下来对它的上传、下载都是 0 次，两边内容原样。定时任务 / 后台任务只碰 schedules/、bg-jobs/ 下的 key，不在这里跑。
 */
describe('一轮同步（假 S3 计数）：mcp-combos.json 上传 / 下载都是 0 次', () => {
  const P = 'kx';
  const COMBOS_KEY = keyFor(P, 'mcp-combos.json');
  class CountingS3 {
    objects = new Map<string, { body: Buffer; etag: string }>();
    gets: string[] = [];
    puts: string[] = [];
    lists: string[] = [];
    n = 0;
    async get(key: string) { this.gets.push(key); const o = this.objects.get(key); return o ? { body: Buffer.from(o.body), etag: o.etag } : null; }
    async put(key: string, body: Buffer) { this.puts.push(key); this.objects.set(key, { body: Buffer.from(body), etag: `"e${++this.n}"` }); return 'ok' as const; }
    async list(prefix: string) { this.lists.push(prefix); return [...this.objects.keys()].filter((k) => k.startsWith(prefix)); }
  }
  const comboText = JSON.stringify([{ id: 'default', name: '通用', mcpServers: { proxy: macProxy } }], null, 2);
  const bucketCombo = JSON.stringify([{ id: 'research', name: '投研', mcpServers: { pw } }]);

  function setupHome(): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-combos-local-'));
    const w = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true }); fs.writeFileSync(path.join(home, rel), text); };
    w('sessions/s1/record.json', JSON.stringify({ id: 's1', updatedAt: 1 }));
    w('sessions/s1/transcript.jsonl', '{"id":"m1"}\n');
    w('sessions/s1/history.md', '# s1');
    w('memory/sessions/s1.md', '- 记住这个');
    w('attachments/a.png', 'png');
    w('agent-profiles/claude.json', '{"v":1}');
    w('mcp-combos.json', comboText);
    w('s3-combos-sync.json', JSON.stringify({ localHash: 'old', remoteHash: 'old' }));   // 以前同步过留下的摘要
    return home;
  }

  /** 和 runS3Sync 同一个顺序：会话 / 记忆 / 附件的上传循环 → 外观 → agent-profiles。 */
  async function oneRound(home: string, s3: CountingS3): Promise<void> {
    const plan = planUpload(home, ['s1'], {}, { projects: [] });
    for (const rel of plan.upload) await s3.put(keyFor(P, rel), fs.readFileSync(path.join(home, rel)));
    await runAppearanceSync({
      isEnabled: () => true,
      local: () => undefined,
      getRemote: async () => { const g = await s3.get(keyFor(P, APPEARANCE_REL)); return g ? g.body.toString('utf-8') : null; },
      put: async (text) => { await s3.put(keyFor(P, APPEARANCE_REL), Buffer.from(text)); },
      apply: () => {},
    });
    const root = path.join(home, AGENT_PROFILES_REL);
    const profKey = (rel: string) => keyFor(P, path.join(AGENT_PROFILES_REL, ...rel.split('/')));
    let marks = {};
    await syncProfileFiles({
      listRemote: async () => (await s3.list(`${keyFor(P, AGENT_PROFILES_REL)}/`)).map((k) => k.slice(`${keyFor(P, AGENT_PROFILES_REL)}/`.length)),
      get: (rel) => s3.get(profKey(rel)),
      put: (rel, body) => s3.put(profKey(rel), body),
      listLocal: () => listLocalProfileFiles(root),
      readLocal: (rel) => { try { return fs.readFileSync(path.join(root, rel)); } catch { return undefined; } },
      writeLocal: () => {},
      writeConflictCopy: (rel) => rel,
      readMarks: () => marks,
      writeMarks: (m) => { marks = m; },
    });
  }

  test('这一轮 S3 有读写，但没有一次碰 mcp-combos.json；本机文件和桶里那份都原样', async () => {
    const home = setupHome();
    try {
      const s3 = new CountingS3();
      s3.objects.set(COMBOS_KEY, { body: Buffer.from(bucketCombo), etag: '"old"' });
      await oneRound(home, s3);
      assert.ok(s3.puts.length > 0, '会话等照常上传（证明这一轮真的跑了）');
      assert.ok(s3.puts.includes(keyFor(P, 'sessions/s1/transcript.jsonl')));
      assert.ok(s3.puts.includes(keyFor(P, 'agent-profiles/claude.json')));
      assert.equal(s3.puts.filter((k) => k.includes('mcp-combos')).length, 0, '上传 0 次');
      assert.equal(s3.gets.filter((k) => k.includes('mcp-combos')).length, 0, '下载 0 次');
      assert.equal(s3.lists.filter((k) => k.includes('mcp-combos')).length, 0);
      assert.equal(fs.readFileSync(path.join(home, 'mcp-combos.json'), 'utf-8'), comboText, '本机文件不动');
      assert.equal(s3.objects.get(COMBOS_KEY)!.body.toString(), bucketCombo, '桶里那份不删不改');
      assert.ok(!fs.existsSync(path.join(home, 'mcp-combos-untrusted.json')), '没有从桶里来的新内容，不新增待确认');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  test('对照：以前的组合同步（syncComboFile）用同一个假桶会读写 mcp-combos.json —— 计数确实数得到', async () => {
    const s3 = new CountingS3();
    s3.objects.set(COMBOS_KEY, { body: Buffer.from(bucketCombo), etag: '"old"' });
    let local: string | undefined = comboText;
    await syncComboFile({
      get: async () => { const g = await s3.get(COMBOS_KEY); return g ? { text: g.body.toString(), etag: g.etag } : null; },
      put: async (text) => { await s3.put(COMBOS_KEY, Buffer.from(text)); return 'ok'; },
      readLocal: () => local,
      writeLocal: (text) => { local = text; },
      readMark: () => undefined,
      writeMark: () => {},
    });
    assert.ok(s3.gets.includes(COMBOS_KEY));
  });

  test('模拟的这一轮和真实接线对得上：runS3Sync 每轮只调外观 / agent-profiles / 定时任务 / 后台任务这几个配置同步', () => {
    const at = M.indexOf('async function runS3Sync(');
    const body = M.slice(at, M.indexOf('function rescheduleS3Sync', at));
    const calls = [...body.matchAll(/await (sync\w+WithBucket)\(/g)].map((m) => m[1]);
    assert.deepEqual(calls, ['syncAppearanceWithBucket', 'syncAgentProfilesWithBucket', 'syncSchedulesWithBucket', 'syncBgJobsWithBucket']);
    /* 会话 / 记忆的上传循环用的是 planUpload，它的白名单里没有 mcp-combos.json（上面那一轮已验） */
    assert.match(body, /planUpload\(/);
  });
});
