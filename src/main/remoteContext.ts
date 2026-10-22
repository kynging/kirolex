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
import { forwardHelp, forwardHttpHelp } from './forwardMcp.ts';

export interface RemoteContextInput {
  /** 给人看的机器名（设置里的 label）。 */
  hostLabel: string;
  /** 远端那份项目镜像的绝对路径（agent 的 cwd）。 */
  remoteDir: string;
  /** 用户机器上的主目录 —— `local_*` 工具的相对路径以它为准。 */
  localDir: string;
  /**
   * **用户在他机器上真有一个工程吗** ——「我让它找一个纯远程的项目但它总是在本地找」。
   *
   * 没有本地工程时 `localDir` 并不是空的：它退回成 KiroLex 自己的会话目录
   * （`~/.kirolex/sessions/<id>/`，里面只有 record.json / transcript.jsonl / history.md）。
   * 于是下面那些"他的仓库和工具链在他机器上、构建测试 git 用 local_bash"的话照样注进去了 ——
   * 而对一个**纯远程**的工程，这些话是反的：它会拿着 `local_grep` 去搜那个会话目录，
   * 搜不到就说"找不到这个项目"。
   *
   * 所以这件事要显式传进来，不能从"`localDir` 有没有值"推。
   */
  hasLocalProject?: boolean;
  /** 兼容旧调用点（镜像时代的会话目录），现在不再出现在注入里。 */
  sessionDir?: string;
  /**
   * 用户机器上**这条会话自己的文件夹**（`~/.kirolex/sessions/<id>/files/`）—— `local_*` 的默认目录，
   * 中间产物 / 生成物放这里，跟着会话一起备份、恢复、删除。
   */
  filesDir?: string;
  /** 项目设的工作目录（他机器上的工程）—— cwd 不在那儿，所以要单独说出路径。 */
  projectDir?: string;
  /** `filesDir` 以前用过的路径（会话从别的机器恢复过来）—— 历史里写的是这些，要告诉它就是现在那个。 */
  movedFrom?: string[];
  /**
   * 从用户机器**转发**过来的那些 MCP 的名字（`playwright` 之类）。
   *
   * 必须说出来：不说的话它会以为这些工具作用在自己这台机器上 —— 而"我以为我在自己机器上
   * 点浏览器"是最难看出来的一类错（截图回来的是另一台机器的屏幕）。
   */
  forwarded?: string[];
  /**
   * 名单里那些从用户机器**中转**的 HTTP MCP（妙想之类）。要说清请求从他机器发出、
   * 别在远端另配同名的直连（那里没有密钥，出口 IP 也不对）。
   */
  forwardedHttp?: string[];
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
    /*
      有本地工程才讲那一套"他的文件在他机器上"。没有的话讲反了比不讲糟：
      见 `hasLocalProject` 上面那段。
    */
    (localDir && input.hasLocalProject !== false) ? localToolsHelp(localDir) : '',
    input.hasLocalProject === false
      ? `· **这条会话没有本地工程** —— 用户没给它挑本机目录，所以"项目"就在**你这台机器上**`
        + `（当前目录 \`${remoteDir}\` 是缓存目录，交付物不放这里）。要找文件、找代码、跑命令，都在这里找，`
        + `**别拿 \`local_glob\` / \`local_grep\` 去搜用户的 Mac** —— 那边没有这个工程，`
        + `\`local_*\` 的默认目录是这条会话在他机器上的文件夹${input.filesDir ? `（\`${input.filesDir}\`）` : ''}，`
        + `里面只有这条会话自己的产出，不是工程。`
        + `\`local_*\` 留着是为了两件事：用户**明确指给你**的本机路径（他会把路径写出来），`
        + `以及把最终产出用 \`local_write\` 交回他机器上（默认就放进那个文件夹）。`
      : '',
    /* 有本地工程时也要说：产出不该落进他的仓库，而是这条会话自己的文件夹 */
    input.hasLocalProject !== false && input.filesDir
      ? `· 中间产物和生成的文件交回他机器时放进这条会话的文件夹 \`${input.filesDir}\`（\`local_*\` 的相对路径就是相对它的），`
        + `它跟着这条会话一起备份、恢复、删除。`
        + (input.projectDir ? `他的工程在他机器上的 \`${input.projectDir}\` —— 工程里的文件用这个绝对路径去读写。` : '')
      : '',
    /* 两种情况（有没有本地工程）都要说：路径变了是会话被搬过，跟工程无关 */
    input.filesDir && input.movedFrom?.length
      ? `· 这条会话是从别处恢复/搬过来的：对话历史和 memory 里出现的 ${input.movedFrom.map((d) => `\`${d}\``).join('、')}`
        + ` 就是 \`${input.filesDir}\` 以前的路径 —— 那些文件现在都在新路径下，用 \`local_*\` 按新路径找。`
      : '',
    /*
      **别拿历史里的结论判断自己有没有工具** —— 这条是实测出来的（用户：「我让 agent 测本地
      playwright 它找不到」）。那条会话的工具清单里 `browser_*` / `local_*` 全都在（同一份 agent
      配置、同一个模型，用 ACP 单独探一遍全都列得出来），但它连着三轮回答"我拿不到这些工具"，
      而且**一次调用都没试**。原因是随消息带过来的那 5 万字符历史和 memory 全是**镜像时代**的：
      里面写着"我在 /home/ec2-user/kirolex-mirror"、"你的 /Users/... 路径都不存在"、
      "5 个调用有 4 个被路径校验拦掉"。它信了历史，没看工具清单。

      这类错最贵的地方在于它**看起来像故障**：用户以为转发断了，于是去查隧道、查 MCP、重启 ——
      而那一层全是好的。所以这句话必须显式地把旧结论作废。
    */
    '· **你有哪些工具，看你这一轮的工具清单，不要根据对话历史推断。**'
      + '历史里凡是说"我在镜像目录里"、"你的 `/Users/...` 路径不存在"、"被路径校验拦掉"的，'
      + '都是旧架构（rsync 镜像）留下的记录，**现在不成立**。要确认某个工具在不在，直接调一次就知道了 ——'
      + '比在回复里说"我拿不到这个工具"便宜得多，也不会让用户跑去排查一条其实是好的隧道。',
    /*
      历史是随消息带过来的（ride-along），远端不存在 history.md —— 明确说一句，
      否则它会去找那个文件，然后把"读不到"当成"没有历史"。
    */
    '· 对话历史**随消息带给你**，这台机器上没有 history.md / transcript.jsonl 之类的文件，别去找；'
      + '用户提到的**附件**在他机器上，用 `local_read` 去读（他会给出路径）。',
    /*
      **默认在这台机器上干活** ——「在远程会话中记得默认是在远程做，除非文件在本地或提示词中
      用户让在本地操作」。

      上一版这段话把天平压到了另一边（"构建、跑测试、git 提交这些事用 local_bash"），
      那是从"文件在用户机器上"直接推出来的 —— 但推过头了：装依赖、下载、解压、跑网络请求、
      起长任务，这些**没有理由**回到用户的笔记本上跑（那台远端机器就是为此存在的，
      而每一次 local_bash 都要过一遍 184ms 的隧道）。

      所以规则按**文件在哪**来定，而不是按"哪台机器更亲"：要动的文件在他那边就用 local_*，
      别的默认在这里做。
    */
    `· **默认在这台机器上做**：跑命令、装依赖、下载、解压、访问网络、落临时文件 ——`
      + `当前目录 \`${remoteDir}\` 就是你的工作区。这台机器就是给你干活用的，别把这些搬回用户的笔记本。`,
    /*
      **交付给用户的文件写本机** ——「v1 是经本机工具写到本机的，v3 却落在了 EC2」。
      远端 kiro-cli 自带的写文件工具模型可以任选，选了它文件就落在那台机器上：用户找不到、
      侧栏 comment 写不回去。所以：远端只放用完即弃的东西（cwd 就是缓存目录，随时会被清），
      用户要的文件一律 `local_write`；自带的写文件工具写到缓存以外会被 KiroLex 拒掉
      （`remoteWriteGuard.ts`），被拒了就改走 `local_write`，别换条路绕过去。
    */
    `· **交付给用户的文件一律写在他机器上**：文档、报告、改好的稿子、生成的代码 —— 用 \`local_write\``
      + (input.filesDir ? `（默认放进 \`${input.filesDir}\`，或者他指定的本机路径）` : '（或者他指定的本机路径）')
      + `。**别用你这台机器上自带的写文件工具（fs_write / write 之类）写交付物**：`
      + `当前目录 \`${remoteDir}\` 是**缓存**，里面的东西随时会被清、不算交付；`
      + `往缓存（和 /tmp）以外写会被 KiroLex 拒绝 —— 被拒了就改用 \`local_write\`，别换个路径重试，也别用 shell 重定向绕过去。`
      + `用命令在这里生成的产物（编译结果、脚本输出）要给他的，最后用 \`local_write\` 交回去；`
      + `写不了的二进制文件就把它在这台机器上的完整路径告诉他。`,
    input.hasLocalProject === false
      ? '· **什么时候回到用户机器**：只有两种 —— ① 他把某个本机路径明确写给你；'
        + '② 他明说了"在本地/在我机器上"做。其余一律在这里做，'
        + '产出用 `local_write` 交回去。'
      : '· **什么时候回到用户机器**：① 要读或改的文件在他那边（`local_read` / `local_write`）；'
        + '② 要在**他的仓库/工程**上跑构建、测试、git —— 文件和工具链都在那边（`local_bash`）；'
        + '③ 他明说了"在本地/在我机器上"做。'
        + '其余情况在这里做就行；他要的最终产出用 `local_write` 交回去。',
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
    localMachineHelp([...(input.forwarded || []), ...(input.forwardedHttp || [])]),
    forwardHelp(input.forwarded || []),
    forwardHttpHelp(input.forwardedHttp || []),
    /* 这条只在**他那边真有工程**时成立；没有的话它会把人往错的机器上引 */
    input.hasLocalProject === false ? ''
      : '· 在**他的工程**上跑构建 / 测试 / git 要用 `local_bash` —— 那里才有他的 `node_modules`、'
        + '工具链和仓库；把他的项目拷到这台机器上重装一遍是在做无用功。'
        + '而与他的工程无关的事（装个工具、拉个数据、跑个脚本）就在这台机器上做。',
  ].filter(Boolean).join('\n');
}

