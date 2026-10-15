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
import { tr } from './uiText.ts';

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
    return tr("Signature mismatch. This is usually **not** a wrong AKSK (that would be AccessDenied/InvalidAccessKeyId); more likely this computer's clock is off by more than 15 minutes, or the region doesn't match where the bucket actually lives.");
  }
  if (code === 'InvalidAccessKeyId') return tr('Access Key ID not found. Check for stray spaces or line breaks.');
  if (code === 'AccessDenied') {
    return tr('The credentials are valid but lack permission. This key needs `s3:PutObject` / `s3:GetObject` / `s3:ListBucket` on this bucket.');
  }
  if (code === 'NoSuchBucket') return tr('Bucket not found. The name is wrong, or it belongs to another account.');
  if (code === 'PermanentRedirect' || status === 301) {
    const real = (xml.match(/<Region>([^<]+)<\/Region>/) || [])[1];
    return real
      ? tr('The bucket is not in this region. S3 says it is in `{region}`.', { region: real })
      : tr('The bucket is not in this region.');
  }
  if (code === 'RequestTimeTooSkewed') return tr("This computer's clock is too far off from AWS (>15 minutes). Check the system time.");
  if (status === 404) return tr('The object or bucket does not exist.');
  return '';
}

/**
 * **中国区的域名后缀不一样** ——「getaddrinfo ENOTFOUND kyn-files.s3.cn-northwest-1.amazonaws.com」
 * 「中国区的url之类和海外不一样哦，你应该对 cn-north-1 和 cn-northwest-1 分开处理」。
 *
 * AWS 中国是**独立分区**（`aws-cn`），域名后缀是 `.amazonaws.com.cn`：
 *
 *   · `cn-north-1`（北京）     → `<bucket>.s3.cn-north-1.amazonaws.com.cn`
 *   · `cn-northwest-1`（宁夏） → `<bucket>.s3.cn-northwest-1.amazonaws.com.cn`
 *
 * 少这个 `.cn` 的表现正是用户看到的那条：DNS 根本解析不出来（`ENOTFOUND`），
 * 而那条报错长得像"网络有问题"，不像"域名拼错了"——所以下面 `hintFor` 那边也要认这个错。
 *
 * 判据用 `cn-` 前缀而不是把两个区名写死：这是分区的规则，不是这两个区的特例
 * （将来加区也是 `cn-` 开头）。签名那边不用改 —— `aws-cn` 的 SigV4 scope 仍然是
 * `<region>/s3/aws4_request`，和主分区同一个形状。
 */
export function isChinaRegion(region?: string): boolean {
  return /^cn-/.test(String(region || '').trim().toLowerCase());
}

/** 这个区的 S3 域名后缀。 */
export function s3Suffix(region?: string): string {
  return isChinaRegion(region) ? 'amazonaws.com.cn' : 'amazonaws.com';
}

/**
 * DNS 解析不了时给一句**能照着改**的提示。
 *
 * 三种可能，按"改起来最便宜"排：桶名拼错 → 区写错 → 中国区/海外的后缀混了。
 * 最后这一条要点名，因为它是唯一一个"看起来完全正常"的错法。
 */
export function dnsHint(creds: S3Creds, host: string): string {
  const parts = [
    tr('This domain name could not be resolved, so the request never reached AWS. It is usually not a network problem but one of these three:'),
    tr('· The bucket name is misspelled (currently `{bucket}`);', { bucket: creds.bucket || tr('(empty)') }),
    tr('· The region is wrong (currently `{region}`);', { region: creds.region || tr('(empty)') }),
  ];
  if (isChinaRegion(creds.region)) {
    parts.push(tr('· China regions (the `aws-cn` partition) use the domain suffix `.amazonaws.com.cn`. KiroLex already builds it that way (`{host}`); if you typed an address into the endpoint field next to "Key prefix", check that it is not missing `.cn`.', { host }));
  } else {
    parts.push(tr('· If this bucket is in a **China region** (Beijing `cn-north-1` / Ningxia `cn-northwest-1`), the region must be one of those two. China is a separate partition with the domain suffix `.amazonaws.com.cn`; a non-China region produces a domain that does not exist.'));
  }
  return parts.join('\n');
}

