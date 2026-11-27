/* 控制面板：所有改动都经主进程落盘，再广播给桌宠窗口。 */
(function () {
  'use strict';
  const api = window.panel;
  const VOICE = window.BXC_VOICE;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const els = {
    hookChip: $('#hookChip'), fpsChip: $('#fpsChip'), fpsDot: $('#fpsDot'), fpsVal: $('#fpsVal'), modeVal: $('#modeVal'),
    perm: $('#perm'), permText: $('#permText'), btnPermOpen: $('#btnPermOpen'), btnRetry: $('#btnRetry'),
    btnHeadMode: $('#btnHeadMode'), headName: $('#headName'), btnFrenzy: $('#btnFrenzy'),
    headScale: $('#headScale'), headScaleVal: $('#headScaleVal'),
    petScale: $('#petScale'), petScaleVal: $('#petScaleVal'),
    switchSound: $('#switchSound'), desk: $('#desk'), voiceName: $('#voiceName'), btnClearVoice: $('#btnClearVoice'),
    voiceEaster: $('[data-key="voiceEaster"]'), easterWrap: $('#easterWrap'),
    aboutText: $('#aboutText'), toast: $('#toast'),
  };
  const state = { data: null, mode: '启动中', fps: 0, statusAt: 0 };
  let logLoadVia = '';

  function toast(text) {
    els.toast.textContent = text;
    els.toast.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => els.toast.classList.remove('show'), 2600);
  }

  async function set(patch) {
    state.data = await api.set(patch);
    render();
  }

  // 头像 × 原声彩蛋 × 导入配音 的联动规则（与桌宠共用同一份）
  function rules(d) {
    return VOICE.resolve({
      headMode: d.settings.headMode, headType: d.meta.headType, voiceEaster: d.settings.voiceEaster, hasVoice: !!d.meta.voiceSrc,
    });
  }

  function renderHook() {
    const { hook, meta } = state.data;
    const mac = meta.isMac;
    const appName = meta.dev ? 'Electron' : 'Cyberpet';
    let text = '';
    let cls = 'chip';
    let banner = '';
    if (hook.state === 'live') {
      text = '✓ 键鼠已连接';
      cls += ' ok';
    } else if (hook.state === 'listening') {
      text = mac && !hook.axTrusted ? '● 等待授权「辅助功能」' : '● 监听中';
      cls += mac && !hook.axTrusted ? ' warn' : ' wait';
      if (mac && !hook.axTrusted) {
        banner = `macOS 需要授权「辅助功能」才能响应你的键盘鼠标：系统设置 → 隐私与安全性 → 辅助功能 → 打开「${appName}」。如果它已经开着，关一下再打开即可，程序会自动连上。`;
      }
    } else if (hook.state === 'error') {
      text = '⚠ 键鼠监听未启用';
      cls += ' warn';
      banner = mac
        ? `键鼠监听没能启动，通常是还没授权：系统设置 → 隐私与安全性 → 辅助功能 → 打开「${appName}」（已经开着就关一下再打开），然后点「重新检测」。`
        : `键鼠监听启动失败：${hook.error || '未知错误'}`;
    } else {
      text = '⚠ 原生监听组件加载失败';
      cls += ' warn';
      banner = `键鼠监听组件没能加载${hook.error ? `（${hook.error}）` : ''}。请换一个安装包重装（例如 setup.exe / portable.exe 各试一次）；杀毒软件拦截 .node 文件也会导致这个问题。面板和「试试打字」等按钮仍可使用。`;
      logLoadVia = hook.loadVia || '';
    }
    els.hookChip.hidden = false;
    els.hookChip.className = cls;
    els.hookChip.textContent = text;
    els.permText.textContent = banner;
    const showBanner = !!banner;
    if (els.perm.hidden === showBanner) api.banner(showBanner);
    els.perm.hidden = !showBanner;
    els.btnPermOpen.hidden = !mac;
  }

  function renderStatus() {
    const fresh = Date.now() - state.statusAt < 4000;
    const mode = fresh ? state.mode : '未响应';
    els.fpsVal.textContent = fresh ? `${state.fps} FPS` : '-- FPS';
    els.modeVal.textContent = mode;
    els.fpsDot.style.background = { 暴走中: '#2f6fe0', 暴躁: '#ff8c00', 生气: '#ff5a3c', 活跃: '#22c55e', 待机: '#b5bccd' }[mode] || '#b5bccd';
    els.btnFrenzy.classList.toggle('on', mode === '暴走中');
  }

  function render() {
    const d = state.data;
    if (!d) return;
    const s = d.settings;
    const r = rules(d);
    for (const b of $$('[data-body]')) b.classList.toggle('on', b.dataset.body === s.body);
    els.btnHeadMode.classList.toggle('on', s.headMode === 'photo');
    const kind = s.headMode === 'cartoon' ? 'Q 版猫头' : d.meta.headType === 'video' ? '视频' : '图片';
    els.headName.textContent = `当前：${s.headMode === 'cartoon' ? kind : `${d.meta.headName}（${kind}）`}`;
    els.headName.title = els.headName.textContent;
    els.headScale.value = s.headScale;
    els.headScaleVal.textContent = `${Math.round(s.headScale * 100)}%`;
    els.petScale.value = s.petScale;
    els.petScaleVal.textContent = `${Math.round(s.petScale * 100)}%`;
    for (const c of $$('[data-key]')) c.checked = !!s[c.dataset.key];

    // 「原声彩蛋」只对视频头像可用；图片 / Q 版猫头时置灰
    els.voiceEaster.disabled = !r.easterEnabled;
    els.easterWrap.classList.toggle('off', !r.easterEnabled);
    els.voiceEaster.title = r.easterEnabled ? VOICE.EASTER_TITLE.video
      : (s.headMode === 'cartoon' ? VOICE.EASTER_TITLE.cartoon : VOICE.EASTER_TITLE.image);

    // 轴体音色只在「键盘音效」开着时才有意义
    els.switchSound.disabled = !s.keySfx;
    els.switchSound.title = s.keySfx ? '' : '先勾选「键盘音效」才会出声';
    els.switchSound.value = s.switchSound;
    els.desk.value = s.desk;

    // 现在到底会播哪一种配音
    els.voiceName.textContent = r.source === 'video' ? '视频原声' : (d.meta.voiceName || '未导入');
    els.voiceName.title = r.source === 'video'
      ? '触发时播放视频自带的原声' + (d.meta.voiceName ? '；取消「原声彩蛋」后会改播导入的配音' : '')
      : (d.meta.voiceName ? `触发时播放：${d.meta.voiceName}` : '触发时用合成的低吼声；可以「导入配音」换成你自己的音频');
    els.btnClearVoice.hidden = !d.meta.voiceName;
    renderHook();
    renderStatus();
  }

  // 选完文件立刻生效，并明确告诉用户换成了什么
  async function applyResult(request, okText) {
    const d = await request();
    if (!d) return;
    if (d.error) { toast(d.error); return; }
    state.data = d;
    render();
    toast(okText(d));
  }

  // ---------- 事件 ----------
  for (const b of $$('[data-body]')) b.addEventListener('click', () => set({ body: b.dataset.body }));
  for (const b of $$('[data-act]')) b.addEventListener('click', () => api.action(b.dataset.act));
  els.btnFrenzy.addEventListener('click', () => api.action('frenzy'));
  els.btnHeadMode.addEventListener('click', () => set({ headMode: state.data.settings.headMode === 'photo' ? 'cartoon' : 'photo' }));
  $('#btnPickHead').addEventListener('click', () => applyResult(() => api.pickHead(), (d) => `已换成图片头像：${d.meta.headName}`));
  $('#btnPickHeadVideo').addEventListener('click', () => applyResult(() => api.pickHeadVideo(), (d) => `已换成视频头像：${d.meta.headName}`));
  $('#btnResetHead').addEventListener('click', () => applyResult(() => api.resetHead(), () => '已还原为默认头像'));
  $('#btnResetHeadPos').addEventListener('click', () => set({ headOffset: null }).then(() => toast('头像位置已归位')));
  for (const c of $$('[data-key]')) c.addEventListener('change', () => set({ [c.dataset.key]: c.checked }));
  els.switchSound.addEventListener('change', () => set({ switchSound: els.switchSound.value }));
  els.desk.addEventListener('change', () => set({ desk: els.desk.value }));
  els.headScale.addEventListener('input', () => {
    els.headScaleVal.textContent = `${Math.round(els.headScale.value * 100)}%`;
    api.set({ headScale: Number(els.headScale.value) }).then((d) => { if (d) state.data = d; });
  });
  els.petScale.addEventListener('input', () => {
    els.petScaleVal.textContent = `${Math.round(els.petScale.value * 100)}%`;
    api.set({ petScale: Number(els.petScale.value) }).then((d) => { if (d) state.data = d; });
  });
  $('#btnPickVoice').addEventListener('click', () => applyResult(() => api.pickVoice(), (d) => `已导入配音：${d.meta.voiceName}`));
  els.btnClearVoice.addEventListener('click', () => applyResult(() => api.clearVoice(), () => '已清除导入的配音'));
  els.btnRetry.addEventListener('click', async () => {
    await api.retryHook();
    state.data = await api.get();
    render();
  });
  els.btnPermOpen.addEventListener('click', () => api.openPermissionSettings());
  $('#btnCollapse').addEventListener('click', () => api.collapse());
  // ⌘V / Ctrl+V：剪贴板里有图就直接贴成脑袋
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      applyResult(() => api.pasteHead(), (d) => `已贴成头像：${d.meta.headName}`);
    }
  });

  // 作者信息：渲染成可点的链接
  function renderAbout(author) {
    els.aboutRow.hidden = author ? false : true;
    if (!author) { els.aboutText.textContent = ''; return; }
    const parts = [];
    if (author.name) parts.push(`<b>${author.name}</b>`);
    if (author.douyinId) parts.push(`<a href="#" data-url="${author.douyin}">抖音 @${author.douyinId}</a>`);
    if (author.site) parts.push(`<a href="#" data-url="${author.site}">粉丝站</a>`);
    if (author.github) parts.push(`<a href="#" data-url="${author.github}">GitHub</a>`);
    if (author.gitee) parts.push(`<a href="#" data-url="${author.gitee}">Gitee</a>`);
    els.aboutText.innerHTML = parts.join(' · ');
    for (const a of els.aboutText.querySelectorAll('a')) {
      a.addEventListener('click', (ev) => { ev.preventDefault(); api.openUrl(a.dataset.url); });
    }
  }

  api.onSettings((payload) => {
    if (!payload) return;
    state.data = payload;
    render();
    if (payload.meta.author) renderAbout(payload.meta.author);
  });
  api.onStatus((s) => {
    if (!s) return;
    state.mode = s.mode;
    state.fps = s.fps;
    state.statusAt = Date.now();
    renderStatus();
  });

  api.get().then((payload) => {
    state.data = payload;
    render();
    if (payload && payload.meta.author) renderAbout(payload.meta.author);
  });
})();
