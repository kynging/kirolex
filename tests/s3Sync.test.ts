import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signRequest, canonicalUri, canonicalQuery, amzDates } from '../src/main/awsSigV4.ts';
import { parseS3ErrorCode, hintFor } from '../src/main/s3Client.ts';
import {
  planUpload, keyFor, relFor, walk, contentTypeFor, mergeCatalog, joinPrefix, catalogKey,
  readState, writeState, maskKeyId, trashDirFor,
  SESSION_FILES, SHARED_DIRS, MAX_FILE_BYTES, LAYOUT, DEFAULT_INTERVAL_MINUTES,
} from '../src/main/s3Sync.ts';

/*
 * 「加一个定时向 S3 同步的功能，然后用户可以选择哪个会话恢复回本地，S3 认证用 AKSK」。
 *
 * 为什么手写签名而不装 `@aws-sdk/client-s3`：这个 app 的运行时依赖一共 12 个，而要用的只是
 * 三个纯 REST 操作（Put/Get/List）；SDK 会往 Electron 包里塞几十个包，而它的分片上传、重试策略、
 * 凭证链这里一个都用不到。
 *
 * 代价是签名必须自己写对，而签错的表现是 403 `SignatureDoesNotMatch` —— 一种"看起来像凭证不对"
 * 的错（人会去换 AKSK，而问题在代码里）。所以下面这条向量是**用 botocore 算出来的**，
 * 不是我凭记忆写的：同一个 key、同一时间、同一组签名头，botocore 和这里必须一模一样。
 * （第一版我按记忆写了个"期望值"、对不上 —— 原因是那个示例 key 有 `+` 和 `/` 两个变体，
 *   我拿了 `+` 的 key 去配 `/` 的签名。换成批准的那个变体之后，botocore 和文档一致。）
 */
