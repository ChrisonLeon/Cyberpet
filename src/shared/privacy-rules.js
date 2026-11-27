/* 隐私策略只接受 API 布尔结论；未知不是「没有风险」。主进程与测试共用。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BXC_PRIVACY = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CAPABILITY_KEYS = Object.freeze([
    'secureInput', 'accessibility', 'sensitive', 'fullscreen', 'recorder', 'recorderRunningOnly',
  ]);
  const MODE_RANK = Object.freeze({ off: 0, normal: 1, shield: 2, hidden: 3 });

  function emptyCapabilities() {
    return Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, false]));
  }

  // 严格校验必要字段、只拷贝白名单。任何额外字符串（包括诊断、标题）不会流向 UI。
  function normalizeProbe(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    for (const key of ['sensitive', 'fullscreen', 'recorder']) {
      if (value[key] !== null && typeof value[key] !== 'boolean') return null;
    }
    if (typeof value.trusted !== 'boolean') return null;
    if (!value.capabilities || typeof value.capabilities !== 'object' || Array.isArray(value.capabilities)) return null;
    const capabilities = emptyCapabilities();
    for (const key of CAPABILITY_KEYS) {
      if (Object.hasOwn(value.capabilities, key)) {
        if (typeof value.capabilities[key] !== 'boolean') return null;
        capabilities[key] = value.capabilities[key];
      }
    }
    return {
      sensitive: value.sensitive, fullscreen: value.fullscreen, recorder: value.recorder,
      trusted: value.trusted, capabilities,
    };
  }

  function resolve({ enabled = false, raw = null, failure = '' } = {}) {
    if (!enabled) return { mode: 'off', reason: 'disabled' };
    if (failure) return { mode: 'shield', reason: failure };
    const probe = normalizeProbe(raw);
    if (!probe) return { mode: 'shield', reason: 'probe-unknown' };
    // 正结论始终优先；即使另一项检测失败，已知录屏或全屏也不能降为普通遮罩。
    if (probe.recorder === true) return { mode: 'hidden', reason: 'recorder-running' };
    if (probe.fullscreen === true) return { mode: 'hidden', reason: 'fullscreen' };
    if (probe.sensitive === true) return { mode: 'shield', reason: 'sensitive-input' };
    if (!probe.trusted) return { mode: 'shield', reason: 'accessibility-unavailable' };
    if (probe.sensitive === null || !probe.capabilities.sensitive) return { mode: 'shield', reason: 'sensitive-unknown' };
    if (probe.fullscreen === null || !probe.capabilities.fullscreen) return { mode: 'shield', reason: 'fullscreen-unknown' };
    if (probe.recorder === null || !probe.capabilities.recorder) return { mode: 'shield', reason: 'recorder-unknown' };
    return { mode: 'normal', reason: 'clear' };
  }

  return { CAPABILITY_KEYS, MODE_RANK, emptyCapabilities, normalizeProbe, resolve };
}));
