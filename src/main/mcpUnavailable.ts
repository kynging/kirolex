/**
 * **这次会话准备没带上的 MCP：合并成一条、同一原因只说一次** ——「新会话用远程 codex 似乎很多报错…没有关闭按钮就很烦」。
 *
 * 实测（2026-10-25）：新建一条远程 Codex 会话，开头就插了 3 条 ⚠️（context7 没标 forwardFromLocal、builder-mcp /
 * agentcore-websearch 起不来），每新建一条会话都再来一遍。现在：
 *   · 同一次会话准备里没带上的（没标转发 / 这台电脑上找不到程序 / 起不来 / 缺环境变量）合并成**一条**，
 *     主句列名字 + 简短原因，每个的原因和怎么改放「详情」（写法按 docs/notices-glossary.md）；
 *   · 同一台电脑 + 同一个 MCP 配置 + 同一个原因只在第一次出现时进对话记录（`planMcpNotice`），
 *     之后的会话只在输入框上方挂一个小徽标（渲染端），点开看同样的详情；原因变了（装上了又坏了）才重新说。
 *     「说过了」记在 `~/.kirolex/mcp-notice-seen.json`（本机的，不进 S3 —— 这件事本来就按电脑算）。
 * 纯逻辑；读写文件的两个函数收 `home` 参数（测试传临时目录）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { tr, trConcat, trList } from './uiText.ts';
import { NOTE_DETAIL_SEP } from './kirolexNote.ts';

export type McpUnavailableKind = 'not-forwarded' | 'missing-command' | 'failed' | 'skipped';

export interface McpUnavailable {
  name: string;
  kind: McpUnavailableKind;
  /** 「详情」里这一个的那一句：为什么 + 怎么改 */
  detail: string;
  /** 「同一个原因」的判据（不给人看）：种类 + 具体原因（命令路径 / 报错原文…） */
  fingerprint: string;
}

/** 主句里名字后面括号里那几个字（同一原因的名字并在一起，原因只写一次）。 */
export function mcpUnavailableLabel(kind: McpUnavailableKind): string {
  switch (kind) {
    case 'not-forwarded': return tr('a remote session needs forwardFromLocal');
    case 'missing-command': return tr('program not found on this computer');
    case 'failed': return tr('failed to start');
    case 'skipped': return tr('skipped');
  }
}

/** 组合里没标「从本机转发」、远程会话里就没有的（`why` = forwardMcp 那句为什么）。 */
export function notForwardedItem(name: string, kind: 'http' | 'stdio', why: string): McpUnavailable {
  return {
    name, kind: 'not-forwarded', fingerprint: `not-forwarded:${kind}`,
    detail: trConcat(tr('{name}: to use it, add "forwardFromLocal": true to it in 🧩 MCP profiles and reopen the session.', { name }), ' ', why),
  };
}

/** 这台电脑上找不到它的程序（`reason` = `commandMissingReason`）：没起、也不会重试。 */
export function missingCommandItem(name: string, command: string, reason: string): McpUnavailable {
  return {
    name, kind: 'missing-command', fingerprint: `missing-command:${command}`,
    detail: trConcat(tr('{name}: {reason}.', { name, reason }), ' ',
      tr('In 🧩 MCP profiles, set a command for this computer or turn it off on this computer.')),
  };
}

/** 起了但没起来（连续失败 / 握手出错）。报错原文进指纹 —— 原因变了才重新说。 */
export function failedItem(name: string, reason: string): McpUnavailable {
  const why = String(reason || '').trim() || tr('Unknown error');
  return {
    name, kind: 'failed', fingerprint: `failed:${why.slice(0, 300)}`,
    detail: trConcat(tr('{name}: {reason}.', { name, reason: why }), ' ', tr('Check that its command runs on this machine, then reopen the session.')),
  };
}

/** 跳过的（缺环境变量 / 名字放不进转发地址…，`reason` 已经是给人看的话）。 */
export function skippedItem(name: string, reason: string): McpUnavailable {
  const why = String(reason || '').trim();
  return { name, kind: 'skipped', fingerprint: `skipped:${why}`, detail: tr('{name}: {reason}.', { name, reason: why }) };
}

