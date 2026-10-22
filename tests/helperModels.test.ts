import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import {
  mergeHelperModelLists, planHelperRoute, helperChoiceText, remoteLiteScript, parseRemoteLiteOutput, remoteLiteAgentName,
  LOCAL_MACHINE, REMOTE_LITE_OK,
} from '../src/main/helperModels.ts';

/*
 * 「设置里的辅助模型下拉没有自动更新成所有模型」。
 *
 * 现场：本机 kiro-cli 被地域过滤，只报 8 个、一个 Claude 都没有；远程机器（tokyo-arm）报得出
 * claude-opus-5.5 / claude-sonnet-5 等。下拉只问本机 → 看不到；默认辅助模型 claude-sonnet-5
 * 本机没有 → runLiteOneShot 悄悄换成别的、只写日志。这里守的是：
 *   1. 清单 = 本机 + 每台远程，去重，本机优先，单台失败只少那台，缓存占位被实时清单替换；
 *   2. 辅助调用按模型所在机器选：本机有 → 本机；只远程有 → 那台远程；都没有 → 现有兜底并说出实际用的。
 */

const ORDER = ['gpt-5.6-sol', 'gpt-5.6-terra', 'deepseek-3.2'];
const LOCAL_IDS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'deepseek-3.2', 'glm-5'];
const TOKYO_IDS = ['claude-opus-5.5', 'claude-sonnet-5', 'gpt-5.6-terra', 'auto'];

describe('mergeHelperModelLists：多机清单合并', () => {
  test('去重、本机优先：本机和远程都有的只标本机，只远程有的标那台机器', () => {
    const out = mergeHelperModelLists([
      { machine: 'tokyo-arm', label: 'tokyo-arm', status: 'ok', ids: TOKYO_IDS },
      { machine: LOCAL_MACHINE, label: '本机', status: 'ok', ids: LOCAL_IDS },
    ]);
    const byId = Object.fromEntries(out.map((c) => [c.id, c]));
    assert.equal(byId['gpt-5.6-terra'].machine, LOCAL_MACHINE, '两边都有 → 只标本机');
    assert.equal(byId['claude-opus-5.5'].machine, 'tokyo-arm');
    assert.equal(byId['claude-opus-5.5'].label, 'tokyo-arm');
    assert.equal(out.filter((c) => c.id === 'gpt-5.6-terra').length, 1, '不重复');
    assert.ok(!byId.auto, 'auto 不是一个能钉进 agent 的模型，不进清单');
    /* 本机的排在前面（不管传进来的顺序） */
    assert.deepEqual(out.slice(0, LOCAL_IDS.length).map((c) => c.id), LOCAL_IDS);
    assert.ok(out.every((c) => !c.placeholder));
  });

  test('单台失败只少那台：别的机器照样列出来', () => {
    const out = mergeHelperModelLists([
      { machine: LOCAL_MACHINE, label: '本机', status: 'ok', ids: LOCAL_IDS },
      { machine: 'dead-box', label: 'dead-box', status: 'failed', ids: [], error: 'timeout' },
      { machine: 'tokyo-arm', label: 'tokyo-arm', status: 'ok', ids: TOKYO_IDS },
    ]);
    const ids = out.map((c) => c.id);
    assert.ok(ids.includes('claude-sonnet-5'));
    assert.ok(ids.includes('glm-5'));
    assert.ok(out.every((c) => c.machine !== 'dead-box'));
  });

  test('本机失败也不影响远程那份', () => {
    const out = mergeHelperModelLists([
      { machine: LOCAL_MACHINE, label: '本机', status: 'failed', ids: [] },
      { machine: 'tokyo-arm', label: 'tokyo-arm', status: 'ok', ids: TOKYO_IDS },
    ]);
    assert.deepEqual(out.map((c) => c.id), ['claude-opus-5.5', 'claude-sonnet-5', 'gpt-5.6-terra']);
  });

  test('还在拉的时候用缓存 id 占位；实时清单回来后占位被替换', () => {
    const cached = ['claude-opus-5.5', 'claude-haiku-4.5', 'glm-5'];
    const pending = mergeHelperModelLists([
      { machine: LOCAL_MACHINE, label: '本机', status: 'ok', ids: LOCAL_IDS },
      { machine: 'tokyo-arm', label: 'tokyo-arm', status: 'pending', ids: [] },
    ], cached);
    const ph = pending.filter((c) => c.placeholder).map((c) => c.id);
    assert.deepEqual(ph, ['claude-opus-5.5', 'claude-haiku-4.5'], '已经在实时清单里的（glm-5）不重复占位');
    assert.ok(pending.filter((c) => c.placeholder).every((c) => c.machine === null));

    const live = mergeHelperModelLists([
      { machine: LOCAL_MACHINE, label: '本机', status: 'ok', ids: LOCAL_IDS },
      { machine: 'tokyo-arm', label: 'tokyo-arm', status: 'ok', ids: TOKYO_IDS },
    ], cached);
    assert.ok(live.every((c) => !c.placeholder), '都拉完了 → 不再有占位');
    assert.ok(!live.some((c) => c.id === 'claude-haiku-4.5'), '哪台都不报的缓存 id 不再出现');
    assert.equal(live.find((c) => c.id === 'claude-opus-5.5')!.machine, 'tokyo-arm', '占位换成带机器的实时条目');
  });

  test('选项文字：模型 · 机器；占位写明是缓存', () => {
    assert.equal(helperChoiceText({ id: 'claude-opus-5.5', machine: 'tokyo-arm', label: 'tokyo-arm' }, '本机', '缓存'), 'claude-opus-5.5 · tokyo-arm');
    assert.equal(helperChoiceText({ id: 'gpt-5.6-terra', machine: LOCAL_MACHINE, label: '本机' }, '本机', '缓存'), 'gpt-5.6-terra · 本机');
    assert.equal(helperChoiceText({ id: 'x', machine: null, label: null, placeholder: true }, '本机', '缓存'), 'x · 缓存');
  });
});

