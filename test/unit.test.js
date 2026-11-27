'use strict';
// 单元测试：不启动 Electron，任何系统上都能跑（npm test）。覆盖主进程、界面、测试共用的纯逻辑。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KEYS = require('../src/shared/keys');
const VOICE = require('../src/shared/voice-rules');
const { sanitize, DEFAULTS } = require('../src/main/settings');
const { importFile } = require('../src/main/importer');
const ART = require('../src/renderer/shared/art');
const hooks = require('../src/main/hooks');

// ---------- 按键标签：mac 和 Windows 各一套 ----------
test('字母和数字在两个平台上都显示大写', () => {
  for (const p of ['darwin', 'win32']) {
    assert.equal(KEYS.labelFor('a', p), 'A');
    assert.equal(KEYS.labelFor('z', p), 'Z');
    assert.equal(KEYS.labelFor('5', p), '5');
    assert.equal(KEYS.labelFor('f8', p), 'F8');
    assert.equal(KEYS.labelFor('left', p), '←');
    assert.equal(KEYS.labelFor('space', p), 'Space');
    assert.equal(KEYS.labelFor('', p), '');
    assert.equal(KEYS.labelFor(undefined, p), '');
    assert.equal(KEYS.labelFor(';', p), ';'); // 没有专门标签的原样显示
  }
});

test('修饰键：mac 用符号，Windows 用文字', () => {
  assert.deepEqual(['shift', 'ctrl', 'alt', 'meta'].map((k) => KEYS.labelFor(k, 'darwin')), ['⇧', '⌃', '⌥', '⌘']);
  assert.deepEqual(['shift', 'ctrl', 'alt', 'meta'].map((k) => KEYS.labelFor(k, 'win32')), ['Shift', 'Ctrl', 'Alt', 'Win']);
  assert.equal(KEYS.labelFor('enter', 'darwin'), '↵');
  assert.equal(KEYS.labelFor('enter', 'win32'), 'Enter');
});

test('键盘图上没有的键有兜底位置，未知的返回 null', () => {
  assert.deepEqual(KEYS.fallbackAnchor('f1'), ['2', 0, -26]);
  assert.deepEqual(KEYS.fallbackAnchor('f12'), ['0', 0, -26]);
  assert.equal(KEYS.fallbackAnchor('up')[0], '/');
  assert.equal(KEYS.fallbackAnchor('numpad5')[0], 'ctrl');
  assert.equal(KEYS.fallbackAnchor('whatever'), null);
  assert.equal(KEYS.fallbackAnchor(''), null);
  // 兜底位置的锚点键必须真的画在键盘上，否则爪子没地方去
  const kbd = ART.keyboardSvg(false);
  for (const [anchor] of Object.values(KEYS.ANCHORS)) assert.ok(kbd.includes(`data-k="${anchor}"`), `键盘上缺少锚点键 ${anchor}`);
  assert.ok(kbd.includes('data-k="2"') && kbd.includes('data-k="0"'));
});

// ---------- 配音联动：头像 × 原声彩蛋 × 导入配音 的全部组合 ----------
test('原声彩蛋只对视频头像可用', () => {
  for (const headMode of ['photo', 'cartoon']) {
    for (const headType of ['image', 'video']) {
      const r = VOICE.resolve({ headMode, headType, voiceEaster: true, hasVoice: false });
      assert.equal(r.easterEnabled, headMode === 'photo' && headType === 'video', `${headMode}/${headType}`);
    }
  }
});

