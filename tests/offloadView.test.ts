import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  placeholderRows, offloadTooltip, offloadSummary, offloadFailureKind, offloadFailureText, idleDays, sizeLabel,
} from '../src/renderer/offloadView.ts';

/* 侧栏 ☁ 占位的展示逻辑：已移到云端的会话照常出现在原来的项目分组里，悬停说明多少天没用、点开会下载。 */

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-30T00:00:00Z');
const row = (id: string, over = {}) => ({ id, title: `t-${id}`, project: 'P', engine: 'claude', lastActiveAt: NOW - 40 * DAY, offloadedAt: NOW - DAY, bytes: 1536 * 1024 * 1024, ...over });

describe('placeholderRows', () => {
  test('占位 → 侧栏行：带项目 / 引擎 / 机器，挂 offloaded；本机已有的不画', () => {
    const out = placeholderRows([row('a', { remoteHost: 'devbox' }), row('b')], [{ id: 'b' }], new Set(['a']));
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'a');
    assert.equal(out[0].projectId, 'P');
    assert.equal(out[0].engine, 'claude');
    assert.equal(out[0].remoteHost, 'devbox');
    assert.equal(out[0].offloaded.restoring, true);
    assert.equal(out[0].timestamp, NOW - 40 * DAY);
  });
  test('没项目的进未分组（projectId 不带）；未知引擎不带', () => {
    const [r] = placeholderRows([row('a', { project: undefined, engine: 'weird' })], []);
    assert.equal('projectId' in r, false);
    assert.equal('engine' in r, false);
    assert.deepEqual(placeholderRows(null, []), []);
  });
});

describe('提示文字', () => {
  test('悬停：已移到云端（X 天未使用），点开会自动下载；下载中另一句', () => {
    const m = { lastActiveAt: NOW - 40 * DAY, offloadedAt: NOW - DAY, bytes: 1 };
    assert.equal(offloadTooltip(m, NOW, 'zh'), '已移到云端（40 天未使用），点开会自动下载');
    assert.match(offloadTooltip(m, NOW, 'en'), /unused for 40 days/);
    assert.match(offloadTooltip({ ...m, restoring: true }, NOW, 'zh'), /下载/);
    assert.equal(idleDays(NOW, NOW), 1);
  });
  test('汇总：已把 N 条 30 天未使用的会话移到云端，腾出 X GB', () => {
    assert.equal(offloadSummary(12, 2.5 * 1024 ** 3, 30, 'zh'), '已把 12 条 30 天未使用的会话移到云端，腾出 2.5 GB');
    assert.equal(sizeLabel(5 * 1024 ** 2), '5 MB');
  });
});

describe('下载失败的原因：网络 / 凭证 / 云端已没有', () => {
  test('分类', () => {
    assert.equal(offloadFailureKind({ gone: true, error: 'x' }), 'gone');
    assert.equal(offloadFailureKind({ error: 'getaddrinfo ENOTFOUND s3.amazonaws.com' }), 'network');
    assert.equal(offloadFailureKind({ error: 'List x failed (403 SignatureDoesNotMatch)' }), 'credentials');
    assert.equal(offloadFailureKind({ error: 'S3 backup is not fully set up: missing bucket' }), 'credentials');
    assert.equal(offloadFailureKind({ error: 'This session is in the middle of a turn.' }), 'busy');
    assert.equal(offloadFailureKind({ error: '???' }), 'other');
    assert.equal(offloadFailureKind(null), 'other');
  });
  test('给人看的那句说明占位保留、什么都没删', () => {
    const s = offloadFailureText('周报', { error: 'connect ETIMEDOUT' }, 'zh');
    assert.match(s, /周报/);
    assert.match(s, /网络/);
    assert.match(s, /占位保留/);
  });
});
