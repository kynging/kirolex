/**
 * **AWS SigV4 签名** —— 只为 S3 的三个操作（PutObject / GetObject / ListObjectsV2）而写。
 *
 * ## 为什么不装 `@aws-sdk/client-s3`
 *
 * 这个 app 的运行时依赖一共 12 个（react、yaml、几个 markdown 插件…），而 S3 这三个操作是
 * 纯 REST：签名 + `https.request`。SDK 会往一个 Electron 包里塞进几十个包和上百个文件，
 * 而它们提供的能力（分片上传、重试策略、凭证链、流式处理）这里一个都用不到。
 *
 * 代价是签名得自己写对 —— 所以这个模块是**纯函数**，并且用 AWS 官方文档里那条
 * 「Example: GET Object」的测试向量卡住（`tests/awsSigV4.test.ts`）：给定同样的 key、
 * 同样的时间、同样的请求，算出来的 Signature 必须和文档里那一串完全一样。
 * 签名错了的表现是 403 `SignatureDoesNotMatch`，而那是一种"看起来像凭证不对"的错 ——
 * 人会去换 AKSK，而问题在代码里。
 *
 * ## S3 的几个坑（都在这里处理）
 *
 * · **路径不能整体 encode**：S3 的 canonical URI 要对每一段做 URI 编码，但 `/` 保持原样。
 *   整体 `encodeURIComponent` 会把 `/` 变成 `%2F`，签出来的名字就不是那个 key 了。
 * · **`x-amz-content-sha256` 必须参与签名**：S3（不同于多数服务）要求它，而且要是真实 payload 的
 *   sha256，不能用 `UNSIGNED-PAYLOAD` —— 用了在某些 bucket 策略下会被拒。
 * · **query 要按 key 排序**，且 value 也要 encode（`list-type=2&prefix=a/b` 里的 `/` 要变 `%2F`）。
 */

import crypto from 'crypto';

const ALGORITHM = 'AWS4-HMAC-SHA256';

export interface SignInput {
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE';
  /** 例如 `my-bucket.s3.us-west-2.amazonaws.com`。 */
  host: string;
  /** 以 `/` 开头的对象 key 路径（**未编码**的原始路径）。 */
  path: string;
  /** query 参数（未编码）。 */
  query?: Record<string, string>;
  /** 除 host / x-amz-date / x-amz-content-sha256 之外要签的头。 */
  headers?: Record<string, string>;
  /** 请求体（空请求传空 Buffer）。 */
  payload: Buffer;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** 临时凭证才有。 */
  sessionToken?: string;
  /** 注入时间，便于测试。 */
  now?: Date;
  service?: string;
}

/** `20130524T000000Z` / `20130524`。 */
export function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = `${now.toISOString().replace(/[:-]|\.\d{3}/g, '')}`.replace(/Z$/, 'Z');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

const sha256 = (data: Buffer | string): string => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string): Buffer => crypto.createHmac('sha256', key).update(data).digest();

/**
 * 一段一段地编码路径，`/` 不动。
 *
 * S3 的 canonical URI 规则：每个 segment 按 RFC 3986 编码，而 `encodeURIComponent` 漏掉
 * `!'()*` 这几个字符 —— 名字里带它们的对象会签失败，所以补上。
 */
export function canonicalUri(path: string): string {
  return String(path || '/')
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/') || '/';
}

/** query 串：按 key 排序，key 和 value 都编码。 */
export function canonicalQuery(query: Record<string, string> = {}): string {
  return Object.keys(query)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k] ?? '')}`)
    .join('&');
}

/**
 * 算出要带上的头（含 `Authorization`）。
 *
 * 返回的是**完整的一组请求头** —— 调用方直接交给 `https.request`，不用再自己拼
 * `x-amz-date` 之类（漏一个就是 403，而 403 看起来像凭证问题）。
 */
export function signRequest(input: SignInput): Record<string, string> {
  const service = input.service || 's3';
  const now = input.now || new Date();
  const { amzDate, dateStamp } = amzDates(now);
  const payloadHash = sha256(input.payload);

  const headers: Record<string, string> = {
    ...(input.headers || {}),
    host: input.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (input.sessionToken) headers['x-amz-security-token'] = input.sessionToken;

  /* 签名要用小写头名、排序、值去掉首尾空白 */
  const lower = Object.keys(headers).map((k) => [k.toLowerCase(), String(headers[k]).trim()] as const);
  lower.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonicalHeaders = `${lower.map(([k, v]) => `${k}:${v}`).join('\n')}\n`;
  const signedHeaders = lower.map(([k]) => k).join(';');

  const canonicalRequest = [
    input.method,
    canonicalUri(input.path),
    canonicalQuery(input.query),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${input.region}/${service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    ...headers,
    Authorization: `${ALGORITHM} Credential=${input.accessKeyId}/${scope},`
      + `SignedHeaders=${signedHeaders},Signature=${signature}`,
  };
}
