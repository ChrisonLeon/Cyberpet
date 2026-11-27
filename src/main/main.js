'use strict';
const {
  app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, shell, dialog, clipboard, systemPreferences, net,
} = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { pathToFileURL } = require('url');
const { SettingsStore } = require('./settings');
const { InputHook } = require('./hooks');
const { PrivacyController } = require('./privacy-controller');
const { labelFor } = require('../shared/keys');
const { importFile } = require('./importer');
const { initUpdater } = require('./updater');

// 真实的操作系统：决定窗口类型、授权弹窗这些必须按真实平台来的事
const REAL_PLATFORM = process.platform;
const IS_MAC = REAL_PLATFORM === 'darwin';
const SELFTEST_DIR = process.env.BXC_PET_SELFTEST || '';
// 只在冒烟测试时允许「模拟成另一个系统」，检验按键标签、键盘刻字这些展示逻辑；正常启动永远是真实平台
const PLATFORM = SELFTEST_DIR && process.env.BXC_PET_PLATFORM ? process.env.BXC_PET_PLATFORM : REAL_PLATFORM;

const APP_TITLE = 'Cyberpet';
const PET_SIZE = { width: 394, height: 430 };
const PANEL_SIZE = { width: 840, height: 1070 }; // 宽高按内容实测校准（selftest「面板布局」日志），默认视图一屏放下、无滚动条
const BANNER_H = 82; // 授权横幅出现时窗口扩高的量（横幅高度 + 上下边距）
const ACTIONS = new Set(['type-demo', 'frenzy', 'mouse-demo', 'pat', 'angry']);
const HEAD_VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'm4v']);
const IMAGE_PICK_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
const AUDIO_PICK_EXTS = ['mp3', 'wav', 'm4a', 'aac', 'ogg'];

// 作者信息：显示在控制面板底部「支持」一行
const AUTHOR = {
  show: true,
  name: '凉拌卡皮巴拉',
  douyin: 'https://v.douyin.com/sAG1aUn2fRE/', // 抖音主页（短链接）
  douyinId: 'Chrison_Leon',
  github: 'https://github.com/ChrisonLeon/Cyberpet',
  gitee: 'https://gitee.com/chrison/Cyberpet',
};

// 意外异常只记日志，不让整个程序退出
process.on('uncaughtException', (err) => {
  console.error('[main] 未捕获的异常（已忽略，程序继续运行）:', err);
});

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (REAL_PLATFORM === 'win32') app.setAppUserModelId('top.baixiaochun.pet');

let store = null;
let settings = null;
let hook = null;
let privacyCtl = null;
let privacyHidden = false; // 录屏/全屏期间被自动隐藏；恢复时按用户自己的显隐选择还原
let petWin = null;
let panelWin = null;
let tray = null;
let trayMenu = null;
let petReady = false;
let panelReady = false;
let ignoreState = null;
let petStatus = { fps: 0, mode: '启动中' };
let assetsDir = '';
let rendererDir = '';
let userDataDir = '';
let updater = null;

// 单实例锁以 productName 命名：开发 / 冒烟若与打包版共用「Cyberpet」，打包版运行时这里会静默退出。
// 在申请锁之前就把 userData 分开：打包版 = Cyberpet，开发 = Cyberpet-dev，冒烟 = 独立测试目录。
if (!app.isPackaged && !SELFTEST_DIR) {
  app.setPath('userData', path.join(app.getPath('appData'), 'Cyberpet-dev'));
}
if (SELFTEST_DIR) app.setPath('userData', path.resolve(SELFTEST_DIR) + '-profile');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    setSettings({ petVisible: true, panelVisible: true });
    if (panelWin) panelWin.show();
  });
}

const at = (dir, ...parts) => path.join(dir, ...parts);

// 开发 / 自测模式下，把渲染进程的报错回显到主进程控制台
function watchConsole(win, name) {
  if (app.isPackaged && !SELFTEST_DIR) return;
  win.webContents.on('console-message', (e, legacyLevel, legacyMessage) => {
    const raw = e && e.level !== undefined ? e.level : legacyLevel;
    const level = typeof raw === 'string' ? (raw === 'error' ? 3 : raw === 'warning' ? 2 : 0) : (raw ?? 0);
    if (level >= 2) console.error(`[renderer:${name}] ${(e && e.message) || legacyMessage || ''}`);
  });
}

