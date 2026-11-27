/* 程序化 SVG 素材：猫身 / 人偶身 / 猫爪 / 卡通头 / 键盘。
   颜色全部走 CSS 变量（--fur / --collar / --pad ...），换身子只切 body[data-body]。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BXC_ART = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TORSO_PATH = 'M14 114 C 4 70, 26 18, 80 14 C 134 18, 156 70, 146 114 C 122 122, 38 122, 14 114 Z';
  const DOLL_PATH = 'M34 118 L 34 54 C 34 30, 52 18, 80 18 C 108 18, 126 30, 126 54 L 126 118 Z';
  // 尾巴和身子画在同一张 SVG 里、共用一层白色贴纸底，接口处才不会断开。
  // S 形：从身子右下伸出，先向右再扬起，末端向右勾。坐标是身子的 viewBox 单位。
  // 尾巴：单一连续曲线，每帧按两个弹簧角度实时重建路径——
  // 没有两段刚体的接缝，任何角度组合下轮廓都是平滑的。
  // 几何（torso viewBox 坐标）：尾根 (126,98)，静止方向 角度（度），段长
  const TAIL_ROOT = [118, 88];  // 装在背部，远离键盘（键盘上沿在 stage y≈318）
  const TAIL_REST = { base: -26, tip: -74 }; // 静止方向：向右上扬再折向竖直，呈 S 形
  const TAIL_LEN = { base: 60, tip: 50 };

  function smooth01(x) {
    const t = Math.min(1, Math.max(0, x));
    return t * t * (3 - 2 * t);
  }

  /**
   * 计算尾巴路径。baseDeg / tipDeg 分别是尾根段、尾尖段相对静止方向的摆角（度）。
   * 返回 { d, dTip }：d 是整条尾巴的中心线（Catmull-Rom 转贝塞尔），dTip 是最后
   * 一小段（双色尾巴的浅色尾尖，和 d 共用同一几何，所以接口处永远平滑）。
   */
  function tailPathD(baseDeg, tipDeg) {
    const rad = (deg) => (deg * Math.PI) / 180;
    // 输入钳制（双保险）：无论调用方传多大，几何永远在安全范围内、永远平滑
    baseDeg = Math.min(40, Math.max(-40, baseDeg));
    tipDeg = Math.min(70, Math.max(-70, tipDeg));
    const a1 = TAIL_REST.base + rad(baseDeg);
    const a2 = TAIL_REST.tip + rad(baseDeg + tipDeg);
    const pts = [];
    const N = 10;
    for (let i = 0; i <= N; i++) {
      const s = i / N;
      const bend = smooth01((s - 0.42) / 0.16); // 只在关节附近过渡两种角度，两端保持纯方向
      const ang = a1 + (a2 - a1) * bend;
      const len = s <= 0.5 ? TAIL_LEN.base * (s / 0.5) : TAIL_LEN.base + TAIL_LEN.tip * ((s - 0.5) / 0.5);
      pts.push([TAIL_ROOT[0] + Math.cos(ang) * len, TAIL_ROOT[1] + Math.sin(ang) * len]);
    }
    const toD = (list) => {
      let out = `M${list[0][0].toFixed(1)} ${list[0][1].toFixed(1)}`;
      for (let i = 0; i < list.length - 1; i++) {
        const p0 = list[Math.max(0, i - 1)], p1 = list[i], p2 = list[i + 1], p3 = list[Math.min(list.length - 1, i + 2)];
        const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
        const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
        out += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
      }
      return out;
    };
    return { d: toD(pts), dTip: toD(pts.slice(-4)), root: TAIL_ROOT };
  }

  const BELL = `
<g id="bell">
  <circle cx="80" cy="56" r="8.5" fill="url(#bellGrad)"/>
  <path class="bell-slit" d="M73.5 57 H 86.5"/>
  <circle cx="80" cy="59.5" r="1.8" fill="#b9800a"/>
  <circle cx="76.8" cy="52.6" r="2.2" fill="#fffbe6" opacity=".95"/>
</g>`;

  function torsoMarkup(variant) {
    if (variant === 'doll') {
      return `
<defs>
  <linearGradient id="torsoShade" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="var(--fur-hi)"/><stop offset="1" stop-color="var(--fur)"/>
  </linearGradient>
</defs>
<g class="sil"><path d="${DOLL_PATH}" fill="#fff" stroke="#fff" stroke-width="6" stroke-linejoin="round"/></g>
<path d="${DOLL_PATH}" fill="url(#torsoShade)"/>
<path class="hood" d="M46 44 Q 80 14 114 44 Q 80 31 46 44 Z"/>
<path class="pocket" d="M58 70 Q 80 63 102 70 L 100 96 Q 80 100 60 96 Z"/>
<path class="string" d="M68 42 q -2 9 -1 15"/><path class="string" d="M92 42 q 2 9 1 15"/>
<circle class="aglet" cx="67" cy="58" r="1.8"/><circle class="aglet" cx="93" cy="58" r="1.8"/>`;
    }
    return `
<defs>
  <radialGradient id="torsoShade" cx="38%" cy="26%" r="95%">
    <stop offset="0" stop-color="var(--fur-hi)"/><stop offset="1" stop-color="var(--fur)"/>
  </radialGradient>
  <radialGradient id="bellGrad" cx="35%" cy="30%" r="80%">
    <stop offset="0" stop-color="#fff6c2"/><stop offset=".55" stop-color="#ffd23f"/><stop offset="1" stop-color="#df9600"/>
  </radialGradient>
  <clipPath id="torsoClip"><path d="${TORSO_PATH}"/></clipPath>
</defs>
<path id="tailSil" class="sil tail-stroke" fill="none" stroke="#fff" stroke-width="33" stroke-linecap="round"/>
<g class="sil"><path d="${TORSO_PATH}" fill="#fff" stroke="#fff" stroke-width="6" stroke-linejoin="round"/></g>
<path d="${TORSO_PATH}" fill="url(#torsoShade)"/>
<path id="tailColor" class="tail-stroke" fill="none" stroke="var(--tail)" stroke-width="27" stroke-linecap="round"/>
<path id="tailTipC" class="tail-stroke" fill="none" stroke="var(--tail-tip)" stroke-width="27" stroke-linecap="round"/>
${['bluewhite', 'orange', 'cream'].includes(variant) ? `<g clip-path="url(#torsoClip)" fill="var(--patch)">
  <path d="M14 114 C 4 70, 26 18, 80 14 C 76 46, 68 74, 64 120 L 14 114 Z"/>
  <path d="M96 15 C 124 20, 146 46, 152 80 C 132 66, 108 46, 96 15 Z"/>
</g>` : ''}
<path class="string" d="M58 44 q -3 8 -2 14"/><path class="string" d="M102 44 q 3 8 2 14"/>
<circle class="aglet" cx="56" cy="59" r="1.8"/><circle class="aglet" cx="104" cy="59" r="1.8"/>
<path class="collar" d="M44 36 Q 80 60 116 36"/>
<path class="collar-hi" d="M48 37 Q 80 56 112 37"/>
${BELL}`;
  }

  // 参考视频里的爪子：与身子同色的圆爪，靠上有一小排粉色豆豆（没有大掌垫）
  function pawMarkup() {
    return `
<path class="paw-body" d="M-16 5 C -18 -5, -10 -13, 0 -13 C 10 -13, 18 -5, 16 5 C 14 12, 7 15, 0 15 C -7 15, -14 12, -16 5 Z"/>
<circle class="bean" cx="-9.5" cy="-4.5" r="2.1"/>
<circle class="bean" cx="-3.3" cy="-6.8" r="2.1"/>
<circle class="bean" cx="3.3" cy="-6.8" r="2.1"/>
<circle class="bean" cx="9.5" cy="-4.5" r="2.1"/>`;
  }

  function cartoonHeadMarkup() {
    const eye = (cx) => `
<g class="eye">
  <ellipse class="iris" cx="${cx}" cy="92" rx="9.5" ry="11.5"/>
  <ellipse class="pupil" cx="${cx}" cy="93" rx="4" ry="8.5"/>
  <circle class="glint" cx="${cx + 3}" cy="87" r="2.8"/><circle class="glint" cx="${cx - 2.5}" cy="96" r="1.3"/>
</g>`;
    return `
<g class="sil">
  <path d="M34 58 L 25 10 Q 24 2 31 6 L 70 30 Z" fill="#fff" stroke="#fff" stroke-width="6" stroke-linejoin="round"/>
  <path d="M126 58 L 135 10 Q 136 2 129 6 L 90 30 Z" fill="#fff" stroke="#fff" stroke-width="6" stroke-linejoin="round"/>
  <circle cx="80" cy="94" r="60" fill="#fff" stroke="#fff" stroke-width="6"/>
</g>
<path class="ear" d="M34 58 L 25 10 Q 24 2 31 6 L 70 30 Z"/>
<path class="ear" d="M126 58 L 135 10 Q 136 2 129 6 L 90 30 Z"/>
<path class="ear-in" d="M36 46 L 32 18 L 54 31 Z"/>
<path class="ear-in" d="M124 46 L 128 18 L 106 31 Z"/>
<circle class="face" cx="80" cy="94" r="60"/>
<path class="patch" d="M22 80 C 26 52, 44 36, 64 34 C 76 52, 72 76, 52 84 C 40 88, 30 86, 22 80 Z"/>
${eye(57)}${eye(103)}
<ellipse class="blush" cx="40" cy="108" rx="7" ry="4"/><ellipse class="blush" cx="120" cy="108" rx="7" ry="4"/>
<path class="nose" d="M75.5 103.5 L 84.5 103.5 L 80 108.5 Z"/>
<path class="mouth" d="M80 108.5 Q 80 115 73 115 M 80 108.5 Q 80 115 87 115"/>
<path class="whisk" d="M16 96 L 40 98 M 18 108 L 41 105"/><path class="whisk" d="M144 96 L 120 98 M 142 108 L 119 105"/>`;
  }

  const ROWS = [
    [['`', 1], ['1', 1], ['2', 1], ['3', 1], ['4', 1], ['5', 1], ['6', 1], ['7', 1], ['8', 1], ['9', 1], ['0', 1], ['-', 1], ['=', 1], ['backspace', 2]],
    [['tab', 1.5], ['q', 1], ['w', 1], ['e', 1], ['r', 1], ['t', 1], ['y', 1], ['u', 1], ['i', 1], ['o', 1], ['p', 1], ['[', 1], [']', 1], ['\\', 1.5]],
    [['caps', 1.75], ['a', 1], ['s', 1], ['d', 1], ['f', 1], ['g', 1], ['h', 1], ['j', 1], ['k', 1], ['l', 1], [';', 1], ["'", 1], ['enter', 2.25]],
    [['shift', 2.25], ['z', 1], ['x', 1], ['c', 1], ['v', 1], ['b', 1], ['n', 1], ['m', 1], [',', 1], ['.', 1], ['/', 1], ['shift', 2.75]],
    [['ctrl', 1.25], ['meta', 1.25], ['alt', 1.25], ['space', 6.25], ['alt', 1.25], ['fn', 1.25], ['menu', 1.25], ['ctrl', 1.25]],
  ];
  const MODIFIERS = new Set(['backspace', 'tab', 'caps', 'enter', 'shift', 'ctrl', 'meta', 'alt']);

  function capLabel(name, isMac) {
    if (/^[a-z]$/.test(name)) return name.toUpperCase();
    const table = isMac
      ? { backspace: '⌫', tab: '⇥', caps: '⇪', enter: '↵', shift: '⇧', ctrl: '⌃', meta: '⌘', alt: '⌥', fn: 'fn', menu: '☰' }
      : { backspace: '⌫', tab: 'Tab', caps: 'Caps', enter: 'Enter', shift: 'Shift', ctrl: 'Ctrl', meta: 'Win', alt: 'Alt', fn: 'Fn', menu: '☰' };
    return table[name] || name;
  }

  function keyboardSvg(isMac) {
    const U = 19.4;
    const GAP = 1.7;
    const H = 17.7;
    let keys = '';
    ROWS.forEach((row, r) => {
      let x = 5;
      const y = 5 + r * U;
      row.forEach(([name, units]) => {
        const w = units * U - GAP;
        const cls = name === 'space' ? ' key soft' : MODIFIERS.has(name) ? ' key accent' : ' key';
        const label = name === 'space' ? '' : capLabel(name, isMac);
        const font = label.length > 1 ? 5.6 : 6.6;
        keys += `<g class="${cls.trim()}" data-k="${name.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`
          + `<rect class="side" x="${x.toFixed(2)}" y="${(y + 2.1).toFixed(2)}" width="${w.toFixed(2)}" height="${H}" rx="3.4"/>`
          + `<rect class="cap" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${H}" rx="3.4"/>`
          + (label ? `<text x="${(x + w / 2).toFixed(2)}" y="${(y + H / 2 + font * 0.36).toFixed(2)}" font-size="${font}">${label.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>` : '')
          + '</g>';
        x += units * U;
      });
    });
    return `
<rect class="sil" x="1" y="1" width="298" height="108" rx="11" fill="#fff" stroke="#fff" stroke-width="6"/>
<rect class="kb-case" x="1" y="1" width="298" height="108" rx="11"/>
<rect class="kb-plate" x="3.6" y="3.6" width="292.8" height="102.8" rx="8"/>${keys}`;
  }

  return { torsoMarkup, pawMarkup, cartoonHeadMarkup, keyboardSvg, tailPathD };
}));
