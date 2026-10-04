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
  detectConflicts, conflictKeyFor, backoffMultiplier, MAX_BACKOFF_MULTIPLIER,
  SESSION_FILES, SHARED_DIRS, MAX_FILE_BYTES, LAYOUT, DEFAULT_INTERVAL_MINUTES,
} from '../src/main/s3Sync.ts';
import type { CatalogEntry } from '../src/main/s3Sync.ts';

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
  /*
    两个界面：**配置**在设置里（`BackupSettings`），**恢复**在侧栏那颗 ☁️（`BackupDialog`）——
    「这个备份的配置放回设置中…这个云按钮只保留恢复」。
  */
  const CONF = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/BackupSettings.tsx'), 'utf8');
  const UI = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/BackupDialog.tsx'), 'utf8');

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

  test('测连通是真的**写**一个对象，而且写完删掉', () => {
    const at = M.indexOf("ipcMain.handle('s3:test'");
    /* 判据那段注释在 handle **上面**，所以往前也要看 */
    const body = M.slice(at - 900, at + 2200);
    assert.match(body, /putObject/);
    assert.match(body, /getObject/);
    assert.match(body, /是两条独立的权限/);
    /* 写进去再读回来对比 —— 桶上可能有改写内容的策略 */
    assert.match(body, /内容不一致/);
    /*
      「测试应该是写完然后删除」—— 留着那个 `.kirolex-write-test` 是往用户桶里扔垃圾，
      桶开了版本控制的话每次测还会攒一个版本。
    */
    assert.match(body, /await deleteObject\(creds!, key\);/);
    /* 但删不掉**不算测试失败**：要证明的"能读能写"已经成立了。只是必须说出来。 */
    assert.match(body, /leftover = /);
    assert.match(body, /没有 s3:DeleteObject/);
    assert.ok(body.indexOf('const back = await getObject') < body.indexOf('await deleteObject'),
      '先验证内容，再删 —— 反过来就没东西可读了');
  });

  test('S3 的 DELETE 对不存在的 key 也算成功（幂等清理）', async () => {
    const C = fs.readFileSync(path.join(process.cwd(), 'src/main/s3Client.ts'), 'utf8');
    assert.match(C, /export async function deleteObject/);
    /* 204 就是成功，所以 `check` 直接用；重复调用不会变成错误 */
    assert.match(C, /request\(creds, 'DELETE', `\/\$\{key\}`/);
  });

  test('按钮上不再写"真写一个小对象" —— 它不留痕迹了，那句是噪音', () => {
    const CONF2 = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/BackupSettings.tsx'), 'utf8');
    assert.equal(/测连通（真写一个小对象）/.test(CONF2), false);
    assert.match(CONF2, /'测连通'/);
  });

  test('catalog **最后**传：它是恢复的唯一入口，先传会指向还没上传完的东西', () => {
    const at = M.indexOf('async function runS3Sync');
    const body = M.slice(at, M.indexOf('rescheduleS3Sync', at));
    /* **写** catalog 在文件之后。注意现在 catalog 还会被**先读一次**（冲突检测要在覆盖之前
       知道桶里是什么），所以判据是 `putObject(... catalogKey` 的位置，不是 `catalogKey(` 的位置。 */
    assert.ok(
      body.indexOf('for (const rel of plan.upload)') < body.indexOf('putObject(creds!, catalogKey('),
      '写 catalog 要排在文件之后',
    );
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

  test('连着的先自动断开再恢复；只有正在跑一轮的才拒', () => {
    /*
      「恢复的未分组里面怎么有这么多正连着」—— 启动预热会把未分组整组拉起来，
      原来一律拒、要人手动去断开。现在恢复是合并，断开之后执行器不再写盘，安全。
      正在跑的那一轮还没落盘，那种才拒。
    */
    const at = M.indexOf("ipcMain.handle('s3:restore'");
    const body = M.slice(at, at + 3200);
    assert.match(body, /if \(live\?\.busy\)/);
    assert.match(body, /detachExecutor\(sessionId\)/);
    assert.ok(body.indexOf('live?.busy') < body.indexOf('detachExecutor(sessionId)'), '先判 busy 再断开');
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
    /* 本地已有的那些现在是**合并**（不是覆盖），所以措辞跟着改了 */
    assert.match(UI, /合并/);
    assert.match(UI, /trash/);
    /* secret 框平时是空的，空 = 不改 */
    assert.match(CONF, /留空 = 不改/);   /* secret 在配置那一页 */
  });
});

/*
 * 从 Tabby 那个云同步插件（`niceit/tabby-cloud-sync-settings` v1.8.0）借来的两条 ——
 * 它的 changelog 里写着 `Improved conflict detection, safe conflict backups, synchronization
 * pausing, and local snapshot recovery` 和 `improved retry behavior after repeated failures`。
 * 这两条都是我们原来没有的，而且都是"错了不报错、只会安静丢数据 / 安静刷日志"的那类。
 */
describe('冲突检测与失败退避（借 Tabby 的做法）', () => {
  const mine = (over: Partial<CatalogEntry> = {}): CatalogEntry =>
    ({ id: 's1', title: 'A', updatedAt: 100, bytes: 1, syncedAt: 1, ...over } as CatalogEntry);

  test('别的机器更新得更晚 → 算冲突', () => {
    const remote = { version: 1 as const, entries: [mine({ updatedAt: 200, from: 'other-mac' })] };
    const c = detectConflicts(remote, [mine({ updatedAt: 100, from: 'me' })], 'me');
    assert.deepEqual(c.map((e) => e.id), ['s1']);
  });

  test('自己上一轮传的不算冲突', () => {
    const remote = { version: 1 as const, entries: [mine({ updatedAt: 200, from: 'me' })] };
    assert.deepEqual(detectConflicts(remote, [mine({ updatedAt: 100, from: 'me' })], 'me'), []);
  });

  test('本机更新更晚 → 不算冲突（正常的往前推进）', () => {
    const remote = { version: 1 as const, entries: [mine({ updatedAt: 50, from: 'other-mac' })] };
    assert.deepEqual(detectConflicts(remote, [mine({ updatedAt: 100, from: 'me' })], 'me'), []);
  });

  test('老条目没记来源 → 不当冲突（否则第一次升级后全都变冲突）', () => {
    const remote = { version: 1 as const, entries: [mine({ updatedAt: 200, from: undefined })] };
    assert.deepEqual(detectConflicts(remote, [mine({ updatedAt: 100, from: 'me' })], 'me'), []);
  });

  test('冲突时本机那份走旁路 key，不盖对方的', () => {
    const k = conflictKeyFor('kirolex', 's1', 'me', path.join('sessions', 's1', 'record.json'));
    assert.equal(k, `kirolex/${LAYOUT}/conflicts/s1/me/sessions/s1/record.json`);
    /* 正常 key 和冲突 key 必须不同 —— 相同就等于没做这件事 */
    assert.notEqual(k, keyFor('kirolex', path.join('sessions', 's1', 'record.json')));
  });

  test('退避：翻倍、有上限、成功清零', () => {
    assert.equal(backoffMultiplier(0), 1);
    assert.equal(backoffMultiplier(1), 2);
    assert.equal(backoffMultiplier(2), 4);
    assert.equal(backoffMultiplier(3), 8);
    /* 有上限：桶名写错不该退避到几天后才重试一次 */
    assert.equal(backoffMultiplier(99), MAX_BACKOFF_MULTIPLIER);
  });

  test('接线：手动点「立即同步」不受退避限制', () => {
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    /* 人刚改完配置想马上验证 —— 让他等 4 小时是荒谬的 */
    assert.match(M, /if \(reason === '定时' && Date\.now\(\) < syncNextAllowedAt\)/);
    assert.match(M, /syncFailures = 0;\s*\n\s*syncNextAllowedAt = 0;/);
  });

  test('接线：catalog 在上传**之前**读 —— 读晚了已经盖掉对方了', () => {
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    const at = M.indexOf('async function runS3Sync');
    const body = M.slice(at, M.indexOf('rescheduleS3Sync', at));
    assert.ok(body.indexOf('detectConflicts(') < body.indexOf('for (const rel of plan.upload)'));
    /* 冲突的那几条不进 catalog：它们在 conflicts/ 下，让 catalog 指向它们就是把"可恢复"说错了 */
    assert.match(body, /freshEntries\.filter\(\(e\) => !conflictIds\.has\(e\.id\)\)/);
  });
});


/*
 * 「这个备份的配置放回设置中。我的意思是这个云按钮只保留恢复，这个界面应该展示所有已经备份的
 * 会话，然后留一个多选/恢复按钮即可」。
 *
 * 分工：**配置**在 设置 → ☁️ 备份（配一次就不用再看）；**恢复**在侧栏那颗 ☁️
 * （平时要回来看的那件事：桶里有哪些、要捞哪几条）。
 */
describe('备份分成两页：配置在设置，云按钮只管恢复', () => {
  const CONF = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/BackupSettings.tsx'), 'utf8');
  const UI = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/BackupDialog.tsx'), 'utf8');
  const SD = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/SettingsDialog.tsx'), 'utf8');
  const APP = fs.readFileSync(path.join(process.cwd(), 'src/renderer/App.tsx'), 'utf8');
  const CSS = fs.readFileSync(path.join(process.cwd(), 'src/renderer/styles/global.css'), 'utf8');

  test('配置回到设置里', () => {
    assert.match(SD, /\{ id: 'backup', label: '☁️ 备份' \}/);
    assert.match(SD, /\{tab === 'backup' && <BackupSettings \/>\}/);
    /* 桶 / 凭据 / 定时都在那一页 */
    for (const f of ['label="Bucket"', 'label="Region"', 'label="Access Key ID"', 'label="Secret"', '定时同步']) {
      assert.ok(CONF.includes(f), `配置页要有 ${f}`);
    }
  });

  test('云按钮那一页**没有任何配置** —— 它只管恢复', () => {
    for (const f of ['label="Bucket"', 'label="Region"', 'label="Access Key ID"',
      'label="Secret"', 'testS3', 'intervalMinutes']) {
      assert.equal(UI.includes(f), false, `恢复页不该有 ${f}`);
    }
    assert.match(APP, /onOpenBackup=\{\(\) => setShowBackup\(true\)\}/);
  });

  test('打开就列，不用先点一下', () => {
    /* 切到「恢复」那个 tab 就去拉，不用再点一次「列出桶里的会话」 */
    assert.match(UI, /if \(tab === 'restore' && !entries\) void loadBackups\(\);/);
    assert.match(UI, /listS3Backups/);
  });

  test('多选 + 一颗恢复按钮', () => {
    assert.match(UI, /const \[picked, setPicked\] = useState<Set<string>>/);
    /* 「选整组」那颗按钮删了（「选整组那个按钮是干毛线」）—— 要多选逐行勾就够了 */
    assert.equal(/toggleGroup/.test(UI), false);
    assert.match(UI, /恢复选中的/);
    /* 一条一条恢复：并发会同时写 trash 和 sessions，而失败要说清是哪一条 */
    assert.match(UI, /for \(const e of chosen\)/);
    assert.match(UI, /bad\.push\(`\$\{e\.title \|\| e\.id\}：/);
  });

  test('**一次**确认，而且把要覆盖的那几条点名', () => {
    /* 逐条确认的问题不是慢，是每次长得一样 —— 点到第五次就不看了，而其中可能有一条是覆盖 */
    /* 恢复那一页只确认一次；同步那一页删备份还有一次（那是另一个动作） */
    assert.equal((UI.match(/window\.confirm/g) || []).length, 2);
    assert.match(UI, /merging\.map\(\(e\) => `  · \$\{e\.title \|\| e\.id\}`\)/);
    /* 本地已有的那些现在是**合并**（见下面那个 describe），不是覆盖 */
    /* 原生 confirm 不认 markdown，所以这里用「」而不是 ** */
    assert.match(UI, /会和本地那份「合并」/);
    assert.match(UI, /不会真的丢/);
  });

  test('正在跑的不给勾 —— 主进程会拒，让人勾上再被拒是最差的', () => {
    assert.match(UI, /disabled=\{!!e\.busy \|\| !!busy\}/);
    assert.match(UI, /\(entries \|\| \[\]\)\.filter\(\(e\) => !e\.busy\)/);
    /* 这个标记是主进程给的（它才知道谁在跑） */
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    assert.match(M, /busy: !!sessionClients\.get\(e\.id\)\?\.busy/);
  });

  test('三种状态各有一个标，"哪几条会动到本地"要看得见', () => {
    assert.match(UI, /backup-tag warn">正在跑/);
    /* 本地已有的那些是**合并**（见下面那个 describe），所以这个标也跟着改了 */
    assert.match(UI, /backup-tag over">会合并/);
    assert.match(UI, /backup-tag new">本地没有/);
    /* 覆盖那个是这一页唯一有破坏性的，颜色要区分开 */
    assert.match(CSS, /\.backup-tag\.over \{[\s\S]{0,160}--warning/);
  });

  test('整行可点（label），列表自己滚', () => {
    /* 不是只能点那个 13px 的方块 */
    assert.match(UI, /<label\s+key=\{e\.id\}/);
    const at = CSS.indexOf('.backup-restore-list {');
    assert.ok(at > 0);
    assert.match(CSS.slice(at, at + 260), /overflow-y: auto;/);
  });

  test('间隔那几个选项在一个 `.ts` 里 —— 单测跑不了 .tsx', async () => {
    /* node 的 type-stripping 不认 `.tsx`（ERR_UNKNOWN_FILE_EXTENSION） */
    const { INTERVAL_CHOICES, intervalChoices, intervalLabel } =
      await import('../src/renderer/backupIntervals.ts');
    assert.equal(Math.min(...INTERVAL_CHOICES), 5, '不要比 5 分钟更频繁');
    assert.ok(INTERVAL_CHOICES.length <= 6, '"留几个选项就行"');
    assert.equal(intervalLabel(5), '5 分钟');
    assert.equal(intervalLabel(60), '1 小时');
    assert.equal(intervalLabel(1440), '1 天');
    /* 手改成 45 也要列出来，否则 select 显示空白、随手一选就把它改掉 */
    assert.deepEqual(intervalChoices(45), [5, 15, 30, 45, 60, 360, 1440]);
    /* 低于 5 的不收：主进程会钳掉，列出来等于承诺一个做不到的间隔 */
    assert.deepEqual(intervalChoices(1), [...INTERVAL_CHOICES]);
  });

  test('配置页：不放示例值、Key 前缀标可选且排最后、region 在 ak 前面', () => {
    for (const fake of ['my-kirolex-backup', 'ap-northeast-1', 'AKIA…', 'kirolex（可留空）']) {
      assert.equal(CONF.includes(`placeholder="${fake}"`), false, `${fake} 不该当 placeholder`);
    }
    assert.match(CONF, /label="Key 前缀（可选）"/);
    const idx = (x: string): number => CONF.indexOf(x);
    assert.ok(idx('label="Bucket"') < idx('label="Region"'));
    assert.ok(idx('label="Region"') < idx('label="Access Key ID"'), 'region 放在 ak 前面');
    assert.ok(idx('label="Access Key ID"') < idx('label="Secret"'));
    assert.ok(idx('label="Secret"') < idx('label="Key 前缀（可选）"'), '可选的那个放最后');
    /* 间隔是下拉，不是能敲任意数字的输入框 */
    assert.equal(/type="number"/.test(CONF), false);
    assert.match(CONF, /<select className="settings-select backup-interval"/);
  });

  test('侧栏那颗 ☁️ 的 tooltip 说清点开是恢复', () => {
    const SB = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/Sidebar.tsx'), 'utf8');
    assert.match(SB, /从备份恢复/);
  });
});

/*
 * 「另外备份是不是应该有合并的功能」→ 选了「真合并进同一条」。
 *
 * 为什么这件事**可以**做对：`transcript.jsonl` 是 append-only 的事件流，每行一个 JSON、
 * 每条带 `id` 和 `ts` —— 所以"按 id 去重、按 ts 排序"是精确答案，不是启发式。
 * `history.md` 是渲染产物（重建即可），只有 `record.json` 需要一条策略。
 */
describe('合并：桶里那份并进本地那条', () => {
  test('按 id 去重、按 ts 排序，本地的一条不丢', async () => {
    const { mergeTranscripts } = await import('../src/main/transcriptMerge.ts');
    const line = (id: string, ts: number, content = id) => JSON.stringify({ id, ts, role: 'user', content });
    const local = [line('a', 100), line('b', 300)].join('\n') + '\n';
    const remote = [line('b', 300), line('c', 200)].join('\n') + '\n';
    const r = mergeTranscripts(local, remote);
    const ids = r.text.trim().split('\n').map((l) => JSON.parse(l).id);
    assert.deepEqual(ids, ['a', 'c', 'b'], '按 ts 排序：100 < 200 < 300');
    assert.equal(r.added, 1, '只有 c 是新的');
    assert.equal(r.kept, 2);
    assert.equal(r.clashed, 0, 'b 两边一模一样，不算冲突');
  });

  test('同 id 不同内容 → **保留本地**，但要数出来', async () => {
    const { mergeTranscripts } = await import('../src/main/transcriptMerge.ts');
    const mine = JSON.stringify({ id: 'x', ts: 1, content: '我的' });
    const theirs = JSON.stringify({ id: 'x', ts: 1, content: '别人的' });
    const r = mergeTranscripts(`${mine}\n`, `${theirs}\n`);
    /* 悄悄用远端的覆盖掉用户眼前看到的内容是这里面最坏的结果 */
    assert.match(r.text, /我的/);
    assert.equal(/别人的/.test(r.text), false);
    assert.equal(r.clashed, 1, '"合并完少了一条"必须能解释');
  });

  test('在**原始行**上合并 —— 折叠后的视图会丢掉 mergeIntoMessageId 事件', async () => {
    const { mergeTranscripts, parseRawEvents } = await import('../src/main/transcriptMerge.ts');
    /*
      `readTranscript()` 会把这种事件折叠进它指向的那条用户消息里。在折叠后的视图上合并,
      这些事件就消失了 —— 合并回去的 transcript 少掉几段用户实际发过的内容，
      而且看不出来（文件完整、能解析、只是内容少了）。
    */
    const base = JSON.stringify({ id: 'u1', ts: 1, role: 'user', content: '第一段' });
    const patch = JSON.stringify({ id: 'u1b', ts: 2, role: 'user', content: '第二段', mergeIntoMessageId: 'u1' });
    const r = mergeTranscripts('', `${base}\n${patch}\n`);
    assert.equal(parseRawEvents(r.text).length, 2, '两条事件都要在');
    assert.match(r.text, /mergeIntoMessageId/);
    /* 而且那条 patch 必须排在它的目标之后 */
    assert.ok(r.text.indexOf('"u1"') < r.text.indexOf('u1b'));
  });

  test('原始行**原样保留**，不重新序列化', async () => {
    const { mergeTranscripts } = await import('../src/main/transcriptMerge.ts');
    /* re-stringify 会改字段顺序，也会让将来新增、这一版还不认识的字段承担风险 */
    const weird = '{"ts":5,"id":"z","未来字段":1,"content":"x"}';
    const r = mergeTranscripts('', `${weird}\n`);
    assert.equal(r.text.trim(), weird);
  });

  test('坏行和缺 id 的行丢掉，不让整份合并失败', async () => {
    const { mergeTranscripts } = await import('../src/main/transcriptMerge.ts');
    const good = JSON.stringify({ id: 'a', ts: 1 });
    const r = mergeTranscripts(`${good}\n{"ts":2`, '{"ts":3,"content":"没有 id"}\n');
    assert.equal(r.text.trim(), good, '末尾被截断的半行、以及没有 id 的行都丢掉');
  });

  test('record.json：新的赢，但 createdAt 取更早、数组取并集、cliSessionId 保留本地', async () => {
    const { mergeRecords } = await import('../src/main/transcriptMerge.ts');
    const local = {
      id: 's', title: '本地标题', updatedAt: 200, createdAt: 50,
      tags: ['/a'], cliSessionId: 'local-cli', executorState: 'attached',
    };
    const remote = {
      id: 's', title: '远端标题', updatedAt: 300, createdAt: 10,
      tags: ['/b'], cliSessionId: 'remote-cli', executorState: 'attached',
    };
    const out = mergeRecords(local, remote);
    assert.equal(out.title, '远端标题', 'updatedAt 大的赢');
    assert.equal(out.createdAt, 10, '开始时间不随谁后改一次而变');
    assert.deepEqual(out.tags.sort(), ['/a', '/b'], '两台机器各加过的标签都要留');
    /* 抄另一台的 cliSessionId 会让下一次 attach 去 load 一个这里不存在的 session */
    assert.equal(out.cliSessionId, 'local-cli');
    assert.equal(out.executorState, 'detached', '刚合并完，谁也没连着');
    assert.ok(out.updatedAt >= 300);
  });

  test('一边缺就直接用另一边', async () => {
    const { mergeRecords } = await import('../src/main/transcriptMerge.ts');
    assert.deepEqual(mergeRecords(null, { id: 'x' }), { id: 'x' });
    assert.deepEqual(mergeRecords({ id: 'y' }, null), { id: 'y' });
  });

  test('接线：合并前挪 trash、history.md 重建而不是照抄', () => {
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    const at = M.indexOf("ipcMain.handle('s3:restore'");
    const body = M.slice(at, at + 4200);
    /* 合并是个算法，算法会有 bug —— "选了合并"不等于"愿意拿这条会话赌一次" */
    assert.match(body, /backedUp = trashDirFor\(KIROLEX_HOME, sessionId\)/);
    assert.match(body, /mergeTranscripts\(mine, body\.toString\('utf-8'\)\)/);
    assert.match(body, /mergeRecords\(mine, theirs\)/);
    /* history.md 照抄远端那份 = 界面上的历史比 transcript 少一半，而且没有任何报错 */
    assert.match(body, /if \(existed && base === 'history\.md'\) continue;/);
    assert.match(body, /if \(merged\) refreshHistoryFile\(sessionId\);/);
    /* 本地没有这条时是纯恢复，没什么可合的 */
    assert.match(body, /const existed = fs\.existsSync\(localDir\);/);
  });

  test('界面上那个标改成「会合并」，并说清它不合模型的上下文', () => {
    const UI2 = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/BackupDialog.tsx'), 'utf8');
    assert.match(UI2, /backup-tag over">会合并/);
    assert.equal(/会覆盖本地/.test(UI2), false);
    /* 这是合并唯一的硬边界，必须在确认框里说 */
    assert.match(UI2, /模型自己那套上下文在跑过它的那台机器上，不会一起合并/);
  });
});

/*
 * 「getaddrinfo ENOTFOUND kyn-files.s3.cn-northwest-1.amazonaws.com」
 * 「中国区的url之类和海外不一样哦，你应该对 cn-north-1 和 cn-northwest-1 分开处理」。
 *
 * AWS 中国是独立分区（`aws-cn`），域名后缀是 `.amazonaws.com.cn`。少这个 `.cn` 的表现就是
 * DNS 根本解析不出来 —— 而那条报错长得像断网，不像"域名拼错了"。
 */
describe('中国区：域名后缀不一样', () => {
  test('cn-north-1 / cn-northwest-1 走 .amazonaws.com.cn', async () => {
    const { hostFor, s3Suffix, isChinaRegion } = await import('../src/main/s3Client.ts');
    assert.equal(isChinaRegion('cn-northwest-1'), true);
    assert.equal(isChinaRegion('cn-north-1'), true);
    assert.equal(isChinaRegion('CN-NORTH-1'), true, '大小写不该影响它');
    assert.equal(isChinaRegion('ap-northeast-1'), false);
    assert.equal(isChinaRegion(undefined), false);
    assert.equal(s3Suffix('cn-north-1'), 'amazonaws.com.cn');
    assert.equal(s3Suffix('us-east-1'), 'amazonaws.com');

    const creds = (region: string): any => ({ bucket: 'kyn-files', region, accessKeyId: 'a', secretAccessKey: 'b' });
    /* 用户实测撞上的就是这一条 */
    assert.equal(hostFor(creds('cn-northwest-1')), 'kyn-files.s3.cn-northwest-1.amazonaws.com.cn');
    assert.equal(hostFor(creds('cn-north-1')), 'kyn-files.s3.cn-north-1.amazonaws.com.cn');
    assert.equal(hostFor(creds('ap-northeast-1')), 'kyn-files.s3.ap-northeast-1.amazonaws.com');
  });

  test('判据是 `cn-` 前缀，不是把两个区名写死', async () => {
    const C = fs.readFileSync(path.join(process.cwd(), 'src/main/s3Client.ts'), 'utf8');
    /* 这是分区的规则而不是这两个区的特例（将来加区也是 cn- 开头） */
    assert.match(C, /\/\^cn-\/\.test/);
  });

  test('手填的 endpoint 优先 —— 那是用户明确指定的', async () => {
    const { hostFor } = await import('../src/main/s3Client.ts');
    assert.equal(
      hostFor({ bucket: 'b', region: 'cn-north-1', endpoint: 'https://s3.example.com/' } as any),
      's3.example.com',
    );
  });

  test('DNS 失败给一句能照着改的提示，而不是原样抛 ENOTFOUND', async () => {
    const { dnsHint } = await import('../src/main/s3Client.ts');
    const cn = dnsHint({ bucket: 'kyn-files', region: 'cn-northwest-1' } as any, 'kyn-files.s3.cn-northwest-1.amazonaws.com.cn');
    assert.match(cn, /一般不是网络问题/);
    assert.match(cn, /kyn-files/);
    assert.match(cn, /amazonaws\.com\.cn/);
    /* 海外区要点名"这桶是不是在中国区" —— 那是唯一一个看起来完全正常的错法 */
    const oversea = dnsHint({ bucket: 'b', region: 'us-east-1' } as any, 'b.s3.us-east-1.amazonaws.com');
    assert.match(oversea, /cn-north-1/);
    assert.match(oversea, /cn-northwest-1/);

    const C = fs.readFileSync(path.join(process.cwd(), 'src/main/s3Client.ts'), 'utf8');
    assert.match(C, /err\?\.code === 'ENOTFOUND' \|\| err\?\.code === 'EAI_AGAIN'/);
  });
});

/*
 * 「测联通ok的话显示个绿色和✅就行了，不用显示什么可读可写」
 * 「为什么现在桶的配置消失了，这个应该一直在的」。
 */
describe('两处显示上的收口', () => {
  const CONF3 = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/BackupSettings.tsx'), 'utf8');
  const UI3 = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/BackupDialog.tsx'), 'utf8');
  const CSS3 = fs.readFileSync(path.join(process.cwd(), 'src/renderer/styles/global.css'), 'utf8');

  test('测连通成功只给一个 ✅，而且是绿的', () => {
    /*
      "可读可写（桶 / 区）"那句里没有一个字是人还不知道的：桶和区就在上面两栏里，
      而"可读可写"正是这颗按钮的定义。
    */
    assert.match(CONF3, /\? \(leftover \|\| '✅'\)/);
    /* 成功不再和普通说明共用灰色 —— 否则"成了"和"这是一段解释"长得一样 */
    assert.match(CONF3, /msg\.kind === 'bad' \? 'settings-warn' : 'backup-ok'/);
    assert.match(CSS3, /\.backup-ok \{[\s\S]{0,140}color: var\(--success\);/);
  });

  test('但"测试对象没删掉"要原样说出来 —— 那是新信息，不是复述', () => {
    /* 那种情况下桶里真留了个东西，而且可能意味着这个 key 没有 DeleteObject */
    assert.match(CONF3, /\/没删掉\/\.test\(String\(r\.message \|\| ''\)\)/);
  });

  test('标题上写清是哪个桶', () => {
    /* 配置搬去设置之后这一页一个桶名都不显示，"我在从哪儿恢复"没地方看，像是配置丢了 */
    assert.match(UI3, /className="backup-where"/);
    assert.match(UI3, /\{where\.bucket\}\{where\.region \? ` \/ \$\{where\.region\}` : ''\}/);
    /* 还没配桶时也要说，而且指路到设置 */
    assert.match(UI3, /还没配桶（设置 → ☁️ 备份）/);
    /* 凭据仍然只在设置里改 —— 这一页的 saveS3Config 只用来存"哪些项目不同步" */
    assert.equal(/bucket: cfg\.bucket/.test(UI3), false);
  });
});

/*
 * 「这一页中没用的文字描述都删掉」。
 *
 * 砍掉的是实现说明："备份了什么（逐项列一遍）"、"按大小和修改时间跳过没变的"、
 * "启动 60 秒后补一轮 / 退出前那一下做不了"、"用系统 keychain 加密"、
 * "桶里的 key 都加这个前缀"。它们的共同点是：看完也不会改变你在这一页的任何一个动作。
 *
 * 留下的每一条都要能说出"看了它会做什么不一样的事"。
 */
describe('配置页只留有信息量的文字', () => {
  const CONF4 = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/BackupSettings.tsx'), 'utf8');
  /** 只看 JSX 里真会显示出来的文字，不看注释。 */
  const shown = CONF4.split('\n').filter((l) => !/^\s*(\/\*|\*|\/\/|\{\/\*)/.test(l)).join('\n');

  test('那几段实现说明不在了', () => {
    for (const gone of [
      '按大小和修改时间跳过没变的',
      '启动 60 秒后会补一轮',
      '崩溃和被强杀根本不会走退出回调',
      '用系统 keychain 加密后才写进配置',
      '桶里的 key 都加这个前缀',
      'record / transcript / history',
    ]) {
      assert.equal(shown.includes(gone), false, `"${gone}" 应该删掉了`);
    }
  });

  test('留下的两句各有理由', () => {
    /* ① 凭据会不会被传上去，是个真问题 */
    assert.match(shown, /不含 <code>config\.json<\/code> 和日志/);
    /* ② 不说的话人会在这一页找恢复 */
    assert.match(shown, /恢复在侧栏那颗/);
  });

  test('Secret 那条只留"需要哪些权限"——那是你真要去授的东西', () => {
    assert.match(shown, /需要 s3:PutObject \/ GetObject \/ ListBucket \/ DeleteObject。/);
    /* DeleteObject 要在里面：测连通现在写完会删掉那个对象 */
    assert.match(shown, /DeleteObject/);
  });

  test('但没有 keychain 那条**警告**要留着 —— 它解释了为什么 Secret 那栏是灰的', () => {
    /* 警告不是描述：它只在真有问题时出现，而且解释了一个当场看得见的现象 */
    assert.match(CONF4, /没有可用的加密存储（keychain \/ keyring）/);
    assert.match(CONF4, /disabled=\{!cfg\.encryptionAvailable\}/);
  });

  test('"上一次同步"那行状态也留着 —— 它回答"备份到底在不在跑"', () => {
    assert.match(shown, /上一次：/);
  });
});

/*
 * 「这个界面不行，你得按 project 整理，有些project可以选择不同步」
 * 「云那里分同步和恢复两个tab好了」。
 *
 * 粒度是**项目**而不是会话：一摊活要么整摊备份要么整摊不备份，"这个项目里只备份三条会话"
 * 基本不是真实需求。所以分组不只是排版 —— 它和"不同步"那个开关是同一个粒度。
 */
describe('按项目整理 + 同步/恢复两个 tab', () => {
  const M5 = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const UI5 = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/BackupDialog.tsx'), 'utf8');
  const CSS5 = fs.readFileSync(path.join(process.cwd(), 'src/renderer/styles/global.css'), 'utf8');

  test('存"排除"而不是"包含" —— 新建的项目默认跟着备份', async () => {
    /*
      存包含列表的话，每建一个项目都要记得回来勾一次，而漏勾的表现是"它一直没被备份"——
      那件事只有等你需要恢复时才会发现。
    */
    const S = fs.readFileSync(path.join(process.cwd(), 'src/main/s3Sync.ts'), 'utf8');
    assert.match(S, /excludeProjects\?: string\[\];/);
    assert.equal(/includeProjects/.test(S), false);
  });

  test('项目来自 `profile.projectId`，不从目录名推', () => {
    /*
      从目录名推的话，一条没归项目的远程会话会推出一个叫 `s_179…` 的"项目"——
      侧栏那个"怎么移都移不动"的 bug 就是这么来的。
    */
    assert.match(M5, /function projectOf\([\s\S]{0,260}profile as any\)\?\.projectId/);
    const at = M5.indexOf('function projectOf(');
    assert.equal(/deriveProjectId/.test(M5.slice(at, at + 400)), false);
  });

  test('同步时按项目筛，而且说出跳过了多少条', () => {
    const at = M5.indexOf('async function runS3Sync');
    const body = M5.slice(at, at + 2600);
    /* 先按项目、再按单条会话（「我是说单独会话级别的同步与否」） */
    assert.match(body, /const sessions = allSessions\.filter\(\(r\) => !projectExcluded\(cfg, projectOf\(r\)\) && !sessionExcluded\(cfg, r\.id\)\);/);
    /* "少备份了一些东西"必须能解释，否则那是静默的数据缺失 */
    assert.match(body, /跳过 \$\{excludedCount\} 条会话/);
  });

  test('筛在枚举会话的地方，不塞进 planUpload', () => {
    /* `planUpload` 只认"路径 + 上次的状态"，把项目概念塞进去会让它同时对两件事负责 */
    const S = fs.readFileSync(path.join(process.cwd(), 'src/main/s3Sync.ts'), 'utf8');
    assert.equal(/excludeProjects/.test(S.slice(S.indexOf('export function planUpload'), S.indexOf('export function walk'))), false);
  });

  test('排除是"停止继续备份"，不是"删掉备份"', () => {
    /*
      已经传上去的还在桶里 —— `mergeCatalog` 会把老条目并进来，所以它们照旧可以恢复。
      界面上要说出来，否则"关了它怎么还在列表里"看起来像开关没生效。
    */
    assert.match(UI5, /停止继续备份<\/b>，不是删掉已有备份/);
    const S = fs.readFileSync(path.join(process.cwd(), 'src/main/s3Sync.ts'), 'utf8');
    assert.match(S, /已经传上去的不会被删/);
  });

  test('catalog 带上 project —— 分组不该变成几十次下载', () => {
    /* 恢复列表是一次 GET 拿整张 catalog 的；为了分组去逐个下 record.json 等于把 1 次请求变成 N 次 */
    assert.match(M5, /project: projectOf\(r\) \|\| undefined,/);
    const S = fs.readFileSync(path.join(process.cwd(), 'src/main/s3Sync.ts'), 'utf8');
    assert.match(S, /project\?: string;/);
  });

  test('项目清单从会话记录现算，空项目不出现', () => {
    const at = M5.indexOf("ipcMain.handle('s3:projects'");
    assert.ok(at > 0);
    /* 窗口要够大 —— 这一段里有好几段解释为什么这么算的注释 */
    const body = M5.slice(at, M5.indexOf("ipcMain.handle('s3:list-backups'"));
    /* 这一页要回答的是"同步会覆盖到哪些东西"，那取决于会话实际归在哪 */
    assert.match(body, /for \(const rec of store\.listSessions\(\)\)/);
    /* 未分组排最后，其余按最近动过排 —— 你要找的通常是刚用过的那个 */
    assert.match(body, /\(a\.project \? 0 : 1\) - \(b\.project \? 0 : 1\)/);
  });

  test('存进配置时去重、只收字符串', () => {
    const at = M5.indexOf("ipcMain.handle('s3:save-config'");
    const body = M5.slice(at, at + 3000);
    /* 混进一个数字就是一条永不命中的规则（它要和 projectId 做 includes 比较） */
    assert.match(body, /filter\(\(v\): v is string => typeof v === 'string'\)/);
    assert.match(body, /filter\(\(v, i, a\) => a\.indexOf\(v\) === i\)/);
  });

  test('两个 tab，而且恢复那张表是切过去才拉', () => {
    assert.match(UI5, /useState<'sync' \| 'restore'>\('sync'\)/);
    assert.match(UI5, /className="backup-tabs"/);
    /* 列表是一次网络请求，只开同步 tab 的人不该付这个钱 */
    assert.match(UI5, /if \(tab === 'restore' && !entries\) void loadBackups\(\);/);
    /* tab 上带计数：不点进去也知道有多少 */
    assert.match(UI5, /同步\{projects \? ` \(\$\{syncingCount\}\/\$\{projects\.length\}\)` : ''\}/);
  });

  test('恢复那页按项目分组、组头粘顶、能收起', () => {
    assert.match(UI5, /const groups = useMemo/);
    /* 「未分组」整组排最后 */
    assert.match(UI5, /a\[0\] === '未分组' \? 1 : -1/);
    /*
      「选整组」删掉了 —— 恢复整个项目不是常见动作，而那颗按钮占的位置最容易误点。
      只看真会渲染出来的部分：文件头那段注释里会提到它（在解释为什么删的）。
    */
    assert.equal(/>\s*\{allOn \? '取消整组' : '选整组'\}/.test(UI5), false);
    assert.equal(/toggleGroup/.test(UI5), false);
    /* 滚到一半时"我在看哪个项目"不该需要往上翻 */
    const at = CSS5.indexOf('.backup-group-head {');
    assert.ok(at > 0);
    assert.match(CSS5.slice(at, at + 320), /position: sticky;/);
  });

  test('"正在跑"的那些连勾都不给', () => {
    /* 那些恢复会被主进程拒 —— 夹在一堆成功里最容易被漏掉 */
    assert.match(UI5, /disabled=\{!!e\.busy \|\| !!busy\}/);
  });

  test('同步完把恢复那张表作废 —— 桶里的东西变了', () => {
    assert.match(UI5, /setEntries\(null\);/);
  });

  test('未分组要有个名字，否则它是一行空白', () => {
    assert.match(UI5, /const projectLabel = \(p\?: string\): string => \(p && p\.trim\(\) \? p : '未分组'\)/);
  });
});

/*
 * 老 catalog 没有 `project` 字段（那是这一版才加的）—— 升级之前传上去的备份如果全挤在
 * 「未分组」里，"按 project 整理"就等于没生效。对还在本地的那些会话，项目归属可以直接从
 * 本地记录补上。
 */
describe('老 catalog 的项目归属从本地记录补', () => {
  const M6 = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('catalog 里有就用 catalog 的，没有才回退到本地', () => {
    const at = M6.indexOf("ipcMain.handle('s3:list-backups'");
    const body = M6.slice(at, at + 2400);
    /* 顺序要求：桶里那份是权威的（它记的是"备份时属于哪个项目"） */
    assert.match(body, /project: e\.project \|\| projectById\.get\(e\.id\) \|\| undefined,/);
    assert.match(body, /const projectById = new Map\(localRecs\.map\(\(r\) => \[r\.id, projectOf\(r\)\]\)\);/);
    /* 本地记录只读一遍 —— existsLocally 和这个补齐共用它 */
    assert.equal((body.match(/store\.listSessions\(\)/g) || []).length, 1);
  });

  test('两边都不知道就留空 —— 那是诚实的', () => {
    /* 本地已经删掉的那些补不了，留空 → 未分组。编一个项目名比空着糟 */
    const at = M6.indexOf("ipcMain.handle('s3:list-backups'");
    assert.match(M6.slice(at, at + 2400), /本地已经没有的那些补不了，留空/);
  });
});

/*
 * 「每一个会话同步应该有最新同步到什么时间」。
 *
 * catalog 里的 `syncedAt` 回答不了这个问题：它每一轮给**所有**条目盖同一个 `now`，
 * 说的是"catalog 什么时候写的"。一条一周没动过的会话文件根本没重传，
 * 但它的 `syncedAt` 每 30 分钟还是往前跳。
 */
describe('每条会话的最新同步时间', () => {
  test('从没传过 / 有改动待同步 / 已同步', async () => {
    const { sessionSyncState } = await import('../src/main/s3Sync.ts');
    assert.equal(sessionSyncState(undefined, 100), 'never');
    /* 本地 updatedAt 比上传那一刻记下的新 → 有改动还没备份 */
    assert.equal(sessionSyncState({ at: 5, updatedAt: 100 }, 200), 'pending');
    assert.equal(sessionSyncState({ at: 5, updatedAt: 200 }, 200), 'synced');
    /* `at` 为 0 的坏记录当成没传过 —— 那个字段是"什么时候传的"，0 不是一个时间 */
    assert.equal(sessionSyncState({ at: 0, updatedAt: 999 }, 1), 'never');
  });

  test('"传过但时间不明"必须能表达 —— 否则会满屏误报"没备份过"', async () => {
    const { sessionSyncState } = await import('../src/main/s3Sync.ts');
    /*
      两个必然出现的错报：
      ① 增量同步跳过没变的文件 → 那些会话永远进不了 mark 表；
      ② mark 表是后加的 → 存量会话一个 mark 都没有。
      没有这个兜底的话它们会被一直说成"没备份过"，而它们其实躺在桶里好好的，
      而且点「立即同步」也不会变（那一轮只会跳过它们）。
    */
    assert.equal(sessionSyncState(undefined, 100, true), 'synced');
    assert.equal(sessionSyncState(undefined, 100, false), 'never');
    /* 有 mark 时以 mark 为准 —— 它更精确 */
    assert.equal(sessionSyncState({ at: 5, updatedAt: 1 }, 100, true), 'pending');
  });

  test('从上传路径认会话 id', async () => {
    const { sessionIdOfRel } = await import('../src/main/s3Sync.ts');
    assert.equal(sessionIdOfRel('sessions/s_1/transcript.jsonl'), 's_1');
    assert.equal(sessionIdOfRel(`sessions${path.sep}s_2${path.sep}record.json`), 's_2');
    /* 不是会话文件的（记忆层、附件）返回空 —— 它们不属于任何一条会话 */
    assert.equal(sessionIdOfRel('memory/global.md'), '');
    assert.equal(sessionIdOfRel('attachments/x.png'), '');
    assert.equal(sessionIdOfRel(''), '');
  });

  test('只给这一轮真的传过文件的会话更新时间', () => {
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    const at = M.indexOf('async function runS3Sync');
    /* 到函数尾（`rescheduleS3Sync` 是紧跟其后的那个）—— 中间有几段长注释 */
    const body = M.slice(at, M.indexOf('function rescheduleS3Sync', at));
    assert.match(body, /const touchedSessions = new Set<string>\(\);/);
    assert.match(body, /if \(sid\) touchedSessions\.add\(sid\);/);
    /* 给所有会话盖一个 now 就又回到 catalog 那个毛病了 */
    assert.match(body, /if \(touchedSessions\.size\) \{/);
    /* `updatedAt` 一起记 —— 之后本地再动过就能算出"有改动还没备份" */
    assert.match(body, /marks\[id\] = \{ at: now, updatedAt: byId\.get\(id\)\?\.updatedAt \|\| 0 \}/);
  });

  test('界面上"时间未知"和"没备份过"要分开说', () => {
    const UI = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/BackupDialog.tsx'), 'utf8');
    /* 编一个时间比说"不知道"糟 —— 假时间会被拿去判断备份新不新 */
    assert.match(UI, /x\.state === 'synced' \? '已同步（时间未知）' : '—'/);
    assert.match(UI, /没备份过/);
    assert.match(UI, /有改动待同步/);
    /* 收起时组头也要能看出"这摊有几条没同步" */
    assert.match(UI, /\$\{behind\} 条待同步/);
  });

  test('删掉一个项目的备份要连状态表和 mark 表一起清', () => {
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    const at = M.indexOf("ipcMain.handle('s3:delete-project'");
    assert.ok(at > 0);
    const body = M.slice(at, at + 4200);
    /* 删对象 / 写 catalog / 清状态表这三步挪进了 deleteBackupsOf（删会话的入口也用它） */
    assert.match(body, /await deleteBackupsOf\(creds!, cfg\.prefix, catalog,/);
    const h = M.indexOf('async function deleteBackupsOf(');
    const helper = M.slice(h, M.indexOf('\n}\n', h));
    /*
      不清状态表的话，下一轮同步会认为"这些文件没变、跳过"——
      于是删掉的备份**再也不会被重新传上去**。
    */
    assert.match(helper, /if \(sid && goneIds\.has\(sid\)\) delete state\[rel\];/);
    assert.match(helper, /for \(const id of goneIds\) delete marks\[id\];/);
    /* catalog 最后写：先写的话中途失败会留下一个指向已删对象的 catalog */
    assert.ok(helper.indexOf('await deleteObject') < helper.indexOf('putObject(creds, catalogKey'));
    /* 两道确认：界面弹一次，IPC 层还要求原样传回项目名（防手滑点到别的行） */
    assert.match(body, /if \(confirm !== project\) return \{ ok: false/);
  });
});

describe('单条会话的同步与否 ——「我是说单独会话级别的同步与否」', () => {
  const MI = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const UI = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/BackupDialog.tsx'), 'utf8');

  test('排除表按会话 id 存、能存能读，界面每行一个开关', () => {
    assert.match(MI, /function sessionExcluded\(cfg: SyncConfig, sessionId: string\): boolean/);
    assert.match(MI, /excludeSessions: \(input\.excludeSessions as unknown\[\]\)/);
    assert.match(MI, /excluded: sessionExcluded\(cfg, rec\.id\),/);
    assert.match(UI, /onChange=\{\(next\) => void toggleSession\(x\.id, next\)\}/);
    assert.match(UI, /saveS3Config\?\.\(\{ excludeSessions: next \}\)/);
    /* 项目关着时整组都不传，单条的开关就不给按（按了也没意义） */
    assert.match(UI, /disabled=\{!!busy \|\| p\.excluded\}/);
  });

  test('「删除备份」在恢复那一页，不在同步那一页', () => {
    const syncAt = UI.indexOf("{tab === 'sync' && (");
    const restoreAt = UI.indexOf("{tab === 'restore' && (");
    const syncPart = UI.slice(syncAt, restoreAt);
    assert.doesNotMatch(syncPart, /deleteProject\(/);
    assert.match(UI.slice(restoreAt), /onClick=\{\(\) => void deleteProject\(rows\[0\]\?\.project \|\| '', rows\.length\)\}/);
  });
});

describe('恢复 ——「我尝试恢复但没有生效」', () => {
  const MI = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const UI = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/BackupDialog.tsx'), 'utf8');
  const HK = fs.readFileSync(path.join(process.cwd(), 'src/renderer/hooks/useAcp.ts'), 'utf8');
  const at = MI.indexOf("ipcMain.handle('s3:restore'");
  const body = MI.slice(at, MI.indexOf("ipcMain.handle('acp:reveal'", at));

  test('记忆跟着回来：会话 / 项目 / 全局三份都拉，一律合并（细节见 memoryBackup.test.ts）', () => {
    assert.match(body, /path\.join\('memory', 'sessions', sessionId\)/);
    assert.match(body, /path\.join\('memory', 'projects', project\)/);
    assert.match(body, /mergeMemoryText\(local, body\.toString\('utf-8'\)\)/);
    assert.doesNotMatch(body, /overwrite: true/, '会话记忆不再直接覆盖');
  });

  test('新恢复的默认在本机跑（远端那份是备份它的那台机器的配置）；墓碑清掉', () => {
    assert.match(body, /if \(!existed && recAfter\?\.profile\?\.remote\) \{\s*delete recAfter\.profile\.remote;/);
    assert.match(body, /clearSessionTombstone\(sessionId\);/);
  });

  test('不用重启：恢复完侧栏对一遍磁盘，并把那几条连上', () => {
    assert.match(UI, /new CustomEvent\('kirolex:sessions-restored', \{ detail: \{ ids: restoredIds \} \}\)/);
    assert.doesNotMatch(UI, /重启 KiroLex 后它们会出现在列表里/);
    assert.match(HK, /window\.addEventListener\('kirolex:sessions-restored', onRestored\);/);
    assert.match(HK, /await hydrateFromDiskRef\.current\(\);/);
    assert.match(HK, /for \(const id of ids\) void warmSessionRef\.current\(id\);/);
  });
});
