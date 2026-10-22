/**
 * 「AI 工具配置」的接线（源码扫描）+ 确认框文案（`renderer/agentProfileView.ts`）。
 *
 * 守的是：四个 IPC 都注册了、preload 有包装、设置 → 机器页挂了这一块；同步走 runProfileSync（先备份）；
 * 版本走 remote-bootstrap.sh 的 PINS（沿用远端安装路径和失败原因回传）；确认框先说备份、列出要改的、说明什么永不下发。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { confirmText, diffText, areaLabel, type PlanView } from '../src/renderer/agentProfileView.ts';

const SRC = path.join(import.meta.dirname, '..', 'src');
const M = fs.readFileSync(path.join(SRC, 'main', 'index.ts'), 'utf8');
const P = fs.readFileSync(path.join(SRC, 'main', 'preload.ts'), 'utf8');
const S = fs.readFileSync(path.join(SRC, 'renderer', 'components', 'SettingsDialog.tsx'), 'utf8');
const B = fs.readFileSync(path.join(import.meta.dirname, '..', 'scripts', 'remote-bootstrap.sh'), 'utf8');

describe('接线', () => {
  test('IPC 注册 + preload 包装', () => {
    for (const ch of ['agent-profile:read', 'agent-profile:save', 'agent-profile:diff', 'agent-profile:plan', 'agent-profile:sync', 'agent-profile:open-dir']) {
      assert.ok(M.includes(`ipcMain.handle('${ch}'`), ch);
      assert.ok(P.includes(`'${ch}'`), ch);
    }
    assert.ok(P.includes("'agent-profile:sync-output'"));
  });

  test('编辑框：S3 拉回新配置时没改动就刷新编辑框、有改动就提示；保存带上打开时的原文（主进程比对，变了就不写）', () => {
    const C = fs.readFileSync(path.join(SRC, 'renderer', 'components', 'AgentProfileSettings.tsx'), 'utf8');
    const at = C.indexOf('onAgentProfileChanged?.(');
    assert.ok(at > 0);
    const cb = C.slice(at, at + 1400);
    assert.ok(cb.includes('if (!dirtyRef.current)'));
    assert.ok(cb.includes('showFile(r, e)'));
    assert.ok(cb.includes('Saving is blocked'));
    assert.ok(C.includes('agentProfileSave(engine, text, baseRef.current[engine])'));
    assert.ok(P.includes("ipcRenderer.invoke('agent-profile:save', engine, text, expected)"));
    const sv = M.slice(M.indexOf("ipcMain.handle('agent-profile:save'"), M.indexOf("ipcMain.handle('agent-profile:save'") + 600);
    assert.ok(sv.includes('{ expected:'));
  });

  test('设置 → 机器页挂了 AgentProfileSettings', () => {
    assert.match(S, /tab === 'machines' && <AgentProfileSettings \/>/);
  });

  test('同步走 runProfileSync；版本用 remote-bootstrap.sh 的 PINS，失败原因用 remoteInstallReason', () => {
    const at = M.indexOf("ipcMain.handle('agent-profile:sync'");
    const body = M.slice(at, at + 8000);
    assert.ok(body.includes('runProfileSync(plan'));
    assert.ok(body.includes('remotePinCommand('));
    assert.ok(body.includes('readBootstrapScript()'));
    assert.ok(body.includes('remoteInstallReason('));
  });

  test('remote-bootstrap.sh 的 PINS：只装钉的那几个、npm 失败行带 `  npm: ` 前缀、装完核对版本', () => {
    assert.match(B, /PINS="\$\{PINS:-\}"/);
    assert.match(B, /\[ -n "\$PINS" \] && \[ -z "\$ONLY" \] && ONLY=pins/);
    const at = B.indexOf('npm_pin() {');
    assert.ok(at > 0);
    const fn = B.slice(at, at + 2000);
    assert.ok(fn.includes('npm_i "$pkg@$ver" "$bin"'));
    assert.ok(fn.includes('claude install "$ver"'));
    assert.ok(fn.includes("sed 's/^/  npm: /'"));
    assert.ok(fn.includes('装完是'));
    /* 钉版本那段在「只装一个适配器」的自检之前就 exit 了，不会掉进全量安装 */
    assert.ok(B.indexOf('if [ -n "$PINS" ]; then\n  for kx_spec') < B.indexOf('# 只装一个适配器（ONLY）到这里就完了'));
  });
});

