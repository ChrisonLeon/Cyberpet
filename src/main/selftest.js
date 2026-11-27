'use strict';
// 冒烟测试：无人值守地把桌宠的主要功能跑一遍，逐项截图并断言。
// 触发：设环境变量 BXC_PET_SELFTEST=<输出目录> 后启动（npm run smoke）。
// 可选 BXC_PET_PLATFORM=win32 | darwin：把展示逻辑模拟成另一个系统，检验按键标签和键盘刻字。
const fs = require('fs');
const path = require('path');
const { DEFAULTS } = require('./settings');
const { labelFor, fallbackAnchor } = require('../shared/keys');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 测试素材目录由主进程传入（开发时在仓库里；打包后通过 BXC_PET_FIXTURES 指到仓库目录，不打进安装包）
let FIXTURES = '';
const PAW_CENTER = (id) => `(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`;
const KEY_CENTER = (name, nth = 0) => `(() => { const n = document.querySelectorAll('#kbd [data-k="${name}"]')[${nth}]; if (!n) return null;`
  + ' const r = n.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()';
// 两只基准键之间的中点（左爪 F/G，右爪 H/J）
const HOME = (a, b) => `(() => { const a = document.querySelector('#kbd [data-k="${a}"]').getBoundingClientRect()`
  + `, b = document.querySelector('#kbd [data-k="${b}"]').getBoundingClientRect(); return [(a.left + a.right + b.left + b.right) / 4, a.top + a.height / 2]; })()`;
const dist = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : Infinity);

