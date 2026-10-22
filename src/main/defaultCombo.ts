/**
 * **新会话默认组合** ——「或者内置一个默认的」「帮我做一个默认通用的吧」。
 *
 * 新建 Claude Code / Codex 会话（本机、远端都算）时按它填 `profile.mcpCombo`；已有会话不动。
 * 两层：全局一个（`~/.kirolex/config.json` 的 `defaultMcpCombo`），项目可以覆盖（项目的 `project.json`
 * 的 `defaultMcpCombo`，见 `projectStore.ts`）。都没设 = 内置「通用」，和以前一样。
 *
 * 选的组合在本机的 `mcp-combos.json` 里找不到（别的电脑上的、被删了、文件有错）→ 新会话按内置「通用」，
 * 并带上 `missing` 让界面说出来；不留一个悬空的 id 在新会话里。
 * 这个模块不碰 electron，路径作为参数传入（测试用临时目录）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { BUILTIN_COMBO_ID, findCombo, readMcpCombos, type McpCombo } from './mcpCombos.ts';
import { readProject } from './projectStore.ts';

const COMBO_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** 规范化一个设置值：空 / 不合法 = 没设（''）。 */
export function normalizeComboId(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  return COMBO_ID.test(s) ? s : '';
}

/** 全局默认组合（没设 = ''，即内置「通用」）。config.json 读不了也当没设。 */
export function readGlobalDefaultCombo(configPath: string): string {
  try { return normalizeComboId(JSON.parse(fs.readFileSync(configPath, 'utf-8'))?.defaultMcpCombo); } catch { return ''; }
}

/**
 * 写全局默认组合。'' / 内置那个 = 删掉这个键（回到默认）。
 * config.json 存在但解析不了时**不写**、抛出去 —— 按空对象重写会把里面别的配置（机器、开关）全冲掉。
 */
export function writeGlobalDefaultCombo(configPath: string, id: string): void {
  const want = normalizeComboId(id);
  if (String(id || '').trim() && !want) throw new Error(`invalid combo id: ${id}`);
  let cfg: Record<string, unknown> = {};
  let text: string | null = null;
  try { text = fs.readFileSync(configPath, 'utf-8'); } catch { /* 还没有 config.json */ }
  if (text !== null && text.trim()) {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${configPath} is not a JSON object`);
    cfg = raw;
  }
  if (want && want !== BUILTIN_COMBO_ID) cfg.defaultMcpCombo = want; else delete cfg.defaultMcpCombo;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, configPath);
}

export type DefaultComboResolution = {
  /** 新会话实际用的组合 id（内置「通用」是 `default`） */
  id: string;
  /** 这个值是从哪一层来的 */
  source: 'project' | 'global' | 'builtin';
  /** 设了、但本机文件里没有的那个 id（这时 `id` 是内置「通用」） */
  missing?: string;
};

/**
 * 新会话该用哪个组合：项目设了就用项目的，否则全局的，否则内置「通用」。
 * 设的那个本机没有 → 内置「通用」+ `missing`（不往下一层找：说的是「回退到通用」，就只回退到通用）。
 */
export function resolveDefaultCombo(
  combos: Array<Pick<McpCombo, 'id' | 'aliases'>>,
  globalId: string | undefined,
  projectId?: string | undefined,
): DefaultComboResolution {
  const p = normalizeComboId(projectId);
  const g = normalizeComboId(globalId);
  const source = p ? 'project' : g ? 'global' : 'builtin';
  const want = p || g;
  if (!want || want === BUILTIN_COMBO_ID) return { id: BUILTIN_COMBO_ID, source };
  /* 记着自建通用原 id（如 general）的也算有 —— 它顶替了内置通用（`findCombo`） */
  if (findCombo(combos, want)) return { id: want, source };
  return { id: BUILTIN_COMBO_ID, source, missing: want };
}

/** 写进新会话 profile 的值：内置「通用」不写（和 `switchMcpComboImpl` 一样，undefined = 通用）。 */
export function newSessionMcpCombo(r: DefaultComboResolution): string | undefined {
  return r.id === BUILTIN_COMBO_ID ? undefined : r.id;
}

/**
 * **新建会话用的那一份**（`acp:new-session` 调）：读本机的组合文件、全局设置、这个项目的覆盖，给出结论。
 * kiro 会话没有组合，不填。组合文件有错时清单只有「通用」，于是设了的那个也按 `missing` 处理。
 */
export function defaultComboForNewSession(opts: {
  home: string; configPath: string; engine: string; projectId?: string;
}): DefaultComboResolution & { mcpCombo: string | undefined } {
  if (opts.engine === 'kiro') return { id: BUILTIN_COMBO_ID, source: 'builtin', mcpCombo: undefined };
  const { combos } = readMcpCombos(opts.home);
  const project = String(opts.projectId || '').trim();
  const projectId = project ? readProject(opts.home, project).defaultMcpCombo : undefined;
  const r = resolveDefaultCombo(combos, readGlobalDefaultCombo(opts.configPath), projectId);
  return { ...r, mcpCombo: newSessionMcpCombo(r) };
}