describe('确认框 / 差异文案', () => {
  const t = (k: string, v?: Record<string, string | number>) => k.replace(/\{(\w+)\}/g, (_m, n) => String(v?.[n] ?? ''));
  const plan: PlanView = {
    backupDir: '~/.claude/.kirolex-backup-20261022-090507',
    items: [
      { area: 'version', key: 'claude-code', status: 'different', want: '2.1.308', have: '2.1.289' },
      { area: 'settings', key: 'model', status: 'different', want: 'opus', have: 'sonnet' },
      { area: 'settings', key: 'env.AWS_REGION', status: 'missing', want: 'ap-northeast-1' },
      { area: 'warning', key: 'env.X', status: 'unresolved', want: '{{X}}' },
    ],
    pins: [{ bin: 'claude', pkg: '@anthropic-ai/claude-code', version: '2.1.308' }],
    rules: ['prod-safety.md'], plugins: ['superpowers@aim'], marketplaces: [{ name: 'aim', copy: true }],
    codexEntries: [], warnings: [], hasWork: true,
  };

  test('先说备份到哪，再列要改的，最后说什么永不下发', () => {
    const s = confirmText(plan, 'ec2-user@1.2.3.4', t);
    const lines = s.split('\n');
    assert.match(lines[0], /back up .*\.kirolex-backup-20261022-090507/);
    assert.ok(s.includes('claude@2.1.308'));
    assert.ok(s.includes('model, env.AWS_REGION'));
    assert.ok(s.includes('prod-safety.md'));
    assert.ok(s.includes('superpowers@aim'));
    assert.ok(s.includes('aim (copied from this computer)'));
    assert.ok(s.includes('{{X}}'));
    assert.match(lines[lines.length - 1], /Never sent: local-only MCP/);
  });

  test('要启用一个已装但关着的插件 → 确认框里列出来', () => {
    const s = confirmText({ ...plan, plugins: [], items: [{ area: 'plugin', key: 'frontend@claude-plugins-official', status: 'different', want: 'enabled', have: 'disabled' }] }, 'h', t);
    assert.match(s, /Turn on installed plugins \(enabledPlugins set to true\): frontend@claude-plugins-official/);
    assert.ok(!/Turn off plugins/.test(s));
  });

  test('Codex：确认框只说改顶层那两行；嵌套项列为「需手动配置」', () => {
    const s = confirmText({ ...plan, codexEntries: ['model_provider'], items: [
      { area: 'codex', key: 'model_provider', status: 'missing', want: 'amazon-bedrock' },
      { area: 'codex', key: 'model_providers.amazon-bedrock.aws.region', status: 'manual', want: 'us-east-1' },
    ] }, 'h', t);
    assert.match(s, /Set at the top of ~\/\.codex\/config\.toml \(only these lines change\): model_provider/);
    assert.match(s, /Not changed automatically, set up by hand on that machine: model_providers\.amazon-bedrock\.aws\.region/);
    assert.equal(diffText({ area: 'codex', key: 'model_providers.amazon-bedrock.aws.region', status: 'manual', want: 'us-east-1' }, t), 'Needs manual setup: model_providers.amazon-bedrock.aws.region = us-east-1');
  });

  test('差异一行', () => {
    assert.equal(diffText(plan.items[1], t), 'model: sonnet → opus');
    assert.equal(diffText({ area: 'adapter', key: 'codex-acp', status: 'missing', want: '2.2.2' }, t), 'codex-acp is not installed → 2.2.2');
    assert.equal(areaLabel('codex', t), 'config.toml');
  });
});
