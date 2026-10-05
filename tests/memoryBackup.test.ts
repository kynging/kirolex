import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planUpload, memoryRelsFor, mergeMemoryText } from '../src/main/s3Sync.ts';

/** 「会话和 project 备份时把 project 和 session 的记忆也备份进去，恢复也增加这些，就默认自带」 */
function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kxmem-'));
  const put = (rel: string, body = 'x'): void => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  put('sessions/s_in/record.json', '{}');
  put('sessions/s_out/record.json', '{}');
  put('memory/global.md');
  put('memory/projects/Keep/memory.md');
  put('memory/projects/Dev/memory.md');
  put('memory/sessions/s_in/memory.md');
  put('memory/sessions/s_out/memory.md');
  put('memory/sessions/s_gone/memory.md');
  return root;
}

describe('备份：记忆跟着会话 / 项目走', () => {
  test('只传全局 + 要备份的项目 + 要备份的会话那几份', () => {
    const root = fixture();
    const { upload } = planUpload(root, ['s_in'], {}, { projects: ['Keep'] });
    const mem = upload.filter((r) => r.startsWith('memory')).sort();
    assert.deepEqual(mem, [
      path.join('memory', 'global.md'),
      path.join('memory', 'projects', 'Keep', 'memory.md'),
      path.join('memory', 'sessions', 's_in', 'memory.md'),
    ].sort());
    assert.ok(upload.includes(path.join('sessions', 's_in', 'record.json')));
  });

  test('id 里带路径分隔符的不认（不能借它跳出目录）', () => {
    const root = fixture();
    assert.deepEqual(memoryRelsFor(root, ['../x', 's_in'], ['..', 'a/b']).sort(), [
      path.join('memory', 'global.md'),
      path.join('memory', 'sessions', 's_in', 'memory.md'),
    ].sort());
  });

  test('接线：同步按"不同步的项目"筛记忆', () => {
    const M = fs.readFileSync('src/main/index.ts', 'utf8');
    assert.match(M, /planUpload\(KIROLEX_HOME, ids, state, \{ projects: memoryProjects \}\)/);
    assert.match(M, /\.filter\(\(p\) => !projectExcluded\(cfg, p\)\)/);
  });
});

describe('恢复：记忆合并，不覆盖', () => {
  test('本地原样保留，备份里多的行按顺序补在后面；重复恢复不会越补越多', () => {
    const local = '# Chat-specific memory\n\n- 用 pnpm\n- 本机后来教的\n';
    const backup = '# Chat-specific memory\n\n- 用 pnpm\n- 备份里的 A\n- 备份里的 B\n';
    const merged = mergeMemoryText(local, backup);
    assert.equal(merged, '# Chat-specific memory\n\n- 用 pnpm\n- 本机后来教的\n- 备份里的 A\n- 备份里的 B\n');
    assert.equal(mergeMemoryText(merged, backup), merged);
  });
  test('本地是空的就整份拿备份；备份没有新东西就原样返回', () => {
    assert.equal(mergeMemoryText('  \n', '- a\n'), '- a\n');
    assert.equal(mergeMemoryText('- a\r\n', '- a\n'), '- a\r\n');
  });
  test('接线：会话 / 项目 / 全局三份都拉，合并前先进 trash', () => {
    const M = fs.readFileSync('src/main/index.ts', 'utf8');
    const at = M.indexOf("ipcMain.handle('s3:restore'");
    const body = M.slice(at, at + 12000);
    assert.match(body, /path\.join\('memory', 'sessions', sessionId\)/);
    assert.match(body, /path\.join\('memory', 'projects', project\)/);
    assert.match(body, /path\.join\('memory', 'global\.md'\)/);
    assert.match(body, /mergeMemoryText\(local, body\.toString\('utf-8'\)\)/);
    assert.match(body, /fs\.copyFileSync\(abs, dest\);/);
  });
});

describe('会话自己的 files/ 跟着会话备份', () => {
  test('同步时整棵传；别的会话的不传', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kxfiles-'));
    const put = (rel: string): void => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), 'x'); };
    put('sessions/s_in/record.json');
    put('sessions/s_in/files/out.csv');
    put('sessions/s_in/files/sub/chart.png');
    put('sessions/s_out/files/secret.txt');
    const { upload } = planUpload(root, ['s_in'], {}, { projects: [] });
    assert.ok(upload.includes(path.join('sessions', 's_in', 'files', 'out.csv')));
    assert.ok(upload.includes(path.join('sessions', 's_in', 'files', 'sub', 'chart.png')));
    assert.equal(upload.some((r) => r.includes('s_out')), false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('恢复到另一台机器、路径变了', () => {
  test('合并两份记录时 files/ 用过的路径取并集', async () => {
    const { mergeRecords } = await import('../src/main/transcriptMerge.ts');
    const out = mergeRecords(
      { updatedAt: 2, filesDirs: ['/Users/me/.kirolex/sessions/s/files'] },
      { updatedAt: 1, filesDirs: ['C:\Users\me\.kirolex\sessions\s\files'] },
    );
    assert.deepEqual(out.filesDirs, ['/Users/me/.kirolex/sessions/s/files', 'C:\Users\me\.kirolex\sessions\s\files']);
  });
  test('远程说明里把旧路径指向新路径', async () => {
    const { remoteContextBlock } = await import('../src/main/remoteContext.ts');
    const t = remoteContextBlock({ hostLabel: 'tokyo', remoteDir: '/r', localDir: '/new/files', filesDir: '/new/files', hasLocalProject: false, movedFrom: ['C:\old\files'] });
    assert.match(t, /C:\old\files/);
    assert.match(t, /就是 `\/new\/files` 以前的路径/);
    assert.doesNotMatch(remoteContextBlock({ hostLabel: 'tokyo', remoteDir: '/r', localDir: '/n', filesDir: '/n', hasLocalProject: false }), /以前的路径/);
  });
  test('接线：本地每一轮的说明、远程说明都带上旧路径；没变过就什么都不说', () => {
    const M = fs.readFileSync('src/main/index.ts', 'utf8');
    assert.match(M, /movedFilesNote\(previousFilesDirs\(sessionId\)\),/);
    assert.match(M, /movedFrom: previousFilesDirs\(sessionId\),/);
    assert.match(M, /if \(!previous\.length\) return '';/);
  });
});
