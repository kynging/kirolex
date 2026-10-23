/**
 * **缺 Claude Code / Codex 的 ACP 适配器时，在会话里一键装上** ——「别只叫人去设置里找」。
 *
 * 本机：`npm install -g <包>`，**cwd 是家目录**。绝不在 KiroLex 自己的目录里 `npm install` / `npm ci`：
 * 那会重装官方 Electron，Falcon 把它当 malware 杀掉。`-g` 装到全局 npm，和用户自己照着提示敲的那条一样。
 * 远端：「安装 AI 工具」那个脚本（`scripts/remote-bootstrap.sh`），带 `ONLY=<命令名>` 只装缺的那一个（index.ts `installRemoteAdapter`）。
 *
 * 纯模块（不 import electron）：spawn 由调用方传进来，测试换成假的。
 */
import path from 'path';
import { ADAPTER_PACKAGE, ENGINE_LABEL, REMOTE_ADAPTER_BIN } from './engines.ts';
import { tr } from './uiText.ts';

export type AdapterEngine = 'claude' | 'codex';

export interface InstallCommand { command: string; args: string[]; cwd: string }

function q(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * macOS / Linux 上跑的那段（`bash -lc`）。GUI 起的 KiroLex 的 PATH 里常常没有 npm（Homebrew、fnm、nvm 都不在），
 * 所以先问登录 shell，再到常见位置和 fnm / nvm / Volta / asdf 的版本目录里找（目录布局和远端探测 `adapterProbeScript` 同一套），
 * 后找到的覆盖前面的 —— 版本目录按名字排序，最后一个通常是最新的。
 */
export function localInstallScript(pkg: string): string {
  return [
    `kx_pkg=${q(pkg)}`,
    'cd "$HOME" || exit 1',
    'kx_npm=$(command -v npm 2>/dev/null)',
    'if [ -z "$kx_npm" ]; then',
    '  for kx_d in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin" "$HOME/.npm-global/bin" "${VOLTA_HOME:-$HOME/.volta}/bin" \\',
    '    "${FNM_DIR:-$HOME/.local/share/fnm}"/node-versions/*/installation/bin "$HOME/.fnm"/node-versions/*/installation/bin \\',
    '    "$HOME/Library/Application Support/fnm"/node-versions/*/installation/bin \\',
    '    "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin "${ASDF_DATA_DIR:-$HOME/.asdf}"/installs/nodejs/*/bin; do',
    '    [ -x "$kx_d/npm" ] && kx_npm="$kx_d/npm"',
    '  done',
    'fi',
    'if [ -z "$kx_npm" ]; then echo KX_NO_NPM; exit 127; fi',
    /* npm 自己是个 node 脚本：它的目录（node 也在那）要在 PATH 上 */
    'export PATH="$(dirname "$kx_npm"):$PATH"',
    'echo "npm: $kx_npm"',
    'exec "$kx_npm" install -g "$kx_pkg"',
  ].join('\n');
}

/** 本机装这一家的适配器用哪条命令。cwd 永远是家目录。 */
export function localInstallCommand(
  engine: AdapterEngine,
  opts: { platform: NodeJS.Platform; home: string; env: NodeJS.ProcessEnv },
): InstallCommand {
  const pkg = ADAPTER_PACKAGE[engine];
  if (opts.platform === 'win32') {
    /* npm 在 Windows 上是 npm.cmd：直接 spawn `.cmd` 会 EINVAL，经 cmd.exe 跑（和 engines.ts 问 `npm root -g` 同一个做法） */
    return { command: opts.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `npm install -g ${pkg}`], cwd: opts.home };
  }
  return { command: '/bin/bash', args: ['-lc', localInstallScript(pkg)], cwd: opts.home };
}

/** 远端那一条：脚本从 stdin 落到临时文件再跑（理由见 index.ts `remote:bootstrap`），只装 `ONLY` 点名的那个（kiro → `kiro-cli`）。 */
export function remoteInstallCommand(remoteTmp: string, engine: AdapterEngine | 'kiro'): string {
  const only = engine === 'kiro' ? 'kiro-cli' : REMOTE_ADAPTER_BIN[engine];
  return `cat > ${remoteTmp} && ONLY=${only} bash ${remoteTmp}; rc=$?; rm -f ${remoteTmp}; exit $rc`;
}

/**
 * 远端「只装 kiro-cli」跑完之后的结论（index.ts `installRemoteKiro`）：装完按设置里「自动检测」那套在那台机器上找一遍，
 * 找到能起的 kiro-cli 才算装好（`found`）；那台机器还没配 kiro 启动命令的，调用方把找到的这条存进去（`saveAs`），
 * 不然会话照样报「还没有设置 {host} 上的 kiro 启动命令」。已经配过的不动（那是人选的）。
 */
