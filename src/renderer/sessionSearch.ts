/**
 * FINDING A CHAT BY NAME — pure, so the sidebar's filtering can be reasoned about without a DOM.
 *
 * Two rules that are not obvious until you use it:
 *
 *   A GROUP WITH A HIT OPENS ITSELF. Most projects are collapsed (untouched for a week, see `projectActivity`),
 *   and a search that leaves the match hidden inside a folded group reads as "found nothing".
 *   THE PROJECT NAME COUNTS as text. Typing 「周报」 to find that project's chats is the same intent as typing a
 *   chat's title, and requiring the exact title turns a search box into a spelling test.
 *   THE ID COUNTS TOO —「会话搜索框支持直接粘 id」. 排查时手里只有日志里的 `sessionId=s_…`、看板 bug 里的
 *   一截 id、控制入口 `/sessions/:id/…`，标题对不上号。见 `idMatches`。
 */
export interface Searchable {
  id: string;
  title: string;
  projectId?: string;
  archived?: boolean;
}

export interface SearchResult<T> {
  /** Matching sessions, order preserved from the input. */
  hits: T[];
  /** Projects that contain a hit — the sidebar opens these while a query is active. */
  projects: string[];
  /** True when no query is active, so callers can skip filtering entirely. */
  idle: boolean;
}

/**
 * id 片段最短几位才算「按 id 找」。`s_<时间戳>_<6位>` 里 `s_` 人人都有、时间戳的数字段和标题里的「2024」
 * 撞车，太短的片段会把整张列表都算命中 —— 所以短于这个长度只认整串相等。
 */
const MIN_ID_FRAGMENT = 4;

/** 把粘进来的一截东西剥成 id：日志里的 `sessionId=…`、引号、控制入口路径 `/sessions/<id>/tail`。 */
export function idQuery(raw: string): string {
  let q = String(raw || '').trim();
  const fromPath = /\/sessions\/([A-Za-z0-9_-]+)/.exec(q);
  if (fromPath) q = fromPath[1];
  q = q.replace(/^sessionId\s*[=:]\s*/i, '').replace(/^["'`]+|["'`]+$/g, '').trim();
  return q.toLowerCase();
}

/**
 * 这一截是不是这条会话的 id：整串相等；或（够长时）是 id 的**前缀**、或是最后那段随机后缀
 * （`dl006j`）的前缀。不做任意子串匹配 —— 时间戳中间的一段数字不该把一堆会话都算进来。
 */
export function idMatches(id: string, q: string): boolean {
  const lid = String(id || '').toLowerCase();
  if (!lid || !q) return false;
  if (lid === q) return true;
  if (q.length < MIN_ID_FRAGMENT) return false;
  if (lid.startsWith(q)) return true;
  const cut = lid.lastIndexOf('_');
  return cut >= 0 && lid.slice(cut + 1).startsWith(q);
}

export function searchSessions<T extends Searchable>(sessions: T[], query: string): SearchResult<T> {
  const q = (query || '').trim().toLowerCase();
  if (!q) return { hits: sessions, projects: [], idle: true };
  const idQ = idQuery(query);
  const hits = sessions.filter((s) => {
    if (idMatches(s.id, idQ)) return true;
    const title = (s.title || '').toLowerCase();
    const project = (s.projectId || '').toLowerCase();
    return title.includes(q) || project.includes(q);
  });
  return {
    hits,
    projects: Array.from(new Set(hits.map((s) => (s.projectId || '').trim()).filter(Boolean))),
    idle: false,
  };
}
