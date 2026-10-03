import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

/*
  「agent 编辑界面如果 unsaved 不能直接 close，应该抛弃所有变更然后 close」。
  关闭这个动作本身就是"不要了"；草稿只在内存里，丢掉不会碰到任何已存的配置。
*/
const src = fs.readFileSync(new URL('../src/renderer/components/ChatArea.tsx', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

test('关闭直接丢弃草稿，不再弹确认', () => {
  const at = src.indexOf('const closeAgentConfig = useCallback(');
  assert.ok(at > 0);
  const body = src.slice(at, src.indexOf('}, [', at));
  assert.match(body, /discardAgentConfig\(\)/);
  assert.equal(/setConfirm\(/.test(body), false, '关闭时不该再弹确认框');
});

test('丢弃确实清掉了编辑器、所有草稿和状态行', () => {
  const at = src.indexOf('const discardAgentConfig = useCallback(');
  const body = src.slice(at, src.indexOf('}, [', at));
  assert.match(body, /setAgentConfigEditor\(null\)/);
  assert.match(body, /setAgentConfigDrafts\(\{\}\)/);
  assert.match(body, /setAgentConfigStatus\(null\)/);
});