test('触发时播放什么：视频原声 > 导入配音 > 合成音效', () => {
  const cases = [
    // [headMode, headType, voiceEaster, hasVoice, 期望]
    ['photo', 'video', true, false, 'video'],   // 视频头像 + 勾选：播视频原声
    ['photo', 'video', true, true, 'video'],    // 原声优先于导入配音
    ['photo', 'video', false, true, 'voice'],   // 取消勾选：播导入的配音
    ['photo', 'video', false, false, 'synth'],  // 都没有：合成音效
    ['photo', 'image', true, true, 'voice'],    // 图片头像：彩蛋无效，播配音
    ['photo', 'image', false, true, 'voice'],
    ['photo', 'image', true, false, 'synth'],
    ['cartoon', 'video', true, true, 'voice'],  // Q 版猫头显示时视频不参与，彩蛋无效
    ['cartoon', 'video', true, false, 'synth'],
    ['cartoon', 'image', true, true, 'voice'],
  ];
  for (const [headMode, headType, voiceEaster, hasVoice, expected] of cases) {
    assert.equal(VOICE.resolve({ headMode, headType, voiceEaster, hasVoice }).source, expected, `${headMode}/${headType}/${voiceEaster}/${hasVoice}`);
  }
});

// ---------- 设置校验：渲染进程传什么都不会把配置写坏 ----------
test('设置的默认值完整，非法输入全部丢弃', () => {
  assert.equal(DEFAULTS.desk, 'transparent'); // 默认透明背景
  assert.equal(DEFAULTS.sticker, true);
  assert.deepEqual(sanitize({ body: 'x', desk: 'rainbow', switchSound: 3, headScale: 'big' }), {});
  assert.deepEqual(sanitize(null), {});
  assert.deepEqual(sanitize('junk'), {});
  assert.deepEqual(sanitize([]), {});
  assert.deepEqual(sanitize({ body: 'doll', desk: 'dark', sticker: false }), { body: 'doll', desk: 'dark', sticker: false });
  assert.equal(Object.keys(sanitize({ imageDir: '/a', videoDir: '/b', unknown: 1 })).length, 0, '已经下线的素材目录配置不再接受');
});

test('头的大小限制在 0.6 – 1.4，路径必须是绝对路径', () => {
  assert.equal(sanitize({ headScale: 99 }).headScale, 1.4);
  assert.equal(sanitize({ headScale: 0.01 }).headScale, 0.6);
  assert.equal(sanitize({ headScale: 1.23456 }).headScale, 1.23);
  assert.equal(sanitize({ head: 'relative.png' }).head, undefined);
  assert.equal(sanitize({ head: 42 }).head, undefined);
  assert.equal(sanitize({ voice: null }).voice, null);
  if (process.platform === 'win32') assert.equal(sanitize({ head: 'C:\\tmp\\a.png' }).head, 'C:\\tmp\\a.png');
  else assert.equal(sanitize({ head: '/tmp/a.png' }).head, '/tmp/a.png');
  assert.deepEqual(sanitize({ petPos: { x: 10.4, y: 20.6 } }).petPos, { x: 10, y: 21 });
  assert.equal(sanitize({ petPos: { x: 'a' } }).petPos, undefined);
});