async function runSelfTest(ctx) {
  const { app, hook, dir, getPet, getPanel, setSettings, sendAction, status, ignore, getSettings, importHead, importVoice, userDataDir, platform, fixturesDir, log } = ctx;
  FIXTURES = fixturesDir || '';
  const pet = getPet();
  const panel = getPanel();
  const summary = { platform: process.platform, simulated: platform, errors: [], shots: [], checks: 0, steps: [] };
  const check = (cond, msg) => {
    summary.checks++;
    if (!cond) throw new Error(msg);
  };
  for (const [name, win] of [['pet', pet], ['panel', panel]]) {
    win.webContents.on('console-message', (e, legacyLevel, legacyMessage) => {
      const raw = e && e.level !== undefined ? e.level : legacyLevel;
      const level = typeof raw === 'string' ? (raw === 'error' ? 3 : raw === 'warning' ? 2 : 0) : (raw ?? 0);
      const message = (e && e.message) || legacyMessage || '';
      log(`${name} console[${raw}] ${message}`);
      if (level >= 2) summary.errors.push(`${name}: ${message}`);
    });
  }
  const js = (win, code) => win.webContents.executeJavaScript(code, true);
  const shot = async (name, win = pet) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(dir, `${name}.png`), img.toPNG());
    const cornerAlpha = img.toBitmap()[3];
    const size = img.getSize();
    summary.shots.push({ name, w: size.width, h: size.height, cornerAlpha });
  };
  class SkipError extends Error {}
  const step = async (name, fn) => {
    try {
      await fn();
      summary.steps.push(`✓ ${name}`);
    } catch (err) {
      if (err instanceof SkipError) { summary.steps.push(`⊘ ${name}（无测试素材）`); return; }
      summary.errors.push(`${name}: ${err.message}`);
      summary.steps.push(`✗ ${name}: ${err.message}`);
      log(`FAIL ${name}: ${err.message}`);
    }
  };
  const key = (name, extra = {}) => hook.inject({ kind: 'key', name, mod: false, ...extra });
  const mouse = (type, x, y) => pet.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 });
  const fix = (name) => path.join(FIXTURES, name);
  const hasFixtures = !!FIXTURES && fs.existsSync(path.join(FIXTURES, 'head.png'));
  const skip = (why) => { log('跳过：' + why); summary.steps.push('⊘ ' + why); };

  // 按一个键：对应的键会亮，对应的爪子落到这个键上（键盘图上没有的键，落到兜底位置）
  async function expectPawOn(name, pawId, nth = 0, tol = 5) {
    let target = [name, nth];
    const fb = fallbackAnchor(name); // 例如 F8 → 数字 0 上方
    if (fb && !(await js(pet, `!!document.querySelectorAll('#kbd [data-k="${name}"]').length`))) {
      const anchors = await js(pet, `document.querySelectorAll('#kbd [data-k="${fb[0]}"]').length`);
      target = [fb[0], anchors - 1];
      nth = 0;
    }
    key(name);
    await sleep(30);
    const down = await js(pet, `(() => { const n = document.querySelectorAll('#kbd [data-k="${name}"]')[${nth}]; return n ? n.classList.contains('down') : null; })()`);
    if (down !== null) check(down === true, `${name} 键没有高亮`);
    await sleep(240);
    const k = await js(pet, KEY_CENTER(target[0], target[1]));
    if (fb && target[0] !== name) { k[0] += fb[1]; k[1] += fb[2]; }
    const d = dist(await js(pet, PAW_CENTER(pawId)), k);
    check(d <= tol, `${name}: ${pawId} 爪离目标位置 ${d.toFixed(1)}px`);
  }

  await sleep(1400);

  await step('layout', async () => {
    await setSettings({ ...DEFAULTS, head: null, voice: null });
    await sleep(500);
    await shot('01-idle');
    check(summary.shots[0].cornerAlpha === 0, '窗口四角应当是透明的');
    const l = JSON.parse(await js(pet, "JSON.stringify({ w: innerWidth, h: innerHeight, desk: document.body.dataset.desk,"
      + " pad: getComputedStyle(document.getElementById('pad')).display, kb: getComputedStyle(document.getElementById('kb')).display })"));
    summary.layout = l;
    check(l.w === 394 && l.h === 430, `窗口尺寸 ${l.w}x${l.h}`);
    summary.tail = await js(pet, "(() => { const t = document.getElementById('tailColor');"
      + " return JSON.stringify({ dLive: (t ? t.getAttribute('d') : 'null').slice(0, 120),"
      + " dFresh: window.BXC_ART.tailPathD(0, 0).d.slice(0, 120),"
      + " rest: JSON.stringify(window.BXC_ART.TAIL_REST || 'none') }); })()");
    check(l.desk === 'bluewhite' && l.pad === 'block' && l.kb === 'block', '默认应当是蓝白桌面（键盘可见）');
    // 面板默认视图应当一屏放下，不出滚动条（授权横幅出现时内容变多，允许滚动）
    summary.panelLayout = await js(panel, "(() => { const footers = document.querySelectorAll('footer');"
      + " const footer = footers[footers.length - 1]; const perm = document.getElementById('perm');"
      + " return JSON.stringify({ header: document.querySelector('header').offsetHeight,"
      + " content: document.querySelector('main').scrollHeight,"
      + " permH: perm.hidden ? 0 : perm.offsetHeight + 10, footer: footer.offsetHeight,"
      + " bannerHidden: perm.hidden, win: innerHeight,"
      + " titlebarDrag: getComputedStyle(document.querySelector('header')).webkitAppRegion,"
      + " collapseNoDrag: getComputedStyle(document.getElementById('btnCollapse')).webkitAppRegion }); })()");
    log('面板布局 ' + summary.panelLayout);
    const pl = JSON.parse(summary.panelLayout);
    check(pl.titlebarDrag === 'drag' && pl.collapseNoDrag === 'no-drag', `标题栏拖拽区域不对（${pl.titlebarDrag}/${pl.collapseNoDrag}）`);
    // 无论有没有授权横幅（横幅出现时窗口会自动扩高），内容都必须一屏放下
    check(pl.header + pl.content + pl.footer <= pl.win + 2, `面板视图超出一屏（需要 ${pl.header + pl.content + pl.footer}px，窗口 ${pl.win}px）`);
    check(pl.header + pl.content - pl.permH + pl.footer <= pl.win + 2, `面板无横幅视图超出一屏（需要 ${pl.header + pl.content - pl.permH + pl.footer}px，窗口 ${pl.win}px）`);
    log(`面板自然高度（无授权横幅）${pl.header + pl.content - pl.permH + pl.footer}px`);
    await shot('01-panel', panel);
    await js(pet, "document.documentElement.style.background = 'linear-gradient(135deg, #d5e0f2, #8ea3c6)'; 1"); // 后续截图垫一层底色
  });

  await step('hit-test', async () => { // 透明区域点击穿透，画了东西的地方可以交互
    for (const [x, y, want] of [[214, 150, false], [4, 4, true], [20, 120, true], [214, 330, false], [214, 262, false], [8, 300, true]]) {
      pet.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      await sleep(80);
      const hit = ignore() === want;
      if (!hit) {
        const el = await js(pet, `(() => { const n = document.elementFromPoint(${x}, ${y}); return n ? (n.id || n.tagName) + '|' + (n.closest('[data-drag]')?.id || 'none') : 'null'; })()`);
        check(false, `鼠标在 ${x},${y}：穿透=${ignore()}，应为 ${want}（命中 ${el}）`);
      }
      check(hit, `鼠标在 ${x},${y}：穿透=${ignore()}，应为 ${want}`);
    }
    // 鼠标与键盘之间取「在同侧能看见的间隙」（鼠标可能在键盘左或右，另一侧算出来是负数）。
    // 用 computed style 的 left/width：getBoundingClientRect 会把 rotateX 投影后的放大也算进去，
    // 而 SVG 元素没有 offsetLeft。
    const gap = await js(pet, "(() => { const cs = (el) => getComputedStyle(el);"
      + " const k = document.getElementById('kb'), m = document.getElementById('deskmouse');"
      + " const kl = parseFloat(cs(k).left), ml = parseFloat(cs(m).left);"
      + " return Math.round(Math.max(kl - (ml + parseFloat(cs(m).width)), ml - (kl + parseFloat(cs(k).width)))); })()");
    summary.mouseGap = gap;
    check(gap >= 20, `鼠标离键盘太近：${gap}px`);
  });

  await step('paw-on-key', async () => {
    await expectPawOn('q', 'pawL');
    await expectPawOn('p', 'pawR');
    await expectPawOn('enter', 'pawR');
    await expectPawOn('b', 'pawL');
    await expectPawOn('shift', 'pawR', 1); // 刚才是左手按键，Shift 交给右手按（右侧那个）
    await expectPawOn('f8', 'pawR', 0, 7); // 键盘图上没有 F8：落到上方的兜底位置
    await shot('02-paw-on-key');
    await sleep(1300);
    check(dist(await js(pet, PAW_CENTER('pawL')), await js(pet, HOME('f', 'g'))) <= 5, '左手没有回到基准键 F/G');
    check(dist(await js(pet, PAW_CENTER('pawR')), await js(pet, HOME('h', 'j'))) <= 5, '右手没有回到基准键 H/J');
    // 按住不放：爪子停在键上，但不连着冒气泡
    const before = await js(pet, "document.getElementById('bubbles').children.length");
    key('a', { repeat: true });
    await sleep(120);
    check((await js(pet, "document.getElementById('bubbles').children.length")) <= before, '按住不放时不应该连冒气泡');
    check(dist(await js(pet, PAW_CENTER('pawL')), await js(pet, KEY_CENTER('a'))) <= 6, '按住不放时爪子应当停在 A 上');
  });

  await step('knock', async () => { // 敲一下脑袋 → 暴躁（台词是独立开关，默认关）
    const knock = async () => {
      mouse('mouseMove', 214, 150);
      await sleep(60);
      mouse('mouseDown', 214, 150);
      await sleep(60);
      mouse('mouseUp', 214, 150);
      await sleep(220);
    };
    await js(pet, "document.getElementById('speech').classList.remove('show'); 1");
    await knock();
    await shot('03-knock');
    check(await js(pet, "document.body.classList.contains('angry')"), '敲脑袋没有触发暴躁');
    check(await js(pet, "!document.getElementById('speech').classList.contains('show')"), '台词开关关闭时不应显示台词');
    check(await js(pet, "document.querySelector('.flame') === null"), '不应该再有火焰动画元素');
    await setSettings({ angryLine: true }); // 打开独立台词开关
    await sleep(200);
    await js(pet, "document.getElementById('speech').classList.remove('show'); 1");
    await knock();
    check(await js(pet, "document.getElementById('speech').classList.contains('show')"), '台词开关打开后敲脑袋应显示台词');
    check((await js(pet, "document.getElementById('speechText').textContent")).includes('能别放屁吗'), '台词内容不对');
    await shot('03-knock-line');
    await setSettings({ angryLine: false });
    await sleep(2600);
  });

  await step('petting', async () => { // 按住脑袋滑动 → 冒爱心（锁定状态下拖头=摸头）
    await setSettings({ headLock: true });
    await sleep(200);
    mouse('mouseDown', 214, 150);
    await sleep(520);
    for (let i = 1; i <= 4; i++) { mouse('mouseMove', 214 + i * 4, 150); await sleep(70); }
    summary.hearts = await js(pet, "document.getElementById('hearts').children.length");
    mouse('mouseUp', 230, 150);
    await sleep(150);
    check(summary.hearts > 0, `摸头没有冒爱心（${summary.hearts}）`);
    await setSettings({ headLock: false });
    await sleep(200);
  });

  await step('drag', async () => { // 拖动身子 → 窗口跟着走
    const before = pet.getPosition();
    await js(pet, `(() => {
      const fire = (type, x, y, mx, my) => document.elementFromPoint(x, y).dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, movementX: mx, movementY: my }));
      fire('pointermove', 214, 262, 0, 0);
      fire('pointerdown', 214, 262, 0, 0);
      for (let i = 1; i <= 6; i++) { fire('pointermove', 214 - i * 5, 262 - i * 4, -5, -4); }
      fire('pointerup', 184, 238, 0, 0);
      return 1;
    })()`);
    await sleep(800);
    const after = pet.getPosition();
    check(after[0] !== before[0] || after[1] !== before[1], '拖动时窗口没有移动');
    pet.setPosition(before[0], before[1]);
  });

  await step('typing', async () => {
    for (const k of ['b', 'a', 'i', 'x', 'i', 'a', 'o', 'c', 'h']) { key(k); await sleep(90); }
    await sleep(30);
    await shot('04-typing');
    summary.statusTyping = { ...status() };
  });

  await step('mouse', async () => { // 鼠标一动，右爪去抓右侧的鼠标（反向默认）
    sendAction('mouse-demo');
    await sleep(800);
    await shot('05-mouse');
    const p = await js(pet, PAW_CENTER('pawR'));
    check(Math.hypot(p[0] - 361, p[1] - 372) <= 14, `右爪没有伸到鼠标上（${p.map(Math.round)}）`);
  });

  await step('mouse-press', async () => { // 左右键按下反馈：按住持续高亮，松开恢复
    hook.inject({ kind: 'mousedown', button: 1 });
    await sleep(120);
    check(await js(pet, "document.body.classList.contains('mx-l') && !document.body.classList.contains('mx-r')"), '左键按住应标记 mx-l');
    await shot('05-mouse-l');
    hook.inject({ kind: 'mousedown', button: 2 });
    await sleep(120);
    check(await js(pet, "document.body.classList.contains('mx-l') && document.body.classList.contains('mx-r')"), '右键按住应同时标记 mx-r');
    hook.inject({ kind: 'mouseup', button: 1 });
    hook.inject({ kind: 'mouseup', button: 2 });
    await sleep(120);
    check(await js(pet, "!document.body.classList.contains('mx-l') && !document.body.classList.contains('mx-r')"), '松开后应清除按压标记');
  });

  await step('kbdir-forward', async () => { // 正向：键盘转半圈挪到左，鼠标在左下角，左爪去抓
    await setSettings({ kbDir: 'forward' });
    await sleep(400);
    const l = JSON.parse(await js(pet, "JSON.stringify({ dir: document.body.dataset.kbDir,"
      + " kbT: getComputedStyle(document.getElementById('kb')).transform,"
      + " mouseLeft: Math.round(document.getElementById('deskmouse').getBoundingClientRect().left) })"));
    check(l.dir === 'forward', `方向没有切到 forward（${l.dir}）`);
    check(l.mouseLeft < 100, `正向时鼠标应在左侧（left=${l.mouseLeft}）`);
    await shot('05-kbdir-forward');
    try {
      // 上一步的扑鼠标窗口（2.8s）此时可能还没结束；正向时鼠标和 P 键都归左爪管，
      // 必须等窗口结束、伸爪量彻底归零，P 键的落点才量得准
      await sleep(2000);
      // 键盘转半圈后，P 键的视觉位置到了左半边：负责它的爪子也随之换成左爪
      await expectPawOn('p', 'pawL');
      // 先按 P 再扑鼠标：正向时鼠标和 P 键都归左爪管，必须等扑鼠标的窗口结束再量落键位置
      sendAction('mouse-demo');
      await sleep(800);
      const pl = await js(pet, PAW_CENTER('pawL'));
      check(Math.hypot(pl[0] - 33, pl[1] - 372) <= 16, `正向时左爪应伸到左侧鼠标（${pl.map(Math.round)}）`);
    } finally {
      await setSettings({ kbDir: 'reverse' }); // 断言失败也不能把 forward 带进后面的步骤
      await sleep(2200); // 等扑鼠标窗口结束、爪子归位
    }
    check((await js(pet, "document.body.dataset.kbDir")) === 'reverse', '没有切回反向');
  });

  await step('privacy-shield', async () => { // 自动隐私保护：开启 → 遮蔽/隐藏；期间输入被拦；关闭恢复
    const before = await js(pet, "document.querySelectorAll('.kcap').length");
    try {
      const on = await setSettings({ privacy: true });
      check(on.privacy && on.privacy.enabled === true, `隐私开关没有生效（${JSON.stringify(on.privacy)}）`);
      await sleep(1500); // 等探测器启动并输出
      const state = (await setSettings({})).privacy; // 空补丁：拿当前实时状态
      // 桌面上若正好有全屏应用或录屏软件，主进程会直接隐藏整窗（hidden），也是正确的保护形态
      check(['shield', 'normal', 'hidden'].includes(state.mode), `开启后应为 shield、normal 或 hidden（${state.mode}）`);
      const covered = await js(pet, "document.body.classList.contains('privacy')");
      check(covered === (state.mode !== 'normal'), `遮蔽标记与实际状态不符（${state.mode}）`);
      await shot('08-privacy');
      if (state.mode !== 'normal') {
        key('z'); // 保护期间注入的按键不应变成气泡
        await sleep(200);
        const after = await js(pet, "document.querySelectorAll('.kcap').length");
        check(after === before, `保护期间按键不应显示（${before}→${after}）`);
      }
    } finally {
      const off = await setSettings({ privacy: false }); // 断言失败也要关掉保护，别把 hidden 带进后面的步骤
      check(off.privacy.mode === 'off', `关闭后应回到 off（${off.privacy.mode}）`);
      check((await js(pet, "!document.body.classList.contains('privacy')")) === true, '关闭后应移除遮蔽标记');
      await sleep(200);
    }
  });
  await step('pat', async () => { sendAction('pat'); await sleep(260); await shot('06-pat'); });
  await step('frenzy', async () => {
    sendAction('frenzy');
    await sleep(650);
    await shot('07-frenzy');
    summary.statusFrenzy = { ...status() };
    sendAction('frenzy');
  });

  let n = 10;
  for (const body of ['black', 'bluewhite', 'orange', 'cream']) {
    for (const headMode of ['photo', 'cartoon']) {
      if (body === 'black' && headMode === 'photo') continue;
      await step(`look-${body}-${headMode}`, async () => {
        await setSettings({ body, headMode, sticker: true, desk: 'bluewhite', headScale: 1.1 });
        await sleep(260);
        await shot(`${String(n++).padStart(2, '0')}-${body}-${headMode}`);
      });
    }
  }
  await step('desk-variants', async () => {
    await setSettings({ body: 'black', headMode: 'photo', desk: 'bluewhite' });
    await sleep(240);
    await shot(`${String(n++).padStart(2, '0')}-desk-bluewhite`);
    await setSettings({ desk: 'dark', sticker: false });
    await sleep(240);
    await shot(`${String(n++).padStart(2, '0')}-desk-dark-nosticker`);
    await setSettings({ desk: 'none' });
    await sleep(240);
    await shot(`${String(n++).padStart(2, '0')}-desk-none`);
    const p = await js(pet, "getComputedStyle(document.getElementById('pad')).display + '/' + getComputedStyle(document.getElementById('kb')).display");
    check(p === 'none/none', `无道具模式应当没有键盘（${p}）`);
    key('k');
    await sleep(150); // 没有键盘图时按键也不能出错
    await setSettings({ desk: 'transparent', sticker: true });
    await sleep(240);
    await shot(`${String(n++).padStart(2, '0')}-desk-transparent`);
    const t = await js(pet, "getComputedStyle(document.getElementById('pad')).display + '/' + getComputedStyle(document.getElementById('kb')).display");
    check(t === 'none/block', `透明桌面应当保留键盘（${t}）`);
  });
  await step('pet-scale', async () => { // 整体大小：窗口和内容一起缩，右下角不动
    const before = pet.getBounds();
    await setSettings({ petScale: 1.3 });
    await sleep(500);
    const big = pet.getBounds();
    const z = pet.webContents.getZoomFactor();
    check(Math.abs(big.width - Math.round(394 * 1.3)) <= 3, `放大后窗口宽 ${big.width}，应约 ${Math.round(394 * 1.3)}`);
    check(Math.abs(z - 1.3) < 0.02, `缩放系数 ${z}`);
    check(Math.abs(big.y + big.height - (before.y + before.height)) <= 3, '底边应当保持不动');
    await shot(`${String(n++).padStart(2, '0')}-scale130`);
    await setSettings({ petScale: 1 });
    await sleep(400);
    check(Math.abs(pet.getBounds().width - 394) <= 3, '没有恢复默认大小');
  });
  await step('head-offset', async () => { // 未锁定时拖头像=调位置，锁定后不可拖
    await setSettings({ headMode: 'photo', head: null, headLock: false, headOffset: null });
    await sleep(400);
    const posOf = "(() => { const r = document.getElementById('headAnim'); const c = getComputedStyle(r); return [Math.round(parseFloat(c.left)), Math.round(parseFloat(c.top))]; })()";
    const pos0 = await js(pet, posOf);
    await js(pet, `(() => {
      const head = document.getElementById('headAnim');
      const fire = (type, x, y, mx, my) => head.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 7, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, movementX: mx, movementY: my }));
      fire('pointerdown', 214, 150, 0, 0);
      for (let i = 1; i <= 5; i++) fire('pointermove', 214 + i * 8, 150 - i * 3, 8, -3);
      fire('pointerup', 254, 135, 0, 0);
      return 1;
    })()`);
    await sleep(600);
    const pos1 = await js(pet, posOf);
    const saved = getSettings().headOffset;
    check(pos1[0] > pos0[0] && pos1[1] < pos0[1], `拖动后头像没有移动（${JSON.stringify(pos0)}→${JSON.stringify(pos1)}）`);
    check(saved && saved.x > 0 && saved.y < 0, `偏移没有落盘（${JSON.stringify(saved)}）`);
    await shot(`${String(n++).padStart(2, '0')}-head-offset`);
    await setSettings({ headLock: true });
    await sleep(250);
    await js(pet, `(() => {
      const head = document.getElementById('headAnim');
      const fire = (type, x, y, mx, my) => head.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 8, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, movementX: mx, movementY: my }));
      fire('pointerdown', 214, 150, 0, 0);
      fire('pointermove', 240, 130, 26, -20);
      fire('pointerup', 240, 130, 0, 0);
      return 1;
    })()`);
    await sleep(400);
    const saved2 = getSettings().headOffset;
    check(saved2.x === saved.x && saved2.y === saved.y, `锁定后还能拖动（${JSON.stringify(saved)}→${JSON.stringify(saved2)}）`);
    await shot(`${String(n++).padStart(2, '0')}-head-locked`);
    await setSettings({ headLock: false, headOffset: null });
    await sleep(400); // 等动画帧：脑袋有呼吸浮动，比较留容差
    const pos2 = await js(pet, posOf);
    check(pos2[0] === pos0[0] && pos2[1] === pos0[1], `归位后没有回到默认位置（${JSON.stringify(pos0)}→${JSON.stringify(pos2)}）`);
  });
  await step('head-sizes', async () => {
    await setSettings({ headScale: 1.4 });
    await sleep(300);
    await shot(`${String(n++).padStart(2, '0')}-head140`);
    await setSettings({ headScale: 0.7 });
    await sleep(300);
    await shot(`${String(n++).padStart(2, '0')}-head070`);
    await setSettings({ headScale: 1.1 });
  });

  // ---------- 真实的导入流程（之前「导入后没变化」的 bug 就出在这里）----------
  if (!hasFixtures) { skip('没有测试素材（BXC_PET_FIXTURES），跳过导入与配音联动共 3 步'); }
  await step('import-image', async () => {
    if (!hasFixtures) throw new SkipError();
    const r = await importHead(fix('head.png'));
    check(r && fs.existsSync(r.settings.head), '导入的图片没有落盘');
    check(r.meta.headType === 'image', '应当识别为图片头像');
    await sleep(400);
    const img = JSON.parse(await js(pet, "JSON.stringify({ ok: document.getElementById('headImg').complete && document.getElementById('headImg').naturalWidth > 0,"
      + " shown: getComputedStyle(document.getElementById('headImg')).display, video: getComputedStyle(document.getElementById('headVideo')).display,"
      + " anim: document.body.dataset.anim })"));
    check(img.ok && img.video === 'none', `图片头像没有显示（${JSON.stringify(img)}）`);
    check(img.anim === 'static', '图片头像平时应停在静态首帧');
    await shot(`${String(n++).padStart(2, '0')}-import-image`);
  });

  // audioTried：确实发起了配音播放。CI 机器通常没有声卡，play() 会被拒绝，所以不能只看 paused。
  const voiceState = async () => JSON.parse(await js(pet, "(() => { const a = document.getElementById('voice'), v = document.getElementById('headVideo');"
    + " return JSON.stringify({ audioTried: a.dataset.tried === '1', audioPlaying: !a.paused || a.ended, hasAudio: !!a.getAttribute('src'), videoMuted: v.muted }); })()"));
  const played = (s) => s.audioTried || s.audioPlaying;
  const trigger = async () => {
    await js(pet, "document.getElementById('voice').dataset.tried = ''; 1");
    sendAction('angry');
  };

  await step('voice-image-head', async () => { // 图片头像：平时静态首帧，触发时切动画并播导入的配音
    if (!hasFixtures) throw new SkipError();
    await setSettings({ head: null, headMode: 'photo' });
    const r = await importVoice(fix('voice.m4a'));
    check(r && r.meta.voiceName === 'voice.m4a', '配音没有导入成功');
    await sleep(300);
    trigger();
    await sleep(300);
    const s = await voiceState();
    check(played(s), `图片头像应当播导入的配音（${JSON.stringify(s)}）`);
    check(await js(pet, "document.body.dataset.anim") === 'play', '触发时图片头像应切到动画');
    await shot(`${String(n++).padStart(2, '0')}-voice-image-head`);
    await sleep(3200); // 等触发窗口结束
    check(await js(pet, "document.body.dataset.anim") === 'static', '触发结束后应回到静态首帧');
    await setSettings({ voice: null });
    await sleep(200);
    trigger(); // 什么都没有：合成音效，不能出错
    await sleep(200);
    const none = await voiceState();
    check(!none.hasAudio && !played(none), '清除配音后回到合成音效');
    await sleep(2800);
  });

  await step('import-prune', async () => {
    if (!hasFixtures) throw new SkipError(); // 只保留最近的 10 个，正在用的不删
    for (let i = 0; i < 14; i++) await importHead(fix('head.png'));
    const files = fs.readdirSync(path.join(userDataDir, 'heads'));
    check(files.length <= 10, `头像目录应当不超过 10 个文件（${files.length}）`);
    check(fs.existsSync(getSettings().head), '当前使用的头像文件必须存在');
    await setSettings({ head: null });
  });

  await step('rage-mode', async () => { // 没有导入配音：不显示台词也不播音，逐渐暴躁疯狂打字
    await setSettings({ head: null, headMode: 'photo', headLock: true, voice: null });
    await sleep(300);
    await js(pet, "document.getElementById('speech').classList.remove('show'); document.querySelectorAll('.kcap').forEach(n => n.remove()); 1"); // 清掉上一步残留的气泡和台词
    const bubblesBefore = await js(pet, "document.querySelectorAll('.kcap').length");
    trigger();
    await sleep(500);
    const r = JSON.parse(await js(pet, "JSON.stringify({ speech: document.getElementById('speech').classList.contains('show'),"
      + " bubbles: document.querySelectorAll('.kcap').length, angry: document.body.classList.contains('angry') })"));
    const vs = await voiceState();
    check(r.angry === true, '暴躁模式应有生气表情');
    check(r.speech === false, `台词开关关闭时不应显示台词（${JSON.stringify(r)}）`);
    check(r.bubbles > bubblesBefore + 2, `暴躁时应疯狂击打键盘（气泡 ${bubblesBefore}→${r.bubbles}）`);
    check(vs.audioTried === false && !vs.audioPlaying, `没有配音时不应播放媒体声音（${JSON.stringify(vs)}）`);
    await shot('07-rage');
    summary.statusRage = { ...status() };
    await sleep(2600);
  });

  // ---------- 平台：标签和键盘刻字按平台来 ----------
  await step('platform', async () => {
    await setSettings({ keyBubbles: true, head: null, headMode: 'photo' });
    for (let i = 0; i < 12; i++) { // 等上一步的气泡动画全部结束，避免读到旧气泡
      if ((await js(pet, "document.querySelectorAll('.kcap').length")) === 0) break;
      await sleep(250);
    }
    key('shift');
    await sleep(60);
    const label = await js(pet, "(() => { const b = document.querySelectorAll('.kcap'); return b.length ? b[b.length - 1].textContent : null; })()");
    check(label === labelFor('shift', platform), `Shift 的气泡应当是「${labelFor('shift', platform)}」，实际「${label}」`);
    const caps = await js(pet, "document.getElementById('kbd').textContent");
    check(caps.includes(platform === 'darwin' ? '⌘' : 'Win'), `键盘刻字与平台不符（${platform}）`);
    summary.label = label;
  });

  await step('panel', async () => {
    await setSettings({ head: null, headMode: 'cartoon', voice: null, keySfx: true, desk: 'transparent' });
    await sleep(300);
    const a = JSON.parse(await js(panel, "JSON.stringify({ dirs: document.querySelectorAll('[data-dir]').length,"
      + " headBtns: document.querySelectorAll('#btnPickHead, #btnResetHead').length,"
      + " videoBtnGone: !document.getElementById('btnPickHeadVideo'), easterGone: !document.querySelector('[data-key=\"voiceEaster\"]'),"
      + " sfxOn: !!document.querySelector('[data-key=\"sfxOn\"]'), soundDisabled: document.getElementById('switchSound').disabled, head: document.getElementById('headName').textContent,"
      + " title: document.querySelector('h1').textContent,"
      + " about: document.getElementById('aboutText').textContent,"
      + " qrs: [!!document.getElementById('qrWechat'), !!document.getElementById('qrAlipay'), !!document.getElementById('qrZoom')] })"));
    summary.panel = a;
    check(a.dirs === 0, '素材目录配置应当已经去掉');
    check((await js(panel, "document.querySelectorAll('[data-body]').length")) === 4, '应当有 4 种身子（人偶身已删除）');
    check((await js(panel, "document.querySelectorAll('[data-kb-dir]').length")) === 2, '应当有正向/反向两个键鼠方向按钮');
    check((await js(panel, "!!document.getElementById('privacyStatus')")) === true, '应当有隐私实际状态显示');
    check((await js(panel, "!!document.getElementById('petScale')")) === true, '应当有整体大小滑块');
    check((await js(panel, "!!document.querySelector('[data-key=\"headLock\"]')")) === true, '应当有锁定头像位置复选框');
    check(a.videoBtnGone === true && a.easterGone === true, '「选视频」和「原声彩蛋」应当已经移除');
    check(a.sfxOn === true, '应当有音效总开关');
    check(a.headBtns === 2, '头像行应当只剩 选图片/还原默认头像 两个按钮');
    check(a.soundDisabled === false, '键盘音效开着时轴体应当可选');
    check(a.head.includes('当前：'), '没有显示当前头像');
    check(a.title.includes('CyberPet'), `面板标题应当包含软件名（${a.title}）`);
    check(a.about.includes('作者：'), `应当显示作者信息（${a.about}）`);
    check(a.qrs.every(Boolean), '应当有微信/支付宝收款码和放大弹层');
    // 收款码图片要真的加载出来（打包后从 asar 里读）
    for (const id of ['qrWechat', 'qrAlipay']) {
      await sleep(200);
      check(await js(panel, `(() => { const i = document.querySelector('#${id} img'); return i.complete && i.naturalWidth > 0; })()`) === true, `${id} 收款码图片没有加载出来`);
    }
    // 点击缩略图弹出放大层，点弹层任意处关闭
    await js(panel, "document.getElementById('qrWechat').click(); 1");
    await sleep(120);
    check(await js(panel, "(() => { const z = document.getElementById('qrZoom'); return !z.hidden && !!document.getElementById('qrZoomImg').getAttribute('src'); })()") === true, '点击收款码应当弹出放大层');
    await js(panel, "document.getElementById('qrZoom').click(); 1");
    await sleep(120);
    check(await js(panel, "document.getElementById('qrZoom').hidden") === true, '点击弹层应当关闭放大层');
    await setSettings({ keySfx: false });
    await sleep(200);
    check((await js(panel, "document.getElementById('switchSound').disabled")) === true, '键盘音效关闭时轴体应当置灰');
    await js(panel, "document.getElementById('perm').hidden = false; 1");
    await sleep(200);
    await shot(`${String(n++).padStart(2, '0')}-panel`, panel);
    await setSettings({ keySfx: true });
  });

  summary.status = { ...status() };
  summary.hookStart = { state: hook.state, error: hook.error ? String(hook.error.message || hook.error) : null };
  for (let i = 0; i < 6 && hook.state !== 'live'; i++) await sleep(500); // 先等几秒真实键鼠事件
  if (hook.state === 'listening' && hook.postTestKey()) { await sleep(700); summary.testKeyPosted = true; } // 发一个无害的 Shift，验证系统钩子全链路
  summary.hookEnd = { state: hook.state, events: hook.eventCount };
  await setSettings(DEFAULTS);
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  const passed = summary.steps.filter((s) => s.startsWith('✓')).length;
  log(`通过 ${passed}/${summary.steps.length} 步，${summary.checks} 项断言；失败 ${summary.errors.length}`);
  for (const e of summary.errors) log('  ✗ ' + e);
  app.exit(summary.errors.length ? 1 : 0); // 有失败就以非零状态退出，CI 才能发现回归
}

module.exports = { runSelfTest };
