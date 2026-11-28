// 全局键鼠被动监听助手（macOS）。
// 用 CGEventTapCreate 的 listenOnly（被动）模式：只观察、无权修改或吞掉任何事件，
// 从机制上杜绝「钩子停摆 → 全系统鼠标键盘被堵死」（主动式钩子的通病）。
// 协议与 privacy-probe 一致：stdout 逐行 JSON（2s 心跳），stdin 收到 stop 退出。
// 事件形状：{"t":"key","n":"q","r":false,"s":false,"c":false,"a":false,"m":false}
//          {"t":"keyup","n":"q"} {"t":"md","b":1} {"t":"mm","x":10,"y":20} {"t":"wheel","d":-1}
import AppKit

// kVK 虚拟键码 → 键名（与 uiohook-napi/UiohookKey 命名对齐，经 hooks.js 翻译为气泡标签）
let NAMES: [Int: String] = [
  0x00: "a", 0x01: "s", 0x02: "d", 0x03: "f", 0x04: "h", 0x05: "g", 0x06: "z", 0x07: "x",
  0x08: "c", 0x09: "v", 0x0B: "b", 0x0C: "q", 0x0D: "w", 0x0E: "e", 0x0F: "r",
  0x10: "y", 0x11: "t", 0x12: "1", 0x13: "2", 0x14: "3", 0x15: "4", 0x16: "6", 0x17: "5",
  0x18: "=", 0x19: "9", 0x1A: "7", 0x1B: "-", 0x1C: "8", 0x1D: "0", 0x1E: "]", 0x1F: "o",
  0x20: "u", 0x21: "[", 0x22: "i", 0x23: "p", 0x25: "l", 0x26: "j", 0x27: "'", 0x28: "k",
  0x29: ";", 0x2A: "\\", 0x2B: ",", 0x2C: "/", 0x2D: "n", 0x2E: "m", 0x2F: ".",
  0x24: "enter", 0x30: "tab", 0x31: "space", 0x33: "backspace", 0x35: "esc",
  0x36: "meta", 0x37: "meta", 0x38: "shift", 0x39: "caps", 0x3A: "alt", 0x3B: "ctrl",
  0x3C: "shift", 0x3D: "alt", 0x3E: "ctrl", 0x3F: "fn",
  0x41: "numdot", 0x43: "nummul", 0x45: "numadd", 0x47: "numlock", 0x4B: "numdiv",
  0x4C: "numenter", 0x4E: "numsub",
  0x52: "num0", 0x53: "num1", 0x54: "num2", 0x55: "num3", 0x56: "num4",
  0x57: "num5", 0x58: "num6", 0x59: "num7", 0x5B: "num8", 0x5C: "num9",
  0x60: "f5", 0x61: "f6", 0x62: "f7", 0x63: "f3", 0x64: "f8", 0x65: "f9",
  0x67: "f11", 0x69: "f13", 0x6B: "f14", 0x6D: "f10", 0x6F: "f12", 0x71: "f15",
  0x72: "ins", 0x73: "home", 0x74: "pgup", 0x75: "del", 0x76: "f4", 0x77: "end", 0x79: "pgdn",
  0x78: "f2", 0x7A: "f1", 0x7B: "left", 0x7C: "right", 0x7D: "down", 0x7E: "up",
]

// 修饰键的设备级标志位（区分左右，用于 flagsChanged 的按下/抬起判定）
let MOD_BITS: [Int: UInt64] = [
  0x38: 0x02, 0x3C: 0x04,       // 左/右 Shift
  0x3B: 0x01, 0x3E: 0x2000,     // 左/右 Control
  0x37: 0x08, 0x36: 0x10,       // 左/右 Command
  0x3A: 0x20, 0x3D: 0x40,       // 左/右 Option
  0x39: 0x10000,                // CapsLock（NX_ALPHASHIFT 状态位）
]

var prevModState: [Int: Bool] = [:]
var lastMoveOut = 0.0
let outHandle = FileHandle.standardOutput

func emit(_ line: String) {
  outHandle.write(Data((line + "\n").utf8))
}

