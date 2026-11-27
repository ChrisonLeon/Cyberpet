// Standalone metadata-only probe. No AXValue, labels, text, keys, images or window titles.
// AXIsProcessTrusted is deliberately non-prompting: permission must be user-initiated elsewhere.
import Foundation
import AppKit
import ApplicationServices
import Carbon
import Darwin

private let once = CommandLine.arguments.contains("--once")
private let parentPID = getppid()
private let queryTimeout: Float = 0.060
private let systemWide = AXUIElementCreateSystemWide()
private var stdinBuffer = [UInt8]()

private func axCopy(_ element: AXUIElement, _ attribute: CFString) -> (AXError, CFTypeRef?) {
    AXUIElementSetMessagingTimeout(element, queryTimeout)
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, attribute, &value)
    return (result, value)
}

private func axElement(_ value: CFTypeRef?) -> AXUIElement? {
    guard let value = value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

private func focusedSensitive(trusted: Bool) -> Bool? {
    // Carbon detects system-wide secure input even when AX permission is absent.
    if IsSecureEventInputEnabled() { return true }
    guard trusted else { return nil }
    let (error, value) = axCopy(systemWide, kAXFocusedUIElementAttribute as CFString)
    guard error == .success, let element = axElement(value) else { return nil }
    let (roleError, roleValue) = axCopy(element, kAXRoleAttribute as CFString)
    guard roleError == .success, let role = roleValue as? String else { return nil }
    if role == "AXSecureTextField" { return true }
    let (subError, subValue) = axCopy(element, kAXSubroleAttribute as CFString)
    if subError == .success, let subrole = subValue as? String {
        return subrole == (kAXSecureTextFieldSubrole as String)
    }
    // Non-text roles may legitimately not implement subrole. Failed text-field queries are unknown.
    if role != (kAXTextFieldRole as String), subError == .attributeUnsupported || subError == .noValue {
        return false
    }
    return nil
}

private func focusedFullscreen(trusted: Bool) -> Bool? {
    guard trusted, let front = NSWorkspace.shared.frontmostApplication else { return nil }
    let app = AXUIElementCreateApplication(front.processIdentifier)
    let (windowError, value) = axCopy(app, kAXFocusedWindowAttribute as CFString)
    guard windowError == .success, let window = axElement(value) else { return nil }
    let (fullError, fullValue) = axCopy(window, "AXFullScreen" as CFString)
    if fullError == .success, let full = fullValue as? Bool, full { return true }
    let (posError, posValue) = axCopy(window, kAXPositionAttribute as CFString)
    let (sizeError, sizeValue) = axCopy(window, kAXSizeAttribute as CFString)
    guard posError == .success, sizeError == .success,
          let p = posValue, let s = sizeValue,
          CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    // AXValue here is the AX geometry wrapper, never kAXValueAttribute / field content.
    var position = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &position),
          AXValueGetValue(s as! AXValue, .cgSize, &size),
          position.x.isFinite, position.y.isFinite, size.width.isFinite, size.height.isFinite,
          size.width > 0, size.height > 0 else { return nil }
    let screens = NSScreen.screens
    guard let primary = screens.first else { return nil }
    let rect = CGRect(origin: position, size: size)
    // AX uses top-left coordinates; AppKit uses bottom-left. Compare entire screen, not visibleFrame.
    return screens.contains { screen in
        let frame = screen.frame
        let axFrame = CGRect(x: frame.minX, y: primary.frame.maxY - frame.maxY,
                             width: frame.width, height: frame.height)
        return abs(rect.minX - axFrame.minX) <= 2 && abs(rect.minY - axFrame.minY) <= 2
            && abs(rect.maxX - axFrame.maxX) <= 2 && abs(rect.maxY - axFrame.maxY) <= 2
    }
}

private func recorderRunning() -> Bool? {
    // Conservative RUNNING-APP whitelist, NOT a recording-session detector.
    // Idle QuickTime/OBS/Teams/Zoom also hide the pet (intentional false positives).
    let exact: Set<String> = [
        "com.obsproject.obs-studio", "com.apple.quicktimeplayerx", "us.zoom.xos",
        "com.microsoft.teams", "com.microsoft.teams2", "com.loom.desktop",
        "com.cisco.webexmeetingsapp", "com.apple.screencaptureui",
    ]
    let prefixes = ["net.telestream.screenflow", "com.telestream.screenflow", "com.techsmith.camtasia"]
    for app in NSWorkspace.shared.runningApplications {
        if app.processIdentifier == getpid() || app.processIdentifier == parentPID || app.isTerminated { continue }
        guard let id = app.bundleIdentifier?.lowercased() else { continue }
        if exact.contains(id) || prefixes.contains(where: { id.hasPrefix($0) }) { return true }
    }
    return false
}

private func shouldStop() -> Bool {
    if getppid() != parentPID { return true }
    var bytes = [UInt8](repeating: 0, count: 64)
    let count = read(STDIN_FILENO, &bytes, bytes.count)
    if count == 0 { return true }
    if count < 0 { return errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR }
    for byte in bytes.prefix(count) {
        if byte == 10 {
            if stdinBuffer == Array("stop".utf8) { return true }
            stdinBuffer.removeAll(keepingCapacity: true)
        } else {
            if stdinBuffer.count >= 128 { return true }
            stdinBuffer.append(byte)
        }
    }
    return false
}

private func emit(sensitive: Bool?, fullscreen: Bool?, recorder: Bool?, trusted: Bool) {
    let record: [String: Any] = [
        "sensitive": sensitive.map { $0 as Any } ?? NSNull(),
        "fullscreen": fullscreen.map { $0 as Any } ?? NSNull(),
        "recorder": recorder.map { $0 as Any } ?? NSNull(),
        "trusted": trusted,
        "capabilities": ["secureInput": true, "accessibility": trusted,
                         "sensitive": sensitive != nil, "fullscreen": fullscreen != nil,
                         "recorder": recorder != nil, "recorderRunningOnly": true],
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]), data.count < 4096 else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}

if !once {
    let flags = fcntl(STDIN_FILENO, F_GETFL)
    if flags >= 0 { _ = fcntl(STDIN_FILENO, F_SETFL, flags | O_NONBLOCK) }
}
var fullscreen: Bool?
var recorder: Bool?
var nextFullscreen = 0.0
var nextRecorder = 0.0
repeat {
    let tick = ProcessInfo.processInfo.systemUptime
    if !once && shouldStop() { break }
    autoreleasepool {
        let trusted = AXIsProcessTrusted() // Does not display a permission prompt.
        let sensitive = focusedSensitive(trusted: trusted)
        if !trusted { fullscreen = nil; nextFullscreen = 0 }
        if tick >= nextFullscreen {
            fullscreen = focusedFullscreen(trusted: trusted)
            nextFullscreen = tick + 1.0
        }
        if tick >= nextRecorder {
            recorder = recorderRunning()
            nextRecorder = tick + 2.0
        }
        emit(sensitive: sensitive, fullscreen: fullscreen, recorder: recorder, trusted: trusted)
    }
    if once { break }
    // Run AppKit's loop so workspace/screen metadata updates; sensitive queries start every ~200ms.
    let remaining = max(0.005, 0.2 - (ProcessInfo.processInfo.systemUptime - tick))
    RunLoop.current.run(until: Date(timeIntervalSinceNow: remaining))
} while true
