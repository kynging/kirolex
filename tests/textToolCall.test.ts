/**
 * 「一直给我输出一些代码不干活」—— 模型把工具调用写成正文（`<invoke name=…>`）就结束这一轮，什么都没执行。
 *
 * 守的是：
 *   1. 检测：只认**出现在正文末尾**的标记块；代码块里的示例、行内提到的标签、后面还有正文的都不算；
 *   2. 一轮结束时的处置：第一次补发一条纠正（KiroLex 提示），纠正那一轮还这样就停下；
 *   3. 历史里把这类块折叠成一句说明，不把整段标记原样喂回模型。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  detectTextToolCall,
  foldTextToolCall,
  splitTextToolCall,
  textToolCallVerdict,
  isTextToolNudgeId,
  TEXT_TOOL_NUDGE_PROMPT,
  TEXT_TOOL_NUDGE_ID_PREFIX,
} from '../src/main/textToolCall.ts';
import { chatHistoryBody } from '../src/renderer/historyBlock.ts';

const INVOKE = [
  '<invoke name="use_aws">',
  '<parameter name="__tool_use_purpose">查看实例上的服务状态</parameter>',
  '<parameter name="operation_name">send-command</parameter>',
  '<parameter name="service_name">ssm</parameter>',
  '</invoke>',
].join('\n');

describe('detectTextToolCall：各种标记形态', () => {
  test('回复末尾一段裸的 <invoke> → 判定，认出工具名', () => {
    const text = `好的，我现在去实例上看一下服务状态。\n\ncode\n${INVOKE}\n`;
    const hit = detectTextToolCall(text);
    assert.ok(hit);
    assert.deepEqual(hit.tools, ['use_aws']);
    /* 前面那行孤零零的 "code" 也算进块里（折叠时一起收掉） */
    assert.equal(text.slice(0, hit.start).trim(), '好的，我现在去实例上看一下服务状态。');
  });

  test('<function_calls> 包着多个 invoke → 判定，工具名按顺序去重', () => {
    const text = `下一步：\n<function_calls>\n<invoke name="bg_status">\n<parameter name="jobId">bg_1</parameter>\n</invoke>\n<invoke name="local_bash">\n<parameter name="command">ls</parameter>\n</invoke>\n<invoke name="bg_status">\n<parameter name="jobId">bg_2</parameter>\n</invoke>\n</function_calls>`;
    const hit = detectTextToolCall(text);
    assert.ok(hit);
    assert.deepEqual(hit.tools, ['bg_status', 'local_bash']);
  });

  test('带命名空间前缀（ns:invoke / ns:parameter）的写法 → 判定', () => {
    const NS = ['ant', 'ml:'].join('');   // 拼出来：这个前缀的字面量在别的工具链里会被当成真调用
    const text = `我来检查。\n<${NS}function_calls>\n<${NS}invoke name="bg_status">\n<${NS}parameter name="jobId">bg_9</${NS}parameter>\n</${NS}invoke>\n</${NS}function_calls>`;
    const hit = detectTextToolCall(text);
    assert.ok(hit);
    assert.deepEqual(hit.tools, ['bg_status']);
    assert.equal(text.slice(0, hit.start).trim(), '我来检查。');
  });

  test('只写了几个 <parameter name=…>（没有 invoke）→ 判定，工具名未知', () => {
    const hit = detectTextToolCall('继续：\n<parameter name="command">uptime</parameter>\n<parameter name="timeoutSec">60</parameter>');
    assert.ok(hit);
    assert.deepEqual(hit.tools, []);
  });

  test('写到一半就结束了（没有闭合标签）→ 也判定', () => {
    const hit = detectTextToolCall('接着看日志。\n<invoke name="local_bash">\n<parameter name="command">tail -n 50 /var/log/app.log');
    assert.ok(hit);
    assert.deepEqual(hit.tools, ['local_bash']);
  });

  test('整个回复末尾就是一个只装着标记的代码块 → 判定（末尾位置为准）', () => {
    const text = `好的，继续部署。\n\n\`\`\`xml\n${INVOKE}\n\`\`\`\n`;
    const hit = detectTextToolCall(text);
    assert.ok(hit);
    assert.deepEqual(hit.tools, ['use_aws']);
    assert.equal(text.slice(0, hit.start).trim(), '好的，继续部署。');
  });

  test('标记后面只剩一小句收尾 → 仍然判定', () => {
    assert.ok(detectTextToolCall(`我先查一下。\n${INVOKE}\n稍等。`));
  });

  test('CRLF 换行也认', () => {
    const hit = detectTextToolCall(`我去看一下。\r\n${INVOKE.replace(/\n/g, '\r\n')}\r\n`);
    assert.ok(hit);
    assert.deepEqual(hit.tools, ['use_aws']);
  });
});

