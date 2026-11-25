import assert from 'node:assert/strict';
import test from 'node:test';
import { loopbackEndpoint, normalizeQuota } from '../sidecars/quota/main.mjs';
import { diagnoseSidebar, localPageSocket } from '../sidecars/quota/sidebar-bridge.mjs';

test('明确区分 0%、无效或缺失的额度', () => {
  const resetTime = '2026-11-25T12:00:00Z';
  const [gemini] = normalizeQuota({ response: { groups: [{
    displayName: 'Gemini Models',
    buckets: [
      { bucketId: 'gemini-weekly', remainingFraction: 0.85, resetTime },
      { displayName: 'Five Hour Limit Remaining' },
      { bucketId: 'daily', remainingFraction: 0.4 }
    ]
  }] } });
  assert.deepEqual(gemini.buckets, [
    { period: '5h', remaining: 0, resetAt: null },
    { period: 'weekly', remaining: 0.85, resetAt: Date.parse(resetTime) }
  ]);
  const [claude] = normalizeQuota({ response: { groups: [{
    displayName: 'Claude and GPT models',
    buckets: [
      { bucketId: 'claude-5h', disabled: true, remainingFraction: 1 },
      { bucketId: 'claude-weekly', remainingFraction: 1.5, resetTime: 'invalid' }
    ]
  }] } });
  assert.deepEqual(claude.buckets, [{ period: 'weekly', remaining: null, resetAt: null }]);
  assert.deepEqual(normalizeQuota({ response: { groups: [] } }), []);
  assert.throws(() => normalizeQuota({}), /无法识别/);
});

test('额度服务只接受本机地址', () => {
  assert.deepEqual(loopbackEndpoint('localhost:12345'), { protocol: 'http:', hostname: '127.0.0.1', port: 12345 });
  assert.deepEqual(loopbackEndpoint('http://[::1]:12345'), { protocol: 'http:', hostname: '::1', port: 12345 });
  for (const value of ['https://example.com:12345', 'http://127.0.0.1.example.com:12345',
    'http://0.0.0.0:12345', 'http://me@127.0.0.1:12345', 'http://127.0.0.1:12345/path']) {
    assert.throws(() => loopbackEndpoint(value), /回环地址/);
  }
});

test('调试目标必须是同一回环端口上的顶层页面', () => {
  const url = 'ws://127.0.0.1:12345/devtools/page/FABCDEF012345678901234567890ABCD';
  const page = { type: 'page', url: 'https://127.0.0.1:34567', webSocketDebuggerUrl: url };
  assert.equal(localPageSocket(page, 12345), url);
  assert.equal(localPageSocket(page, 23456), null);
  for (const bad of [
    { ...page, type: 'iframe' },
    { ...page, url: 'https://example.com' },
    { ...page, webSocketDebuggerUrl: url.replace('/page/', '/browser/') },
    { ...page, webSocketDebuggerUrl: `${url}?token=unused` }
  ]) assert.equal(localPageSocket(bad, 12345), null);
});

test('没有端口文件时可诊断为未开启调试', async () => {
  const randomPortFile = new URL(`./missing-${Math.random()}/DevToolsActivePort`, import.meta.url);
  assert.equal(await diagnoseSidebar(randomPortFile), 'debug-port-missing');
});
