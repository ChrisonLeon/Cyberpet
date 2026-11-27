'use strict';
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
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

function loadBackend({ requireModule = require, exists = fs.existsSync, resourcesPath = process.resourcesPath, platform = process.platform, arch = process.arch } = {}) {
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
    const name = this.names.get(e.keycode) || '';
    const repeat = this.held.has(name);
    if (name) this.held.add(name);
    this.emitEvent({ kind: 'key', name, repeat, mod: MODIFIERS.has(name), shift: !!e.shiftKey, ctrl: !!e.ctrlKey, alt: !!e.altKey, meta: !!e.metaKey });
  }
  onKeyUp(e) {
    this.markLive();
    if (this.blocked) return;
    const name = this.names.get(e.keycode) || '';
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
    if (!this.running || !this.backend) return false;
    try { this.backend.uIOhook.keyTap((this.backend.UiohookKey || KEY_CODES).Shift); return true; } catch { return false; }
  }
  inject(ev) { if (!this.blocked) this.emit('event', { ...ev, __test: true }); }
}

module.exports = { InputHook, labelFor, hookAvailable: !!loaded.backend, wrapRaw, loadBackend, KEY_CODES };
