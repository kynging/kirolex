/**
 * Codex 走 Bedrock 时的 IAM 权限：报错解析、最小策略、预检结果、关网页搜索的 config.toml 合并。
 *
 * 背景（2026-10-25 实测）：aws-tokyo 上的 Codex 一用网页搜索整轮就断，会话里只有一句
 * 「stream disconnected before completion: Access denied: web search is not authorized for this identity.」——
 * 那台机器的实例角色只有调模型的权限，没有 bedrock-websearch:*。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MODEL_ACTIONS, WEB_SEARCH_ACTIONS, isAccessDeniedError, parseAccessDenied, roleArnOf, minimalPolicy,
  parseIamPrecheck, bedrockCheckScript, withBedrockCheck, setCodexWebSearch, codexWebSearchDisabled,
  deniedNoteGroup, parseDeniedNoteGroup, deniedRoleArn, bedrockRegionOf, localBedrockCheckOutput, deniedCardPolicy,
  parseRemoteConfigRead, readLocalConfig, toggleCodexWebSearch, REMOTE_CONFIG_READ_SCRIPT,
} from '../src/main/bedrockIam.ts';

const TOKYO = 'stream disconnected before completion: Access denied: web search is not authorized for this identity.';

describe('报错 → 缺哪个 action、哪个身份', () => {
  test('那一句英文（web search）→ 三个 bedrock-websearch 动作', () => {
    assert.equal(isAccessDeniedError(TOKYO), true);
    const d = parseAccessDenied(TOKYO)!;
    assert.deepEqual(d.actions, WEB_SEARCH_ACTIONS);
    assert.equal(d.webSearch, true);
    assert.equal(d.identityArn, undefined);
  });

  test('AWS 标准格式：身份、动作、资源都拆出来；assumed-role 换成 role ARN', () => {
    const e = 'AccessDeniedException: User: arn:aws:sts::123456789012:assumed-role/kx-ec2-role/i-0abc123 is not authorized to perform: bedrock:InvokeModel on resource: arn:aws:bedrock:us-east-1::foundation-model/openai.gpt-6.1-sol because no identity-based policy allows the bedrock:InvokeModel action';
    const d = parseAccessDenied(e)!;
    assert.deepEqual(d.actions, ['bedrock:InvokeModel']);
    assert.equal(d.identityArn, 'arn:aws:sts::123456789012:assumed-role/kx-ec2-role/i-0abc123');
    assert.equal(d.roleArn, 'arn:aws:iam::123456789012:role/kx-ec2-role');
    assert.equal(d.resource, 'arn:aws:bedrock:us-east-1::foundation-model/openai.gpt-6.1-sol');
    assert.equal(d.region, 'us-east-1');
    assert.equal(d.webSearch, false);
  });

  test('bedrock-mantle:CreateInference', () => {
    const d = parseAccessDenied('Access denied: User: arn:aws:sts::111122223333:assumed-role/r/s is not authorized to perform: bedrock-mantle:CreateInference')!;
    assert.deepEqual(d.actions, ['bedrock-mantle:CreateInference']);
    assert.equal(d.roleArn, 'arn:aws:iam::111122223333:role/r');
  });

  test('只说了 Access denied、没给动作的 Bedrock 报错 → 当成模型调用', () => {
    const d = parseAccessDenied('unexpected status 403 Forbidden: {"message":"AccessDeniedException: You don\'t have access to the model with the specified model ID."}')!;
    assert.deepEqual(d.actions, MODEL_ACTIONS);
  });

  test('IAM 用户身份原样当 principal', () => {
    assert.equal(roleArnOf('arn:aws:iam::123456789012:user/alice'), 'arn:aws:iam::123456789012:user/alice');
    assert.equal(roleArnOf('arn:aws:sts::123456789012:assumed-role/a-b/c'), 'arn:aws:iam::123456789012:role/a-b');
  });

  test('不相干的错误不认', () => {
    assert.equal(isAccessDeniedError('stream disconnected before completion: connection reset'), false);
    assert.equal(parseAccessDenied('Internal error'), undefined);
    /* 别的服务的 AccessDenied（S3 等）不是这张卡管的 */
    assert.equal(parseAccessDenied('AccessDenied: User arn:aws:sts::1:assumed-role/r/s is not authorized to perform: s3:GetObject'), undefined);
  });
});

describe('最小策略 JSON', () => {
  test('网页搜索：三个动作、资源是那个区的 tool/*', () => {
    const p = JSON.parse(minimalPolicy(WEB_SEARCH_ACTIONS, 'us-east-1'));
    assert.equal(p.Version, '2012-10-17');
    assert.equal(p.Statement.length, 1);
    assert.equal(p.Statement[0].Effect, 'Allow');
    assert.deepEqual(p.Statement[0].Action, WEB_SEARCH_ACTIONS);
    assert.equal(p.Statement[0].Resource, 'arn:aws:bedrock-websearch:us-east-1:aws:tool/*');
  });

  test('模型调用 + 网页搜索：分两段；模型那段有资源就用资源', () => {
    const p = JSON.parse(minimalPolicy(['bedrock:InvokeModel', ...WEB_SEARCH_ACTIONS], 'ap-northeast-1', 'arn:aws:bedrock:us-east-1::foundation-model/x'));
    assert.equal(p.Statement.length, 2);
    assert.deepEqual(p.Statement[0].Action, ['bedrock:InvokeModel']);
    assert.equal(p.Statement[0].Resource, 'arn:aws:bedrock:us-east-1::foundation-model/x');
    assert.equal(p.Statement[1].Resource, 'arn:aws:bedrock-websearch:ap-northeast-1:aws:tool/*');
  });

  test('没给资源时模型那段是 *；没给区域时默认 us-east-1', () => {
    const p = JSON.parse(minimalPolicy(['bedrock-mantle:CreateInference']));
    assert.equal(p.Statement[0].Resource, '*');
    assert.match(minimalPolicy(WEB_SEARCH_ACTIONS), /arn:aws:bedrock-websearch:us-east-1:aws:tool\/\*/);
  });

  test('不含任何改 IAM 的动作', () => {
    assert.doesNotMatch(minimalPolicy([...MODEL_ACTIONS, ...WEB_SEARCH_ACTIONS]), /iam:/);
  });
});

