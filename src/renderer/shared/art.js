/* 程序化 SVG 素材：猫身 / 人偶身 / 猫爪 / 卡通头 / 键盘。
   颜色全部走 CSS 变量（--fur / --collar / --pad ...），换身子只切 body[data-body]。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BXC_ART = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TORSO_PATH = 'M30 114 C 22 74, 42 20, 80 16 C 118 20, 138 74, 130 114 C 108 120, 52 120, 30 114 Z';
  // 尾巴和身子共用 SVG / 贴纸底。两段设计贝塞尔在接点共用竖直切线，始终向上呈 S 形。
  // 所有控制点都在 [16.5,223.5] × [16.5,115.5] 内：凸包性质保证最宽 18 的圆头描边不出界。
  const TAIL_ROOT = [118, 88];

  /**
   * baseDeg / tipDeg 是弹簧摆角（度），不是弧度，也不是绝对朝向。
   * 有限输入钳制到 ±40° / ±70°，非有限输入按静止处理；三角函数只接收转换后的弧度。
   * 返回兼容的 { d, dTip, root }，以及原始 segments，便于真正检查几何而非搜 NaN 字符串。
   */
  function tailPathD(baseDeg = 0, tipDeg = 0) {
    const angle = (value, limit) => Number.isFinite(value) ? Math.min(limit, Math.max(-limit, value)) : 0;
    const rad = (deg) => deg * Math.PI / 180;
    baseDeg = angle(baseDeg, 40);
    tipDeg = angle(tipDeg, 70);
    const b = Math.sin(rad(baseDeg)) / Math.sin(rad(40));
    const t = Math.sin(rad(tipDeg)) / Math.sin(rad(70));
    const join = [178 + 8 * b, 60 + 3 * b + 3 * t];
    const end = [join[0] + 28 + 6 * t, 26 + 4 * t];
    const segments = [
      [TAIL_ROOT.slice(), [148 + 6 * b, 88], [join[0], join[1] + 20], join],
      [join, [join[0], join[1] - 20], [join[0] + 12 + 3 * t, end[1]], end],
    ];
    // de Casteljau 精确截取末段，浅色尾尖直接复用同一曲线的控制点，不重新拟合。
    const mix = (a, c) => a.map((v, i) => v + (c[i] - v) * 0.55);
    const [p0, p1, p2, p3] = segments[1];
    const a = mix(p0, p1), c = mix(p1, p2), e = mix(p2, p3);
    const ac = mix(a, c), ce = mix(c, e);
    const tipSegments = [[mix(ac, ce), ce, e, p3]];
    const point = (p) => `${p[0].toFixed(3)} ${p[1].toFixed(3)}`;
    const toD = (curves) => `M${point(curves[0][0])}`
      + curves.map((s) => ` C ${point(s[1])}, ${point(s[2])}, ${point(s[3])}`).join('');
    return { d: toD(segments), dTip: toD(tipSegments), root: TAIL_ROOT.slice(), segments, tipSegments };
  }

  const BELL = `
<g id="bell">
  <circle cx="80" cy="48" r="8.5" fill="url(#bellGrad)"/>
  <path class="bell-slit" d="M73.5 49 H 86.5"/>
  <circle cx="80" cy="51.5" r="1.8" fill="#b9800a"/>
  <circle cx="76.8" cy="44.6" r="2.2" fill="#fffbe6" opacity=".95"/>
</g>`;

  function torsoMarkup(variant) {
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
<path id="tailSil" class="sil tail-stroke" fill="none" stroke="#fff" stroke-width="16.5" stroke-linecap="round"/>
<path id="tailColor" class="tail-stroke" fill="none" stroke="var(--tail)" stroke-width="15" stroke-linecap="round"/>
<path id="tailTipC" class="tail-stroke" fill="none" stroke="var(--tail-tip)" stroke-width="15" stroke-linecap="round"/>
<!-- 尾巴画在身子前面一层（SVG 后画的在上）：先尾巴后身子，尾巴从身后探出来，不会压在肚子上 -->
<g class="sil"><path d="${TORSO_PATH}" fill="#fff" stroke="#fff" stroke-width="1" stroke-linejoin="round"/></g>
<path d="${TORSO_PATH}" fill="url(#torsoShade)"/>
${['bluewhite', 'orange', 'cream'].includes(variant) ? `<g clip-path="url(#torsoClip)" fill="var(--patch)">
  <path d="M28 114 C 24 72, 40 20, 80 16 C 78 42, 74 70, 72 118 L 28 114 Z"/>
  <path d="M94 17 C 116 22, 132 44, 140 74 C 126 62, 106 46, 94 17 Z"/>
</g>` : ''}
<path class="string" d="M62 36 q -3 8 -2 13"/><path class="string" d="M98 36 q 3 8 2 13"/>
<circle class="aglet" cx="60" cy="50" r="1.8"/><circle class="aglet" cx="100" cy="50" r="1.8"/>
<path class="collar" d="M58 30 Q 80 52 102 30"/>
<path class="collar-hi" d="M62 31 Q 80 48 98 31"/>
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
  <path d="M34 58 L 25 10 Q 24 2 31 6 L 70 30 Z" fill="#fff" stroke="#fff" stroke-width="1" stroke-linejoin="round"/>
  <path d="M126 58 L 135 10 Q 136 2 129 6 L 90 30 Z" fill="#fff" stroke="#fff" stroke-width="1" stroke-linejoin="round"/>
  <circle cx="80" cy="94" r="60" fill="#fff" stroke="#fff" stroke-width="1"/>
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
    if (/^num\d$/.test(name)) return name.slice(3);
    const table = isMac
      ? { backspace: '⌫', tab: '⇥', caps: '⇪', enter: '↵', shift: '⇧', ctrl: '⌃', meta: '⌘', alt: '⌥', fn: 'fn', menu: '☰', esc: 'esc', numlock: 'Num', numadd: '+', numsub: '-', nummul: '*', numdiv: '/', numdot: '.', numenter: '↵' }
      : { backspace: '⌫', tab: 'Tab', caps: 'Caps', enter: 'Enter', shift: 'Shift', ctrl: 'Ctrl', meta: 'Win', alt: 'Alt', fn: 'Fn', menu: '☰', esc: 'Esc', numlock: 'Num', numadd: '+', numsub: '-', nummul: '*', numdiv: '/', numdot: '.', numenter: '↵' };
    return table[name] || name;
  }

  // 固定五排键盘（还原为最初的画法）；小键盘数字、F 键、方向键等不画的键由
  // keys.js 的 fallbackAnchor 兜底到主键区对应位置，爪子照常落键。
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
<rect class="sil" x="1" y="1" width="298" height="108" rx="11" fill="#fff" stroke="#fff" stroke-width="1"/>
<rect class="kb-case" x="1" y="1" width="298" height="108" rx="11"/>
<rect class="kb-plate" x="3.6" y="3.6" width="292.8" height="102.8" rx="8"/>${keys}`;
  }

  return { torsoMarkup, pawMarkup, cartoonHeadMarkup, keyboardSvg, tailPathD };
}));
