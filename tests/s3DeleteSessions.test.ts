import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

/*
  「远程会话恢复中需要有一个删除按钮，现在这里面有好多 New Chat 之类没用的会话」。
  那些大多是本地早删了、桶里还留着的 —— 同步只往上传，从不删桶里的东西。
*/
const M = fs.readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
const UI = fs.readFileSync(new URL('../src/renderer/components/BackupDialog.tsx', import.meta.url), 'utf8');

test('按会话删：id 过白名单，只删桶里有的', () => {
  const at = M.indexOf("ipcMain.handle('s3:delete-sessions'");
  assert.ok(at > 0);
  const body = M.slice(at, at + 2400);
  assert.ok(body.includes('w.-]+$/.test(id)'), '会话 id 要过白名单（它被拼进对象 key）');
  assert.match(body, /inBucket\.has\(id\)/);
  /* 本地还在的要说出来：下次同步会再传 */
  assert.match(body, /willReturn/);
});

test('删项目和删会话共用一段：catalog 最后写、本地状态表一起清', () => {
  const at = M.indexOf('async function deleteBackupsOf(');
  const body = M.slice(at, M.indexOf('\n}\n', at));
  /* 删对象 + 写删除记录在 catalogStore.ts 的 deleteSessionBackups（写前重读最新的 catalog） */
  assert.match(body, /await deleteSessionBackups\(/);
  const CS = fs.readFileSync(new URL('../src/main/catalogStore.ts', import.meta.url), 'utf8');
  const d = CS.slice(CS.indexOf('export async function deleteSessionBackups('));
  assert.ok(d.indexOf('await bucket.del(') > 0 && d.indexOf('await bucket.del(') < d.indexOf('await updateCatalog('), 'catalog 必须在删完对象之后写');
  assert.match(body, /writeState\(S3_STATE_PATH, state\)/);
  assert.match(body, /writeSessionMarks\(S3_MARKS_PATH, marks\)/);
  /* 两个入口都走它，不是各抄一份 */
  assert.equal((M.match(/await deleteBackupsOf\(/g) || []).length, 2);
});

test('界面：两次点击确认，不用系统确认框', () => {
  const at = UI.indexOf('const removeBackups = async');
  const body = UI.slice(at, at + 400);
  assert.match(body, /if \(!armDelete\) \{ setArmDelete\(true\); return; \}/);
  assert.equal(/window\.confirm/.test(body), false);
  assert.match(UI, /t\('Confirm deleting \{n\} backups', \{ n: chosen\.length \}\)/);
});