describe('planHelperRoute：辅助调用在哪台机器上跑', () => {
  const remotes = [{ machine: 'tokyo-arm', ids: TOKYO_IDS }];

  test('本机有 → 本机', () => {
    const r = planHelperRoute({ wanted: ['gpt-5.6-terra', 'claude-sonnet-5'], local: LOCAL_IDS, remotes, fallbackOrder: ORDER });
    assert.deepEqual(r.attempts[0], { model: 'gpt-5.6-terra', machine: LOCAL_MACHINE });
    assert.equal(r.effective, 'gpt-5.6-terra');
    assert.equal(r.substituted, false);
  });

  test('只远程有 → 那台远程；远程失败还有本机兜底可走', () => {
    const r = planHelperRoute({ wanted: ['claude-sonnet-5', ''], local: LOCAL_IDS, remotes, fallbackOrder: ORDER });
    assert.deepEqual(r.attempts[0], { model: 'claude-sonnet-5', machine: 'tokyo-arm' });
    assert.equal(r.effective, 'claude-sonnet-5');
    assert.equal(r.substituted, false);
    /* 远程也失败才走现有兜底：MODEL_FALLBACK_ORDER 里本机有的第一个 */
    assert.deepEqual(r.attempts[r.attempts.length - 1], { model: 'gpt-5.6-sol', machine: LOCAL_MACHINE });
  });

  test('主模型只远程有、备用本机有：先远程主模型，再本机备用', () => {
    const r = planHelperRoute({ wanted: ['claude-sonnet-5', 'gpt-5.6-terra'], local: LOCAL_IDS, remotes, fallbackOrder: ORDER });
    assert.deepEqual(r.attempts, [
      { model: 'claude-sonnet-5', machine: 'tokyo-arm' },
      { model: 'gpt-5.6-terra', machine: LOCAL_MACHINE },
    ]);
  });

  test('都没有 → 现有兜底，并返回实际用的模型', () => {
    const r = planHelperRoute({ wanted: ['claude-retired-1', 'claude-retired-2'], local: LOCAL_IDS, remotes, fallbackOrder: ORDER });
    assert.deepEqual(r.attempts, [{ model: 'gpt-5.6-sol', machine: LOCAL_MACHINE }]);
    assert.equal(r.effective, 'gpt-5.6-sol');
    assert.equal(r.substituted, true);
  });

  test('本机清单问不到：照旧在本机原样试（没依据不换）', () => {
    const r = planHelperRoute({ wanted: ['gpt-5.6-terra', 'glm-5'], local: [], remotes: [], fallbackOrder: ORDER });
    assert.deepEqual(r.attempts, [
      { model: 'gpt-5.6-terra', machine: LOCAL_MACHINE },
      { model: 'glm-5', machine: LOCAL_MACHINE },
    ]);
    assert.equal(r.substituted, false);
  });

  test('本机清单问不到、但远程报了这个模型：先去那台远程，再照旧在本机试', () => {
    /* 审查回归：以前本机清单一问不到（超时 / 没配启动命令）就完全不看远程，下拉里确认过的远程模型白白只在本机试 */
    const r = planHelperRoute({ wanted: ['claude-sonnet-5', 'glm-5'], local: [], remotes, fallbackOrder: ORDER });
    assert.deepEqual(r.attempts, [
      { model: 'claude-sonnet-5', machine: 'tokyo-arm' },
      { model: 'claude-sonnet-5', machine: LOCAL_MACHINE },
      { model: 'glm-5', machine: LOCAL_MACHINE },
    ]);
    assert.equal(r.effective, 'claude-sonnet-5');
    assert.equal(r.substituted, false);
  });

  test('多台远程都有：取第一台（按设置里的顺序）', () => {
    const r = planHelperRoute({
      wanted: ['claude-opus-5.5'], local: LOCAL_IDS, fallbackOrder: ORDER,
      remotes: [{ machine: 'a', ids: ['x'] }, { machine: 'b', ids: ['claude-opus-5.5'] }, { machine: 'c', ids: ['claude-opus-5.5'] }],
    });
    assert.deepEqual(r.attempts[0], { model: 'claude-opus-5.5', machine: 'b' });
  });
});