describe('detectTextToolCall：不误判', () => {
  test('代码块里的示例、后面还有解释 → 不判定', () => {
    const text = `工具调用在协议里大概长这样：\n\n\`\`\`xml\n${INVOKE}\n\`\`\`\n\n其中 operation_name 是要调的接口名，service_name 是服务名。你在配置里只要写好权限就行，KiroLex 会负责把它发给后端。`;
    assert.equal(detectTextToolCall(text), null);
  });

  test('代码块里的示例放在中间、末尾是别的代码块 → 不判定', () => {
    const text = `示例：\n\`\`\`\n${INVOKE}\n\`\`\`\n然后运行：\n\`\`\`bash\nnpm test\n\`\`\``;
    assert.equal(detectTextToolCall(text), null);
  });

  test('末尾代码块里先是别的代码、再出现标记 → 不判定（那是展示，不是"只装着标记"）', () => {
    const text = `解析器要能处理这种输入：\n\`\`\`ts\nconst sample = \`\n${INVOKE}\n\`;\n\`\`\``;
    assert.equal(detectTextToolCall(text), null);
  });

  test('行内代码提到 `<invoke name="x">` → 不判定', () => {
    assert.equal(detectTextToolCall('不要在回复里写 `<invoke name="x">` 这种标记，直接调用工具。'), null);
  });

  test('标记在中间、后面还有一大段正文 → 不判定', () => {
    const text = `原来的输出是 ${INVOKE} 这样一段，说明模型把调用写成了文字。我已经改成直接调用工具，后面的步骤都会真的执行，下面是这次排查的结论和后续计划，请过目。`;
    assert.equal(detectTextToolCall(text), null);
  });

  test('普通回复 / 空 / 普通 HTML → 不判定', () => {
    assert.equal(detectTextToolCall('部署完成，所有检查都通过了。'), null);
    assert.equal(detectTextToolCall(''), null);
    assert.equal(detectTextToolCall('<div class="x">HTML 片段</div>'), null);
    assert.equal(detectTextToolCall('参数列表见 <parameters> 一节'), null);
  });
});

