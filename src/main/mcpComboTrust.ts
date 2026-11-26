/**
 * **从 S3 拉下来的组合，这台电脑上确认过才用** —— 安全扫描「S3-synced mcp-combos.json yields local command execution」。
 *
 * `mcp-combos.json` 跟着 S3 同步：别的电脑（或拿到桶写权限的人）写进去的 stdio MCP 是**在这台电脑上起的进程**，
 * http MCP 的 headers 里还会展开本机的环境变量。同步拉回 / 合并进来的、这台电脑上原来没有的那些 MCP 配置，
 * 记进本机的 `~/.kirolex/mcp-combos-untrusted.json`（不进 S3），会话准备 MCP 时跳过它们（`withholdUntrusted`），
 * 直到用户在设置里看过并保存一次组合文件（`trustCombosText`）。本机手改 / 设置里保存的不受影响。
 * 2026-11-26 起组合文件只存本机、不再同步：不会再有新的待确认项，以前同步来、还没确认的照旧拦着。
 *
 * 认的是**配置本身**（`serverTrustKey`：除了 `disabled` 之外整份，含 perMachine）—— 桶里改了某条 MCP 的命令 / 参数，
 * 那条也重新算没确认过。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseMcpCombos, localizeCombo, type McpCombo, type McpComboServer, type MachineIdentity } from './mcpCombos.ts';

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]));
  }
  return v;
}

/**
 * 一条 MCP 配置的指纹：开 / 关（`disabled`，包括 perMachine 里的「在这台电脑上禁用」）不算改了它 —— 关掉不会让它变危险；
 * 别的（命令、参数、env、url、headers、perMachine 里的命令 / 在哪跑…）都算。
 */
export function serverTrustKey(s: McpComboServer): string {
  const { disabled: _disabled, perMachine, ...rest } = s;
  const pm: Record<string, unknown> = {};
  for (const [k, o] of Object.entries(perMachine || {})) {
    const { disabled: _d, ...r } = o || {};
    if (Object.keys(r).length) pm[k] = r;
  }
  return crypto.createHash('sha256').update(JSON.stringify(stable(Object.keys(pm).length ? { ...rest, perMachine: pm } : rest))).digest('hex');
}

/** 文本里所有 MCP 配置的指纹；文本校验不过 → 空（等于"这台电脑原来什么都没有"）。 */
export function comboTextKeys(text: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  const r = parseMcpCombos(text);
  if (!r.ok) return out;
  for (const c of r.combos) for (const s of Object.values(c.mcpServers)) out.add(serverTrustKey(s));
  return out;
}

export function untrustedPath(home: string): string {
  return path.join(home, '.kirolex', 'mcp-combos-untrusted.json');
}

/** 没有这个文件 = 没有待确认的；文件坏了 / 读不了 → null（调用方按"全都没确认"处理，宁可不挂）。 */
export function readUntrusted(home: string): Set<string> | null {
  let text: string;
  try { text = fs.readFileSync(untrustedPath(home), 'utf-8'); } catch (err: any) {
    return err?.code === 'ENOENT' ? new Set() : null;
  }
  try {
    const j = JSON.parse(text);
    if (!Array.isArray(j) || j.some((k) => typeof k !== 'string')) return null;
    return new Set(j);
  } catch { return null; }
}

/** tmp + rename；写不进去就抛（拉取那边据此不改写组合文件）。 */
function writeUntrusted(home: string, keys: Set<string>): void {
  const file = untrustedPath(home);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify([...keys].sort(), null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 本来就没写出来 */ }
    throw err;
  }
}

/**
 * 同步要把本机组合文件从 `oldText` 改写成 `newText`（拉回 / 合并）之前调用：`newText` 里本机原来没有的 MCP 配置记成没确认过。
 * **只加不减，也不在之后清理**：换不成功时旧文件里待确认的那些必须照样拦着；桶里删掉的那条也一直记着 ——
 * 还开着的设置面板里那份旧文本被「在这台电脑上禁用」这类自动保存写回去时，它照样算没确认过。
 * 只有用户明确点保存（`trustCombosText`）才去掉。记的是 64 字符的摘要，只有从桶里来过的才记，不会大。
 * 写不进去就抛 —— 调用方这时**不能**改写组合文件。返回新记下的个数。
 */
export function markPulledUntrusted(home: string, oldText: string | undefined, newText: string): number {
  const before = comboTextKeys(oldText);
  const prev = readUntrusted(home);
  /* 读不了旧记录（= 全都不挂）：本机原来那些也照样算没确认过（宁可多问一次） */
  const next = new Set(prev || before);
  let added = 0;
  for (const k of comboTextKeys(newText)) {
    if (!before.has(k) && !next.has(k)) { next.add(k); added += 1; }
  }
  if (!prev || added) writeUntrusted(home, next);
  return added;
}