describe('预检输出 → 结果', () => {
  const TOML = 'model = "openai.gpt-6.1-sol"\nmodel_provider = "amazon-bedrock"\n\n[model_providers.amazon-bedrock.aws]\nregion = "us-east-1"\n';
  const out = (body: string, toml = TOML): string => `${body}\nKX_IAM_TOML\n${toml}`;

  test('simulate：模型 ✓、网页搜索 ✗', () => {
    const c = parseIamPrecheck(out([
      'KX_IAM_ARN arn:aws:sts::123456789012:assumed-role/kx-ec2-role/i-0abc',
      'KX_IAM_PRINCIPAL arn:aws:iam::123456789012:role/kx-ec2-role',
      'KX_IAM_SIM bedrock-mantle:CreateInference\tallowed',
      'KX_IAM_SIM bedrock-websearch:InvokeSearch\timplicitDeny',
      'KX_IAM_SIM bedrock-websearch:InvokeFetch\timplicitDeny',
      'KX_IAM_SIM bedrock-websearch:ExternalWebAccess\texplicitDeny',
    ].join('\n')), 1000);
    assert.equal(c.method, 'simulate');
    assert.equal(c.model, 'ok');
    assert.equal(c.webSearch, 'denied');
    assert.deepEqual(c.missing, WEB_SEARCH_ACTIONS);
    assert.equal(c.identity, 'arn:aws:sts::123456789012:assumed-role/kx-ec2-role/i-0abc');
    assert.equal(c.roleArn, 'arn:aws:iam::123456789012:role/kx-ec2-role');
    assert.equal(c.region, 'us-east-1');
    assert.equal(c.checkedAt, 1000);
    assert.equal(c.webSearchDisabled, false);
    assert.deepEqual(JSON.parse(c.policy!).Statement[0].Action, WEB_SEARCH_ACTIONS);
  });

  test('simulate 全部 allowed → 没有策略要补', () => {
    const c = parseIamPrecheck(out([
      'KX_IAM_ARN arn:aws:sts::1:assumed-role/r/s',
      ...[...MODEL_ACTIONS, ...WEB_SEARCH_ACTIONS].map((a) => `KX_IAM_SIM ${a}\tallowed`),
    ].join('\n')));
    assert.equal(c.model, 'ok');
    assert.equal(c.webSearch, 'ok');
    assert.deepEqual(c.missing, []);
    assert.equal(c.policy, undefined);
  });

  test('没权限模拟 → 用真实调用：网页搜索被拒', () => {
    const c = parseIamPrecheck(out([
      'KX_IAM_ARN arn:aws:sts::1:assumed-role/r/s',
      'KX_IAM_SIM_ERR An error occurred (AccessDenied) when calling the SimulatePrincipalPolicy operation',
      'KX_IAM_PROBE_BEGIN',
      'ERROR: stream disconnected before completion: Access denied: web search is not authorized for this identity.',
      'KX_IAM_PROBE_END 1',
    ].join('\n')));
    assert.equal(c.method, 'probe');
    assert.equal(c.model, 'ok');
    assert.equal(c.webSearch, 'denied');
    assert.deepEqual(c.missing, WEB_SEARCH_ACTIONS);
  });

  test('真实调用成功、输出里有 web_search 事件 → 两样都 ✓', () => {
    const c = parseIamPrecheck(out('KX_IAM_ARN arn:aws:sts::1:assumed-role/r/s\nKX_IAM_SIM_ERR denied\nKX_IAM_PROBE_BEGIN\n{"type":"item.completed","item":{"type":"web_search"}}\nOK\nKX_IAM_PROBE_END 0'));
    assert.equal(c.model, 'ok');
    assert.equal(c.webSearch, 'ok');
  });

  test('真实调用成功但模型没去搜 → 模型 ✓、网页搜索判不了（不乱报 ✓）', () => {
    const c = parseIamPrecheck(out('KX_IAM_ARN arn:aws:sts::1:assumed-role/r/s\nKX_IAM_SIM_ERR denied\nKX_IAM_PROBE_BEGIN\nOK\nKX_IAM_PROBE_END 0'));
    assert.equal(c.model, 'ok');
    assert.equal(c.webSearch, 'unknown');
    assert.ok(c.note);
  });

  test('真实调用：模型调用被拒 → 两样都判不了网页搜索，模型 ✗', () => {
    const c = parseIamPrecheck(out('KX_IAM_ARN arn:aws:sts::1:assumed-role/r/s\nKX_IAM_SIM_ERR denied\nKX_IAM_PROBE_BEGIN\nUser: arn:aws:sts::1:assumed-role/r/s is not authorized to perform: bedrock-mantle:CreateInference\nKX_IAM_PROBE_END 1'));
    assert.equal(c.model, 'denied');
    assert.equal(c.webSearch, 'unknown');
    assert.deepEqual(c.missing, ['bedrock-mantle:CreateInference']);
  });

  test('真实调用超时（124）→ 不知道，不乱报 ✗', () => {
    const c = parseIamPrecheck(out('KX_IAM_ARN arn:aws:sts::1:assumed-role/r/s\nKX_IAM_SIM_ERR denied\nKX_IAM_PROBE_BEGIN\nKX_IAM_PROBE_END 124'));
    assert.equal(c.model, 'unknown');
    assert.equal(c.webSearch, 'unknown');
    assert.match(c.note || '', /60/);
  });

  test('没装 aws CLI / 拿不到身份', () => {
    const a = parseIamPrecheck(out('KX_IAM_NO_AWS'));
    assert.equal(a.method, 'none');
    assert.equal(a.model, 'unknown');
    assert.ok(a.note);
    const b = parseIamPrecheck(out('KX_IAM_ARN_ERR Unable to locate credentials'));
    assert.equal(b.identity, undefined);
    assert.match(b.note || '', /Unable to locate credentials/);
  });

  test('config.toml 里已经关了网页搜索 → 记下来', () => {
    const c = parseIamPrecheck(out('KX_IAM_NO_AWS', `web_search = "disabled"\n${TOML}`));
    assert.equal(c.webSearchDisabled, true);
  });

  test('预检结果挂到引擎状态上', () => {
    const status = { installed: true, loggedIn: true, detail: 'Via Amazon Bedrock' };
    const c = parseIamPrecheck(out('KX_IAM_ARN arn:aws:sts::1:assumed-role/r/s\nKX_IAM_SIM bedrock-mantle:CreateInference\tallowed\nKX_IAM_SIM bedrock-websearch:InvokeSearch\timplicitDeny'));
    const s = withBedrockCheck(status, c);
    assert.equal(s.bedrock?.model, 'ok');
    assert.equal(s.bedrock?.webSearch, 'denied');
    assert.deepEqual(s.bedrock?.missing, ['bedrock-websearch:InvokeSearch']);
    assert.equal(s.detail, status.detail);
    /* 没有预检结果就原样 */
    assert.equal(withBedrockCheck(status, undefined), status);
  });
});

