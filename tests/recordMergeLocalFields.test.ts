import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mergeRecords } from '../src/main/transcriptMerge.ts';

/*
 * 「同步功能不要同步这个会话是在哪里跑的，以及用的什么 agent」（2026-11-17）：
 * mergeRecords 原来除了位置 / createdAt / 数组 / cliSessionId 之外整份按 updatedAt 新的赢 —— 另一台后聊一句，
 * 它的运行位置（profile.remote，带着那台电脑上的私钥路径）、agent（profile.kiroAgent）、本机目录（localDir）就盖到本机。
 * 这几项是每台电脑自己的设置：合并一律保留本机的；引擎 / 模型 / 权限模式这些照旧按 updatedAt。测试数据全是造的。
 */

const remoteA = { id: 'tokyo-arm', label: 'tokyo', sshHost: 'ec2-user@10.0.0.1', identityFile: '/Users/me/.ssh/a.pem', bins: { kiro: '/opt/kiro' } };
const remoteB = { id: 'win-box', label: 'win', sshHost: 'admin@10.0.0.2', identityFile: 'C:\\Users\\other\\.ssh\\b.pem' };

describe('mergeRecords：运行位置 / agent / 本机目录保留本机的', () => {
  test('对方 updatedAt 更新：remote / kiroAgent / localDir 都还是本机的；标题、模型照旧取对方的', () => {
    const local = {
      id: 's_1', updatedAt: 1000, title: '本机标题', localDir: '/Users/me/proj',
      profile: { model: 'claude-sonnet', remote: remoteA, kiroAgent: 'aws-agent', permissionMode: 'auto-approve' },
    };
    const theirs = {
      id: 's_1', updatedAt: 9000, title: '对方改的标题', localDir: 'C:\\Users\\other\\proj',
      profile: { model: 'claude-opus', remote: remoteB, kiroAgent: 'other-agent', permissionMode: 'ask' },
    };
    const m = mergeRecords(local, theirs);
    assert.deepEqual(m.profile.remote, remoteA);
    assert.equal(m.profile.kiroAgent, 'aws-agent');
    assert.equal(m.localDir, '/Users/me/proj');
    assert.equal(m.title, '对方改的标题', '标题照旧按 updatedAt');
    assert.equal(m.profile.model, 'claude-opus', '模型照旧按 updatedAt');
    assert.equal(m.profile.permissionMode, 'ask', '权限模式照旧按 updatedAt');
    /* 不改入参 */
    assert.deepEqual(local.profile.remote, remoteA);
    assert.deepEqual(theirs.profile.remote, remoteB);
  });

  test('本机 remote 为空（本机跑），对方是远程机器 → 合并后仍为空；本机没有 agent / localDir 也不从对方拷', () => {
    const local = { id: 's_1', updatedAt: 1000, title: 't', profile: { model: 'm' } };
    const theirs = { id: 's_1', updatedAt: 9000, title: 't2', localDir: 'C:\\x', profile: { model: 'm2', remote: remoteB, kiroAgent: 'y' } };
    const m = mergeRecords(local, theirs);
    assert.equal('remote' in m.profile, false);
    assert.equal('kiroAgent' in m.profile, false);
    assert.equal('localDir' in m, false);
    assert.equal(m.profile.model, 'm2');
  });

  test('本机更新时也一样：对方有、本机没有的这几项不从对方补进来', () => {
    const local = { id: 's_1', updatedAt: 9000, profile: { model: 'm' } };
    const theirs = { id: 's_1', updatedAt: 1000, localDir: '/Users/x', contextEstablishedFor: 'cli-b', contextEstablishedPid: 42, lastExecutorError: 'boom', profile: { model: 'm', remote: remoteB } };
    const m = mergeRecords(local, theirs);
    for (const k of ['localDir', 'contextEstablishedFor', 'contextEstablishedPid', 'lastExecutorError']) assert.equal(k in m, false, k);
    assert.equal('remote' in m.profile, false);
  });

  test('后端进程的记账（contextEstablishedFor / Pid、lastExecutorError）保留本机的，和 cliSessionId 一起', () => {
    const local = { id: 's_1', updatedAt: 1000, cliSessionId: 'cli-a', contextEstablishedFor: 'cli-a', contextEstablishedPid: 7, profile: {} };
    const theirs = { id: 's_1', updatedAt: 9000, cliSessionId: 'cli-b', contextEstablishedFor: 'cli-b', contextEstablishedPid: 99, lastExecutorError: 'x', profile: {} };
    const m = mergeRecords(local, theirs);
    assert.deepEqual([m.cliSessionId, m.contextEstablishedFor, m.contextEstablishedPid, 'lastExecutorError' in m], ['cli-a', 'cli-a', 7, false]);
  });

  test('项目 / 归档 / 同步开关的规则不受影响', () => {
    const local = { id: 's_1', updatedAt: 1000, placementChangedAt: 5, archived: false, profile: { projectId: 'A', remote: remoteA } };
    const theirs = { id: 's_1', updatedAt: 9000, placementChangedAt: 8, archived: true, crossDevice: true, crossDeviceChangedAt: 3, profile: { projectId: 'B', remote: remoteB } };
    const m = mergeRecords(local, theirs);
    assert.equal(m.profile.projectId, 'B');
    assert.equal(m.archived, true);
    assert.equal(m.crossDevice, true);
    assert.deepEqual(m.profile.remote, remoteA);
  });
});
