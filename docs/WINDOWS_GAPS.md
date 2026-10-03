# Windows 上跑不起来的东西

2026-09-28 全量审计（`src/main/`、`src/renderer/`、`scripts/`）的结论。
**第 1–5 节全部已修**（2026-09-28）。剩下的只有：
· 第 6 节 —— Windows 上 `SIGTERM` 不触发（只在 dev supervisor 下有意义，已注明）、
  两个写死了某台 Mac 路径的 dev 探针脚本；
· 第 7 节 —— 一条不是代码 bug 的 Windows 风险（AV / 索引器占着文件会让 rename 失败）;
· `config.ts:254` 的草稿目录名（`C_Users_x_proj`，纯 cosmetic，有 SHA1 后缀保证唯一）;
· `sshMux.ts` 的 `mode: 0o700`（Windows 上复用已禁用，这条现在 moot）。

## 先说已经是对的那些

这不是"Windows 全线崩"，`app` 本身能起来 —— 启动路径（`app.whenReady()` → `createWindow`
→ `createTray`）是纯 `fs` + `nativeImage`，托盘图标是内存里画的，没有缺文件。

已经做了平台分支的地方：

| 位置 | 已有的 Windows 处理 |
|---|---|
| `src/main/loopVerify.ts:98` | win32 走 `%ComSpec% /d /s /c`，还会认 cmd.exe 的 "is not recognized as an internal or external command" |
| `src/main/index.ts:3513` | `getShellEnv()` 在 win32 走 `reg query`，只在 POSIX 上 source `~/.zshrc` |
| `src/main/index.ts:3640` | `runCli` 用 `shell: true`，二进制路径加了双引号 |
| `src/main/acp-client.ts:114` | 候选路径里有 `%LOCALAPPDATA%\Kiro-Cli\kiro-cli.exe` |
| `src/main/imagePaths.ts:29`、`src/renderer/filePaths.ts:17,27` | 路径正则都有 `[A-Za-z]:\\` 分支 |
| `src/main/s3Sync.ts:162,172` | S3 key 做了 `path.sep` ↔ `/` 转换 |
| `src/main/hostOps.ts:100` | `LocalHost` 用 `fs`，unix 命令只在 `SshHost` 里 |
| `scripts/dev-hot.mjs:31,135` | 处理 `.cmd` shim，并且注明了 Windows 的信号限制 |
| `src/main/skillDoc.ts:123`、`src/main/localMcp.ts:373` | 正则和分帧都容忍 `\r\n` |

## 1. ✅ 已修：ssh 连接复用（BLOCKING）

`src/main/sshMux.ts` + `src/main/acp-client.ts:861`

Win32-OpenSSH **根本没实现连接多路复用**，`ControlMaster` / `ControlPath` 它不认。
而这个模块的探活是 unix domain socket 形状的：`statSync().isSocket()` 在 Windows 上永远
false，`net.connect(<文件路径>)` 在 Windows 上要的是 `\\.\pipe\…` 命名管道。

后果：`ensureLocalTools` 会 await `sshMux.ensure()`，于是每条远程会话等满 12 秒然后抛
「复用连接没建起来」——**一条都起不来**。这是加复用时引入的回归（复用之前每条会话
自己一条 ssh、自己一个 `-R` 端口，在 Windows 上是好的）。

**修法**：`muxSupported()` 按 `process.platform` 判，Windows 上回退到"每条会话自己一条隧道"
（= 复用之前的行为）。少了复用的好处（少握手、少端口），但功能是全的。

## 2. ✅ 已修：本机工具探测（BLOCKING）

- `src/main/index.ts:1876` — `runProbe` 的本机那一半走 `execFile('bash', ['-lc', script])`
- `src/main/binDetect.ts:28-67` — 候选名只有 `kiro-cli` / `claude` / `codex`（没有 `.exe`），
  候选路径只有 `/usr/local/bin`、`/opt/homebrew/bin`、`~/.local/bin`
