/* 控制面板：选项经主进程保存；隐私状态只采用主进程实际报告，不从开关推断。 */
(function () {
  'use strict';
  const api = window.panel;
  const VOICE = window.BXC_VOICE;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const els = {
    hookChip: $('#hookChip'), fpsDot: $('#fpsDot'), fpsVal: $('#fpsVal'), modeVal: $('#modeVal'),
    perm: $('#perm'), permText: $('#permText'), btnPermOpen: $('#btnPermOpen'), btnRetry: $('#btnRetry'), btnPermFix: $('#btnPermFix'),
    btnHeadMode: $('#btnHeadMode'), headName: $('#headName'), btnFrenzy: $('#btnFrenzy'), btnAngryLine: $('#btnAngryLine'),
    headScale: $('#headScale'), headScaleVal: $('#headScaleVal'), petScale: $('#petScale'), petScaleVal: $('#petScaleVal'),
    switchSound: $('#switchSound'), desk: $('#desk'), voiceName: $('#voiceName'), btnClearVoice: $('#btnClearVoice'),
    voiceEaster: $('[data-key="voiceEaster"]'), easterWrap: $('#easterWrap'),
    privacyStatus: $('#privacyStatus'), privacyReason: $('#privacyReason'), privacyCapabilities: $('#privacyCapabilities'),
    toast: $('#toast'),
  };
  const state = { data: null, privacy: null, mode: '启动中', fps: 0, statusAt: 0 };

  function toast(text) {
    els.toast.textContent = text;
    els.toast.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => els.toast.classList.remove('show'), 4200);
  }

  function errorText(error) {
    return String(error && (error.message || error.error) || error || '未知错误');
  }

  // 所有异步 UI 操作（含同步抛错）统一收口，避免未处理的 Promise 拒绝。
  async function run(task) {
    try {
      const result = await task();
      if (result && result.error) throw new Error(errorText(result.error));
      return result;
    } catch (error) {
      if (state.data) render();
      toast(`操作失败：${errorText(error)}`);
      return null;
    }
  }

  function bind(element, event, task) {
    element.addEventListener(event, (e) => run(() => task(e)));
  }

  function accept(payload) {
    if (!payload || !payload.settings || !payload.meta) throw new Error('未收到有效的设置数据');
    if (payload.error) throw new Error(errorText(payload.error));
    state.data = payload;
    if (Object.prototype.hasOwnProperty.call(payload, 'privacy')) state.privacy = payload.privacy;
    render();
  }

  async function set(patch) {
    const payload = await api.set(patch);
    if (payload && payload.error) throw new Error(errorText(payload.error));
    accept(payload);
  }

  function pressed(button, on) {
    button.classList.toggle('on', !!on);
    button.setAttribute('aria-pressed', String(!!on));
  }

  function trustedValue(hook) {
    if (typeof hook.trusted === 'boolean') return hook.trusted;
    return typeof hook.axTrusted === 'boolean' ? hook.axTrusted : null;
  }

  function boolText(value) {
    return value === true ? 'true（是）' : value === false ? 'false（否）' : 'unknown（未知）';
  }

  function renderHook() {
    const { hook = {}, meta } = state.data;
    const mac = meta.isMac;
    const trusted = trustedValue(hook);
    const labels = {
      live: ['键鼠已连接', 'ok'], listening: ['键鼠监听中', 'wait'], idle: ['键鼠监听未启动', 'wait'],
      error: ['键鼠监听启动失败', 'warn'], unavailable: ['原生监听组件不可用', 'warn'],
    };
    let [text, cls] = labels[hook.state] || ['键鼠状态未知', 'warn'];
    if (mac && trusted === false) { text += ' · 待授权'; cls = 'warn'; }
    els.hookChip.hidden = false;
    els.hookChip.className = `chip ${cls}`;
    els.hookChip.textContent = text;
    const messages = [];
    if (hook.state === 'unavailable') messages.push('原生监听组件未能加载，请查看下方实际错误与加载方式；这不等同于未授权。');
    else if (hook.state === 'error') messages.push('键鼠监听启动失败，请结合诊断中的实际错误、加载方式及权限状态排查。');
    else if (!labels[hook.state]) messages.push('尚未取得有效监听状态，可重新检测并查看诊断。');
    if (mac) {
      if (trusted === false) {
        messages.push('辅助功能尚未对本程序生效：系统设置 → 隐私与安全性 → 辅助功能，勾选 Cyberpet。');
        // 开关看着是开的却不生效，几乎都是换版后留下的失效记录（ad-hoc 签名每次更新都不同），照旧勾选救不回来
        messages.push('若开关已经是打开状态：这条记录是旧版本留下的、对新版本无效——先关闭再打开一次；仍不行就选中条目按 − 移除后用 + 重新添加，或点「复制修复命令」在终端执行后重启本应用再勾选。');
      } else if (trusted === null) messages.push('辅助功能授权状态 unknown，当前无法确认是否已授权。');
      messages.push('当前为 ad-hoc 签名，换版后可能需要你在「辅助功能」中重新勾选当前应用，再点「重新检测」。更新不保证免授权，程序不会自动重置系统授权。');
    }
    els.permText.textContent = messages.join(' ');
    els.perm.hidden = !messages.length;
    els.btnPermOpen.hidden = !mac;
    els.btnPermFix.hidden = !(mac && trusted === false);
    // 权限条位于可滚动 main 中，不调用 banner 扩高窗口。
    $('#diagExecPath').textContent = meta.execPath || 'unknown（主进程未提供运行路径）';
    $('#diagInstalled').textContent = boolText(meta.isInstalled);
    $('#diagHookState').textContent = hook.state || 'unknown';
    $('#diagTrusted').textContent = boolText(trusted);
    $('#diagLoadVia').textContent = hook.loadVia || 'unknown（未报告加载方式）';
    $('#diagHookError').textContent = hook.error ? errorText(hook.error) : '未报告错误';
  }

  const CAPABILITY_NAMES = {
    secureInput: '安全输入检测', fullscreen: '全屏检测', fullScreen: '全屏检测',
    recording: '常见录屏软件检测', recordingApps: '常见录屏软件检测',
    contentProtection: '系统内容保护',
  };
  function capabilityText(value) {
    const status = value && typeof value === 'object' ? (value.status ?? value.available) : value;
    if (status === true || status === 'available' || status === 'supported') return '可用';
    if (status === false || status === 'unavailable' || status === 'unsupported') return '不可用';
    return 'unknown（能力不可用或尚未确认）';
  }

  function renderPrivacy() {
    const p = state.privacy;
    const modes = { off: '保护已关闭', normal: '正常显示', shield: '闭眼 · 键盘已遮挡', hidden: '已自动隐藏' };
    const valid = p && Object.prototype.hasOwnProperty.call(modes, p.mode);
    const enabled = p && typeof p.enabled === 'boolean' ? p.enabled : null;
    els.privacyStatus.textContent = valid ? `实际：${modes[p.mode]}` : '实际状态 unknown';
    els.privacyStatus.className = `chip ${!valid ? 'warn' : p.mode === 'shield' || p.mode === 'hidden' ? 'ok' : 'wait'}`;
    const reasons = {
      'secure-input': '检测到系统安全输入', secureInput: '检测到系统安全输入',
      fullscreen: '检测到全屏应用', 'full-screen': '检测到全屏应用',
      recording: '检测到常见录屏软件运行', 'recording-app': '检测到常见录屏软件运行',
      disabled: '自动隐私保护已关闭', normal: '未检测到需保护的场景',
    };
    const reason = p && p.reason ? (reasons[p.reason] || String(p.reason)) : '未报告原因';
    els.privacyReason.textContent = p
      ? `实际保护开关：${boolText(enabled)}；原因：${reason}。`
      : '等待主进程报告；实际保护开关、模式和检测能力均为 unknown，不能确认已保护。';
    const capabilities = p && p.capabilities && typeof p.capabilities === 'object' ? p.capabilities : {};
    const keys = Object.keys(capabilities);
    if (!keys.length) keys.push('secureInput', 'fullscreen', 'recording');
    els.privacyCapabilities.replaceChildren();
    for (const key of keys) {
      const value = capabilities[key];
      const item = document.createElement('li');
      const reason = value && typeof value === 'object' && value.reason ? `；${String(value.reason)}` : '';
      item.textContent = `${CAPABILITY_NAMES[key] || key}：${capabilityText(value)}${reason}`;
      els.privacyCapabilities.appendChild(item);
    }
  }

  function renderStatus() {
    const fresh = Date.now() - state.statusAt < 4000;
    const mode = fresh ? state.mode : '未响应';
    els.fpsVal.textContent = fresh ? `${state.fps} FPS` : '-- FPS';
    els.modeVal.textContent = mode;
    els.fpsDot.style.background = { 暴走中: '#2f6fe0', 暴躁: '#ff8c00', 生气: '#ff5a3c', 活跃: '#22c55e', 待机: '#b5bccd' }[mode] || '#b5bccd';
    pressed(els.btnFrenzy, mode === '暴走中');
  }

  function render() {
    const d = state.data;
    if (!d) return;
    const s = d.settings;
    const r = VOICE.resolve({ headMode: s.headMode, headType: d.meta.headType, voiceEaster: s.voiceEaster, hasVoice: !!d.meta.voiceSrc });
    for (const b of $$('[data-body]')) pressed(b, b.dataset.body === s.body);
    for (const b of $$('[data-kb-dir]')) pressed(b, b.dataset.kbDir === (s.kbDir || 'reverse'));
    pressed(els.btnHeadMode, s.headMode === 'photo');
    pressed(els.btnAngryLine, s.angryLine === true);
    const kind = s.headMode === 'cartoon' ? 'Q 版猫头' : d.meta.headType === 'video' ? '视频' : '图片';
    els.headName.textContent = s.headMode === 'cartoon' ? `当前：${kind}` : `当前：${d.meta.headName || '默认头像'}（${kind}）`;
    els.headName.title = els.headName.textContent;
    els.headScale.value = s.headScale;
    els.headScaleVal.textContent = `${Math.round(s.headScale * 100)}%`;
    els.petScale.value = s.petScale;
    els.petScaleVal.textContent = `${Math.round(s.petScale * 100)}%`;
    for (const c of $$('[data-key]')) c.checked = !!s[c.dataset.key];
    els.voiceEaster.disabled = !r.easterEnabled;
    els.easterWrap.classList.toggle('off', !r.easterEnabled);
    els.voiceEaster.title = r.easterEnabled ? VOICE.EASTER_TITLE.video
      : (s.headMode === 'cartoon' ? VOICE.EASTER_TITLE.cartoon : VOICE.EASTER_TITLE.image);
    els.easterWrap.title = els.voiceEaster.title;
    els.switchSound.disabled = !s.keySfx;
    els.switchSound.title = s.keySfx ? '' : '先勾选「键盘音效」才会出声';
    els.switchSound.value = s.switchSound;
    els.desk.value = s.desk;
    els.voiceName.textContent = r.source === 'video' ? '视频原声' : (d.meta.voiceName || '合成音效');
    els.voiceName.title = r.source === 'video'
      ? '触发时播放视频原声；关闭原声彩蛋后使用导入配音或合成音效'
      : (d.meta.voiceName ? `触发时播放：${d.meta.voiceName}` : '触发时使用合成音效；可导入自己的音频');
    els.btnClearVoice.hidden = !d.meta.voiceName;
    // 作者信息始终隐藏，不渲染主进程可能携带的名字、头像或链接。
    $('#aboutRow').hidden = true;
    $('#aboutText').textContent = '';
    renderHook();
    renderPrivacy();
    renderStatus();
  }

  async function applyResult(request, okText) {
    const payload = await request();
    if (payload === null) return; // 选择媒体时取消是正常结果。
    if (payload && payload.error) throw new Error(errorText(payload.error));
    accept(payload);
    toast(okText(payload));
  }

  for (const b of $$('[data-body]')) bind(b, 'click', () => set({ body: b.dataset.body }));
  for (const b of $$('[data-kb-dir]')) bind(b, 'click', () => set({ kbDir: b.dataset.kbDir }));
  for (const b of $$('[data-act]')) bind(b, 'click', () => api.action(b.dataset.act));
  bind(els.btnFrenzy, 'click', () => api.action('frenzy'));
  bind(els.btnAngryLine, 'click', () => set({ angryLine: state.data.settings.angryLine !== true }));
  bind(els.btnHeadMode, 'click', () => set({ headMode: state.data.settings.headMode === 'photo' ? 'cartoon' : 'photo' }));
  bind($('#btnPickHead'), 'click', () => applyResult(() => api.pickHead(), (d) => `已换成图片头像：${d.meta.headName}`));
  bind($('#btnPickHeadVideo'), 'click', () => applyResult(() => api.pickHeadVideo(), (d) => `已换成视频头像：${d.meta.headName}`));
  bind($('#btnResetHead'), 'click', () => applyResult(() => api.resetHead(), () => '已还原为默认头像'));
  bind($('#btnResetHeadPos'), 'click', async () => { await set({ headOffset: null }); toast('头像位置已归位'); });
  for (const c of $$('[data-key]')) bind(c, 'change', () => set({ [c.dataset.key]: c.checked }));
  bind(els.switchSound, 'change', () => set({ switchSound: els.switchSound.value }));
  bind(els.desk, 'change', () => set({ desk: els.desk.value }));
  for (const [input, label, key] of [[els.headScale, els.headScaleVal, 'headScale'], [els.petScale, els.petScaleVal, 'petScale']]) {
    bind(input, 'input', async () => {
      const value = Number(input.value);
      label.textContent = `${Math.round(value * 100)}%`;
      await set({ [key]: value });
    });
  }
  bind($('#btnPickVoice'), 'click', () => applyResult(() => api.pickVoice(), (d) => `已导入配音：${d.meta.voiceName}`));
  bind(els.btnClearVoice, 'click', () => applyResult(() => api.clearVoice(), () => '已清除导入的配音'));
  bind(els.btnRetry, 'click', async () => {
    const result = await api.retryHook();
    // retryHook 返回的 hook.error 是诊断数据，不是 IPC 调用失败；仍须刷新并展示。
    if (result && result.error && !result.state) throw new Error(errorText(result.error));
    accept(await api.get());
  });
  bind(els.btnPermOpen, 'click', () => api.openPermissionSettings());
  bind(els.btnPermFix, 'click', async () => {
    await api.copyPermissionFix();
    toast('已复制 tccutil 重置命令：粘贴到「终端」回车执行，然后重启 Cyberpet 并重新勾选授权');
  });
  bind($('#btnCollapse'), 'click', () => api.collapse());
  bind(document, 'keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      return applyResult(() => api.pasteHead(), (d) => `已贴成头像：${d.meta.headName}`);
    }
  });

  api.onSettings((payload) => { if (payload) run(() => accept(payload)); });
  api.onStatus((s) => {
    if (!s) return;
    state.mode = s.mode;
    state.fps = s.fps;
    state.statusAt = Date.now();
    renderStatus();
  });
  if (typeof api.onPrivacy === 'function') {
    api.onPrivacy((privacy) => {
      state.privacy = privacy && Object.prototype.hasOwnProperty.call(privacy, 'privacy') ? privacy.privacy : privacy;
      renderPrivacy();
    });
  }
  run(async () => accept(await api.get()));
})();
