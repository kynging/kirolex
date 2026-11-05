import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseRemoteTargets, listRemoteTargets, saveRemoteTarget } from '../src/main/remoteTargets.ts';
import { defaultPick, switchVia } from '../src/renderer/remotePick.ts';
import { ssmPreflight, type SsmRun } from '../src/main/remotePreflight.ts';
import { setSsmKeyRoot } from '../src/main/sshProxy.ts';

/* SSM 默认推临时公钥，预检会生成密钥 —— 放进临时目录，不碰真的 ~/.kirolex */
setSsmKeyRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'ssm-keys-')));

/*
 * 「SSM 机器设置：老 agents[].remote 冒出名称为 IP 的 SSH 幽灵机器且被默认选中」。
 *
 * tokyo-ec2 切到 SSM 后 sshHost 变成 `ec2-user@<实例ID>`，按 host:port 去重不再命中老形状那条，
 * 它就单独列了出来、名字退回 IP；所有条目又都没有 editedAt，defaultPick 选最后一条 —— 正好是它。
 */
const SSM_TOKYO = {
  id: 'tokyo', label: 'tokyo-ec2', sshHost: 'ec2-user@i-0123456789abcdef0', connectVia: 'ssm',
  ssmInstanceId: 'i-0123456789abcdef0', ssmRegion: 'ap-northeast-1', identityFile: '/keys/tokyo.pem', remoteWorkdir: '~/kirolex',
};
const LEGACY = { id: 'agent_1', name: '', remote: { enabled: false, sshHost: 'ec2-user@1.2.3.4', sshPort: 22 } };

function fixture(cfg: any): string {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ssm-legacy-')), 'config.json');
  fs.writeFileSync(f, JSON.stringify(cfg));
  return f;
}

