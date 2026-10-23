import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import { pickEngineModel, newChatModel, reshapeProfileForEngine, withEngineModelUsed, KIRO_NEW_CHAT_ORDER } from '../src/main/engineModelPick.ts';

/*
 * 「模型兜底按引擎分开」—— Claude Code 没有 gpt，Codex 不能选 claude：kiro 的兜底链 / 清单 / 偏好不套到它们身上。
 * 它们只在自己适配器报的 configOptions（category: 'model'）里兜底，并在会话里说一句。
 */

const KIRO_IDS = ['claude-opus-5', ...KIRO_NEW_CHAT_ORDER];
const CLAUDE_OPTS = {
  current: 'default',
  options: ['default', 'sonnet', 'opus', 'haiku', 'global.anthropic.claude-fable-5-1'].map((value) => ({ value, name: value })),
};
const CODEX_OPTS = { current: 'gpt-5.5-codex', options: [{ value: 'gpt-5.5-codex', name: 'GPT-5.5 Codex' }, { value: 'gpt-5.5-mini', name: 'mini' }] };

describe('pickEngineModel：Claude Code / Codex 记住的模型 → 这次设哪个、要不要说', () => {
  test('kiro 不走这里（现有降级链原样）', () => {
    assert.equal(pickEngineModel('kiro', 'claude-opus-5', undefined, CLAUDE_OPTS), null);
  });

  test('记住的在清单里 → 就用它，不提示', () => {
    assert.deepEqual(pickEngineModel('claude', 'opus', undefined, CLAUDE_OPTS), { value: 'opus' });
  });

  test('Claude 记住的不在清单 → 上次成功用的（在清单里）+ 提示', () => {
    assert.deepEqual(pickEngineModel('claude', 'claude-old-4', 'sonnet', CLAUDE_OPTS), { value: 'sonnet', fallbackFrom: 'claude-old-4' });
  });

  test('上次成功用的也不在 → 适配器的 default，再没有就是当前值', () => {
    assert.deepEqual(pickEngineModel('claude', 'claude-old-4', 'gone', CLAUDE_OPTS), { value: 'default', fallbackFrom: 'claude-old-4' });
    assert.deepEqual(pickEngineModel('codex', 'o9', undefined, CODEX_OPTS), { value: 'gpt-5.5-codex', fallbackFrom: 'o9' });
  });

  test('绝不选出另一引擎的 id：kiro 的 id 记成了 Claude / Codex 的模型，也只在本引擎清单里挑', () => {
    for (const kiroId of KIRO_IDS) {
      const c = pickEngineModel('claude', kiroId, kiroId, CLAUDE_OPTS)!;
      assert.ok(CLAUDE_OPTS.options.some((o) => o.value === c.value), `${kiroId} -> ${c.value}`);
      assert.ok(!KIRO_IDS.includes(c.value));
      const x = pickEngineModel('codex', kiroId, 'sonnet', CODEX_OPTS)!;
      assert.ok(CODEX_OPTS.options.some((o) => o.value === x.value), `${kiroId} -> ${x.value}`);
      assert.notEqual(x.value, 'sonnet', 'Claude 的值不给 Codex');
    }
  });

  test('没记过 / 适配器没报清单 → 什么都不做（没依据不乱设）', () => {
    assert.equal(pickEngineModel('claude', undefined, 'sonnet', CLAUDE_OPTS), null);
    assert.equal(pickEngineModel('claude', 'opus', undefined, null), null);
    assert.equal(pickEngineModel('claude', 'opus', undefined, { current: '', options: [] }), null);
  });
});

describe('连续两次连接：第一次兜底挑中的，第二次先沿用它', () => {
  /* 模拟 applyEngineModel：pick → 适配器接受 → withEngineModelUsed（index.ts rememberEngineModelUsed 用的就是它） */
  const connect = (p: any, opts: { current: string; options: Array<{ value: string }> }) => {
    const pick = pickEngineModel('codex', p.engineModels?.codex, p.engineModelsUsed?.codex, opts)!;
    return { pick, profile: withEngineModelUsed(p, 'codex', pick.value) };
  };

  test('记住的和旧成功的都没了 → 用当前值 A；换到有 A、但当前是 B 的机器 → 还是 A', () => {
    const p0 = { model: 'default', engine: 'codex' as const, engineModels: { codex: 'o9' }, engineModelsUsed: { codex: 'gone' } };
    const first = connect(p0, { current: 'A', options: [{ value: 'A' }, { value: 'C' }] });
    assert.deepEqual(first.pick, { value: 'A', fallbackFrom: 'o9' });
    assert.equal(first.profile.engineModelsUsed?.codex, 'A', '兜底挑中、适配器接受了的也记成上次成功用的');
    assert.equal(first.profile.engineModels?.codex, 'o9', '你选的不动');
    const second = connect(first.profile, { current: 'B', options: [{ value: 'B' }, { value: 'A' }] });
    assert.deepEqual(second.pick, { value: 'A', fallbackFrom: 'o9' });
    assert.equal(second.profile.engineModels?.codex, 'o9');
  });

  test('没变就返回原对象（不写盘）；不碰 kiro 的字段', () => {
    const p = { model: 'gpt-5.6-sol', preferredModel: 'claude-opus-5', modelEarnedOn: 'local', engineModelsUsed: { codex: 'A' } };
    assert.equal(withEngineModelUsed(p, 'codex', 'A'), p);
    const q = withEngineModelUsed(p, 'claude', 'sonnet');
    assert.deepEqual(q.engineModelsUsed, { codex: 'A', claude: 'sonnet' });
    assert.equal(q.model, 'gpt-5.6-sol'); assert.equal(q.preferredModel, 'claude-opus-5'); assert.equal(q.modelEarnedOn, 'local');
  });
});

