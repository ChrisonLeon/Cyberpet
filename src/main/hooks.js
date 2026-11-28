'use strict';
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { labelFor } = require('../shared/keys');

// libuiohook 扫描码，与 uiohook-napi 的 UiohookKey 一致（不是 USB HID 键码）。
const KEY_CODES = {
  Escape: 1, Backspace: 14, Tab: 15, Enter: 28, CapsLock: 58, Space: 57,
  Delete: 3667, Insert: 3666, Home: 3655, End: 3663, PageUp: 3657, PageDown: 3665,
  ArrowLeft: 57419, ArrowUp: 57416, ArrowRight: 57421, ArrowDown: 57424,
  Ctrl: 29, CtrlRight: 3613, Alt: 56, AltRight: 3640, Shift: 42, ShiftRight: 54,
  Meta: 3675, MetaRight: 3676, NumLock: 69,
  Backquote: 41, Minus: 12, Equal: 13, BracketLeft: 26, BracketRight: 27,
  Backslash: 43, Semicolon: 39, Quote: 40, Comma: 51, Period: 52, Slash: 53,
  Print: 3639, Scroll: 70,
  // 小键盘（含 NumLock 关闭时 mac 发的变体码，按对应主键处理）
  Numpad0: 82, Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad4: 75,
  Numpad5: 76, Numpad6: 77, Numpad7: 71, Numpad8: 72, Numpad9: 73,
  NumpadAdd: 78, NumpadSubtract: 74, NumpadMultiply: 55, NumpadDecimal: 83,
  NumpadDivide: 3637, NumpadEnter: 3612,
  NumpadEnd: 61007, NumpadArrowDown: 61008, NumpadPageDown: 61009,
  NumpadArrowLeft: 61003, NumpadArrowRight: 61005, NumpadHome: 60999,
  NumpadArrowUp: 61000, NumpadPageUp: 61001, NumpadInsert: 61010, NumpadDelete: 61011,
};
'QWERTYUIOP'.split('').forEach((k, i) => { KEY_CODES[k] = 16 + i; });
'ASDFGHJKL'.split('').forEach((k, i) => { KEY_CODES[k] = 30 + i; });
'ZXCVBNM'.split('').forEach((k, i) => { KEY_CODES[k] = 44 + i; });
'1234567890'.split('').forEach((k, i) => { KEY_CODES[k] = 2 + i; });
for (let i = 1; i <= 10; i++) KEY_CODES['F' + i] = 58 + i;
KEY_CODES.F11 = 87;
KEY_CODES.F12 = 88;
const MODIFIERS = new Set(['shift', 'ctrl', 'alt', 'meta']);
const EVENTS = { 4: 'keydown', 5: 'keyup', 7: 'mousedown', 8: 'mouseup', 9: 'mousemove', 10: 'mousemove', 11: 'wheel' };

// macOS 被动监听助手：独立进程用 listen-only 事件钩子只观察不拦截，
// 从机制上杜绝主动式钩子停摆导致的「全系统鼠标键盘堵死」。
function resolveHelperPath({ resourcesPath = process.resourcesPath,
  isPackaged = !!(process.versions.electron && !process.defaultApp),
  platform = process.platform, arch = process.arch } = {}) {
  if (platform !== 'darwin' || !['arm64', 'x64'].includes(arch)) return null;
  if (isPackaged) return resourcesPath ? path.join(resourcesPath, 'helpers', `${platform}-${arch}`, 'input-hook') : null;
  return path.join(__dirname, '..', '..', 'native', 'bin', `${platform}-${arch}`, 'input-hook');
}

function wrapHelper(helperPath, spawnFn = spawn) {
  const em = new EventEmitter();
  let wanted = false;
  let running = false;
  let child = null;
  let lastLine = 0;
  let watchdog = null;
  let restartTimer = null;
  let lastStart = 0;

  const clearTimers = () => {
    if (watchdog) clearInterval(watchdog);
    if (restartTimer) clearTimeout(restartTimer);
    watchdog = restartTimer = null;
  };

  const launch = () => {
    let c;
    try {
      c = spawnFn(helperPath, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      return false;
    }
    child = c;
    running = true;
    lastStart = Date.now();
    lastLine = Date.now();
    watchdog = setInterval(() => { if (Date.now() - lastLine > 6000) { try { c.kill(); } catch { /* 已退出 */ } } }, 2000);
    watchdog.unref?.();
    let buf = '';
    c.stdout.on('data', (chunk) => {
      lastLine = Date.now();
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (e.t === 'hb' || e.t === 'ready') continue;
        if (e.t === 'key') em.emit('keydown', { name: String(e.n || ''), shift: !!e.s, ctrl: !!e.c, alt: !!e.a, meta: !!e.m, repeat: !!e.r });
        else if (e.t === 'keyup') em.emit('keyup', { name: String(e.n || '') });
        else if (e.t === 'md' || e.t === 'mu') em.emit(e.t === 'md' ? 'mousedown' : 'mouseup', { button: e.b });
        else if (e.t === 'mm') em.emit('mousemove', { x: e.x, y: e.y });
        else if (e.t === 'wheel') em.emit('wheel', { direction: e.d > 0 ? 1 : -1, amount: Math.abs(e.d) || 1 });
      }
    });
    c.once('exit', () => {
      if (!wanted) return; // 用户主动 stop：不重启
      running = false;
      clearTimers();
      // 被动钩子断了不影响系统输入，静默拉起新实例（快速失败退避到 30s 上限）
      const stable = Date.now() - lastStart > 30000;
      const delay = stable ? 1000 : Math.min(30000, 2000 * Math.max(1, fastFails()));
      restartTimer = setTimeout(() => { if (wanted) launch(); }, delay);
      restartTimer.unref?.();
    });
    return true;
  };
  const fastFails = () => (Date.now() - lastStart > 30000 ? 0 : Math.ceil((30000 - (Date.now() - lastStart)) / 5000) + 1);

  em.start = () => {
    if (running) return true;
    wanted = true;
    return launch();
  };
  em.stop = () => {
    wanted = false;
    running = false;
    clearTimers();
    if (child) {
      try { child.stdin.end('stop\n'); } catch { /* 管道已关 */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, 300).unref?.();
      child = null;
    }
    return true;
  };
  em.keyTap = () => false; // 被动监听不能注入按键（自测用 hook.inject 代替）
  // 与 wrapRaw 相同的包装结构：uIOhook 挂事件，UiohookKey 供键码翻译兜底
  return { uIOhook: em, UiohookKey: KEY_CODES, isHelper: true };
}

