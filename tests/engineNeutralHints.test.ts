import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { t } from '../src/renderer/i18n.ts';
import { ZH_MAIN } from '../src/main/uiText.ts';
import { engineLabel, engineCliName } from '../src/renderer/engineLabel.ts';

/*
  提示文案审计（docs/hint-text-audit.md）的回归测试：Claude Code / Codex 会话会走到的那几处，
  不能再写死「Kiro / kiro-cli」。名单按审计结果写；每条后面是它在哪儿出现、为什么非 kiro 也看得到。
*/
const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...p), 'utf8');

const BANNED: Array<{ file: string[]; text: string; why: string }> = [
  { file: ['renderer', 'hooks', 'useAcp.ts'], text: "t('Sent, waiting for Kiro to respond", why: '每次发送后的状态行，三种引擎都走 sendMessage' },
  { file: ['renderer', 'App.tsx'], text: "t('Kiro CLI will summarize", why: '「管理上下文 → 压缩」确认框，占比条对 Claude Code / Codex 也亮' },
  { file: ['renderer', 'App.tsx'], text: "t('Kiro CLI will discard", why: '「管理上下文 → 清空」确认框' },
  { file: ['renderer', 'App.tsx'], text: 'The remote kiro-cli reads and writes', why: '新建会话选了远端机器时的说明，不看引擎' },
  { file: ['renderer', 'components', 'Sidebar.tsx'], text: 'This chat’s kiro-cli runs on', why: '侧栏 🌐 远端标签的悬停提示，不看引擎' },
  { file: ['renderer', 'components', 'ChatArea.tsx'], text: 'Kiro CLI does not expose exact per-turn token counts.\')', why: '每条回复的 token 估算悬停提示' },
  { file: ['renderer', 'components', 'ChatArea.tsx'], text: "t('Kiro CLI commands')", why: '斜杠命令菜单（命令来自 ACP，三家都有）' },
  { file: ['renderer', 'components', 'KiroConfigPanel.tsx'], text: 'the kiro-cli on this machine reads', why: 'Claude Code / Codex 的配置面板也用这个组件' },
  { file: ['renderer', 'components', 'ForwardMcpSettings.tsx'], text: 'In remote Kiro sessions', why: '转发名单对远程 Claude Code / Codex 会话同样生效（adapterForwardPlan）' },
  { file: ['main', 'acp-client.ts'], text: "tr('kiro-cli sent an unknown request", why: '适配器发来不认识的请求也走这条' },
  { file: ['main', 'kiroConfig.ts'], text: 'is managed by kiro-cli', why: 'claude-plugins 也是只读分类' },
];

for (const b of BANNED) {
  test(`不再写死 kiro：${b.file.join('/')} —— ${b.why}`, () => {
    assert.ok(!read(...b.file).includes(b.text), `${b.file.join('/')} 里还有「${b.text}」`);
  });
}

test('中文表里也不再有这几句写死 Kiro 的译文', () => {
  const zh = ['chat.ts', 'shell.ts', 'settingsPanels.ts'].map((f) => read('renderer', 'i18nZh', f)).join('\n')
    + read('renderer', 'i18n.ts') + read('main', 'uiTextZh', 'modulesB.ts');
  for (const s of ['等待 Kiro 响应', 'Kiro CLI 会', '远端那个 kiro-cli', '这条会话的 kiro-cli 跑在', '远程 Kiro 会话里', 'Kiro CLI 不提供每一轮', '这台机器上的 kiro-cli 读的', 'kiro-cli 发来一个', '{label} 由 kiro-cli 管理']) {
    assert.ok(!zh.includes(s), `中文表里还有「${s}」`);
  }
});

test('引擎名：缺省 = kiro；kiro 会话的文案不变（Kiro / kiro-cli）', () => {
  assert.equal(engineLabel(undefined), 'Kiro');
  assert.equal(engineLabel('claude'), 'Claude Code');
  assert.equal(engineLabel('codex'), 'Codex');
  assert.equal(engineCliName(undefined), 'kiro-cli');
  assert.equal(engineCliName('kiro'), 'kiro-cli');
  assert.equal(engineCliName('claude'), 'Claude Code');
  assert.equal(t('zh', 'Sent, waiting for {engine} to respond…', { engine: engineLabel('codex') }), '已发送，等待 Codex 响应…');
  assert.equal(t('zh', 'Sent, waiting for {engine} to respond…', { engine: engineLabel(undefined) }), '已发送，等待 Kiro 响应…');
  assert.equal(
    t('zh', 'This chat’s {engine} runs on {host}; the files stay on this machine. It reads and writes them by calling local tools over a reverse tunnel (no files are copied).', { engine: engineCliName(undefined), host: 'h' }),
    '这条会话的 kiro-cli 跑在 h 上；文件仍然在你这台机器上 ——它通过一条反向隧道调本地工具来读写（不复制文件）。',
  );
});

test('改过的英文原文都有中文（渲染层 t()）', () => {
  const keys = [
    'Sent, waiting for {engine} to respond…',
    '{engine} will summarize older conversation context to free context-window capacity. The original full context cannot be restored inside this active {engine} session.',
    '{engine} will discard the active conversation context, and KiroLex will clear the currently displayed history. This cannot be undone inside this active chat.',
    'Files stay local. The remote {engine} reads and writes the files on this machine through a tunnel (nothing is copied).',
    'This chat’s {engine} runs on {host}; the files stay on this machine. It reads and writes them by calling local tools over a reverse tunnel (no files are copied).',
    'Estimated from the visible question and answer; the engine does not report exact per-turn token counts.',
    'Slash commands',
    'This is the copy the {engine} on this machine reads',
    ' or right-click → "Run on" lets a session run on that machine. ',
    '⚠️ Switching the model failed: {why}',
    '⚠️ Switching the effort failed: {why}',
    '⚠️ Switching the permission mode failed: {why}',
    '⚠️ Switching the MCP profile failed: {why}',
    'Switch failed',
    '{why}\nClick to dismiss.',
  ];
  for (const k of keys) assert.notEqual(t('zh', k), t('en', k), `缺中文：${k}`);
});

test('改过的英文原文都有中文（主进程 tr()）', () => {
  for (const k of [
    '⚠️ {engine} sent a request KiroLex does not know (`{method}`) and got an empty answer; please report this to KiroLex.',
    'If it was asking you something, this turn went on with an answer nobody gave.',
    '{label} is managed by {owner} and cannot be edited here.',
  ]) assert.ok(ZH_MAIN[k], `缺中文：${k}`);
});
