/**
 * 引擎在界面上叫什么（和主进程 `engines.ts` 的 `ENGINE_LABEL` 一致；那个文件 import 了 fs / child_process，渲染端用不了）。
 * 会话记录里 `engine` 缺省 = kiro。提示文案里说「等待 {engine} 响应」这类话时用它，别写死 Kiro。
 */
export const ENGINE_LABEL = { kiro: 'Kiro', claude: 'Claude Code', codex: 'Codex' } as const;

export function engineLabel(engine: string | null | undefined): string {
  return engine === 'claude' || engine === 'codex' ? ENGINE_LABEL[engine] : ENGINE_LABEL.kiro;
}

/** 说「跑在哪台机器上的那个进程」时的叫法：kiro 会话说 kiro-cli（原来的文案），另外两家就是引擎名 */
export function engineCliName(engine: string | null | undefined): string {
  return engine === 'claude' || engine === 'codex' ? ENGINE_LABEL[engine] : 'kiro-cli';
}
