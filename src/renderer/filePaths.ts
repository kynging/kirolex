/**
 * 「这段文字是不是一条文件路径」—— PURE，两条正则住在一起。
 *
 * 从 `ChatArea.tsx` 抽出来的，理由有两条：
 *   ① `.tsx` 跑不了 `node:test`（这个库的约定），所以待在组件里的正则**只能靠手抄一份到测试里**去测 ——
 *      而手抄的那份和代码分岔了不会有任何人发现。抽成 `.ts` 之后测试 import 的就是真货。
 *   ② 判据有两个消费者（行内代码、散文里的裸路径），现在又多了第三个（围栏里整行是路径的那几行）。
 *      三处各写一条正则，迟早出现"行内认得、围栏不认"这种说不清的差别。
 */

/**
 * **整段文字就是一条路径**（行内代码、围栏里的一整行用它）。
 *
 * 要求以扩展名结尾：`/update/delete` 那种句子里的斜杠不该被当成路径。中文路径是匹配的
 * （`[^\n\r\t<>|?*]+` 不限字符集）—— 实测 `…/devops-agent-rds-诊断配置指南.md` 通过。
 */
export const FILE_TOKEN_RE = /^(?:[A-Za-z]:\\[^\n\r\t<>|?*]+|~?\/[^\n\r\t<>|?*]+|[^\/\n\r\t<>|?*]+(?:\/[^\/\n\r\t<>|?*]+)+)\.[A-Za-z0-9]{1,8}$/u;

/**
 * **散文里的裸路径**（`remarkLinkifyPaths` 用它，全局匹配）。
 *
 * 比上面那条严：要么是 Windows 路径、要么在已知根目录下（`/Users`、`/tmp`…）、要么以扩展名结尾，
 * 而且后面得跟着空白/括号/引号/中英文标点或行尾 —— 收紧过一次，为的是别把 "/update/delete" 这种
 * 句子里的斜杠链接化。
 */
export const PATH_RE = /(?:[A-Za-z]:\\[^\s"'`)]+|\/(?:Users|home|tmp|var|etc|opt|usr|private|Applications|mnt|srv|root)\/[^\n\r\t<>|"'`]*?\.[A-Za-z0-9]{1,8}(?=[\s)"'`,，。；;：]|$)|(?:\/[\p{L}\p{N}._\-]+)+\.[A-Za-z0-9]{1,8})/gu;

/**
 * **markdown 链接的 href → 本机路径**（`MD_COMPONENTS.a` 交给 FileRef 之前用它）。
 *
 * mdast-util-to-hast 生成 href 时走 `normalizeUri`，会把非 ASCII（中文文件名）、空格、反斜杠等
 * 百分号编码 —— `…/files/阿里云….md` 变成 `…/files/%E9%98%BF….md`，存在检查就查不到了。
 * 所以非 URL 的 href 先 `decodeURI` 还原；编码畸形（`%E9%9`）解不开就用原值，不抛错。
 * 真实 URL（http/https/mailto/tel）原样返回，不解码。
 */
export function hrefToLocalPath(href: string): string {
  if (/^(https?:|mailto:|tel:)/i.test(href)) return href;
  try {
    return decodeURI(href);
  } catch {
    return href;
  }
}
