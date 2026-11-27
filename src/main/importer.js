'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

let seq = 0;

/**
 * 把选中的文件复制进应用自己的数据目录，之后原文件挪走或删除也不影响。
 * 每类只保留最近的 limit 个；正在使用中的文件（inUse）永远不删——包括刚导入的这个。
 *
 * @param {string} srcPath 用户选中的文件
 * @param {string} dir     应用数据目录下的子目录（heads / voice）
 * @param {number} limit   最多保留几个
 * @param {string[]} inUse 正在使用的文件绝对路径
 * @returns {Promise<string>} 新文件的绝对路径
 */
async function importFile(srcPath, dir, limit, inUse = []) {
  await fsp.mkdir(dir, { recursive: true });
  const safeName = path.basename(srcPath).replace(/[^\w.\-\u4e00-\u9fff]+/g, '_');
  // 文件名 = 时间戳 + 序号 + 原名：字典序就是时间序，清理旧文件时按名字排序即可
  const stamp = `${Date.now()}-${String((seq += 1) % 1000).padStart(3, '0')}`;
  const dest = path.join(dir, `${stamp}-${safeName}`);
  await fsp.copyFile(srcPath, dest);
  const names = (await fsp.readdir(dir)).sort();
  const keep = new Set([...inUse, dest]);
  for (const name of names.slice(0, Math.max(0, names.length - limit))) {
    const file = path.join(dir, name);
    if (!keep.has(file)) await fsp.unlink(file).catch(() => {});
  }
  return dest;
}

module.exports = { importFile };
