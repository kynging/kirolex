import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WinJobHost } from '../src/main/winJob.ts';

/**
 * Windows 作业对象（真起 PowerShell 辅助进程）。守的是：放进作业的进程**和它之后起的子孙**都由
 * TerminateJobObject 一起结束；辅助进程没了（= KiroLex 退出 / 崩溃）作业里的也都结束（KILL_ON_JOB_CLOSE）；
 * 作业外的进程不受影响。
 */

const win = process.platform === 'win32';
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(cond: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) assert.fail(`等不到：${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 起一个进程，**收到 go 之后**再起一个脱离的孙进程（写下 pid），然后两个都一直活着（go 之前放进作业，同闸门）。 */
function parentWithDetachedChild(): { pid: number; childPidFile: string; go: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-job-'));
  const childPidFile = path.join(dir, 'child');
  const inner = "require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)";
  const outer = `process.stdin.once('data',()=>{require('child_process').spawn(process.execPath,['-e',${JSON.stringify(inner)},process.argv[1]],{stdio:'ignore',detached:true}).unref()});setInterval(()=>{},1000)`;
  const p = spawn(process.execPath, ['-e', outer, childPidFile], { stdio: ['pipe', 'ignore', 'ignore'] });
  return { pid: p.pid!, childPidFile, go: () => { p.stdin!.write('go\n'); } };
}

describe('WinJobHost', { skip: !win }, () => {
  test('放进作业之后起的孙进程也在作业里：terminate 一起结束；作业外的不受影响', async () => {
    const h = new WinJobHost();
    const bystander = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    try {
      /* 和闸门同一个形状：父进程先放进作业，**收到 go 之后**才起子进程（一个脱离的 node，再起一个 cmd `start /b` 的）——
         放进作业之前就起的子进程本来就不在作业里，那正是闸门要避免的 */
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-job-'));
      const childPidFile = path.join(dir, 'child');
      const inner = "require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)";
      const outer = `process.stdin.once('data',()=>{require('child_process').spawn(process.execPath,['-e',${JSON.stringify(inner)},process.argv[1]],{stdio:'ignore',detached:true}).unref()});setInterval(()=>{},1000)`;
      const parent = spawn(process.execPath, ['-e', outer, childPidFile], { stdio: ['pipe', 'ignore', 'ignore'] });
      assert.equal(await h.assign('t1', parent.pid!), true);
      parent.stdin!.write('go\n');
      await waitFor(() => fs.existsSync(childPidFile) && fs.readFileSync(childPidFile, 'utf8') !== '', '孙进程起来了');
      const grandchild = Number(fs.readFileSync(childPidFile, 'utf8'));
      await h.terminate('t1');
      await waitFor(() => !alive(parent.pid!) && !alive(grandchild), '父进程和孙进程都结束');
      assert.ok(alive(bystander.pid!), '作业外的进程不该被碰');
    } finally {
      bystander.kill();
      h.killAllSync();
    }
  });

  test('辅助进程没了（KiroLex 退出 / 崩溃）：作业里的进程由系统结束', async () => {
    const h = new WinJobHost();
    const { pid, childPidFile, go } = parentWithDetachedChild();
    assert.equal(await h.assign('t2', pid), true);
    go();
    await waitFor(() => fs.existsSync(childPidFile) && fs.readFileSync(childPidFile, 'utf8') !== '', '孙进程起来了');
    const grandchild = Number(fs.readFileSync(childPidFile, 'utf8'));
    h.killAllSync();
    await waitFor(() => !alive(pid) && !alive(grandchild), '作业句柄关闭后父进程和孙进程都被结束');
  });

  test('pid 对上了但不是我们起的那个（父进程不是 KiroLex，比如 pid 被别的程序复用）：拒绝放进作业，也不会结束它', async () => {
    const h = new WinJobHost();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-job-'));
    const pidFile = path.join(dir, 'pid');
    const leaf = "require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)";
    /* 孙进程：父进程是 cmd.exe，不是这个测试进程 —— 和「pid 被一个无关程序复用」在辅助进程眼里是同一回事 */
    spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"start /b "" "${process.execPath}" -e "${leaf}" "${pidFile}""`], { stdio: 'ignore', windowsVerbatimArguments: true, windowsHide: true });
    await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8') !== '', '孙进程写下 pid');
    const stranger = Number(fs.readFileSync(pidFile, 'utf8'));
    try {
      assert.equal(await h.assign('t5', stranger), false, '不是我们的子进程，不能放进作业');
      await h.terminate('t5');
      await new Promise((r) => setTimeout(r, 500));
      assert.ok(alive(stranger), '没放进作业的进程不该被结束');
    } finally {
      try { process.kill(stranger); } catch {}
      h.killAllSync();
    }
  });

  test('非法参数 / 不存在的进程：放不进去（返回 false），调用方据此退回「只结束自己握着的那个」', async () => {
    const h = new WinJobHost();
    try {
      assert.equal(await h.assign('bad id', 123), false);
      assert.equal(await h.assign('t3', 0), false);
      assert.equal(await h.assign('t4', 4_000_000_000 % 2 ** 31), false);
    } finally {
      h.killAllSync();
    }
  });

  test('辅助进程复用：连续放 3 个进程只起一次辅助进程；它挂了下一次自动重起', async () => {
    const h = new WinJobHost(() => {}, 60_000, fs.mkdtempSync(path.join(os.tmpdir(), 'kx-jobcache-')));
    const kids = [1, 2, 3].map(() => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }));
    try {
      for (const [i, k] of kids.entries()) assert.equal(await h.assign(`r${i}`, k.pid!), true);
      assert.equal(h.starts, 1, '第 2、3 个不该再起辅助进程');
      /* 模拟它挂了：作业句柄随之关闭，作业里的进程由系统结束 */
      process.kill(h.helperPid!);
      await waitFor(() => kids.every((k) => !alive(k.pid!)), '辅助进程没了，作业里的进程都结束');
      const again = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
      try {
        assert.equal(await h.assign('r4', again.pid!), true, '下一次自动重起辅助进程');
        assert.equal(h.starts, 2);
        await h.terminate('r4');
        await waitFor(() => !alive(again.pid!), '重起后的作业照样能结束');
      } finally {
        try { again.kill(); } catch {}
      }
    } finally {
      for (const k of kids) { try { k.kill(); } catch {} }
      h.killAllSync();
    }
  });

  test('编译结果缓存成 dll（按源码哈希命名）：下一个辅助进程直接加载，不再编译', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-jobcache-'));
    const a = new WinJobHost(() => {}, 60_000, dir);
    const b = new WinJobHost(() => {}, 60_000, dir);
    const k = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    try {
      a.warm();
      assert.equal(a.starts, 1, 'warm 就把辅助进程起起来');
      assert.equal(await a.assign('c1', k.pid!), true);
      assert.equal(a.starts, 1);
      assert.equal(a.loadedFrom, 'compiled');
      const dlls = fs.readdirSync(dir).filter((f) => /^winjob-[0-9a-f]{16}\.dll$/.test(f));
      assert.equal(dlls.length, 1, `缓存目录里该有一个 dll：${fs.readdirSync(dir).join(', ')}`);
      assert.equal(await b.assign('c2', process.pid), false, '自己不是自己的子进程：拒绝（但辅助进程起来了）');
      assert.equal(b.loadedFrom, 'dll', '第二个辅助进程直接加载缓存的 dll');
      await a.terminate('c1');
      await waitFor(() => !alive(k.pid!), '加载 dll 的作业照样能结束');
    } finally {
      try { k.kill(); } catch {}
      a.killAllSync();
      b.killAllSync();
    }
  });

  test('缓存的 dll 坏了：退回当场编译，照常能用', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-jobcache-'));
    const a = new WinJobHost(() => {}, 60_000, dir);
    assert.equal(await a.assign('d1', process.pid), false);
    a.killAllSync();
    const dll = fs.readdirSync(dir).find((f) => f.endsWith('.dll'));
    assert.ok(dll, '第一次编译后留下了 dll');
    await waitFor(() => { try { fs.writeFileSync(path.join(dir, dll), 'not a dll'); return true; } catch { return false; } }, '辅助进程退出、dll 不再被占用');
    const b = new WinJobHost(() => {}, 60_000, dir);
    const k = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    try {
      assert.equal(await b.assign('d2', k.pid!), true);
      assert.equal(b.loadedFrom, 'compiled');
      await b.terminate('d2');
      await waitFor(() => !alive(k.pid!), '作业结束');
    } finally {
      try { k.kill(); } catch {}
      b.killAllSync();
    }
  });
});
