import assert from 'node:assert/strict';
import test from 'node:test';
import { preflightScript, parseModels, parseModelMeta, judgePreflight } from '../src/main/remotePreflight.ts';
import { setUiLang } from '../src/main/uiText.ts';
import { userInfo } from 'node:os';
test('模型列表走 --list-models 的 JSON —— 传错模型那招在 2.24+ 上会真跑一轮', () => {
  /*
    2.25.0 实测：`--model __kirolex_probe__` 不再在参数校验处报错，而是
      `[warn] failed to set model '__kirolex_probe__': Method not found`
    然后用默认模型答了一整轮。所以列表恒为空 + 每次白烧一次调用（gpt-5.6-sol 是 4.40x）。
    判据盯的是**命令形状**：新路必须在前，老路只能是兜底。
  */
  const s = preflightScript(undefined, { models: true });
  assert.match(s, /--list-models --format json/);
  const at = s.indexOf('--list-models');
  const fallbackAt = s.indexOf('__kirolex_probe__');
  assert.ok(at > 0 && fallbackAt > at, '兜底必须排在 --list-models 之后，否则每次都先烧一轮');
});

test('parseModels 认 JSON，取的是 model_id', () => {
  const json = JSON.stringify({
    models: [
      { model_name: 'auto', model_id: 'auto', rate_multiplier: 1.0, context_window_tokens: 1000000 },
      { model_name: 'claude-opus-5.5', model_id: 'claude-opus-5.5', rate_multiplier: 2.0, context_window_tokens: 1000000 },
    ],
    default_model: 'auto',
  });
  assert.deepEqual(parseModels(`KVER 2.25.0\nMODELSJSON ${json}`), ['auto', 'claude-opus-5.5']);
  const meta = parseModelMeta(`MODELSJSON ${json}`);
  assert.equal(meta['claude-opus-5.5'].rate, 2.0);
  assert.equal(meta['claude-opus-5.5'].context, 1000000);
});

test('JSON 坏了要退回老那条，而不是给个空列表', () => {
  assert.deepEqual(
    parseModels('MODELSJSON {not json\nAvailable models: auto, claude-opus-5'),
    ['auto', 'claude-opus-5'],
  );
  assert.deepEqual(parseModelMeta('MODELSJSON {not json'), {});
});

test('旧版（没有 --list-models）仍然能解析出列表', () => {
  assert.deepEqual(parseModels('Available models: auto, gpt-5.6-luna'), ['auto', 'gpt-5.6-luna']);
});

test('连不上时说出真正原因 —— 不要只剩 ssh 横幅那排 @@@@', () => {
  /*
    2026-10-14 实测：私钥继承了 CodexSandboxUsers 的权限，Windows ssh 打横幅后拒用密钥，
    界面上只显示 "连不上 …：@@@@@@"，看着像主机密钥变了。
  */
  setUiLang('zh');
  const banner = '@'.repeat(59);
  const remote = { sshHost: 'ec2-user@1.2.3.4', identityFile: 'C:\k\key.pem' } as any;
  const perm = [banner, '@         WARNING: UNPROTECTED PRIVATE KEY FILE!          @', banner,
    "Permissions for 'C:\k\key.pem' are too open.",
    'Load key "C:\k\key.pem": bad permissions',
    'ec2-user@1.2.3.4: Permission denied (publickey,gssapi-keyex,gssapi-with-mic).'].join('\r\n');
  const v = judgePreflight(255, '', perm, remote);
  assert.equal(v.code, 'unreachable');
  assert.match(v.message, /私钥文件权限太宽/);
  assert.doesNotMatch(v.message, /@@@/);
  assert.doesNotMatch(v.message, /远端不接受这把密钥/, '权限太宽时 ssh 也会顺带打 Permission denied，但真正原因是前者');
  if (process.platform === 'win32') {
    assert.ok(v.message.includes(`icacls "C:\k\key.pem" /inheritance:r /grant:r "${userInfo().username}:R"`), v.message);
  } else {
    assert.ok(v.message.includes('chmod 600 "C:\k\key.pem"'), v.message);
  }

  const changed = [banner, '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @', banner].join('\n');
  assert.match(judgePreflight(255, '', changed, remote).message, /主机密钥变了.*ssh-keygen -R 1\.2\.3\.4/);

  const denied = 'ec2-user@1.2.3.4: Permission denied (publickey,gssapi-keyex,gssapi-with-mic).';
  assert.match(judgePreflight(255, '', denied, remote).message, /远端不接受这把密钥.*用户名/);

  /* 认不出的原因：跳过横幅边框，取第一句真正的话 */
  const other = [banner, '@ something new @', banner, 'kex_exchange_identification: read: Connection reset'].join('\n');
  const o = judgePreflight(255, '', other, remote).message;
  assert.match(o, /Connection reset/);
  assert.match(o, /检查网络\/密钥\/安全组/);
});

test('连不上的人话也有英文版', () => {
  setUiLang('en');
  try {
    const remote = { sshHost: 'ec2-user@1.2.3.4' } as any;
    const m = judgePreflight(255, '', '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @', remote).message;
    assert.match(m, /^Cannot connect to ec2-user@1\.2\.3\.4: the remote host key has changed/);
    assert.match(m, /ssh-keygen -R 1\.2\.3\.4/);
    assert.doesNotMatch(m, /[\u4e00-\u9fff]/);
    const p = judgePreflight(255, '', 'Load key "k": bad permissions', remote).message;
    assert.match(p, /private key file permissions are too open/);
    assert.match(p, /<private key path>/);
    assert.doesNotMatch(p, /[\u4e00-\u9fff]/);
  } finally {
    setUiLang('zh');
  }
});