- `src/main/binDetect.ts:117-160` — `detectScript` / `testScript` 是纯 POSIX shell
  （`command -v`、`$(...)`、`case…esac`、`readlink -f`、`< /dev/null`）

后果：设置 → 机器 里「自动检测这台机器上的三个工具」和「测试」两颗按钮都是死的。
而 `kiroBinProblem()`（`acp-client.ts:104`）在配好之前**拒绝起任何会话** ——
也就是 Windows 上的首次使用没有出路，只能手填，而手填又容易撞上第 3 条。

**修法**：Windows 上不走 shell，用 Node 自己探（`detectWindows`）——
遍历 `PATH` × `PATHEXT`（`.exe` / `.cmd` 都认，npm 装的工具是 `.cmd` shim）、
展开 `%LOCALAPPDATA%` 这类候选、每个真的跑一次 `--version` 并用 `verify` 校验输出、
按解析后的真实路径去重。没有把那段 POSIX 脚本翻译成 PowerShell ——
那意味着维护两份同样的逻辑，而它们会慢慢长歪。远端那一半照旧走脚本（远端是 Linux）。
「测试」那颗按钮同理，而且会先在 PATH 上解析一次裸名字。

## 3. ✅ 已修：配置值必须是存在的文件（BLOCKING）

`src/main/acp-client.ts:236-247` — `connect()` 取第一个 `fs.existsSync(p)` 通过的候选。
所以填裸名字 `kiro-cli`（或没带 `.exe` 的路径）直接被拒，即便 `resolveKiroCli()`
（`:137`）本来是允许走 PATH 的。这个本地/设置的不一致在 Windows 上最疼 ——
那边磁盘上的名字总是带 `.exe`。

**修法**：`connect()` 改成调 `resolveKiroCli()`（它本来就处理裸名字），
不再自己写一遍 existsSync 循环。那个函数的注释早就写着"一个解析器给两条路"。

## 4. ✅ 已修：Windows 用户真会碰到的（DEGRADED）

| 位置 | 后果 |
|---|---|
| `src/renderer/components/ChatArea.tsx:2506` | 用 `/\/\.kirolex\/sessions\//` 判断"这是不是会话草稿目录"。Windows 路径是 `\`，永远不匹配 → **把草稿目录当成真的工作目录显示出来**，正是那段注释说它要防的谎 |
| `src/main/index.ts:7000,7052` | 只剥 `file://`；Windows 的 `file:///C:/…` 剥完剩 `/C:/…`，`path.isAbsolute` 接受但 `statSync` 拒绝 → `app:open-external`、`workspace:read`、`workspace:download` 在拿到 `file://` URL 时失败 |
| `src/renderer/App.tsx:3534,3593,3621` | `path.split('/').pop()` → 查看器标题和文件标签页显示整条路径而不是文件名 |
| `src/renderer/components/ChatArea.tsx:2509` | 同上，工作目录那个 chip 显示整条路径 |
| `src/renderer/components/WorkspacePanel.tsx:109` | 手工 `${path}/${name}` 拼接 → 浏览时显示混合分隔符（`C:\Users\x/sub`） |
| `src/renderer/App.tsx:557` | `Dockerfile` / `Makefile` 的正则匹配不到（name 变成整条路径）→ 丢高亮 |
| `src/main/index.ts:3522` | 单实例锁的错误信息叫用户去跑 `pkill` —— 而这正是 app 拒绝启动时显示的那句 |
| `src/main/projectStore.ts:71` | 校验信息说"要写绝对路径（从 / 开始）" |

## 5. 远程路径上的（第 1 条修好之后这些就会被碰到，所以也修了）

