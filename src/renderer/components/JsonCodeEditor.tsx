import React, { forwardRef, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import hljs from 'highlight.js';
import { useT } from '../hooks/useLang';

/**
 * **设置里 JSON 配置的编辑框**（Kiro agent、Claude Code settings.json、组合 mcp-combos.json …）：
 * 行号 + 语法高亮 + 等宽字体，长内容可滚动。
 *
 * 做法是一个透明文字的 `<textarea>` 叠在高亮好的 `<pre>` 上面：输入、选区、撤销、Ctrl+S 都还是原生 textarea 的，
 * 高亮层只跟着它的滚动位置平移。字体 / 字号 / 行高 / padding 两边必须一样（global.css 的 `.json-code-editor`）。
 *
 * 外面那层 `agent-config-editor-shell` 由调用方给（它决定 valid / invalid 的边框），这里只画里面。
 */

/** 太大的文件不高亮（highlight.js 逐键重跑会卡），照样显示原文。 */
const HIGHLIGHT_LIMIT = 200_000;

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface JsonCodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  /** 出错的那一行（1 起），行号栏标红。 */
  errorLine?: number | null;
  onKeyDown?: React.KeyboardEventHandler<HTMLTextAreaElement>;
  ariaLabel?: string;
  autoFocus?: boolean;
}

export const JsonCodeEditor = forwardRef<HTMLTextAreaElement, JsonCodeEditorProps>(function JsonCodeEditor(
  { value, onChange, readOnly, errorLine, onKeyDown, ariaLabel, autoFocus },
  ref,
) {
  const t = useT();
  const gutterRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLElement>(null);
  const lineCount = useMemo(() => value.split('\n').length, [value]);
  const html = useMemo(() => {
    if (value.length > HIGHLIGHT_LIMIT) return escapeHtml(value);
    try { return hljs.highlight(value, { language: 'json', ignoreIllegals: true }).value; } catch { return escapeHtml(value); }
  }, [value]);

  const sync = useCallback((ta: HTMLTextAreaElement) => {
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop;
    if (codeRef.current) codeRef.current.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
  }, []);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const setTextarea = useCallback((el: HTMLTextAreaElement | null) => {
    taRef.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) ref.current = el;
  }, [ref]);
  /* 内容整体换掉（打开另一个文件、点「格式化」）后 textarea 的滚动位置可能变了，高亮层跟上 */
  useLayoutEffect(() => { if (taRef.current) sync(taRef.current); }, [value, sync]);

  return (
    <>
      <div ref={gutterRef} className="agent-config-line-numbers" aria-hidden="true">
        {Array.from({ length: lineCount }, (_, index) => {
          const lineNumber = index + 1;
          const isErrorLine = errorLine === lineNumber;
          return (
            <span key={lineNumber} className={isErrorLine ? 'error' : ''} title={isErrorLine ? t('JSON error on this line') : undefined}>
              {lineNumber}
            </span>
          );
        })}
      </div>
      <div className="json-code-editor">
        <pre className="json-code-editor-highlight" aria-hidden="true">
          {/* 末尾补一个换行：textarea 最后一行是空行时高亮层也要有那一行的高度 */}
          <code ref={codeRef} dangerouslySetInnerHTML={{ __html: `${html}\n` }} />
        </pre>
        <textarea
          ref={setTextarea}
          className="agent-config-editor-textarea"
          value={value}
          readOnly={readOnly}
          onChange={(ev) => onChange?.(ev.target.value)}
          onScroll={(ev) => sync(ev.currentTarget)}
          onSelect={(ev) => sync(ev.currentTarget)}
          onKeyDown={onKeyDown}
          aria-invalid={!!errorLine}
          aria-label={ariaLabel}
          spellCheck={false}
          autoFocus={autoFocus}
        />
      </div>
    </>
  );
});
