/**
 * **不阻塞的错误提示** —— 代替 `window.alert`。
 *
 * alert 是模态的：它弹着的时候整个渲染进程的 JS 都停住（实测：两条会话同时切引擎、一条失败，
 * 那个弹窗挂在那里，界面上别的会话的输出也跟着停了，直到有人去点「确定」）。
 * 这里是一个角落里的条，过一会儿自己消失，点一下也能关。
 */
import React, { useEffect, useState } from 'react';
import { useT } from '../hooks/useLang';

interface Toast { id: number; text: string }
const EVENT = 'kirolex:toast';
let seq = 0;

export function showToast(text: string): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { id: ++seq, text: String(text || '') } }));
}

const LIFETIME_MS = 12_000;

export const Toasts: React.FC = () => {
  const [items, setItems] = useState<Toast[]>([]);
  const tr = useT();
  useEffect(() => {
    const on = (e: Event): void => {
      const t = (e as CustomEvent<Toast>).detail;
      if (!t?.text) return;
      setItems((prev) => [...prev.slice(-3), t]);
      setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== t.id)), LIFETIME_MS);
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  if (!items.length) return null;
  return (
    <div className="kx-toasts" role="status">
      {items.map((t) => (
        <div key={t.id} className="kx-toast" onClick={() => setItems((prev) => prev.filter((x) => x.id !== t.id))} title={tr('Click to dismiss')}>
          {t.text}
        </div>
      ))}
    </div>
  );
};