describe('预检脚本（只读）', () => {
  const S = bedrockCheckScript();
  test('只用只读调用：sts get-caller-identity、iam simulate-principal-policy、codex exec 60 秒', () => {
    assert.match(S, /aws sts get-caller-identity/);
    assert.match(S, /aws iam simulate-principal-policy/);
    for (const a of [...MODEL_ACTIONS, ...WEB_SEARCH_ACTIONS]) assert.ok(S.includes(a), a);
    assert.match(S, /timeout 60 codex exec/);
    assert.match(S, /web_search="live"/);
    assert.doesNotMatch(S, /iam (put|attach|create|update|delete)-/i);
  });

  test('在 bash 里跑一遍（假的 aws / codex）能被 parseIamPrecheck 读懂', (t) => {
    let bash = '';
    try { execFileSync('bash', ['-c', 'true']); bash = 'bash'; } catch { t.skip('没有 bash'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-iam-'));
    try {
      const bin = path.join(dir, 'bin');
      fs.mkdirSync(bin);
      fs.mkdirSync(path.join(dir, '.codex'));
      fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), 'model_provider = "amazon-bedrock"\n');
      fs.writeFileSync(path.join(bin, 'aws'), [
        '#!/bin/sh',
        'case "$1 $2" in',
        '  "sts get-caller-identity") echo "arn:aws:sts::123456789012:assumed-role/kx-role/i-1" ;;',
        '  "iam get-role") exit 255 ;;',
        '  "iam simulate-principal-policy") echo "An error occurred (AccessDenied)" >&2; exit 254 ;;',
        'esac',
      ].join('\n'), { mode: 0o755 });
      fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\necho "ERROR: Access denied: web search is not authorized for this identity."\nexit 1\n', { mode: 0o755 });
      const toPosix = (p: string): string => p.replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/');
      const out = execFileSync(bash, ['-c', `export HOME="$1" PATH="$2:/usr/bin:/bin"; bash -c "$3" </dev/null 2>&1`, 'x', toPosix(dir), toPosix(bin), S], { encoding: 'utf8' });
      const c = parseIamPrecheck(out);
      assert.equal(c.identity, 'arn:aws:sts::123456789012:assumed-role/kx-role/i-1');
      assert.equal(c.roleArn, 'arn:aws:iam::123456789012:role/kx-role');
      assert.equal(c.method, 'probe');
      assert.equal(c.webSearch, 'denied');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('预检脚本：按资源模拟（只按 tool/* 授权的策略不能被误判成缺权限）', () => {
  const S = bedrockCheckScript();
  const toPosix = (p: string): string => p.replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/');
  /** 假的 aws：网页搜索只在模拟资源正好是那个区的 tool/* 时 allowed（= 只按 minimalPolicy 给的资源授权）；模型调用按 * 授权。 */
  const run = (t: any, toml: string): string | null => {
    try { execFileSync('bash', ['-c', 'true']); } catch { t.skip('没有 bash'); return null; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-iamres-'));
    try {
      const bin = path.join(dir, 'bin');
      fs.mkdirSync(bin);
      fs.mkdirSync(path.join(dir, '.codex'));
      fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), toml);
      fs.writeFileSync(path.join(bin, 'aws'), [
        '#!/bin/sh',
        'case "$1 $2" in',
        '  "sts get-caller-identity") echo "arn:aws:sts::123456789012:assumed-role/kx-role/i-1" ;;',
        '  "iam get-role") echo "arn:aws:iam::123456789012:role/kx-role" ;;',
        '  "iam simulate-principal-policy")',
        '    ok=implicitDeny',
        '    case "$*" in *"--resource-arns arn:aws:bedrock-websearch:ap-northeast-1:aws:tool/*"*) ok=allowed ;; esac',
        '    for a in "$@"; do case "$a" in',
        '      bedrock-mantle:*) printf "%s\\tallowed\\n" "$a" ;;',
        '      bedrock-websearch:*) printf "%s\\t%s\\n" "$a" "$ok" ;;',
        '    esac; done ;;',
        'esac',
      ].join('\n'), { mode: 0o755 });
      fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\necho "should not be called"\nexit 1\n', { mode: 0o755 });
      return execFileSync('bash', ['-c', `export HOME="$1" PATH="$2:/usr/bin:/bin"; bash -c "$3" </dev/null 2>&1`, 'x', toPosix(dir), toPosix(bin), S], { encoding: 'utf8' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  test('网页搜索按配置区域的 tool/* 模拟：只按 tool/* 授权 → 判 ✓', (t) => {
    const out = run(t, 'model_provider = "amazon-bedrock"\n\n[model_providers.amazon-bedrock.aws]\nregion = "ap-northeast-1"\n');
    if (out === null) return;
    assert.match(out, /^KX_IAM_REGION ap-northeast-1$/m);
    const c = parseIamPrecheck(out);
    assert.equal(c.method, 'simulate');
    assert.equal(c.model, 'ok');
    assert.equal(c.webSearch, 'ok');
    assert.deepEqual(c.missing, []);
    assert.equal(c.region, 'ap-northeast-1');
  });

  test('区域对不上（授权在别的区）→ 判 ✗，给的策略资源是配置里的区域', (t) => {
    const out = run(t, 'model_provider = "amazon-bedrock"\n\n[model_providers.amazon-bedrock.aws]\nregion = "us-west-2"\n');
    if (out === null) return;
    const c = parseIamPrecheck(out);
    assert.equal(c.webSearch, 'denied');
    assert.equal(c.model, 'ok');
    assert.equal(JSON.parse(c.policy!).Statement[0].Resource, 'arn:aws:bedrock-websearch:us-west-2:aws:tool/*');
  });

  test('Codex 没走 Bedrock：不查', (t) => {
    const out = run(t, 'model_provider = "my-gateway"\n');
    if (out === null) return;
    const c = parseIamPrecheck(out);
    assert.equal(c.notBedrock, true);
    assert.doesNotMatch(out, /KX_IAM_SIM|KX_IAM_PROBE/);
  });

  test('脚本里两次模拟、网页搜索那次带 --resource-arns', () => {
    assert.match(S, /--action-names bedrock-mantle:CreateInference --query/);
    assert.match(S, /--action-names bedrock-websearch:InvokeSearch bedrock-websearch:InvokeFetch bedrock-websearch:ExternalWebAccess --resource-arns "arn:aws:bedrock-websearch:\$R:aws:tool\/\*"/);
  });
});

describe('从实际报错到卡上的策略：报错点名的资源要带过去（不给成 *）', () => {
  test('bedrock:InvokeModel 被拒、给了具体模型 ARN → 卡上策略的 Resource 就是那个 ARN', () => {
    const err = 'AccessDeniedException: User: arn:aws:sts::123456789012:assumed-role/kx-role/i-1 is not authorized to perform: bedrock:InvokeModel on resource: arn:aws:bedrock:us-east-1::foundation-model/openai.gpt-6.1-sol because no identity-based policy allows the bedrock:InvokeModel action';
    const d = parseAccessDenied(err)!;
    const group = deniedNoteGroup({ machineId: 'r_tokyo', region: 'us-east-1', actions: d.actions, ...(d.resource ? { resource: d.resource } : {}) });
    const g = parseDeniedNoteGroup(group)!;
    assert.equal(g.resource, 'arn:aws:bedrock:us-east-1::foundation-model/openai.gpt-6.1-sol');
    assert.equal(g.machineId, 'r_tokyo');
    assert.deepEqual(g.actions, ['bedrock:InvokeModel']);
    const p = JSON.parse(deniedCardPolicy(group)!);
    assert.deepEqual(p.Statement, [{ Sid: 'KiroLexCodexBedrockModel', Effect: 'Allow', Action: ['bedrock:InvokeModel'], Resource: 'arn:aws:bedrock:us-east-1::foundation-model/openai.gpt-6.1-sol' }]);
  });

  test('网页搜索那句（没给资源）→ 照旧是那个区的 tool/*；旧格式的 group 照样认', () => {
    const d = parseAccessDenied(TOKYO)!;
    const group = deniedNoteGroup({ machineId: 'local', region: 'eu-west-1', actions: d.actions });
    assert.equal(parseDeniedNoteGroup(group)!.resource, undefined);
    assert.equal(JSON.parse(deniedCardPolicy(group)!).Statement[0].Resource, 'arn:aws:bedrock-websearch:eu-west-1:aws:tool/*');
    assert.equal(deniedCardPolicy('model-fallback:a→b'), undefined);
  });
});

describe('预检试调用被拒、报错点名了模型 → 预检策略和启动提示卡都收窄到那个模型', () => {
  const MODEL_ARN = 'arn:aws:bedrock:us-east-1::foundation-model/openai.gpt-6.1-sol';
  const ERR = `ERROR: User: arn:aws:sts::123456789012:assumed-role/kx-role/i-1 is not authorized to perform: bedrock:InvokeModel on resource: ${MODEL_ARN} because no identity-based policy allows the bedrock:InvokeModel action`;
  const TOML = 'model_provider = "amazon-bedrock"\n\n[model_providers.amazon-bedrock.aws]\nregion = "us-east-1"\n';
  const expectNarrow = (policy: string | undefined): void => {
    assert.deepEqual(JSON.parse(policy!).Statement, [{ Sid: 'KiroLexCodexBedrockModel', Effect: 'Allow', Action: ['bedrock:InvokeModel'], Resource: MODEL_ARN }]);
  };
  /** 和 index.ts 的 precheckCodexBedrock 同一个写法（下面源码断言守着它没变） */
  const startupGroup = (check: ReturnType<typeof parseIamPrecheck>): string =>
    deniedNoteGroup({ machineId: 'r_tokyo', region: check.region, actions: check.missing, ...(check.resource ? { resource: check.resource } : {}) });

  test('远端预检输出 → BedrockIamCheck 带资源，策略不是 *；启动提示卡的策略也是那个模型', () => {
    const c = parseIamPrecheck(['KX_IAM_REGION us-east-1', 'KX_IAM_ARN arn:aws:sts::123456789012:assumed-role/kx-role/i-1', 'KX_IAM_SIM_ERR denied',
      'KX_IAM_PROBE_BEGIN', ERR, 'KX_IAM_PROBE_END 1', 'KX_IAM_TOML', TOML].join('\n'));
    assert.equal(c.model, 'denied');
    assert.deepEqual(c.missing, ['bedrock:InvokeModel']);
    assert.equal(c.resource, MODEL_ARN);
    expectNarrow(c.policy);
    expectNarrow(deniedCardPolicy(startupGroup(c)));
  });

  test('本机预检（localBedrockCheckOutput）同样带资源', async () => {
    const run = async (tool: 'aws' | 'codex', args: string[]) => {
      if (tool === 'codex') return { code: 1, out: ERR };
      if (args[0] === 'sts') return { code: 0, out: 'arn:aws:sts::123456789012:assumed-role/kx-role/i-1' };
      return { code: 254, out: 'AccessDenied' };
    };
    const c = parseIamPrecheck(await localBedrockCheckOutput(() => TOML, run));
    assert.equal(c.resource, MODEL_ARN);
    expectNarrow(c.policy);
    expectNarrow(deniedCardPolicy(startupGroup(c)));
  });

  test('没点名资源（网页搜索那句）：不带资源，照旧 tool/*', () => {
    const c = parseIamPrecheck(['KX_IAM_SIM_ERR denied', 'KX_IAM_PROBE_BEGIN', TOKYO, 'KX_IAM_PROBE_END 1', 'KX_IAM_TOML', TOML].join('\n'));
    assert.equal(c.resource, undefined);
    assert.equal(JSON.parse(deniedCardPolicy(startupGroup(c))!).Statement[0].Resource, 'arn:aws:bedrock-websearch:us-east-1:aws:tool/*');
  });

  test('index.ts 的启动提示卡把预检里的资源带进 group', () => {
    const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
    const pre = M.slice(M.indexOf('function precheckCodexBedrock('), M.indexOf('async function noteBedrockDenied('));
    assert.match(pre, /const group = deniedNoteGroup\(\{ machineId: remote \? target\?\.id : 'local', region: check\.region, actions: check\.missing, \.\.\.\(check\.resource \? \{ resource: check\.resource \} : \{\}\) \}\);/);
  });
});

describe('remote-bootstrap.sh 的试调用判断（没权限模拟时）', () => {
  const read = (...p: string[]): string => fs.readFileSync(path.join(import.meta.dirname, '..', ...p), 'utf8');
  /** 跑安装脚本里那一段：aws 能拿身份但不能模拟 → 走试调用；codex 输出 / 退出码可控（timeout 原样转发退出码）。 */
  const runBlock = (t: any, codexOut: string, codexCode: number): string | null => {
    try { execFileSync('bash', ['-c', 'true']); } catch { t.skip('没有 bash'); return null; }
    const SH = read('scripts', 'remote-bootstrap.sh');
    const from = SH.indexOf('# Codex 走 Bedrock 时的 IAM 权限');
    const to = SH.indexOf('\nsay ""\nif [ "$rc" -eq 0 ]', from);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-iamprobe-'));
    try {
      const bin = path.join(dir, 'bin');
      fs.mkdirSync(bin);
      fs.mkdirSync(path.join(dir, '.codex'));
      fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), 'model_provider = "amazon-bedrock"\n\n[model_providers.amazon-bedrock.aws]\nregion = "us-east-1"\n');
      fs.writeFileSync(path.join(bin, 'aws'), [
        '#!/bin/sh',
        'case "$1 $2" in',
        '  "sts get-caller-identity") echo "arn:aws:sts::123456789012:assumed-role/kx-role/i-1" ;;',
        '  "iam get-role") echo "arn:aws:iam::123456789012:role/kx-role" ;;',
        '  *) exit 254 ;;',
        'esac',
      ].join('\n'), { mode: 0o755 });
      fs.writeFileSync(path.join(bin, 'timeout'), '#!/bin/sh\nshift\n"$@"\n', { mode: 0o755 });
      fs.writeFileSync(path.join(dir, 'codex-out.txt'), codexOut);
      fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\ncat "$HOME/codex-out.txt"\nexit ${codexCode}\n`, { mode: 0o755 });
      const script = path.join(dir, 'blk.sh');
      fs.writeFileSync(script, `say() { printf '%s\\n' "$*"; }\nhave() { command -v "$1" >/dev/null 2>&1; }\nfull() { true; }\n${SH.slice(from, to)}\n`);
      const toPosix = (p: string): string => p.replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/');
      return execFileSync('bash', ['-c', 'export HOME="$1" PATH="$2:/usr/bin:/bin"; bash "$3" </dev/null 2>&1', 'x', toPosix(dir), toPosix(bin), toPosix(script)], { encoding: 'utf8' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  test('报错里只有动作名 bedrock-websearch:InvokeSearch → 网页搜索 ✗、模型 ✓（不误报缺 CreateInference）', (t) => {
    const out = runBlock(t, '{"type":"error","message":"AccessDeniedException: User: arn:aws:sts::123456789012:assumed-role/kx-role/i-1 is not authorized to perform: bedrock-websearch:InvokeSearch"}\n', 1);
    if (out === null) return;
    assert.match(out, /模型调用 ✓ · 网页搜索 ✗/);
    assert.doesNotMatch(out, /CreateInference/);
    assert.match(out, /arn:aws:bedrock-websearch:us-east-1:aws:tool\/\*/);
  });

  test('输出里有 web_search 但退出码非 0 → 两样都 ?（不报通过）', (t) => {
    const out = runBlock(t, '{"type":"item.started","item":{"type":"web_search"}}\n{"type":"error","message":"stream disconnected: connection reset"}\n', 1);
    if (out === null) return;
    assert.match(out, /模型调用 \? · 网页搜索 \?/);
    assert.doesNotMatch(out, /缺:/);
  });

  test('超时（124）→ 两样都 ?', (t) => {
    const out = runBlock(t, '{"type":"item.started","item":{"type":"web_search"}}\n', 124);
    if (out === null) return;
    assert.match(out, /模型调用 \? · 网页搜索 \?/);
  });

  test('退出码 0 且有 web_search 事件 → 两样都 ✓；退出码 0 没搜 → 模型 ✓、网页搜索 ?', (t) => {
    const ok = runBlock(t, '{"type":"item.completed","item":{"type":"web_search"}}\nOK\n', 0);
    if (ok === null) return;
    assert.match(ok, /模型调用 ✓ · 网页搜索 ✓/);
    const noSearch = runBlock(t, 'OK\n', 0);
    assert.match(noSearch!, /模型调用 ✓ · 网页搜索 \?/);
  });

  test('bedrock:InvokeModel 被拒且给了模型 ARN → 模型 ✗，策略里是那个动作和那个资源', (t) => {
    const out = runBlock(t, 'ERROR: User: arn:aws:sts::123456789012:assumed-role/kx-role/i-1 is not authorized to perform: bedrock:InvokeModel on resource: arn:aws:bedrock:us-east-1::foundation-model/openai.gpt-6.1-sol because no identity-based policy allows it\n', 1);
    if (out === null) return;
    assert.match(out, /模型调用 ✗ · 网页搜索 \?/);
    const json = out.slice(out.indexOf('{\n'), out.indexOf('\n}\n') + 2);
    assert.deepEqual(JSON.parse(json).Statement, [{ Sid: 'KiroLexCodexBedrockModel', Effect: 'Allow', Action: ['bedrock:InvokeModel'], Resource: 'arn:aws:bedrock:us-east-1::foundation-model/openai.gpt-6.1-sol' }]);
  });
});

describe('这台机器暂时关掉 Codex 网页搜索（config.toml 合并）', () => {
  const T = [
    '# 我的配置',
    'model = "openai.gpt-6.1-sol"',
    'model_provider = "amazon-bedrock"',
    'approval_policy = "never"',
    '',
    '[model_providers.amazon-bedrock.aws]',
    'region = "us-east-1"',
    '',
    '[projects."/home/ec2-user"]',
    'trust_level = "trusted"',
    '',
  ].join('\n');

  test('关掉：顶层加一行 web_search = "disabled"，其余逐字保留', () => {
    const out = setCodexWebSearch(T, 'disabled');
    assert.equal(codexWebSearchDisabled(out), true);
    assert.equal(codexWebSearchDisabled(T), false);
    /* 加在第一张表之前（否则会变成某张表里的键） */
    const lines = out.split('\n');
    const at = lines.indexOf('web_search = "disabled"');
    assert.ok(at >= 0 && at < lines.indexOf('[model_providers.amazon-bedrock.aws]'));
    assert.equal(out.replace('web_search = "disabled"\n', ''), T);
  });

  test('已经有顶层 web_search：原地换掉，不重复', () => {
    const out = setCodexWebSearch(T.replace('approval_policy = "never"', 'web_search = "live"  # 原来的'), 'disabled');
    assert.equal(out.match(/^web_search\s*=/gm)?.length, 1);
    assert.equal(codexWebSearchDisabled(out), true);
    assert.match(out, /approval_policy|trust_level/);
  });

  test('表里的同名键（[tools] web_search）不算顶层，不动它', () => {
    const t2 = `${T}\n[tools]\nweb_search = true\n`;
    const out = setCodexWebSearch(t2, 'disabled');
    assert.match(out, /\[tools\]\nweb_search = true/);
    assert.equal(codexWebSearchDisabled(t2), false);
  });

  test('重新打开：删掉那一行，回到原样', () => {
    assert.equal(setCodexWebSearch(setCodexWebSearch(T, 'disabled'), null), T);
  });

  test('空文件 / 只有表 / CRLF', () => {
    assert.equal(setCodexWebSearch('', 'disabled'), 'web_search = "disabled"\n');
    assert.equal(setCodexWebSearch('[a]\nx = 1\n', 'disabled'), 'web_search = "disabled"\n\n[a]\nx = 1\n');
    const crlf = setCodexWebSearch('model = "m"\r\n[a]\r\nx = 1\r\n', 'disabled');
    assert.equal(codexWebSearchDisabled(crlf), true);
    assert.match(crlf, /x = 1/);
  });
});

describe('关网页搜索之前的读取：读不干净就不写（不能把 provider / 模型 / 区域冲掉）', () => {
  const CFG = 'model = "openai.gpt-6.1-sol"\nmodel_provider = "amazon-bedrock"\n\n[model_providers.amazon-bedrock.aws]\nregion = "eu-west-1"\n';

  test('远端输出：完整（前面有 motd 也行）/ 文件不存在 / 空文件 / CRLF 原样', () => {
    assert.deepEqual(parseRemoteConfigRead(`Welcome!\nKX_CFG_BEGIN\n${CFG}\nKX_CFG_END_OK\n`), { ok: true, text: CFG, existed: true });
    assert.deepEqual(parseRemoteConfigRead('KX_CFG_MISSING\n'), { ok: true, text: '', existed: false });
    assert.deepEqual(parseRemoteConfigRead('KX_CFG_BEGIN\n\nKX_CFG_END_OK\n'), { ok: true, text: '', existed: true });
    assert.deepEqual(parseRemoteConfigRead('KX_CFG_BEGIN\na = 1\r\nb = 2\r\n\nKX_CFG_END_OK\n'), { ok: true, text: 'a = 1\r\nb = 2\r\n', existed: true });
  });

  test('远端输出不完整 / cat 出错 / 什么都没回 → 不算读到', () => {
    assert.equal(parseRemoteConfigRead(`KX_CFG_BEGIN\n${CFG.slice(0, 20)}`).ok, false);       // 截断：没有结尾标记
    assert.equal(parseRemoteConfigRead('KX_CFG_BEGIN\ncat: /home/u/.codex/config.toml: Permission denied\n').ok, false);
    assert.equal(parseRemoteConfigRead('').ok, false);
    assert.equal(parseRemoteConfigRead('bash: line 1: ssh noise\n').ok, false);
  });

  test('远端读法在 bash 里真跑：有文件 / 没文件 / 读不了（是个目录）', (t) => {
    try { execFileSync('bash', ['-c', 'true']); } catch { t.skip('没有 bash'); return; }
    const toPosix = (p: string): string => p.replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/');
    /* 读不了时脚本退出码非 0（和 runRemoteCapture「出错但有输出」一样，只拿输出） */
    const runIn = (home: string): string => {
      try { return execFileSync('bash', ['-c', `export HOME="$1"; bash -c "$2" 2>&1`, 'x', toPosix(home), REMOTE_CONFIG_READ_SCRIPT], { encoding: 'utf8' }); }
      catch (err: any) { return String(err?.stdout || ''); }
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-cfgread-'));
    try {
      assert.deepEqual(parseRemoteConfigRead(runIn(dir)), { ok: true, text: '', existed: false });
      fs.mkdirSync(path.join(dir, '.codex'));
      fs.mkdirSync(path.join(dir, '.codex', 'config.toml'));            // 读不了：是个目录
      assert.equal(parseRemoteConfigRead(runIn(dir)).ok, false);
      fs.rmdirSync(path.join(dir, '.codex', 'config.toml'));
      fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), CFG);
      assert.deepEqual(parseRemoteConfigRead(runIn(dir)), { ok: true, text: CFG, existed: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('本机：只有 ENOENT 算空配置，别的读错误不算', () => {
    const fail = (code: string) => () => { const e: any = new Error(code); e.code = code; throw e; };
    assert.deepEqual(readLocalConfig('/x', fail('ENOENT')), { ok: true, text: '', existed: false });
    assert.equal(readLocalConfig('/x', fail('EACCES')).ok, false);
    assert.equal(readLocalConfig('/x', fail('EISDIR')).ok, false);
    assert.deepEqual(readLocalConfig('/x', () => CFG), { ok: true, text: CFG, existed: true });
  });

  test('读失败 → 抛错、不写；原文件一个字不变（真文件）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-cfgkeep-'));
    try {
      const file = path.join(dir, 'config.toml');
      fs.writeFileSync(file, CFG);
      let wrote = 0;
      const write = async (text: string) => { wrote++; fs.writeFileSync(file, text); };
      /* 本机：读的时候报 EACCES */
      await assert.rejects(toggleCodexWebSearch(async () => readLocalConfig(file, () => { const e: any = new Error('denied'); e.code = 'EACCES'; throw e; }), write, false), /nothing was changed|什么都没改/);
      /* 远端：输出被截断 */
      await assert.rejects(toggleCodexWebSearch(async () => parseRemoteConfigRead(`KX_CFG_BEGIN\n${CFG.slice(0, 15)}`), write, false));
      assert.equal(wrote, 0);
      assert.equal(fs.readFileSync(file, 'utf8'), CFG);
      /* 读得干净：只多一行，其余不变 */
      await toggleCodexWebSearch(async () => readLocalConfig(file, (p) => fs.readFileSync(p, 'utf8')), write, false);
      assert.equal(wrote, 1);
      assert.equal(fs.readFileSync(file, 'utf8').replace('web_search = "disabled"\n', ''), CFG);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('文件确实不存在 → 从空配置开始写（告诉写的那一侧「原来没有」，不去备份）', async () => {
    const calls: Array<[string, boolean]> = [];
    const out = await toggleCodexWebSearch(async () => parseRemoteConfigRead('KX_CFG_MISSING\n'), async (t, existed) => { calls.push([t, existed]); }, false);
    assert.equal(out, 'web_search = "disabled"\n');
    assert.deepEqual(calls, [['web_search = "disabled"\n', false]]);
  });

  test('index.ts 的开关两条路都走 toggleCodexWebSearch，不再「读不到就当空」', () => {
    const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
    const h = M.slice(M.indexOf("ipcMain.handle('ai-login:codex-web-search'"), M.indexOf("ipcMain.handle('ai-login:local-config'"));
    assert.match(h, /await toggleCodexWebSearch\(async \(\) => readLocalConfig\(file, \(p\) => fs\.readFileSync\(p, 'utf-8'\)\)/);
    assert.match(h, /await toggleCodexWebSearch\(async \(\) => parseRemoteConfigRead\(await runRemoteCapture\(remote, REMOTE_CONFIG_READ_SCRIPT, 30_000\)\)/);
    assert.match(h, /cat > \$\{file\}\.kirolex-tmp && chmod 600 \$\{file\}\.kirolex-tmp && mv \$\{file\}\.kirolex-tmp \$\{file\}/);
    assert.doesNotMatch(h, /cat ~\/\.codex\/config\.toml 2>\/dev\/null \|\| true/);
    assert.doesNotMatch(h, /catch \{ \/\* 没有就从空的开始 \*\/ \}/);
  });
});

describe('提示卡的关闭 / 不再提醒和普通 KiroLex 提示共用一份记录', () => {
  test('缺权限卡和普通提示交替关掉：两条的关闭记录都在（内存和落盘都在）', async () => {
    const nd = await import('../src/renderer/noticeDismiss.ts');
    const { uiGet } = await import('../src/renderer/uiStore.ts');
    const card = { id: 'u_bedrock_card_1', noteGroup: deniedNoteGroup({ machineId: 'r_tokyo', region: 'us-east-1', actions: WEB_SEARCH_ACTIONS }) };
    const plain = { id: 'u_plain_note_1', noteGroup: 'backend-session-swap' };
    const card2 = { id: 'u_bedrock_card_2', noteGroup: card.noteGroup };
    nd.dismissNotice(card.id);
    nd.dismissNotice(plain.id);
    nd.dismissNotice(card2.id);
    const saved = JSON.parse(uiGet(nd.DISMISSED_NOTES_KEY) || '[]');
    for (const id of [card.id, plain.id, card2.id]) assert.ok(saved.includes(id), `落盘里有 ${id}`);
    const st = nd.noticeHideStore.get();
    assert.equal(nd.isNoticeHidden(card, st), true);
    assert.equal(nd.isNoticeHidden(plain, st), true);
    assert.equal(nd.isNoticeHidden(card2, st), true);
  });

  test('「不再提醒」按类型：缺权限卡静音后同类的新卡都不画，别的提示照常', async () => {
    const nd = await import('../src/renderer/noticeDismiss.ts');
    const g = deniedNoteGroup({ machineId: 'local', region: 'eu-west-1', actions: MODEL_ACTIONS });
    assert.equal(nd.muteKeyOf(g), 'bedrock-denied');
    nd.muteNotice(g);
    const st = nd.noticeHideStore.get();
    assert.equal(nd.isNoticeHidden({ id: 'u_new_card', noteGroup: deniedNoteGroup({ machineId: 'r_x', region: 'us-east-1', actions: WEB_SEARCH_ACTIONS }) }, st), true);
    assert.equal(nd.isNoticeHidden({ id: 'u_other', noteGroup: 'model-fallback:a→b' }, st), false);
  });
});

describe('会话里提示卡的 group（类型:对象→结果）', () => {
  test('往返', () => {
    const g = deniedNoteGroup({ machineId: 'r_tokyo', region: 'us-east-1', actions: WEB_SEARCH_ACTIONS });
    assert.match(g, /^bedrock-denied:/);
    assert.deepEqual(parseDeniedNoteGroup(g), { machineId: 'r_tokyo', region: 'us-east-1', actions: WEB_SEARCH_ACTIONS });
    assert.equal(parseDeniedNoteGroup('model-fallback:a→b'), undefined);
    assert.equal(parseDeniedNoteGroup(undefined), undefined);
    /* 本机会话没有机器 id */
    assert.equal(parseDeniedNoteGroup(deniedNoteGroup({ region: 'us-east-1', actions: MODEL_ACTIONS }))?.machineId, undefined);
  });

  test('从提示正文里拿 role ARN（中英两版都认）', () => {
    assert.equal(deniedRoleArn('…身份：arn:aws:iam::123456789012:role/kx-role（来自 …）'), 'arn:aws:iam::123456789012:role/kx-role');
    assert.equal(deniedRoleArn('Identity: arn:aws:iam::123456789012:role/path/kx-role.'), 'arn:aws:iam::123456789012:role/path/kx-role');
    assert.equal(deniedRoleArn('no arn here'), undefined);
  });
});

describe('本机的预检（不经 bash，逐条跑同样的只读调用）', () => {
  const TOML = 'model_provider = "amazon-bedrock"\n\n[model_providers.amazon-bedrock.aws]\nregion = "eu-west-1"\n';
  type Call = { tool: string; args: string[]; timeoutMs: number };
  /** 假的本机命令：网页搜索只在模拟资源正好是 eu-west-1 的 tool/* 时 allowed。 */
  const fakeRun = (calls: Call[], opts: { aws?: boolean; simDenied?: boolean; codexOut?: string; codexCode?: number; codexTimeout?: boolean } = {}) =>
    async (tool: 'aws' | 'codex', args: string[], timeoutMs: number) => {
      calls.push({ tool, args, timeoutMs });
      if (tool === 'aws') {
        if (opts.aws === false) return null;
        const cmd = `${args[0]} ${args[1]}`;
        if (cmd === 'sts get-caller-identity') return { code: 0, out: 'arn:aws:sts::123456789012:assumed-role/local-role/me\n' };
        if (cmd === 'iam get-role') return { code: 0, out: 'arn:aws:iam::123456789012:role/dev/local-role\n' };
        if (cmd === 'iam simulate-principal-policy') {
          if (opts.simDenied) return { code: 254, out: 'An error occurred (AccessDenied) when calling the SimulatePrincipalPolicy operation' };
          const res = args[args.indexOf('--resource-arns') + 1];
          const ok = args.includes('--resource-arns') && res === 'arn:aws:bedrock-websearch:eu-west-1:aws:tool/*' ? 'allowed' : 'implicitDeny';
          return { code: 0, out: args.filter((a) => /^bedrock/.test(a)).map((a) => `${a}\t${a.startsWith('bedrock-mantle') ? 'allowed' : ok}`).join('\n') };
        }
        return { code: 1, out: '' };
      }
      if (opts.codexOut === undefined) return null;
      return { code: opts.codexCode ?? 0, out: opts.codexOut, timedOut: opts.codexTimeout };
    };

  test('不走 Bedrock：只读配置，不跑任何命令', async () => {
    const calls: Call[] = [];
    const c = parseIamPrecheck(await localBedrockCheckOutput(() => 'model_provider = "gw"\n', fakeRun(calls)));
    assert.equal(c.notBedrock, true);
    assert.equal(calls.length, 0);
  });

  test('模拟：网页搜索按本机配置区域的 tool/* 资源、模型单独模拟；身份是 get-role 给的真实 role ARN', async () => {
    const calls: Call[] = [];
    const c = parseIamPrecheck(await localBedrockCheckOutput(() => TOML, fakeRun(calls)));
    assert.equal(c.method, 'simulate');
    assert.equal(c.model, 'ok');
    assert.equal(c.webSearch, 'ok');
    assert.equal(c.region, 'eu-west-1');
    assert.equal(c.identity, 'arn:aws:sts::123456789012:assumed-role/local-role/me');
    assert.equal(c.roleArn, 'arn:aws:iam::123456789012:role/dev/local-role');
    const sims = calls.filter((x) => x.args[1] === 'simulate-principal-policy');
    assert.equal(sims.length, 2);
    assert.ok(!sims[0].args.includes('--resource-arns'));
    assert.ok(sims[1].args.includes('arn:aws:bedrock-websearch:eu-west-1:aws:tool/*'));
    assert.ok(!calls.some((x) => x.tool === 'codex'));
    /* 只读：没有任何改 IAM 的调用 */
    assert.ok(!calls.some((x) => /^(put|attach|create|update|delete)-/.test(x.args[1] || '')));
  });

  test('没权限模拟 → 一次 codex exec（60 秒、强制网页搜索）：网页搜索被拒', async () => {
    const calls: Call[] = [];
    const c = parseIamPrecheck(await localBedrockCheckOutput(() => TOML, fakeRun(calls, {
      simDenied: true, codexCode: 1, codexOut: '{"type":"error","message":"Access denied: web search is not authorized for this identity."}',
    })));
    assert.equal(c.method, 'probe');
    assert.equal(c.webSearch, 'denied');
    assert.equal(c.model, 'ok');
    assert.equal(JSON.parse(c.policy!).Statement[0].Resource, 'arn:aws:bedrock-websearch:eu-west-1:aws:tool/*');
    const probe = calls.find((x) => x.tool === 'codex')!;
    assert.equal(probe.timeoutMs, 60_000);
    assert.deepEqual(probe.args.slice(0, 2), ['exec', '--ephemeral']);
    assert.ok(probe.args.includes('web_search=live'));
  });

  test('本机没装 aws：直接试调用；试调用超时 → 判不了', async () => {
    const calls: Call[] = [];
    const c = parseIamPrecheck(await localBedrockCheckOutput(() => TOML, fakeRun(calls, { aws: false, codexOut: '', codexCode: 1, codexTimeout: true })));
    assert.equal(c.model, 'unknown');
    assert.equal(c.webSearch, 'unknown');
    assert.match(c.note || '', /AWS CLI/);
    assert.match(c.note || '', /60/);
  });

  test('aws 和 codex 都没有', async () => {
    const c = parseIamPrecheck(await localBedrockCheckOutput(() => TOML, fakeRun([], { aws: false })));
    assert.equal(c.method, 'none');
    assert.ok(c.note);
  });
});

describe('接线（源码断言）', () => {
  test('本机：引擎状态、会话启动、报错卡的身份、关网页搜索都走本机那条路', () => {
    const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
    /* 预检：本机键 'local'，用 localBedrockCheckOutput + runLocalTool（不经 bash） */
    assert.match(M, /const key = remote \? bedrockCheckKey\(remote\) : 'local';/);
    assert.match(M, /: localBedrockCheckOutput\(\(\) => \{ try \{ return fs\.readFileSync\(LOCAL_CODEX_TOML\(\), 'utf-8'\); \} catch \{ return ''; \} \}, runLocalTool\);/);
    /* 本机引擎状态也查、也挂结果 */
    const loc = M.slice(M.indexOf('async function localEngineStatuses('), M.indexOf('async function remoteEngineStatusesFor('));
    assert.match(loc, /const check = ensureBedrockCheck\(undefined, force\)/);
    assert.match(M, /statuses = await localEngineStatuses\(force\);/);
    assert.match(M, /function withBedrockStatuses\(machine: string, statuses: EngineStatus\[\]\): EngineStatus\[\] \{\n\s*const check = bedrockChecks\.get\(machine\);/);
    /* 本机 Codex 会话启动时也查 */
    assert.match(M, /if \(engine === 'codex' && sessionId\) precheckCodexBedrock\(sessionId, profile\.remote\?\.sshHost \? profile\.remote : undefined\);/);
    /* 报错卡：本机也问身份；机器 id 是 'local'（卡上才有「关掉网页搜索」） */
    const fn = M.slice(M.indexOf('async function noteBedrockDenied('), M.indexOf('/* ─────────────── 模型自己安排的'));
    assert.match(fn, /const id = await runLocalTool\('aws', \['sts', 'get-caller-identity', '--query', 'Arn', '--output', 'text'\], 15_000\);/);
    assert.match(fn, /deniedNoteGroup\(\{ machineId: remote \? target\?\.id : 'local', region, actions: denied\.actions, \.\.\.\(denied\.resource \? \{ resource: denied\.resource \} : \{\}\) \}\)\)/);
    /* 关网页搜索：'local' 写本机 ~/.codex/config.toml（备份 + 临时文件 + rename） */
    const ws = M.slice(M.indexOf("ipcMain.handle('ai-login:codex-web-search'"));
    assert.match(ws, /if \(machine === 'local'\) \{\n\s*const file = LOCAL_CODEX_TOML\(\);/);
    assert.match(ws, /fs\.copyFileSync\(file, `\$\{file\}\.kirolex-bak`\);/);
    assert.match(ws, /fs\.writeFileSync\(tmp, text, \{ mode: 0o600 \}\);\n\s*fs\.renameSync\(tmp, file\);/);
    /* 卡上按钮只要有机器 id 就显示（本机是 'local'） */
    const C = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'components', 'ChatArea.tsx'), 'utf8');
    assert.match(C, /\{webSearch && g\.machineId && \(/);
    assert.equal(parseDeniedNoteGroup(deniedNoteGroup({ machineId: 'local', region: 'eu-west-1', actions: WEB_SEARCH_ACTIONS }))?.machineId, 'local');
  });

  const read = (...p: string[]): string => fs.readFileSync(path.join(import.meta.dirname, '..', ...p), 'utf8');

  test('remote-bootstrap.sh 结尾打印 Codex Bedrock 权限检查（只读，不改 IAM）', () => {
    const SH = read('scripts', 'remote-bootstrap.sh');
    const at = SH.indexOf('step "自检"');
    const block = SH.slice(at);
    assert.ok(at > 0);
    assert.match(block, /aws sts get-caller-identity/);
    assert.match(block, /aws iam simulate-principal-policy/);
    assert.match(block, /timeout 60 codex exec/);
    assert.match(block, /say "Codex Bedrock 权限: 模型调用 \$\(kx_mark "\$KX_MV"\) · 网页搜索 \$\(kx_mark "\$KX_WV"\)/);
    for (const a of [...MODEL_ACTIONS, ...WEB_SEARCH_ACTIONS]) assert.ok(block.includes(a), a);
    assert.match(block, /arn:aws:bedrock-websearch:\$\{KX_REGION\}:aws:tool\/\*/);
    assert.doesNotMatch(SH, /aws iam (put|attach|create|update|delete)-/i);
    assert.ok(!SH.includes('\r\n'));
  });

  test('remote-bootstrap.sh 那一段在 bash 里跑（假的 aws：模拟出网页搜索被拒）', (t) => {
    try { execFileSync('bash', ['-c', 'true']); } catch { t.skip('没有 bash'); return; }
    const SH = read('scripts', 'remote-bootstrap.sh');
    const from = SH.indexOf('# Codex 走 Bedrock 时的 IAM 权限');
    const to = SH.indexOf('\nsay ""\nif [ "$rc" -eq 0 ]', from);
    assert.ok(from > 0 && to > from);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-iamsh-'));
    try {
      const bin = path.join(dir, 'bin');
      fs.mkdirSync(bin);
      fs.mkdirSync(path.join(dir, '.codex'));
      fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), 'model_provider = "amazon-bedrock"\n\n[model_providers.amazon-bedrock.aws]\nregion = "ap-northeast-1"\n');
      fs.writeFileSync(path.join(bin, 'aws'), [
        '#!/bin/sh',
        'case "$1 $2" in',
        '  "sts get-caller-identity") echo "arn:aws:sts::123456789012:assumed-role/kx-role/i-1" ;;',
        '  "iam get-role") exit 255 ;;',
        '  "iam simulate-principal-policy") printf "bedrock-mantle:CreateInference\tallowed\nbedrock-websearch:InvokeSearch\timplicitDeny\nbedrock-websearch:InvokeFetch\timplicitDeny\nbedrock-websearch:ExternalWebAccess\timplicitDeny\n" ;;',
        'esac',
      ].join('\n'), { mode: 0o755 });
      fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const script = path.join(dir, 'blk.sh');
      fs.writeFileSync(script, `say() { printf '%s\\n' "$*"; }\nhave() { command -v "$1" >/dev/null 2>&1; }\nfull() { true; }\n${SH.slice(from, to)}\n`);
      const toPosix = (p: string): string => p.replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/');
      const out = execFileSync('bash', ['-c', 'export HOME="$1" PATH="$2:/usr/bin:/bin"; bash "$3" </dev/null 2>&1', 'x', toPosix(dir), toPosix(bin), toPosix(script)], { encoding: 'utf8' });
      assert.match(out, /Codex Bedrock 权限: 模型调用 ✓ · 网页搜索 ✗/);
      assert.match(out, /身份 arn:aws:iam::123456789012:role\/kx-role/);
      const json = out.slice(out.indexOf('{\n'), out.indexOf('\n}\n') + 2);
      const p = JSON.parse(json);
      assert.deepEqual(p.Statement[0].Action, WEB_SEARCH_ACTIONS);
      assert.equal(p.Statement[0].Resource, 'arn:aws:bedrock-websearch:ap-northeast-1:aws:tool/*');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('remote-bootstrap.sh：只按 tool/* 授权网页搜索时判 ✓（网页搜索按配置区域的资源模拟）', (t) => {
    try { execFileSync('bash', ['-c', 'true']); } catch { t.skip('没有 bash'); return; }
    const SH = read('scripts', 'remote-bootstrap.sh');
    const from = SH.indexOf('# Codex 走 Bedrock 时的 IAM 权限');
    const to = SH.indexOf('\nsay ""\nif [ "$rc" -eq 0 ]', from);
    assert.match(SH.slice(from, to), /--resource-arns "arn:aws:bedrock-websearch:\$\{KX_REGION\}:aws:tool\/\*"/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-iamsh2-'));
    try {
      const bin = path.join(dir, 'bin');
      fs.mkdirSync(bin);
      fs.mkdirSync(path.join(dir, '.codex'));
      fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), 'model_provider = "amazon-bedrock"\n\n[model_providers.amazon-bedrock.aws]\nregion = "ap-northeast-1"\n');
      fs.writeFileSync(path.join(bin, 'aws'), [
        '#!/bin/sh',
        'case "$1 $2" in',
        '  "sts get-caller-identity") echo "arn:aws:sts::123456789012:assumed-role/kx-role/i-1" ;;',
        '  "iam get-role") echo "arn:aws:iam::123456789012:role/kx-role" ;;',
        '  "iam simulate-principal-policy")',
        '    ok=implicitDeny',
        '    case "$*" in *"--resource-arns arn:aws:bedrock-websearch:ap-northeast-1:aws:tool/*"*) ok=allowed ;; esac',
        '    for a in "$@"; do case "$a" in',
        '      bedrock-mantle:*) printf "%s\\tallowed\\n" "$a" ;;',
        '      bedrock-websearch:*) printf "%s\\t%s\\n" "$a" "$ok" ;;',
        '    esac; done ;;',
        'esac',
      ].join('\n'), { mode: 0o755 });
      fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const script = path.join(dir, 'blk.sh');
      fs.writeFileSync(script, `say() { printf '%s\\n' "$*"; }\nhave() { command -v "$1" >/dev/null 2>&1; }\nfull() { true; }\n${SH.slice(from, to)}\n`);
      const toPosix = (p: string): string => p.replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/');
      const out = execFileSync('bash', ['-c', 'export HOME="$1" PATH="$2:/usr/bin:/bin"; bash "$3" </dev/null 2>&1', 'x', toPosix(dir), toPosix(bin), toPosix(script)], { encoding: 'utf8' });
      assert.match(out, /Codex Bedrock 权限: 模型调用 ✓ · 网页搜索 ✓ {3}（IAM 策略模拟/);
      assert.doesNotMatch(out, /缺:/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('index.ts：Codex 一轮被拒 → 提示卡 + 一句人话；预检 / 关网页搜索两条 IPC；不调用改 IAM 的接口', () => {
    const M = read('src', 'main', 'index.ts');
    assert.match(M, /const deniedMsg = await noteBedrockDenied\(sessionId, entry\.profile, `\$\{err\?\.message \|\| ''\}\$\{detail\}`\);\n\s*if \(deniedMsg\) throw new Error\(deniedMsg\);/);
    assert.match(M, /deniedNoteGroup\(\{ machineId: remote \? target\?\.id : 'local', region, actions: denied\.actions, \.\.\.\(denied\.resource \? \{ resource: denied\.resource \} : \{\}\) \}\)\)/);
    assert.match(M, /ipcMain\.handle\('ai-login:bedrock-check'/);
    assert.match(M, /\? runRemoteCapture\(remote, bedrockCheckScript\(\), 120_000\)\n/);
    assert.match(M, /const job = run\.then\(\(out\) => \{\n\s*const check = parseIamPrecheck\(out\);\n\s*bedrockChecks\.set\(key, check\);/);
    assert.match(M, /const check = await ensureBedrockCheck\(remote, !!opts\?\.force\);/);
    assert.match(M, /ipcMain\.handle\('ai-login:codex-web-search'/);
    assert.match(M, /await toggleCodexWebSearch\(async \(\) => parseRemoteConfigRead\(/);
    assert.match(M, /viaBedrock: true/);
    const P = read('src', 'main', 'preload.ts');
    assert.match(P, /aiLoginBedrockCheck: .*'ai-login:bedrock-check'/);
    assert.match(P, /aiLoginCodexWebSearch: .*'ai-login:codex-web-search'/);
  });

  test('预检不依赖登录页：引擎检测、远程 Codex 起执行器时都会跑，结果挂到引擎状态上', () => {
    const M = read('src', 'main', 'index.ts');
    const st = M.slice(M.indexOf('async function remoteEngineStatusesFor('), M.indexOf('async function engineStatusesFor('));
    assert.match(st, /if \(statuses\.some\(\(s\) => s\.engine === 'codex' && s\.state === 'ok'\)\) \{\n\s*const check = ensureBedrockCheck\(target, force\)/);
    assert.match(M, /statuses = await remoteEngineStatusesFor\(target, force\);/);
    assert.match(M, /return \{ ok: true, statuses: withBedrockStatuses\(key, await engineStatusesFor\(key, !!opts\?\.force\)\) \};/);
    assert.match(M, /if \(engine === 'codex' && sessionId\) precheckCodexBedrock\(sessionId, profile\.remote\?\.sshHost \? profile\.remote : undefined\);/);
    const pre = M.slice(M.indexOf('function precheckCodexBedrock('), M.indexOf('async function noteBedrockDenied('));
    assert.match(pre, /store\.readTranscript\(sessionId\)\.some\(\(m: any\) => m\?\.kirolex && m\.noteGroup === group\)\) return;/);
    assert.match(pre, /noteInSession\(sessionId, trConcat\(main, NOTE_DETAIL_SEP, detail\), undefined, group\);/);
    const P = read('src', 'renderer', 'components', 'EngineStatusPanel.tsx');
    assert.match(P, /\{e === 'codex' && s\?\.bedrock && <BedrockLine b=\{s\.bedrock\} \/>\}/);
  });

  test('报错卡的区域：没有预检结果时读那台机器 config.toml 里的实际区域（不是写死 us-east-1）', () => {
    const M = read('src', 'main', 'index.ts');
    const fn = M.slice(M.indexOf('async function noteBedrockDenied('), M.indexOf('/* ─────────────── 模型自己安排的'));
    assert.match(fn, /let region = cached && !cached\.notBedrock \? cached\.region : undefined;/);
    assert.match(fn, /if \(\(!roleArn \|\| !region\) && remote\) \{/);
    assert.match(fn, /cat ~\/\.codex\/config\.toml 2>\/dev\/null \|\| true', 15_000\)/);
    assert.match(fn, /region = bedrockRegionOf\(out\.slice\(at \+ 'KX_IAM_TOML'\.length\)\)/);
    assert.match(fn, /region = region \|\| denied\.region \|\| BEDROCK_DEFAULTS\.codex\.region;/);
    /* 读出来的区域就是策略里网页搜索资源的区域 */
    assert.equal(bedrockRegionOf('model_provider = "amazon-bedrock"\n[model_providers.amazon-bedrock.aws]\nregion = "eu-west-1"\n'), 'eu-west-1');
    assert.equal(bedrockRegionOf(''), 'us-east-1');
    assert.match(minimalPolicy(WEB_SEARCH_ACTIONS, bedrockRegionOf('[model_providers.amazon-bedrock.aws]\nregion = "eu-west-1"\n')), /arn:aws:bedrock-websearch:eu-west-1:aws:tool\/\*/);
  });

  test('界面：会话里的提示卡能关闭；登录页 / 引擎面板显示预检结果', () => {
    const C = read('src', 'renderer', 'components', 'ChatArea.tsx');
    assert.match(C, /group\.kind === 'kirolex' && parseDeniedNoteGroup\(group\.message\.noteGroup\) \? \(\n\s*<BedrockDeniedCard/);
    /* 关闭 / 不再提醒用统一机制（noticeDismiss.ts），不再自己读写 kirolex-dismissed-notes */
    const card = C.slice(C.indexOf('const BedrockDeniedCard = memo'), C.indexOf('// Kiro CLI does not expose exact per-turn token counts'));
    assert.match(card, /const hide = useSyncExternalStore\(noticeHideStore\.subscribe, noticeHideStore\.get\);/);
    assert.match(card, /if \(!g \|\| isNoticeHidden\(\{ id: message\.id, noteGroup: message\.noteGroup \}, hide\)\) return null;/);
    assert.ok(card.indexOf('useSyncExternalStore(') < card.indexOf('return null'), 'hooks 在提前 return 之前');
    assert.match(card, /className="kirolex-message-close"\s*onClick=\{\(\) => dismissNotice\(message\.id\)\}/);
    assert.match(card, /onClick=\{\(\) => muteNotice\(message\.noteGroup\)\}/);
    assert.doesNotMatch(C, /kirolex-dismissed-notes|function dismissNote\(|readDismissedNotes/);
    assert.match(C, /<PolicyBox policy=\{deniedCardPolicy\(message\.noteGroup\)!\} \/>/);
    assert.match(C, /<WebSearchToggle machine=\{g\.machineId\} disabled=\{false\} \/>/);
    const L = read('src', 'renderer', 'components', 'LoginSettings.tsx');
    assert.match(L, /tool === 'codex' && status\?\.installed && status\.viaBedrock && <BedrockCheckRow machine=\{machine\} initial=\{status\.bedrock\} \/>/);
    const B = read('src', 'renderer', 'components', 'BedrockIam.tsx');
    assert.match(B, /t\('Model calls \{m\}', \{ m: mark\(check\.model\) \}\)/);
    assert.match(B, /t\('Web search \{m\}', \{ m: mark\(check\.webSearch\) \}\)/);
  });
});
