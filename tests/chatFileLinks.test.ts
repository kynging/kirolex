import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/* 「为啥这两个会话里的文件链接打不开」：相对路径按家目录解析、远程会话一律"存在"、不存在的仍挂着链接样式 */
describe('会话里的文件链接按这条会话自己的目录解析', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const C = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/ChatArea.tsx'), 'utf8');
  const A = fs.readFileSync(path.join(process.cwd(), 'src/renderer/App.tsx'), 'utf8');

  test('主进程：files/ → 会话目录 → 项目工作目录 → 家目录，取第一个存在的；三个入口同一套', () => {
    assert.match(M, /bases\.push\(path\.join\(sessionsBaseDir, sessionId, SESSION_FILES_DIR\), path\.join\(sessionsBaseDir, sessionId\)\);/);
    assert.match(M, /return candidates\.find\(\(c\) => fs\.existsSync\(c\)\) \|\| candidates\[0\];/);
    assert.match(M, /if \(fs\.existsSync\(resolveUserPath\(filePath, sessionId\)\)\) return true;/);
    assert.match(M, /const p = resolveUserPath\(target, sessionId\);\n\s+const err = await shell\.openPath\(p\);/);
    assert.doesNotMatch(M, /if \(entry\?\.profile\.remote\?\.sshHost\) return true;/, '远程会话不再一律"存在"');
  });

  test('渲染层：查存在、打开都带消息所在那条会话的 id（分屏时不一定是当前会话）', () => {
    assert.match(C, /const PathSessionContext = React\.createContext<string>\(''\);/);
    assert.match(C, /<PathSessionContext\.Provider value=\{currentSessionId \|\| ''\}>/);
    assert.match(C, /window\.kiroApi\.pathExists\?\.\(path, sessionId \|\| undefined\)/);
    assert.ok((C.match(/openPathInApp\(path, sessionId\)/g) || []).length >= 3);
    assert.match(A, /void openFileInApp\(path, typeof sid === 'string' && sid \? sid : undefined\);/);
    assert.match(A, /await window\.kiroApi\.workspaceRead\(sessionForPath, p\);/);
  });

  test('不存在的路径不挂链接样式', () => {
    assert.match(C, /<code className=\{className === 'md-file-link' \? undefined : className\}>\{children\}<\/code>/);
  });
});

describe('远程会话在它自己那台机器上写的文件', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  test('本机没有、像是远端路径 → 用 ssh 读（读成就登记，写回见 reviewAccess.test.ts）；Mac 的 /Users/ 路径不认', () => {
    assert.match(M, /if \(p\.startsWith\('\/'\)\) return p\.startsWith\('\/Users\/'\) \? null : \{ target, path: p \};/);
    assert.match(M, /const remote = remoteFileFor\(sessionId, rawPath\);\n\s+if \(remote\) \{\n\s+const out = await readRemoteFile\(remote\.target, remote\.path\);/);
    assert.match(M, /const base = \{ path: remotePath, remote: true, remoteHost: host \};/);
    /* 显示成链接时不为每个链接开 ssh */
    assert.match(M, /return !!remoteFileFor\(sessionId, filePath\);/);
  });
});

describe('侧栏跟着「字号」设置走', () => {
  const CSS = fs.readFileSync(path.join(process.cwd(), 'src/renderer/styles/global.css'), 'utf8');
  test('预览正文、代码视图、审阅正文都用 --chat-font-size', () => {
    assert.match(CSS, /\.workspace-viewer-md \{\n  padding: 4px 2px 24px;\n  font-size: var\(--chat-font-size, 13px\);/);
    assert.match(CSS, /font-size: calc\(var\(--chat-font-size, 13px\) - 1px\);/);
    assert.match(CSS, /\.rv-review-md \{ font-size: var\(--chat-font-size, 12px\);/);
  });
});

describe('杂项', () => {
  test('dev:hot 重启时等 9222 真的放开再起（固定 1.5 秒不够）', () => {
    const S = fs.readFileSync(path.join(process.cwd(), 'scripts/dev-hot.mjs'), 'utf8');
    assert.match(S, /void waitPortFree\(CDP_PORT, 15_000\)\.then\(\(free\) => \{/);
  });
  test('同一个文件只开一个标签：按当初点的路径也比，读 ref 里最新的标签表', () => {
    const A = fs.readFileSync(path.join(process.cwd(), 'src/renderer/App.tsx'), 'utf8');
    assert.match(A, /const existing = fileTabsRef\.current\.find\(\(t\) => t\.path === p \|\| t\.requestedPath === p\);/);
    assert.match(A, /\{ id, path: p, requestedPath: p, content: '', ownerSessionId: sessionForPath \|\| undefined \}/);
  });
});
