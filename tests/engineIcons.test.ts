/**
 * 三个引擎的图标形状互不相同 ——「Claude Code 和 Codex 的图标看起来差不多」。
 *
 * 守的是：
 *   1. 路径数据互不相同，而且是三种**轮廓类型**（Kiro 描边方头 / Claude Code 实心星芒 / Codex 空心结），
 *      不靠颜色也能分清；14px 下线条不细于 1px；
 *   2. 所有显示引擎图标的地方都用同一个 `EngineIcon`，旧的三个单独图标组件不再存在；
 *   3. 图标颜色走引擎强调色（开关关掉时统一色，形状照样不同）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ENGINE_ICON_SHAPES } from '../src/renderer/engineIcons.ts';
import { ACCENT_ENGINES, engineAccentCss } from '../src/renderer/engineTheme.ts';

const SRC = path.join(import.meta.dirname, '..', 'src', 'renderer');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const pathData = (e: typeof ACCENT_ENGINES[number]) => ENGINE_ICON_SHAPES[e].parts.map((p) => p.d).join(' ');

describe('形状', () => {
  test('三个引擎的路径数据互不相同', () => {
    const all = ACCENT_ENGINES.map(pathData);
    assert.equal(new Set(all).size, 3);
    // 也没有任何一段路径是两个引擎共用的
    const parts = ACCENT_ENGINES.flatMap((e) => ENGINE_ICON_SHAPES[e].parts.map((p) => p.d));
    assert.equal(new Set(parts).size, parts.length);
  });
  test('Claude Code 是实心的星芒：只有填色的部分，八个尖', () => {
    const s = ENGINE_ICON_SHAPES.claude;
    assert.ok(s.parts.length > 0 && s.parts.every((p) => p.filled));
    const pts = (s.parts[0].d.match(/[ML]/g) || []).length;
    assert.equal(pts, 16, '八个尖 + 八个谷 = 16 个点');
  });
  test('Codex 是空心的结：只描边，外圈六段圆弧瓣 + 中间一个孔', () => {
    const s = ENGINE_ICON_SHAPES.codex;
    assert.ok(s.parts.every((p) => !p.filled));
    assert.equal((s.parts[0].d.match(/A/g) || []).length, 6);
    assert.equal(s.parts.length, 2);
  });
  test('Kiro 沿用方头机器人：描边的圆角方头 + 实心的眼睛', () => {
    const s = ENGINE_ICON_SHAPES.kiro;
    assert.ok(s.parts.some((p) => !p.filled && /h8a4 4/.test(p.d)), '方头');
    assert.equal(s.parts.filter((p) => p.filled).length, 3, '天线头 + 两只眼');
  });
  test('三者的「填色 / 描边」组合各不相同（色弱也看得出不是同一种东西）', () => {
    const kind = (e: typeof ACCENT_ENGINES[number]) => {
      const ps = ENGINE_ICON_SHAPES[e].parts;
      return ps.every((p) => p.filled) ? 'filled' : ps.every((p) => !p.filled) ? 'stroked' : 'mixed';
    };
    assert.deepEqual(ACCENT_ENGINES.map(kind), ['mixed', 'filled', 'stroked']);
  });
  test('14px 下描边不细于 1px（24 网格里 ≥ 1.72）', () => {
    for (const e of ACCENT_ENGINES) {
      const s = ENGINE_ICON_SHAPES[e];
      if (s.parts.some((p) => !p.filled)) assert.ok(s.strokeWidth * 14 / 24 >= 1, `${e} 线宽 ${s.strokeWidth}`);
    }
  });
  test('路径坐标都在 24×24 的画布里', () => {
    for (const e of ACCENT_ENGINES) {
      for (const n of pathData(e).match(/-?\d+(\.\d+)?/g) || []) assert.ok(Math.abs(Number(n)) <= 24, `${e}: ${n}`);
    }
  });
});

describe('接线：所有显示引擎图标的地方都用 EngineIcon', () => {
  test('旧的单独图标组件不在了，src 里也没人再引用', () => {
    const files = ['App.tsx', 'components/ChatArea.tsx', 'components/Sidebar.tsx', 'components/Icons.tsx',
      'components/EngineStatusPanel.tsx', 'components/AgentProfileSettings.tsx', 'components/LoginSettings.tsx'];
    for (const f of files) assert.doesNotMatch(read(f), /IconClaudeSpark|IconCodex\b|IconRobot/, f);
  });
  test('分屏标题旁徽标', () => {
    assert.match(read('App.tsx'), /<span className="engine-badge"[^>]*>\s*<EngineIcon engine=\{session\.engine\} size=\{14\} \/>/);
  });
  test('会话左下角那颗按钮（Claude Code / Codex 用自己的，Kiro 的 agent 按钮用 kiro 的）', () => {
    const ca = read('components', 'ChatArea.tsx');
    assert.match(ca, /<EngineIcon engine=\{engine\} size=\{15\} \/>/);
    assert.match(ca, /<EngineIcon engine="kiro" size=\{15\} \/>/);
  });
  test('引擎配置面板 / Kiro agent 配置面板的标题', () => {
    const ca = read('components', 'ChatArea.tsx');
    assert.match(ca, /<EngineIcon engine=\{engine\} size=\{17\} \/>\s*<h3 id="engine-config-title">/);
    assert.match(ca, /<EngineIcon engine="kiro" size=\{17\} \/>\s*<h3 id="agent-config-editor-title">/);
  });
  test('新建会话 / 设置 → 机器 里的引擎状态行', () => {
    assert.match(read('components', 'EngineStatusPanel.tsx'), /<EngineIcon engine=\{e\} size=\{14\} \/>\s*<span className="engine-status-name">/);
  });
  test('设置里 Claude Code / Codex 配置的 tab', () => {
    assert.match(read('components', 'AgentProfileSettings.tsx'), /<EngineIcon engine=\{e\} size=\{14\}/);
  });
  test('侧栏右键「运行引擎」子菜单的三个选项', () => {
    assert.match(read('components', 'Sidebar.tsx'), /<EngineIcon engine=\{eng\} size=\{14\}/);
  });
});

describe('颜色', () => {
  test('图标挂 data-accent-engine，颜色是 --engine-accent', () => {
    const icons = read('components', 'Icons.tsx');
    assert.match(icons, /data-accent-engine=\{e\}/);
    const css = read('styles', 'global.css');
    const i = css.indexOf('.engine-icon {');
    assert.match(css.slice(i, css.indexOf('}', i)), /color: var\(--engine-accent, var\(--accent\)\)/);
  });
  test('开关关掉时三者同色（形状另由上面的测试守着）', () => {
    const off = engineAccentCss(false);
    const accents = ACCENT_ENGINES.map((e) => (off.match(new RegExp(`^\\[data-accent-engine="${e}"\\] \\{ --engine-accent: (#[0-9a-f]{6})`, 'm')) || [])[1]);
    assert.equal(new Set(accents).size, 1);
    assert.ok(accents[0]);
  });
});
