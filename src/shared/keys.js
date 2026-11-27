/* 按键规则：按键名 → 气泡里的显示标签 / 画出来的键盘上没有的键该去哪按。
   主进程、渲染层、单元测试共用同一份（UMD），避免两边各写一套对不上。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BXC_KEYS = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ARROWS = { left: '←', up: '↑', right: '→', down: '↓' };
  const MAC = { shift: '⇧', ctrl: '⌃', alt: '⌥', meta: '⌘', backspace: '⌫', enter: '↵', space: 'Space', tab: '⇥', esc: 'Esc', caps: 'Caps' };
  const WIN = { shift: 'Shift', ctrl: 'Ctrl', alt: 'Alt', meta: 'Win', backspace: '⌫', enter: 'Enter', space: 'Space', tab: 'Tab', esc: 'Esc', caps: 'Caps' };
  const COMMON = { del: 'Del', ins: 'Ins', home: 'Home', end: 'End', pgup: 'PgUp', pgdn: 'PgDn', numlock: 'Num', menu: '☰' };

  function labelFor(name, platform) {
    if (!name) return '';
    if (ARROWS[name]) return ARROWS[name];
    if (/^f\d{1,2}$/.test(name)) return name.toUpperCase();
    const table = Object.assign({}, COMMON, platform === 'darwin' ? MAC : WIN);
    if (table[name]) return table[name];
    if (/^[a-z]$/.test(name)) return name.toUpperCase();
    return name;
  }

  // 键盘图上没有的键：爪子去「锚点键 + 偏移」的位置按（dx、dy 是 CSS 像素）
  const ANCHORS = {
    up: ['/', 46, -12], left: ['/', 28, 12], down: ['/', 46, 12], right: ['/', 64, 12],
    pgup: ['=', 0, -26], ins: ['backspace', 22, 0], home: ['enter', 24, -10],
    del: ['backspace', 22, 12], end: ['enter', 24, 2], pgdn: ['enter', 24, 14],
    numlock: ['ctrl', 70, 10], fn: ['ctrl', 44, 10], menu: ['ctrl', 57, 10],
  };
  function fallbackAnchor(name) {
    if (!name) return null;
    if (/^f([1-9]|1[0-2])$/.test(name)) return [Number(name.slice(1)) <= 6 ? '2' : '0', 0, -26];
    if (/^numpad/.test(name)) return ['ctrl', 84, 10];
    return ANCHORS[name] || null;
  }

  return { labelFor, fallbackAnchor, ANCHORS };
}));