describe('老形状 agents[].remote 和 SSM 机器', () => {
  test('没有 label 的老条目不再只叫一个 IP', () => {
    const f = fixture({ remotes: [SSM_TOKYO], agents: [LEGACY] });
    const list = listRemoteTargets(f);
    const old = list.find((t) => t.id === 'agent_1');
    assert.ok(old, '对不上任何一台 SSM 机器时照旧列出来');
    assert.notEqual(old!.label, '1.2.3.4');
    assert.match(old!.label, /旧配置|old config/);
    assert.equal(old!.legacy, true);
    assert.equal(list.find((t) => t.id === 'tokyo')!.legacy, undefined);
  });

  test('老条目有名字 / kind 时用它们加「(旧配置)」', () => {
    const [byName] = parseRemoteTargets({ agents: [{ id: 'a', name: 'kiro', remote: { sshHost: 'u@9.9.9.9' } }] });
    assert.match(byName.label, /^kiro \((旧配置|old config)\)$/);
    const [byKind] = parseRemoteTargets({ agents: [{ id: 'b', kind: 'kiro-cli', remote: { sshHost: 'u@9.9.9.9' } }] });
    assert.match(byKind.label, /^kiro-cli \((旧配置|old config)\)$/);
    const [own] = parseRemoteTargets({ agents: [{ id: 'c', name: 'kiro', remote: { sshHost: 'u@9.9.9.9', label: 'box' } }] });
    assert.equal(own.label, 'box', '自己写了 label 的照旧');
  });

  test('私钥 + 工作目录对得上某台 SSM 机器 → 不再单独列一台', () => {
    const list = parseRemoteTargets({
      remotes: [SSM_TOKYO],
      agents: [{ id: 'agent_1', remote: { sshHost: 'ec2-user@1.2.3.4', identityFile: '/keys/tokyo.pem', remoteWorkdir: '~/kirolex' } }],
    });
    assert.deepEqual(list.map((t) => t.id), ['tokyo']);
  });

  test('老条目的名字和 SSM 机器同名 → 也认成同一台', () => {
    const list = parseRemoteTargets({
      remotes: [SSM_TOKYO],
      agents: [{ id: 'agent_1', remote: { sshHost: 'ec2-user@1.2.3.4', label: 'tokyo-ec2' } }],
    });
    assert.deepEqual(list.map((t) => t.id), ['tokyo']);
  });

  test('只是私钥相同、工作目录不同 → 不算同一台（同一把密钥常给好几台机器用）', () => {
    const list = parseRemoteTargets({
      remotes: [SSM_TOKYO],
      agents: [{ id: 'agent_1', remote: { sshHost: 'ec2-user@1.2.3.4', identityFile: '/keys/tokyo.pem', remoteWorkdir: '/srv/other' } }],
    });
    assert.equal(list.length, 2);
  });

  test('SSH → SSM 的那次保存顺手删掉 sshHost 等于切换前地址的老 agents[].remote（同一次写）', () => {
    const f = fixture({
      remotes: [{ id: 'tokyo', label: 'tokyo-ec2', sshHost: 'ec2-user@1.2.3.4', identityFile: '/keys/tokyo.pem' }],
      agents: [{ ...LEGACY, kind: 'kiro', other: 'keep-me' }, { id: 'agent_2', remote: { sshHost: 'u@5.6.7.8' } }],
      features: { x: true },
    });
    /* 切换前两条地址相同 → 被去重，只看得到一台 */
    assert.deepEqual(listRemoteTargets(f).map((t) => t.id), ['tokyo', 'agent_2']);
    const saved = saveRemoteTarget(f, {
      id: 'tokyo', label: 'tokyo-ec2', sshHost: 'ec2-user@i-0123456789abcdef0',
      connectVia: 'ssm', ssmInstanceId: 'i-0123456789abcdef0', ssmRegion: 'ap-northeast-1',
    });
    assert.deepEqual(saved.droppedLegacy, ['agent_1']);
    const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.equal(cfg.agents[0].remote, undefined, '老条目被删掉');
    assert.equal(cfg.agents[0].other, 'keep-me', 'agent 本身的其它字段不动');
    assert.deepEqual(cfg.agents[1].remote, { sshHost: 'u@5.6.7.8' }, '别的地址的老条目不动');
    assert.deepEqual(cfg.features, { x: true });
    assert.deepEqual(listRemoteTargets(f).map((t) => t.id), ['tokyo', 'agent_2']);
    assert.equal(fs.readdirSync(path.dirname(f)).filter((n) => n.includes('.tmp-')).length, 0, '原子写不留临时文件');
  });

  test('验收：remotes[tokyo(ssm)] + agents[].remote(1.2.3.4) —— 走一次 SSH→SSM 保存后只剩新形状那台', () => {
    const f = fixture({ remotes: [{ id: 'tokyo', label: 'tokyo', sshHost: 'ec2-user@1.2.3.4' }], agents: [LEGACY] });
    saveRemoteTarget(f, {
      id: 'tokyo', sshHost: 'ec2-user@i-0123456789abcdef0',
      connectVia: 'ssm', ssmInstanceId: 'i-0123456789abcdef0', ssmRegion: 'ap-northeast-1',
    });
    assert.deepEqual(listRemoteTargets(f).map((t) => t.id), ['tokyo']);
  });

  test('本来就是 SSM 的再存一次 / 普通 SSH 保存：不动老配置', () => {
    const f = fixture({ remotes: [SSM_TOKYO], agents: [{ id: 'agent_1', remote: { sshHost: 'ec2-user@i-0123456789abcdef0' } }] });
    const a = saveRemoteTarget(f, { ...SSM_TOKYO, connectVia: 'ssm', label: 'renamed' });
    assert.equal(a.droppedLegacy, undefined);
    const g = fixture({ remotes: [{ id: 'x', sshHost: 'u@1.2.3.4' }], agents: [{ id: 'agent_1', remote: { sshHost: 'u@1.2.3.4' } }] });
    saveRemoteTarget(g, { id: 'x', sshHost: 'u@1.2.3.4', sshPort: 2222 });
    assert.deepEqual(JSON.parse(fs.readFileSync(g, 'utf8')).agents[0].remote, { sshHost: 'u@1.2.3.4' });
    assert.ok(JSON.parse(fs.readFileSync(f, 'utf8')).agents[0].remote);
  });
});

describe('defaultPick', () => {
  test('都没有 editedAt 时选新形状里的第一台，不选老形状条目', () => {
    assert.equal(defaultPick([{ id: 'tokyo' }, { id: 'graviton' }, { id: 'agent_1', legacy: true }]), 'tokyo');
    assert.equal(defaultPick([{ id: 'agent_1', legacy: true }, { id: 'tokyo' }]), 'tokyo');
    assert.equal(defaultPick([{ id: 'agent_1', legacy: true }]), 'agent_1', '只有老条目时也得选一台');
  });
  test('有 editedAt 时照旧选最近编辑的那台', () => {
    assert.equal(defaultPick([{ id: 'a', editedAt: 5 }, { id: 'b', editedAt: 9 }, { id: 'old', legacy: true }]), 'b');
  });
});