/** 主句里的那一串：同一原因的名字并在一起（按第一次出现的顺序），原因写在最后一个名字后面。 */
function summaryList(items: McpUnavailable[]): string {
  const order: McpUnavailableKind[] = [];
  const names = new Map<McpUnavailableKind, string[]>();
  for (const it of items) {
    if (!names.has(it.kind)) { names.set(it.kind, []); order.push(it.kind); }
    names.get(it.kind)!.push(it.name);
  }
  return trList(order.map((k) => tr('{names} ({reason})', { names: trList(names.get(k)!), reason: mcpUnavailableLabel(k) })));
}

/**
 * 合并后的那一条（进对话记录 / 徽标里点开看的也是它）。主句：没带上几个、各是什么原因；「详情」：每个一行，为什么 + 怎么改。
 * 空列表 → ''。
 */
export function mcpUnavailableNotice(items: McpUnavailable[]): string {
  if (!items.length) return '';
  return trConcat(
    tr('⚠️ This session is missing {n} MCP(s): {list}. See Details for why and how to fix.', { n: items.length, list: summaryList(items) }),
    NOTE_DETAIL_SEP,
    items.map((it) => `· ${it.detail}`).join('\n'),
  );
}

/**
 * 哪些**只进徽标、不进对话记录**：找不到程序的（这台电脑上没有 / 远程会话里本机和远端都没有）——
 * 「别逼用户装」：程序本来就不在这台电脑上，不起、不重试，安静跳过；输入框上方的「⚠ N 个 MCP 不可用」里照样列出来。
 */
export function splitQuietMcpItems(items: McpUnavailable[]): { loud: McpUnavailable[]; quiet: McpUnavailable[] } {
  return {
    loud: items.filter((i) => i.kind !== 'missing-command'),
    quiet: items.filter((i) => i.kind === 'missing-command'),
  };
}

/** 「说过了」记录的作用域：哪台电脑 + 哪个 MCP 配置（Kiro 远程会话用 agent 名）。 */
export function mcpNoticeScope(machine: string, comboId: string): string {
  return `${String(machine || '').toLowerCase()}|${comboId}`;
}

export type McpNoticeSeen = Record<string, string>;

/** 记录最多留多少条（旧的先挤掉）：组合里删掉的 MCP 留下的条目不会再被清。 */
export const MCP_NOTICE_SEEN_MAX = 500;

/**
 * 这次要不要在对话记录里说：有一个 MCP 是第一次出现、或原因和上次不一样就说（`fresh` 是那几个）；全都说过了就不说。
 * `okNames` = 这次正常带上的：清掉它们的记录 —— 好过之后再坏，哪怕原因和以前一样，也算新的一次。
 * 返回新的记录（原对象不动）。
 */
export function planMcpNotice(
  items: McpUnavailable[], seen: McpNoticeSeen, scope: string, okNames: string[] = [],
): { say: boolean; fresh: string[]; next: McpNoticeSeen } {
  const next: McpNoticeSeen = { ...(seen || {}) };
  for (const n of okNames) delete next[`${scope}|${n}`];
  const fresh: string[] = [];
  for (const it of items) {
    const key = `${scope}|${it.name}`;
    if (next[key] === it.fingerprint) continue;
    fresh.push(it.name);
    delete next[key];          // 重新插到最后（挤掉时按最旧的先挤）
    next[key] = it.fingerprint;
  }
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - MCP_NOTICE_SEEN_MAX))) delete next[k];
  return { say: fresh.length > 0, fresh, next };
}

export function mcpNoticeSeenPath(home: string): string {
  return path.join(home, '.kirolex', 'mcp-notice-seen.json');
}

/** 读不了 / 坏了 = 什么都没说过（最坏是多说一次）。 */
export function readMcpNoticeSeen(home: string): McpNoticeSeen {
  try {
    const j = JSON.parse(fs.readFileSync(mcpNoticeSeenPath(home), 'utf-8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) return {};
    const out: McpNoticeSeen = {};
    for (const [k, v] of Object.entries(j)) if (typeof v === 'string') out[k] = v;
    return out;
  } catch { return {}; }
}

/** tmp + rename；写不进去不抛（最坏是下次多说一次）。 */
export function writeMcpNoticeSeen(home: string, seen: McpNoticeSeen): void {
  const file = mcpNoticeSeenPath(home);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(seen, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 本来就没写出来 */ }
  }
}
