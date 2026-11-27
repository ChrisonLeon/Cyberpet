'use strict';
// 手动更新的纯逻辑：版本比较、更新清单解析、安装脚本生成。
// 不在顶层 require electron（单元测试直接跑这里）；运行时依赖通过 initUpdater 注入。

// 更新清单与安装包只允许来自这两个仓库的域，防渲染层伪造地址
const ALLOWED_HOSTS = new Set([
  'gitee.com', 'raw.githubusercontent.com', 'github.com',
  'objects.githubusercontent.com', 'release-assets.githubusercontent.com',
]);
const PLATFORM_KEYS = ['darwin-arm64', 'darwin-x64', 'win32-x64'];
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** 语义化版本比较：a<b → -1，a=b → 0，a>b → 1；非数字段按 0 处理 */
function compareVersions(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split('.').map((n) => (Number.isFinite(Number(n)) ? Number(n) : 0));
  const pb = String(b || '').replace(/^v/i, '').split('.').map((n) => (Number.isFinite(Number(n)) ? Number(n) : 0));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function safeUrl(u) {
  try {
    const url = new URL(String(u));
    return url.protocol === 'https:' && ALLOWED_HOSTS.has(url.hostname) && url.href.length <= 300 ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * 解析并收敛更新清单：只放行已知平台键、https 白名单域名；结构不对一律返回 null。
 * 期望形状：{ version: '2.4.1', notes: '…', urls: { 'darwin-arm64': [url, …], … } }
 */
function parseManifest(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const v = typeof raw.version === 'string' ? raw.version.trim() : '';
  if (!VERSION_RE.test(v)) return null;
  const urls = {};
  for (const key of PLATFORM_KEYS) {
    const list = raw.urls && raw.urls[key];
    const arr = (Array.isArray(list) ? list : [list]).map(safeUrl).filter(Boolean).slice(0, 4);
    if (arr.length) urls[key] = arr;
  }
  if (!Object.keys(urls).length) return null;
  const notes = typeof raw.notes === 'string' ? raw.notes.slice(0, 300) : '';
  return { version: v.replace(/^v/i, ''), notes, urls };
}

/** 取某平台的下载直链列表（按清单里的顺序，前面的优先） */
function pickUrls(urls, platformKey) {
  return (urls && Array.isArray(urls[platformKey])) ? urls[platformKey].slice() : [];
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** mac 自动更新脚本：先解压好的新 App 顶掉旧目录再重启（下载阶段已校验 Contents/MacOS 存在） */
function macInstallScript({ zipPath, extractDir, appPath }) {
  const app = shellQuote(`${extractDir}/Cyberpet.app`);
  const target = shellQuote(appPath);
  return [
    'set -e',
    'sleep 0.5',
    'pkill -x Cyberpet || true',
    'sleep 1',
    `rm -rf ${target}`,
    `ditto ${app} ${target}`,
    `open ${target}`,
  ].join('\n');
}

/** 注入 electron 依赖后的运行时：检查 / 下载 / 安装 / 打开下载页 */
function initUpdater({ net, app, shell, broadcast, platform, arch, isPackaged, macInstalled, winPortable, appVersion }) {
  const MANIFEST_URLS = [
    'https://gitee.com/chrison/Cyberpet/raw/main/latest.json',
    'https://raw.githubusercontent.com/ChrisonLeon/Cyberpet/main/latest.json',
  ];
  const RELEASE_PAGE = 'https://github.com/ChrisonLeon/Cyberpet/releases/latest';
  const platformKey = `${platform}-${arch}`;
  let download = null; // { version, file, total, received, done }

  function fetchText(url, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (ok, v) => { if (!done) { done = true; ok ? resolve(v) : reject(v); } };
      let req;
      try { req = net.request({ method: 'GET', url }); } catch (e) { return finish(false, e); }
      req.setHeader('User-Agent', 'Cyberpet-Updater');
      const timer = setTimeout(() => { try { req.abort(); } catch { /* 已结束 */ } finish(false, new Error('请求超时')); }, timeoutMs);
      req.on('response', (res) => {
        if (res.statusCode !== 200) { clearTimeout(timer); return finish(false, new Error(`HTTP ${res.statusCode}`)); }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > 65536) { clearTimeout(timer); try { req.abort(); } catch { /* 已结束 */ } return finish(false, new Error('清单过大')); }
          chunks.push(c);
        });
        res.on('end', () => { clearTimeout(timer); finish(true, Buffer.concat(chunks).toString('utf8')); });
        res.on('error', (e) => { clearTimeout(timer); finish(false, e); });
      });
      req.on('error', (e) => { clearTimeout(timer); finish(false, e); });
      req.end();
    });
  }

  // 依次试清单源（Gitee 优先），全部失败才报错
  async function fetchManifest() {
    let lastErr = new Error('没有可用的更新源');
    for (const url of MANIFEST_URLS) {
      try {
        const text = await fetchText(url);
        const manifest = parseManifest(JSON.parse(text));
        if (manifest) return manifest;
        lastErr = new Error('更新清单格式无效');
      } catch (err) { lastErr = err; }
    }
    throw lastErr;
  }

  async function check() {
    const manifest = await fetchManifest();
    return {
      current: appVersion,
      latest: manifest.version,
      notes: manifest.notes,
      hasUpdate: compareVersions(manifest.version, appVersion) > 0,
      installable: installable(),
      urls: pickUrls(manifest.urls, platformKey),
    };
  }

  function installable() {
    if (!isPackaged) return false; // 开发模式不自助更新
    if (platform === 'darwin') return macInstalled; // 必须已装进「应用程序」
    if (platform === 'win32') return !winPortable; // 便携版运行中被锁定，只能手动换
    return false;
  }

  function downloadFile(url, dest, onProgress) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (ok, v) => { if (!done) { done = true; ok ? resolve(v) : reject(v); } };
      let req;
      try { req = net.request({ method: 'GET', url }); } catch (e) { return finish(false, e); }
      req.setHeader('User-Agent', 'Cyberpet-Updater');
      const timer = setTimeout(() => { try { req.abort(); } catch { /* 已结束 */ } finish(false, new Error('下载超时')); }, 15 * 60 * 1000);
      req.on('response', (res) => {
        if (res.statusCode !== 200) { clearTimeout(timer); return finish(false, new Error(`HTTP ${res.statusCode}`)); }
        const total = Number(res.headers['content-length']) || 0;
        if (total > 600 * 1024 * 1024) { clearTimeout(timer); return finish(false, new Error('安装包过大')); }
        const out = require('fs').createWriteStream(dest);
        let received = 0;
        let lastTick = 0;
        res.on('data', (c) => {
          received += c.length;
          if (total && received > total * 1.05) { clearTimeout(timer); out.destroy(); try { req.abort(); } catch { /* 已结束 */ } return finish(false, new Error('下载内容异常')); }
          if (!out.write(c)) res.pause();
          out.once('drain', () => res.resume());
          const now = Date.now();
          if (now - lastTick > 250) { lastTick = now; onProgress({ received, total, pct: total ? Math.min(100, Math.round(received / total * 100)) : 0 }); }
        });
        res.on('error', (e) => { clearTimeout(timer); out.destroy(); finish(false, e); });
        out.on('error', (e) => { clearTimeout(timer); finish(false, e); });
        res.on('end', () => {
          clearTimeout(timer);
          out.end(() => {
            onProgress({ received, total, pct: 100 });
            finish(true, dest);
          });
        });
      });
      req.on('error', (e) => { clearTimeout(timer); finish(false, e); });
      req.end();
    });
  }

  const { spawn } = require('child_process');
  const fs = require('fs');
  const path = require('path');

  // 下载：同一时间只允许一个；完成后广播 update:done
  async function startDownload(version, urls) {
    if (download && !download.done) throw new Error('已有下载在进行中');
    const url = urls[0];
    if (!url) throw new Error('没有可用的下载地址');
    const ext = platform === 'win32' ? '.exe' : '.zip';
    const file = path.join(app.getPath('downloads'), `Cyberpet-${version}-${platformKey}${ext}`);
    download = { version, url, urls, file, received: 0, total: 0, done: false };
    broadcast('update:progress', { pct: 0 });
    try {
      await downloadFile(url, file, ({ pct, received }) => { download.received = received; broadcast('update:progress', { pct }); });
      download.done = true;
      broadcast('update:done', { ok: true, version });
      return { ok: true, file };
    } catch (err) {
      download = null;
      broadcast('update:done', { ok: false, error: String(err.message || err) });
      return { ok: false, error: String(err.message || err) };
    }
  }

  // mac：解压并校验，然后由独立脚本退应用→替换→重启
  async function installMac(file, version) {
    const appPath = path.resolve(process.execPath, '..', '..', '..'); // …/Cyberpet.app
    if (!app.isInApplicationsFolder || !app.isInApplicationsFolder()) throw new Error('未安装在「应用程序」目录，请手动更新');
    const extractDir = path.join(app.getPath('temp'), `cyberpet-update-${version}`);
    await fs.promises.rm(extractDir, { recursive: true, force: true });
    await fs.promises.mkdir(extractDir, { recursive: true });
    await new Promise((resolve, reject) => {
      const p = spawn('ditto', ['-x', '-k', file, extractDir], { stdio: 'ignore' });
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`解压失败（${code}）`))));
      p.on('error', reject);
    });
    if (!fs.existsSync(path.join(extractDir, 'Cyberpet.app', 'Contents', 'MacOS', 'Cyberpet'))) throw new Error('更新包内容无效');
    const script = macInstallScript({ zipPath: file, extractDir, appPath });
    const child = spawn('/bin/bash', ['-c', script], { detached: true, stdio: 'ignore' });
    child.unref();
    setTimeout(() => app.exit(0), 300);
  }

  // win：静默安装（NSIS /S），配置在 %APPDATA% 不受影响；先结束自己再启动安装器
  async function installWin(file) {
    const script = `taskkill /IM Cyberpet.exe /F\r\nstart "" "${file}" /S`;
    const child = spawn('cmd.exe', ['/d', '/s', '/c', script], { detached: true, windowsHide: true, stdio: 'ignore' });
    child.unref();
    setTimeout(() => app.exit(0), 500);
  }

  async function install() {
    if (!download || !download.done) throw new Error('请先完成下载');
    if (!installable()) throw new Error('当前安装方式不支持自动更新');
    if (platform === 'darwin') return installMac(download.file, download.version);
    if (platform === 'win32') return installWin(download.file);
    throw new Error('该平台不支持自动更新');
  }

  function openPage() { shell.openExternal(RELEASE_PAGE); }

  return { check, startDownload, install, openPage, _state: () => download };
}

module.exports = { compareVersions, parseManifest, pickUrls, macInstallScript, initUpdater, ALLOWED_HOSTS, PLATFORM_KEYS };