export function remoteKiroInstallOutcome(
  host: string,
  run: { code: number | null; output: string; error?: string },
  found: { command: string; version?: string } | undefined,
  configured: string | undefined,
): { ok: true; saveAs?: string } | { ok: false; error: string } {
  if (run.error) return { ok: false, error: tr('❌ Installing kiro-cli on {host} failed: {why}', { host, why: run.error }) };
  if (run.code === 255) return { ok: false, error: tr('❌ Installing kiro-cli on {host} failed: {why}', { host, why: installFailureReason(run.output, run.code) }) };
  if (found) return { ok: true, ...(configured ? {} : { saveAs: found.command }) };
  const why = run.code === 0
    ? tr('the install script finished, but no kiro-cli that starts was found on that machine')
    : remoteInstallReason(run.output, run.code);
  return { ok: false, error: tr('❌ Installing kiro-cli on {host} failed: {why}', { host, why }) };
}

/** npm 输出 → 一句原因。认得出的说人话，认不出的给最后几行。 */
export function installFailureReason(output: string, code: number | null, opts: { timedOut?: boolean } = {}): string {
  const out = String(output || '');
  if (opts.timedOut) return tr('it did not finish within {min} minutes', { min: '10' });
  if (/KX_NO_NPM|'npm' is not recognized|不是内部或外部命令|npm: command not found/.test(out)) {
    return tr('npm was not found on this machine. Install Node.js (it comes with npm) first, then click Install again.');
  }
  const tail = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-6).join('\n');
  if (/EACCES|permission denied/i.test(out)) {
    return tr('npm has no permission to write its global folder (EACCES).') + (tail ? `\n${tail}` : '');
  }
  return tail || tr('Exit code {code}', { code: code == null ? '?' : String(code) });
}

/**
 * 远端脚本的输出 → 原因。脚本里 npm 失败时把它最后几行加 `  npm: ` 前缀打出来（`remote-bootstrap.sh` 的 `npm_i`），
 * 有这些行就用它们（网络 / 权限 / 下载的具体原因）+ 那句 `✗ … 装不上`；没有再退回看最后几行。
 */
export function remoteInstallReason(output: string, code: number | null): string {
  const lines = String(output || '').split(/\r?\n/);
  const npm = lines.map((l) => /^\s*npm: (.*)$/.exec(l)?.[1]?.trim()).filter((l): l is string => !!l);
  if (!npm.length) return installFailureReason(output, code);
  const fails = lines.map((l) => l.trim()).filter((l) => /^✗ /.test(l) && !/没装好，见上面/.test(l));
  const why = [...fails.slice(0, 3), ...npm.slice(-8)].join('\n');
  return /EACCES|permission denied/i.test(why) ? `${tr('npm has no permission to write its global folder (EACCES).')}\n${why}` : why;
}

/**
 * 远端「只装一个」跑完之后的结论（index.ts `installRemoteAdapter`）：装完验证能起才算装好；
 * 起不来时原因 = 脚本的失败原因（退出码非 0 时）+ 验证那一句。
 */
export function remoteInstallOutcome(
  engine: AdapterEngine,
  host: string,
  run: { code: number | null; output: string; error?: string },
  verify?: { ok: boolean; line: string },
): InstallResult {
  if (run.error) return { ok: false, error: adapterInstallFailedMessage(engine, host, run.error) };
  /* 255 = ssh 自己没连上：脚本根本没跑 */
  if (run.code === 255 || !verify) return { ok: false, error: adapterInstallFailedMessage(engine, host, installFailureReason(run.output, run.code)) };
  if (verify.ok) return { ok: true };
  const why = [run.code === 0 ? '' : remoteInstallReason(run.output, run.code), verify.line].filter(Boolean).join('\n');
  return { ok: false, error: adapterInstallFailedMessage(engine, host, why) };
}

/** 装不上时会话里说的那句。`host` 没给 = 本机。 */
export function adapterInstallFailedMessage(engine: AdapterEngine, host: string | undefined, why: string): string {
  return host
    ? tr('❌ Installing the {engine} ACP adapter ({pkg}) on {host} failed: {why}', { engine: ENGINE_LABEL[engine], pkg: ADAPTER_PACKAGE[engine], host, why })
    : tr('❌ Installing the {engine} ACP adapter ({pkg}) on this machine failed: {why}', { engine: ENGINE_LABEL[engine], pkg: ADAPTER_PACKAGE[engine], why });
}

interface ChildLike {
  stdout?: { on(ev: 'data', cb: (b: Buffer) => void): void } | null;
  stderr?: { on(ev: 'data', cb: (b: Buffer) => void): void } | null;
  on(ev: 'error', cb: (err: Error) => void): void;
  on(ev: 'close', cb: (code: number | null) => void): void;
  kill(signal?: string): void;
}
export type SpawnLike = (command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; windowsHide: boolean; stdio: Array<'ignore' | 'pipe'> }) => ChildLike;

export type InstallResult = { ok: true; entry?: string } | { ok: false; error: string };

/**
 * 在本机装，边装边把输出交给 `onOutput`。装完用 `findEntry` 确认 KiroLex 真的找得到它（`engines.ts` 的
 * `findAdapterEntry`，含 fnm / nvm / Volta / asdf 的目录）—— npm 说成功、却装到了一个 KiroLex 看不见的地方，也算失败。
 * 非 Windows 上 PATH 里有那个命令也算（`resolveAdapter` 在那边会按名字起它）。
 */
