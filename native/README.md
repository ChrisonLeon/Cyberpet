# native/

自动隐私保护的探测辅助程序。

## macOS（已编译，本轮实机验证）

- 源码：`macos/privacy-probe.swift`
- 产物：`bin/darwin-arm64/privacy-probe`（arm64）
- 重新编译：`npm run build:privacy`
- 能力：系统安全输入（Carbon `IsSecureEventInputEnabled`）、辅助功能授权下的安全文本框角色 /
  前台窗口全屏（几何比对）、常见录屏/共享 App 运行白名单。只输出布尔结论，不读取任何内容。
- 边界：当前工具链（无完整 Xcode）编译不出 x86_64。Intel Mac 上探测器缺失 → 主进程按
  「探测器缺失」保守遮蔽并在面板说明。

## Windows（源码交付，待 Windows 环境编译验证）

- 源码：`windows/privacy-probe.cpp`（UIA `IsPassword` + `ES_PASSWORD`、前台窗口全屏几何、
  录屏/共享进程名白名单）
- 编译命令见源码头部注释；产物需放入 `bin/win32-x64/privacy-probe.exe` 后再打包。
- **状态：未编译、未在 Windows 实机验证。** 在 Windows 上启用隐私检测前必须完成：
  1. 在 Windows 构建环境编译并放入 `bin/win32-x64/`；
  2. 实机验证协议输出、密码框/全屏/录屏软件三类检测；
  3. 冒烟（`npm run smoke`）中的隐私步骤。
  未完成前，Windows 上开启「自动隐私保护」会走「探测器缺失 → 保守遮蔽」并明确提示。

## 协议（两端一致）

stdout 每 ~200ms 一行 JSON：`sensitive / fullscreen / recorder`（bool 或 null=该能力本轮不可测）、
`trusted`、`capabilities`。stdin 收到 `stop` 行或父进程退出即结束。行上限 4KB，超出即杀进程。
