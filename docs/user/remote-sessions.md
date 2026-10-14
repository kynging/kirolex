# Remote sessions

[← Back to contents](README.md)

A chat can run its agent on another machine over **ssh**, for example a cloud VM that has a better
network route to the model service, or a more powerful box. You choose the machine per chat.

## "Execution on the remote, files on your computer"

This is the most important thing to understand about remote chats:

- **The agent process runs on the remote machine.** That is where the model is called from and
  where the agent's own tools run.
- **Everything that is yours stays on your computer:** the chat history, [memory](memory.md),
  settings, your project files and the chat's own `files/` folder. KiroLex does **not** copy or sync
  your project to the remote machine.
- **The remote agent works on your files through a tunnel back to your computer.** For each remote
  chat, KiroLex starts a small tool server on your computer. It listens only on `127.0.0.1` and is
  protected by a per-chat token, and it is reached from the remote through the ssh connection. The
  agent gets these tools:

  | Tool | What it does **on your computer** |
  |---|---|
  | `local_read` | Read files |
  | `local_write` | Write a whole file, creating folders as needed |
  | `local_glob`, `local_grep` | Find files and search in them |
  | `local_git` | Read-only git: `status`, `diff`, `log`, `show`, `branch`, `rev-parse`, `ls-files`, `blame` |
  | `local_bash` | Run any shell command in the chat's folder (on Windows this is `cmd.exe`, so the syntax is cmd syntax) |

What this means for you:

- **A remote chat can read, write and run commands on your computer**, just like a local one. The
  safety boundary is the same as for a local agent, so review its actions the same way.
- When the remote agent changes one of your files, the chat says so: 📝 远端那条会话改了你本机的 …
  (*The remote chat changed … on your machine*).
- The remote machine only keeps a throw-away scratch folder per chat, under `~/.cache/kirolex/`
  there. If the agent writes a file with its *own* tools instead of `local_write`, the file ends up
  on the remote machine. KiroLex warns you (⚠️ 这一轮把文件写在了 … 上 — *this turn wrote files on …,
  not on your machine*) and offers a **⇩ Copy to this machine** button for each file. It reports
  **Copied to {path}** on success and **Copy failed** otherwise.
- If you open a remote file in the viewer, it shows **🌐 This file is on {host}, not on your machine.**
  with the same **⇩ Copy to this machine** button.
- The agent can ask KiroLex to open a web page in your local browser. Only `http` and `https`
  links are opened, at most two per turn.

## Add a machine

1. Open **Settings → 🖥 机器** (*Machines*).
2. In the machine picker, choose **+ 添加一台机器…** (*Add a machine…*).
3. Fill in:

   | Field | Meaning |
   |---|---|
   | **名称** (*Name*) | A label for the machine in menus |
   | **IP 地址** (*IP address*) | Host name or IP address |
   | **用户名** (*Username*) | ssh user. Empty uses your local user name |
   | **端口** (*Port*) | ssh port. Empty means 22 |
   | **密码** (*Password*) | Optional. Stored encrypted and shown as **已保存** (*Saved*), with **清除** (*Clear*) to remove it |
   | **私钥** (*Private key*) | Optional. **选择密钥…** (*Choose key…*) picks a key file, **清除** removes it |
   | **工作目录** (*Working directory*) | A directory on that machine. `~` is the login user's home. Default `~/kirolex` |

   With neither a password nor a key, your normal ssh configuration (`~/.ssh/config`, agent, default keys) is used.

