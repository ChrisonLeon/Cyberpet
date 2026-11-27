// privacy-probe（Windows）：与 macOS 版同协议的元数据探测器。
// 只输出状态布尔值，不读取字段内容、密码、剪贴板或窗口标题。
//
// 编译（必须在 Windows 环境）：
//   cl /O2 /EHsc /DUNICODE /D_UNICODE privacy-probe.cpp /Fe:privacy-probe.exe ^
//     /link /SUBSYSTEM:CONSOLE ole32.lib oleaut64.lib uuid.lib user32.lib
//   或 MinGW: g++ -O2 -std=c++17 -municode privacy-probe.cpp -o privacy-probe.exe -lole32 -loleaut32 -luuid
// 产物放入 native/bin/win32-x64/privacy-probe.exe 后再打包。
// 状态：源码已交付，尚未在 Windows 环境编译验证（本轮无 Windows 构建机）。
//
// 协议：stdout 每 ~200ms 输出一行 JSON：
//   {"sensitive":bool|null,"fullscreen":bool|null,"recorder":bool|null,"trusted":true,
//    "capabilities":{"secureInput":true,"accessibility":true,"sensitive":bool,
//                    "fullscreen":bool,"recorder":bool,"recorderRunningOnly":true}}
// stdin 收到 "stop\n" 或父进程退出时结束。
#include <windows.h>
#include <oleauto.h>
#include <uiautomation.h>
#include <io.h>
#include <fcntl.h>
#include <cstdio>
#include <cstring>
#include <string>
#include <set>

static DWORD parentPid = 0;
static IUIAutomation* uia = nullptr;

static bool jsonEmit(bool hasSensitive, bool sensitive, bool hasFull, bool full, bool recorder) {
    char line[512];
    const char* s = hasSensitive ? (sensitive ? "true" : "false") : "null";
    const char* f = hasFull ? (full ? "true" : "false") : "null";
    const char* r = recorder ? "true" : "false";
    int n = snprintf(line, sizeof line,
        "{\"sensitive\":%s,\"fullscreen\":%s,\"recorder\":%s,\"trusted\":true,"
        "\"capabilities\":{\"secureInput\":true,\"accessibility\":true,\"sensitive\":%s,"
        "\"fullscreen\":%s,\"recorder\":true,\"recorderRunningOnly\":true}}\n",
        s, f, r, hasSensitive ? "true" : "false", hasFull ? "true" : "false");
    if (n <= 0 || n >= (int)sizeof line) return true;
    DWORD written = 0;
    return WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), line, (DWORD)n, &written, nullptr) && written == (DWORD)n;
}

// 安全输入：密码框（password 属性）或带 ES_PASSWORD 样式的编辑框。
static bool focusedSensitive() {
    HWND focus = GetFocus(); // 探测器无窗口焦点，改用 AttachThreadInput 不可靠；退回前台窗口的焦点控件
    HWND front = GetForegroundWindow();
    if (!focus && front) {
        GUITHREADINFO gi = { sizeof(gi) };
        if (GetGUIThreadInfo(GetWindowThreadProcessId(front, nullptr), &gi) && gi.hwndFocus) focus = gi.hwndFocus;
    }
    if (!focus) return false;
    wchar_t cls[64] = {};
    GetClassNameW(focus, cls, 64);
    if (wcsstr(cls, L"EDIT") || wcsstr(cls, L"RichEdit")) {
        // ES_PASSWORD 只对标准编辑框公开样式位；宿主自绘框（浏览器内）走 UIA。
        LONG style = GetWindowLongW(focus, GWL_STYLE);
        if (style & ES_PASSWORD) return true;
    }
    if (!uia) return false;
    IUIAutomationElement* el = nullptr;
    if (FAILED(uia->GetFocusedElement(&el)) || !el) return false;
    BOOL pw = FALSE;
    bool hit = SUCCEEDED(el->get_CurrentIsPassword(&pw)) && pw;
    el->Release();
    return hit;
}