/**
 * **不算确认的保存**（「在这台电脑上禁用」/「为这台电脑设置命令」/「在哪跑」这类只改一条的自动保存）在写组合文件之前调用：
 * 这次要写的配置里，**磁盘上没有、或者磁盘上有但还没确认的**，都记成没确认过 —— 自动保存永远不放行任何东西。
 * 不按「组合 + 名字」去对旧条目：开着的旧面板里可能还留着同步已经删掉的条目，改一下 perMachine 指纹就变了，
 * 对不上旧条目也证明不了它确认过。代价：给已确认的那条设置本机命令 / 在哪跑之后，它也要再点一次保存才挂。
 * 只加不减；写不进去就抛 —— 调用方这时不能写组合文件。
 */
export function carryUntrusted(home: string, oldText: string | undefined, newText: string): void {
  const prev = readUntrusted(home);
  const onDisk = comboTextKeys(oldText);
  /* 读不了旧记录（= 全都不挂）：磁盘上原来那些也照样算没确认过 */
  const next = new Set(prev || onDisk);
  let changed = !prev;
  for (const k of comboTextKeys(newText)) {
    if (!onDisk.has(k) && !next.has(k)) { next.add(k); changed = true; }
  }
  if (changed) writeUntrusted(home, next);
}

/** 用户在设置里保存了这份组合文件 = 看过、确认过：里面的 MCP 配置都不再算没确认过。 */
export function trustCombosText(home: string, text: string): void {
  const prev = readUntrusted(home);
  if (prev && !prev.size) return;
  const saved = comboTextKeys(text);
  const next = new Set([...(prev || [])].filter((k) => !saved.has(k)));
  /* 读不了旧记录：保存的那份之外没有别的组合了，清空就对 */
  writeUntrusted(home, prev ? next : new Set());
}

/** 去掉组合里没确认过的 MCP（`untrusted` 为 null = 记录读不了，全都去掉）。返回去掉的名字。 */
export function withholdUntrusted<T extends Pick<McpCombo, 'mcpServers'>>(
  combo: T, untrusted: Set<string> | null,
): { combo: T; withheld: string[] } {
  const withheld: string[] = [];
  const kept: Record<string, McpComboServer> = {};
  for (const [name, s] of Object.entries(combo.mcpServers)) {
    if (!untrusted || untrusted.has(serverTrustKey(s))) withheld.push(name); else kept[name] = s;
  }
  return withheld.length ? { combo: { ...combo, mcpServers: kept }, withheld } : { combo, withheld };
}

/**
 * 会话准备 MCP 用：先按这台电脑套 `perMachine`（`localizeCombo`），再去掉没确认过的 —— 本机已 disabled 的
 * 本来就不挂，不算进 `withheld`、不提示。认不认仍按文件里原样那条（`withholdUntrusted` / `serverTrustKey`，不看本机覆盖）。
 * 返回本机那份（去掉没确认的）和要提示的名字。
 */
export function withholdUntrustedLocal<T extends Pick<McpCombo, 'mcpServers'>>(
  combo: T, untrusted: Set<string> | null, m: MachineIdentity,
): { combo: T; withheld: string[] } {
  const held = new Set(withholdUntrusted(combo, untrusted).withheld);
  const localized = localizeCombo(combo, m);
  if (!held.size) return { combo: localized, withheld: [] };
  const withheld: string[] = [];
  const kept: Record<string, McpComboServer> = {};
  for (const [name, s] of Object.entries(localized.mcpServers)) {
    if (!held.has(name)) kept[name] = s;
    else if (!s?.disabled) withheld.push(name);
  }
  return { combo: { ...localized, mcpServers: kept }, withheld };
}

/** 文本里哪些 MCP 还没确认过（给设置面板看）：`[{ comboId, server }]`。 */
export function untrustedInText(home: string, text: string): Array<{ comboId: string; server: string }> {
  const r = parseMcpCombos(text);
  if (!r.ok) return [];
  const untrusted = readUntrusted(home);
  const out: Array<{ comboId: string; server: string }> = [];
  for (const c of r.combos) {
    for (const [server, s] of Object.entries(c.mcpServers)) {
      if (!untrusted || untrusted.has(serverTrustKey(s))) out.push({ comboId: c.id, server });
    }
  }
  return out;
}
