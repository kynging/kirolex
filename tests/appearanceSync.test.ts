/**
 * 外观配置跨电脑同步（`src/main/appearanceSync.ts`）。
 *
 * 守的是：
 *   1. 载荷只有 主题 / 对比度 / 强调色 / 界面字体 / 等宽字体 / 聊天字号 + theme.json 原文 —— **没有 uiZoom**，也没有别的设置；
 *   2. 冲突整份按修改时刻取新的；只差空白不互传；
 *   3. 「在其他电脑上同步外观」关掉 → 不上传、不应用；
 *   4. 新电脑第一次记快照不会显得比别的电脑上真改过的更新；
 *   5. 接线：runS3Sync 里调了外观同步，载荷只从 pickSyncedSettings + theme.json 来，不碰 config.json。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  SYNCED_DEFAULTS, SYNCED_SETTING_KEYS, applySyncedSettings, runAppearanceSync, appearanceSyncEnabled, makePayload, noteLocalAppearance, parseBundle,
  parseSnapshot, pickSyncedSettings, planAppearanceSync, samePayload, serializeBundle, type AppearanceBundle,
} from '../src/main/appearanceSync.ts';

const FULL_SETTINGS = {
  fontSize: 14, uiZoom: 130, fontFamily: "'Segoe UI', Tahoma, sans-serif", monoFontFamily: 'Consolas, monospace',
  theme: 'light', contrast: 'high', accentColor: '#3b82f6', syncAppearance: true,
  mergeQueuedMessages: true, language: 'en', splitGrid: '2x2', engineAccents: false,
  remotes: [{ host: 'secret-box' }], s3Sync: { bucket: 'b' }, executorCap: 8,
};

describe('同步载荷', () => {
  test('只挑外观那几项：没有 uiZoom，也没有语言 / 远端 / S3 / 开关等别的字段', () => {
    const p = makePayload(FULL_SETTINGS, null);
    assert.deepEqual(Object.keys(p.settings).sort(), [...SYNCED_SETTING_KEYS].sort());
    assert.equal('uiZoom' in p.settings, false);
    const text = serializeBundle({ version: 1, updatedAt: 1, payload: p });
    for (const leak of ['uiZoom', 'secret-box', 'bucket', 'executorCap', 'language', 'splitGrid', 'syncAppearance']) {
      assert.equal(text.includes(leak), false, `${leak} 进了同步载荷`);
    }
    assert.equal(SYNCED_SETTING_KEYS.includes('uiZoom' as any), false);
  });
  test('坏值不进载荷（字号越界、强调色不是 #rrggbb、主题不认识）', () => {
    const s = pickSyncedSettings({ fontSize: 99, accentColor: 'red', theme: 'neon', contrast: 'max', fontFamily: 3 });
    assert.deepEqual(s, {});
  });
  test('应用桶里的设置：只改同步那几项，uiZoom 和别的字段保持本机的', () => {
    const local = { ...FULL_SETTINGS, uiZoom: 90, theme: 'dark', fontSize: 12 };
    const out = applySyncedSettings(local, { theme: 'light', fontSize: 16, uiZoom: 200 } as any);
    assert.equal(out.theme, 'light');
    assert.equal(out.fontSize, 16);
    assert.equal(out.uiZoom, 90);
    assert.equal(out.language, 'en');
    assert.deepEqual(out.remotes, FULL_SETTINGS.remotes);
    assert.equal(out.accentColor, '#3b82f6');   // 桶里没写的那项保持本机的
  });
  test('桶里那份读写往返；格式不对 = 当作没有', () => {
    const b: AppearanceBundle = { version: 1, updatedAt: 42, from: 'pc-a', payload: makePayload(FULL_SETTINGS, '{"dark":{}}') };
    assert.deepEqual(parseBundle(serializeBundle(b)), b);
    assert.equal(parseBundle('{'), null);
    assert.equal(parseBundle('{"version":2,"updatedAt":1,"payload":{}}'), null);
    assert.equal(parseBundle(null), null);
    /* 桶里被塞了别的字段（uiZoom 等）也不会进本机 */
    const sneaky = parseBundle(JSON.stringify({ version: 1, updatedAt: 1, payload: { settings: { uiZoom: 200, fontSize: 13, remotes: [1] }, themeJson: null } }))!;
    assert.deepEqual(Object.keys(sneaky.payload.settings).sort(), [...SYNCED_SETTING_KEYS].sort());
    assert.equal(sneaky.payload.settings.fontSize, 13);
    assert.equal('uiZoom' in sneaky.payload.settings, false);
  });
  test('本机快照读写；坏的 = 没有', () => {
    const snap = { updatedAt: 5, payload: makePayload(FULL_SETTINGS, null) };
    assert.deepEqual(parseSnapshot(JSON.stringify(snap)), snap);
    assert.equal(parseSnapshot('nope'), undefined);
  });
});

