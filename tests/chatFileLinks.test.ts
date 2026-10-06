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
    assert.match(M, /return fs\.existsSync\(resolveUserPath\(filePath, sessionId\)\);/);
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
