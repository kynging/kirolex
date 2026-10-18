/**
 * **Windows 作业对象（Job Object）** —— 后台命令（`bgJobs.ts`）的进程归属靠它，不靠进程快照推断。
 *
 * 为什么：按「父进程号 + 出生时间」从快照里推断哪些进程是这个任务的，pid 一被复用就会认错、误杀别的程序
 * （连续几轮都栽在这上面）。作业对象是内核记账：进程一旦放进去，它之后起的所有子孙都自动在里面、出不去；
 * 结束任务 = `TerminateJobObject`，只结束作业里的进程，不看 pid。
 *
 * 实现：一个常驻的 PowerShell 辅助进程（`Add-Type` 包一层 CreateJobObject / AssignProcessToJobObject /
 * TerminateJobObject），按行收命令：
 *   `new <id> <pid> <父pid>`  核对它还在运行、父进程就是 <父pid>（= KiroLex 自己），再建一个作业（设 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）并把 pid 放进去 → `ok <id>` / `err <id> <原因>`
 *   `kill <id>`       结束作业里的全部进程并关掉句柄 → `ok <id>`
 * 句柄都在辅助进程手里，**KiroLex 退出或崩溃时**它的 stdin 断开、它退出，句柄随之关闭，`KILL_ON_JOB_CLOSE`
 * 让作业里剩下的进程全部结束 —— 不需要 KiroLex 自己在退出路径上做任何事。
 *
 * 不 import electron；测试在 Windows 上直接起真的辅助进程。
 */

import { spawn, type ChildProcess } from 'child_process';
import os from 'os';
import path from 'path';

const CS = String.raw`
using System;
using System.Runtime.InteropServices;
public static class KxJob {
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public Int64 a; public Int64 b; public UInt32 LimitFlags; public UIntPtr c; public UIntPtr d; public UInt32 e; public UIntPtr f; public UInt32 g; public UInt32 h; }
  [StructLayout(LayoutKind.Sequential)] struct IO { public UInt64 a; public UInt64 b; public UInt64 c; public UInt64 d; public UInt64 e; public UInt64 f; }
  [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC Basic; public IO Io; public UIntPtr a; public UIntPtr b; public UIntPtr c; public UIntPtr d; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref EXT info, int len);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [StructLayout(LayoutKind.Sequential)] struct PBI { public IntPtr ExitStatus; public IntPtr Peb; public IntPtr Affinity; public IntPtr BasePriority; public UIntPtr Pid; public UIntPtr ParentPid; }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PBI info, int len, out int ret);
  public static IntPtr Create(uint pid, uint parent) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Exception("CreateJobObject " + Marshal.GetLastWin32Error());
    EXT info = new EXT();
    info.Basic.LimitFlags = 0x2000; /* JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE */
    if (!SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(typeof(EXT)))) { int e = Marshal.GetLastWin32Error(); CloseHandle(job); throw new Exception("SetInformationJobObject " + e); }
    IntPtr p = OpenProcess(0x1101, false, pid); /* PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION */
    if (p == IntPtr.Zero) { int e = Marshal.GetLastWin32Error(); CloseHandle(job); throw new Exception("OpenProcess " + e); }
    /* 打开的必须就是我们起的那个：还在运行，而且父进程是（还活着的）KiroLex —— pid 被别的程序复用了的话这里对不上 */
    uint code; PBI pbi = new PBI(); int ret;
    if (!GetExitCodeProcess(p, out code) || code != 259) { CloseHandle(p); CloseHandle(job); throw new Exception("not running"); }
    if (NtQueryInformationProcess(p, 0, ref pbi, Marshal.SizeOf(typeof(PBI)), out ret) != 0 || pbi.ParentPid.ToUInt64() != parent) { CloseHandle(p); CloseHandle(job); throw new Exception("not our child"); }
    bool ok = AssignProcessToJobObject(job, p);
    int err = Marshal.GetLastWin32Error();
    CloseHandle(p);
    if (!ok) { CloseHandle(job); throw new Exception("AssignProcessToJobObject " + err); }
    return job;
  }
  public static void Kill(IntPtr job) { TerminateJobObject(job, 1); CloseHandle(job); }
}
`;

