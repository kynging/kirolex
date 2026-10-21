import type { Message } from './App';
import { messageVariants, t, type Lang } from './i18n.ts';
import { asVariants } from '../main/uiText.ts';
import { asSteerParts } from './steerSplit.ts';
import { cleanIpcError } from './sessionRequestStatus.ts';

/**
 * 「⚠️ 这条会话没连上：…」那条提示 —— 只在界面上，不落盘。
 *
 * 换了机器再连的时候要把旧的那条摘掉（不然切到远程还挂着本机的报错），
 * 所以构造和判据放在一起：只认 KiroLex 自己（`role: 'kirolex'`）说的、以这个开头的那种，
 * 用户或模型的消息哪怕字面一样也不动。
 */
export const CONNECT_FAILURE_PREFIX = '⚠️ 这条会话没连上：';
/** 英文界面下的同一个开头（只在界面上、不落盘，所以判据两种都认）。 */
const connectFailurePrefix = (lang: Lang): string => t(lang, "⚠️ This chat couldn't connect: ");
const CONNECT_FAILURE_PREFIXES = [CONNECT_FAILURE_PREFIX, connectFailurePrefix('en')];

export const connectFailureNotice = (rawWhy: string, now: number = Date.now(), lang: Lang = 'zh'): Message => {
  /* 新建会话 / 重连失败时原因前面套着 Electron 的「Error invoking remote method 'acp:new-session': Error: 」—— 只留我们自己的那句 */
  const why = cleanIpcError(rawWhy);
  /* 整句的中英两版：原因是 KiroLex 自己说的（主进程 tr() 出来的报错）就一起换，系统原文（ECONNREFUSED…）原样 */
  const reason = messageVariants(why);
  return {
    id: `msg_${now}`,
    role: 'kirolex' as any,
    content: `${connectFailurePrefix(lang)}${why}`,
    variants: { zh: `${connectFailurePrefix('zh')}${reason?.zh ?? why}`, en: `${connectFailurePrefix('en')}${reason?.en ?? why}` },
    timestamp: now,
  } as Message;
};

export const isConnectFailureNotice = (m: Pick<Message, 'role' | 'content'> | null | undefined): boolean =>
  !!m && (m.role as string) === 'kirolex' && typeof m.content === 'string' && CONNECT_FAILURE_PREFIXES.some((p) => (m.content as string).startsWith(p));

/** 摘掉所有连接失败提示；给了 `notice` 就换成这一条（只留一条，不并存）。 */
export const replaceConnectFailureNotices = (msgs: Message[], notice?: Message): Message[] => {
  const kept = msgs.filter((m) => !isConnectFailureNotice(m));
  if (notice) return [...kept, notice];
  return kept.length === msgs.length ? msgs : kept;
};

/**
 * **没缓存的后台会话，先把历史读进来再写提示** —— 消息缓存非空时，点开会话 / 分屏都会跳过读盘。
 * 直接往一个空缓存里塞一条失败提示，等于让这条会话的历史从界面上消失。
 *
 * 缓存已有内容就返回 `null`（不读、不覆盖）；读不到或读坏了也返回 `null`（不挡路）。
 * 形状和启动时分屏那一轮读盘一致。
 */
export const historyBeforeNotice = async (
  cached: Message[] | undefined,
  readTranscript: () => Promise<any[] | undefined | null>,
): Promise<Message[] | null> => {
  if (cached && cached.length > 0) return null;
  try {
    const t = await readTranscript();
    if (!Array.isArray(t) || t.length === 0) return null;
    return t.map((m: any) => ({
      id: m.id, role: m.role, content: m.content,
      toolCalls: m.toolCalls, attachments: m.attachments,
      pastes: m.pastes, timestamp: m.ts,
      ...(asSteerParts(m.steerParts) ? { steerParts: asSteerParts(m.steerParts) } : {}),
      ...(m.kirolex ? { kirolex: true as const } : {}),
      /* KiroLex 提示的中英两版 —— 漏了它，这条后台会话打开后提示就停在写下时的语言 */
      ...(asVariants(m.variants) ? { variants: asVariants(m.variants) } : {}),
    } as Message));
  } catch {
    return null;
  }
};