4. Click **测试连接** (*Test connection*). The result tells you what is missing:

   | Result | What to do |
   |---|---|
   | *…kiro-cli 在，也登录了，N 个可用模型* (*kiro-cli present and logged in, N models available*) | Ready |
   | *连不上 …* (*Can't connect to …*) | Check the network, key or firewall / security group |
   | *… 上缺 …* (*… is missing …*) | Install the missing tools on that machine (see the next step) |
   | *… 上的 kiro-cli 没登录* (*kiro-cli on … isn't logged in*) | Run `kiro-cli login` once on that machine |

5. Optional: click **安装 AI 工具** (*Install AI tools*). It only becomes available after a successful
   test. It installs or updates kiro-cli, Claude Code, Codex and their ACP adapters, Node, rsync and
   git on the remote machine.
6. Set the remote machine's **kiro 启动命令** (*kiro launch command*), the same way as for this computer
   (see [Getting started](getting-started.md#tell-kirolex-where-kiro-cli-is)). You can click
   **自动检测这台机器上的三个工具** (*Auto-detect the three tools on this machine*). KiroLex refuses to
   start a Kiro chat on a machine with no launch command, rather than guessing one. A ★ marks commands
   that have successfully started a chat before.

Changes save automatically (**改动自动保存**, *changes save automatically*). **删除** (*Delete*) removes
the machine.

A jump host (`proxyJump`) is supported but has no field in the form. Set it in the machine's entry
under `remotes` in `~/.kirolex/config.json`.

## Run a chat on a remote machine

- **New chat:** in the **💬 New Chat** dialog, choose the machine under **在哪台机器上跑**
  (*Which machine to run on*). This option appears once at least one machine has been added, and
  KiroLex remembers your last choice.
- **Existing chat:** right-click it → **💻 / 🌐 运行位置：…** (*Run location*) → **💻 本地**
  (*Local*), a machine, or **＋ 添加机器…** (*Add machine…*). The chat keeps its history. While it
  moves, the sidebar shows ⏳.

Remote chats show **🌐 host** in the sidebar.

All three engines can run remotely. For Claude Code and Codex, the ACP adapter has to be installed on
that machine (**安装 AI 工具** does this) and the engine has to be signed in there.

### Signing in to Claude Code / Codex on a remote machine

In a remote Claude Code or Codex chat, click the engine icon at the bottom-left of the composer.
The **…配置** (*configuration*) dialog opens. Its **🔑 登录** (*Login*) tab shows the sign-in status on
that machine (**刷新状态**, *Refresh status*) and offers three ways to set it up:

- **用 Amazon Bedrock（推荐）** (*Use Amazon Bedrock (recommended)*) → **写到那台机器上** (*Write to
  that machine*). This configures the engine to use Bedrock with the remote machine's own AWS
  credentials. No keys are written. The previous config file is backed up.
- **手动填写** (*Fill in manually*): edit the engine's environment (Claude Code) or provider settings
  (Codex) yourself. **拷入本机配置** (*Copy in local config*) starts from your local settings.
- **官方账号登录** (*Official account login*): runs the engine's own login on the remote machine.
  **在浏览器打开** (*Open in browser*) opens the login link in your local browser. For Claude Code you
  then paste the code and click **发送 code** (*Send code*).

Running chats use the new settings after they reconnect. This tab is only for remote machines. On
your own computer, sign in to Claude Code / Codex the usual way.

## Forwarding MCP servers from your computer

Some MCP servers have to run on your computer, for example because they use local files, your
local network or IP address, or keys you don't want on the remote. KiroLex forwards these from
your computer to remote Kiro chats:

- **automatically:** MCP servers in the chat's Kiro agent whose command is a local path, and the ones
  named `playwright`, `drawio` or `pencil`;
- **by name:** add them under **Settings → 🖥 机器** → **MCPs forwarded from this machine to remote
  sessions**. Click **+ Add**, enter the **MCP name** as it appears under `mcpServers` in your Kiro
  agent file, and optionally a **Timeout (seconds)**. The timeout applies to HTTP entries only, with
  a minimum of 120 seconds and a default of 180. ✕ (**Remove this entry**) deletes a row.

For forwarded servers, *an HTTP upstream sees your local outbound IP, ${env:…} in request headers is
expanded from your local environment, and keys never reach the remote.* Changes apply to the next
remote chat. Local chats are not affected. Only the chat's selected Kiro agent is read, so a chat on
the default agent forwards nothing.

## Windows notes

- On Windows, each remote chat opens its own ssh connection. On macOS and Linux, chats to the same
  machine share one connection.
- `local_bash` runs through `cmd.exe`, so the remote agent has to use cmd syntax for commands on your
  computer.
