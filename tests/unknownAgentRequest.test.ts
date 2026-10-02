import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { AcpClient } from '../src/main/acp-client.ts';

/*
  **替用户回答之前必须先说出来** —— 这条兜底原来是静默的。

  今天只有 `session/request_permission` 会向客户端要答案（kiro-cli 的二进制里
  `session/request_user_input` / `ask` / `choice` 一个都没有），所以这条分支走不到。
  但它哪天走到了，后果是：KiroLex 替用户答一个空对象，而用户、日志、界面三处都看不见
  —— 那一轮就按一个没人给过的答案继续跑。
*/
const src = fs.readFileSync(new URL('../src/main/acp-client.ts', import.meta.url), 'utf8');

/** 把那条分支的代码取出来（剥注释 —— 解释旧行为的注释里有同样的字）。 */
function fallbackBranch(): string {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  const at = code.indexOf('private handleAgentRequest');
  assert.ok(at > 0);
  return code.slice(at, at + 1800);
}

test('不认识的请求：先 emit error（进日志也进界面），再回 {}', () => {
  const b = fallbackBranch();
  const emitAt = b.indexOf("this.emit('error'");
  const sendAt = b.lastIndexOf("result: {} }");
  assert.ok(emitAt > 0, '没有走 error 通道说出来 —— 那它就还是静默的');
  assert.ok(sendAt > emitAt, 'emit 要在回包之前（回包之后那一轮可能已经走了）');
});

test('仍然要回包 —— 不回会让那一轮挂住等超时', () => {
  assert.match(fallbackBranch(), /result: \{\} \}/);
});

test('真跑一遍：事件带上方法名，而且回包的 id 对得上', () => {
  /*
    直接驱动那个私有方法 —— 判据是"行为"，不是源码形状：
    一个不认识的 method 进去，要能看到 error 事件 + 一个 id 对得上的空结果。
    不起真进程（不需要 kiro-cli，也不该在测试里拉它）。
  */
  const c: any = new AcpClient('claude-opus-5', {}, undefined, 'ask');
  const sent: any[] = [];
  c.send = (m: any) => sent.push(m);
  const errs: any[] = [];
  (c as EventEmitter).on('error', (e: any) => errs.push(e));

  c.handleAgentRequest({ jsonrpc: '2.0', id: 77, method: 'session/請你選一個', params: { a: 1 } });

  assert.equal(errs.length, 1, '没有报出来');
  assert.equal(errs[0].type, 'unknown-request');
  assert.match(errs[0].message, /session\/請你選一個/);
  assert.deepEqual(sent, [{ jsonrpc: '2.0', id: 77, result: {} }]);
});

test('已知的权限请求不受影响 —— 它不该被当成"不认识"报错', () => {
  const c: any = new AcpClient('claude-opus-5', {}, undefined, 'auto-approve');
  const sent: any[] = [];
  c.send = (m: any) => sent.push(m);
  const errs: any[] = [];
  (c as EventEmitter).on('error', (e: any) => errs.push(e));

  c.handleAgentRequest({
    jsonrpc: '2.0', id: 9, method: 'session/request_permission',
    params: { options: [{ optionId: 'allow', kind: 'allow_once' }] },
  });
  assert.equal(errs.length, 0, '权限请求被误报成不认识的请求');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].result.outcome.outcome, 'selected');
});
