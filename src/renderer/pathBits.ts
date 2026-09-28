/**
 * **路径的那几个小操作，一次写对** ——「看一下有没有 windows 上不能跑的东西」→「都修」。
 *
 * 渲染层没有 `path` 模块（它跑在浏览器里），于是各处都手写 `split('/')`。
 * 在 macOS 上那是对的，在 Windows 上全错 —— 而错法很具体：
 *
 *   · `'C:\\Users\\k\\proj'.split('/').pop()` 回的是**整条路径**，不是 `proj`。
 *     于是文件标签页、查看器标题、工作目录那个 chip 全都显示一长条路径；
 *   · `/\/\.kirolex\/sessions\//.test(d)` 在 Windows 上永远 false，于是
 *     KiroLex 自己的会话草稿目录被当成"真的工作目录"显示出来 ——
 *     而那正是 ChatArea 里那段注释说它要防的谎。
 *
 * 所以这里统一按**两种分隔符**处理。远端路径一定是 `/`，本机路径在 Windows 上是 `\`，
 * 而这个模块两边都要对（同一个界面会同时显示远端和本机的路径）。
 */

/** 路径里的分隔符 —— `/` 和 `\` 都算。 */
const SEP = /[\\/]+/;

/**
 * 最后一段（文件名 / 目录名）。拿不到就原样回 —— 空串和纯分隔符都可能进来。
 *
 * 末尾的分隔符要忽略：`'/a/b/'` 的 basename 是 `b`，不是空串。
 */
export function baseName(p: string): string {
  const s = String(p || '');
  const parts = s.split(SEP).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : s;
}

/**
 * 两段拼成一条路径，**沿用左边那段的分隔符**。
 *
 * 为什么不一律用 `/`：Windows 上 `C:\Users\k` + `/sub` 能跑（Node 容忍混合分隔符），
 * 但它会显示成 `C:\Users\k/sub` —— 而这个字符串是要给人看的，
 * 而且浏览一层就多一个混进去的斜杠。
 */
export function joinPath(dir: string, name: string): string {
  const d = String(dir || '').replace(/[\\/]+$/, '');
  if (!d) return String(name || '');
  const sep = d.includes('\\') && !d.includes('/') ? '\\' : '/';
  return `${d}${sep}${name}`;
}

/**
 * 这是 KiroLex 自己的会话草稿目录吗（`~/.kirolex/sessions/<id>`）。
 *
 * 判据要同时认 `/` 和 `\`：Windows 上它长这样
 * `C:\Users\k\.kirolex\sessions\s_179…`，而原来那个只认 `/` 的正则永远不匹配 ——
 * 于是那个目录被当成真的工作目录显示出来。
 */
export function isSessionScratchDir(p: string): boolean {
  return /[\\/]\.kirolex[\\/]sessions[\\/]/.test(String(p || ''));
}
