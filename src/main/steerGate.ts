/**
 * `acp:steer` 先查什么、后查什么 —— PURE（`tests/steerGate.test.ts`）。
 *
 * 顺序有讲究：**「这一轮已经结束」要排在「引擎支不支持 steer」前面**。没声明 steering 的执行器本来就插不进去（`busyEnterCaps.ts`），
 * 它们的一轮刚结束、渲染端还没收到时按下的 Enter，要的是「作为新消息发出」（`idle`），不是标红的「不支持」。
 * 重建历史和换执行器排在最前：那两种时候这条消息要等，而不是当作这一轮结束发出去。
 */
export type SteerRefusal = 'not-connected' | 'reconfiguring' | 'priming' | 'idle' | 'unsupported';

export function steerRefusal(s: {
  connected: boolean;
  reconfiguring: boolean;
  priming: boolean;
  busy: boolean;
  supportsSteer: boolean;
}): SteerRefusal | null {
  if (!s.connected) return 'not-connected';
  if (s.reconfiguring) return 'reconfiguring';
  if (s.priming) return 'priming';
  if (!s.busy) return 'idle';
  if (!s.supportsSteer) return 'unsupported';
  return null;
}
