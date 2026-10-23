/**
 * 模型向用户提问（ACP `elicitation/create` form 模式）的纯逻辑：schema → 卡片控件、回包、摘要。
 *
 * 用到的两份 schema 是 2026-10-23 用真适配器抓到的原样（claude-agent-acp 0.88 的 AskUserQuestion、
 * codex-acp 2.1.1 Plan 模式下的 request_user_input），见 `src/main/elicitation.ts` 头注释。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLIENT_CAPABILITIES, QUESTION_TIMEOUT_MS, parseRequestedSchema, initialValues, buildAcceptContent,
  elicitationResult, newQuestionCard, closeQuestionCard, answerLines, questionTailText, redactAnswer,
} from '../src/main/elicitation.ts';

const CLAUDE_SCHEMA = {
  type: 'object',
  properties: {
    question_0: {
      type: 'string', title: 'Color', description: 'Which color?',
      oneOf: [
        { const: 'Red', title: 'Red', description: 'Red' },
        { const: 'Green', title: 'Green', description: 'Green' },
        { const: 'Blue', title: 'Blue', description: 'A calm one' },
      ],
    },
    question_0_custom: { type: 'string', title: 'Other', description: 'Type your own answer, or add a note to the option you chose above (optional).' },
    question_1: {
      type: 'array', title: 'Fruits', description: 'Which fruits?',
      items: { anyOf: [{ const: 'Apple', title: 'Apple' }, { const: 'Banana', title: 'Banana' }, { const: 'Cherry', title: 'Cherry' }] },
    },
    question_1_custom: { type: 'string', title: 'Other', description: 'Type your own answer to add to your selection above (optional).' },
  },
};

const CODEX_SCHEMA = {
  type: 'object',
  properties: {
    database: {
      title: 'Which database?', description: 'Database', _meta: { codex: { isOther: true, isSecret: false } },
      type: 'string',
      oneOf: [
        { const: 'Postgres', title: 'Postgres', description: 'Choose Postgres.' },
        { const: 'MySQL', title: 'MySQL', description: 'Choose MySQL.' },
        { const: 'None of the above', title: 'None of the above', description: 'Provide a different answer in the note field.' },
      ],
    },
    database_note: { type: 'string', title: 'Additional answer or note', _meta: { codex: { questionId: 'database', role: 'user_note', isSecret: false } } },
    token: { type: 'string', title: 'API token', _meta: { codex: { isSecret: true } } },
  },
  required: ['database'],
};

describe('clientCapabilities 声明', () => {
  test('只声明 elicitation.form（url 不声明）', () => {
    assert.deepEqual(CLIENT_CAPABILITIES, { elicitation: { form: {} } });
    assert.equal('url' in CLIENT_CAPABILITIES.elicitation, false);
  });
});

describe('requestedSchema → 卡片控件', () => {
  test('Claude Code：单选 oneOf、多选 array.anyOf、每题的「其他」框挂到那一题', () => {
    const { fields } = parseRequestedSchema(CLAUDE_SCHEMA);
    assert.deepEqual(fields.map((f) => [f.key, f.kind, f.customFor]), [
      ['question_0', 'single', undefined],
      ['question_0_custom', 'text', 'question_0'],
      ['question_1', 'multi', undefined],
      ['question_1_custom', 'text', 'question_1'],
    ]);
    assert.equal(fields[0].title, 'Color');
    assert.equal(fields[0].description, 'Which color?');
    /* 和标题一字不差的选项说明是噪音，去掉；真的说明留着 */
    assert.deepEqual(fields[0].options, [
      { value: 'Red', title: 'Red' }, { value: 'Green', title: 'Green' }, { value: 'Blue', title: 'Blue', description: 'A calm one' },
    ]);
    assert.deepEqual(fields[2].options?.map((o) => o.value), ['Apple', 'Banana', 'Cherry']);
  });

  test('Codex：user_note 备注框挂到 questionId 那一题；isSecret → 密文；required 认得', () => {
    const { fields } = parseRequestedSchema(CODEX_SCHEMA);
    const by = Object.fromEntries(fields.map((f) => [f.key, f]));
    assert.equal(by.database.kind, 'single');
    assert.equal(by.database.required, true);
    assert.equal(by.database_note.customFor, 'database');
    assert.equal(by.database_note.required, false);
    assert.equal(by.token.secret, true);
    assert.equal(by.token.customFor, undefined);
  });

  test('enum（无标题）单选 / 多选、string、boolean、number、integer 及其约束', () => {
    const { fields, title, description } = parseRequestedSchema({
      type: 'object', title: 'Setup', description: 'A few things',
      properties: {
        env: { type: 'string', enum: ['dev', 'prod'], enumNames: ['Development', 'Production'], default: 'dev' },
        tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, minItems: 1, maxItems: 2 },
        name: { type: 'string', minLength: 2, maxLength: 5, default: 'x' },
        ok: { type: 'boolean', default: true },
        ratio: { type: 'number', minimum: 0, maximum: 1 },
        count: { type: 'integer', minimum: 1 },
      },
    });
    assert.equal(title, 'Setup');
    assert.equal(description, 'A few things');
    const by = Object.fromEntries(fields.map((f) => [f.key, f]));
    assert.equal(by.env.kind, 'single');
    assert.deepEqual(by.env.options, [{ value: 'dev', title: 'Development' }, { value: 'prod', title: 'Production' }]);
    assert.equal(by.tags.kind, 'multi');
    assert.deepEqual([by.tags.minItems, by.tags.maxItems], [1, 2]);
    assert.deepEqual([by.name.kind, by.name.minLength, by.name.maxLength], ['text', 2, 5]);
    assert.equal(by.ok.kind, 'boolean');
    assert.deepEqual([by.ratio.kind, by.ratio.minimum, by.ratio.maximum], ['number', 0, 1]);
    assert.deepEqual([by.count.kind, by.count.minimum], ['integer', 1]);
    assert.deepEqual(initialValues(fields), { env: 'dev', tags: [], name: 'x', ok: true });
  });

  test('坏 schema 不抛：没有属性就是一张只有说明和按钮的卡片', () => {
    assert.deepEqual(parseRequestedSchema(null).fields, []);
    assert.deepEqual(parseRequestedSchema({ properties: { a: 'nope' } }).fields, []);
  });
});

