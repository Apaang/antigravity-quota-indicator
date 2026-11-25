import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { installationPaths, installPlugin, sidecarId, uninstallPlugin } from '../install.mjs';

function environment(t) {
  const temp = resolve(tmpdir());
  const dir = fs.mkdtempSync(join(temp, 'antigravity-quota-test-'));
  t.after(() => {
    assert.equal(dirname(resolve(dir)), temp);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const app = join(dir, 'Antigravity.exe');
  fs.writeFileSync(app, 'fixture');
  const paths = installationPaths(dir, join(dir, 'Roaming'));
  const state = { shortcut: 'missing', written: 0 };
  const shortcut = (path, action, executable) => {
    assert.equal(path, paths.shortcut);
    if (action === 'inspect') return state.shortcut;
    if (action === 'write') {
      assert.equal(executable, app);
      state.shortcut = 'ready';
      state.written++;
    }
    if (action === 'remove') state.shortcut = 'missing';
  };
  return { app, paths, state, shortcut };
}

function writeConfig(paths, data) {
  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.writeFileSync(paths.config, JSON.stringify(data));
}

test('首次安装、重复安装和卸载保留其他 Sidecar 及插件目录的附加文件', (t) => {
  const { app, paths, state, shortcut } = environment(t);
  const unrelated = { sidecars: { other: { enabled: true } }, userSettings: { example: 1 } };
  writeConfig(paths, unrelated);
  installPlugin(paths, app, shortcut);
  const installedConfig = fs.readFileSync(paths.config, 'utf8');
  assert.deepEqual(JSON.parse(installedConfig).sidecars[sidecarId], { enabled: true });
  assert.equal(JSON.parse(fs.readFileSync(join(paths.pluginDir, 'plugin.json'))).name, 'local-quota');
  installPlugin(paths, app, shortcut);
  assert.equal(fs.readFileSync(paths.config, 'utf8'), installedConfig);
  assert.equal(state.shortcut, 'ready');
  const extra = join(paths.pluginDir, 'user-note.txt');
  fs.writeFileSync(extra, 'keep this');
  assert.equal(uninstallPlugin(paths, shortcut), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.config)), unrelated);
  assert.equal(state.shortcut, 'missing');
  assert.equal(fs.existsSync(join(paths.pluginDir, 'plugin.json')), false);
  assert.equal(fs.readFileSync(extra, 'utf8'), 'keep this');
  assert.equal(uninstallPlugin(paths, shortcut), false);
});

test('保留同一 Sidecar 的已有附加配置和同名非托管快捷方式', (t) => {
  const { app, paths, state, shortcut } = environment(t);
  const prior = { sidecars: { [sidecarId]: { enabled: false, projectId: 'example' } } };
  writeConfig(paths, prior);
  state.shortcut = 'conflict';
  assert.throws(() => installPlugin(paths, app, shortcut), /同名快捷方式/);
  assert.equal(fs.existsSync(paths.pluginDir), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.config)), prior);
  state.shortcut = 'missing';
  installPlugin(paths, app, shortcut);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.config)).sidecars[sidecarId], { enabled: true, projectId: 'example' });
  state.shortcut = 'conflict';
  assert.equal(uninstallPlugin(paths, shortcut), true);
  assert.equal(state.shortcut, 'conflict');
});

test('不会覆盖已有无关插件或无法解析的配置', (t) => {
  const { app, paths, shortcut } = environment(t);
  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.writeFileSync(paths.config, '{ malformed');
  assert.throws(() => installPlugin(paths, app, shortcut), /无法解析/);
  assert.equal(fs.readFileSync(paths.config, 'utf8'), '{ malformed');
  writeConfig(paths, {});
  fs.mkdirSync(paths.pluginDir, { recursive: true });
  const unrelated = join(paths.pluginDir, 'plugin.json');
  fs.writeFileSync(unrelated, '{"name":"different-project"}');
  assert.throws(() => installPlugin(paths, app, shortcut), /无法确认归属/);
  assert.equal(uninstallPlugin(paths, shortcut), false);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), '{"name":"different-project"}');
});

test('检测到外部配置信息变化后保留新配置，允许重试', (t) => {
  const { app, paths, shortcut } = environment(t);
  writeConfig(paths, { before: 1 });
  const externalWrite = (path, action, executable) => {
    const result = shortcut(path, action, executable);
    if (action === 'write') writeConfig(paths, { external: 2 });
    return result;
  };
  assert.throws(() => installPlugin(paths, app, externalWrite), /配置已变化/);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.config)), { external: 2 });
  installPlugin(paths, app, shortcut);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.config)), { external: 2, sidecars: { [sidecarId]: { enabled: true } } });
});