export function hostFor(creds: S3Creds): string {
  if (creds.endpoint) return creds.endpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  /* us-east-1 也用带 region 的 host：它同样有效，而少一条分支就少一个只在某个区触发的 bug */
  return `${creds.bucket}.s3.${creds.region}.${s3Suffix(creds.region)}`;
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
    req.on('timeout', () => { req.destroy(new Error(tr('S3 request got no response within {sec}s', { sec: timeoutMs / 1000 }))); });
    /*
      **DNS 失败要说清它不是"网络坏了"** —— 实测用户拿到的是
      `getaddrinfo ENOTFOUND kyn-files.s3.cn-northwest-1.amazonaws.com`，
      而那句话看起来像断网，其实是**域名拼不出来**：桶名错、区写错，或者中国区少了 `.cn`。
      原样抛给界面的代价是人跑去查网络，而问题在配置的三个字里。
    */
    req.on('error', (err: any) => {
      if (err?.code === 'ENOTFOUND' || err?.code === 'EAI_AGAIN') {
        reject(new S3Error(0, err.code, tr('Cannot reach {host} ({code})', { host, code: err.code }), dnsHint(creds, host)));
        return;
      }
      reject(err);
    });
    if (payload.length) req.write(payload);
    req.end();
  });
}

function check(r: RawResult, what: string): RawResult {
  if (r.status >= 200 && r.status < 300) return r;
  const xml = r.body.toString('utf-8');
  const code = parseS3ErrorCode(xml) || `HTTP_${r.status}`;
  throw new S3Error(r.status, code, tr('{what} failed ({status} {code})', { what, status: r.status, code }), hintFor(r.status, code, xml));
}

export async function putObject(creds: S3Creds, key: string, body: Buffer, contentType = 'application/octet-stream'): Promise<void> {
  check(await request(creds, 'PUT', `/${key}`, {}, body, { 'content-type': contentType }), tr('Upload {key}', { key }));
}

export async function getObject(creds: S3Creds, key: string): Promise<Buffer> {
  return check(await request(creds, 'GET', `/${key}`, {}, Buffer.alloc(0)), tr('Download {key}', { key })).body;
}

/**
 * 删一个对象 ——「测试应该是写完然后删除」。
 *
 * S3 的 DELETE 对**不存在的 key** 也回 204，所以这个函数在"本来就没有"时也算成功 ——
 * 这正是幂等清理想要的语义（重复调用不会变成错误）。
 */
export async function deleteObject(creds: S3Creds, key: string): Promise<void> {
  check(await request(creds, 'DELETE', `/${key}`, {}, Buffer.alloc(0)), tr('Delete {key}', { key }));
}

/** 对象不存在时返回 `null`（而不是抛）—— "还没有"是正常状态，不是错误。 */
export async function getObjectIfExists(creds: S3Creds, key: string): Promise<Buffer | null> {
  const r = await request(creds, 'GET', `/${key}`, {}, Buffer.alloc(0));
  if (r.status === 404) return null;
  return check(r, tr('Download {key}', { key })).body;
}

export interface S3Entry { key: string; size: number; lastModified: string }

/** 列一个前缀下的所有对象（自动翻页 —— 一页 1000 个，超了不翻就是静默少数据）。 */
export async function listObjects(creds: S3Creds, prefix: string): Promise<S3Entry[]> {
  const out: S3Entry[] = [];
  let token: string | undefined;
  do {
    const query: Record<string, string> = { 'list-type': '2', prefix };
    if (token) query['continuation-token'] = token;
    const xml = check(await request(creds, 'GET', '/', query, Buffer.alloc(0)), tr('List {prefix}', { prefix })).body.toString('utf-8');
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
