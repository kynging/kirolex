# Windows 上跑不起来的东西

2026-09-28 全量审计（`src/main/`、`src/renderer/`、`scripts/`）的结论。
**只修了第 1 条**（它是加 ssh 复用时引入的回归），其余按用户决定先记下来。

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

## 2. 本机工具探测（BLOCKING，未修）

- `src/main/index.ts:1876` — `runProbe` 的本机那一半走 `execFile('bash', ['-lc', script])`
- `src/main/binDetect.ts:28-67` — 候选名只有 `kiro-cli` / `claude` / `codex`（没有 `.exe`），
  候选路径只有 `/usr/local/bin`、`/opt/homebrew/bin`、`~/.local/bin`
- `src/main/binDetect.ts:117-160` — `detectScript` / `testScript` 是纯 POSIX shell
  （`command -v`、`$(...)`、`case…esac`、`readlink -f`、`< /dev/null`）

后果：设置 → 机器 里「自动检测这台机器上的三个工具」和「测试」两颗按钮都是死的。
而 `kiroBinProblem()`（`acp-client.ts:104`）在配好之前**拒绝起任何会话** ——
也就是 Windows 上的首次使用没有出路，只能手填，而手填又容易撞上第 3 条。

修法方向：Windows 分支用 `where.exe` / PowerShell，候选加 `%LOCALAPPDATA%` 和 `.exe`。

## 3. 配置值必须是存在的文件（BLOCKING，未修）

`src/main/acp-client.ts:236-247` — `connect()` 取第一个 `fs.existsSync(p)` 通过的候选。
所以填裸名字 `kiro-cli`（或没带 `.exe` 的路径）直接被拒，即便 `resolveKiroCli()`
（`:137`）本来是允许走 PATH 的。这个本地/设置的不一致在 Windows 上最疼 ——
那边磁盘上的名字总是带 `.exe`。

## 4. Windows 用户真会碰到的（DEGRADED，未修）

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

## 5. 只影响远程路径（被第 1 条挡住之前都碰不到）

| 位置 | 后果 |
|---|---|
| `src/main/localMcp.ts:253,260,263,283` | `find` / `rg` / `grep` / `bash -lc` → `local_glob`、`local_grep`、`local_bash` 全死 |
| `src/main/localMcp.ts:369` | `spawn` 不带 `shell: true` → `npx` / `uvx` 这类 `.cmd` shim 起不来，转发的 MCP 静默少工具 |
| `src/main/forwardMcp.ts:49` | 用 `startsWith('/')` 判断"这是本机命令"→ `C:\…\node.exe` 被判成不是本机的，于是**静默不转发**（正是那个模块头警告的那种静默丢工具） |
| `src/main/index.ts:8431` | `execSync` 里用 `shellQuote` 的 POSIX 单引号 → cmd.exe 不认，`remote:bootstrap` 静默丢掉登录环境 |
| `src/main/index.ts:1768-1779` | 孤儿 ssh 清理靠 `ps -eo` + PPID==1 → Windows 上两个都不成立，泄漏的 ssh 会累积 |
| `src/main/sshMux.ts:259` | `mode: 0o700` 在 Windows 上被静默忽略（没有 ACL） |
| `src/main/index.ts:8396,8613`、`src/main/remoteTargets.ts:37` | `~\.ssh\id_rsa` 不展开（正则要求 `~/`） |
| `src/main/config.ts:254` | 草稿目录名变成 `C_Users_x_proj` |

## 6. dev flow

- 仓库没有 `.gitattributes`。Windows clone 会把 `scripts/remote-bootstrap.sh` 变成 CRLF，
  而 `index.ts:8386` 把它读出来管道给远端 bash → `$'\r': command not found`。
  打包的 `.exe` 不受影响（electron-builder 装的是构建机上的产物）。
- `src/main/index.ts:8840` — `SIGTERM` 在 Windows 上不会触发，所以"退出时释放 kiro-cli
  会话锁"那条不生效。只在 dev supervisor 下有意义，`scripts/dev-hot.mjs:135` 已注明。
- `scripts/acp-probe.mjs:33,41`、`scripts/steer-smoke.mjs:33` — 写死了某台 Mac 的路径。

## 7. 一条不是代码 bug 的 Windows 风险

`sessionStore.ts` 和 `index.ts` 里到处是"写临时文件 + `renameSync`"。libuv 用
`MoveFileEx(MOVEFILE_REPLACE_EXISTING)`，覆盖本身是可以的 —— 但**杀毒软件或搜索索引器
持有目标文件时会 `EPERM`/`EBUSY`**。这影响 `record.json` / `ui-state.json` / `config.json`。
不是要改代码，是排查 Windows 上"配置偶尔存不上"时该先想到它。
