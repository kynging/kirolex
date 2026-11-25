/**
 * 回复里带中文文件名的路径点不了 —— 「阿里云AI能力」会话末尾的
 * `/Users/keyinan/.kirolex/sessions/…/files/阿里云产品AI能力集成研究.md` 显示成普通文字。
 *
 * 根因：`remarkLinkifyPaths` 产出的 link 节点 url 是原路径，但 mdast-util-to-hast 生成 href 时
 * 走 `normalizeUri`，把非 ASCII 字符百分号编码了；`MD_COMPONENTS.a` 把编码后的 href 交给 FileRef，
 * 存在检查查不到 → 退回普通文字。`hrefToLocalPath` 负责把 href 还原成本机路径。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUri } from 'micromark-util-sanitize-uri';
import { hrefToLocalPath } from '../src/renderer/filePaths.ts';

const roundTrip = (p: string) => hrefToLocalPath(normalizeUri(p));

test('中文文件名的绝对路径经 normalizeUri 后还原', () => {
  const p = '/Users/keyinan/.kirolex/sessions/s_1795593792807_uwz4w9/files/阿里云产品AI能力集成研究.md';
  assert.notEqual(normalizeUri(p), p); // 确认 normalizeUri 真的编码了
  assert.equal(roundTrip(p), p);
});

test('带空格的路径（%20）还原', () => {
  const p = '/Users/me/My Docs/report v2.md';
  assert.match(normalizeUri(p), /%20/);
  assert.equal(roundTrip(p), p);
  assert.equal(hrefToLocalPath('/Users/me/My%20Docs/report%20v2.md'), p);
});

test('Windows 路径 D:\资料\报告.md 还原', () => {
  const p = 'D:\资料\报告.md';
  assert.equal(roundTrip(p), p);
});

test('相对路径 files/中文.md 还原（用户自己写的 [x](相对/中文.md) 也是这条路）', () => {
  assert.equal(roundTrip('files/中文.md'), 'files/中文.md');
  assert.equal(roundTrip('相对/中文.md'), '相对/中文.md');
});

test('文件名里本来就有 % 也能还原', () => {
  assert.equal(roundTrip('/tmp/100%完成.md'), '/tmp/100%完成.md');
});

test('真实 URL 原样返回，不解码', () => {
  for (const u of [
    'https://example.com/a%20b?q=%E4%B8%AD',
    'http://example.com/%E9%98%BF',
    'mailto:a%40b.com',
    'tel:+86%20123',
  ]) assert.equal(hrefToLocalPath(u), u);
});

test('畸形编码不抛错，原样返回', () => {
  assert.doesNotThrow(() => hrefToLocalPath('/tmp/%E9%9.md'));
  assert.equal(hrefToLocalPath('/tmp/%E9%9.md'), '/tmp/%E9%9.md');
  assert.equal(hrefToLocalPath('/tmp/%E9%98.md'), '/tmp/%E9%98.md');
});
