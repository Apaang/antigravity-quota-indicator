import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnoseSidebar } from './sidecars/quota/sidebar-bridge.mjs';

const projectDir = dirname(fileURLToPath(import.meta.url));
const pluginName = 'local-quota';
export const sidecarId = `${pluginName}/quota`;
const shortcutName = 'Antigravity (Quota Indicator).lnk';
const shortcutOwner = 'Antigravity Quota Indicator [local-quota]';
const debugArg = '--remote-debugging-port=0';
const bundleFiles = [
  'plugin.json',
  'sidecars/quota/sidebar.js',
  'sidecars/quota/sidebar-bridge.mjs',
  'sidecars/quota/main.mjs',
  'sidecars/quota/sidecar.json'
];

export function installationPaths(home, appData) {
  const configDir = join(home, '.gemini', 'config');
  const pluginDir = join(configDir, 'plugins', pluginName);
  return {
    configDir, pluginDir, config: join(configDir, 'config.json'),
    shortcut: join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', shortcutName),
    portFile: join(appData, 'Antigravity', 'DevToolsActivePort')
  };
}

function stat(path) {
  return fs.lstatSync(path, { throwIfNoEntry: false });
}

function readJson(path) {
  const info = stat(path);
  if (!info) return { raw: null, data: {} };
  if (!info.isFile()) throw new Error(`不是普通文件 ${basename(path)}`);
  const raw = fs.readFileSync(path, 'utf8');
  let data;
  try { data = JSON.parse(raw.replace(/^\uFEFF/, '')); }
  catch { throw new Error(`无法解析 JSON 文件 ${basename(path)}`); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`JSON 根节点需要是对象 ${basename(path)}`);
  return { raw, data };
}

function readConfig(path) {
  const config = readJson(path);
  const sidecars = config.data.sidecars;
  if (Object.hasOwn(config.data, 'sidecars') && (!sidecars || typeof sidecars !== 'object' || Array.isArray(sidecars))) {
    throw new Error('Antigravity 的 sidecars 配置需要是对象。');
  }
  return config;
}

function writeAtomic(path, value, beforeRename) {
  const temp = join(dirname(path), `.local-quota-${randomUUID()}.tmp`);
  fs.writeFileSync(temp, value, { flag: 'wx' });
  try {
    beforeRename?.();
    fs.renameSync(temp, path);
  } finally {
    if (stat(temp)) fs.unlinkSync(temp);
  }
}

function writeConfig(path, config) {
  writeAtomic(path, `${JSON.stringify(config.data, null, 2)}\n`, () => {
    if (readConfig(path).raw !== config.raw) throw new Error('Antigravity 配置已变化，请重试当前命令。');
  });
}

