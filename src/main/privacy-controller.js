'use strict';
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const rules = require('../shared/privacy-rules');

const MAX_LINE_BYTES = 4096;
const MAX_CHUNK_BYTES = 65536;
const RETRY_DELAYS = Object.freeze([250, 500, 1000, 2000, 5000, 10000]);

// 不搜索 PATH，不执行 shell，不接受来自设置/renderer 的可执行路径。
function resolveHelperPath({ platform = process.platform, arch = process.arch,
  resourcesPath = process.resourcesPath,
  isPackaged = !!(process.versions.electron && !process.defaultApp) } = {}) {
  if (!['darwin', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) return null;
  const name = platform === 'win32' ? 'privacy-probe.exe' : 'privacy-probe';
  if (isPackaged) return resourcesPath && path.isAbsolute(resourcesPath)
    ? path.join(resourcesPath, 'helpers', `${platform}-${arch}`, name) : null;
  return path.join(__dirname, '..', '..', 'native', 'bin', `${platform}-${arch}`, name);
}

class PrivacyController extends EventEmitter {
  // spawn/existsSync/clock 是单元测试依赖注入，不应接收 IPC/用户配置。
  constructor(options = {}) {
    super();
    this._platform = options.platform || process.platform;
    this._helperPath = resolveHelperPath({ ...options, platform: this._platform });
    this._spawn = options.spawn || spawn;
    this._exists = options.existsSync || fs.existsSync;
    this._clock = options.clock || {
      now: () => Date.now(), setTimeout, clearTimeout, setInterval, clearInterval,
    };
    this._enabled = false;
    this._raw = null;
    this._failure = '';
    this._helperStatus = 'stopped';
    this._child = null;
    this._retiring = new Map();
    this._lastProbeAt = null;
    this._startedAt = 0;
    this._validFrames = 0;
    this._retryIndex = 0;
    this._release = null;
    this._restartTimer = null;
    this._heartbeat = null;
    this._staleMs = 1800;
    this._releaseMs = 400;
    this._exitBound = false;
    this._onExit = () => {
      // exit 事件中不能等待异步清理。
      for (const child of [this._child, ...this._retiring.keys()]) {
        try { child?.kill('SIGKILL'); } catch { /* already exited */ }
      }
    };
    this._state = this._snapshot({ mode: 'off', reason: 'disabled' });
    if (options.enabled === true) this.setEnabled(true);
  }

  getState() {
    return { ...this._state, capabilities: { ...this._state.capabilities } };
  }

  setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
    if (enabled === this._enabled) return this.getState();
    this._enabled = enabled;
    this._clearRelease();
    this._raw = null;
    this._lastProbeAt = null;
    if (!enabled) {
      this._clearRestart();
      if (this._heartbeat !== null) this._clock.clearInterval(this._heartbeat);
      this._heartbeat = null;
      this._failure = '';
      this._helperStatus = 'stopped';
      const child = this._child;
      this._child = null;
      if (child) this._terminate(child);
      this._publish({ mode: 'off', reason: 'disabled' });
      this._unbindExitIfIdle();
      return this.getState();
    }
    this._retryIndex = 0;
    this._failure = 'helper-starting';
    this._helperStatus = 'starting';
    if (!this._exitBound) {
      process.on('exit', this._onExit);
      this._exitBound = true;
    }
    this._publish({ mode: 'shield', reason: this._failure });
    this._heartbeat = this._clock.setInterval(() => this._checkHeartbeat(), 200);
    this._heartbeat.unref?.();
    this._start();
    return this.getState();
  }

  stop() { return this.setEnabled(false); }

  _snapshot(decision) {
    const raw = this._raw;
    return {
      enabled: this._enabled, ...decision, helperStatus: this._helperStatus,
      sensitive: raw ? raw.sensitive : null,
      fullscreen: raw ? raw.fullscreen : null,
      recorder: raw ? raw.recorder : null,
      trusted: raw ? raw.trusted : false,
      capabilities: raw ? { ...raw.capabilities } : rules.emptyCapabilities(),
    };
  }

  _publish(decision) {
    const state = this._snapshot(decision);
    if (JSON.stringify(state) === JSON.stringify(this._state)) return;
    this._state = state;
    this.emit('change', this.getState());
  }

  _target() {
    return rules.resolve({ enabled: this._enabled, raw: this._raw, failure: this._failure });
  }

  _reconcile() {
    const next = this._target();
    if (!this._enabled || rules.MODE_RANK[next.mode] >= rules.MODE_RANK[this._state.mode]) {
      this._clearRelease();
      this._publish(next); // 进入保护立即发生，无进入防抖。
      return;
    }
    // 退出保护必须连续清晰 400ms；同等级理由变化不重置这个窗口。
    if (!this._release || this._release.mode !== next.mode) {
      this._clearRelease();
      const pending = { mode: next.mode, timer: null };
      this._release = pending;
      pending.timer = this._clock.setTimeout(() => {
        if (this._release !== pending) return;
        this._release = null;
        const current = this._target();
        if (current.mode === pending.mode) this._publish(current);
        else this._reconcile();
      }, this._releaseMs);
      pending.timer.unref?.();
    }
    // 防抖期间保留原 mode/reason，但仍更新诊断能力。
    this._publish({ mode: this._state.mode, reason: this._state.reason });
  }

  _clearRelease() {
    if (this._release) this._clock.clearTimeout(this._release.timer);
    this._release = null;
  }

  _clearRestart() {
    if (this._restartTimer !== null) this._clock.clearTimeout(this._restartTimer);
    this._restartTimer = null;
  }

  _start() {
    if (!this._enabled || this._child) return;
    if (!this._helperPath || !this._exists(this._helperPath)) {
      this._failure = this._helperPath ? 'helper-missing' : 'platform-unsupported';
      this._helperStatus = 'unavailable';
      this._reconcile();
      return;
    }
    this._raw = null;
    this._lastProbeAt = null;
    this._startedAt = this._clock.now();
    this._validFrames = 0;
    this._failure = 'helper-starting';
    this._helperStatus = 'starting';
    this._reconcile();
    let child;
    try {
      child = this._spawn(this._helperPath, [], {
        stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false, detached: false,
      });
      this._child = child;
      child.unref?.();
      if (!child.stdout || !child.stdin) throw new Error('probe pipes unavailable');
    } catch {
      if (child) { this._child = null; this._terminate(child); }
      this._fail('helper-spawn-failed');
      return;
    }
    let buffered = '';
    const active = () => this._enabled && this._child === child;
    const failed = (reason) => { if (active()) this._fail(reason); };
    child.stdout.on('data', (chunk) => {
      if (!active()) return;
      // 原生协议是 ASCII JSON；对大块、超长残行、坏 JSON 立即停止探测，不保留内容。
      if (Buffer.byteLength(chunk) > MAX_CHUNK_BYTES) return failed('probe-overflow');
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      let start = 0;
      while (start < text.length && active()) {
        const end = text.indexOf('\n', start);
        const part = text.slice(start, end < 0 ? text.length : end);
        if (Buffer.byteLength(buffered) + Buffer.byteLength(part) > MAX_LINE_BYTES) return failed('probe-overflow');
        buffered += part;
        if (end < 0) return;
        const line = buffered.trim();
        buffered = '';
        start = end + 1;
        if (!line) continue;
        let raw;
        try { raw = rules.normalizeProbe(JSON.parse(line)); } catch { raw = null; }
        if (!raw) return failed('probe-invalid');
        this._raw = raw;
        this._lastProbeAt = this._clock.now();
        this._failure = '';
        this._helperStatus = 'running';
        this._validFrames++;
        // 只在持续健康运行后重置退避，避免「先输出一帧后崩溃」无限快速重启。
        if (this._validFrames >= 25 && this._clock.now() - this._startedAt >= 10000) this._retryIndex = 0;
        this._reconcile();
      }
    });
    child.stdout.on('error', () => failed('probe-stream-error'));
    child.stdout.on('end', () => failed('probe-stream-ended'));
    child.stdin.on('error', () => failed('probe-stream-error'));
    child.on('error', () => failed('helper-spawn-failed'));
    child.once('exit', () => failed('helper-exited'));
    child.once('close', () => failed('helper-exited'));
  }

  _checkHeartbeat() {
    if (!this._enabled || !this._child) return;
    const since = this._lastProbeAt === null ? this._startedAt : this._lastProbeAt;
    if (this._clock.now() - since >= this._staleMs) this._fail('probe-stale');
  }

  _fail(reason) {
    if (!this._enabled) return;
    this._raw = null;
    this._lastProbeAt = null;
    this._failure = reason;
    this._helperStatus = 'backoff';
    const child = this._child;
    this._child = null;
    if (child) this._terminate(child);
    this._reconcile();
    if (this._restartTimer !== null) return;
    if (this._retryIndex >= RETRY_DELAYS.length) {
      this._helperStatus = 'unavailable';
      this._reconcile();
      return;
    }
    const delay = RETRY_DELAYS[this._retryIndex++];
    this._restartTimer = this._clock.setTimeout(() => {
      this._restartTimer = null;
      this._start();
    }, delay);
    this._restartTimer.unref?.();
  }

  _terminate(child) {
    if (this._retiring.has(child)) return;
    // 数据监听立即释放；退出/error 回调使用 child identity，旧进程不会污染新会话。
    child.stdout?.removeAllListeners('data');
    const done = () => {
      const timer = this._retiring.get(child);
      if (timer !== undefined) this._clock.clearTimeout(timer);
      this._retiring.delete(child);
      child.stdin?.destroy?.();
      child.stdout?.destroy?.();
      this._unbindExitIfIdle();
    };
    const timer = this._clock.setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      child.stdin?.destroy?.();
      child.stdout?.destroy?.();
    }, 500);
    timer.unref?.();
    this._retiring.set(child, timer);
    child.once('close', done);
    if (child.exitCode !== null && child.exitCode !== undefined) { done(); return; }
    try { child.stdin?.end('stop\n'); } catch { /* pipe already closed */ }
    try { child.kill('SIGTERM'); } catch { /* already exited */ }
  }

  _unbindExitIfIdle() {
    if (this._enabled || this._child || this._retiring.size || !this._exitBound) return;
    process.removeListener('exit', this._onExit);
    this._exitBound = false;
  }
}

module.exports = { PrivacyController, resolveHelperPath };