describe('冲突判断', () => {
  const A = makePayload({ ...FULL_SETTINGS, theme: 'dark' }, '{"dark": {"--text-muted": "#9a9a9a"}}');
  const B = makePayload({ ...FULL_SETTINGS, theme: 'light' }, '{"dark": {"--text-muted": "#9a9a9a"}}');
  const remote = (updatedAt: number, payload = B): AppearanceBundle => ({ version: 1, updatedAt, payload });

  test('本机改得更晚 → 上传本机那份（带本机的修改时刻）', () => {
    const p = planAppearanceSync({ enabled: true, local: { updatedAt: 200, payload: A }, remote: remote(100), machine: 'pc-a' });
    assert.equal(p.action, 'upload');
    if (p.action === 'upload') { assert.equal(p.bundle.updatedAt, 200); assert.deepEqual(p.bundle.payload, A); assert.equal(p.bundle.from, 'pc-a'); }
  });
  test('桶里的更晚 → 应用到本机', () => {
    const p = planAppearanceSync({ enabled: true, local: { updatedAt: 100, payload: A }, remote: remote(200) });
    assert.equal(p.action, 'apply');
    if (p.action === 'apply') assert.deepEqual(p.payload, B);
  });
  test('时刻一样内容不同 → 应用桶里的（两台电脑收敛到同一份，不来回传）', () => {
    assert.equal(planAppearanceSync({ enabled: true, local: { updatedAt: 0, payload: A }, remote: remote(0) }).action, 'apply');
  });
  test('桶里没有 → 上传', () => {
    assert.equal(planAppearanceSync({ enabled: true, local: { updatedAt: 0, payload: A }, remote: null }).action, 'upload');
  });
  test('只差空白 → 不互传（哪怕时刻不同）', () => {
    const spaced = makePayload({ ...FULL_SETTINGS, theme: 'dark' }, '{\n  "dark" : {\n    "--text-muted" : "#9a9a9a"\n  }\n}\n');
    assert.ok(samePayload(A, spaced));
    const p = planAppearanceSync({ enabled: true, local: { updatedAt: 999, payload: A }, remote: remote(1, spaced) });
    assert.deepEqual(p, { action: 'none', reason: 'same' });
    const q = planAppearanceSync({ enabled: true, local: { updatedAt: 1, payload: A }, remote: remote(999, spaced) });
    assert.deepEqual(q, { action: 'none', reason: 'same' });
  });
  test('开关关着：本机更新也不上传，桶里更新也不应用', () => {
    assert.deepEqual(planAppearanceSync({ enabled: false, local: { updatedAt: 200, payload: A }, remote: remote(100) }), { action: 'none', reason: 'disabled' });
    assert.deepEqual(planAppearanceSync({ enabled: false, local: { updatedAt: 100, payload: A }, remote: remote(200) }), { action: 'none', reason: 'disabled' });
    assert.deepEqual(planAppearanceSync({ enabled: false, local: { updatedAt: 1, payload: A }, remote: null }), { action: 'none', reason: 'disabled' });
  });
  test('开关缺省开，只有明确 false 才关', () => {
    assert.equal(appearanceSyncEnabled({}), true);
    assert.equal(appearanceSyncEnabled(null), true);
    assert.equal(appearanceSyncEnabled({ syncAppearance: false }), false);
  });
  test('uiZoom 改了不算外观改动（不进快照、不触发上传）', () => {
    const prev = { updatedAt: 10, payload: makePayload(FULL_SETTINGS, null) };
    const r = noteLocalAppearance(prev, makePayload({ ...FULL_SETTINGS, uiZoom: 80 }, null), 500);
    assert.equal(r.changed, false);
    assert.equal(r.snapshot.updatedAt, 10);
  });
});

describe('本机修改时刻', () => {
  test('一样 → 不动；变了 → 记 now；theme.json 只差空白不算变', () => {
    const p0 = makePayload(FULL_SETTINGS, '{"a":1}');
    const prev = { updatedAt: 10, payload: p0 };
    assert.equal(noteLocalAppearance(prev, makePayload(FULL_SETTINGS, '{ "a": 1 }\n'), 99).changed, false);
    const r = noteLocalAppearance(prev, makePayload({ ...FULL_SETTINGS, fontSize: 15 }, '{"a":1}'), 99);
    assert.equal(r.changed, true);
    assert.equal(r.snapshot.updatedAt, 99);
  });
  test('第一次记快照用 firstAt（默认 0），新电脑不会盖掉别的电脑上真改过的外观', () => {
    const r = noteLocalAppearance(undefined, makePayload({}, null), 1_000_000);
    assert.equal(r.snapshot.updatedAt, 0);
    const plan = planAppearanceSync({ enabled: true, local: r.snapshot, remote: { version: 1, updatedAt: 500, payload: makePayload({ theme: 'light' }, null) } });
    assert.equal(plan.action, 'apply');
  });
});