describe('textToolCallVerdict：一轮结束时怎么处置', () => {
  const bad = `好的，下一步查状态。\n${INVOKE}`;

  test('普通一轮把工具调用写成文字 → 补发一次纠正', () => {
    const v = textToolCallVerdict({ stopReason: 'end_turn', text: bad, correctionTurn: false });
    assert.equal(v.action, 'nudge');
    assert.deepEqual(v.hit?.tools, ['use_aws']);
  });

  test('纠正那一轮又这样（连续两轮）→ 停下，不再纠正', () => {
    const v = textToolCallVerdict({ stopReason: 'end_turn', text: bad, correctionTurn: true });
    assert.equal(v.action, 'stop');
  });

  test('纠正那一轮正常了 → 什么都不做', () => {
    assert.equal(textToolCallVerdict({ stopReason: 'end_turn', text: '已经查完了，状态正常。', correctionTurn: true }).action, 'none');
  });

  test('标记之后这一轮还有真实工具调用（tailFrom 指到最后一次工具调用处）→ 不判定', () => {
    /* 先把调用写成文字、随后又真的调了工具、之后没有再写字：tail 是空的 */
    const v = textToolCallVerdict({ stopReason: 'end_turn', text: bad, tailFrom: bad.length, correctionTurn: false });
    assert.equal(v.action, 'none');
  });

  test('先真调一个工具（bg_run）、再把下一步写成文字结束 → 判定（只看最后一次工具调用之后的正文）', () => {
    const before = '我先在后台起一个检查。';
    const text = `${before}\n\n已经起好了，接下来查状态：\n<invoke name="bg_status">\n<parameter name="jobId">bg_1</parameter>\n</invoke>`;
    const v = textToolCallVerdict({ stopReason: 'end_turn', text, tailFrom: before.length, correctionTurn: false });
    assert.equal(v.action, 'nudge');
    assert.deepEqual(v.hit?.tools, ['bg_status']);
  });

  test('不是 end_turn（被停止 / 超长截断）或要求跳过（侧栏改写）→ 不处置', () => {
    assert.equal(textToolCallVerdict({ stopReason: 'cancelled', text: bad, correctionTurn: false }).action, 'none');
    assert.equal(textToolCallVerdict({ stopReason: 'max_tokens', text: bad, correctionTurn: false }).action, 'none');
    assert.equal(textToolCallVerdict({ stopReason: 'end_turn', text: bad, correctionTurn: false, skip: true }).action, 'none');
  });

  test('纠正消息：用任务给定的原话；消息 id 能认出是纠正那一轮', () => {
    assert.equal(TEXT_TOOL_NUDGE_PROMPT, '上一条把工具调用写成了文字，没有执行。请直接调用工具继续，不要在回复里写 invoke 标记。');
    assert.ok(isTextToolNudgeId(`${TEXT_TOOL_NUDGE_ID_PREFIX}123`));
    assert.ok(!isTextToolNudgeId('u_123'));
    assert.ok(!isTextToolNudgeId(undefined));
  });
});

describe('审查跟进 1：明确的示例语境不误判（末尾的示例也一样），真的伪调用照样认', () => {
  test('前文写明「下面是工具调用格式的示例，仅供说明」、示例代码块在末尾 → 不判定、不纠正、不折叠', () => {
    const text = `下面是工具调用格式的示例，仅供说明：\n\n\`\`\`xml\n${INVOKE}\n\`\`\``;
    assert.equal(detectTextToolCall(text), null);
    assert.equal(textToolCallVerdict({ stopReason: 'end_turn', text, correctionTurn: false }).action, 'none');
    assert.equal(foldTextToolCall(text), text);
  });

  test('末尾示例后面接一小句说明（「仅供参考。」/「这只是格式示意。」）→ 不判定', () => {
    assert.equal(detectTextToolCall(`工具调用在协议里长这样：\n\`\`\`xml\n${INVOKE}\n\`\`\`\n仅供参考。`), null);
    assert.equal(detectTextToolCall(`调用的写法：\n\`\`\`xml\n${INVOKE}\n\`\`\`\n这只是格式示意。`), null);
  });

  test('没有围栏、但前一行写着「例如：」/ "For example:" → 不判定', () => {
    assert.equal(detectTextToolCall(`例如：\n${INVOKE}`), null);
    assert.equal(detectTextToolCall(`The raw call looks like this, for example:\n${INVOKE}`), null);
  });

  test('只看紧挨着的上下文：很早以前提过「格式」，最后一段是真的伪调用 → 照样判定', () => {
    const text = `我先确认了一下配置文件的格式，没有问题。\n\n第二步已经做完，第三步重启服务。\n现在去实例上看一下状态：\n${INVOKE}`;
    assert.ok(detectTextToolCall(text));
  });

  test('真的伪调用（「我来取命令输出：」+ 末尾代码块）照样判定', () => {
    assert.ok(detectTextToolCall(`我来取命令输出：\n\n\`\`\`xml\n${INVOKE}\n\`\`\`\n`));
  });
});