describe('切换连接方式不丢值', () => {
  test('SSH → SSM → SSH：端口和这次输入的密码都还在 draft 里', () => {
    const d0 = { sshHost: 'ec2-user@1.2.3.4', sshPort: 2222, password: 'pw', proxyJump: '' };
    const ssm = switchVia(d0, 'ssm');
    assert.equal(ssm.connectVia, 'ssm');
    assert.equal(ssm.sshPort, 2222);
    assert.equal(ssm.password, 'pw');
    const back = switchVia({ ...ssm, ssmInstanceId: 'i-0123456789abcdef0' }, 'ssh');
    assert.equal(back.connectVia, 'ssh');
    assert.equal(back.sshPort, 2222);
    assert.equal(back.password, 'pw');
  });
});

describe('「测试连接」说清实际用的 profile 和身份', () => {
  test('ssmPreflight 把 sts get-caller-identity 的 ARN 交出来', async () => {
    const run: SsmRun = async (_f, args) => (args[0] === 'sts'
      ? { code: 0, stdout: JSON.stringify({ Arn: 'arn:aws:iam::123456789012:user/me' }), stderr: '' }
      : { code: 0, stdout: JSON.stringify({ InstanceInformationList: [{ PingStatus: 'Online' }] }), stderr: '' });
    const seen: { arn?: string } = {};
    const v = await ssmPreflight({ sshHost: 'ec2-user@i-0123456789abcdef0', connectVia: 'ssm', ssmInstanceId: 'i-0123456789abcdef0', ssmRegion: 'us-east-1' } as any,
      { aws: '/aws', plugin: '/p' }, run, seen);
    assert.equal(v, null);
    assert.equal(seen.arn, 'arn:aws:iam::123456789012:user/me');
  });
  test('remote:test 的结果里带 profile 和 ARN', () => {
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    const at = M.indexOf("ipcMain.handle('remote:test'");
    const body = M.slice(at, at + 3500);
    assert.match(body, /ssmIdentityNote\(/);
  });
});

/*
 * 表单真的渲染出来看：esbuild 打包 RemoteSettings.tsx 里的 ConnectionFields，
 * 用 react-dom/server 渲染成 HTML 再断言（node 直接跑不了 tsx）。
 */
describe('RemoteSettings：SSM 模式隐藏端口 / 密码', async () => {
  const esbuild = await import('esbuild');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-fields-'));
  const entry = path.join(dir, 'entry.tsx');
  const comp = path.join(process.cwd(), 'src/renderer/components/RemoteSettings.tsx').replace(/\\/g, '/');
  fs.writeFileSync(entry, [
    "import React from 'react';",
    "import { renderToStaticMarkup } from 'react-dom/server';",
    `import { ConnectionFields } from '${comp}';`,
    'export const render = (props: any) => renderToStaticMarkup(React.createElement(ConnectionFields, { setDraft() {}, setVia() {}, pickKey() {}, onToggleAdvanced() {}, locked: false, ...props }));',
  ].join('\n'));
  const out = path.join(dir, 'out.cjs');
  await esbuild.build({
    entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: out, jsx: 'automatic', logLevel: 'silent',
    nodePaths: [path.join(process.cwd(), 'node_modules')],
    loader: { '.png': 'dataurl', '.svg': 'dataurl', '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const { render } = createRequire(import.meta.url)(out);
  const inputs = (html: string, label: string): string[] => {
    const at = html.indexOf(`>${label}</label>`);
    return at < 0 ? [] : [html.slice(at, html.indexOf('</div></div>', at))];
  };
  const SSM_DRAFT = { sshHost: 'ec2-user@i-0123456789abcdef0', connectVia: 'ssm', ssmInstanceId: 'i-0123456789abcdef0', ssmRegion: 'ap-northeast-1', sshPort: 2222, password: 'pw', remoteWorkdir: '~/kirolex' };

  /*
    「SSM 模式根本不该让人填登录用户和私钥」（任务 698fb826）：默认推临时公钥，
    登录用户 / 端口 / 「改用自己的私钥」都收进默认折叠的「高级」。
  */
  test('SSM：默认视图没有「登录用户」「私钥」「端口」「密码」，都在折叠的「高级」后面', () => {
    const html = render({ draft: { ...SSM_DRAFT, identityFile: '/Users/me/k.pem' }, advancedOpen: false });
    assert.equal(/type="password"/.test(html), false, '没有密码框');
    for (const label of ['密码', '端口', '登录用户', '私钥']) assert.deepEqual(inputs(html, label), [], `默认视图里不该有 ${label}`);
    assert.equal(html.includes('改用自己的私钥'), false);
    assert.equal(html.includes('k.pem'), false, '老配置里的私钥路径不显示');
    assert.match(html, /高级/);
    /* 「名称」在 ConnectionFields 外面；AWS profile 的中文标签是「Profile」 */
    for (const label of ['连接方式', '实例 ID', '区域（Region）', 'Profile', '工作目录']) {
      assert.ok(html.includes(`>${label}</label>`), `缺 ${label}`);
    }
  });

  test('SSM：展开「高级」后有登录用户、端口和「改用自己的私钥」，值还在', () => {
    const html = render({ draft: SSM_DRAFT, advancedOpen: true });
    const [port] = inputs(html, '端口');
    assert.ok(port, '展开后有端口');
    assert.match(port, /value="2222"/);
    assert.match(inputs(html, '登录用户')[0] || '', /value="ec2-user"/);
    assert.match(html, /type="checkbox"[^>]*\/?>[^<]*改用自己的私钥（不推临时公钥）/);
    const box = (h: string): string => /<input type="checkbox"[^>]*>/.exec(h)?.[0] || '';
    assert.ok(box(html));
    assert.equal(/checked=""/.test(box(html)), false, '缺省不勾');
    assert.deepEqual(inputs(html, '私钥'), [], '没勾时不显示选私钥');
    assert.equal(/type="password"/.test(html), false);
  });

  test('SSM：勾了「改用自己的私钥」才显示私钥（老配置里的路径还在）', () => {
    const html = render({ draft: { ...SSM_DRAFT, ssmUseOwnKey: true, identityFile: '/Users/me/k.pem' }, advancedOpen: true });
    assert.match(/<input type="checkbox"[^>]*>/.exec(html)?.[0] || '', /checked=""/);
    assert.match(inputs(html, '私钥')[0] || '', /\/Users\/me\/k\.pem/);
  });

  test('SSH 模式不受影响：登录用户（用户名）/ 端口 / 密码 / 私钥都在主区域', () => {
    const d = { sshHost: 'ec2-user@1.2.3.4', sshPort: 22, identityFile: '/k.pem', remoteWorkdir: '~/kirolex' };
    const html = render({ draft: d, advancedOpen: false });
    for (const label of ['IP 地址', '用户名', '端口', '密码', '私钥', '工作目录']) {
      assert.ok(html.includes(`>${label}</label>`), `缺 ${label}`);
    }
    assert.equal(/高级/.test(html), false);
    assert.equal(html.includes('改用自己的私钥'), false);
  });

  test('SSM：AWS profile 是下拉，留空显示「默认凭证链（default）」，列出本机 profile', () => {
    const html = render({ draft: SSM_DRAFT, awsProfiles: ['default', 'work'] });
    const [sel] = inputs(html, 'Profile');
    assert.match(sel, /<select/);
    assert.match(sel, /默认凭证链（default）/);
    assert.match(sel, /<option value="work">work<\/option>/);
    const custom = render({ draft: { ...SSM_DRAFT, ssmProfile: 'not-listed' }, awsProfiles: ['work'] });
    assert.match(inputs(custom, 'Profile')[0], /value="not-listed"/, '列表里没有的名字也显示出来');
  });

  test('切回 SSH：端口和密码两栏都回来，值不丢', () => {
    const d = switchVia(SSM_DRAFT as any, 'ssh');
    const html = render({ draft: d, advancedOpen: false });
    assert.match(inputs(html, '端口')[0], /value="2222"/);
    assert.match(inputs(html, '密码')[0], /type="password"[^>]*value="pw"|value="pw"[^>]*type="password"/);
    assert.equal(/高级/.test(html), false);
  });
});

test('机器下拉：SSM 显示「实例ID · 区域 [SSM]」，不再整串 ec2-user@i-…', () => {
  const RS = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/RemoteSettings.tsx'), 'utf8');
  assert.match(RS, /machineOptionText\(r\)/);
  return import('../src/renderer/remotePick.ts').then(({ machineOptionText }) => {
    assert.equal(machineOptionText({ label: 'tokyo-ec2', sshHost: 'ec2-user@i-0abc', connectVia: 'ssm', ssmInstanceId: 'i-0abc', ssmRegion: 'ap-northeast-1' }),
      '🌐 tokyo-ec2 — i-0abc · ap-northeast-1  [SSM]');
    assert.equal(machineOptionText({ label: 'box', sshHost: 'u@1.2.3.4' }), '🌐 box — u@1.2.3.4');
  });
});
