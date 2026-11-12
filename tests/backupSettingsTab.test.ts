import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { backupConfigured } from '../src/renderer/backupGroups.ts';

/*
  「这个恢复功能的配置似乎有问题哦，难道不应该在同步恢复那个里面配置吗」。
  备份的配置从 设置 → ☁️ 备份 搬进侧栏 ☁️ 对话框的第四个页签「设置」；
  「已开启跨电脑同步的会话」放在「同步」页签；设置面板不再有备份那一页。
*/
const read = (p: string): string => fs.readFileSync(new URL(`../src/renderer/${p}`, import.meta.url), 'utf8');
const UI = read('components/BackupDialog.tsx');
const CONF = read('components/BackupSettings.tsx');
const SD = read('components/SettingsDialog.tsx');
const APP = read('App.tsx');
const ZHP = read('i18nZh/settingsPanels.ts');
const ZHS = read('i18nZh/shell.ts');

const section = (key: string): string => {
  const at = UI.indexOf(`{tab === '${key}' && (`);
  assert.ok(at >= 0, `没有 ${key} 页签的内容`);
  const next = UI.indexOf('{tab === ', at + 10);
  return UI.slice(at, next > 0 ? next : undefined);
};

test('对话框有第四个页签「设置」，渲染的就是 BackupSettings', () => {
  assert.match(UI, /useState<'sync' \| 'restore' \| 'trash' \| 'settings'>/);
  assert.match(UI, /tab === 'settings' \? 'active' : ''\}`\} onClick=\{\(\) => pickTab\('settings'\)\}>\s*\{t\('Settings'\)\}/);
  assert.match(UI, /import \{ BackupSettings, CrossDeviceList, Field \} from '\.\/BackupSettings\.tsx';/);
  assert.match(section('settings'), /<BackupSettings onSaved=\{\(\) => void loadConfig\(\)\} \/>/);
  assert.match(read('i18n.ts'), /'Settings': '设置'/);
});

test('「已开启跨电脑同步的会话」在同步页签里，设置页签不再重复', () => {
  assert.match(section('sync'), /<CrossDeviceList \/>/);
  assert.match(section('sync'), /label=\{t\('Sessions from other computers'\)\}/);
  /* BackupSettings 只导出列表，自己不再渲染它 */
  assert.match(CONF, /export const CrossDeviceList/);
  assert.equal(CONF.includes('<CrossDeviceList />'), false);
  assert.equal(CONF.includes("t('Sessions from other computers')"), false);
});

test('设置面板不再有备份那一页', () => {
  assert.equal(/id: 'backup'/.test(SD), false);
  assert.equal(SD.includes('BackupSettings'), false);
  assert.equal(/type SettingsTab = [^;]*'backup'/.test(SD), false);
  assert.equal(/settingsTab, setSettingsTab\] = useState<[^>]*'backup'/.test(APP), false);
});

test('没配好时默认停在「设置」页签，配好了是「同步」', () => {
  assert.match(UI, /if \(!tabTouched\.current\) setTab\(backupConfigured\(cfg\) \? 'sync' : 'settings'\);/);
  /* 用户自己点了页签就不再被改 */
  assert.match(UI, /const pickTab = \(next: typeof tab\): void => \{ tabTouched\.current = true; setTab\(next\); \};/);
});

test('标题里没配桶时是可点的「去设置」', () => {
  assert.equal(UI.includes('No bucket configured yet (Settings → ☁️ Backup)'), false);
  assert.match(UI, /t\('No bucket configured yet'\)/);
  assert.match(UI, /onClick=\{\(\) => pickTab\('settings'\)\}>\{t\('Go to settings'\)\}/);
  assert.match(ZHP, /'Go to settings': '去设置'/);
  assert.match(ZHP, /'No bucket configured yet': '还没配桶'/);
  /* 旧的、指向设置面板的文案都不在了 */
  for (const src of [UI, ZHP, ZHS, read('components/Sidebar.tsx')]) assert.equal(src.includes('Settings → ☁️ Backup'), false);
});

test('backupConfigured：桶 + 区域 + 凭证齐了且主进程没报问题才算配好', () => {
  assert.equal(backupConfigured(null), false);
  assert.equal(backupConfigured({ bucket: '', region: 'r', credentialSource: 'default' }), false);
  assert.equal(backupConfigured({ bucket: 'b', region: '', credentialSource: 'default' }), false);
  assert.equal(backupConfigured({ bucket: 'b', region: 'r', credentialSource: 'default' }), true);
  assert.equal(backupConfigured({ bucket: 'b', region: 'r', credentialSource: 'profile', awsProfile: 'p' }), true);
  /* AK/SK（缺省）要 AK 和存好的 secret 都在 */
  assert.equal(backupConfigured({ bucket: 'b', region: 'r', accessKeyId: 'AK', hasSecret: false }), false);
  assert.equal(backupConfigured({ bucket: 'b', region: 'r', credentialSource: 'keys', accessKeyId: 'AK', hasSecret: true }), true);
  /* 密钥解不开（换机器 / 重装）—— 字段齐了也不算 */
  assert.equal(backupConfigured({ bucket: 'b', region: 'r', credentialSource: 'keys', accessKeyId: 'AK', hasSecret: true, credsProblem: 'x' }), false);
});