describe('审查跟进 2：标记之后又真调了工具 —— 判定、界面、历史同一个口径', () => {
  /* 事件顺序：正文里先写了一段 invoke 标记 → 后端开了一个真实工具调用（那一刻正文长度 = toolTailFrom）→ 之后没再写字 */
  const text = `我去看一下服务状态。\ncode\n${INVOKE}`;
  const toolTailFrom = text.length;

  test('一轮结束时不纠正', () => {
    assert.equal(textToolCallVerdict({ stopReason: 'end_turn', text, tailFrom: toolTailFrom, correctionTurn: false }).action, 'none');
  });

  test('界面不标「未执行」（splitTextToolCall 带 toolTailFrom 返回 null）', () => {
    assert.equal(splitTextToolCall(text, toolTailFrom), null);
    assert.equal(detectTextToolCall(text, toolTailFrom), null);
  });

  test('历史不写成「未执行」（foldTextToolCall 带 toolTailFrom 原样返回；渲染端历史块同样）', () => {
    assert.equal(foldTextToolCall(text, toolTailFrom), text);
    assert.equal(chatHistoryBody([{ role: 'assistant', content: text, toolTailFrom }]), `Assistant: ${text}`);
    /* 不带位置（老消息 / 没调过工具）照旧折叠 */
    assert.match(chatHistoryBody([{ role: 'assistant', content: text }]), /未执行/);
  });

  test('真实调用之后又写了一段 invoke 才结束 → 三处都认，范围相对整段正文', () => {
    const later = `${text}\n\n已经起好了，接下来：\n<invoke name="bg_status">\n<parameter name="jobId">bg_1</parameter>\n</invoke>`;
    assert.equal(textToolCallVerdict({ stopReason: 'end_turn', text: later, tailFrom: toolTailFrom, correctionTurn: false }).action, 'nudge');
    const s = splitTextToolCall(later, toolTailFrom);
    assert.ok(s);
    assert.deepEqual(s.tools, ['bg_status']);
    assert.ok(s.before.includes('<invoke name="use_aws">'), '真实调用之前那段不动');
    const folded = foldTextToolCall(later, toolTailFrom);
    assert.ok(folded.includes('<invoke name="use_aws">'));
    assert.match(folded, /（此处原本应调用工具 bg_status，但被写成了文字，未执行）$/);
  });
});

describe('foldTextToolCall / splitTextToolCall：历史和界面', () => {
  test('折叠成一句说明，前面的正文保留，标记一个都不剩', () => {
    const folded = foldTextToolCall(`好的，我现在去实例上看一下服务状态。\n\ncode\n${INVOKE}\n`);
    assert.equal(folded, '好的，我现在去实例上看一下服务状态。\n\n（此处原本应调用工具 use_aws，但被写成了文字，未执行）');
  });

  test('标记后那一小句收尾保留在说明后面', () => {
    assert.equal(foldTextToolCall(`我先查一下。\n${INVOKE}\n稍等。`), '我先查一下。\n\n（此处原本应调用工具 use_aws，但被写成了文字，未执行）\n\n稍等。');
  });

  test('多个工具名用顿号连起来；认不出工具名时也有一句', () => {
    assert.match(foldTextToolCall('x\n<invoke name="a"></invoke>\n<invoke name="b"></invoke>'), /调用工具 a、b，/);
    assert.match(foldTextToolCall('x\n<parameter name="c">1</parameter>'), /（此处原本应调用工具，但被写成了文字，未执行）/);
  });

  test('没有这类块的正文原样返回（包括代码块示例）', () => {
    const ex = `示例：\n\`\`\`xml\n${INVOKE}\n\`\`\`\n这就是格式，你不用手写，KiroLex 和后端会处理好，正常聊天就可以了，不需要关心这些细节。`;
    assert.equal(foldTextToolCall(ex), ex);
    assert.equal(foldTextToolCall('普通回复'), '普通回复');
  });

  test('splitTextToolCall：拆成「前面的正文 + 标记块 + 工具名」给界面折叠', () => {
    const s = splitTextToolCall(`我去看一下。\ncode\n${INVOKE}`);
    assert.ok(s);
    assert.equal(s.before, '我去看一下。');
    assert.ok(s.markup.includes('<invoke name="use_aws">'));
    assert.deepEqual(s.tools, ['use_aws']);
    assert.equal(s.after, '');
    assert.equal(splitTextToolCall('普通回复'), null);
  });
});

