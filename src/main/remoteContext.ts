/**
 * **告诉模型它在别人的机器上** ——「为什么远程会话的搜索是在本地的，你是不是应该给他一些提示词
 * 告诉他本地和远程目录的区别」。
 *
 * 远程会话里模型的每个工具都在远端跑（ACP 上拦不住也改不了），而它**完全不知道这件事**：
 * 设计文档里写了要注入这段说明，实现时漏了。漏掉的后果不是"少一句话"，而是它会拿对话里出现的
 * `/Users/...` 去搜 —— 那台机器上没有这个路径，于是"搜不到"被它解释成"这个东西没有"，
 * 然后基于错误结论往下做。
 *
 * **镜像去掉之后这段话变了**（「把镜像去掉，给远程配一些能调用本地 MCP 的能力」）：
 * 用户的文件不再被复制过去，而是通过反向隧道用一组 `local_*` 工具直接读写他机器上的那一份。
 * 所以要说的不再是"路径要换算成远端的镜像路径"，而是"项目不在你这台机器上，用那组工具"。
 *
 * 这段话每轮都注入（几百字符），和 memory 块同一个位置：越靠近用户那句话越可能被遵守。
 */

import { localActionHelp } from './localAction.ts';
import { localToolsHelp } from './remoteLocalTools.ts';
import { forwardHelp } from './forwardMcp.ts';

export interface RemoteContextInput {
  /** 给人看的机器名（设置里的 label）。 */
  hostLabel: string;
  /** 远端那份项目镜像的绝对路径（agent 的 cwd）。 */
  remoteDir: string;
  /** 用户机器上的工作目录 —— `local_*` 工具的相对路径以它为准。 */
  localDir: string;
  /** 兼容旧调用点（镜像时代的会话目录），现在不再出现在注入里。 */
  sessionDir?: string;
  /**
   * 从用户机器**转发**过来的那些 MCP 的名字（`playwright` 之类）。
   *
   * 必须说出来：不说的话它会以为这些工具作用在自己这台机器上 —— 而"我以为我在自己机器上
   * 点浏览器"是最难看出来的一类错（截图回来的是另一台机器的屏幕）。
   */
  forwarded?: string[];
}

/**
 * 那段注入文本。**空 host 或空目录时返回空串** —— 宁可不说，也不要注入一句半截的说明。
 */
export function remoteContextBlock(input: RemoteContextInput): string {
  const host = String(input?.hostLabel || '').trim();
  const remoteDir = String(input?.remoteDir || '').trim();
  const localDir = String(input?.localDir || '').trim();
  if (!host || !remoteDir) return '';
  return [
    '[运行环境：远程]',
    `你现在跑在远端机器 ${host} 上，不是用户的 Mac。你的工具（读写文件、执行命令）都在这台机器上生效。`,
    /*
      **文件不再被复制到这台机器上** —— 镜像去掉了（`registerRemoteSync` 那段）。
      用户的项目在他自己机器上，这条会话通过反向隧道调本地工具去读写它。
      所以这里要说的不再是"路径要换算"，而是"用那组工具"。
    */
    localDir ? localToolsHelp(localDir) : '',
    /*
      历史是随消息带过来的（ride-along），远端不存在 history.md —— 明确说一句，
      否则它会去找那个文件，然后把"读不到"当成"没有历史"。
    */
    '· 对话历史**随消息带给你**，这台机器上没有 history.md / transcript.jsonl 之类的文件，别去找；'
      + '用户提到的附件和文件都在他机器上，用 `local_read` 去读。',
    `· 你的当前目录 \`${remoteDir}\` 只是这台机器上的**草稿目录** —— 用户的项目不在这里。`
      + '需要临时文件、下载、解压的时候用它；用户要的产出一律用 `local_write` 写回他机器上。',
    /*
      **浏览器在用户那边** ——「想办法让它打开本地的 chrome 我看看进度」。
      它在远端只能 `curl`，而用户要看的是**页面**。远端没有图形界面，`open`/`xdg-open` 在那儿
      要么不存在要么开在一台没人看的机器上；而 KiroLex 的 transcript 会把 URL 变成可点的链接，
      点开用的就是用户自己机器上的浏览器（`shell.openExternal`）。所以规则很简单：把 URL 说出来。
      公网地址（CloudFront / API Gateway 这类）用户能直接打开；只监听远端 localhost 的端口它打不开，
      那种情况要说清是哪个端口，让用户自己决定要不要转发。
    */
    '· 用户的浏览器在**他自己的机器**上，不在这里。'
      + '只在这台机器的 localhost 上监听的服务他打不开，那就明说端口号。',
    localActionHelp(),
    forwardHelp(input.forwarded || []),
    '· 构建、跑测试、git 提交这些事用 `local_bash`（在**用户机器**上跑，那里才有他的 `node_modules`、'
      + '工具链和仓库）。这台机器上装依赖没有意义 —— 项目不在这儿。',
  ].filter(Boolean).join('\n');
}
