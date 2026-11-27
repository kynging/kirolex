import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SUGGESTION_CONTEXT_MAX_PCT, lastAssistantReplyOf, replyInvitesFollowUp, suggestionGate } from '../src/main/promptSuggestions.ts';

/**
 * token 优化 5/5：kiro 会话的追问建议少调几次 —— 回复不是在问问题时不生成，上下文 ≥ 70% 时不生成，设置里关掉时完全不调。
 */
const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', ...p), 'utf-8');

describe('回复是不是在等用户接话', () => {
  test('最后一段以问号结尾 → 生成', () => {
    assert.equal(replyInvitesFollowUp('改好了。\n\n要我顺便把测试也补上吗？'), true);
    assert.equal(replyInvitesFollowUp('Done.\n\nShould I also update the docs?'), true);
    assert.equal(replyInvitesFollowUp('你想先看哪部分？**'), true, '结尾的 markdown 标记不算');
    assert.equal(replyInvitesFollowUp('Which one do you prefer?)\n\n'), true);
  });

  test('带编号 / 字母选项 → 生成', () => {
    assert.equal(replyInvitesFollowUp('有两种做法：\n1. 直接改配置\n2. 加一个开关'), true);
    assert.equal(replyInvitesFollowUp('可以这样：\nA. 保留旧接口\nB. 全部切新接口'), true);
    assert.equal(replyInvitesFollowUp('方案：\n① 先迁移\n② 后迁移'), true);
    assert.equal(replyInvitesFollowUp('下面几个选项：\n- 重启服务\n- 回滚版本'), true, '带「选项」引导的无序列表');
  });

  test('明确等用户决定（要不要 / 你定 / 选哪个 …）→ 生成', () => {
    assert.equal(replyInvitesFollowUp('这一步会删掉旧数据，要不要先备份一份。'), true);
    assert.equal(replyInvitesFollowUp('两种都行，你定。'), true);
    assert.equal(replyInvitesFollowUp('看你选哪个，我都能做'), true);
    assert.equal(replyInvitesFollowUp('Let me know which approach you want.'), true);
  });

  test('普通陈述 → 不生成', () => {
    assert.equal(replyInvitesFollowUp('已经改好了，测试全部通过。'), false);
    assert.equal(replyInvitesFollowUp('Done. All tests pass.'), false);
    assert.equal(replyInvitesFollowUp('这一版做了：\n- 修了登录\n- 加了日志'), false, '普通的变更清单不算选项');
    assert.equal(replyInvitesFollowUp('为什么会这样？因为缓存没清。\n\n现在已经修好了。'), false, '只看最后一段');
    assert.equal(replyInvitesFollowUp(''), false);
  });

  test('从对话文字里取最后一条助手回复', () => {
    assert.equal(lastAssistantReplyOf('User: 你好\n\nAssistant: 第一句\n\nUser: 再来\n\nAssistant: 要不要继续？'), '要不要继续？');
    assert.equal(lastAssistantReplyOf('User: 只有用户'), '');
  });
});

describe('判定：关开关 → 上下文高 → 不是在问问题', () => {
  const ask = '要我继续吗？';
  test('关掉追问建议 → off（不管别的）', () => {
    assert.deepEqual(suggestionGate({ enabled: false, contextPct: 10, reply: ask }), { ok: false, reason: 'off' });
  });
  test('上下文 ≥ 70% → context-high；69 还生成', () => {
    assert.equal(SUGGESTION_CONTEXT_MAX_PCT, 70);
    assert.deepEqual(suggestionGate({ enabled: true, contextPct: 70, reply: ask }), { ok: false, reason: 'context-high' });
    assert.deepEqual(suggestionGate({ enabled: true, contextPct: 88.5, reply: ask }), { ok: false, reason: 'context-high' });
    assert.deepEqual(suggestionGate({ enabled: true, contextPct: 69.9, reply: ask }), { ok: true });
    assert.deepEqual(suggestionGate({ enabled: true, contextPct: undefined, reply: ask }), { ok: true }, '不知道占用时不挡');
  });
  test('普通陈述 → not-a-question', () => {
    assert.deepEqual(suggestionGate({ enabled: true, contextPct: 20, reply: '改好了。' }), { ok: false, reason: 'not-a-question' });
  });
});

describe('接线', () => {
  const M = read('src', 'main', 'index.ts');
  const at = M.indexOf("ipcMain.handle('app:generate-suggestions'");
  const h = M.slice(at, M.indexOf("ipcMain.handle('acp:list-sessions'", at));

  test('判定在调用辅助模型之前，且在 Claude Code / Codex 分流之后（那两条路不变）', () => {
    const own = h.indexOf('if (own) return own;');
    const gate = h.indexOf('const gate = kiroSuggestionGate(meta, convo);');
    const skip = h.indexOf('if (!gate.ok) return { suggestions: [], skipped: gate.reason };');
    assert.ok(own > 0 && gate > own, '判定在分流之后');
    assert.ok(skip > gate && skip < h.indexOf('runLiteOneShot('), '跳过在 runLiteOneShot 之前');
    assert.ok(h.indexOf('suggestionsPrompt(convo)') > skip, '提示词照旧，只是在判定之后才拼');
  });

  test('判定用设置里的追问建议开关、主进程记下的上下文占用；跳过时记一行', () => {
    const from = M.indexOf('function kiroSuggestionGate(');
    assert.ok(from > 0);
    const body = M.slice(from, M.indexOf('\n}\n', from));
    assert.match(body, /isFeatureEnabled\('promptSuggestions'\)/);
    assert.match(body, /injectCadence\?\.contextPct/);
    assert.match(body, /logger\.info\('suggestions', `skipped reason=\$\{gate\.reason\}/);
  });

  test('渲染层：带上最后一条回复的结尾和上下文占用；被跳过的这一轮不再问', () => {
    const C = read('src', 'renderer', 'components', 'ChatArea.tsx');
    assert.match(C, /generateSuggestions\?\.\(recent, \{ sessionId: currentSessionId, messages: messages\.length, paneFocused, lastReply: [^,}]+, contextPercent: usage\?\.contextPercent \}\)/);
    assert.match(C, /else if \(r\?\.skipped\) \{ markSuggestionTried\(key\); return; \}/);
  });
});