describe('接线（源码扫描）', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const fnBody = (name: string): string => {
    const i = M.indexOf(`async function ${name}(`);
    assert.ok(i >= 0, name);
    return M.slice(i, M.indexOf('\n}\n', i));
  };
  test('runS3Sync 每一轮都同步外观', () => {
    assert.match(fnBody('runS3Sync'), /syncAppearanceWithBucket\(creds!, cfg\.prefix\)/);
  });
  test('外观同步的载荷只来自 pickSyncedSettings / makePayload + theme.json，不读 config.json', () => {
    const body = fnBody('syncAppearanceWithBucket');
    assert.match(body, /runAppearanceSync\(\{/);
    assert.match(body, /isEnabled: \(\) => appearanceSyncEnabled\(readUiSettings\(\)\)/, '开关每次现读');
    assert.match(body, /APPEARANCE_REL/);
    assert.doesNotMatch(body, /KIROLEX_CONFIG_PATH|config\.json|loadSyncConfig\(\)\.(?!enabled)/);
    const cur = M.slice(M.indexOf('function currentAppearancePayload('), M.indexOf('\n}\n', M.indexOf('function currentAppearancePayload(')));
    assert.match(cur, /makePayload\(/);
    assert.doesNotMatch(cur, /KIROLEX_CONFIG_PATH|config\.json/);
  });
  test('s3Sync 的白名单照旧不含 config.json', () => {
    const s3 = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 's3Sync.ts'), 'utf8');
    assert.match(s3, /\*\*不同步\*\* `config\.json`/);
    assert.doesNotMatch(s3, /SHARED_DIRS = \[[^\]]*config/);
  });
});

describe('新电脑启动：自动保存的默认设置不算修改（审查意见 1）', () => {
  test('缺的项按默认值补齐：空设置和「带默认值的整份设置」是同一份载荷', () => {
    assert.ok(samePayload(makePayload({}, null), makePayload({ ...SYNCED_DEFAULTS, uiZoom: 100, language: 'zh' }, null)));
  });
  test('默认值和 App.tsx 的 DEFAULT_SETTINGS 一致', () => {
    const app = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf8');
    const i = app.indexOf('const DEFAULT_SETTINGS: Settings = {');
    assert.ok(i >= 0);
    const line = app.slice(i, app.indexOf('};', i));
    assert.ok(line.includes(`fontSize: ${SYNCED_DEFAULTS.fontSize},`), line);
    assert.ok(line.includes("fontFamily: '', monoFontFamily: '', theme: 'dark', contrast: 'standard', accentColor: ''"), line);
  });
  test('启动路径：先以空设置记快照，随后渲染端自动保存默认设置 → 不算修改；云端已有配置 → 应用云端的，不上传默认值', () => {
    const first = noteLocalAppearance(undefined, makePayload({}, null), 1_000, 0);
    assert.equal(first.snapshot.updatedAt, 0);
    const save = noteLocalAppearance(first.snapshot, makePayload({ ...SYNCED_DEFAULTS, uiZoom: 100, splitGrid: '1x2', syncAppearance: true }, null), 2_000);
    assert.equal(save.changed, false, '启动时的自动保存被当成了真实修改');
    const cloud: AppearanceBundle = { version: 1, updatedAt: 500, payload: makePayload({ theme: 'light', fontSize: 16, fontFamily: 'Consolas, monospace' }, '{"light":{}}') };
    const plan = planAppearanceSync({ enabled: true, local: save.snapshot, remote: cloud });
    assert.equal(plan.action, 'apply');
  });
});

