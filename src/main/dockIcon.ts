import path from 'path';

/**
 * Mac 的 Dock 图标 ——「npm start 跑时 Dock 上是 Electron 默认图标」。
 * 没打包时 Dock 用的是 Electron.app 自己的图标，得在运行时用 build/icon.png 设一下；
 * Dock 上的**名字**仍是 Electron（Electron.app 的 Info.plist 决定，运行时改不了）。
 * 打包版也调用，无害（dist 里没有 build/ 时只 warn 一条，Dock 照旧用 .icns）。
 * 依赖全注入，测试里用假的 app / nativeImage（tests/dockIcon.test.ts）。
 */
export interface DockIconDeps {
  platform: string;
  app: { getAppPath(): string; dock?: { setIcon(img: any): void } };
  nativeImage: { createFromPath(p: string): { isEmpty(): boolean } };
  existsSync(p: string): boolean;
  warn(message: string): void;
}

export function dockIconPath(appPath: string): string {
  return path.join(appPath, 'build', 'icon.png');
}

/** 设上了返回 true；非 darwin / 没有 dock / 文件缺失 / 图片为空都返回 false，从不抛错。 */
export function applyDockIcon(deps: DockIconDeps): boolean {
  if (deps.platform !== 'darwin' || !deps.app.dock) return false;
  try {
    const file = dockIconPath(deps.app.getAppPath());
    if (!deps.existsSync(file)) {
      deps.warn(`Dock 图标文件不存在：${file}`);
      return false;
    }
    const img = deps.nativeImage.createFromPath(file);
    if (img.isEmpty()) {
      deps.warn(`Dock 图标读出来是空图：${file}`);
      return false;
    }
    deps.app.dock.setIcon(img);
    return true;
  } catch (e) {
    deps.warn(`设置 Dock 图标失败：${(e as Error)?.message ?? e}`);
    return false;
  }
}
