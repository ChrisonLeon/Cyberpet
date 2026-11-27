/* 配音纯规则：头像类型 × 「原声彩蛋」× 导入配音决定声音来源。
   angryLine 仅控制台词显示，不参与声音选择；保留 resolve 的原有返回结构。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BXC_VOICE = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * @param {object} options
   * @param {string} options.headMode 'photo' | 'cartoon'
   * @param {string} options.headType 'image' | 'video'
   * @param {boolean} options.voiceEaster 是否使用视频原声（非视频时保留设置但不生效）
   * @param {boolean} options.hasVoice 是否已导入配音
   */
  function resolve({ headMode, headType, voiceEaster, hasVoice }) {
    const videoHead = headMode === 'photo' && headType === 'video';
    const useVideoOriginal = videoHead && !!voiceEaster;
    return {
      easterEnabled: videoHead,
      source: useVideoOriginal ? 'video' : (hasVoice ? 'voice' : 'synth'),
    };
  }

  const EASTER_TITLE = {
    video: '仅选择声音来源：开启时生气触发播放视频原声；关闭时使用导入配音，没有则使用合成音效。台词显示由独立台词按钮决定；更换声音来源会停止上一段声音。',
    image: '图片头像没有视频原声，此选项暂不可用并保留原值；触发时使用导入配音或合成音效。台词显示由独立台词按钮决定。',
    cartoon: 'Q 版猫头没有视频原声，此选项暂不可用并保留原值；触发时使用导入配音或合成音效。台词显示由独立台词按钮决定。',
  };

  return { resolve, EASTER_TITLE };
}));
