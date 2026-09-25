/**
 * **S3 的三个操作**（PutObject / GetObject / ListObjectsV2），直接走 https + SigV4。
 *
 * 为什么不装 SDK：见 `awsSigV4.ts` 文件头。这里只做"把请求发出去、把错误说清楚"。
 *
 * ## 错误必须说清是哪一类
 *
 * S3 的失败都是 HTTP 状态码 + 一小段 XML，而这几类的**处理方式完全不同**：
 *   · 403 `SignatureDoesNotMatch` → 代码/时钟问题，换 AKSK 没用；
 *   · 403 `AccessDenied` → 凭证或 bucket policy 问题，换代码没用；
 *   · 404 `NoSuchBucket` → 名字或 region 写错了；
 *   · 301 `PermanentRedirect` → **region 不对**（S3 会把正确的 region 放在 XML 里告诉你）。
 * 全都笼统报成"上传失败"的话，人只能一个个猜。所以 `S3Error` 带上 `code` 和 `hint`。
 */

import https from 'https';
import { signRequest } from './awsSigV4.ts';

export interface S3Creds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  bucket: string;
  /** 自定义 endpoint（MinIO / S3 兼容存储）。不填按 AWS 规则拼。 */
  endpoint?: string;
}

export class S3Error extends Error {
  status: number;
  code: string;
  hint: string;
  constructor(status: number, code: string, message: string, hint: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

/** `<Code>AccessDenied</Code>` 里那个词。拿不到就空串。 */
export function parseS3ErrorCode(xml: string): string {
  return (String(xml || '').match(/<Code>([^<]+)<\/Code>/) || [, ''])[1] || '';
}

/** 那几类失败各自该往哪儿看。**不泛化**：一句"上传失败"等于让人逐个猜。 */
export function hintFor(status: number, code: string, xml = ''): string {
  if (code === 'SignatureDoesNotMatch') {
    return '签名不匹配 —— 这通常**不是** AKSK 写错（那会是 AccessDenied/InvalidAccessKeyId），'
      + '而是本机时钟偏差超过 15 分钟，或者 region 和 bucket 实际所在区不一致。';
  }
  if (code === 'InvalidAccessKeyId') return 'Access Key ID 不存在 —— 检查有没有多余的空格或换行。';
  if (code === 'AccessDenied') {
    return '凭证有效但没权限 —— 这个 key 需要对该 bucket 的 `s3:PutObject` / `s3:GetObject` / `s3:ListBucket`。';
  }
  if (code === 'NoSuchBucket') return 'bucket 不存在 —— 名字写错，或者它在另一个账号里。';
  if (code === 'PermanentRedirect' || status === 301) {
    const real = (xml.match(/<Region>([^<]+)<\/Region>/) || [])[1];
    return `bucket 不在这个 region${real ? ` —— S3 说它在 \`${real}\`` : ''}。`;
  }
  if (code === 'RequestTimeTooSkewed') return '本机时钟和 AWS 差太多（>15 分钟）—— 对一下系统时间。';
  if (status === 404) return '对象或 bucket 不存在。';
  return '';
}

function hostFor(creds: S3Creds): string {
  if (creds.endpoint) return creds.endpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  /* us-east-1 也用带 region 的 host：它同样有效，而少一条分支就少一个只在某个区触发的 bug */
  return `${creds.bucket}.s3.${creds.region}.amazonaws.com`;
}

interface RawResult { status: number; body: Buffer; headers: Record<string, string | string[] | undefined> }

function request(
  creds: S3Creds,
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE',
  path: string,
  query: Record<string, string>,
  payload: Buffer,
  extraHeaders: Record<string, string> = {},
  timeoutMs = 120_000,
): Promise<RawResult> {
  const host = hostFor(creds);
  const headers = signRequest({
    method, host, path, query, payload, region: creds.region,
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
    headers: { ...extraHeaders, 'content-length': String(payload.length) },
  });
  const qs = Object.keys(query).length
    ? `?${Object.keys(query).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`).join('&')}`
    : '';
  return new Promise((resolve, reject) => {
    const req = https.request({
      host, method, path: `${path.split('/').map(encodeURIComponent).join('/')}${qs}`, headers, timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on('timeout', () => { req.destroy(new Error(`S3 请求超过 ${timeoutMs / 1000}s 没响应`)); });
    req.on('error', reject);
    if (payload.length) req.write(payload);
    req.end();
  });
}

function check(r: RawResult, what: string): RawResult {
  if (r.status >= 200 && r.status < 300) return r;
  const xml = r.body.toString('utf-8');
  const code = parseS3ErrorCode(xml) || `HTTP_${r.status}`;
  throw new S3Error(r.status, code, `${what} 失败（${r.status} ${code}）`, hintFor(r.status, code, xml));
}

export async function putObject(creds: S3Creds, key: string, body: Buffer, contentType = 'application/octet-stream'): Promise<void> {
  check(await request(creds, 'PUT', `/${key}`, {}, body, { 'content-type': contentType }), `上传 ${key}`);
}

export async function getObject(creds: S3Creds, key: string): Promise<Buffer> {
  return check(await request(creds, 'GET', `/${key}`, {}, Buffer.alloc(0)), `下载 ${key}`).body;
}

/** 对象不存在时返回 `null`（而不是抛）—— "还没有"是正常状态，不是错误。 */
export async function getObjectIfExists(creds: S3Creds, key: string): Promise<Buffer | null> {
  const r = await request(creds, 'GET', `/${key}`, {}, Buffer.alloc(0));
  if (r.status === 404) return null;
  return check(r, `下载 ${key}`).body;
}

export interface S3Entry { key: string; size: number; lastModified: string }

/** 列一个前缀下的所有对象（自动翻页 —— 一页 1000 个，超了不翻就是静默少数据）。 */
export async function listObjects(creds: S3Creds, prefix: string): Promise<S3Entry[]> {
  const out: S3Entry[] = [];
  let token: string | undefined;
  do {
    const query: Record<string, string> = { 'list-type': '2', prefix };
    if (token) query['continuation-token'] = token;
    const xml = check(await request(creds, 'GET', '/', query, Buffer.alloc(0)), `列 ${prefix}`).body.toString('utf-8');
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const block = m[1];
      const key = (block.match(/<Key>([^<]*)<\/Key>/) || [])[1];
      if (!key) continue;
      out.push({
        key,
        size: Number((block.match(/<Size>(\d+)<\/Size>/) || [, '0'])[1]),
        lastModified: (block.match(/<LastModified>([^<]*)<\/LastModified>/) || [, ''])[1],
      });
    }
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    token = truncated ? (xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/) || [])[1] : undefined;
  } while (token);
  return out;
}
