/* 配音纯规则：有导入配音就播配音，否则合成音效（视频原声彩蛋已随「选视频」一起移除）。
   angryLine 仅控制台词显示，不参与声音选择；保留 resolve 的返回结构供调用方兼容。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BXC_VOICE = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * @param {object} options
   * @param {boolean} options.hasVoice 是否已导入配音
   */
  function resolve({ hasVoice }) {
    return { easterEnabled: false, source: hasVoice ? 'voice' : 'synth' };
  }

  return { resolve };
}));
