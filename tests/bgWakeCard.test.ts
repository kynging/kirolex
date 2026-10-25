import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 后台命令 / 监视结束的唤醒在会话里画成紧凑卡片（同「⏰ 定时」那套，不是用户气泡）—— 解析器、给模型的原文不变、渲染接线。
 */
const SRC = path.join(import.meta.dirname, '..', 'src');
const read = (...parts: string[]) => fs.readFileSync(path.join(SRC, ...parts), 'utf8');
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const view = await import('../src/main/bgWakeView.ts');
const user = (content: string, extra: Record<string, unknown> = {}) => ({ role: 'user', id: 'wake_bg_1_2', content, ...extra });

describe('parseBgWake：认出后台命令 / 监视结束那条', () => {
  test('中文「已结束」：label / 退出码 / 用时 / id / 输出', () => {
    const card = view.parseBgWake(user('🔔 后台命令「等看板任务 030cc5cd（README 架构图）」已结束：退出码 0，用时 1 分 4 秒（bg_mvnsetf33）\n\n输出末尾：\nline 1\nline 2'));
    assert.deepEqual(card, {
      kind: 'bg', label: '等看板任务 030cc5cd（README 架构图）', status: 'ok', exitCode: 0, duration: '1 分 4 秒', jobId: 'bg_mvnsetf33', output: 'line 1\nline 2',
    });
  });

  test('英文「finished」非 0 退出码 + 没有输出', () => {
    const card = view.parseBgWake(user('🔔 Background command "npm test" finished: exit code 2, ran 12 sec (bg_abc1)\n\n(no output)'));
    assert.deepEqual(card, { kind: 'bg', label: 'npm test', status: 'exit', exitCode: 2, duration: '12 sec', jobId: 'bg_abc1', output: '' });
  });

  test('中 / 英「没能运行」：原因进 reason，没有输出', () => {
    assert.deepEqual(view.parseBgWake(user('🔔 后台命令「构建」没能运行：工作目录不存在：D:\\x（bg_q1）')), {
      kind: 'bg', label: '构建', status: 'failed', reason: '工作目录不存在：D:\\x', jobId: 'bg_q1',
    });
    assert.deepEqual(view.parseBgWake(user('🔔 Background command "build" could not run: spawn ENOENT (bg_q2)')), {
      kind: 'bg', label: 'build', status: 'failed', reason: 'spawn ENOENT', jobId: 'bg_q2',
    });
  });

  test('中 / 英「监视结束」：退出码', () => {
    assert.deepEqual(view.parseBgWake(user('👀 监视「看日志」已结束：命令退出，退出码 1（bg_w1）')), {
      kind: 'watch', label: '看日志', status: 'exit', exitCode: 1, jobId: 'bg_w1',
    });
    assert.deepEqual(view.parseBgWake(user('👀 Watch "tail log" ended: the command exited with code 0 (bg_w2)')), {
      kind: 'watch', label: 'tail log', status: 'ok', exitCode: 0, jobId: 'bg_w2',
    });
  });

  test('超时 / 到时间上限 / 被限流：⏹ 已停止', () => {
    assert.deepEqual(view.parseBgWake(user('🔔 后台命令「慢」跑了 10 分 0 秒 超时，已结束（bg_t1）\n\n输出末尾：\n…（前面的输出省略，只显示最后 4000 字节）\nx')), {
      kind: 'bg', label: '慢', status: 'stopped', stop: 'timeout', duration: '10 分 0 秒', jobId: 'bg_t1', output: '…（前面的输出省略，只显示最后 4000 字节）\nx',
    });
    assert.deepEqual(view.parseBgWake(user('👀 Watch "w" reached its time limit (1 h 0 min) and was stopped (bg_t2)')), {
      kind: 'watch', label: 'w', status: 'stopped', stop: 'timeout', duration: '1 h 0 min', jobId: 'bg_t2',
    });
    assert.equal(view.parseBgWake(user('👀 监视「w」已被限流停掉：事件太多（60 秒内超过 30 条）。换一个输出少一些的命令，或者先过滤输出（bg_t3）'))?.stop, 'rate-limited');
  });

  test('退出码「?」：算非 0（醒目），exitCode 记 null', () => {
    const card = view.parseBgWake(user('🔔 后台命令「x」已结束：退出码 ?，用时 3 秒（bg_z）\n\n（没有输出）'));
    assert.equal(card?.status, 'exit');
    assert.equal(card?.exitCode, null);
  });

  test('无关文本 / KiroLex 提示 / 模型的回复：null', () => {
    assert.equal(view.parseBgWake(user('帮我看看 bg_mvnsetf33 的输出')), null);
    assert.equal(view.parseBgWake(user('🔔 后台命令「x」已结束：随便写的')), null);
    assert.equal(view.parseBgWake(user('👀 监视「w」（bg_1）有新输出：\nabc')), null, '新输出不是结束');
    assert.equal(view.parseBgWake(user('🔔 后台命令「x」已结束：退出码 0，用时 3 秒（bg_z）', { kirolex: true })), null);
    assert.equal(view.parseBgWake({ role: 'assistant', content: '🔔 后台命令「x」已结束：退出码 0，用时 3 秒（bg_z）' }), null);
  });
});

describe('给模型的文本不变：解析用的模板就是 bgJobs.ts 发出去的那几句', () => {
  test('每个模板 bgJobs.ts 里都原样出现', () => {
    const BG = read('main', 'bgJobs.ts');
    for (const key of view.BG_WAKE_TEMPLATES) assert.ok(BG.includes(`'${key}'`), `bgJobs.ts 里没有这句了：${key}`);
  });
});

describe('渲染接线', () => {
  const CHAT = strip(read('renderer', 'components', 'ChatArea.tsx'));
  test('后台命令 / 监视结束单独成组、画成 BgWakeCard，不走用户气泡组件', () => {
    assert.match(CHAT, /const bgWake = parseBgWake\(m\);\s*if \(bgWake\) \{[\s\S]{0,200}groups\.push\(\{ kind: 'bgWake', message: m, card: bgWake \}\)/);
    const at = CHAT.indexOf("group.kind === 'bgWake' ? (");
    assert.ok(at > 0, '渲染分支不见了');
    const branch = CHAT.slice(at, CHAT.indexOf(') : ', at + 30));
    assert.match(branch, /<BgWakeCard/);
    assert.doesNotMatch(branch, /UserGroupItem/);
    const card = CHAT.slice(CHAT.indexOf('const BgWakeCard'), CHAT.indexOf('const ScheduleEndCard'));
    assert.ok(card.length > 0);
    assert.doesNotMatch(card, /UserGroupItem|user-message/);
    assert.match(card, /schedule-card/, '复用定时卡片的样式');
    assert.match(card, /<details className="[^"]*bg-wake-output/, '输出默认折叠');
    assert.match(card, /card\.output \?/, '没有输出就不显示');
  });
  test('摘要那行不摆内部 id：id 只在详情 / 悬停提示里', () => {
    const card = CHAT.slice(CHAT.indexOf('const BgWakeCard'), CHAT.indexOf('const ScheduleEndCard'));
    const title = card.slice(card.indexOf('const title'), card.indexOf('\n', card.indexOf('const title')));
    assert.doesNotMatch(title, /jobId/);
    assert.match(card, /card\.jobId/);
  });
});