/**
 * **碰用户机器上的东西走 `local_bash`，以及这一轮到底接过来了哪些本机工具** ——
 * 「远程 Claude Code 和 Codex 会话似乎没有本地工具，不能正常访问 agent board」。
 *
 * 看板客户端只听用户机器的 `127.0.0.1:9333`，操作它的脚本也在他机器上；模型在远端 curl 127.0.0.1
 * 连的是远端自己，于是"连不上"被它当成"看板没开"。所以点名这几样，并把这一轮实际的本机工具列出来：
 * 不列的话它只能从历史里猜自己有什么（见上面"看你这一轮的工具清单"那条）。
 */
function localMachineHelp(forwarded: string[]): string {
  const names = [...new Set(forwarded.filter(Boolean))];
  return '· **碰用户机器上的东西，一律用 `kirolex-local` 的 `local_bash`**：这台是远端，'
      + '`127.0.0.1` / `localhost` 在这里指的是**这台**机器。用户的 agent board 看板客户端（`http://127.0.0.1:9333`）、'
      + '`~/.kirolex/tools/board-cdp.mjs`、`~/agent-board`、`~/.kirolex` 都在他机器上 —— '
      + '要用就在 `local_bash` 里跑（例如 `node ~/.kirolex/tools/board-cdp.mjs …`），'
      + '别在这台机器上 curl 9333、找这些路径或另装一份。\n'
    + '· 这一轮从用户机器接过来的工具：'
    + (names.length
      ? `\`kirolex-local\`（\`local_*\` 那组）、${names.map((n) => `\`${n}\``).join('、')}。`
      : '只有 `kirolex-local`（`local_*` 那组），没有别的本机 MCP。')
    + '工具清单里的名字可能带前缀（例如 `mcp__kirolex-local__local_bash`），是同一个。';
}