// ---------- 导入：选中即生效，只保留最近的几个，正在用的不删 ----------
test('导入后文件一定存在；超过上限时删最旧的，正在使用的保留', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bxc-pet-test-'));
  const src = path.join(tmp, '源 文件.png');
  fs.writeFileSync(src, 'demo');
  const dir = path.join(tmp, 'heads');
  const imported = [];
  for (let i = 0; i < 12; i++) {
    imported.push(await importFile(src, dir, 10));
    await new Promise((r) => setTimeout(r, 2)); // 保证时间戳递增
  }
  const left = fs.readdirSync(dir);
  assert.equal(left.length, 10, '只保留 10 个');
  assert.ok(fs.existsSync(imported[11]), '刚导入的文件必须还在（之前就是这里被误删）');
  assert.ok(fs.existsSync(imported[2]) && !fs.existsSync(imported[0]), '删的是最旧的');
  // 正在使用的旧文件不能删
  const oldest = imported[2]; // 前面清理后剩下的最旧一个
  const again = await importFile(src, dir, 3, [oldest]);
  assert.ok(fs.existsSync(oldest), '使用中的文件被保留');
  assert.ok(fs.existsSync(again));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------- 素材 ----------
test('猫身带实时计算的 S 形尾巴（含两只黄猫），人偶身没有尾巴', () => {
  for (const v of ['black', 'bluewhite', 'orange', 'cream']) {
    const torso = ART.torsoMarkup(v);
    for (const id of ['tailSil', 'tailColor', 'tailTipC']) assert.ok(torso.includes(`id="${id}"`), `${v} 缺少 ${id}`);
    assert.equal(torso.includes('tail-grp'), false, `${v}：不应再有刚体分段尾巴`);
  }
  assert.equal(ART.torsoMarkup('doll').includes('tailColor'), false);
  // 实时路径：从尾根出发、贝塞尔平滑、无 NaN，尾尖段是共享几何的子路径
  for (const [base, tip] of [[0, 0], [25, -40], [-25, 60], [45, -70]]) {
    const { d, dTip } = ART.tailPathD(base, tip);
    assert.ok(!/NaN/.test(d + dTip), `角度 ${base}/${tip} 出现 NaN`);
    assert.ok(d.startsWith('M126'), '路径应从尾根出发');
    assert.ok(d.length > dTip.length, '尾尖段应是整条路径的子集');
    assert.ok(d.endsWith(dTip.slice(-10)), '尾尖段必须与整条尾巴共享同一几何（否则接口会错位）');
  }
  assert.equal(ART.pawMarkup().split('class="bean"').length - 1, 4, '爪子上有四颗豆豆');
  for (const v of ['bluewhite', 'orange', 'cream']) assert.ok(ART.torsoMarkup(v).includes('clip-path='), `${v} 应有斑纹`);
  assert.equal(ART.torsoMarkup('black').includes('clip-path='), false, '黑猫不带斑纹');
  assert.equal(ART.keyboardSvg(true).includes('⌘'), true, 'mac 键盘刻 ⌘');
  assert.equal(ART.keyboardSvg(false).includes('Win'), true, 'Windows 键盘刻 Win');
  const kbd = ART.keyboardSvg(false);
  for (const ch of 'abcdefghijklmnopqrstuvwxyz0123456789') assert.ok(kbd.includes(`data-k="${ch}"`), `键盘缺少 ${ch}`);
  assert.equal(kbd.includes('flame'), false, '火焰动画已经去掉');
});

// ---------- 全局键鼠：键码 → 按键名、按住不放的识别 ----------
test('按键钩子把键码翻译成按键名，并识别「按住不放」', { skip: !hooks.hookAvailable && '当前环境没有全局键鼠组件' }, () => {
  const hook = new hooks.InputHook();
  const got = [];
  hook.on('event', (ev) => { if (ev.kind === 'key') got.push(ev); });
  hook.onKey({ keycode: 30 }); // A
  hook.onKey({ keycode: 30 }); // 还按着，系统自动重复
  hook.onKeyUp({ keycode: 30 });
  hook.onKey({ keycode: 30, shiftKey: true }); // 松开后再按才算新的一次
  assert.deepEqual(got.map((e) => [e.name, !!e.repeat]), [['a', false], ['a', true], ['a', false]]);
  assert.equal(got[2].shift, true);
  hook.onKey({ keycode: 42 });
  assert.equal(got[3].name, 'shift');
  assert.equal(got[3].mod, true);
  hook.onKey({ keycode: 999999 });
  assert.equal(got[4].name, '', '认不出的键码不崩溃，按空名处理');
  assert.equal(typeof hooks.labelFor, 'function');
});

test('鼠标移动事件限流，不会刷屏', { skip: !hooks.hookAvailable && '当前环境没有全局键鼠组件' }, () => {
  const hook = new hooks.InputHook();
  let moves = 0;
  hook.on('event', (ev) => { if (ev.kind === 'move') moves++; });
  hook.onMove({ x: 1, y: 1 });
  hook.onMove({ x: 2, y: 2 });
  hook.onMove({ x: 3, y: 3 });
  assert.equal(moves, 1, '33 毫秒内的连续移动只发一次');
});
