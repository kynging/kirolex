/**
 * **SSH 密码登录** ——「除了用户名应该还有密码，不过密码可以是空的」。
 *
 * ssh 不接受命令行上的密码，只会在终端里问；而 KiroLex 的每一条 ssh 都是后台进程，
 * 没有终端（还都带着 `BatchMode=yes`，意思就是"什么都不许问"）。标准做法是 `SSH_ASKPASS`：
 * ssh 要密码时去跑这个程序，读它 stdout 的第一行当答案。`SSH_ASKPASS_REQUIRE=force` 让它
 * 即使有终端、没有 DISPLAY 也走这条路（OpenSSH ≥ 8.4；Windows 自带的 OpenSSH 9.x 也认）。
 *
 * 三条规矩：
 *   · **没配密码的机器行为完全不变**：`sshEnv` 原样返回、`batchModeFor` 仍然是 `yes`。
 *   · 明文**只在内存和子进程环境里**：配置里存的是 `safeStorage` 加密后的 `passwordCipher`
 *     （和 S3 secret 同一套，见 index.ts `encryptSecret`），界面只拿到 `hasPassword`。
 *   · 助手程序本身**不含密码**：它只把环境变量 `KX_SSH_PASSWORD` 打出来，所以落盘的那个
 *     小脚本谁读到都没用。
 *
 * 同一个答案也会被用来回答"私钥口令"的提问 —— ssh 问的都是"一个秘密"，这正是想要的。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

/** 解密由主进程注入（`safeStorage` 只在 Electron 主进程里有；这样这个模块在 node:test 里也能跑）。 */
let decrypt: ((cipher: string) => string) | null = null;
export function setPasswordDecryptor(fn: (cipher: string) => string): void { decrypt = fn; }

export interface PasswordAuth { passwordCipher?: string }

/** 这台机器配了密码吗。 */
export function hasPassword(remote: PasswordAuth | undefined): boolean {
  return !!remote?.passwordCipher;
}

/** 有密码就得让 ssh 能问（`BatchMode=yes` 会让它连 askpass 都不调）。 */
export function batchModeFor(remote: PasswordAuth | undefined): string {
  return hasPassword(remote) ? 'BatchMode=no' : 'BatchMode=yes';
}

const HELPER_DIR = path.join(os.homedir(), '.kirolex', 'askpass');

/**
 * 助手脚本的路径，没有就写一份。
 *
 * Windows 用 PowerShell 读环境变量：`echo %X%` 会把 `&` `|` `^` `%` 这些当成 cmd 语法，
 * 带特殊字符的密码就会被截断或执行。PowerShell 的 `$env:X` 原样输出。
 */
export function askpassHelper(dir = HELPER_DIR, platform = process.platform): string {
  const win = platform === 'win32';
  const file = path.join(dir, win ? 'askpass.cmd' : 'askpass.sh');
  const body = win
    ? '@echo off\r\npowershell -NoProfile -NonInteractive -Command "[Console]::Out.WriteLine($env:KX_SSH_PASSWORD)"\r\n'
    : '#!/bin/sh\nprintf \'%s\\n\' "$KX_SSH_PASSWORD"\n';
  try {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== body) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, body, { mode: 0o700 });
    }
  } catch { /* 写不了就让 ssh 自己报"认证失败"，那句话至少是真的 */ }
  return file;
}

/**
 * 给一次 ssh 调用的环境。没配密码 / 解不开 → 原样（复制一份）返回，ssh 照旧用密钥。
 */
export function sshEnv(remote: PasswordAuth | undefined, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  if (!remote?.passwordCipher || !decrypt) return env;
  let plain = '';
  try { plain = decrypt(remote.passwordCipher); } catch { plain = ''; }
  if (!plain) return env;
  return {
    ...env,
    SSH_ASKPASS: askpassHelper(),
    SSH_ASKPASS_REQUIRE: 'force',
    /* 老版本 OpenSSH 没有 SSH_ASKPASS_REQUIRE，只在"有 DISPLAY、没终端"时才调 askpass */
    DISPLAY: env.DISPLAY || 'kirolex:0',
    KX_SSH_PASSWORD: plain,
  };
}
