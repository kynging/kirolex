/**
 * **远程会话让你这台机器做一件事** ——「那个本地工具调用的问题你能不能想想办法」/
 * 「想办法让它打开本地的 chrome 我看看进度」。
 *
 * 问题的形状：远程会话的**所有**工具都在那台机器上跑（kiro-cli 自己拥有工具，ACP 上既拦不住
 * 也加不了 —— 实测它连客户端声明的 `fs` 能力都不用）。于是它起了一个服务、想让你看一眼，
 * 能做的只有 `curl`：它在那台没有图形界面的机器上 `open` 一个 URL，最好的情况是什么都没发生。
 *
 * 这一层给它**一条窄通道**：在回复里写一行标记，KiroLex（跑在你机器上）认这一行，
 * 在**你的**机器上执行一个白名单动作。
 *
 * ```
 * KIROLEX-LOCAL: open https://example.com
 * ```
 *
 * ## 为什么只有 open，而且只收 http(s)
 *
 * 这是"模型说什么、你的机器就做什么"的通道，所以它的边界比功能重要：
 *   · **只有 `open` 一个动词**。不是"暂时只做了一个"—— 一条能在你机器上跑命令的通道，
 *     和把那台 EC2 的权限接到你的 Mac 上是同一件事（那条路见「反向通道」那个选项，没选它）。
 *   · **只收 `http:` / `https:`**。别的 scheme 在 macOS 上是**应用启动器**：`file:` 能开任意
 *     文件、自定义 scheme 能唤起注册了它的 app（还带参数）。挡掉 scheme 比事后判断"这个 app
 *     安全吗"可靠得多。
 *   · **一轮最多两个**，同一个地址一条会话只开一次。不是怕它恶意，是怕它**热心**：
 *     一轮里每验证一次就弹一个标签页，你的浏览器会被它填满。
 *   · 每次都在状态行说明开了什么、是谁要求的 —— 你的机器上凭空弹出一个窗口，必须能对上账。
 *
 * 数据外带不是这条通道新增的风险：那台机器本来就有完整的出网能力，想发东西自己就发了。
 */

/** 标记词。行首（允许 markdown 的项目符号/加粗/反引号包裹）。 */
export const LOCAL_MARKER = 'KIROLEX-LOCAL';

/** 一轮最多执行几个 —— 见文件头那段：防的是"热心"，不是恶意。 */
export const MAX_LOCAL_ACTIONS_PER_TURN = 2;

export interface LocalAction {
  verb: 'open';
  /** 已校验过的 http(s) 地址。 */
  target: string;
}

export interface LocalActionReject {
  raw: string;
  why: string;
}

/**
 * 从**一行**文本里解析标记。返回能执行的动作和被拒的那些（要告诉人：它想干什么、为什么没干）。
 *
 * 按行喂进来（流式时只处理已经收完的整行）—— 半行会把一个 URL 截成两半，
 * 而截半的 URL 恰好可能仍然是个合法地址（`https://x.com/a` vs `https://x.com/admin/delete`）。
 */
export function parseLocalActions(line: string): { actions: LocalAction[]; rejected: LocalActionReject[] } {
  const actions: LocalAction[] = [];
  const rejected: LocalActionReject[] = [];
  const raw = String(line || '');
  /* 去掉 markdown 的装饰：`- `、`* `、`> `、`**`、反引号 —— 模型一定会包点什么 */
  const clean = raw.trim().replace(/^[-*>\s]+/, '').replace(/[`*]/g, '').trim();
  const m = new RegExp(`^${LOCAL_MARKER}\\s*[:：]\\s*(\\S+)\\s*(.*)$`, 'i').exec(clean);
  if (!m) return { actions, rejected };
  const verb = m[1].toLowerCase();
  const rest = m[2].trim();
  if (verb !== 'open') {
    rejected.push({ raw: clean, why: `只支持 open，不认 \`${verb}\`` });
    return { actions, rejected };
  }
  const target = rest.split(/\s+/)[0] || '';
  if (!target) {
    rejected.push({ raw: clean, why: '没给地址' });
    return { actions, rejected };
  }
  if (!/^https?:\/\//i.test(target)) {
    rejected.push({ raw: clean, why: '只能开 http/https 地址（别的 scheme 在 macOS 上是应用启动器）' });
    return { actions, rejected };
  }
  try {
    const u = new URL(target);
    if (!u.hostname) throw new Error('no host');
    actions.push({ verb: 'open', target: u.toString() });
  } catch {
    rejected.push({ raw: clean, why: '不是一个合法地址' });
  }
  return { actions, rejected };
}

/**
 * 注入里那段说明。
 *
 * 必须给**例子**：只说"有这么个通道"的话它会自己发明格式（实测模型在这种事上一贯如此），
 * 而格式不对就等于这条通道不存在 —— 而且失败是静默的（它以为开了，你那边什么都没发生）。
 */
export function localActionHelp(): string {
  return `· 需要用户**看**一个页面时，在回复里单独写一行 \`${LOCAL_MARKER}: open <http 地址>\`——`
    + `KiroLex 跑在用户机器上，它会认这一行并在**用户自己的浏览器**里打开。`
    + `只支持这一个动作、只收 http(s) 地址、一轮最多两个；`
    + `你不要试图在这台机器上开浏览器（这里没有图形界面）。`;
}