describe('远程一次性调用的脚本', () => {
  test('agent JSON 钉模型（--model 在 chat --no-interactive 上不生效），prompt 走 stdin，成功打标记', () => {
    const agent = { name: 'kirolex-lite', tools: [] };
    const s = remoteLiteScript('/home/u/.local/bin/kiro-cli', 'kirolex-lite', agent, 'claude-sonnet-5');
    const b64 = Buffer.from(JSON.stringify({ ...agent, name: 'kirolex-lite-claude-sonnet-5', model: 'claude-sonnet-5' })).toString('base64');
    assert.ok(s.includes(b64), 'agent JSON 以 base64 写过去，不经引号；name 和文件名一致、model 钉死');
    assert.match(s, /~\/\.kiro\/agents\/kirolex-lite-claude-sonnet-5\.json/);
    assert.match(s, /mv /, '先写临时文件再 rename');
    assert.match(s, /--agent 'kirolex-lite-claude-sonnet-5'/);
    assert.match(s, /--model 'claude-sonnet-5'/);
    assert.match(s, /"\$\(cat\)"/, 'prompt 从 stdin 读，不拼进命令行');
    assert.ok(s.includes(REMOTE_LITE_OK));
  });

  test('解析：有标记才算成功', () => {
    assert.equal(parseRemoteLiteOutput(`${REMOTE_LITE_OK}\nhello\nworld`), 'hello\nworld');
    assert.equal(parseRemoteLiteOutput('error: something'), null);
    assert.equal(parseRemoteLiteOutput(''), null);
  });
});

/*
 * 审查回归：远程辅助调用以前都写同一个 `kirolex-lite.json`。标题 / 建议 / 记忆整理可能同时在跑，
 * 其中一次换了模型（走备用、或用户刚改了设置）时，会在另一次「写完配置 → kiro-cli 读配置」之间把它覆盖掉，
 * 那一次就用错了模型。现在每个模型一份 agent 文件。
 */
