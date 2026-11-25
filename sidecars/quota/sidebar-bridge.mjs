import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const POLL_MS = 6_000;
const TIMEOUT_MS = 2_000;

export function localPageSocket(target, port) {
  if (target?.type !== 'page') return null;
  try {
    const page = new URL(target.url);
    const socket = new URL(target.webSocketDebuggerUrl);
    if (!['https:', 'http:'].includes(page.protocol) || page.hostname !== '127.0.0.1' ||
        socket.protocol !== 'ws:' || socket.hostname !== '127.0.0.1' || socket.port !== String(port) ||
        socket.username || socket.password || socket.search || socket.hash ||
        !/^\/devtools\/page\/[a-f0-9]{32}$/i.test(socket.pathname)) return null;
    return socket.href;
  } catch {
    return null;
  }
}

function evaluate(socket, expression) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('本机调试请求超时。')), TIMEOUT_MS);
    const onMessage = ({ data }) => {
      let reply;
      try { reply = JSON.parse(data); } catch { return; }
      if (reply.id !== 1) return;
      if (reply.error || reply.result?.exceptionDetails) return finish(new Error('额度指示器脚本执行失败。'));
      finish(null, reply.result?.result?.value);
    };
    const onError = () => finish(new Error('本机调试连接已断开。'));
    function finish(error, value) {
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onError);
      if (error) reject(error);
      else resolve(value);
    }
    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onError);
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  });
}

function connect(url) {
  const socket = new WebSocket(url);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('本机调试连接超时。'));
    }, TIMEOUT_MS);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(socket);
    }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('无法连接本机调试端口。'));
    }, { once: true });
  });
}

const HOST = `window === window.top && window.__APP_CONFIG__?.productName === 'antigravity' &&
  (typeof window.electronNative?.setTitleBarOverlay === 'function' || typeof window.electronNative?.getZoomLevel === 'function')`;
const SETTINGS = `!!document.querySelector('[role="navigation"] [data-testid="settings-button"]')`;

async function readPageSockets(portFile) {
  let port;
  try {
    port = Number((await readFile(portFile, 'utf8')).split(/\r?\n/, 1)[0]);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('无效的调试端口。');
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error'
  });
  if (!response.ok) throw new Error('本机调试端口无法列出窗口。');
  const targets = await response.json();
  if (!Array.isArray(targets)) throw new Error('无法识别调试窗口列表。');
  return targets.flatMap((target) => {
    const url = localPageSocket(target, port);
    return url ? [url] : [];
  });
}

async function withPage(socketUrl, fn) {
  const socket = await connect(socketUrl);
  try {
    return await fn((expression) => evaluate(socket, expression));
  } finally {
    socket.close();
  }
}

export async function diagnoseSidebar(portFile) {
  let sockets;
  try {
    sockets = await readPageSockets(portFile);
  } catch {
    return 'unreachable';
  }
  if (sockets === null) return 'debug-port-missing';
  if (!sockets.length) return 'workbench-missing';
  const states = await Promise.allSettled(sockets.map((url) => withPage(url, (evaluate) => evaluate(`(() => {
    if (!(${HOST})) return 'workbench-missing';
    if (!(${SETTINGS})) return 'settings-button-missing';
    const widget = document.getElementById('local-quota-indicator')?.shadowRoot;
    if (!widget || widget.querySelectorAll('.badge').length !== 2) return 'indicator-missing';
    return widget.querySelector('.ring:not(.missing), .core:not(.missing)') ? 'ready' : 'quota-missing';
  })()`))));
  for (const state of ['ready', 'quota-missing', 'indicator-missing', 'settings-button-missing', 'workbench-missing']) {
    if (states.some((result) => result.status === 'fulfilled' && result.value === state)) return state;
  }
  return 'unreachable';
}

export async function startSidebarBridge(getQuota) {
  if (process.platform !== 'win32' || !process.env.APPDATA) return;
  const source = await readFile(new URL('./sidebar.js', import.meta.url), 'utf8');
  const revision = JSON.stringify(createHash('sha256').update(source).digest('hex').slice(0, 16));
  const portFile = join(process.env.APPDATA, 'Antigravity', 'DevToolsActivePort');
  const isHost = `(${HOST}) && ${SETTINGS}`;
  const installationState = `(() => {
    if (!(${isHost})) return 0;
    const current = window.__localQuotaIndicator;
    if (typeof current !== 'function') return 1;
    if (current.revision === ${revision}) return 2;
    // 已载入的旧版本会在心跳停止后自行卸载。
    return typeof current.dispose === 'function' ? 1 : 0;
  })()`;
  const install = `window.__localQuotaIndicator?.dispose?.();\n${source}\nwindow.__localQuotaIndicator.revision = ${revision};`;
  let lastError = false;

  async function tick() {
    let requested;
    try {
      const sockets = await readPageSockets(portFile);
      if (!sockets?.length) return;
      const outcomes = await Promise.allSettled(sockets.map((url) => withPage(url, async (evaluate) => {
        const state = await evaluate(installationState);
        if (!state) return;
        requested ??= getQuota();
        const payload = JSON.stringify(await requested);
        await evaluate(`if (${isHost}) { ${state === 1 ? install : ''}\n window.__localQuotaIndicator?.(${payload}); }`);
      })));
      const error = outcomes.find((outcome) => outcome.status === 'rejected');
      if (error && !lastError) console.warn('更新侧栏额度指示器失败', error.reason?.name ?? 'Error');
      lastError = Boolean(error);
    } catch (error) {
      if (!lastError) console.warn('读取侧栏调试连接失败', error.code ?? error.name);
      lastError = true;
    } finally {
      setTimeout(tick, POLL_MS);
    }
  }

  void tick();
}
