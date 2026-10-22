/**
 * 会话信息 ——「会话能查看/复制 id」。纯逻辑，侧栏的「会话信息」面板只负责画。
 *
 * 会话 id（`s_<时间戳>_<6位>`）原来只在磁盘目录、日志和控制入口里看得到；排查时（日志按 `sessionId=`
 * 过滤、给看板提 bug、控制入口 `/sessions/:id/…`）得靠标题去猜是哪条。所以这里把排查要的几样**一次拿全**：
 * 会话 id、后端会话 id（cliSessionId）、运行位置、引擎、会话目录。
 */
export type Engine = 'kiro' | 'claude' | 'codex';

/** 主进程 `acp:session-info` 回来的东西。 */
export interface SessionInfo {
  id: string;
  /** 后端（kiro-cli / 适配器）自己的会话 id。还没连过后端时没有。 */
  cliSessionId?: string;
  engine?: Engine;
  /** 远端：给人看的名字 + 真正的 ssh 目标。本地为空。 */
  remote?: { label: string; sshHost: string } | null;
  /** `~/.kirolex/sessions/<id>`（本机）。 */
  dir?: string;
  /**
   * 远程会话这一回实际拿到的本机工具（主进程 `ensureLocalTools` 最近一次准备的结果）。本地会话为 null / 没有。
   * `forwarded` 不含 kirolex-local（它总在）；`skipped` 是组合 / 设置名单里没转发成的，带原因。
   */
  localTools?: { state: 'ready' | 'not-ready' | 'failed'; forwarded: string[]; skipped: Array<{ name: string; reason: string }> } | null;
}

export interface InfoRow {
  key: 'id' | 'cli' | 'where' | 'engine' | 'tools' | 'dir';
  label: string;
  /** 显示出来的字 */
  value: string;
  /** 点「复制」时进剪贴板的字；空串 = 没有可复制的（不要把一句说明文字复制出去） */
  copy: string;
  /** 能点开的本机路径 */
  open?: string;
}

const ENGINE_NAMES: Record<Engine, string> = { kiro: 'Kiro', claude: 'Claude Code', codex: 'Codex' };

type T = (key: string, vars?: Record<string, string | number>) => string;

export function sessionInfoRows(info: SessionInfo, t: T): InfoRow[] {
  const remote = info.remote && info.remote.sshHost ? info.remote : null;
  const where = remote
    ? (remote.label && remote.label !== remote.sshHost ? `${remote.label} (${remote.sshHost})` : remote.sshHost)
    : t('Local');
  const engine = info.engine || 'kiro';
  return [
    { key: 'id', label: t('Session id'), value: info.id, copy: info.id },
    {
      key: 'cli',
      label: t('Backend session id'),
      value: info.cliSessionId || t('None yet (assigned when the chat first connects)'),
      copy: info.cliSessionId || '',
    },
    { key: 'where', label: t('Runs on'), value: where, copy: remote ? remote.sshHost : 'local' },
    { key: 'engine', label: t('Engine'), value: ENGINE_NAMES[engine] || engine, copy: engine },
    ...(info.localTools ? [localToolsRow(info.localTools, t)] : []),
    { key: 'dir', label: t('Session folder'), value: info.dir || '', copy: info.dir || '', ...(info.dir ? { open: info.dir } : null) },
  ];
}

/**
 * 「本机工具」那一行 ——「会话里能看到这条会话实际拿到了哪些本机工具，缺了的说原因」。
 * 复制出来的只有名字（没准备好时没有可复制的）。
 */
function localToolsRow(lt: NonNullable<SessionInfo['localTools']>, t: T): InfoRow {
  const label = t('Local tools');
  if (lt.state !== 'ready') {
    return {
      key: 'tools', label, copy: '',
      value: lt.state === 'failed'
        ? t('The local tools connection is not up (it reconnects automatically)')
        : t('Not prepared yet (shown after the session connects)'),
    };
  }
  const names = ['kirolex-local', ...lt.forwarded];
  const skipped = lt.skipped.length
    ? t('; not forwarded: {list}', { list: lt.skipped.map((s) => `${s.name} (${s.reason})`).join(', ') })
    : '';
  return { key: 'tools', label, value: `${names.join(', ')}${skipped}`, copy: names.join(', ') };
}

/**
 * 「全部复制」：`key=value` 一行一项，**不翻译** —— 这段是贴进 bug / 拿去过滤日志的
 * （日志里写的就是 `sessionId=`），中英文界面复制出来应当一模一样。
 */
export function sessionInfoText(info: SessionInfo): string {
  const remote = info.remote && info.remote.sshHost ? info.remote : null;
  return [
    `sessionId=${info.id}`,
    `cliSessionId=${info.cliSessionId || ''}`,
    `where=${remote ? remote.sshHost : 'local'}`,
    `engine=${info.engine || 'kiro'}`,
    `dir=${info.dir || ''}`,
    ...(info.localTools?.state === 'ready' ? [`localTools=${['kirolex-local', ...info.localTools.forwarded].join(',')}`] : []),
  ].join('\n');
}