// 只包装接口，不在 require 阶段启动全局监听。授权后 start/stop 都可重复调用。
function wrapRaw(raw) {
  const em = new EventEmitter();
  let running = false;
  em.start = () => {
    if (running) return;
    raw.start((e) => { if (e && EVENTS[e.type]) em.emit(EVENTS[e.type], e); });
    running = true;
  };
  em.stop = () => { if (running) { raw.stop(); running = false; } };
  em.keyTap = (key) => raw.keyTap(key, 0);
  return { uIOhook: em, UiohookKey: KEY_CODES };
}

function loadBackend({ requireModule = require, exists = fs.existsSync, resourcesPath = process.resourcesPath, platform = process.platform, arch = process.arch, isPackaged = !!(process.versions.electron && !process.defaultApp) } = {}) {
  // macOS：优先用被动监听助手（不会阻塞系统输入）；助手缺失再退回 uiohook-napi
  const helperPath = resolveHelperPath({ resourcesPath, isPackaged, platform, arch });
  if (helperPath && exists(helperPath)) {
    try {
      return { backend: wrapHelper(helperPath), via: 'input-hook helper', error: null };
    } catch (first) {
      // 助手启动失败退回 uiohook-napi
    }
  }
  try {
    return { backend: requireModule('uiohook-napi'), via: 'uiohook-napi', error: null };
  } catch (first) {
    let error = first;
    const roots = [path.resolve(__dirname, '../../node_modules/uiohook-napi')];
    if (resourcesPath) roots.unshift(path.join(resourcesPath, 'app.asar.unpacked/node_modules/uiohook-napi'));
    for (const root of roots) {
      const file = path.join(root, 'prebuilds', `${platform}-${arch}`, 'uiohook-napi.node');
      if (!exists(file)) continue;
      try { return { backend: wrapRaw(requireModule(file)), via: `${platform}-${arch} prebuild`, error: null }; }
      catch (err) { error = err; }
    }
    return { backend: null, via: '', error };
  }
}

function nameMap(codes) {
  const map = new Map();
  const put = (name, symbol) => { if (codes[symbol] !== undefined) map.set(codes[symbol], name); };
  for (const ch of 'abcdefghijklmnopqrstuvwxyz') put(ch, ch.toUpperCase());
  for (const ch of '0123456789') put(ch, ch);
  for (let i = 1; i <= 12; i++) put('f' + i, 'F' + i);
  for (const [name, symbol] of [
    ['backspace', 'Backspace'], ['tab', 'Tab'], ['enter', 'Enter'], ['esc', 'Escape'], ['space', 'Space'],
    ['caps', 'CapsLock'], ['del', 'Delete'], ['ins', 'Insert'], ['home', 'Home'], ['end', 'End'],
    ['pgup', 'PageUp'], ['pgdn', 'PageDown'], ['left', 'ArrowLeft'], ['up', 'ArrowUp'], ['right', 'ArrowRight'], ['down', 'ArrowDown'],
    ['shift', 'Shift'], ['shift', 'ShiftRight'], ['ctrl', 'Ctrl'], ['ctrl', 'CtrlRight'],
    ['alt', 'Alt'], ['alt', 'AltRight'], ['meta', 'Meta'], ['meta', 'MetaRight'],
    ['`', 'Backquote'], ['-', 'Minus'], ['=', 'Equal'], ['[', 'BracketLeft'], [']', 'BracketRight'],
    ['\\', 'Backslash'], [';', 'Semicolon'], ["'", 'Quote'], [',', 'Comma'], ['.', 'Period'], ['/', 'Slash'], ['numlock', 'NumLock'],
    ['print', 'Print'], ['scroll', 'Scroll'],
    // 小键盘：数字与运算符；NumLock 关闭时的变体码归到对应主键
    ...'0123456789'.split('').map((d) => [`num${d}`, `Numpad${d}`]),
    ['numadd', 'NumpadAdd'], ['numsub', 'NumpadSubtract'], ['nummul', 'NumpadMultiply'],
    ['numdot', 'NumpadDecimal'], ['numdiv', 'NumpadDivide'], ['numenter', 'NumpadEnter'],
    ['end', 'NumpadEnd'], ['down', 'NumpadArrowDown'], ['pgdn', 'NumpadPageDown'],
    ['left', 'NumpadArrowLeft'], ['right', 'NumpadArrowRight'], ['home', 'NumpadHome'],
    ['up', 'NumpadArrowUp'], ['pgup', 'NumpadPageUp'], ['ins', 'NumpadInsert'], ['del', 'NumpadDelete'],
  ]) put(name, symbol);
  return map;
}