| 位置 | 后果 |
|---|---|
| `src/main/localMcp.ts` | ✅ `find` / `grep` / `bash` 三条都有了 Windows 分支：`globNative` / `grepNative`（用 Node 走目录树，跳过 node_modules / .git，有 2 万个文件的上限，二进制文件按有没有 NUL 跳过），`local_bash` 换成 `%ComSpec% /d /s /c`。ripgrep 仍然优先（Windows 上也常有）。**这些工具跑在用户那台机器上**，所以 Windows 用户一开远程会话就会碰到，而模型会把"工具报错"解释成"这个东西不存在" |
| `src/main/localMcp.ts` | ✅ Windows + 命令不带 `.exe`/`.com` 后缀 → `shell: true` 并给命令加引号（路径带空格是常态）。不修的话 `npx` / `uvx` 这类 `.cmd` shim 全起不来，转发过去的 MCP 静默少工具 |
| `src/main/forwardMcp.ts` | ✅ `isLocalPathCommand` 现在也认 `C:\` / `C:/` / UNC（`\\server\share`）。不修的话 `C:\…\node.exe` 被判成不是本机路径 → **静默不转发**，而远端那台 Linux 上当然没有 `C:\…` |
| `src/main/index.ts` | ✅ 那句 `whoami` 改成 `execFileSync`（不经过 shell，两个平台都不需要引号）。原来 `shellQuote` 包的是 POSIX 单引号，cmd.exe 不认 → bootstrap **静默丢掉登录参数**，远端装好了却没登录 |
| `src/main/index.ts` | ✅ 加了 `sweepStrayLocalSshWindows`：用 `Get-CimInstance Win32_Process` 拿 pid / 父 pid / 命令行，判据从 "PPID==1" 换成"**父进程不在活着的 pid 集合里**"（同一个意思的可移植说法）。拿不到全量 pid 就什么都不杀 —— 宁可漏，不可错杀。不修的话这一轮在 Windows 上是彻底 no-op，而**这正是压死那台 EC2 的链条的第一环** |
| `src/main/sshMux.ts:259` | `mode: 0o700` 被忽略 —— **moot**：Windows 上复用已经禁用了（第 1 条），那个目录根本不会被建 |
| `src/main/remoteTargets.ts` | ✅ `expandHome` 两种分隔符都认（`~` 后面必须紧跟分隔符或结尾 —— 否则 `~user/x` 会被错展开）。index.ts 里那两处重复实现删掉，改成复用它 |
| `src/main/config.ts:254` | 草稿目录名变成 `C_Users_x_proj` |

## 6. dev flow

- ✅ 已加 `.gitattributes`（`* text=auto eol=lf` + `*.sh` / `*.mjs` 显式 `eol=lf`）。
  不加的话 Windows clone 会把 `scripts/remote-bootstrap.sh` 变成 CRLF，
  而 `index.ts` 把它读出来管道给远端 bash → `$'\r': command not found`，
  而那条错误看不出跟换行有关。打包的 `.exe` 不受影响（装的是构建机上的产物）。
- `src/main/index.ts:8840` — `SIGTERM` 在 Windows 上不会触发，所以"退出时释放 kiro-cli
  会话锁"那条不生效。只在 dev supervisor 下有意义，`scripts/dev-hot.mjs:135` 已注明。
- ✅ 已修：`scripts/acp-probe.mjs` 原来写死了某台 Mac 的路径，改成和 `steer-smoke.mjs` 同一套候选查找（`KIRO_CLI_PATH` → `~/.local/bin` → … → PATH），PATH 拼接用 `path.delimiter`。

## 7. 一条不是代码 bug 的 Windows 风险

`sessionStore.ts` 和 `index.ts` 里到处是"写临时文件 + `renameSync`"。libuv 用
`MoveFileEx(MOVEFILE_REPLACE_EXISTING)`，覆盖本身是可以的 —— 但**杀毒软件或搜索索引器
持有目标文件时会 `EPERM`/`EBUSY`**。这影响 `record.json` / `ui-state.json` / `config.json`。
不是要改代码，是排查 Windows 上"配置偶尔存不上"时该先想到它。
