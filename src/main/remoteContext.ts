/**
 * **告诉模型它在别人的机器上** ——「为什么远程会话的搜索是在本地的，你是不是应该给他一些提示词
 * 告诉他本地和远程目录的区别」。
 *
 * 远程会话里模型的每个工具都在远端跑（ACP 上拦不住也改不了），而它**完全不知道这件事**：
 * 设计文档里写了要注入这段说明，实现时漏了。漏掉的后果不是"少一句话"，而是它会：
 *   · 拿对话里出现的 `/Users/...` 去搜 —— 那是本地路径，在远端根本不存在，于是"搜不到"
 *     被它解释成"这个东西没有"，然后基于错误结论往下做；
 *   · 在远端跑 `npm test` / 构建 —— `node_modules` 没同步（里面是 darwin 的原生二进制，
 *     拷过去也不能用），于是它花一轮时间去装依赖；
 *   · 以为自己写的文件会丢 —— 其实每轮前后都会同步回本地。
 *
 * 这段话每轮都注入（几百字符），和 memory 块同一个位置：越靠近用户那句话越可能被遵守。
 */

export interface RemoteContextInput {
  /** 给人看的机器名（设置里的 label）。 */
  hostLabel: string;
  /** 远端那份项目镜像的绝对路径（agent 的 cwd）。 */
  remoteDir: string;
  /** 本地那份项目目录 —— 说清同一个项目的两个名字。 */
  localDir: string;
  /** 会话目录（`history.md`、附件）在远端的位置。 */
  sessionDir?: string;
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
    `· 项目在这台机器上的路径是 \`${remoteDir}\`（就是你的当前目录）。`,
    localDir ? `· 同一个项目在用户本地是 \`${localDir}\` —— **那个路径在这台机器上不存在**。`
      + `对话里出现 \`${localDir}/x/y\` 这类路径时，你要找的是 \`${remoteDir}/x/y\`；`
      + `直接拿本地路径去搜会搜不到，而"搜不到"不等于"这个东西没有"。` : '',
    input.sessionDir ? `· 这条会话的附件和 history.md 在 \`${input.sessionDir}\`。` : '',
    '· 文件**以用户本地那份为准**：每一轮开始前本地会同步到这里，你改完之后会同步回去。'
      + '所以你写的东西不会丢，也不需要自己往回拷。',
    '· 这台机器上**没有** `node_modules`、构建产物（它们不同步：原生依赖跨平台不能用），'
      + '也没有 LibreOffice。需要构建、跑测试、做预览/PPT 时，说出来让用户在本地做，不要在这里装依赖。',
  ].filter(Boolean).join('\n');
}
