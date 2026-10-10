/**
 * 界面缩放快捷键：Ctrl(macOS 上是 ⌘) + 加号 / 减号 / 0。
 *
 * 在主进程的 `before-input-event` 里认（见 createWindow）：那里比页面的 keydown 先拿到，
 * 光标在输入框里也一样；macOS 自带菜单的 ⌘= / ⌘- / ⌘0 缩放也会被它挡下，不会和设置里的值各走各的。
 * **不带 Ctrl/⌘ 的 +/-/0 不归这里**——那是 PDF 预览自己的缩放键（PdfView.tsx）。
 */
export interface ZoomKeyInput {
  type: string;
  key: string;
  code: string;
  control: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

export function zoomKeyAction(input: ZoomKeyInput, platform: string): 'in' | 'out' | 'reset' | null {
  if (input.type !== 'keyDown' || input.alt) return null;
  const mod = platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta;
  if (!mod) return null;
  // 按字符认（不按物理键位）：`=` / `+` 是同一个键不按 / 按 Shift，小键盘 + 也是 `+`。
  // 小键盘 0 在 NumLock 关着时是 Insert（Ctrl+Insert = 复制），所以 0 只认字符 '0'。
  if (input.key === '=' || input.key === '+' || input.code === 'NumpadAdd') return 'in';
  if (input.key === '-' || input.key === '_' || input.code === 'NumpadSubtract') return 'out';
  if (input.key === '0') return 'reset';
  return null;
}
