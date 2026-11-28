#!/usr/bin/env bash
# 编译自动隐私保护的探测辅助程序（macOS arm64）。
# 产物：native/bin/darwin-arm64/privacy-probe，electron-builder 经 extraResources 复制到 Resources/helpers/darwin-arm64/。
#
# 已知边界：当前工具链（Command Line Tools，无完整 Xcode）编译不出 x86_64 版本。
# Intel Mac 上探测器文件不存在 → 主进程按「探测器缺失」处理：保守遮蔽 + 面板明确提示，
# 不会假装「已检测、无风险」。若以后装了完整 Xcode，可加回：
#   swiftc -O -sdk "$SDK" -target x86_64-apple-macos11 -o native/bin/darwin-x64/privacy-probe native/macos/privacy-probe.swift
set -euo pipefail
cd "$(dirname "$0")/.."

SDK="${SDK:-$(xcrun --show-sdk-path)}"
mkdir -p native/bin/darwin-arm64

echo "• arm64"
swiftc -O -sdk "$SDK" -target arm64-apple-macos13 \
  -o native/bin/darwin-arm64/privacy-probe native/macos/privacy-probe.swift

swiftc -O -sdk "$SDK" -target arm64-apple-macos13 \
  -o native/bin/darwin-arm64/input-hook native/macos/input-hook.swift
file native/bin/darwin-arm64/privacy-probe native/bin/darwin-arm64/input-hook
echo "完成。冒烟验证：echo '{}' | native/bin/darwin-arm64/privacy-probe --once"
