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
    video: '触发时（敲脑袋 / 打字太快 / 点「能别放屁吗」）从头播放一遍视频的原声；取消勾选后视频静音，改用导入的配音',
    image: '图片没有声音，这个选项对图片头像无效；想用台词请「导入配音」',
    cartoon: 'Q 版猫头没有原声；想用台词请「导入配音」',
  };

  return { resolve, EASTER_TITLE };
}));
