/**
 * 「怎么还能转 PDF 失败」—— 同一份文件被**同时**转了两次，LibreOffice 是单实例的，一个白跑。
 *
 * ## 实测
 *
 * 日志里两条紧挨着：
 *
 *   06:15:36.166  WARN  转 PDF 失败：Command failed: … soffice --headless --convert-to pdf …
 *   06:15:36.318  INFO  converted … key=a0e4c3ccdb4accba
 *
 * 相差 152 毫秒，一失败一成功 —— 典型的两个请求并发。命令行复现得很干净：第二个 `soffice` 实例
 * **一个字都不输出、也不产出 PDF**，直接退出（它把活儿交给已经在跑的那个进程就算完事）。
 *
 * 两个请求从哪来：dev 下 React StrictMode 会把 effect 跑两遍，加上"读不到就带 force 重转一次"那条
 * 退路，同一份 deck 很容易在同一瞬间被要两次。
 *
 * ## 两件事分开修
 *
 *   · **同一个 key 只转一次**（这里）—— 第二个请求**等**第一个的结果，而不是再起一个进程。
 *     顺带省掉一次 7～9 秒的转换。
 *   · **独立的 user profile**（调用方传 `-env:UserInstallation`）—— 就算真有两个不同的文件同时转，
 *     或者你自己正开着 LibreOffice，也不会互相踢。实测两个独立 profile 并发跑，两份 PDF 都出来了、
 *     字体也没退化。
 *
 * 只做前者不够：两个**不同**的 deck 同时点开仍然会撞。只做后者也不够：同一份文件转两遍是纯浪费。
 */

/** 同一个 key 正在跑的那次转换。跑完（成功或失败）就移除 —— 失败不该被缓存成"这个文件转不了"。 */
export class ConvertOnce<T> {
  private inflight = new Map<string, Promise<T>>();

  /** 这一刻有几个在跑（给日志/测试看）。 */
  get size(): number { return this.inflight.size; }

  /**
   * `key` 没在跑就跑 `run()`，在跑就**等它**。
   *
   * 返回的是同一个 promise，所以两个调用方拿到完全一样的结果 —— 包括失败：一次失败让两边都失败，
   * 比"一边成功一边报转换失败"要好，后者正是这次的症状。
   */
  async run(key: string, run: () => Promise<T>): Promise<T> {
    const running = this.inflight.get(key);
    if (running) return running;
    const p = (async () => run())();
    this.inflight.set(key, p);
    try {
      return await p;
    } finally {
      /* 无论成败都清掉：留着失败的那次会把一次瞬时失败变成永久的"这个文件转不了" */
      this.inflight.delete(key);
    }
  }
}

/**
 * 我们自己那份 LibreOffice user profile 的目录名。
 *
 * 不用 LO 默认那份（`~/Library/Application Support/LibreOffice/4`）：那是**用户自己的** ——
 * 他开着 LibreOffice 的时候我们的 headless 转换会和它抢同一份 profile，而症状就是这次那个
 * "转失败但另一个成功了"。放在 `~/.kirolex` 下面，跟其它缓存待在一起。
 */
export const LO_PROFILE_DIR = 'loffice-profile';

/**
 * `-env:UserInstallation` 要的那个值 —— 必须是 **file:// URL**，不是路径。
 *
 * 给路径的话 LO 不报错，只是当没设，于是又回到抢默认 profile 那条老路上 —— 又一个"不报错的错"。
 */
export function userInstallationArg(dir: string): string {
  /*
    **Windows 路径也要拼成合法的 file URL** —— `C:\Users\me\.kirolex\loffice-profile` 直接接在
    `file://` 后面是 `file://C:\Users\…`：LO 把 `C:` 当主机名，又是"不报错、当没设"。
    所以反斜杠换成 `/`、盘符前面补一个 `/`（`file:///C:/Users/…`），空格这类字符按 URL 编码 ——
    `C:\Users\张 三` 这种带空格/中文的用户目录在 Windows 上并不少见。
  */
  let clean = String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[A-Za-z]:\//.test(clean)) clean = `/${clean}`;
  const encoded = clean.split('/').map((seg, i) => (i === 1 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg))).join('/');
  return `-env:UserInstallation=file://${encoded}`;
}
