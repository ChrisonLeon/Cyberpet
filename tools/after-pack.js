'use strict';
// electron-builder 的 afterPack 钩子：没有开发者证书时，对 .app 做完整的 ad-hoc 签名。
// 包内资源会被封印、Info.plist 会被绑定，这是 macOS（尤其 Apple Silicon）上正常启动和授权辅助功能的前提。
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const dir = context.appOutDir;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.app')) continue;
    const app = path.join(dir, name);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
    console.log(`  • ad-hoc signed    file=${name}`);
  }
};
