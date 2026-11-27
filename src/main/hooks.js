'use strict';
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { labelFor } = require('../shared/keys');

// 原生模块加载：优先走 uiohook-napi 包；失败（典型：包里混进了别的平台的 build/Release）时
// 直接加载对应平台的全平台预编译 .node 兜底。加载方式记录在 loadVia，方便面板上诊断。
let lib = null;
let loadError = null;
let loadVia = '';

// 裸 .node 只有 start/stop/keyTap；包装成包里 uIOhook 的事件接口。
// 事件类型值与 uiohook 一致：4=keydown 5=keyup 7=down 8=up 9/10=move 11=wheel
function wrapRaw(raw) {
  const em = new EventEmitter();
  em.start = () => {};
  em.stop = () => { try { raw.stop(); } catch { /* 退出时钩子本就不在也无妨 */ } };
  em.keyTap = (key) => raw.keyTap(key);
  raw.start((e) => {
    const type = e && e.type;
    if (type === 4) em.emit('keydown', e);
    else if (type === 5) em.emit('keyup', e);
    else if (type === 7) em.emit('mousedown', e);
    else if (type === 8) em.emit('mouseup', e);
    else if (type === 9 || type === 10) em.emit('mousemove', e);
    else if (type === 11) em.emit('wheel', e);
  });
  return { uIOhook: em, UiohookKey: null };
}

// 按键码表（裸模块不带；这里的值与 uiohook 通用码一致）
const FALLBACK_KEYS = {
  Backspace: 0x000e, Tab: 0x000f, Enter: 0x001c, Escape: 0x0001, Space: 0x0039, CapsLock: 0x003a,
  Delete: 0x0033, Insert: 0x0036, Home: 0x0030, End: 0x0031, PageUp: 0x0029, PageDown: 0x002b,
  ArrowLeft: 0x0064, ArrowUp: 0x0065, ArrowRight: 0x0067, ArrowDown: 0x0066,
  Shift: 0x002a, Ctrl: 0x0025, Alt: 0x0026,
};
for (let i = 0; i < 26; i++) FALLBACK_KEYS[String.fromCharCode(65 + i)] = 0x04 + i; // A=4 .. Z=29
for (let i = 1; i <= 9; i++) FALLBACK_KEYS[String(i)] = 0x1e + i; // 1=30 .. 9=38
FALLBACK_KEYS[0] = 0x27;

try {
  lib = require('uiohook-napi');
  loadVia = 'uiohook-napi';
} catch (err) {
  loadError = err;
  const dirs = [];
  if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'uiohook-napi'));
  dirs.push(path.join(__dirname, '..', '..', 'node_modules', 'uiohook-napi'));
  for (const dir of dirs) {
    const file = path.join(dir, 'prebuilds', `${process.platform}-${process.arch}`, 'uiohook-napi.node');
    try {
      if (!fs.existsSync(file)) continue;
      lib = wrapRaw(require(file));
      loadVia = file;
      loadError = null;
      break;
    } catch (err2) {
      loadError = err2;
    }
  }
}

const K = (lib && lib.UiohookKey) || FALLBACK_KEYS;
const NAME_BY_CODE = new Map();
const put = (name, code) => {
  if (code !== undefined) NAME_BY_CODE.set(code, name);
};
for (const ch of 'abcdefghijklmnopqrstuvwxyz') put(ch, K[ch.toUpperCase()]);
for (const d of '0123456789') put(d, K[d]);
[
  ['backspace', 'Backspace'], ['tab', 'Tab'], ['enter', 'Enter'], ['esc', 'Escape'], ['space', 'Space'],
  ['caps', 'CapsLock'], ['del', 'Delete'], ['ins', 'Insert'], ['home', 'Home'], ['end', 'End'],
  ['pgup', 'PageUp'], ['pgdn', 'PageDown'], ['left', 'ArrowLeft'], ['up', 'ArrowUp'],
  ['right', 'ArrowRight'], ['down', 'ArrowDown'],
  ['shift', 'Shift'], ['shift', 'ShiftRight'], ['ctrl', 'Ctrl'], ['ctrl', 'CtrlRight'],
  ['alt', 'Alt'], ['alt', 'AltRight'], ['meta', 'Meta'], ['meta', 'MetaRight'],
  ['`', 'Backquote'], ['-', 'Minus'], ['=', 'Equal'], ['[', 'BracketLeft'], [']', 'BracketRight'],
  ['\\', 'Backslash'], [';', 'Semicolon'], ["'", 'Quote'], [',', 'Comma'], ['.', 'Period'], ['/', 'Slash'],
  ['numlock', 'NumLock'],
].forEach(([name, key]) => put(name, K[key]));
for (let i = 1; i <= 12; i++) put('f' + i, K['F' + i]);