func flagsOf(_ event: CGEvent) -> (Bool, Bool, Bool, Bool) {
  let f = event.flags
  return (f.contains(CGEventFlags(rawValue: 0x20000)), f.contains(CGEventFlags(rawValue: 0x40000)),
          f.contains(CGEventFlags(rawValue: 0x80000)), f.contains(CGEventFlags(rawValue: 0x100000)))
}

func handle(type: CGEventType, event: CGEvent) {
  switch type {
  case .flagsChanged:
    let code = Int(event.getIntegerValueField(.keyboardEventKeycode))
    guard let name = NAMES[code], let bit = MOD_BITS[code] else { return }
    let down = event.flags.contains(CGEventFlags(rawValue: UInt64(bit)))
    if prevModState[code] == down { return } // 无变化（组合键触发多次 flagsChanged）
    prevModState[code] = down
    let (s, c, a, m) = flagsOf(event)
    emit(down
      ? "{\"t\":\"key\",\"n\":\"\(name)\",\"s\":\(s),\"c\":\(c),\"a\":\(a),\"m\":\(m),\"r\":false}"
      : "{\"t\":\"keyup\",\"n\":\"\(name)\"}")
  case .keyDown, .keyUp:
    let code = Int(event.getIntegerValueField(.keyboardEventKeycode))
    let name = NAMES[code] ?? ""
    let (s, c, a, m) = flagsOf(event)
    let rep = event.getIntegerValueField(.keyboardEventAutorepeat) != 0
    if type == .keyDown {
      emit("{\"t\":\"key\",\"n\":\"\(name)\",\"s\":\(s),\"c\":\(c),\"a\":\(a),\"m\":\(m),\"r\":\(rep)}")
    } else {
      emit("{\"t\":\"keyup\",\"n\":\"\(name)\"}")
    }
  case .leftMouseDown: emit("{\"t\":\"md\",\"b\":1}")
  case .rightMouseDown: emit("{\"t\":\"md\",\"b\":2}")
  case .otherMouseDown: emit("{\"t\":\"md\",\"b\":3}")
  case .leftMouseUp: emit("{\"t\":\"mu\",\"b\":1}")
  case .rightMouseUp: emit("{\"t\":\"mu\",\"b\":2}")
  case .otherMouseUp: emit("{\"t\":\"mu\",\"b\":3}")
  case .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged:
    let now = CFAbsoluteTimeGetCurrent()
    guard now - lastMoveOut > 0.03 else { return } // 节流到 ~33ms，主进程再做一层
    lastMoveOut = now
    let p = event.location
    emit("{\"t\":\"mm\",\"x\":\(Int(p.x)),\"y\":\(Int(p.y))}")
  case .scrollWheel:
    let d = event.getIntegerValueField(.scrollWheelEventDeltaAxis1)
    emit("{\"t\":\"wheel\",\"d\":\(d)}")
  case .tapDisabledByTimeout, .tapDisabledByUserInput:
    if let tap = currentTap { CGEvent.tapEnable(tap: tap, enable: true) } // 被动钩子被系统超时禁用：立即恢复
  default:
    break
  }
}

var currentTap: CFMachPort?

func tapCallback(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, refcon: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
  handle(type: type, event: event)
  return Unmanaged.passUnretained(event) // listenOnly：返回值仅形式，事件照常放行
}

func main() {
  var mask: UInt64 = 0
  for t in [CGEventType.keyDown, .keyUp, .flagsChanged, .leftMouseDown, .leftMouseUp,
            .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp,
            .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .scrollWheel] {
    mask |= (1 << t.rawValue)
  }
  guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: CGEventMask(mask), callback: tapCallback, userInfo: nil) else {
    emit("{\"t\":\"error\",\"e\":\"tap-create-failed\"}")
    exit(2)
  }
  currentTap = tap
  let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
  CFRunLoopAddSource(CFRunLoopGetMain(), runLoopSource, .defaultMode)
  CGEvent.tapEnable(tap: tap, enable: true)

  // stdin：收到 stop 退出（privacy-probe 同款协议）
  DispatchQueue.global().async {
    while let line = readLine() {
      if line.trimmingCharacters(in: .whitespaces) == "stop" { exit(0) }
    }
  }

  // 心跳：空闲时也让主进程知道钩子活着（2s 一次）
  Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in emit("{\"t\":\"hb\"}") }
  emit("{\"t\":\"ready\"}")

  RunLoop.main.run()
}

main()
