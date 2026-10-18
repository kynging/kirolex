# Automation: scheduled jobs

[← Back to contents](README.md)

A **scheduled job** sends one of your messages again, automatically, on a schedule. Use it for
things like "every morning, summarise yesterday's commits" or "every 30 minutes, check whether the
deploy finished".

## Create a scheduled job

1. Send the message once as a normal message, or find an earlier message of yours.
2. Click the **⏰** button on it (*Send this message again on a schedule*). This works even
   while a reply is running.
3. In the **⏰ Scheduled job** dialog, choose a **Trigger**:

   | Trigger | Fields |
   |---|---|
   | **Daily at a set time** (default) | **Time (HH:MM, 24-hour)**, default 09:00 |
   | **Weekly at a set time** | **Day of week** (周日…周六, *Sunday…Saturday*; default Monday) and **Time (HH:MM, 24-hour)** |
   | **Repeat on an interval** | **间隔（分钟，最少 1）** (*Interval in minutes, at least 1*), default 60 |
   | **Once, at a given moment** | **Trigger moment**, a date and time |

4. Set **Maximum number of runs (required)**. It starts at 20. Every job has a limit, so a forgotten
   job can't run for ever.
5. Click **Create**. Enter also creates the job, and Esc closes the dialog.

The dialog shows a summary such as 每天 09:00 · 最多 20 次 (*daily at 09:00 · at most 20 runs*).
Each run sends the same message text again. KiroLex does not paste the previous run's result into
it. However, the run is sent **in the same chat**, as a normal next message, so the agent still sees
the chat's earlier conversation, including earlier runs, and its answer can be influenced by it.
There is no way to give each run a fresh, empty context. Creating the job in a chat used only for
that job, with a self-contained message, keeps unrelated conversation out of it, but every run still
shares that chat's history, including all earlier runs.

**When the first run happens:** an interval job runs straight away. A daily or weekly job waits
for the next matching time. A one-time job runs at the moment you chose.

## Watch, pause and cancel

While a chat has a scheduled job:

- a banner above the conversation shows the schedule, the time until the next run, runs so far (for
  example 已运行 3/20, *run 3/20*) and the last failure, if any;
- the sidebar shows ⏰ with a short countdown, or ⏸️ when the job is paused.

Banner buttons:

- **⏸️ Pause** (*Pause: keep the job, stop it firing*) and **▶️ Resume** (*Resume: keep running on the
  original schedule*);
- **🗑️ Cancel** (*Cancel this scheduled job*). Click again within a few seconds on **Confirm cancel?**
  to confirm. This cannot be undone.

When a job ends, the chat says so: ⏰ 定时任务结束 (*scheduled job ended*), because it completed, used
up its run budget, or was cancelled.

## How timing works

- Jobs are checked about every 20 seconds, so a run can start up to about 20 seconds late.
- A run is counted **before** it is sent. If KiroLex crashes mid-run, it does not repeat that run
  again and again. A failed run still counts towards the limit.
- **Jobs keep running while the window is hidden** in the tray. They run in KiroLex's background
  process, not in the window.
- **Jobs do not run while KiroLex is quit.** If a run was due while KiroLex was closed, the job runs
  once soon after the next start. Missed runs are not replayed one by one.
- While KiroLex is waiting to quit, no new runs start.

Scheduled jobs are stored in `~/.kirolex/schedules/`. See [Data and privacy](data-and-privacy.md).

## Background commands and watches started by the agent

The agent can also start work that reports back later, without holding the current reply open:

- **`bg_run`** runs a shell command in the background on your computer, in the chat's folder. When
  the command exits, its exit code and the end of its output arrive in the chat as a new message.
- **`watch`** runs a long-running command (for example `tail -f` on a log, filtered with `grep`).
  Every line it prints is sent back to the chat as an event.

While they run, a banner above the conversation lists them (⚙️ 后台命令 / 👀 监视, *Background
command / Watching*) with their label and running time. **⏹️ Stop** ends one; the chat then records
that you stopped it. If a reply is running at that moment, the record appears when that reply ends.

**Ending a task ends the processes it started.** When a task finishes, is stopped, times out, or
KiroLex quits, KiroLex ends that command and the processes it started, including ones it put in the
background (`nohup x &`, `start /b x`). Two consequences:

- **Don't use a background task to start a service you want to keep running.** Start it yourself in a
  terminal instead.
- **Known limitation on macOS and Linux:** a program that detaches itself from the task's process
  group, for example with `setsid`, `daemonize`, or Node's `detached: true`, is no longer in the
  task's process group. KiroLex does **not** end it when the task finishes, is stopped, or KiroLex
  quits; you have to end it yourself. On Windows, such programs are still ended.
