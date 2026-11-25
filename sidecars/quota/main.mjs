import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSidebarBridge } from './sidebar-bridge.mjs';

const QUOTA_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary';
const CACHE_MS = 60_000;
const MIN_REFRESH_MS = 10_000;

export function loopbackEndpoint(address) {
  const input = String(address ?? '').trim();
  const url = new URL(input.includes('://') ? input : `http://${input}`);
  const localHosts = { '127.0.0.1': '127.0.0.1', '[::1]': '::1', localhost: '127.0.0.1' };
  if (!['http:', 'https:'].includes(url.protocol) || !Object.hasOwn(localHosts, url.hostname) ||
      !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Antigravity 配额服务地址不是有效的本机回环地址。');
  }
  return { protocol: url.protocol, hostname: localHosts[url.hostname], port: Number(url.port) };
}

function quotaPeriod(bucket) {
  const window = String(bucket.window ?? '').trim().toLowerCase();
  const label = `${bucket.bucketId ?? ''} ${bucket.displayName ?? ''}`;
  if (['5h', '18000s'].includes(window) || /\b(?:5[ -]?h(?:ours?)?|five[ -]hour)\b/i.test(label)) return '5h';
  if (['1w', '7d', '168h', '604800s'].includes(window) || /\bweekly\b/i.test(label)) return 'weekly';
  return null;
}

export function normalizeQuota(payload) {
  const groups = payload?.response?.groups;
  if (!Array.isArray(groups)) throw new Error('Antigravity 返回了无法识别的配额数据。');
  return groups.flatMap((group) => {
    if (!group || !Array.isArray(group.buckets)) return [];
    const buckets = group.buckets.flatMap((bucket) => {
      if (!bucket || bucket.disabled) return [];
      const period = quotaPeriod(bucket);
      if (!period) return [];
      // Proto3 JSON 省略值为零的标量字段。
      const fraction = Object.hasOwn(bucket, 'remainingFraction') ? bucket.remainingFraction : 0;
      const remaining = Number.isFinite(fraction) && fraction >= 0 && fraction <= 1 ? fraction : null;
      const resetAt = typeof bucket.resetTime === 'string' ? Date.parse(bucket.resetTime) : NaN;
      return [{ period, remaining, resetAt: Number.isFinite(resetAt) ? resetAt : null }];
    });
    if (!buckets.length) return [];
    buckets.sort((first, second) => Number(first.period === 'weekly') - Number(second.period === 'weekly'));
    return [{ name: String(group.displayName || '模型组'), buckets }];
  });
}

export function readQuota({ address, token }) {
  if (!address || !token) throw new Error('Antigravity 尚未提供本机配额服务。');
  const endpoint = loopbackEndpoint(address);
  const request = endpoint.protocol === 'https:' ? httpsRequest : httpRequest;
  const body = JSON.stringify({ forceRefresh: true });
  return new Promise((resolve, reject) => {
    const call = request({
      ...endpoint,
      method: 'POST',
      path: QUOTA_PATH,
      signal: AbortSignal.timeout(8_000),
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': token,
        'Content-Length': Buffer.byteLength(body)
      }
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`本机配额服务返回 HTTP ${response.statusCode}。`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('error', reject);
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 256 * 1024) {
          response.destroy(new Error('本机配额响应超出大小限制。'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const groups = normalizeQuota(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          resolve({ groups, updatedAt: Date.now() });
        } catch (error) {
          reject(error);
        }
      });
    });
    call.on('error', reject);
    call.end(body);
  });
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (process.platform === 'win32' && entry.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  let cached = null;
  let lastError = false;
  let lastAttempt = 0;

  async function getQuota() {
    const now = Date.now();
    if (now - lastAttempt < (lastError ? MIN_REFRESH_MS : CACHE_MS)) {
      return { data: cached, error: lastError };
    }
    lastAttempt = now;
    try {
      cached = await readQuota({
        address: process.env.ANTIGRAVITY_LS_ADDRESS,
        token: process.env.ANTIGRAVITY_CSRF_TOKEN
      });
      lastError = false;
    } catch (error) {
      if (!lastError) console.warn('读取模型额度失败', error.code ?? error.name);
      lastError = true;
    }
    return { data: cached, error: lastError };
  }

  await startSidebarBridge(getQuota);
}
