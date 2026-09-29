import assert from 'node:assert/strict';
import test from 'node:test';
import { preflightScript, parseModels, parseModelMeta } from '../src/main/remotePreflight.ts';
test('模型列表走 --list-models 的 JSON —— 传错模型那招在 2.24+ 上会真跑一轮', () => {
  /*
    2.25.0 实测：`--model __kirolex_probe__` 不再在参数校验处报错，而是
      `[warn] failed to set model '__kirolex_probe__': Method not found`
    然后用默认模型答了一整轮。所以列表恒为空 + 每次白烧一次调用（gpt-5.6-sol 是 4.40x）。
    判据盯的是**命令形状**：新路必须在前，老路只能是兜底。
  */
  const s = preflightScript(undefined, { models: true });
  assert.match(s, /--list-models --format json/);
  const at = s.indexOf('--list-models');
  const fallbackAt = s.indexOf('__kirolex_probe__');
  assert.ok(at > 0 && fallbackAt > at, '兜底必须排在 --list-models 之后，否则每次都先烧一轮');
});

test('parseModels 认 JSON，取的是 model_id', () => {
  const json = JSON.stringify({
    models: [
      { model_name: 'auto', model_id: 'auto', rate_multiplier: 1.0, context_window_tokens: 1000000 },
      { model_name: 'claude-opus-5.5', model_id: 'claude-opus-5.5', rate_multiplier: 2.0, context_window_tokens: 1000000 },
    ],
    default_model: 'auto',
  });
  assert.deepEqual(parseModels(`KVER 2.25.0\nMODELSJSON ${json}`), ['auto', 'claude-opus-5.5']);
  const meta = parseModelMeta(`MODELSJSON ${json}`);
  assert.equal(meta['claude-opus-5.5'].rate, 2.0);
  assert.equal(meta['claude-opus-5.5'].context, 1000000);
});

test('JSON 坏了要退回老那条，而不是给个空列表', () => {
  assert.deepEqual(
    parseModels('MODELSJSON {not json\nAvailable models: auto, claude-opus-5'),
    ['auto', 'claude-opus-5'],
  );
  assert.deepEqual(parseModelMeta('MODELSJSON {not json'), {});
});

test('旧版（没有 --list-models）仍然能解析出列表', () => {
  assert.deepEqual(parseModels('Available models: auto, gpt-5.6-luna'), ['auto', 'gpt-5.6-luna']);
});