const MODIFIERS = new Set(['shift', 'ctrl', 'alt', 'meta']);

// 全局键鼠监听。只把「按键名 / 鼠标坐标」往外发，不记录、不落盘。
class InputHook extends EventEmitter {
  constructor() {
    super();
    this.state = lib ? 'idle' : 'unavailable'; // idle | listening | live | error | unavailable
    this.error = loadError;
    this.loadVia = loadVia;
    this.lastMoveSent = 0;
    this.eventCount = 0;
    this.held = new Set(); // 按住没松的键：用来识别系统自动重复的 keydown
    if (lib) {
      lib.uIOhook.on('keydown', (e) => this.onKey(e));
      lib.uIOhook.on('keyup', (e) => this.onKeyUp(e));
      lib.uIOhook.on('mousedown', (e) => this.onMouse('mousedown', e));
      lib.uIOhook.on('mouseup', (e) => this.onMouse('mouseup', e));
      lib.uIOhook.on('wheel', (e) => this.onWheel(e));
      lib.uIOhook.on('mousemove', (e) => this.onMove(e));
    }
  }

  emitEvent(ev) {
    this.eventCount++;
    this.emit('event', ev);
  }

  markLive() {
    if (this.state === 'listening') {
      this.state = 'live';
      this.emit('state');
    }
  }

  onKeyUp(e) {
    const name = NAME_BY_CODE.get(e.keycode) || '';
    this.held.delete(name);
    this.emitEvent({ kind: 'keyup', name });
  }

  onKey(e) {
    this.markLive();
    const name = NAME_BY_CODE.get(e.keycode) || '';
    // 按住不放时系统会连发 keydown：标记成 repeat，桌宠只按住不连打
    if (this.held.size > 12) this.held.clear();
    const repeat = this.held.has(name);
    this.held.add(name);
    this.emitEvent({
      kind: 'key',
      name,
      repeat,
      mod: MODIFIERS.has(name),
      shift: !!e.shiftKey,
      ctrl: !!e.ctrlKey,
      alt: !!e.altKey,
      meta: !!e.metaKey,
    });
  }

  onMouse(kind, e) {
    this.markLive();
    this.emitEvent({ kind, button: e.button });
  }

  onMove(e) {
    const now = Date.now();
    if (now - this.lastMoveSent < 33) return;
    this.lastMoveSent = now;
    this.markLive();
    this.emitEvent({ kind: 'move', x: e.x, y: e.y });
  }

  onWheel(e) {
    this.markLive();
    this.emitEvent({ kind: 'wheel', dir: e.direction, amount: e.amount });
  }

  start() {
    if (!lib) return false;
    try {
      lib.uIOhook.start();
      this.state = 'listening';
      this.emit('state');
      return true;
    } catch (err) {
      // macOS 未授权「输入监控 / 辅助功能」时会走到这里
      this.state = 'error';
      this.error = err;
      this.emit('state');
      return false;
    }
  }

  // 自测用：向系统发一个单独的 Shift 按下/抬起（不会向任何 App 输入字符），验证钩子全链路
  postTestKey() {
    if (!lib || !lib.UiohookKey) return false;
    try {
      lib.uIOhook.keyTap(lib.UiohookKey.Shift);
      return true;
    } catch {
      return false;
    }
  }

  stop() {
    if (!lib) return;
    try {
      lib.uIOhook.stop();
    } catch {
      // 退出时钩子本就不在也无妨
    }
  }

  // 供自测走同一条管线注入假输入（带 __test 标记，主进程才会放行）
  inject(ev) {
    this.emit('event', { ...ev, __test: true });
  }
}

module.exports = { InputHook, labelFor, hookAvailable: !!lib };
