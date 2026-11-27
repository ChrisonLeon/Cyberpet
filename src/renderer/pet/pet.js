/* 桌宠渲染层：动效引擎 + 指针交互 + 点击穿透判定。 */
(function () {
  'use strict';
  const ART = window.BXC_ART;
  const Sfx = window.BXC_SFX;
  const KEYS = window.BXC_KEYS;
  const VOICE = window.BXC_VOICE;
  const $ = (s) => document.querySelector(s);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);

  // 二阶阻尼弹簧：动作目标变了，值会「追」过去并带一点过冲，比直接赋值生动得多
  function makeSpring(hz, damping) {
    return {
      x: 0, v: 0,
      step(target, dt) {
        const w = 2 * Math.PI * hz;
        const n = Math.max(1, Math.ceil(dt * 240));
        const h = dt / n;
        for (let i = 0; i < n; i++) {
          this.v += (w * w * (target - this.x) - 2 * damping * w * this.v) * h;
          this.x += this.v * h;
        }
        return this.x;
      },
      kick(dv) { this.v += dv; },
    };
  }
  // 头 2.6Hz、脊柱 1.9Hz、挤压 2.6Hz、尾根 1.6Hz、尾尖 3.2Hz：互不同步，动作才有层次
  const springHead = makeSpring(2.6, 0.62);
  const springSpine = makeSpring(1.9, 0.72);
  const springSquash = makeSpring(2.6, 0.54);
  const springTail = makeSpring(1.6, 0.5);
  const springTailTip = makeSpring(3.2, 0.4);

  // 肩膀在身子两侧偏下；爪子平时停在基准键上，打字时移到对应的键
  const PAW = {
    L: { shoulder: [160, 288], mouse: [33, 372], homeKeys: ['f', 'g'], rest: [186, 344] },
    R: { shoulder: [268, 288], homeKeys: ['h', 'j'], rest: [254, 344] },
  };
  const DEMO_KEYS = 'baixiaochun'.split('');
  const ANGRY_LINE = '「能别放屁吗!」';
  const PAT_LINES = ['喵~', '呼噜呼噜…', '舒服~', '再摸要掉毛啦'];
  const HEART = '<svg class="heart" viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-9.6-9.3C.9 8.2 2.7 4.5 6.3 4.5c2 0 3.6 1.1 4.4 2.7.8-1.6 2.4-2.7 4.4-2.7 3.6 0 5.4 3.7 3.9 7.2C19.5 16.4 12 21 12 21z"/></svg>';

  const el = {
    stage: $('#stage'),
    body: document.body,
    headAnim: $('#headAnim'), headImg: $('#headImg'), headGhost: $('#headGhost'), headVideo: $('#headVideo'), cartoon: $('#headCartoon'),
    torso: $('#torso'), tailSil: null, tailColor: null, tailTipC: null, bell: null, pawL: $('#pawL'), pawR: $('#pawR'),
    armL: $('#armL'), armR: $('#armR'), armLEdge: $('#armLEdge'), armREdge: $('#armREdge'),
    kb: $('#kb'), kbd: $('#kbd'), bubbles: $('#bubbles'), hearts: $('#hearts'),
    speech: $('#speech'), speechText: $('#speechText'), voice: $('#voice'),
  };

  const sfx = new Sfx();
  const cfg = { settings: null, meta: null, headSrc: '', offset: { x: 0, y: 0 } };
  const paw = {
    L: { x: PAW.L.rest[0], y: PAW.L.rest[1], tx: PAW.L.rest[0], ty: PAW.L.rest[1], press: 0, lastKey: -9, reach: 0 },
    R: { x: PAW.R.rest[0], y: PAW.R.rest[1], tx: PAW.R.rest[0], ty: PAW.R.rest[1], press: 0, lastKey: -9, reach: 0 },
  };
  const st = {
    t: 0, typing: 0, side: 0, lastHand: 'L',
    reach: 0, mouseDemoUntil: -9, lastMove: -9, wheelUntil: -9,
    frenzy: false, acc: 0, demoUntil: -9, demoIdx: 0,
    angryUntil: -9, anger: 0, lastAngerAt: -9,
    happyUntil: -9, lastInputAt: -9,
    petTilt: 0, lastSfx: -9, lastBubble: -9, lastHeart: -9, lastMeow: -9, lastPatLine: -9,
    combo: [], voiceUntil: -9,
    fidget: null, // 闲时小动作：歪头 / 张望 / 抖耳朵 / 伸懒腰 / 挪窝
    fx: { lookX: 0, stretchY: 0, shiftX: 0, earWig: 0, tilt: 0 },
  };

  // ---------- 设置 ----------
  function buildBody() {
    const v = cfg.settings.body;
    el.torso.innerHTML = ART.torsoMarkup(v);
    el.tailSil = el.torso.querySelector('#tailSil');
    el.tailColor = el.torso.querySelector('#tailColor');
    el.tailTipC = el.torso.querySelector('#tailTipC');
    el.cartoon.innerHTML = ART.cartoonHeadMarkup();
    el.pawL.innerHTML = ART.pawMarkup();
    el.pawR.innerHTML = ART.pawMarkup();
    el.bell = el.torso.querySelector('#bell');
  }

  // 头像互斥：图片 / 视频 / Q版猫头，任何时刻只有一个在显示
  function applyHeadMedia(payload) {
    const isVideo = payload.meta.headType === 'video';
    el.body.dataset.media = payload.meta.headType;
    if (isVideo) {
      const src = payload.meta.headSrc;
      if ((el.headVideo.getAttribute('src') || '') !== src) {
        el.headVideo.muted = true;
        st.voiceUntil = -9;
        el.headVideo.src = src;
        el.headVideo.play().catch(() => {});
      }
      el.headImg.removeAttribute('src');
      el.headGhost.removeAttribute('src');
    } else {
      el.headVideo.pause();
      el.headVideo.removeAttribute('src');
      el.headVideo.muted = true;
      st.voiceUntil = -9;
      if (cfg.headSrc !== payload.meta.headSrc) {
        cfg.headSrc = payload.meta.headSrc;
        el.headImg.src = cfg.headSrc;
        el.headGhost.src = cfg.headSrc;
      }
    }
  }

  function voiceSource(s, m) {
    return VOICE.resolve({ headMode: s.headMode, headType: m.headType, voiceEaster: s.voiceEaster, hasVoice: !!m.voiceSrc }).source;
  }

  function applySettings(payload) {
    const s = payload.settings;
    const prev = cfg.settings;
    const prevMeta = cfg.meta;
    cfg.settings = s;
    cfg.meta = payload.meta;
    cfg.offset = (s.headOffset && Number.isFinite(s.headOffset.x)) ? { ...s.headOffset } : { x: 0, y: 0 };
    el.body.dataset.body = s.body;
    el.body.dataset.desk = s.desk;
    el.body.dataset.head = s.headMode;
    el.headAnim.style.cursor = s.headLock ? 'pointer' : 'move';
    el.body.classList.toggle('sticker', s.sticker);
    document.documentElement.style.setProperty('--hs', s.headScale);
    if (!el.kbdBuilt) {
      el.kbd.innerHTML = ART.keyboardSvg(payload.meta.isMac);
      el.kbdBuilt = true;
      keyMap = null;
    }
    if (!prev || prev.body !== s.body) buildBody();
    applyHeadMedia(payload);
    const voice = payload.meta.voiceSrc || '';
    if ((el.voice.getAttribute('src') || '') !== voice) {
      if (voice) el.voice.src = voice;
      else { el.voice.removeAttribute('src'); el.voice.load(); }
    }
    // 「原声彩蛋」刚对视频头像生效时（勾选，或换了视频），先从头播一遍让大家听到
    if (prev && voiceSource(s, payload.meta) === 'video' && voiceSource(prev, prevMeta) !== 'video') playOriginal();
  }

  el.headImg.addEventListener('error', () => {
    if (el.body.dataset.media !== 'image') return;
    const fallback = cfg.meta && cfg.meta.defaultHeadSrc;
    if (fallback && el.headImg.getAttribute('src') !== fallback) {
      el.headImg.src = fallback;
      el.headGhost.src = fallback;
    }
  });
  // 视频打不开（文件被删、格式不支持）：告诉主进程换回内置头，别留一个黑框
  el.headVideo.addEventListener('error', () => window.pet.headBroken());

  // ---------- 键盘上每个键的位置（舞台坐标）----------
  let keyMap = null; // 键名 → [{ x, y, node }]

  function buildKeyMap() {
    keyMap = new Map();
    if (getComputedStyle(el.kb).display === 'none') return;
    const origin = el.stage.getBoundingClientRect();
    for (const node of el.kbd.querySelectorAll('.key')) {
      const r = node.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const name = node.dataset.k;
      if (!keyMap.has(name)) keyMap.set(name, []);
      keyMap.get(name).push({ x: r.left - origin.left + r.width / 2, y: r.top - origin.top + r.height / 2, node });
    }
  }

  function kbCenterX() {
    const r = el.kb.getBoundingClientRect();
    return r.left + r.width / 2;
  }

  function pawHome(hand) {
    if (!keyMap || keyMap.size === 0) return PAW[hand].rest;
    const [a, b] = PAW[hand].homeKeys.map((k) => (keyMap.get(k) || [])[0]);
    return a && b ? [(a.x + b.x) / 2, a.y] : PAW[hand].rest;
  }

  // 某个键在画面上的位置；键盘图上没有的键（F 键、方向键…）落到兜底区域，找不到就返回 null
  function keyAnchor(name) {
    if (!keyMap) buildKeyMap();
    if (!keyMap || keyMap.size === 0) return null;
    const list = keyMap.get(name);
    if (list && list.length) {
      // Shift / Ctrl / Alt 左右各一个：用另一只手去按
      return list.length > 1 && st.lastHand === 'L' ? list[list.length - 1] : list[0];
    }
    const fb = KEYS.fallbackAnchor(name);
    if (fb) {
      const anchors = keyMap.get(fb[0]);
      if (anchors && anchors.length) {
        const a = anchors[anchors.length - 1];
        return { x: a.x + fb[1], y: a.y + fb[2], node: null };
      }
    }
    return null;
  }

  window.addEventListener('resize', () => { keyMap = null; });

  // ---------- 输入 ----------
  function onInput(ev) {
    if (!ev) return;
    // 系统级的松手：哪怕是在窗口外松的，也把拖动 / 按压收尾
    if (ev.kind === 'mousedown' || ev.kind === 'mouseup') {
      if (ev.kind === 'mouseup' && ev.button === 1) release();
      return;
    }
    if (ev.kind === 'keyup') return;
    if (ev.kind === 'key') {
      if (ev.repeat) { holdKey(ev.name); return; } // 按住不放：爪子停在键上反复按，但不连冒气泡、连响
      onKey(ev);
      return;
    }
    st.lastInputAt = st.t;
    if (ev.kind === 'move') st.lastMove = st.t;
    if (ev.kind === 'wheel') st.wheelUntil = st.t + 0.7;
  }

  function holdKey(name) {
    st.lastInputAt = st.t;
    st.typing = Math.max(st.typing, 0.8);
    const hit = keyAnchor(name);
    if (hit) {
      const p = paw[hit.x < kbCenterX() ? 'L' : 'R'];
      p.tx = hit.x;
      p.ty = hit.y;
      p.press = 1;
      p.lastKey = st.t;
      if (hit.node) pressNode(hit.node);
    }
  }

  function onKey(ev) {
    const now = st.t;
    if (now - st.lastInputAt > 3) st.combo.length = 0;
    typeKey(ev);
    if (ev.mod) return; // 修饰键也算按了一下，但不计入「敲得太快」
    st.combo.push(now);
    while (st.combo.length && st.combo[0] < now - 2.2) st.combo.shift();
    // 敲得太猛也会被嫌弃
    if (st.combo.length >= 22 && now - st.lastAngerAt > 12) {
      st.combo.length = 0;
      angry();
    }
  }

  function typeKey(ev) {
    const s = cfg.settings;
    const now = st.t;
    st.typing = 1;
    st.lastInputAt = now;
    const hit = keyAnchor(ev.name);
    let hand;
    if (hit) {
      hand = hit.x < kbCenterX() ? 'L' : 'R'; // 键在键盘左半边用左爪，右半边用右爪
      const p = paw[hand];
      p.tx = hit.x;
      p.ty = hit.y;
      if (hit.node) pressNode(hit.node);
    } else {
      hand = st.side ? 'L' : 'R'; // 没有键盘图：两只爪子轮流原地敲
      st.side = 1 - st.side;
    }
    const p = paw[hand];
    p.press = 1;
    p.lastKey = now;
    st.lastHand = hand;
    springSquash.kick(0.02);
    springTailTip.kick(rand(0.7, 1.7));
    if (s.keyBubbles && (now - st.lastBubble > 0.05)) {
      spawnBubble(ev.label, hit ? [hit.x, hit.y - 8] : [p.x, p.y - 10]);
    }
    if (s.keySfx) {
      const gap = st.frenzy ? 0.075 : 0.032;
      if (now - st.lastSfx >= gap) {
        st.lastSfx = now;
        sfx.key(s.switchSound);
      }
    }
  }

  function spawnBubble(label, at) {
    if (!label) return;
    st.lastBubble = st.t;
    while (el.bubbles.children.length >= 10) el.bubbles.firstElementChild.remove();
    const node = document.createElement('div');
    node.className = 'kcap' + (label.length > 1 ? ' wide' : '');
    node.textContent = label;
    node.style.left = `${(at[0] + rand(-3, 3)).toFixed(1)}px`;
    node.style.top = `${at[1].toFixed(1)}px`;
    el.bubbles.appendChild(node);
    node.addEventListener('animationend', () => node.remove());
  }

  function pressNode(node) {
    node.classList.add('down');
    clearTimeout(node.upTimer);
    node.upTimer = setTimeout(() => node.classList.remove('down'), 110);
  }

  // ---------- 动作 ----------
  function onAction(name) {
    if (name === 'type-demo') { st.demoUntil = st.t + 2.8; st.demoIdx = 0; }
    else if (name === 'frenzy') { st.frenzy = !st.frenzy; st.demoUntil = -9; st.acc = 0; }
    else if (name === 'mouse-demo') st.mouseDemoUntil = st.t + 2.8;
    else if (name === 'pat') pat();
    else if (name === 'angry') angry();
  }

  // 视频头像的原声：从头播一遍（带声音），播完自动静音
  function playOriginal() {
    const v = el.headVideo;
    try {
      v.muted = false;
      v.currentTime = 0;
      v.play().catch(() => {});
      const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
      if (dur > 0) {
        st.voiceUntil = st.t + dur;
      } else {
        // 刚换上的视频元数据还没到、拿不到时长：先按 3 秒兜底，时长一到就改按真实时长收尾
        st.voiceUntil = st.t + 3;
        v.addEventListener('loadedmetadata', () => {
          if (st.voiceUntil > 0 && !v.muted && Number.isFinite(v.duration)) st.voiceUntil = st.t + v.duration;
        }, { once: true });
      }
      return true;
    } catch {
      return false;
    }
  }

  function playVoice() {
    if (!el.voice.getAttribute('src')) return false;
    try {
      el.voice.currentTime = 0;
      el.voice.dataset.tried = '1'; // 发起过播放（自测用：没有声卡的环境里 play() 会被拒绝，但功能是通的）
      el.voice.play().catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  function angry() {
    const now = st.t;
    st.lastAngerAt = now;
    st.angryUntil = now + 2.8;
    say(ANGRY_LINE, 2700, 'fire');
    springTailTip.kick(10);
    springSquash.kick(0.1);
    const source = voiceSource(cfg.settings, cfg.meta);
    if (source === 'video') playOriginal();
    else if (source === 'voice') playVoice();
    else sfx.angry();
  }

  function pat(x, y) {
    const now = st.t;
    st.happyUntil = now + 1.1;
    el.headAnim.classList.remove('squish');
    void el.headAnim.offsetWidth;
    el.headAnim.classList.add('squish');
    springSquash.kick(0.5);
    springTailTip.kick(rand(4, 8));
    if (x == null) {
      const r = el.headAnim.getBoundingClientRect();
      x = r.left + r.width * rand(0.25, 0.75);
      y = r.top + r.height * rand(0.1, 0.4);
    }
    spawnHearts(x, y, 4);
    sfx.purr();
    if (now - st.lastMeow > 1.4) {
      st.lastMeow = now;
      sfx.meow();
    }
    if (now - st.lastPatLine > 5 && st.anger < 0.1) {
      st.lastPatLine = now;
      say(PAT_LINES[Math.floor(Math.random() * PAT_LINES.length)], 1300, 'soft');
    }
  }

  let speechTimer = 0;
  function say(text, ms, kind) {
    el.speechText.textContent = text;
    el.speech.classList.toggle('soft', kind === 'soft');
    el.speech.classList.toggle('fire', kind === 'fire');
    el.speech.classList.add('show');
    clearTimeout(speechTimer);
    speechTimer = setTimeout(() => el.speech.classList.remove('show'), ms);
  }

  function spawnHearts(x, y, n) {
    while (el.hearts.children.length >= 24) el.hearts.firstElementChild.remove();
    for (let i = 0; i < n; i++) {
      const holder = document.createElement('div');
      holder.innerHTML = HEART;
      const node = holder.firstElementChild;
      node.style.left = `${(x + rand(-14, 14)).toFixed(1)}px`;
      node.style.top = `${(y + rand(-8, 8)).toFixed(1)}px`;
      node.style.setProperty('--dx', `${rand(-28, 28).toFixed(1)}px`);
      node.style.setProperty('--rot', `${rand(-26, 26).toFixed(1)}deg`);
      node.style.animationDelay = `${(i * 0.06).toFixed(2)}s`;
      el.hearts.appendChild(node);
      node.addEventListener('animationend', () => node.remove());
    }
  }

  // ---------- 指针：敲头 / 摸头 / 拖动 / 点击穿透 ----------
  let press = null;
  let drag = null;
  let ignoring = null;

  function setIgnore(v) {
    if (ignoring !== v) {
      ignoring = v;
      window.pet.setIgnore(v);
    }
  }

  // 透明区域让鼠标穿透到桌面，只有画了东西的地方可交互
  function updateHit(x, y) {
    const node = document.elementFromPoint(x, y);
    setIgnore(!(node && node.closest('#headAnim, [data-drag]')));
  }

  // 用相对位移（movementX/Y）而不是屏幕坐标：窗口跟着鼠标走时坐标不会互相干扰
  function dragMove(e) {
    const dx = clamp(e.movementX || 0, -120, 120);
    const dy = clamp(e.movementY || 0, -120, 120);
    if (!dx && !dy) return;
    drag.dx += dx;
    drag.dy += dy;
    if (!drag.raf) {
      drag.raf = requestAnimationFrame(() => {
        drag.raf = 0;
        window.pet.moveBy(drag.dx, drag.dy);
        drag.dx = 0;
        drag.dy = 0;
      });
    }
  }

  function endDrag() {
    if (drag.raf) cancelAnimationFrame(drag.raf);
    if (drag.dx || drag.dy) window.pet.moveBy(drag.dx, drag.dy);
    drag = null;
    window.pet.dragEnd();
  }

  // 头像拖动：未锁定时按住头像 = 调整头像位置；锁定后 = 摸头
  let headMove = null;
  el.headAnim.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (cfg.settings && !cfg.settings.headLock) {
      headMove = { lx: e.clientX, ly: e.clientY, ox: cfg.offset.x, oy: cfg.offset.y, moved: 0 };
      try { el.headAnim.setPointerCapture(e.pointerId); } catch { /* 不影响 */ }
    } else {
      press = { t: performance.now(), moved: 0, petting: false, sawHeld: false };
    }
    e.preventDefault();
  });

  for (const node of document.querySelectorAll('[data-drag]')) {
    node.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      drag = { dx: 0, dy: 0, raf: 0, sawHeld: false };
      e.preventDefault();
    });
  }

  // 松手：快速点一下脑袋算「敲」，其余情况只收尾
  function release() {
    if (drag) { endDrag(); return; }
    if (!press) return;
    const quick = !press.petting && press.moved < 8;
    press = null;
    st.petTilt = 0;
    if (quick) angry();
  }

  function cancel() {
    if (drag) endDrag();
    press = null;
    st.petTilt = 0;
  }

  window.addEventListener('pointermove', (e) => {
    if (headMove) { // 拖动头像位置（用 clientX/Y 差值，兼容一切输入环境）
      const dx = (e.clientX || 0) - headMove.lx;
      const dy = (e.clientY || 0) - headMove.ly;
      headMove.lx = e.clientX;
      headMove.ly = e.clientY;
      const moved = Math.abs(dx) + Math.abs(dy);
      if (moved) {
        headMove.moved += moved;
        cfg.offset = {
          x: clamp(cfg.offset.x + dx, -110, 110),
          y: clamp(cfg.offset.y + dy, -80, 60),
        };
      }
      return;
    }
    // 没有系统钩子时的兜底：见过「按住」状态后一旦变成没按，就在窗口外松过手
    const holder = drag || press;
    if (holder) {
      if (e.buttons & 1) holder.sawHeld = true;
      else if (holder.sawHeld) { release(); updateHit(e.clientX, e.clientY); return; }
    }
    if (drag) { dragMove(e); return; }
    if (press) {
      press.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
      if (!press.petting && (press.moved > 12 || performance.now() - press.t > 450)) {
        press.petting = true;
        pat(e.clientX, e.clientY);
      }
      if (press.petting) {
        // 摸头时脑袋跟着手的方向歪，爱心跟着手冒
        const r = el.headAnim.getBoundingClientRect();
        st.petTilt = lerp(st.petTilt, clamp((e.clientX - (r.left + r.width / 2)) / 9, -9, 9), 0.3);
        if (st.t - st.lastHeart > 0.1) {
          st.lastHeart = st.t;
          st.happyUntil = st.t + 0.5;
          spawnHearts(e.clientX, e.clientY - 10, 1);
        }
      }
      return;
    }
    updateHit(e.clientX, e.clientY);
  });

  window.addEventListener('pointerup', () => {
    if (headMove) {
      if (headMove.moved > 2) {
        window.pet.saveHeadOffset({ ...cfg.offset }); // 拖完落盘
      } else {
        angry(); // 轻点头像：照常触发台词
      }
      headMove = null;
      return;
    }
    if (drag) { endDrag(); return; }
    release();
  });

  window.addEventListener('pointercancel', cancel);
  window.addEventListener('blur', cancel);

  window.addEventListener('mouseleave', () => setIgnore(true));

  // ---------- 主循环 ----------
  let last = performance.now();
  let lastRender = 0;
  let frames = 0;
  let fpsT = 0;
  let fps = 0;

  function update(dt) {
    const t = st.t;
    const anger = st.anger;
    st.typing = Math.max(0, st.typing - dt * 1.6);
    st.anger = t < st.angryUntil ? Math.min(1, st.anger + dt * 10) : Math.max(0, st.anger - dt * 3);
    st.petTilt = press && press.petting ? st.petTilt : st.petTilt * Math.max(0, 1 - dt * 10);
    if (st.voiceUntil > 0 && t > st.voiceUntil) {
      el.headVideo.muted = true;
      st.voiceUntil = -9;
    }

    // 自动打字：试试打字 / 高速暴走
    const rate = st.frenzy ? 0.055 : (t < st.demoUntil ? 0.13 : 0);
    if (rate) {
      st.acc += dt;
      while (st.acc >= rate) {
        st.acc -= rate;
        const ch = DEMO_KEYS[st.demoIdx % DEMO_KEYS.length];
        st.demoIdx++;
        typeKey({ label: ch.toUpperCase(), name: ch });
      }
    } else {
      st.acc = 0;
    }

    // 真实鼠标一动，小猫就伸爪去抓自己的鼠标
    const reaching = t < st.mouseDemoUntil || t - st.lastMove < 0.5 || t < st.wheelUntil;
    st.reach += ((reaching ? 1 : 0) - st.reach) * (1 - Math.exp(-dt * 10));
    if (reaching && Math.random() < dt * 6) springTailTip.kick(rand(-2, 2)); // 扑鼠标时尾巴也兴奋

    // 爪子：打字时移到对应的键上，停手 0.9 秒回到基准键
    for (const hand of ['L', 'R']) {
      const p = paw[hand];
      const home = pawHome(hand);
      const onKeyNow = t - p.lastKey <= 0.9;
      let tx = onKeyNow ? p.tx : home[0];
      let ty = onKeyNow ? p.ty : home[1];
      const wantReach = hand === 'L' && reaching && t - p.lastKey > 0.35 ? st.reach : 0;
      p.reach += (wantReach - p.reach) * (1 - Math.exp(-dt * 12));
      if (p.reach > 0.001) {
        tx = lerp(tx, PAW.L.mouse[0], p.reach);
        ty = lerp(ty, PAW.L.mouse[1], p.reach);
      }
      const k = 1 - Math.exp(-dt * 34);
      p.x += (tx - p.x) * k;
      p.y += (ty - p.y) * k;
      p.press = Math.max(0, p.press - dt * 14);
    }

    // 闲时小动作（借鉴 KuroCat 的 IdleFidget）：发呆几秒后随机来一个
    const idle = t - st.lastInputAt;
    if (idle > 6 && t > st.happyUntil && Math.random() < dt / 8) st.happyUntil = t + 0.9;
    if (st.fidget && t > st.fidget.until) st.fidget = null;
    if (!st.fidget && idle > 4.5 && Math.random() < dt / 7) {
      const kinds = ['tilt', 'look', 'shift', 'stretch'].concat((cfg.settings ? cfg.settings.headMode : 'photo') === 'cartoon' ? ['ear'] : []);
      const kind = kinds[Math.floor(Math.random() * kinds.length)];
      st.fidget = { kind, t0: t, until: t + { tilt: 1.8, look: 1.6, ear: 1.1, stretch: 2.0, shift: 2.4 }[kind],
        side: Math.random() < 0.5 ? -1 : 1 };
    }
    const fx = st.fx = { lookX: 0, stretchY: 0, shiftX: 0, earWig: 0, tilt: 0 };
    if (st.fidget) {
      const p = clamp((t - st.fidget.t0) / (st.fidget.until - st.fidget.t0), 0, 1);
      const env = Math.sin(p * Math.PI); // 中间饱满、两端归零
      const sd = st.fidget.side;
      if (st.fidget.kind === 'tilt') fx.tilt = sd * 8 * env;
      else if (st.fidget.kind === 'look') fx.lookX = sd * 5 * env;
      else if (st.fidget.kind === 'shift') fx.shiftX = sd * 4 * env;
      else if (st.fidget.kind === 'stretch') { fx.stretchY = -6 * env; fx.tilt = sd * 3 * env; }
      else if (st.fidget.kind === 'ear') fx.earWig = env * Math.sin(p * 26) * 12 * sd;
    }

    // 弹簧步进：头 / 脊柱 / 挤压 / 尾根 / 尾尖 各追各的目标，互不同步
    const speed = 1 + (st.frenzy ? 1.7 : 0) + st.typing * 0.5;
    const happy = t < st.happyUntil ? 1 : 0;
    springHead.x = springHead.step(2.2 * Math.sin(t * 1.4 * speed + 0.5) + st.typing * 1.4 * Math.sin(t * 9)
      + st.petTilt + fx.tilt, dt);
    springSpine.x = springSpine.step(anger * 1.6 * Math.sin(t * 46) + (st.frenzy ? 1.2 * Math.sin(t * 60) : 0) + fx.shiftX, dt);
    springSquash.x = springSquash.step(1 + 0.022 * Math.sin(t * 2.1 - 0.4) + st.typing * 0.012 * Math.sin(t * 23) + happy * 0.02, dt);
    springTail.x = springTail.step(6 * Math.sin(t * 1.5) + anger * 14 * Math.sin(t * 18) + happy * 16 * Math.sin(t * 9)
      + (st.frenzy ? 12 * Math.sin(t * 16) : 0), dt);
    springTailTip.x = springTailTip.step(springTail.x * 0.55 + Math.sin(t * 2.2 - 1.0) * 9
      + anger * 10 * Math.sin(t * 15) + (st.frenzy ? 8 * Math.sin(t * 19) : 0) + happy * 8 * Math.sin(t * 12), dt);

    const angryNow = st.anger > 0.05;
    if (angryNow !== el.body.classList.contains('angry')) el.body.classList.toggle('angry', angryNow);
    const reachNow = st.reach > 0.5;
    if (reachNow !== el.body.classList.contains('reach')) el.body.classList.toggle('reach', reachNow);
    if (st.frenzy !== el.body.classList.contains('frenzy')) el.body.classList.toggle('frenzy', st.frenzy);
  }

  function armPath(arm, from, x, y) {
    const mx = (from[0] + x) / 2;
    const my = Math.max(from[1], y) + 12;
    arm.setAttribute('d', `M${from[0]} ${from[1]} Q${mx.toFixed(1)} ${my.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)}`);
  }

  function render() {
    const t = st.t;
    const typing = st.typing;
    const anger = st.anger;
    const happy = t < st.happyUntil ? 1 : 0;
    const fx = st.fx;

    // 脑袋：悬浮呼吸 + 打字点头 + 生气抖动 + 闲时小动作，角度全部走弹簧
    const hx = anger * 5 * Math.sin(t * 46) + fx.lookX;
    const hy = 2.6 * Math.sin(t * 2.1) + typing * 2.2 * Math.sin(t * 23) + happy * 3 * Math.sin(t * 9) + fx.stretchY;
    el.headAnim.style.left = `${(214 + cfg.offset.x).toFixed(1)}px`;
    el.headAnim.style.top = `${(252 + cfg.offset.y).toFixed(1)}px`;
    el.headAnim.style.transform = `translate(-50%, -100%) translate(${hx.toFixed(2)}px, ${hy.toFixed(2)}px)`
      + ` rotate(${springHead.x.toFixed(2)}deg) scale(${(1 + anger * 0.06).toFixed(3)})`;

    el.torso.style.transform = `translateX(${springSpine.x.toFixed(2)}px) scaleY(${springSquash.x.toFixed(4)})`;

    // 尾巴：整条曲线每帧按两个弹簧角度实时重建（连续无接口）
    if (el.tailColor) {
      const td = ART.tailPathD(springTail.x, springTailTip.x - springTail.x);
      el.tailSil.setAttribute('d', td.d);
      el.tailColor.setAttribute('d', td.d);
      el.tailTipC.setAttribute('d', td.dTip);
    }
    if (el.bell) el.bell.style.transform = `rotate(${(7 * Math.sin(t * 2.1 - 1.3) + typing * 10 * Math.sin(t * 25)).toFixed(2)}deg)`;
    if ((cfg.settings ? cfg.settings.headMode : 'photo') === 'cartoon') {
      const ears = el.cartoon.querySelectorAll('.ear');
      ears.forEach((e, i) => { e.style.transform = `rotate(${(fx.earWig * (i === 0 ? 1 : -1)).toFixed(1)}deg)`; });
    }

    const L = paw.L;
    const R = paw.R;
    const ly = L.y + L.press * 3 + L.reach * 2.5 * Math.sin(t * 34);
    const ry = R.y + R.press * 3;
    el.pawL.setAttribute('transform', `translate(${L.x.toFixed(2)} ${ly.toFixed(2)}) rotate(${(-38 * L.reach).toFixed(1)})`);
    el.pawR.setAttribute('transform', `translate(${R.x.toFixed(2)} ${ry.toFixed(2)})`);
    armPath(el.armLEdge, PAW.L.shoulder, L.x, ly);
    armPath(el.armREdge, PAW.R.shoulder, R.x, ry);
    armPath(el.armL, PAW.L.shoulder, L.x, ly);
    armPath(el.armR, PAW.R.shoulder, R.x, ry);
  }

  function report() {
    window.pet.status({
      fps,
      mode: st.frenzy ? '暴走中' : st.anger > 0.1 ? '生气' : (st.t - st.lastInputAt < 3 || st.t < st.demoUntil) ? '活跃' : '待机',
    });
  }

  function frame(now) {
    // 待机时降到约 30 帧，省电；有动静立刻回到 60
    const busy = st.typing > 0.02 || st.anger > 0 || st.frenzy || st.t < st.happyUntil || st.t - st.lastInputAt < 3
      || st.reach > 0.01 || paw.L.reach > 0.01 || el.bubbles.children.length > 0 || el.hearts.children.length > 0;
    if (!busy && now - lastRender < 30) {
      requestAnimationFrame(frame);
      return;
    }
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    lastRender = now;
    st.t += dt;
    update(dt);
    render();
    frames++;
    fpsT += dt;
    if (fpsT >= 1) {
      fps = Math.round(frames / fpsT);
      frames = 0;
      fpsT = 0;
      report();
    }
    requestAnimationFrame(frame);
  }

  window.addEventListener('error', (e) => console.error('渲染层报错:', e.message));

  window.pet.onSettings(applySettings);
  window.pet.onInput(onInput);
  window.pet.onAction(onAction);
  requestAnimationFrame(frame);
})();