describe('SigV4 签名', () => {
  const VECTOR = {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    /* Code Defender 批准清单里的示例 secret（`git-defender config list --type "allowed secret"`）。
       AWS 文档里有 `+bPxRfiCY` 和 `/bPxRfiCY` 两个变体，批准的是后者 —— 用前者会被 pre-commit 拦下，
       而往 allowlist 里加例外只是把"仓库里有一串像密钥的东西"挪到了别处。 */
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    host: 'examplebucket.s3.amazonaws.com',
    now: new Date('2013-05-24T00:00:00Z'),
    region: 'us-east-1',
  };

  test('和 botocore 算出同一个签名（GET + range 头）', () => {
    const h = signRequest({
      method: 'GET', path: '/test.txt', headers: { range: 'bytes=0-9' },
      payload: Buffer.alloc(0), ...VECTOR,
    });
    assert.match(h.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request,/);
    assert.match(h.Authorization, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,/);
    /* botocore 对同一请求（含 x-amz-content-sha256）给出的就是这一串，而它也正是 AWS 文档
       "Example: GET Object" 里印着的那个签名 —— 两个独立来源对上了 */
    assert.match(h.Authorization, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
  });

  test('空 payload 的 sha256 要真算，不是 UNSIGNED-PAYLOAD', () => {
    const h = signRequest({ method: 'GET', path: '/x', payload: Buffer.alloc(0), ...VECTOR });
    /* S3 要求这个头参与签名，而某些 bucket 策略会拒 UNSIGNED-PAYLOAD */
    assert.equal(h['x-amz-content-sha256'], 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  test('路径**逐段**编码，`/` 保持原样', () => {
    /* 整体 encodeURIComponent 会把 `/` 变成 %2F —— 签出来就不是那个 key 了 */
    assert.equal(canonicalUri('/a/b c/d.json'), '/a/b%20c/d.json');
    assert.equal(canonicalUri('/kirolex/v1/sessions/s_1/record.json'), '/kirolex/v1/sessions/s_1/record.json');
    /* encodeURIComponent 漏掉的那几个字符要补上（名字里带它们的对象否则签失败） */
    assert.equal(canonicalUri("/a(1)'.png"), '/a%281%29%27.png');
  });

  test('query 按 key 排序，value 也编码', () => {
    assert.equal(canonicalQuery({ prefix: 'a/b', 'list-type': '2' }), 'list-type=2&prefix=a%2Fb');
    assert.equal(canonicalQuery({}), '');
  });

  test('时间戳格式（`20130524T000000Z` / `20130524`）', () => {
    const { amzDate, dateStamp } = amzDates(new Date('2013-05-24T00:00:00.123Z'));
    assert.equal(amzDate, '20130524T000000Z');
    assert.equal(dateStamp, '20130524');
  });

  test('临时凭证要带 security token 并且参与签名', () => {
    const h = signRequest({ method: 'GET', path: '/x', payload: Buffer.alloc(0), sessionToken: 'TOK', ...VECTOR });
    assert.equal(h['x-amz-security-token'], 'TOK');
    assert.match(h.Authorization, /x-amz-security-token/);
  });
});

/*
 * S3 的失败都是"状态码 + 一小段 XML"，而这几类的**处理方式完全不同**。全都报成"上传失败"
 * 等于让人一个个猜 —— 尤其 `SignatureDoesNotMatch`，它看起来最像"AKSK 填错了"，
 * 而实际上换密钥完全没用（那是时钟或 region）。
 */
describe('S3 错误要说清是哪一类', () => {
  test('从 XML 里取 Code', () => {
    assert.equal(parseS3ErrorCode('<Error><Code>AccessDenied</Code></Error>'), 'AccessDenied');
    assert.equal(parseS3ErrorCode('not xml'), '');
  });

  test('签名不匹配**不是**让人去换密钥', () => {
    const h = hintFor(403, 'SignatureDoesNotMatch');
    assert.match(h, /\*\*不是\*\* AKSK 写错/);
    assert.match(h, /时钟/);
    assert.match(h, /region/);
  });

  test('301 要把 S3 告诉我们的真实 region 说出来', () => {
    const h = hintFor(301, 'PermanentRedirect', '<Error><Region>ap-northeast-1</Region></Error>');
    assert.match(h, /ap-northeast-1/);
  });

  test('AccessDenied 指向权限，不指向代码', () => {
    assert.match(hintFor(403, 'AccessDenied'), /s3:PutObject/);
  });
});

/*
 * **同步范围是白名单** —— 镜像时代踩过一次：判据是"把工作目录推上去"，结果一条 cwd 是 `~`
 * 的会话把整个家目录推了上去（2.6 → 6.1 GB，含 `.aws/credentials`、`.aws/sso/cache`、17 把 `.pem`）。
 * 所以这里每一项都要能说出"恢复时需要它"，而 `config.json` / 日志 / 预览一律不上传。
 */
describe('同步计划', () => {
  const mk = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-s3-'));
    fs.mkdirSync(path.join(root, 'sessions', 's_1'), { recursive: true });
    for (const f of SESSION_FILES) fs.writeFileSync(path.join(root, 'sessions', 's_1', f), 'x');
    fs.writeFileSync(path.join(root, 'sessions', 's_1', 'events.jsonl'), 'nope');
    fs.mkdirSync(path.join(root, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(root, 'memory', 'global.md'), 'm');
    fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'logs', 'main.log'), 'log');
    fs.writeFileSync(path.join(root, 'config.json'), '{}');
    return root;
  };

  test('只收白名单里的东西 —— config.json / 日志一个都不传', () => {
    const root = mk();
    const { upload } = planUpload(root, ['s_1'], {});
    assert.ok(upload.includes(path.join('sessions', 's_1', 'record.json')));
    assert.ok(upload.includes(path.join('memory', 'global.md')));
    assert.equal(upload.some((r) => r.includes('config.json')), false, 'config.json 里是这台机器的路径和远端主机');
    assert.equal(upload.some((r) => r.startsWith('logs')), false);
    /* 会话目录里也只拿那三个文件 —— events.jsonl / last-injection.md 恢复时不需要 */
    assert.equal(upload.some((r) => r.endsWith('events.jsonl')), false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('没变的跳过（按大小 + 修改时间）', () => {
    const root = mk();
    const first = planUpload(root, ['s_1'], {});
    const state: Record<string, { size: number; mtimeMs: number }> = {};
    for (const rel of first.upload) {
      const st = fs.statSync(path.join(root, rel));
      state[rel] = { size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
    }
    const second = planUpload(root, ['s_1'], state);
    assert.equal(second.upload.length, 0);
    assert.equal(second.skippedUnchanged, first.upload.length);

    /* 改了内容（大小变了）就要重传 */
    fs.writeFileSync(path.join(root, 'memory', 'global.md'), 'much longer content');
    assert.ok(planUpload(root, ['s_1'], state).upload.includes(path.join('memory', 'global.md')));
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('太大的跳过，并且**说出来**（否则一个永远没备份的文件会一直沉默）', () => {
    const root = mk();
    const big = path.join(root, 'memory', 'huge.bin');
    fs.writeFileSync(big, Buffer.alloc(MAX_FILE_BYTES + 1));
    const plan = planUpload(root, ['s_1'], {});
    assert.ok(plan.skippedTooBig.includes(path.join('memory', 'huge.bin')));
    assert.equal(plan.upload.includes(path.join('memory', 'huge.bin')), false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('目录不存在不是错误（没有 pasted/ 很正常）', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-s3b-'));
    assert.deepEqual(walk(root, 'pasted'), []);
    assert.deepEqual(planUpload(root, [], {}).upload, []);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('共享的那几棵树就是用户选的那三类', () => {
    assert.deepEqual(SHARED_DIRS, ['memory', 'attachments', 'pasted']);
    assert.deepEqual(SESSION_FILES, ['record.json', 'transcript.jsonl', 'history.md']);
  });
});

describe('key 布局', () => {
  test('带版本前缀 —— 以后改布局，老数据不会被当成损坏的读', () => {
    assert.equal(keyFor('kirolex', path.join('sessions', 's_1', 'record.json')), `kirolex/${LAYOUT}/sessions/s_1/record.json`);
    assert.equal(keyFor('', 'memory/a.md'), `${LAYOUT}/memory/a.md`);
    assert.equal(joinPrefix('/a/b/'), 'a/b/');
    assert.equal(catalogKey('kirolex'), `kirolex/${LAYOUT}/catalog.json`);
  });

  test('key → 本地路径是 keyFor 的逆，并且**挡住 `../`**', () => {
    assert.equal(relFor('kirolex', `kirolex/${LAYOUT}/memory/a.md`), path.join('memory', 'a.md'));
    /* key 是远端来的数据：`../` 会让恢复写到 ~/.kirolex 之外 */
    assert.equal(relFor('kirolex', `kirolex/${LAYOUT}/../../../etc/passwd`), null);
    assert.equal(relFor('kirolex', `other/${LAYOUT}/memory/a.md`), null, '不属于这个布局的一律不认');
    assert.equal(relFor('kirolex', `kirolex/${LAYOUT}/`), null);
  });

  test('content-type 只为了控制台里点开能看', () => {
    assert.equal(contentTypeFor('a/record.json'), 'application/json');
    assert.match(contentTypeFor('a/history.md'), /^text\/markdown/);
    assert.equal(contentTypeFor('a/t.jsonl'), 'application/x-ndjson');
    assert.equal(contentTypeFor('a/x.bin'), 'application/octet-stream');
  });
});

describe('恢复目录（catalog）', () => {
  test('同 id 用新的那条，按更新时间倒序', () => {
    const old = { version: 1 as const, entries: [
      { id: 'a', title: '旧 A', updatedAt: 1, bytes: 1, syncedAt: 1 },
      { id: 'b', title: 'B', updatedAt: 5, bytes: 1, syncedAt: 1 },
    ] };
    const merged = mergeCatalog(old, [{ id: 'a', title: '新 A', updatedAt: 9, bytes: 2, syncedAt: 2 }]);
    assert.deepEqual(merged.entries.map((e) => e.id), ['a', 'b']);
    assert.equal(merged.entries[0].title, '新 A');
  });

  test('别的机器备份的条目不会被本机这一轮抹掉', () => {
    /* 多台机器往同一个桶备份时，本机的 catalog 里没有另一台的会话 —— 合并而不是替换 */
    const old = { version: 1 as const, entries: [{ id: 'other', title: '另一台的', updatedAt: 2, bytes: 1, syncedAt: 1, from: 'abc-mac2' }] };
    const merged = mergeCatalog(old, [{ id: 'mine', title: '我的', updatedAt: 3, bytes: 1, syncedAt: 2 }]);
    assert.deepEqual(merged.entries.map((e) => e.id), ['mine', 'other']);
  });

  test('没有旧 catalog 也能合（第一次同步）', () => {
    assert.equal(mergeCatalog(null, [{ id: 'a', title: 'A', updatedAt: 1, bytes: 1, syncedAt: 1 }]).entries.length, 1);
  });
});

describe('状态文件与杂项', () => {
  test('状态文件坏了当空 —— 备份不该因为它停掉', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kx-s3c-')), 'state.json');
    assert.deepEqual(readState(f), {});
    fs.writeFileSync(f, '{ broken');
    assert.deepEqual(readState(f), {});
    writeState(f, { 'a': { size: 1, mtimeMs: 2 } });
    assert.deepEqual(readState(f), { a: { size: 1, mtimeMs: 2 } });
  });

  test('日志里只露 access key 的后 4 位', () => {
    assert.equal(maskKeyId('AKIAIOSFODNN7EXAMPLE'), '****MPLE');
    assert.equal(maskKeyId(''), '****');
  });

  test('覆盖前挪进 trash —— "选了覆盖"不等于"愿意丢掉"', () => {
    const d = trashDirFor('/root', 's_1', new Date('2026-09-25T08:09:10Z'));
    assert.match(d, /trash[/\\]restore-20260925-080910[/\\]s_1$/);
  });

  test('默认间隔 30 分钟（会话是聊出来的，丢 30 分钟等于丢一两轮）', () => {
    assert.equal(DEFAULT_INTERVAL_MINUTES, 30);
  });
});

/*
 * 接线上的几条硬约束。它们都是"错了不会报错、只会安静地泄漏或丢数据"的那类。
 */
describe('接线', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const P = fs.readFileSync(path.join(process.cwd(), 'src/main/preload.ts'), 'utf8');
  const UI = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/S3BackupSettings.tsx'), 'utf8');

  test('secret 用 safeStorage 加密，没有 keychain 就**拒绝保存**而不是退回明文', () => {
    assert.match(M, /safeStorage\.encryptString/);
    assert.match(M, /拒绝把 secret 明文写进配置/);
    /* 明文既不落盘也不回渲染层 */
    assert.match(M, /hasSecret: !!cfg\.secretCipher/);
    assert.equal(/secretAccessKey: cfg\.secretAccessKey/.test(M), false);
  });

  test('保存遵守"键在 input 里才动它" —— 漏传一个字段不等于清空它', () => {
    const at = M.indexOf("ipcMain.handle('s3:save-config'");
    const body = M.slice(at, at + 2200);
    assert.match(body, /input\?\.bucket !== undefined \? \{ bucket/);
    /* secret 空 = 不改；要清掉有单独的 flag */
    assert.match(body, /input\?\.secretAccessKey === 'string' && input\.secretAccessKey\.trim\(\)/);
    assert.match(body, /input\?\.clearSecret/);
  });

  test('测连通是真的**写**一个对象 —— ListBucket 通不代表 PutObject 通', () => {
    const at = M.indexOf("ipcMain.handle('s3:test'");
    /* 判据那段注释在 handle **上面**，所以往前也要看 */
    const body = M.slice(at - 900, at + 1400);
    assert.match(body, /putObject/);
    assert.match(body, /getObject/);
    assert.match(body, /是两条独立的权限/);
    /* 写进去再读回来对比 —— 桶上可能有改写内容的策略 */
    assert.match(body, /内容不一致/);
  });

  test('catalog **最后**传：它是恢复的唯一入口，先传会指向还没上传完的东西', () => {
    const at = M.indexOf('async function runS3Sync');
    const body = M.slice(at, M.indexOf('rescheduleS3Sync', at));
    assert.ok(body.indexOf('for (const rel of plan.upload)') < body.indexOf('catalogKey('), 'catalog 要排在文件之后');
  });

  test('同步不可重入（定时器和按钮会同时点）', () => {
    assert.match(M, /if \(syncRunning\) return/);
    assert.match(M, /syncRunning = false;/);
  });

  test('失败也写状态：已经传上去的下次不必重传', () => {
    const at = M.indexOf('async function runS3Sync');
    const body = M.slice(at, M.indexOf('\n}', M.indexOf('finally', at)));
    const catchAt = body.indexOf('catch (err: any)');
    assert.ok(catchAt > 0);
    assert.match(body.slice(catchAt), /writeState\(S3_STATE_PATH, state\)/);
  });

  test('正连着的会话不许恢复（内存里那份会把它盖回去）', () => {
    const at = M.indexOf("ipcMain.handle('s3:restore'");
    const body = M.slice(at, at + 2400);
    assert.match(body, /sessionClients\.has\(sessionId\)/);
    assert.match(body, /先关掉它/);
    /* 会话 id 来自渲染层，要当输入校验（它会被拼进文件路径） */
    assert.ok(body.includes('会话 id 不合法'), '缺 id 校验');
    assert.ok(body.includes('w.-]+$'), '缺白名单正则');
    /* 覆盖前挪进 trash */
    assert.match(body, /trashDirFor/);
  });

  test('启动后补一轮，而不是退出前（崩溃/强杀不走退出回调）', () => {
    assert.match(M, /启动后补一轮/);
    assert.match(M, /崩溃和被 kill 根本不会走 before-quit/);
    /* 那一轮挂在 reveal 之后（窗口出来了、attach 风暴过去了） */
    const at = M.indexOf("ipcMain.handle('acp:reveal'");
    assert.match(M.slice(at, at + 1600), /runS3Sync\('启动后补一轮'\)/);
    /* 而**退出回调里没有**上传 —— 在同步回调里 await 会被直接丢掉 */
    const quitAt = M.lastIndexOf("app.on('before-quit'");
    assert.equal(/runS3Sync/.test(M.slice(quitAt, quitAt + 400)), false, '别指望退出回调里 await 上传');
  });

  test('preload 不提供任何拿回明文 secret 的路', () => {
    assert.match(P, /getS3Config: \(\) => ipcRenderer\.invoke\('s3:get-config'\)/);
    /* 没有任何"把 secret 读回来"的通道 —— 只有写进去那一条。
       只看**代码行**，注释里当然要谈这件事（那正是它存在的理由）。 */
    const code = P.split('\n').filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join('\n');
    assert.equal(/invoke\('s3:[a-z-]*secret/i.test(code), false);
    assert.equal(/getS3Secret|readS3Secret/.test(code), false);
    /* 主进程那边同样：回给界面的只有"填过了没有" */
    assert.match(M, /hasSecret: !!cfg\.secretCipher/);
  });

  test('界面：覆盖前要确认，并且说清挪进 trash', () => {
    assert.match(UI, /window\.confirm/);
    assert.match(UI, /覆盖/);
    assert.match(UI, /trash/);
    /* secret 框平时是空的，空 = 不改 */
    assert.match(UI, /留空 = 不改/);
  });
});