// 渲染进程意外挂掉时自动重载，桌宠不至于「消失」
function keepAlive(win, name) {
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[renderer:${name}] 进程退出（${details.reason}），1 秒后重载`);
    if (details.reason === 'clean-exit') return;
    setTimeout(() => {
      if (win && !win.isDestroyed()) win.webContents.reload();
    }, 1000);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    if (code !== -3) console.error(`[renderer:${name}] 页面加载失败 ${code} ${desc}`); // -3 = 被新导航取消，不算错误
  });
}

function fileExists(file) {
  return !!file && typeof file === 'string' && fs.existsSync(file);
}

// macOS 打包版：从「应用程序」以外的位置启动时，提示移入后再继续。
// 授权绑定的是具体应用路径，固定位置能让「辅助功能」里的勾选持续有效；不自动重置、不静默覆盖。
async function ensureInstalledLocation() {
  if (!IS_MAC || !app.isPackaged || SELFTEST_DIR) return;
  if (settings.installChecked) return;
  if (typeof app.isInApplicationsFolder === 'function' && app.isInApplicationsFolder()) {
    store.set({ installChecked: true });
    return;
  }
  const r = await dialog.showMessageBox({
    type: 'question',
    title: `${APP_TITLE} 安装`,
    message: '要把 Cyberpet 移入「应用程序」文件夹吗？',
    detail: '放在「应用程序」里，键鼠监听所需的辅助功能授权更稳定；以后从启动台打开的也始终是同一个应用。',
    buttons: ['移入应用程序', '暂不移动，继续运行'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  }).catch(() => ({ response: 1 }));
  if (r.response !== 0) {
    store.set({ installChecked: true }); // 用户拒绝过就不再每次打扰
    return;
  }
  let moved = false;
  try { moved = app.moveToApplicationsFolder(); } catch { moved = false; }
  if (moved) {
    store.set({ installChecked: true });
    // 当前进程是从旧路径启动的，二进制已被搬走：交给用户从新位置重新打开
    await dialog.showMessageBox({
      type: 'info', title: APP_TITLE, message: '已移入「应用程序」',
      detail: '本次启动即将退出。请从「应用程序」或启动台重新打开 Cyberpet，然后第一次使用键盘前在系统设置里完成辅助功能授权。',
      buttons: ['知道了'], noLink: true,
    }).catch(() => {});
    app.exit(0);
    return;
  }
  await dialog.showMessageBox({
    type: 'info', title: APP_TITLE, message: '没有完成移动',
    detail: '「应用程序」里可能已有同名版本。已保留当前副本继续运行；建议手动整理后从「应用程序」中的版本启动，以免授权绑定到不同路径。',
    buttons: ['知道了'], noLink: true,
  }).catch(() => {});
}

function defaultPetPos() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - PET_SIZE.width - 16, y: wa.y + wa.height - PET_SIZE.height };
}

function isOnScreen(pos, size) {
  if (!pos) return false;
  for (const d of screen.getAllDisplays()) {
    const wa = d.workArea;
    const overlapX = Math.min(pos.x + size.width, wa.x + wa.width) - Math.max(pos.x, wa.x);
    const overlapY = Math.min(pos.y + size.height, wa.y + wa.height) - Math.max(pos.y, wa.y);
    if (overlapX >= size.width * 0.5 && overlapY >= size.height * 0.5) return true;
  }
  return false;
}

function posOf(win) {
  const [x, y] = win.getPosition();
  return { x, y };
}

function defaultPanelPos(petPos) {
  const wa = screen.getDisplayMatching({ ...petPos, ...PET_SIZE }).workArea;
  let pos = { x: petPos.x + PET_SIZE.width - PANEL_SIZE.width, y: petPos.y - PANEL_SIZE.height - 10 };
  if (pos.y < wa.y) pos = { x: petPos.x - PANEL_SIZE.width - 10, y: petPos.y + PET_SIZE.height - PANEL_SIZE.height };
  if (pos.x < wa.x) pos.x = wa.x + 16;
  pos.x = Math.min(pos.x, wa.x + wa.width - PANEL_SIZE.width);
  pos.y = Math.max(pos.y, wa.y + 8);
  return pos;
}

// 窗口位置随设置持久化；换了显示器或分辨率后把跑到屏幕外的窗口拉回来
function ensureOnScreen() {
  if (petWin && petReady && !isOnScreen(posOf(petWin), PET_SIZE)) {
    const pos = defaultPetPos();
    petWin.setPosition(pos.x, pos.y);
  }
  if (panelWin && panelReady && !isOnScreen(posOf(panelWin), PANEL_SIZE)) {
    const pos = defaultPanelPos(posOf(petWin));
    panelWin.setPosition(pos.x, pos.y);
  }
}

let saveTimer = null;
function savePositions() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (petWin && petReady) store.set({ petPos: posOf(petWin) });
    if (panelWin && panelReady) store.set({ panelPos: posOf(panelWin) });
  }, 400);
}

function createPetWindow() {
  const pos = isOnScreen(settings.petPos, PET_SIZE) ? settings.petPos : defaultPetPos();
  petWin = new BrowserWindow({
    ...PET_SIZE,
    x: pos.x,
    y: pos.y,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    alwaysOnTop: settings.alwaysOnTop,
    skipTaskbar: true,
    focusable: false, // 点桌宠不抢走当前 App 的焦点，打字不会被打断
    type: IS_MAC ? 'panel' : undefined,
    title: `${APP_TITLE}`,
    webPreferences: {
      preload: at(__dirname, '..', 'preload', 'pet.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  petWin.setAlwaysOnTop(settings.alwaysOnTop, 'floating');
  petWin.setVisibleOnAllWorkspaces(true, IS_MAC ? { visibleOnFullScreen: true } : undefined);
  petWin.loadFile(at(rendererDir, 'pet', 'index.html'));
  watchConsole(petWin, 'pet');
  keepAlive(petWin, 'pet');
  petWin.once('ready-to-show', () => {
    petReady = true;
    applyWindowSettings();
  });
  petWin.on('moved', savePositions);
  petWin.on('closed', () => { petWin = null; });
}

function createPanelWindow() {
  const petPos = petWin.getPosition();
  const pos = isOnScreen(settings.panelPos, PANEL_SIZE) ? settings.panelPos : defaultPanelPos({ x: petPos[0], y: petPos[1] });
  panelWin = new BrowserWindow({
    ...PANEL_SIZE,
    x: pos.x,
    y: pos.y,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    alwaysOnTop: settings.alwaysOnTop,
    skipTaskbar: false,
    title: `${APP_TITLE} · 控制面板`,
    icon: at(assetsDir, 'icon.png'),
    webPreferences: {
      preload: at(__dirname, '..', 'preload', 'panel.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  panelWin.setAlwaysOnTop(settings.alwaysOnTop, 'floating');
  panelWin.loadFile(at(rendererDir, 'panel', 'index.html'));
  watchConsole(panelWin, 'panel');
  keepAlive(panelWin, 'panel');
  panelWin.once('ready-to-show', () => {
    panelReady = true;
    applyWindowSettings();
  });
  panelWin.on('closed', () => { panelWin = null; });
  panelWin.on('moved', savePositions);
}

function trayIcon() {
  const img = nativeImage.createFromPath(at(assetsDir, IS_MAC ? 'trayTemplate.png' : 'tray.png'));
  if (IS_MAC) img.setTemplateImage(true);
  return img;
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: settings.petVisible ? '隐藏桌宠' : '显示桌宠', click: () => setSettings({ petVisible: !settings.petVisible }) },
    { label: settings.panelVisible ? '收起控制面板' : '打开控制面板', click: () => setSettings({ panelVisible: !settings.panelVisible }) },
    { type: 'separator' },
    { label: '⌨ 试试打字', click: () => sendAction('type-demo') },
    { label: '🐾 摸摸脑袋', click: () => sendAction('pat') },
    { label: '🔥 能别放屁吗!', click: () => sendAction('angry') },
    { type: 'separator' },
    { label: '窗口置顶', type: 'checkbox', checked: settings.alwaysOnTop, click: (item) => setSettings({ alwaysOnTop: item.checked }) },
    ...(app.isPackaged ? [{
      label: '开机自动启动',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    }] : []),
    { label: '使用说明', click: showHelp },
    { type: 'separator' },
    { label: `退出${APP_TITLE}`, role: 'quit' },
  ]);
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip(APP_TITLE);
  trayMenu = buildTrayMenu();
  tray.on('click', () => setSettings({ panelVisible: !settings.panelVisible }));
  tray.on('right-click', () => tray.popUpContextMenu(trayMenu));
  if (!IS_MAC) tray.setContextMenu(trayMenu);
}

function refreshTray() {
  if (!tray) return;
  trayMenu = buildTrayMenu();
  if (!IS_MAC) tray.setContextMenu(trayMenu);
}

function showHelp() {
  dialog.showMessageBox({
    type: 'info',
    title: `${APP_TITLE} · 使用说明`,
    message: '怎么玩？',
    detail: [
      '· 直接敲键盘：猫爪移到对应的键上按下去，弹出按键气泡，播放键盘音效',
      '· 移动鼠标：小猫伸爪去抓旁边的鼠标',
      '· 敲一下脑袋：触发「能别放屁吗!」',
      '· 按住脑袋左右滑：摸头',
      '· 拖动身子 / 键盘 / 桌垫：移动桌宠',
      '',
      '配音：视频头像勾选「原声彩蛋」后，触发时播放视频原声；',
      '　　图片头像或取消勾选时，播放「导入配音」的音频；都没有就用合成音效。',
      '',
      ...(AUTHOR.show ? [`作者：${AUTHOR.name}${AUTHOR.douyinId ? `（抖音 @${AUTHOR.douyinId}）` : ''}`] : []),
      '隐私：按键只用来画气泡，不记录、不上传。',
    ].join('\n'),
    buttons: ['知道了'],
    defaultId: 0,
    noLink: true,
  }).catch(() => {});
}

function meta() {
  const head = fileExists(settings.head) ? settings.head : null;
  const voice = fileExists(settings.voice) ? settings.voice : null;
  const headType = head && HEAD_VIDEO_EXTS.has(path.extname(head).slice(1).toLowerCase()) ? 'video' : 'image';
  const strip = (file) => path.basename(file).replace(/^\d+(?:-\d{3})?-/, '');
  return {
    platform: PLATFORM,
    isMac: PLATFORM === 'darwin',
    author: AUTHOR.show ? { ...AUTHOR, show: undefined } : null,
    headType, // 头像是图片还是视频，渲染层据此互斥显示
    headSrc: pathToFileURL(head || at(assetsDir, 'heads', 'default-head.png')).href,
    headIsCustom: !!head,
    headName: head ? strip(head) : '默认头像',
    defaultHeadSrc: pathToFileURL(at(assetsDir, 'heads', 'default-head.png')).href,
    voiceSrc: voice ? pathToFileURL(voice).href : null,
    voiceName: voice ? strip(voice) : '',
    version: app.getVersion(),
    dev: !app.isPackaged,
    execPath: process.execPath,
    isInstalled: IS_MAC && typeof app.isInApplicationsFolder === 'function' ? app.isInApplicationsFolder() : true,
  };
}

function hookInfo() {
  return {
    state: hook.state,
    error: hook.error ? String(hook.error.message || hook.error) : null,
    loadVia: hook.loadVia,
    axTrusted: IS_MAC ? systemPreferences.isTrustedAccessibilityClient(false) : true,
  };
}

function payload() {
  return { settings, meta: meta(), hook: hookInfo(), privacy: privacyCtl ? privacyCtl.getState() : null };
}

function broadcast(channel, data, exceptSender) {
  for (const win of [petWin, panelWin]) {
    if (win && !win.isDestroyed() && win.webContents !== exceptSender) win.webContents.send(channel, data);
  }
}

function setSettings(patch, source) {
  settings = store.set(patch);
  if (privacyCtl && patch && typeof patch.privacy === 'boolean') privacyCtl.setEnabled(patch.privacy);
  applyWindowSettings();
  broadcast('settings', payload(), source);
  return payload();
}

function applyWindowSettings() {
  if (petWin && !petWin.isDestroyed()) {
    petWin.setAlwaysOnTop(settings.alwaysOnTop, 'floating');
    petWin.setContentProtection(!!settings.privacy);
    // 整体大小：窗口尺寸和内容缩放一起变，右下角保持不动（桌宠像「放在桌角」的感觉）
    if (petReady) {
      const scale = Math.min(1.5, Math.max(0.6, settings.petScale || 1));
      const target = { width: Math.round(PET_SIZE.width * scale), height: Math.round(PET_SIZE.height * scale) };
      const [curW, curH] = petWin.getContentSize();
      if (Math.abs(curW - target.width) > 1 || Math.abs(curH - target.height) > 1) {
        const [x, y] = petWin.getPosition();
        // 窗口平时禁止用户调整大小；程序化改尺寸需要临时放开（macOS 会拒绝不可调窗口的 setContentSize）
        petWin.setResizable(true);
        petWin.setContentSize(target.width, target.height);
        petWin.setResizable(false);
        petWin.setPosition(x + curW - target.width, y + curH - target.height);
      }
      if (Math.abs(petWin.webContents.getZoomFactor() - scale) > 0.01) petWin.webContents.setZoomFactor(scale);
    }
    if (petReady && petWin.isVisible() !== settings.petVisible) {
      if (settings.petVisible) petWin.showInactive();
      else petWin.hide();
    }
  }
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.setAlwaysOnTop(settings.alwaysOnTop, 'floating');
    if (panelReady && panelWin.isVisible() !== settings.panelVisible) {
      if (settings.panelVisible) panelWin.showInactive();
      else panelWin.hide();
    }
  }
  refreshTray();
}

function sendAction(name) {
  if (!ACTIONS.has(name)) return;
  if (settings.petVisible === false) setSettings({ petVisible: true });
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send('action', name);
}

function onInputEvent(ev) {
  if (SELFTEST_DIR && !ev.__test) return; // 自测期间不转发真实键鼠事件（会干扰断言），只放行带标记的测试输入
  if (ev.kind === 'key') ev.label = labelFor(ev.name, PLATFORM);
  if (petWin && !petWin.isDestroyed() && petWin.isVisible()) petWin.webContents.send('input', ev);
}

// macOS 授权后不用重启：钩子没起来时定期看一眼权限，有了就重新启动
function watchHook() {
  if (hook.state !== 'live') {
    const trusted = !IS_MAC || systemPreferences.isTrustedAccessibilityClient(false);
    // 未授权时不空转；unavailable 说明组件缺失，重试也不会成功，等「重新检测」按钮
    if (trusted && hook.state !== 'unavailable') hook.start();
  }
  setTimeout(watchHook, hook.state === 'error' ? 3000 : 60000).unref();
}

// macOS 的全局键鼠监听需要「辅助功能」权限：主动弹一次系统授权框
function requestAccessibility() {
  if (!IS_MAC) return;
  try {
    systemPreferences.isTrustedAccessibilityClient(true);
  } catch {
    // 弹不出授权框也不影响其余功能
  }
}

// 选完头像 / 配音：选中哪个就用哪个，立刻生效。文件会复制进应用自己的数据目录，原文件之后挪走也不影响。
async function importHead(e, srcPath, lastDir) {
  const head = await importFile(srcPath, at(userDataDir, 'heads'), 10, [settings.head]);
  return setSettings({ head, headMode: 'photo', lastImageDir: lastDir, lastVideoDir: lastDir }, e.sender);
}

async function importVoice(e, srcPath, lastDir) {
  const voice = await importFile(srcPath, at(userDataDir, 'voice'), 4, [settings.voice]);
  return setSettings({ voice, lastAudioDir: lastDir }, e.sender);
}

function startingDir(key, fallback) {
  const dir = settings[key];
  return dir && fs.existsSync(dir) ? dir : fallback;
}

// 有些 Windows 系统没有「图片 / 视频」库，getPath 会抛异常：降级到用户目录
function safeGetPath(name) {
  try {
    return app.getPath(name);
  } catch {
    return app.getPath('home');
  }
}

function isFromPanel(e) {
  return !!panelWin && !panelWin.isDestroyed() && e.sender === panelWin.webContents;
}

function isFromPet(e) {
  return !!petWin && !petWin.isDestroyed() && e.sender === petWin.webContents;
}

function registerIpc() {
  ipcMain.on('pet:ready', (e) => {
    if (isFromPet(e)) e.sender.send('settings', payload());
  });
  ipcMain.on('pet:ignore', (e, ignore) => {
    if (!isFromPet(e)) return;
    ignoreState = !!ignore;
    petWin.setIgnoreMouseEvents(!!ignore, { forward: true });
  });
  ipcMain.on('pet:moveBy', (e, { dx, dy } = {}) => {
    if (!isFromPet(e) || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const [x, y] = petWin.getPosition();
    petWin.setPosition(Math.round(x + dx), Math.round(y + dy));
  });
  ipcMain.on('pet:dragEnd', (e) => {
    if (isFromPet(e)) store.set({ petPos: posOf(petWin) });
  });
  ipcMain.on('pet:headOffset', (e, off) => {
    if (!isFromPet(e)) return;
    setSettings({ headOffset: off || null }); // 走 setSettings：更新内存 + 落盘 + 广播
  });
  ipcMain.on('pet:headBroken', (e) => {
    if (isFromPet(e)) setSettings({ head: null, headMode: 'cartoon' }); // 头像打不开：回到默认的 Q 版猫头
  });
  ipcMain.on('pet:status', (e, s) => {
    if (!isFromPet(e) || !s) return;
    petStatus = s;
    if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send('pet:status', s);
  });

  ipcMain.handle('settings:get', (e) => (isFromPanel(e) ? payload() : null));
  ipcMain.handle('settings:set', (e, patch) => (isFromPanel(e) && patch && typeof patch === 'object' ? setSettings(patch, e.sender) : null));
  ipcMain.handle('action', (e, name) => {
    if (isFromPanel(e) && ACTIONS.has(name)) sendAction(name);
    return true;
  });

  async function pickHead(e) {
    if (!isFromPanel(e)) return null;
    let r;
    try {
      r = await dialog.showOpenDialog(panelWin, {
        title: '选择图片头像（PNG / JPG / GIF / 动态 PNG 均可，GIF 和动态 PNG 会动）',
        defaultPath: startingDir('lastImageDir', safeGetPath('pictures')),
        properties: ['openFile'],
        filters: [{ name: '图片', extensions: IMAGE_PICK_EXTS }],
      });
    } catch (err) {
      // 个别系统的默认目录打不开：退回用户目录再试一次
      try {
        r = await dialog.showOpenDialog(panelWin, {
          title: '选择图片头像',
          defaultPath: safeGetPath('home'),
          properties: ['openFile'],
          filters: [{ name: '图片', extensions: IMAGE_PICK_EXTS }],
        });
      } catch (err2) {
        return { error: `选择窗口打开失败：${err2.message}` };
      }
    }
    if (r.canceled || !r.filePaths[0]) return null;
    return importHead(e, r.filePaths[0], path.dirname(r.filePaths[0]));
  }
  ipcMain.handle('head:pick', (e) => pickHead(e));
  ipcMain.handle('head:paste', async (e) => {
    if (!isFromPanel(e)) return { error: '来源无效' };
    const image = clipboard.readImage();
    if (image.isEmpty()) return { error: '剪贴板里没有图片' };
    const dir = at(userDataDir, 'heads');
    await fsp.mkdir(dir, { recursive: true });
    const head = at(dir, `${Date.now()}-paste.png`);
    await fsp.writeFile(head, image.toPNG());
    return setSettings({ head, headMode: 'photo' }, e.sender);
  });
  ipcMain.handle('head:reset', (e) => (isFromPanel(e) ? setSettings({ head: null, headMode: 'cartoon' }, e.sender) : null));
  ipcMain.handle('voice:pick', async (e) => {
    if (!isFromPanel(e)) return null;
    const r = await dialog.showOpenDialog(panelWin, {
      title: '导入配音（mp3 / m4a / wav）',
      defaultPath: startingDir('lastAudioDir', safeGetPath('music')),
      properties: ['openFile'],
      filters: [{ name: '音频', extensions: AUDIO_PICK_EXTS }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return importVoice(e, r.filePaths[0], path.dirname(r.filePaths[0]));
  });
  ipcMain.handle('voice:clear', (e) => (isFromPanel(e) ? setSettings({ voice: null }, e.sender) : null));
  ipcMain.handle('hook:retry', (e) => {
    if (!isFromPanel(e)) return null;
    requestAccessibility();
    if (IS_MAC && !systemPreferences.isTrustedAccessibilityClient(false)) {
      broadcast('settings', payload()); // 还没授权：只刷新诊断，等用户勾选后由 watchHook 启动
      return hookInfo();
    }
    if (hook.state === 'error') { try { hook.stop(); } catch { /* 保持错误诊断 */ } }
    if (hook.state !== 'live') hook.start();
    broadcast('settings', payload());
    return hookInfo();
  });
  ipcMain.handle('permission:open', (e) => {
    if (isFromPanel(e) && IS_MAC) shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  });
  // 「开关已是开但还是不生效」的兜底：ad-hoc 签名的记录在换版后会失效，清掉旧记录重新授权即可
  ipcMain.handle('permission:copyFix', (e) => {
    if (isFromPanel(e) && IS_MAC) clipboard.writeText('tccutil reset Accessibility top.baixiaochun.pet');
  });
  // ---------- 手动更新：检查 / 下载 / 安装 / 打开下载页 ----------
  ipcMain.handle('update:check', (e) => (isFromPanel(e) ? updater.check().catch((err) => ({ error: String(err.message || err) })) : null));
  ipcMain.handle('update:download', (e, payload) => {
    if (!isFromPanel(e) || !payload || typeof payload.version !== 'string' || !Array.isArray(payload.urls)) return null;
    return updater.startDownload(payload.version, payload.urls.map(String).filter((u) => /^https:\/\//.test(u))).catch((err) => ({ ok: false, error: String(err.message || err) }));
  });
  ipcMain.handle('update:install', (e) => (isFromPanel(e) ? updater.install().catch((err) => ({ ok: false, error: String(err.message || err) })) : null));
  ipcMain.handle('update:openPage', () => updater.openPage());
  ipcMain.handle('open:url', (e, url) => {
    // 只允许打开作者信息里登记过的 https 链接
    if (isFromPanel(e) && typeof url === 'string' && Object.values(AUTHOR).includes(url) && /^https:\/\//.test(url)) {
      shell.openExternal(url);
    }
  });
  ipcMain.handle('panel:collapse', (e) => {
    if (isFromPanel(e)) setSettings({ panelVisible: false });
  });
  ipcMain.on('panel:banner', (e, show) => {
    if (!isFromPanel(e)) return;
    const height = PANEL_SIZE.height + (show ? BANNER_H : 0);
    if (panelWin.getBounds().height !== height) panelWin.setSize(PANEL_SIZE.width, height, true);
  });
}

async function runSelfTest() {
  const { runSelfTest } = require('./selftest');
  await runSelfTest({
    app, hook, dir: SELFTEST_DIR, getPet: () => petWin, getPanel: () => panelWin,
    setSettings: (patch) => setSettings(patch), sendAction, status: () => petStatus, ignore: () => ignoreState,
    getSettings: () => settings,
    importHead: (src) => importHead({ sender: panelWin.webContents }, src, null),
    importVoice: (src) => importVoice({ sender: panelWin.webContents }, src, null),
    userDataDir, platform: PLATFORM,
    // 冒烟测试素材：优先环境变量指定；开发模式直接用仓库里的；打包后没给就跳过导入类步骤
    fixturesDir: process.env.BXC_PET_FIXTURES || (app.isPackaged ? '' : at(app.getAppPath(), 'test', 'fixtures')),
    log: (...a) => console.log('[smoke]', ...a),
  });
}

async function boot() {
  userDataDir = app.getPath('userData');
  assetsDir = at(app.getAppPath(), 'assets');
  rendererDir = at(__dirname, '..', 'renderer');
  store = new SettingsStore(at(userDataDir, 'settings.json'));
  settings = store.get();
  try { await ensureInstalledLocation(); } catch (err) { console.error('[main] 安装引导失败:', err); }
  // 上次用的头像 / 配音文件已经不在了（被删、换了电脑）：回到默认，别留一个加载不出来的路径
  const headOk = !settings.head || fileExists(settings.head);
  const voiceOk = !settings.voice || fileExists(settings.voice);
  if (!headOk || !voiceOk) settings = store.set({ head: headOk ? settings.head : null, voice: voiceOk ? settings.voice : null });
  if (IS_MAC && !app.isPackaged && fs.existsSync(at(assetsDir, 'icon.png'))) {
    app.dock.setIcon(nativeImage.createFromPath(at(assetsDir, 'icon.png')));
  }

  hook = new InputHook();
  hook.on('event', onInputEvent);
  hook.on('state', () => broadcast('settings', payload()));

  // 手动更新：下载进度/完成事件广播给面板
  updater = initUpdater({
    net, app, shell, broadcast, platform: REAL_PLATFORM, arch: process.arch, isPackaged: app.isPackaged,
    macInstalled: IS_MAC && typeof app.isInApplicationsFolder === 'function' ? app.isInApplicationsFolder() : false,
    winPortable: !!process.env.PORTABLE_EXECUTABLE_DIR,
    appVersion: app.getVersion(),
  });

  // 自动隐私保护：探测结论驱动「遮蔽/隐藏 + 停输入映射」，恢复时按用户显隐设置还原
  privacyCtl = new PrivacyController();
  privacyCtl.on('change', (state) => {
    if (hook) hook.setBlocked(state.mode === 'shield' || state.mode === 'hidden');
    if (state.mode === 'hidden') {
      privacyHidden = true;
      if (petWin && !petWin.isDestroyed() && petWin.isVisible()) petWin.hide();
      if (panelWin && !panelWin.isDestroyed() && panelWin.isVisible()) panelWin.hide();
    } else if (privacyHidden) {
      privacyHidden = false;
      applyWindowSettings(); // 不覆盖用户主动选择的「隐藏桌宠」
    }
    broadcast('privacy', state);
  });

  createPetWindow();
  createPanelWindow();
  createTray();
  registerIpc();
  screen.on('display-removed', ensureOnScreen);
  screen.on('display-metrics-changed', ensureOnScreen);
  hook.start();
  requestAccessibility();
  watchHook();

  if (settings.privacy === true) privacyCtl.setEnabled(true); // 跟随上次保存的开关

  if (SELFTEST_DIR) {
    fs.mkdirSync(SELFTEST_DIR, { recursive: true });
    setTimeout(runSelfTest, 800);
  } else if (store.isNew) {
    // 第一次见面：先打一小段字给大家看看玩法
    setTimeout(() => sendAction('type-demo'), 1800);
  }
}

app.whenReady().then(() => boot().catch((err) => console.error('[main] 启动失败:', err))).catch((err) => console.error('[main] 启动失败:', err));

app.on('activate', () => {
  if (petWin && !petWin.isVisible()) petWin.showInactive();
});
app.on('window-all-closed', () => {
  if (!IS_MAC) app.quit();
});
app.on('before-quit', () => {
  try {
    if (hook) hook.stop();
  } catch {
    // 忽略退出时的钩子异常
  }
});
app.on('will-quit', () => {
  if (store) store.save();
});