const PS = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${CS}
'@
$jobs = @{}
[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $p = $line.Split(' ')
  try {
    if ($p[0] -eq 'new') { $jobs[$p[1]] = [KxJob]::Create([uint32]$p[2], [uint32]$p[3]); [Console]::Out.WriteLine('ok ' + $p[1]) }
    elseif ($p[0] -eq 'kill') { if ($jobs.ContainsKey($p[1])) { [KxJob]::Kill($jobs[$p[1]]); $jobs.Remove($p[1]) }; [Console]::Out.WriteLine('ok ' + $p[1]) }
  } catch { [Console]::Out.WriteLine('err ' + $p[1] + ' ' + $_.Exception.Message) }
  [Console]::Out.Flush()
}
`;

/** 进程归属的接口（bgJobs 用）：放进作业 / 结束作业 / 退出时全部结束。 */
export interface JobHost {
  /** 把 pid 放进一个新作业。false = 没放进去（调用方退回「只结束自己握着句柄的那个进程」）。 */
  assign(id: string, pid: number): Promise<boolean>;
  /** 结束作业里的全部进程（没有这个作业就什么都不做）。 */
  terminate(id: string): Promise<void>;
  /** 退出路径：同步结束辅助进程 —— 它的句柄一关，所有作业里的进程都由系统结束。 */
  killAllSync(): void;
}

export class WinJobHost implements JobHost {
  private proc: ChildProcess | null = null;
  private ready: Promise<boolean> | null = null;
  private buf = '';
  private waiters = new Map<string, Array<(line: string) => void>>();
  private readonly log: (m: string) => void;
  private readonly startTimeoutMs: number;

  constructor(log: (m: string) => void = () => {}, startTimeoutMs = 60_000) {
    this.log = log;
    this.startTimeoutMs = startTimeoutMs;
  }

  private ensure(): Promise<boolean> {
    if (this.ready && this.proc && this.proc.exitCode === null && this.proc.signalCode === null) return this.ready;
    this.buf = '';
    const encoded = Buffer.from(PS, 'utf16le').toString('base64');
    let proc: ChildProcess;
    try {
      /* cwd 放到临时目录：PowerShell 找不到本地 AppData 时会把模块缓存写进当前目录 —— 别写进 KiroLex 碰巧所在的地方 */
      /* 绝对路径：按 PATH 找 powershell.exe 的第一次 spawn 会同步卡好几秒 */
      const exe = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
      proc = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], cwd: os.tmpdir() });
    } catch (err: any) {
      this.log(`job helper spawn failed: ${err?.message || err}`);
      this.ready = Promise.resolve(false);
      return this.ready;
    }
    this.proc = proc;
    /* 它不该拖着主进程不退（退出时 KiroLex 会主动收掉它；崩溃时 stdin 断开它自己退） */
    try { proc.unref(); (proc.stdin as any)?.unref?.(); (proc.stdout as any)?.unref?.(); (proc.stderr as any)?.unref?.(); } catch {}
    this.ready = new Promise<boolean>((resolve) => {
      const t = setTimeout(() => { this.log('job helper did not start in time'); resolve(false); }, this.startTimeoutMs);
      const onLine = (line: string) => {
        if (line === 'ready') { clearTimeout(t); resolve(true); return; }
        const m = /^(ok|err) (\S+)/.exec(line);
        if (!m) return;
        const q = this.waiters.get(m[2]);
        const w = q?.shift();
        if (q && !q.length) this.waiters.delete(m[2]);
        w?.(line);
      };
      proc.stdout?.on('data', (d: Buffer) => {
        this.buf += d.toString('utf8');
        let i: number;
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i).replace(/\r$/, '').trim();
          this.buf = this.buf.slice(i + 1);
          if (line) onLine(line);
        }
      });
      proc.stderr?.on('data', (d: Buffer) => {
        /* PowerShell 的进度流（CLIXML）不是错误，别进日志 */
        const t = String(d).trim();
        if (t && !/^#< CLIXML|^<Objs /.test(t)) this.log(`job helper: ${t.slice(0, 300)}`);
      });
      proc.on('error', (err) => { clearTimeout(t); this.log(`job helper error: ${err?.message || err}`); resolve(false); });
      proc.on('exit', () => {
        clearTimeout(t);
        resolve(false);
        /* 还在等回话的全部当失败（作业里的进程已经随句柄关闭被系统结束了） */
        for (const [, q] of this.waiters) for (const w of q) w('err gone');
        this.waiters.clear();
      });
    });
    return this.ready;
  }

  private request(id: string, line: string): Promise<string> {
    return new Promise((resolve) => {
      const q = this.waiters.get(id) || [];
      q.push(resolve);
      this.waiters.set(id, q);
      try { this.proc?.stdin?.write(`${line}\n`); } catch { resolve('err write'); }
    });
  }

  async assign(id: string, pid: number): Promise<boolean> {
    if (!/^[\w-]+$/.test(id) || !Number.isInteger(pid) || pid <= 0) return false;
    if (!(await this.ensure())) return false;
    /* 第三个参数：它的父进程必须是我们（KiroLex 自己活着，所以这个 pid 不会被复用） */
    const r = await this.request(id, `new ${id} ${pid} ${process.pid}`);
    if (!r.startsWith('ok')) this.log(`job ${id} assign failed: ${r}`);
    return r.startsWith('ok');
  }

  async terminate(id: string): Promise<void> {
    if (!this.proc || this.proc.exitCode !== null || !(await this.ready)) return;
    await this.request(id, `kill ${id}`);
  }

  killAllSync(): void {
    try { this.proc?.kill(); } catch { /* 已经没了 */ }
    this.proc = null;
    this.ready = null;
  }
}
