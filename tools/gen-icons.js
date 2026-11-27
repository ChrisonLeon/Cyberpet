'use strict';
// 生成应用图标和托盘图标：electron tools/gen-icons.js
// 复用桌宠同一套 SVG 素材，在隐藏窗口里渲染后截图导出。
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'assets');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024, height: 1024, show: false, frame: false, transparent: true, useContentSize: true,
    webPreferences: { offscreen: false, forceDeviceScaleFactor: 2 },
  });
  await win.loadFile(path.join(__dirname, 'icon.html'));
  const grab = async (kind, width, height, file, outWidth) => {
    await win.webContents.executeJavaScript(`window.show(${JSON.stringify(kind)})`);
    // 等一帧让滤镜和图片都合成完
    await new Promise((resolve) => setTimeout(resolve, 400));
    const img = await win.webContents.capturePage({ x: 0, y: 0, width, height });
    const final = outWidth && outWidth !== img.getSize().width ? img.resize({ width: outWidth }) : img;
    fs.writeFileSync(path.join(OUT, file), final.toPNG());
    console.log(`${file}  ${final.getSize().width}x${final.getSize().height}  cornerAlpha=${final.toBitmap()[3]}`);
  };
  await grab('app', 1024, 1024, 'icon.png', 1024);
  await grab('tray2x', 44, 44, 'trayTemplate@2x.png');
  await grab('tray', 22, 22, 'trayTemplate.png');
  await grab('traycolor', 128, 128, 'tray.png', 32);
  app.quit();
});
