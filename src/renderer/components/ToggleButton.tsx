/**
 * **开关 = 一颗按钮** ——「开关应该改成按钮形式」。
 *
 * 原来两处（备份那页的「定时同步」、设置里的「⚡ 开关」那一栏）都是**原生 checkbox** +
 * 一个「开/关」文字。三个问题：
 *
 * 1. **和这个界面里别的东西不是一套**。这里所有可点的东西都是按钮（`.remote-btn`）,
 *    中间夹一个系统画的白方块，看起来像没做完。
 * 2. **点击区域很别扭**。方块本身只有 13px，真正好点的是外面那个 `<label>` ——
 *    而"label 也能点"这件事是看不出来的，人会去瞄那个小方块。
 * 3. **状态要靠旁边那行字读**。方块本身勾/不勾在暗色背景上对比度很低，
 *    而「开」「关」两个字长得差不多宽 —— 扫一眼扫不出来。
 *
 * 所以做成一颗按钮：整块都能点，开的时候用强调色**填充**（不只是换个字），
 * 关的时候是普通描边。状态用颜色 + 文字**两个**通道说，这样扫一眼也不会看错。
 *
 * `role="switch"` + `aria-checked`：对读屏软件来说它仍然是一个开关，而不是"一颗会变字的按钮"。
 * 用真的 `<button>` 是为了白拿键盘支持（Space / Enter），原来那套 label + checkbox
 * 只有焦点落在那个 13px 的方块上时才能用键盘切。
 */

import React from 'react';
import { useT } from '../hooks/useLang';

export const ToggleButton: React.FC<{
  on: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** 开 / 关 各显示什么。默认中文「开」「关」。 */
  labels?: [on: string, off: string];
  title?: string;
  /** 给读屏用的名字（这一行的标签文字通常在按钮外面）。 */
  ariaLabel?: string;
}> = ({ on, onChange, disabled, labels, title, ariaLabel }) => {
  const t = useT();
  const [onText, offText] = labels || [t('On'), t('Off')];
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      className={`toggle-btn${on ? ' on' : ''}`}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!on)}
    >
      {/* 小圆点：颜色之外再给一个形状上的差别 —— 有人分不清这两种颜色 */}
      <span className="toggle-dot" aria-hidden="true" />
      {on ? onText : offText}
    </button>
  );
};