describe('远程辅助调用并发：不同模型互不覆盖', () => {
  test('不同模型 → 不同的 agent 名和文件；同一模型 → 同一份内容', () => {
    assert.notEqual(remoteLiteAgentName('kirolex-lite', 'claude-sonnet-5'), remoteLiteAgentName('kirolex-lite', 'gpt-5.6-terra'));
    const a = remoteLiteScript('/bin/kiro', 'kirolex-lite', {}, 'claude-sonnet-5');
    const b = remoteLiteScript('/bin/kiro', 'kirolex-lite', {}, 'gpt-5.6-terra');
    assert.ok(!a.includes('kirolex-lite-gpt-5.6-terra'), 'A 的脚本不碰 B 的文件');
    assert.ok(!b.includes('kirolex-lite-claude-sonnet-5'), 'B 的脚本不碰 A 的文件');
    assert.equal(a, remoteLiteScript('/bin/kiro', 'kirolex-lite', {}, 'claude-sonnet-5'));
    /* 名字只含文件名安全的字符（它会进 shell 和路径） */
    assert.match(remoteLiteAgentName('kirolex-lite', "a b/c'd"), /^[A-Za-z0-9._-]+$/);
  });

  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  test('真跑：两次调用同时写配置、慢一点才读，各自读到自己的模型', { skip: !fs.existsSync(bash) && '没有 bash' }, async () => {
    const msys = (p: string) => (process.platform === 'win32'
      ? p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`)
      : p);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-helper-'));
    try {
      /* 假 kiro-cli：先睡一会儿（让另一次调用有机会在中间写配置），再报 --agent 那份 JSON 里钉的模型 */
      const fake = path.join(dir, 'kiro');
      fs.writeFileSync(fake, '#!/bin/bash\nsleep 1.5\ngrep -o \'"model":"[^"]*"\' ~/.kiro/agents/$4.json\n');
      fs.chmodSync(fake, 0o755);
      const run = (model: string) => new Promise<string>((resolve, reject) => {
        const child = execFile(bash, ['-c', remoteLiteScript(msys(fake), 'kirolex-lite', { tools: [] }, model)],
          { env: { ...process.env, HOME: msys(dir) }, encoding: 'utf8', timeout: 60_000 },
          (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
        child.stdin?.end('prompt');
      });
      const [a, b] = await Promise.all([run('claude-sonnet-5'), run('gpt-5.6-terra')]);
      assert.equal(parseRemoteLiteOutput(a)?.trim(), '"model":"claude-sonnet-5"');
      assert.equal(parseRemoteLiteOutput(b)?.trim(), '"model":"gpt-5.6-terra"');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('接线（源码扫描）', () => {
  const root = path.join(import.meta.dirname, '..', 'src');
  const settings = fs.readFileSync(path.join(root, 'renderer', 'components', 'SettingsDialog.tsx'), 'utf-8');
  const main = fs.readFileSync(path.join(root, 'main', 'index.ts'), 'utf-8');

  test('SettingsDialog 不再只调无参的 listModels()，改用多机清单 + 刷新', () => {
    assert.ok(!/listModels\?\.\(\)/.test(settings), '不该再有无参 listModels()');
    assert.match(settings, /listHelperModels/);
    assert.match(settings, /mergeHelperModelLists|helperChoiceText/);
  });

  test('runLiteOneShot 有远程分支：按 planHelperRoute 选机器，远程走 runRemoteCapture', () => {
    const at = main.indexOf('async function runLiteOneShot(');
    assert.ok(at > 0);
    const body = main.slice(at, main.indexOf('\n}\n', at));
    assert.match(body, /planHelperRoute\(/);
    assert.match(body, /runRemoteCapture\(/);
    assert.match(body, /remoteLiteScript\(/);
    /* 审查回归：本机清单问不到（available 为空）也要去看远程，不能写成 `available.length > 0 && …` */
    assert.match(body, /const needRemote = models\.some\(\(m\) => !available\.includes\(m\)\);/);
    assert.doesNotMatch(body, /needRemote = available\.length > 0/);
  });

  test('acp:list-helper-models 已注册，preload 有包装', () => {
    assert.match(main, /ipcMain\.handle\('acp:list-helper-models'/);
    const preload = fs.readFileSync(path.join(root, 'main', 'preload.ts'), 'utf-8');
    assert.match(preload, /listHelperModels:.*'acp:list-helper-models'/);
  });
});
