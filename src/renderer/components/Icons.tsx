import React from 'react';
import { accentEngine } from '../engineTheme.ts';
import { ENGINE_ICON_SHAPES } from '../engineIcons.ts';

interface IconProps {
  size?: number;
  className?: string;
}

/**
 * **引擎图标** —— 所有代表「这是哪个引擎」的地方都用它（分屏标题旁徽标、会话左下角那颗按钮、引擎配置面板标题、
 * 新建会话 / 设置里的引擎状态行、Claude Code / Codex 配置 tab、侧栏右键「引擎」子菜单）。
 * 三个形状类型不同（Kiro 方头机器人描边 / Claude Code 实心星芒 / Codex 空心结），见 `engineIcons.ts`；
 * 颜色是这个引擎的强调色（`engineTheme.ts`，设置「按引擎区分颜色」关掉时三者同色，形状照样不同）。
 */
export const EngineIcon: React.FC<{ engine?: string | null; size?: number; className?: string }> = ({ engine, size = 16, className }) => {
  const e = accentEngine(engine);
  const shape = ENGINE_ICON_SHAPES[e];
  return (
    <span className={`engine-icon${className ? ` ${className}` : ''}`} data-accent-engine={e} data-engine-icon={e} aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
        {shape.parts.map((p, i) => (
          <path key={i} d={p.d} fill={p.filled ? 'currentColor' : 'none'} stroke={p.filled ? 'none' : 'currentColor'} strokeWidth={p.filled ? undefined : shape.strokeWidth} />
        ))}
      </svg>
    </span>
  );
};

export const IconPaperclip: React.FC<IconProps> = ({ size = 17, className }) => (
  <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
);

export const IconQueue: React.FC<IconProps> = ({ size = 17, className }) => (
  <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 6h13M8 12h13M8 18h13" />
    <path d="M3 6h.01M3 12h.01M3 18h.01" />
  </svg>
);

export const IconAppendMessage: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 16.5 3.5 20v-5.2A7 7 0 0 1 7 2h6a7 7 0 0 1 0 14H7Z" />
    <path d="M14 10h6M17 7v6" />
  </svg>
);

// Steer: a redirect arrow folding back into the running stream — used on the
// send button while a turn is in flight and the queue is empty (Enter steers).
export const IconSteer: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="9 10 4 15 9 20" />
    <path d="M20 4v7a4 4 0 0 1-4 4H4" />
  </svg>
);

export const IconFolder: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);

export const IconWorkspaceFolder: React.FC<IconProps> = ({ size = 19, className }) => (
  <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 7a2 2 0 0 1 2-2h3.5a2 2 0 0 1 1.6.8l.8 1.07a2 2 0 0 0 1.6.8H18a2 2 0 0 1 2 2v6.33A2 2 0 0 1 18 18H6a2 2 0 0 1-2-2z" />
  </svg>
);

export const IconFile: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <polyline points="14 3 14 8 19 8" />
  </svg>
);

export const IconLogs: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <polyline points="14 3 14 8 19 8" />
    <line x1="8.5" y1="13" x2="15.5" y2="13" />
    <line x1="8.5" y1="16.5" x2="15.5" y2="16.5" />
  </svg>
);

export const IconDownload: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

export const IconBan: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <line x1="5.6" y1="5.6" x2="18.4" y2="18.4" />
  </svg>
);

export const IconArrowUp: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="12" y1="19" x2="12" y2="5" />
    <polyline points="5 12 12 5 19 12" />
  </svg>
);

export const IconRefresh: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="21 3 21 9 15 9" />
    <path d="M21 9a9 9 0 1 0-2.6 6.3" />
  </svg>
);

export const IconClose: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="5" y1="5" x2="19" y2="19" />
    <line x1="19" y1="5" x2="5" y2="19" />
  </svg>
);

export const IconCopy: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="8" y="8" width="13" height="13" rx="2" />
    <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
  </svg>
);

export const IconEdit: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
  </svg>
);

export const IconFork: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="6" cy="5" r="2" />
    <circle cx="18" cy="5" r="2" />
    <circle cx="12" cy="19" r="2" />
    <path d="M6 7v3a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7M12 12v5" />
  </svg>
);