describe('newChatModel：新建会话塞哪个模型', () => {
  test('kiro 不变：上次手选的 → 兜底链里目标机器有的第一个', () => {
    assert.equal(newChatModel('kiro', undefined, undefined), 'claude-opus-5');
    assert.equal(newChatModel('kiro', 'deepseek-3.2', []), 'deepseek-3.2');
    assert.equal(newChatModel('kiro', undefined, ['gpt-5.6-terra', 'glm-5']), 'gpt-5.6-terra');
    assert.equal(newChatModel('kiro', 'glm-5', ['gpt-5.6-terra', 'glm-5']), 'glm-5');
  });

  test('Claude Code / Codex 不返回 kiro 模型 id（留空，由 engineModels + 适配器清单决定）', () => {
    for (const engine of ['claude', 'codex'] as const) {
      for (const list of [undefined, [], KIRO_IDS]) {
        const m = newChatModel(engine, 'claude-opus-5', list);
        assert.equal(m, '');
        assert.ok(!KIRO_IDS.includes(m));
      }
    }
  });
});

describe('reshapeProfileForEngine：换引擎时各引擎记住的模型互不覆盖', () => {
  const base = {
    model: 'gpt-5.6-sol', preferredModel: 'claude-opus-5', modelEarnedOn: 'local', kiroAgent: 'mine',
    engineModels: { claude: 'opus', codex: 'gpt-5.5-mini' },
  };

  test('kiro → Claude → Codex → kiro：engineModels 原样保留，切回 kiro 用 kiro 的偏好模型', () => {
    const c = reshapeProfileForEngine(base, 'claude', 'claude-opus-5');
    assert.equal(c.engine, 'claude');
    assert.equal(c.model, 'default');
    assert.equal(c.preferredModel, 'claude-opus-5', 'kiro 的偏好不被 Claude 改写');
    assert.deepEqual(c.engineModels, base.engineModels);
    const x = reshapeProfileForEngine(c, 'codex', 'claude-opus-5');
    assert.deepEqual(x.engineModels, base.engineModels, 'Claude 记住的不被 Codex 覆盖');
    const k = reshapeProfileForEngine(x, 'kiro', 'claude-opus-5');
    assert.equal(k.engine, undefined);
    assert.equal(k.model, 'claude-opus-5');
    assert.equal(k.preferredModel, 'claude-opus-5');
    assert.deepEqual(k.engineModels, base.engineModels, '切回 Claude 时还是 opus');
  });

  test('Claude 新会话的占位 default 不会变成 kiro 的偏好', () => {
    const k = reshapeProfileForEngine({ engine: 'claude', model: 'default', preferredModel: 'default' }, 'kiro', 'claude-opus-5');
    assert.equal(k.preferredModel, 'claude-opus-5');
  });
});

describe('接线', () => {
  const M = fs.readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  const A = fs.readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

  test('applyEngineModel 的模型一项走 pickEngineModel，换了就说一句（不再静默跳过）', () => {
    const at = M.indexOf('async function applyEngineModel(');
    const body = M.slice(at, M.indexOf('\n}\n', at));
    assert.match(body, /pickEngineModel\(engine, want, /);
    assert.match(body, /modelFallback\.note\(sessionId, /);
    assert.match(body, /modelFallback\.commit\(sessionId\)/);
    /* 兜底挑中的也记成上次成功用的（不只在用上了记住的那个时记） */
    assert.match(body, /\n      \}\n[^\n]*\n      rememberEngineModelUsed\(sessionId, entry, engine, pick\.value\);/);
  });

  test('渲染层新建会话按引擎选模型', () => {
    assert.match(A, /newChatModel\(newChatEngine, /);
  });

  test('attach 不把渲染层带来的模型名写进 Claude / Codex 会话的记录', () => {
    /* 用记录里的值 → 后面「persist effective model」那段比对相等，不写 model / modelEarnedOn */
    assert.match(M, /const nonKiroAttach = engineOf\(existing\.profile\) !== 'kiro';/);
    assert.match(M, /model: nonKiroAttach \? \(existing\.profile\.model \|\| 'default'\) : \(model \|\| existing\?\.profile\.model \|\| DEFAULT_MODEL\)/);
  });
});
