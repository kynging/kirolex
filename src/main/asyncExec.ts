/**
 * `execFileSync` / `execSync` 的异步替身：同样的参数、同样的超时，成功给 stdout 文本，失败（退出码非零 / 超时 / ENOENT）reject。
 *
 * ——「远程会话连接的前半段输入框没法输入」：主进程里的 execSync / execFileSync 一跑，事件循环整个停住，
 * Windows 上窗口的键盘输入要经过主进程，于是整个窗口不响应输入。调用方改成 await 它，语义不变。
 */
import { exec, execFile, type ExecFileOptions, type ExecOptions } from 'child_process';

export function execFileText(file: string, args: string[], opts: ExecFileOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...opts, encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(String(stdout ?? ''))));
  });
}

/** `execSync(command)` 的异步替身（同样经 shell：Windows 上 cmd.exe，别处 /bin/sh）。 */
export function execShellText(command: string, opts: ExecOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, { ...opts, encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(String(stdout ?? ''))));
  });
}
