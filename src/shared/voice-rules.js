/* 配音联动规则：头像类型 × 「原声彩蛋」× 导入配音，决定触发时到底播放什么。
   面板（决定复选框可不可点）和桌宠（决定播什么）共用，单元测试覆盖全部组合。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BXC_VOICE = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * @param {string} headMode   'photo' | 'cartoon'
   * @param {string} headType  'image' | 'video'
   * @param {boolean} voiceEaster 「原声彩蛋」是否勾选
   * @param {boolean} hasVoice  是否已导入配音
   */
  function resolve({ headMode, headType, voiceEaster, hasVoice }) {
    const videoHead = headMode === 'photo' && headType === 'video';
    const useVideoOriginal = videoHead && !!voiceEaster;
    return {
      easterEnabled: videoHead, // 只有视频头像才有「原声」；图片 / Q 版猫头时复选框不可用
      source: useVideoOriginal ? 'video' : (hasVoice ? 'voice' : 'synth'),
    };
  }

  const EASTER_TITLE = {
    video: '勾选后：敲脑袋 / 打字太快 / 点「能别放屁吗」时，头上显示台词并从头播放视频原声；未勾选：不显示台词，小猫只会逐渐暴躁（疯狂击打键盘），有导入配音时则播放配音',
    image: '勾选后：触发时头上显示台词（声音用导入的配音，没有则用合成音效）；未勾选：不显示台词，小猫逐渐暴躁疯狂击打键盘',
    cartoon: '勾选后：触发时在头上显示台词（声音用导入的配音，没有则用合成音效）；未勾选：不显示台词，小猫逐渐暴躁疯狂击打键盘',
  };

  return { resolve, EASTER_TITLE };
}));