describe('回包格式', () => {
  const { fields } = parseRequestedSchema(CLAUDE_SCHEMA);

  test('accept：只带填了的项，选项和自由填写都在', () => {
    const r = buildAcceptContent(fields, { question_0: 'Green', question_0_custom: '  ', question_1: ['Apple', 'Cherry'], question_1_custom: 'Kiwi' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && elicitationResult('accept', r.content), {
      action: 'accept', content: { question_0: 'Green', question_1: ['Apple', 'Cherry'], question_1_custom: 'Kiwi' },
    });
  });

  test('decline / cancel 不带 content（跳过 / 停止 / 超时都是这两种之一）', () => {
    assert.deepEqual(elicitationResult('decline'), { action: 'decline' });
    assert.deepEqual(elicitationResult('cancel'), { action: 'cancel' });
  });

  test('必填没填 → 不提交，说出是哪一项；选项外的值、数字越界 → invalid', () => {
    const codex = parseRequestedSchema(CODEX_SCHEMA).fields;
    assert.deepEqual(buildAcceptContent(codex, { database_note: 'x' }), { ok: false, missing: ['database'], invalid: [] });
    assert.deepEqual(buildAcceptContent(codex, { database: 'Oracle' }), { ok: false, missing: [], invalid: ['database'] });
    const nums = parseRequestedSchema({ type: 'object', properties: { n: { type: 'integer', minimum: 1 }, r: { type: 'number', maximum: 1 } } }).fields;
    assert.deepEqual(buildAcceptContent(nums, { n: '2.5', r: '3' }), { ok: false, missing: [], invalid: ['n', 'r'] });
    assert.deepEqual(buildAcceptContent(nums, { n: '2', r: '0.5' }), { ok: true, content: { n: 2, r: 0.5 } });
  });

  test('布尔：false 也是一个答案', () => {
    const f = parseRequestedSchema({ type: 'object', properties: { ok: { type: 'boolean' } } }).fields;
    assert.deepEqual(buildAcceptContent(f, { ok: false }), { ok: true, content: { ok: false } });
  });
});

describe('卡片：超时、关闭、落盘的摘要', () => {
  const base = { id: 'q_1', sessionId: 's1', requestId: 7, now: 1000, engine: 'claude' };

  test('新卡片是 pending，默认 30 分钟超时；Codex 的 autoResolutionMs 更短时用它', () => {
    const card = newQuestionCard({ ...base, params: { message: 'Pick', requestedSchema: CLAUDE_SCHEMA } });
    assert.equal(card.status, 'pending');
    assert.equal(card.expiresAt, 1000 + QUESTION_TIMEOUT_MS);
    assert.equal(card.fields.length, 4);
    const quick = newQuestionCard({ ...base, params: { message: 'x', requestedSchema: CODEX_SCHEMA, _meta: { codex: { autoResolutionMs: 60_000 } } } });
    assert.equal(quick.expiresAt, 61_000);
    const nul = newQuestionCard({ ...base, params: { message: 'x', requestedSchema: CODEX_SCHEMA, _meta: { codex: { autoResolutionMs: null } } } });
    assert.equal(nul.expiresAt, 1000 + QUESTION_TIMEOUT_MS);
  });

  test('关一次就定了：再关不改状态；答案里的密文换成 ••••', () => {
    const card = newQuestionCard({ ...base, params: { message: 'x', requestedSchema: CODEX_SCHEMA } });
    const done = closeQuestionCard(card, 'answered', 2000, { database: 'MySQL', token: 'sk-123' });
    assert.equal(done.status, 'answered');
    assert.equal(done.closedAt, 2000);
    assert.deepEqual(done.answer, { database: 'MySQL', token: '••••' });
    assert.equal(closeQuestionCard(done, 'timeout', 3000), done);
    const timedOut = closeQuestionCard(card, 'timeout', 3000);
    assert.equal(timedOut.status, 'timeout');
    assert.equal(timedOut.answer, undefined);
    assert.deepEqual(redactAnswer(card.fields, { token: 'a', database: 'b' }), { token: '••••', database: 'b' });
  });

  test('只读摘要：选项显示标题，「其他」里填的字并进那一题那一行；没答的题不列', () => {
    const card = closeQuestionCard(newQuestionCard({ ...base, params: { message: 'Please answer', requestedSchema: CLAUDE_SCHEMA } }),
      'answered', 2000, { question_0: 'Blue', question_0_custom: 'navy-ish', question_1: ['Apple', 'Banana'] });
    assert.deepEqual(answerLines(card), [
      { key: 'question_0', label: 'Color', value: 'Blue · navy-ish' },
      { key: 'question_1', label: 'Fruits', value: 'Apple, Banana' },
    ]);
    /* 只在「其他」里写了（没选选项）也算这一题的答案 */
    const typed = closeQuestionCard(newQuestionCard({ ...base, params: { message: 'x', requestedSchema: CLAUDE_SCHEMA } }), 'answered', 2000, { question_1_custom: 'Kiwi' });
    assert.deepEqual(answerLines(typed), [{ key: 'question_1', label: 'Fruits', value: 'Kiwi' }]);
  });

  test('写进 transcript 再读回来（JSON 往返）摘要不变 —— 重启后看到的就是这些', () => {
    const card = closeQuestionCard(newQuestionCard({ ...base, params: { message: 'Please answer', requestedSchema: CLAUDE_SCHEMA } }),
      'answered', 2000, { question_0: 'Red', question_1: ['Cherry'] });
    const line = JSON.stringify({ id: card.id, role: 'assistant', content: '', ts: card.askedAt, question: card });
    const back = JSON.parse(line).question;
    assert.deepEqual(answerLines(back), answerLines(card));
    assert.equal(back.status, 'answered');
  });

  test('控制入口 tail 的文字：问题、选项、状态、答案', () => {
    const card = newQuestionCard({ ...base, params: { message: 'Please answer', requestedSchema: CLAUDE_SCHEMA } });
    const pending = questionTailText(card);
    assert.match(pending, /^\[question pending\] Please answer/);
    assert.match(pending, /- Color \[question_0\] \(single\): Red \/ Green \/ Blue\n  \+ free text \[question_0_custom\]/);
    assert.match(pending, /- Fruits \[question_1\] \(multi\): Apple \/ Banana \/ Cherry/);
    assert.doesNotMatch(pending, /Other/);
    const answered = questionTailText(closeQuestionCard(card, 'answered', 2, { question_0: 'Red' }));
    assert.match(answered, /→ Color = Red/);
  });
});