describe('读桶期间关掉同步（审查意见 3）', () => {
  const local = { updatedAt: 900, payload: makePayload({ theme: 'light' }, null) };
  const older = serializeBundle({ version: 1, updatedAt: 100, payload: makePayload({ theme: 'dark' }, null) });
  const newer = serializeBundle({ version: 1, updatedAt: 5_000, payload: makePayload({ theme: 'dark' }, null) });
  const run = async (remoteText: string, flipDuringGet: boolean) => {
    let enabled = true;
    const puts: string[] = [];
    const applied: unknown[] = [];
    let release!: (v: string) => void;
    let started!: () => void;
    const getting = new Promise<void>((r) => { started = r; });
    const p = runAppearanceSync({
      isEnabled: () => enabled,
      local: () => local,
      getRemote: () => new Promise<string>((r) => { release = r; started(); }),
      put: async (t) => { puts.push(t); },
      apply: (payload) => { applied.push(payload); },
    });
    await getting;                         // 请求确实发出去了
    if (flipDuringGet) enabled = false;    // 请求还在路上，用户把开关关了
    release(remoteText);
    const r = await p;
    return { r, puts, applied };
  };
  test('本机更新 + 请求中途关掉 → 不上传', async () => {
    const { r, puts } = await run(older, true);
    assert.deepEqual(r.plan, { action: 'none', reason: 'disabled' });
    assert.equal(puts.length, 0);
  });
  test('桶里更新 + 请求中途关掉 → 不应用', async () => {
    const { r, applied } = await run(newer, true);
    assert.deepEqual(r.plan, { action: 'none', reason: 'disabled' });
    assert.equal(applied.length, 0);
  });
  test('开关一直开着 → 照常上传 / 应用（对照）', async () => {
    assert.equal((await run(older, false)).puts.length, 1);
    assert.equal((await run(newer, false)).applied.length, 1);
  });
  test('一开始就关着 → 连桶都不读', async () => {
    let got = false;
    const r = await runAppearanceSync({ isEnabled: () => false, local: () => local, getRemote: async () => { got = true; return null; }, put: async () => {}, apply: () => {} });
    assert.equal(r.plan.action, 'none');
    assert.equal(got, false);
  });
});

describe('应用关着时编辑 theme.json（审查意见：按文件实际修改时刻记）', () => {
  const H = 3600_000;
  const T8 = 8 * H, T10 = 10 * H, T11 = 11 * H, T12 = 12 * H;
  const settings = { ...SYNCED_DEFAULTS, theme: 'dark' };
  test('已有快照（8 点）→ 关着时 10 点改了文件 → 别的电脑 11 点改了外观 → 12 点启动：记成 10 点，用云端 11 点那份，不上传旧文件', () => {
    const prev = { updatedAt: T8, payload: makePayload(settings, '{"dark": {}}') };
    const r = noteLocalAppearance(prev, makePayload(settings, '{"dark": {"--text-muted": "#9a9a9a"}}'), T12, T10, T10);
    assert.equal(r.changed, true);
    assert.equal(r.snapshot.updatedAt, T10, '启动时发现的文件改动要记成文件的 mtime，不是启动时刻');
    const cloud: AppearanceBundle = { version: 1, updatedAt: T11, payload: makePayload({ ...settings, theme: 'light' }, '{"light": {}}') };
    const plan = planAppearanceSync({ enabled: true, local: r.snapshot, remote: cloud });
    assert.equal(plan.action, 'apply');
  });
  test('同样的离线编辑，云端那份更早（9 点）→ 本机 10 点的编辑更新，上传', () => {
    const prev = { updatedAt: T8, payload: makePayload(settings, '{"dark": {}}') };
    const r = noteLocalAppearance(prev, makePayload(settings, '{"dark": {"--border": "#444"}}'), T12, T10, T10);
    const plan = planAppearanceSync({ enabled: true, local: r.snapshot, remote: { version: 1, updatedAt: 9 * H, payload: makePayload({ ...settings, theme: 'light' }, null) } });
    assert.equal(plan.action, 'upload');
    if (plan.action === 'upload') assert.equal(plan.bundle.updatedAt, T10);
  });
  test('设置改了（应用里保存）→ 仍记 now，不看文件 mtime', () => {
    const prev = { updatedAt: T8, payload: makePayload(settings, '{"dark": {}}') };
    const r = noteLocalAppearance(prev, makePayload({ ...settings, fontSize: 15 }, '{"dark": {}}'), T12, T10, T10);
    assert.equal(r.snapshot.updatedAt, T12);
  });
  test('mtime 早于上一次快照（拷贝保留了旧 mtime）→ 记成上一次快照之后；晚于 now（时钟不准）→ 记 now；文件被删 → now', () => {
    const prev = { updatedAt: T10, payload: makePayload(settings, '{"dark": {}}') };
    assert.equal(noteLocalAppearance(prev, makePayload(settings, '{"light": {}}'), T12, T8, T8).snapshot.updatedAt, T10 + 1);
    assert.equal(noteLocalAppearance(prev, makePayload(settings, '{"light": {}}'), T12, T12 + H, T12 + H).snapshot.updatedAt, T12);
    assert.equal(noteLocalAppearance(prev, makePayload(settings, null), T12, 0, undefined).snapshot.updatedAt, T12);
  });
  test('接线：主进程把 theme.json 的 mtime 传给 noteLocalAppearance', () => {
    const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
    assert.match(M, /noteLocalAppearance\(prev, currentAppearancePayload\(\), Date\.now\(\), mtime \?\? 0, mtime\)/);
  });
});
