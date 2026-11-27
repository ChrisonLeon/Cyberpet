/* 全部音效用 Web Audio 实时合成，不依赖任何音频文件。 */
(function () {
  'use strict';

  class Sfx {
    constructor() {
      this.ctx = null;
      this.master = null;
      this.noiseBuf = null;
    }

    ensure() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.55;
        this.master.connect(this.ctx.destination);
        this.noiseBuf = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
        const data = this.noiseBuf.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }

    // 单个音：从 f0 滑到 f1，快速起音后指数衰减
    tone(type, f0, f1, dur, peak, delay = 0) {
      const ctx = this.ctx;
      const t = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(f0, t);
      if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(f1, t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g);
      g.connect(this.master);
      osc.start(t);
      osc.stop(t + dur + 0.02);
      return { osc, g };
    }

    // 滤波噪声：模拟「咔哒 / 沙沙 / 呼啸」
    burst(dur, peak, type, freq, q = 1, delay = 0, freqEnd) {
      const ctx = this.ctx;
      const t = ctx.currentTime + delay;
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.setValueAtTime(freq, t);
      f.Q.value = q;
      if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(f);
      f.connect(g);
      g.connect(this.master);
      src.start(t, Math.random() * 0.8);
      src.stop(t + dur + 0.02);
    }

    key(profile) {
      if (!this.ensure()) return;
      const r = 0.9 + Math.random() * 0.2;
      switch (profile) {
        case 'blue': // 青轴：清脆的高频 click
          this.burst(0.022, 0.5, 'highpass', 4200 * r, 0.7);
          this.tone('sine', 3300 * r, 2900 * r, 0.03, 0.12);
          break;
        case 'woodfish': // 木鱼：空心的「笃」
          this.tone('sine', 640 * r, 590 * r, 0.11, 0.75);
          this.tone('sine', 1290 * r, 1180 * r, 0.045, 0.22);
          this.burst(0.006, 0.35, 'bandpass', 2400, 1.2);
          break;
        case 'kitten': // 奶猫爪：软软的肉垫声，偶尔喵一声
          if (Math.random() < 0.2) this.meow(0.5 + Math.random() * 0.2, 0.16);
          else this.burst(0.03, 0.45, 'lowpass', 700 * r, 0.7);
          break;
        default: // 麻将音：响亮的「哗啦」
          this.burst(0.04, 0.7, 'bandpass', 2700 * r, 1.3);
          this.tone('triangle', 560 * r, 390 * r, 0.065, 0.42);
          this.tone('sine', 210 * r, 150 * r, 0.05, 0.22);
      }
    }

    meow(pitch = 1, vol = 0.3) {
      if (!this.ensure()) return;
      const ctx = this.ctx;
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(520 * pitch, t);
      osc.frequency.exponentialRampToValueAtTime(900 * pitch, t + 0.11);
      osc.frequency.exponentialRampToValueAtTime(560 * pitch, t + 0.3);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = 3.2;
      f.frequency.setValueAtTime(1100 * pitch, t);
      f.frequency.exponentialRampToValueAtTime(1800 * pitch, t + 0.11);
      f.frequency.exponentialRampToValueAtTime(1000 * pitch, t + 0.3);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.04);
      g.gain.setValueAtTime(vol, t + 0.18);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
      osc.connect(f);
      f.connect(g);
      g.connect(this.master);
      osc.start(t);
      osc.stop(t + 0.34);
    }

    purr() {
      if (!this.ensure()) return;
      const ctx = this.ctx;
      const t = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 420;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.75);
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 26;
      const lg = ctx.createGain();
      lg.gain.value = 0.11;
      lfo.connect(lg);
      lg.connect(g.gain);
      src.connect(f);
      f.connect(g);
      g.connect(this.master);
      src.start(t, Math.random() * 0.5);
      lfo.start(t);
      src.stop(t + 0.8);
      lfo.stop(t + 0.8);
    }

    // 没有原声文件时的替代：低吼 + 火焰呼啸
    angry() {
      if (!this.ensure()) return;
      const ctx = this.ctx;
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(120, t);
      osc.frequency.exponentialRampToValueAtTime(82, t + 0.5);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 520;
      f.Q.value = 5;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.3, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
      osc.connect(f);
      f.connect(g);
      g.connect(this.master);
      osc.start(t);
      osc.stop(t + 0.6);
      this.burst(0.45, 0.45, 'bandpass', 380, 1.2, 0.02, 2600);
    }
  }

  window.BXC_SFX = Sfx;
})();
