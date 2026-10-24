/**
 * **Windows 上 shell 输出的编码** ——「local_bash 中文输出乱码、echo >> 写进 UTF-8 文件变 GBK」。
 *
 * 实测（代码页 936 的机器）：node 自己按 UTF-8 输出，cmd 内建命令 / findstr / `echo x>>f` 按活动代码页（936 = GBK）
 * 输出，而我们一律按 UTF-8 解 —— 于是「找不到文件」变成「�Ҳ����ļ�」，`echo 中文>>记忆.md` 往 UTF-8 文件里写进 GBK 字节。
 *
 * 两层：
 *   · 让 cmd 以 UTF-8 代码页跑（`cmdUtf8Args`：先 `chcp 65001>nul` 再起跑命令的 cmd；后台任务的闸门见 bgJobs.ts）——
 *     内建命令、findstr、echo 重定向都按 UTF-8；外层是 `windowsHide` 起的、有自己的（隐藏）控制台，改代码页不会波及用户的终端。
 *   · 解码兜底（`decodeShellOutput`）：仍有程序不理会控制台代码页、按 OEM / ANSI 代码页写 —— 不是合法 UTF-8 的那几行
 *     按本机代码页再解一次。
 *
 * mac / linux 不走这里（`localOutputEncoding()` 在那边是 null = 和原来一样按 UTF-8 解）。
 */
import { execFileSync } from 'child_process';
import { TextDecoder } from 'util';

/** `cmdUtf8Args` 那条命令放在这个环境变量里交给外层 cmd。 */
export const CMD_UTF8_VAR = 'KX_UTF8_CMD';

/**
 * 以 UTF-8 代码页跑一条 cmd 命令：`%ComSpec%` + 这组参数 + `env[CMD_UTF8_VAR] = 命令`（`windowsVerbatimArguments`）。
 *
 * **不能直接 `chcp 65001>nul & 命令`**：cmd 在**启动时**就记下了代码页，同一个 cmd 里 chcp 之后它自己的 echo、
 * 重定向照旧按老代码页写（实测：`chcp 65001>nul & echo 中文>f` 写进去的是 `??`）。所以外层 cmd 先 chcp，
 * 再起一个**新的** cmd 跑命令 —— 新的那个起来时代码页已经是 65001，而且和外层共用同一个控制台。
 *
 * 命令经环境变量 + 延迟展开（`/v:on` 的 `!…!`）交给内层：延迟展开发生在外层解析完 `&` / `|` / 引号**之后**，
 * 命令里的特殊字符一个都不会被外层碰到；内层拿到的就是原来那条 `/d /s /c "命令"`，`%VAR%`、`^`、退出码都和原来一样。
 * chcp 和内层 cmd 用绝对路径（`!SystemRoot!` / `!ComSpec!`）：不然工作目录里的 `chcp.bat` / `cmd.bat` 会先被找到。
 */
export function cmdUtf8Args(): string[] {
  return ['/d', '/v:on', '/s', '/c', `"!SystemRoot!\\System32\\chcp.com 65001>nul & !ComSpec! /d /s /c "!${CMD_UTF8_VAR}!""`];
}

/**
 * `shell: 'powershell'` 的参数（**不要** `windowsVerbatimArguments`）。整条脚本是 `-Command` 后面的**一个**参数：
 * Node 按 MSVC 规则给它加引号 / 转义，powershell.exe 按同一套规则拆回来 —— 引号、反斜杠原样到达（实测），
 * 模型不用为了引号把命令写成脚本文件。前面先把输出编码设成 UTF-8（管道里的 stdout 按它编码）。
 *
 * 不用 `-EncodedCommand`：实测它让 stderr 变成 `#< CLIXML <Objs …>` 一大坨 XML（连进度信息一起），模型读不了。
 */
export function powershellArgs(command: string): string[] {
  const script = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; '
    + command;
  return ['-NoProfile', '-NonInteractive', '-Command', script];
}

/** Windows 代码页 → `TextDecoder` 认的名字；认不出（或者本来就是 UTF-8）给 null。 */
export function legacyEncodingForCodePage(cp: number): string | null {
  if (!Number.isInteger(cp) || cp <= 0 || cp === 65001) return null;
  const known: Record<number, string> = {
    936: 'gbk', 54936: 'gb18030', 950: 'big5', 932: 'shift_jis', 949: 'euc-kr',
    866: 'ibm866', 20866: 'koi8-r', 21866: 'koi8-u',
  };
  const candidates = known[cp] ? [known[cp]] : [`windows-${cp}`];
  if (cp >= 28591 && cp <= 28605) candidates.push(`iso-8859-${cp - 28590}`);
  for (const label of candidates) {
    try { return new TextDecoder(label).encoding === 'utf-8' ? null : label; } catch { /* 这个名字不认 */ }
  }
  return null;
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true });

/**
 * 解 shell 的输出：整段是合法 UTF-8 就按 UTF-8；不是的话**逐行**判断 —— 合法 UTF-8 的行照旧，不合法的行按 `legacy`
 * （本机代码页）解。逐行是因为同一条命令里常常两种都有（node 打 UTF-8、cmd 的报错是 936）。
 * `legacy` 为 null：和原来一样按 UTF-8 解（坏字节成 U+FFFD）。
 */
export function decodeShellOutput(buf: Buffer, legacy: string | null): string {
  if (!legacy) return buf.toString('utf8');
  try { return utf8Strict.decode(buf); } catch { /* 有不合法的字节：逐行来 */ }
  let fallback: TextDecoder;
  try { fallback = new TextDecoder(legacy); } catch { return buf.toString('utf8'); }
  const out: string[] = [];
  let start = 0;
  while (start <= buf.length) {
    let end = buf.indexOf(0x0a, start);
    if (end < 0) end = buf.length;
    const line = buf.subarray(start, end);
    try { out.push(utf8Strict.decode(line)); } catch { out.push(fallback.decode(line)); }
    start = end + 1;
  }
  return out.join('\n');
}

let cachedEncoding: string | null | undefined;

/**
 * 本机（Windows）的兜底编码：先看 OEM 代码页（控制台程序默认用它，= GetConsoleOutputCP 的默认值），
 * `TextDecoder` 不认（例如 437）再看 ANSI 代码页（GetACP）。从注册表读一次、缓存住。非 Windows 是 null。
 */
export function localOutputEncoding(): string | null {
  if (process.platform !== 'win32') return null;
  if (cachedEncoding !== undefined) return cachedEncoding;
  cachedEncoding = null;
  try {
    const out = execFileSync('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    for (const name of ['OEMCP', 'ACP']) {
      const m = new RegExp(`^\\s*${name}\\s+REG_SZ\\s+(\\d+)`, 'm').exec(out);
      const enc = m ? legacyEncodingForCodePage(Number(m[1])) : null;
      if (enc) { cachedEncoding = enc; break; }
    }
  } catch { /* 读不到：就按 UTF-8 */ }
  return cachedEncoding;
}

/** 本机 shell 输出 → 文字（Windows 上带代码页兜底；其他系统同 `buf.toString('utf8')`）。 */
export function decodeLocalOutput(buf: Buffer): string {
  if (process.platform !== 'win32') return buf.toString('utf8');
  /* 绝大多数输出是合法 UTF-8：那就不用去查代码页 */
  try { return utf8Strict.decode(buf); } catch { return decodeShellOutput(buf, localOutputEncoding()); }
}
