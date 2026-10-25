/**
 * **三个引擎的图标形状** ——「Claude Code 和 Codex 的图标看起来差不多」。
 *
 * 原来 Claude Code 是八根细线的星芒、Codex 是细线画的六瓣结：两个都是「从中心往外的一圈细线」，
 * 11～15px 下看起来是同一团。现在三个用三种**轮廓类型**，不靠颜色也分得清：
 *   - Kiro：方头机器人（沿用原来的，描边、方形）；
 *   - Claude Code：**实心**的尖角星芒（长短交替的八个尖，Claude 那个火花的意思），填色、没有描边；
 *   - Codex：**空心**的结 —— 六个圆弧瓣围成的花形外圈 + 中间一个六边形的孔（OpenAI 那个结的简化），描边。
 * 都是自己画的简化 SVG（不是商标图片）。颜色走 `engineTheme.ts` 的 `--engine-accent`（见 Icons.tsx 的 `EngineIcon`）。
 *
 * 纯数据，不 import React —— `tests/engineIcons.test.ts` 直接断言三者互不相同、类型不同。
 */
import type { AccentEngine } from './engineTheme.ts';

export interface IconPart {
  d: string;
  /** true = 实心填色；false = 描边 */
  filled: boolean;
}
export interface EngineIconShape {
  parts: IconPart[];
  strokeWidth: number;
}

const f = (n: number) => String(Math.round(n * 100) / 100);
const at = (r: number, deg: number): [number, number] => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [12 + r * Math.cos(a), 12 + r * Math.sin(a)];
};

/** 实心星芒：八个尖，长短交替（11 / 8），尖之间收到半径 3.4 —— 芯子够粗，14px 下不会缩成一个点 */
function starburst(): string {
  const pts: string[] = [];
  for (let i = 0; i < 8; i++) {
    const tip = at(i % 2 === 0 ? 11 : 8, i * 45);
    const valley = at(3.4, i * 45 + 22.5);
    pts.push(`${f(tip[0])} ${f(tip[1])}`, `${f(valley[0])} ${f(valley[1])}`);
  }
  return `M${pts.join(' L')} Z`;
}

/** 空心结的外圈：六边形的六个顶点之间各鼓出一段圆弧（花瓣），首尾相接 */
function knotRing(): string {
  const v = Array.from({ length: 6 }, (_, i) => at(7.2, i * 60 + 30));
  let d = `M${f(v[0][0])} ${f(v[0][1])}`;
  for (let i = 1; i <= 6; i++) {
    const p = v[i % 6];
    d += ` A4.2 4.2 0 0 1 ${f(p[0])} ${f(p[1])}`;
  }
  return `${d} Z`;
}

/** 中间的六边形孔 */
function knotHole(): string {
  const v = Array.from({ length: 6 }, (_, i) => at(3, i * 60));
  return `M${v.map((p) => `${f(p[0])} ${f(p[1])}`).join(' L')} Z`;
}

export const ENGINE_ICON_SHAPES: Record<AccentEngine, EngineIconShape> = {
  kiro: {
    strokeWidth: 1.8,
    parts: [
      { d: 'M12 3v3', filled: false },
      { d: 'M12 1.5a1 1 0 1 0 0.01 0Z', filled: true },
      { d: 'M8 6h8a4 4 0 0 1 4 4v5a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-5a4 4 0 0 1 4-4Z', filled: false },
      { d: 'M9 10.8a1.2 1.2 0 1 0 0.01 0Z', filled: true },
      { d: 'M15 10.8a1.2 1.2 0 1 0 0.01 0Z', filled: true },
      { d: 'M9 16h6', filled: false },
    ],
  },
  claude: {
    strokeWidth: 0,
    parts: [{ d: starburst(), filled: true }],
  },
  codex: {
    strokeWidth: 2.2,
    parts: [
      { d: knotRing(), filled: false },
      { d: knotHole(), filled: false },
    ],
  },
};