function withInstallLock(dir, operation) {
  fs.mkdirSync(dir, { recursive: true });
  const path = join(dir, '.local-quota.lock');
  let fd;
  try { fd = fs.openSync(path, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('额度插件安装或卸载正在进行。若上次操作异常退出，请确认无安装进程后移除 .local-quota.lock 并重试。');
    throw error;
  }
  try {
    fs.writeFileSync(fd, String(process.pid));
    return operation();
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(path);
  }
}

function inspectPlugin(dir, rejectUnowned = false) {
  for (const relative of ['', 'sidecars', 'sidecars/quota']) {
    const info = stat(join(dir, relative));
    if (info && !info.isDirectory()) throw new Error('额度插件目录包含链接或非目录项目。');
  }
  const { data } = readJson(join(dir, 'plugin.json'));
  if (data.name === pluginName) return data.version ?? 'unknown';
  if (rejectUnowned && stat(dir) && fs.readdirSync(dir).length) throw new Error('目标插件目录已有其他文件，无法确认归属。');
  return null;
}

export function windowsShortcut(path, action, app = '') {
  installedFile(path);
  const script = `
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$path = $env:LOCAL_QUOTA_SHORTCUT_FILE
$exists = Test-Path -LiteralPath $path -PathType Leaf
if ($exists) { $entry = $shell.CreateShortcut($path) }
$owned = $exists -and $entry.Description -eq $env:LOCAL_QUOTA_SHORTCUT_OWNER
if ($env:LOCAL_QUOTA_SHORTCUT_ACTION -eq 'inspect') {
  if (-not $exists) { 'missing' }
  elseif (-not $owned) { 'conflict' }
  elseif ($entry.Arguments -eq $env:LOCAL_QUOTA_SHORTCUT_ARGS -and (Test-Path -LiteralPath $entry.TargetPath -PathType Leaf)) { 'ready' }
  else { 'owned' }
  exit
}
if ($env:LOCAL_QUOTA_SHORTCUT_ACTION -eq 'remove') {
  if ($owned) { Remove-Item -LiteralPath $path -ErrorAction Stop }
  exit
}
if ($exists -and -not $owned) { throw 'The shortcut is not owned by local-quota.' }
$parent = Split-Path -LiteralPath $path
[void][IO.Directory]::CreateDirectory($parent)
$entry = $shell.CreateShortcut($path)
$entry.TargetPath = $env:LOCAL_QUOTA_APP_EXE
$entry.Arguments = $env:LOCAL_QUOTA_SHORTCUT_ARGS
$entry.WorkingDirectory = Split-Path -LiteralPath $env:LOCAL_QUOTA_APP_EXE
$entry.Description = $env:LOCAL_QUOTA_SHORTCUT_OWNER
$entry.Save()
`;
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
    env: { ...process.env, LOCAL_QUOTA_SHORTCUT_FILE: path, LOCAL_QUOTA_SHORTCUT_OWNER: shortcutOwner,
      LOCAL_QUOTA_SHORTCUT_ACTION: action, LOCAL_QUOTA_SHORTCUT_ARGS: debugArg, LOCAL_QUOTA_APP_EXE: app }
  });
  if (result.status !== 0) throw new Error('无法处理额度插件快捷方式。', { cause: result.error });
  return result.stdout.trim();
}

function installedFile(path) {
  const info = stat(path);
  if (info && !info.isFile()) throw new Error(`拒绝操作文件链接或非普通文件 ${basename(path)}`);
  return Boolean(info);
}

export function installPlugin(paths, app, shortcut = windowsShortcut) {
  if (basename(app).toLowerCase() !== 'antigravity.exe' || !fs.existsSync(app) || !fs.statSync(app).isFile()) {
    throw new Error('未找到 Antigravity 正式版。请使用 --app-path 指定 Antigravity.exe。');
  }
  return withInstallLock(paths.configDir, () => {
    const config = readConfig(paths.config);
    inspectPlugin(paths.pluginDir, true);
    const prior = config.data.sidecars?.[sidecarId];
    if (prior !== undefined && (!prior || typeof prior !== 'object' || Array.isArray(prior))) {
      throw new Error('现有额度 Sidecar 配置需要是对象。');
    }
    if (shortcut(paths.shortcut, 'inspect') === 'conflict') throw new Error('开始菜单已存在同名快捷方式。');
    const files = bundleFiles.map((name) => ({
      to: join(paths.pluginDir, name), data: fs.readFileSync(join(projectDir, name))
    }));
    for (const file of files) installedFile(file.to);
    for (const file of files) {
      fs.mkdirSync(dirname(file.to), { recursive: true });
      if (installedFile(file.to) && fs.readFileSync(file.to).equals(file.data)) continue;
      writeAtomic(file.to, file.data);
    }
    shortcut(paths.shortcut, 'write', app);
    if (prior?.enabled === true) return;
    config.data.sidecars ??= {};
    config.data.sidecars[sidecarId] = { ...prior, enabled: true };
    writeConfig(paths.config, config);
  });
}