// 全屏：前台窗口恰好覆盖一台显示器。
static bool focusedFullscreen() {
    HWND front = GetForegroundWindow();
    if (!front) return false;
    RECT r;
    if (!GetWindowRect(front, &r)) return false;
    // 无边框全屏窗口通常带 WS_POPUP；先排除明显的小窗口
    long w = r.right - r.left, h = r.bottom - r.top;
    if (w < GetSystemMetrics(SM_CXSCREEN) || h < GetSystemMetrics(SM_CYSCREEN)) return false;
    for (int i = 0;; i++) {
        DISPLAY_DEVICEW dd = { sizeof(dd) };
        if (!EnumDisplayDevicesW(nullptr, i, &dd, 0)) break;
        DEVMODEW dm = { sizeof(dm) };
        if (EnumDisplaySettingsW(dd.DeviceName, ENUM_CURRENT_SETTINGS, &dm)) {
            if (r.left <= dm.dmPosition.x && r.top <= dm.dmPosition.y
                && r.right >= dm.dmPosition.x + (long)dm.dmPelsWidth
                && r.bottom >= dm.dmPosition.y + (long)dm.dmPelsHeight) return true;
        }
    }
    return false;
}

// 常见录屏/共享软件：仅进程映像名白名单（运行即隐藏，可能提前隐藏 —— 与用户确认的策略一致）。
static bool recorderRunning() {
    static const wchar_t* names[] = {
        L"obs64.exe", L"obs32.exe", L"zoom.exe", L"Teams.exe", L"ms-teams.exe",
        L"ScreenRecorder.exe", L"Bandicam.exe", L"bdcam.exe", L"XSplit.Core.exe",
        L"CamStudio.exe", L"ScreenToGif.exe", L"vokoscreen.exe", L"ShareX.exe",
        L"weiyuncreen.exe", L"ToDesk.exe", L"SunloginClient.exe",
    };
    bool hit = false;
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return false;
    PROCESSENTRY32W pe = { sizeof(pe) };
    if (Process32FirstW(snap, &pe)) {
        do {
            if (pe.th32ParentProcessID == parentPid || pe.th32ProcessID == GetCurrentProcessId()) continue;
            for (const wchar_t* n : names) {
                if (_wcsicmp(pe.szExeFile, n) == 0) { hit = true; break; }
            }
        } while (!hit && Process32NextW(snap, &pe));
    }
    CloseHandle(snap);
    return hit;
}

static bool parentGone() {
    // 父进程退出检测：句柄信号
    static HANDLE dad = nullptr;
    if (!dad && parentPid) dad = OpenProcess(SYNCHRONIZE, FALSE, parentPid);
    return dad && WaitForSingleObject(dad, 0) == WAIT_OBJECT_0;
}

int wmain(int argc, wchar_t** argv) {
    parentPid = GetCurrentProcessId();
    HANDLE hStdin = GetStdHandle(STD_INPUT_HANDLE);
    // 父进程 PID 来自启动方；简单起见用 stdin 关闭作为退出信号。
    (void)argc; (void)argv;
    _setmode(_fileno(stdout), _O_BINARY);
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    HRESULT hr = CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER, IID_IUIAutomation, (void**)&uia);
    DWORD lastFull = 0, lastRec = 0;
    bool full = false, rec = false;
    for (;;) {
        // stdin：非阻塞检查 "stop"
        DWORD av = 0;
        if (PeekNamedPipe(hStdin, nullptr, 0, nullptr, &av, nullptr) && av > 0) {
            char buf[64] = {};
            DWORD got = 0;
            if (ReadFile(hStdin, buf, sizeof buf - 1, &got, nullptr)) {
                if (strstr(buf, "stop")) break;
            } else break;
        }
        if (parentGone()) break;
        bool sensitive = focusedSensitive();
        DWORD now = GetTickCount();
        if (now - lastFull >= 1000) { full = focusedFullscreen(); lastFull = now; }
        if (now - lastRec >= 2000) { rec = recorderRunning(); lastRec = now; }
        if (!jsonEmit(true, sensitive, true, full, rec)) break;
        Sleep(200);
    }
    if (uia) uia->Release();
    CoUninitialize();
    return 0;
}