/*
 * 回放：那条 CDE 会话（kiro-cli + claude-opus-5.5，远程 tokyo-arm）从 10-19 10:21 起的 9 条「文字版工具调用」回复。
 * 那份 transcript 不在跑测试的这台机器上，fixture 按现象重建（账号 / 实例 / 命令 id 都是占位），
 * 形状保持：正文 + 末尾一段标记、toolCalls 为 0、end_turn；夹着 bg_run 唤醒、用户的「所以呢」和自动纠正。
 */
describe('回放：那 9 条回复', () => {
  const fixture = path.join(import.meta.dirname, 'fixtures', 'textToolCall-cde-replay.jsonl');
  const rows = fs.readFileSync(fixture, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const bad = rows.filter((r) => r.role === 'assistant' && r.expect === 'text-tool-call');
  const good = rows.filter((r) => r.role === 'assistant' && r.expect === 'ok');

  test('fixture 里正好 9 条问题回复，另有正常回复做对照；没有账号 ID 之类的敏感信息', () => {
    assert.equal(bad.length, 9);
    assert.ok(good.length >= 3);
    for (const r of rows) assert.ok(!/\b\d{12}\b|i-[0-9a-f]{17}\b/.test(JSON.stringify(r)), `含疑似账号 / 实例 id：${r.id}`);
  });

  test('9 条全部判定；对照的正常回复（含代码块示例）一条都不误判', () => {
    for (const r of bad) assert.ok(detectTextToolCall(r.content), `漏判：${r.id}`);
    for (const r of good) assert.equal(detectTextToolCall(r.content), null, `误判：${r.id}`);
  });

  test('9 条折叠后不再有任何调用标记，且说出了工具名', () => {
    for (const r of bad) {
      const f = foldTextToolCall(r.content);
      assert.ok(!/<\/?(?:[a-z]+:)?(?:invoke|parameter|function_calls)\b/.test(f), `折叠后还有标记：${r.id}`);
      assert.match(f, /此处原本应调用工具 [^，]+，但被写成了文字，未执行/);
    }
  });

  test('按时间顺序走一遍：每一轮最多纠正一次，纠正那一轮再犯就停下，纠正那一轮从不再纠正', () => {
    const actions: string[] = [];
    let prompt = '';
    for (const r of rows) {
      if (r.role !== 'assistant') { prompt = r.id; continue; }
      const correctionTurn = isTextToolNudgeId(prompt);
      const v = textToolCallVerdict({ stopReason: r.stopReason, text: r.content, tailFrom: r.tailFrom || 0, correctionTurn });
      if (correctionTurn) assert.notEqual(v.action, 'nudge', `纠正那一轮又被纠正：${r.id}`);
      actions.push(`${r.id}:${v.action}`);
    }
    for (const r of rows) if (r.role === 'assistant' && r.expectAction) assert.ok(actions.includes(`${r.id}:${r.expectAction}`), `${r.id} 应为 ${r.expectAction}，实际 ${actions.find((a) => a.startsWith(r.id + ':'))}`);
    assert.ok(actions.some((a) => a.endsWith(':nudge')));
    assert.ok(actions.some((a) => a.endsWith(':stop')));
  });
});