export function uninstallPlugin(paths, shortcut = windowsShortcut) {
  return withInstallLock(paths.configDir, () => {
    const installed = inspectPlugin(paths.pluginDir);
    const shortcutState = shortcut(paths.shortcut, 'inspect');
    const config = readConfig(paths.config);
    const owned = installed || ['ready', 'owned'].includes(shortcutState);
    if (!owned) return false;
    const files = installed ? bundleFiles.map((name) => join(paths.pluginDir, name)).filter(installedFile) : [];
    if (Object.hasOwn(config.data.sidecars ?? {}, sidecarId)) {
      delete config.data.sidecars[sidecarId];
      writeConfig(paths.config, config);
    }
    // 最后移除清单，失败后仍可识别这次安装并重试卸载。
    for (const path of files.toReversed()) fs.unlinkSync(path);
    if (installed) {
      for (const relative of ['sidecars/quota', 'sidecars', '']) {
        try { fs.rmdirSync(join(paths.pluginDir, relative)); }
        catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
      }
    }
    if (['ready', 'owned'].includes(shortcutState)) shortcut(paths.shortcut, 'remove');
    return true;
  });
}

const diagnostics = {
  ready: '已显示额度指示器，并收到额度数据。',
  'quota-missing': '指示器已加载，暂无可显示额度。请确认已登录且应用内可查看模型用量。',
  'indicator-missing': '已定位 Antigravity 侧栏，额度插件尚未挂载。请等待数秒后重试，或查看 Sidecar 日志。',
  'settings-button-missing': '已连接 Antigravity。请展开左侧栏。展开后仍出现此提示可能是窗口结构已变化。',
  'workbench-missing': '已连接调试端口。请打开 Antigravity 主窗口并进入一个会话。',
  'debug-port-missing': '找不到调试端口文件。请退出 Antigravity，再从开始菜单的 Antigravity (Quota Indicator) 打开。',
  unreachable: '本机调试端口无响应。请退出 Antigravity，再从额度插件的快捷方式打开。'
};

function appExecutable(override) {
  if (override) return resolve(override);
  const roots = [process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'), process.env.ProgramFiles, process.env['ProgramFiles(x86)']];
  return roots.filter(Boolean).map((root) => join(root, 'Antigravity', 'Antigravity.exe')).find(fs.existsSync) ?? '';
}

async function cli(args) {
  if (args.length === 0 || args[0] === '--help') {
    console.log('用法\n  node install.mjs install [--app-path <Antigravity.exe>]\n  node install.mjs doctor\n  node install.mjs uninstall');
    return 0;
  }
  const [action, flag, app] = args;
  if (!['install', 'doctor', 'uninstall'].includes(action) ||
      (args.length !== 1 && !(action === 'install' && args.length === 3 && flag === '--app-path' && app))) {
    throw new Error('参数无效。请运行 node install.mjs --help。');
  }
  if (process.platform !== 'win32' || !process.env.APPDATA) throw new Error('当前版本支持 Windows 桌面版 Antigravity。');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('安装工具需要 Node.js 24 或更新版本。');
  const paths = installationPaths(homedir(), process.env.APPDATA);
  if (action === 'install') {
    installPlugin(paths, appExecutable(app));
    console.log('额度插件已安装。请退出 Antigravity，并从开始菜单的 Antigravity (Quota Indicator) 打开。');
    return 0;
  }
  if (action === 'uninstall') {
    console.log(uninstallPlugin(paths) ? '额度插件已卸载。' : '未找到额度插件。');
    return 0;
  }
  const installed = inspectPlugin(paths.pluginDir);
  const enabled = readConfig(paths.config).data.sidecars?.[sidecarId]?.enabled === true;
  const shortcut = windowsShortcut(paths.shortcut, 'inspect');
  const live = await diagnoseSidebar(paths.portFile);
  console.log(`插件版本 ${installed ?? '未安装'}\nSidecar ${enabled ? '已启用' : '未启用'}\n开始菜单快捷方式 ${shortcut === 'ready' ? '就绪' : '缺失或需要修复'}\n${diagnostics[live]}`);
  return installed && enabled && live === 'ready' ? 0 : 1;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (entry && entry.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  try { process.exitCode = await cli(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