const loaded = loadBackend(); // 加载原生模块没有启动监听的副作用
class InputHook extends EventEmitter {
  constructor(options = {}) {
    super();
    const source = options.source || loaded;
    this.backend = source.backend;
    this.error = source.error;
    this.loadVia = source.via;
    this.state = this.backend ? 'idle' : 'unavailable';
    this.running = false;
    this.blocked = false;
    this.lastMoveSent = 0;
    this.eventCount = 0;
    this.held = new Set();
    this.names = nameMap(this.backend ? this.backend.UiohookKey || KEY_CODES : KEY_CODES);
    this.listeners = {
      keydown: (e) => this.onKey(e), keyup: (e) => this.onKeyUp(e),
      mousedown: (e) => this.onMouse('mousedown', e), mouseup: (e) => this.onMouse('mouseup', e),
      mousemove: (e) => this.onMove(e), wheel: (e) => this.onWheel(e),
    };
    if (this.backend) for (const [event, fn] of Object.entries(this.listeners)) this.backend.uIOhook.on(event, fn);
  }

  setBlocked(blocked) { this.blocked = !!blocked; if (this.blocked) this.held.clear(); }
  markLive() {
    this.eventCount++;
    if (this.running && this.state === 'listening') { this.state = 'live'; this.emit('state'); }
  }
  emitEvent(ev) { if (!this.blocked) this.emit('event', ev); }
  onKey(e) {
    this.markLive();
    if (this.blocked) return; // 先判断保护状态，再读取按键身份，不缓存隐私期的键
    const name = typeof e.name === 'string' ? e.name : this.names.get(e.keycode) || '';
    const repeat = this.held.has(name);
    if (name) this.held.add(name);
    this.emitEvent({ kind: 'key', name, repeat, mod: MODIFIERS.has(name), shift: !!e.shiftKey, ctrl: !!e.ctrlKey, alt: !!e.altKey, meta: !!e.metaKey });
  }
  onKeyUp(e) {
    this.markLive();
    if (this.blocked) return;
    const name = typeof e.name === 'string' ? e.name : this.names.get(e.keycode) || '';
    this.held.delete(name);
    this.emitEvent({ kind: 'keyup', name });
  }
  onMouse(kind, e) { this.markLive(); if (!this.blocked) this.emitEvent({ kind, button: e.button }); }
  onMove(e) {
    this.markLive();
    if (this.blocked) return;
    const now = Date.now();
    if (now - this.lastMoveSent < 33) return;
    this.lastMoveSent = now;
    this.emitEvent({ kind: 'move', x: e.x, y: e.y });
  }
  onWheel(e) { this.markLive(); if (!this.blocked) this.emitEvent({ kind: 'wheel', dir: e.direction, amount: e.amount }); }

  start() {
    if (!this.backend) return false;
    if (this.running) return true;
    try {
      this.backend.uIOhook.start();
      this.running = true;
      this.state = 'listening';
      this.error = null;
      this.emit('state');
      return true;
    } catch (err) {
      this.running = false;
      this.state = 'error';
      this.error = err;
      this.emit('state');
      return false;
    }
  }
  stop() {
    this.held.clear();
    if (!this.running) return true;
    try {
      this.backend.uIOhook.stop();
      this.running = false;
      this.state = 'idle';
      this.emit('state');
      return true;
    } catch (err) {
      this.error = err;
      this.state = 'error';
      this.emit('state');
      return false;
    }
  }
  restart() { return this.stop() && this.start(); }
  dispose() {
    this.stop();
    if (this.backend) for (const [event, fn] of Object.entries(this.listeners)) this.backend.uIOhook.removeListener(event, fn);
  }
  postTestKey() {
    if (!this.running || !this.backend || this.backend.isHelper) return false;
    try { this.backend.uIOhook.keyTap((this.backend.UiohookKey || KEY_CODES).Shift); return true; } catch { return false; }
  }
  inject(ev) { if (!this.blocked) this.emit('event', { ...ev, __test: true }); }
}

module.exports = { InputHook, labelFor, hookAvailable: !!loaded.backend, wrapRaw, wrapHelper, loadBackend, resolveHelperPath, KEY_CODES };
