'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  body: 'black',        // black 小黑猫身 | bluewhite 蓝白小猫身 | orange 橘猫身 | cream 奶黄猫身
  headMode: 'cartoon',  // cartoon Q版猫头（默认）| photo 真人抠头（图片或视频）
  head: null,           // null = 内置默认头像，否则是 userData/heads 下的绝对路径
  headScale: 1.1,
  headOffset: null,     // 头像相对默认位置的偏移 {x, y}
  headLock: false,      // 锁定头像位置：锁定后不能拖动头像
  petScale: 1.0,        // 整体大小（窗口 + 内容一起缩放）
  angryLine: false,     // 「能别放屁吗」台词开关：选中后触发时在头上显示台词；未选中只暴躁敲键盘
  kbDir: 'reverse',     // 键鼠方向：reverse 反向（默认，现在的方向）| forward 正向（键盘朝向宠物自己，鼠标在右）
  sticker: true,        // 贴纸白边
  keyBubbles: true,     // 按键气泡
  keySfx: true,         // 键盘音效
  voiceEaster: true,    // 原声彩蛋（只对视频头像有意义）
  privacy: false,       // 隐私防截屏/录屏
  switchSound: 'mahjong',
  desk: 'transparent',  // transparent 透明（默认，无桌垫）| bluewhite 蓝白桌面 | dark 暗夜 | none 无道具
  alwaysOnTop: true,
  petVisible: true,
  panelVisible: true,
  voice: null,          // 导入的配音文件路径
  // 上次选文件时所在的目录：下次打开选择框直接从那里开始（不提供配置界面）
  lastImageDir: null,
  lastVideoDir: null,
  lastAudioDir: null,
  petPos: null,
  panelPos: null,
  installChecked: false, // macOS：已在「应用程序」目录或用户已拒绝移动提示
};

const ENUMS = {
  body: ['black', 'bluewhite', 'orange', 'cream'],
  headMode: ['photo', 'cartoon'],
  switchSound: ['mahjong', 'blue', 'woodfish', 'kitten'],
  desk: ['transparent', 'bluewhite', 'dark', 'none'],
  kbDir: ['reverse', 'forward'],
};
const BOOLEANS = ['sticker', 'keyBubbles', 'keySfx', 'voiceEaster', 'privacy', 'alwaysOnTop', 'petVisible', 'panelVisible', 'headLock', 'angryLine', 'installChecked'];
const PATHS = ['head', 'voice', 'lastImageDir', 'lastVideoDir', 'lastAudioDir'];

function isPos(v) {
  return !!v && Number.isFinite(v.x) && Number.isFinite(v.y);
}

// 只放行认识的字段和合法取值，渲染进程传什么都不会把配置写坏
function sanitize(patch = {}) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  for (const [key, values] of Object.entries(ENUMS)) {
    if (values.includes(patch[key])) out[key] = patch[key];
  }
  for (const key of BOOLEANS) {
    if (typeof patch[key] === 'boolean') out[key] = patch[key];
  }
  if (Number.isFinite(patch.headScale)) {
    out.headScale = Math.min(1.4, Math.max(0.6, Math.round(patch.headScale * 100) / 100));
  }
  if (Number.isFinite(patch.petScale)) {
    out.petScale = Math.min(1.5, Math.max(0.6, Math.round(patch.petScale * 20) / 20));
  }
  if (patch.headOffset === null) out.headOffset = null;
  else if (patch.headOffset && typeof patch.headOffset === 'object'
    && Number.isFinite(patch.headOffset.x) && Number.isFinite(patch.headOffset.y)) {
    const cl = (v) => Math.round(Math.min(120, Math.max(-120, v)));
    out.headOffset = { x: cl(patch.headOffset.x), y: cl(patch.headOffset.y) };
  }
  for (const key of PATHS) {
    if (patch[key] === null) out[key] = null;
    else if (typeof patch[key] === 'string' && path.isAbsolute(patch[key])) out[key] = patch[key];
  }
  for (const key of ['petPos', 'panelPos']) {
    if (isPos(patch[key])) out[key] = { x: Math.round(patch[key].x), y: Math.round(patch[key].y) };
    else if (patch[key] === null) out[key] = null;
  }
  return out;
}

class SettingsStore {
  constructor(file) {
    this.file = file;
    this.data = { ...DEFAULTS };
    this.isNew = !fs.existsSync(file); // 首次启动：主进程据此安排开场小演示
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...DEFAULTS, ...sanitize(raw) };
    } catch {
      // 首次启动或文件损坏：沿用默认值
    }
  }

  get() {
    return { ...this.data };
  }

  set(patch) {
    this.data = { ...this.data, ...sanitize(patch) };
    this.save();
    return this.get();
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch {
      // 写不进去也不影响本次运行
    }
  }
}

module.exports = { SettingsStore, DEFAULTS, sanitize };