export function runLocalAdapterInstall(engine: AdapterEngine, deps: {
  spawn: SpawnLike;
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  onOutput?: (chunk: string) => void;
  findEntry: () => string | null;
  /** 非 Windows：PATH 上有没有这个命令。 */
  binOnPath?: (bin: string) => boolean;
  timeoutMs?: number;
}): Promise<InstallResult> {
  const cmd = localInstallCommand(engine, { platform: deps.platform, home: deps.home, env: deps.env });
  const say = (s: string) => { try { deps.onOutput?.(s); } catch { /* 界面没了不影响安装 */ } };
  say(`$ npm install -g ${ADAPTER_PACKAGE[engine]}  (cwd: ${cmd.cwd})\n`);
  return new Promise<InstallResult>((resolve) => {
    let output = '';
    let done = false;
    let timedOut = false;
    /* spawn 可能同步抛错（还没起定时器）：timer 先声明成可选，清的时候判一下 */
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (r: InstallResult) => { if (!done) { done = true; if (timer) clearTimeout(timer); resolve(r); } };
    let child: ChildLike;
    try {
      child = deps.spawn(cmd.command, cmd.args, { cwd: cmd.cwd, env: deps.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err: any) {
      finish({ ok: false, error: adapterInstallFailedMessage(engine, undefined, String(err?.message || err)) });
      return;
    }
    const onData = (b: Buffer) => {
      const s = b.toString('utf-8');
      output = (output + s).slice(-8000);
      say(s);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* 已经退了 */ } }, deps.timeoutMs ?? 10 * 60_000);
    child.on('error', (err) => finish({ ok: false, error: adapterInstallFailedMessage(engine, undefined, String(err?.message || err)) }));
    child.on('close', (code) => {
      if (code !== 0 || timedOut) {
        finish({ ok: false, error: adapterInstallFailedMessage(engine, undefined, installFailureReason(output, code, { timedOut })) });
        return;
      }
      const entry = deps.findEntry();
      if (entry) { finish({ ok: true, entry }); return; }
      if (deps.platform !== 'win32' && deps.binOnPath?.(REMOTE_ADAPTER_BIN[engine])) { finish({ ok: true }); return; }
      finish({ ok: false, error: adapterInstallFailedMessage(engine, undefined, tr('npm reported success, but KiroLex cannot find {pkg} in any global node_modules folder it knows about.', { pkg: ADAPTER_PACKAGE[engine] })) });
    });
  });
}

/** PATH 上有没有这个可执行文件（非 Windows 用）。 */
export function binOnPath(bin: string, env: NodeJS.ProcessEnv, exists: (p: string) => boolean): boolean {
  return String(env.PATH || '').split(path.delimiter).filter(Boolean).some((d) => exists(path.join(d, bin)));
}

/**
 * **同一机器、同一引擎的安装只跑一次，进度广播给所有在等的会话**（index.ts `acp:install-adapter`）。
 *
 * 第二条会话点「安装」时不另起一次，而是订阅已经在跑的那个 job：先补发已经出来的输出（不然它只看到「安装中」），
 * 之后的输出和第一条会话一样实时收到；结果（成功 / 失败原因）每个等待者都拿到同一份，各自写会话、各自重连。
 * 装完（不管成败）job 就删掉，下次再点重新装。
 */
export function createSharedInstalls<R = InstallResult>(opts: { replayMax?: number } = {}) {
  const replayMax = opts.replayMax ?? 6000;
  const jobs = new Map<string, { promise: Promise<R>; subscribers: Set<(chunk: string) => void>; output: string }>();
  return {
    has(key: string): boolean { return jobs.has(key); },
    /** 订阅 `key` 那个安装；还没有就用 `start` 起一个（`start` 拿到的 `broadcast` 把输出发给所有订阅者）。 */
    join(key: string, onOutput: (chunk: string) => void, start: (broadcast: (chunk: string) => void) => Promise<R>): { promise: Promise<R>; joined: boolean } {
      const safe = (chunk: string) => { try { onOutput(chunk); } catch { /* 那个窗口没了不影响别的 */ } };
      const existing = jobs.get(key);
      if (existing) {
        if (existing.output) safe(existing.output);
        existing.subscribers.add(safe);
        return { promise: existing.promise, joined: true };
      }
      const job = { promise: undefined as unknown as Promise<R>, subscribers: new Set([safe]), output: '' };
      const broadcast = (chunk: string) => {
        if (!chunk) return;
        job.output = (job.output + chunk).slice(-replayMax);
        for (const fn of [...job.subscribers]) fn(chunk);
      };
      jobs.set(key, job);
      let p: Promise<R>;
      try { p = Promise.resolve(start(broadcast)); } catch (err: any) { p = Promise.reject(err); }
      job.promise = p.finally(() => { if (jobs.get(key) === job) jobs.delete(key); });
      return { promise: job.promise, joined: false };
    },
  };
}
