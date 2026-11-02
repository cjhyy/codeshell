// WindowServer view of one process's on-screen windows (no window titles or
// pixels are read, so Screen Recording permission is not required).
//   list <pid>                          one JSON snapshot
//   sample <pid> <durationMs> <everyMs> <rects>
//                                       classify Mimi windows over time; <rects> is every
//                                       display's global bounds "x,y,w,h;x,y,w,h;..."
//   displays                            CoreGraphics online displays (bounds, mode, pixels)
//   trusted                             whether this process may post input
//   capture-access                      whether this process may capture the screen
//   topmost <x> <y>                     owner pid of the frontmost window at a point
//   click <x> <y> [right]               native mouse click (callers check topmost first)
//   key escape|down|return              native key press
//   cursor                              current pointer position
//   stack <x> <y>                       every on-screen window at a point, front to back
//   others <pid>                        on-screen windows of other processes (bounds only)
//   drag <x1> <y1> <x2> <y2> <steps> <stepMs>
//                                       native left-button drag (callers check the start point)
//   front <seconds>                     an owned foreground helper app (one small window) that
//                                       holds activation, so stray keys reach it, not another app
//   frontmost                           pid of the active application
//   type <text>                         native key events carrying <text> (callers check the key window)
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

struct Win: Codable { let id: Int; let layer: Int; let alpha: Double; let x: Double; let y: Double; let width: Double; let height: Double }

func windows(pid: Int32) -> [Win] {
  guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
  return list.compactMap { info in
    guard (info[kCGWindowOwnerPID as String] as? Int32) == pid,
      let bounds = info[kCGWindowBounds as String] as? [String: Double] else { return nil }
    return Win(
      id: info[kCGWindowNumber as String] as? Int ?? 0,
      layer: info[kCGWindowLayer as String] as? Int ?? 0,
      alpha: info[kCGWindowAlpha as String] as? Double ?? 1,
      x: bounds["X"] ?? 0, y: bounds["Y"] ?? 0, width: bounds["Width"] ?? 0, height: bounds["Height"] ?? 0)
  }
}

struct Rect: Codable { let x: Double; let y: Double; let width: Double; let height: Double }

func parseRects(_ text: String) -> [Rect] {
  text.split(separator: ";").compactMap { part in
    let v = part.split(separator: ",").compactMap { Double($0) }
    return v.count == 4 ? Rect(x: v[0], y: v[1], width: v[2], height: v[3]) : nil
  }
}

// Docked: 112×112 or 400×380. Moving: one display's full width and height above
// the normal layer, at that display's x and at or up to 64 pt below its top (in an
// ordinary Space macOS keeps the panel below that display's menu bar). Every display
// is checked (same-size screens and negative origins included); a size-only match
// against one display would miss a moving window left on another screen.
func kind(_ w: Win, displays: [Rect]) -> String? {
  if w.alpha <= 0 { return nil }
  if (w.width == 112 && w.height == 112) || (w.width == 400 && w.height == 380) { return "docked" }
  if w.layer > 0 && displays.contains(where: {
    $0.x == w.x && $0.width == w.width && $0.height == w.height && w.y >= $0.y && w.y - $0.y <= 64
  }) {
    return "moving"
  }
  return nil
}

/// An owned, visible, above-normal-layer window large enough to be a character
/// surface but matching neither form: the sampler must never see one.
func unclassifiedLarge(_ w: Win, displays: [Rect]) -> Bool {
  w.alpha > 0 && w.layer > 0 && w.width >= 300 && w.height >= 300 && kind(w, displays: displays) == nil
}

func displayIndex(_ w: Win, displays: [Rect]) -> Int {
  let cx = w.x + w.width / 2, cy = w.y + w.height / 2
  return displays.firstIndex { cx >= $0.x && cy >= $0.y && cx < $0.x + $0.width && cy < $0.y + $0.height } ?? -1
}

func emit<T: Encodable>(_ value: T) {
  let data = try! JSONEncoder().encode(value)
  print(String(data: data, encoding: .utf8)!)
}

let args = CommandLine.arguments
switch args.count > 1 ? args[1] : "" {
case "trusted":
  emit(["trusted": AXIsProcessTrusted()])
case "capture-access":
  emit(["granted": CGPreflightScreenCaptureAccess()])
case "cursor":
  let point = CGEvent(source: nil)!.location
  emit(["x": point.x, "y": point.y])
case "topmost":
  let x = Double(args[2])!, y = Double(args[3])!
  let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
  // Front-to-back order. Ignore fully transparent windows and the menu bar/Dock layers.
  let hit = list.first { info in
    guard let b = info[kCGWindowBounds as String] as? [String: Double],
      (info[kCGWindowAlpha as String] as? Double ?? 1) > 0,
      (info[kCGWindowLayer as String] as? Int ?? 0) < 1000 else { return false }
    return x >= b["X"]! && y >= b["Y"]! && x < b["X"]! + b["Width"]! && y < b["Y"]! + b["Height"]!
  }
  emit(["pid": hit?[kCGWindowOwnerPID as String] as? Int ?? -1, "id": hit?[kCGWindowNumber as String] as? Int ?? -1])
case "click":
  let point = CGPoint(x: Double(args[2])!, y: Double(args[3])!)
  let right = args.count > 4 && args[4] == "right"
  let down: CGEventType = right ? .rightMouseDown : .leftMouseDown
  let up: CGEventType = right ? .rightMouseUp : .leftMouseUp
  let button: CGMouseButton = right ? .right : .left
  CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: button)!.post(tap: .cghidEventTap)
  usleep(120_000)
  CGEvent(mouseEventSource: nil, mouseType: down, mouseCursorPosition: point, mouseButton: button)!.post(tap: .cghidEventTap)
  usleep(60_000)
  CGEvent(mouseEventSource: nil, mouseType: up, mouseCursorPosition: point, mouseButton: button)!.post(tap: .cghidEventTap)
  emit(["clicked": true])
case "move":
  let point = CGPoint(x: Double(args[2])!, y: Double(args[3])!)
  CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)!.post(tap: .cghidEventTap)
  emit(["moved": true])
case "key":
  let codes: [String: CGKeyCode] = ["escape": 53, "down": 125, "return": 36]
  guard args.count > 2, let code = codes[args[2]] else { exit(2) }
  CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)!.post(tap: .cghidEventTap)
  usleep(30_000)
  CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)!.post(tap: .cghidEventTap)
  emit(["key": args[2]])
case "others":
  // On-screen windows of every other process (bounds only), to exclude from pixel analysis.
  let pid = Int32(args[2])!
  let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
  emit(list.compactMap { info -> Win? in
    guard (info[kCGWindowOwnerPID as String] as? Int32) != pid,
      (info[kCGWindowAlpha as String] as? Double ?? 1) > 0,
      let b = info[kCGWindowBounds as String] as? [String: Double] else { return nil }
    return Win(id: info[kCGWindowNumber as String] as? Int ?? 0, layer: info[kCGWindowLayer as String] as? Int ?? 0,
      alpha: 1, x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
  })
case "stack":
  // Every on-screen window containing a point, front to back.
  let x = Double(args[2])!, y = Double(args[3])!
  let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
  struct Hit: Codable { let pid: Int; let id: Int; let layer: Int; let width: Double; let height: Double }
  emit(list.compactMap { info -> Hit? in
    guard let b = info[kCGWindowBounds as String] as? [String: Double],
      (info[kCGWindowAlpha as String] as? Double ?? 1) > 0,
      x >= b["X"]! && y >= b["Y"]! && x < b["X"]! + b["Width"]! && y < b["Y"]! + b["Height"]! else { return nil }
    return Hit(pid: info[kCGWindowOwnerPID as String] as? Int ?? -1, id: info[kCGWindowNumber as String] as? Int ?? -1,
      layer: info[kCGWindowLayer as String] as? Int ?? 0, width: b["Width"]!, height: b["Height"]!)
  })
case "list":
  emit(windows(pid: Int32(args[2])!))
case "sample":
  let pid = Int32(args[2])!, duration = Double(args[3])! / 1000, every = UInt32(args[4])! * 1000
  let displays = parseRects(args[5])
  guard !displays.isEmpty else { exit(2) }
  struct Result: Codable {
    var samples = 0; var docked = 0; var moving = 0; var both = 0; var bothAt: [Double] = []
    var multipleMoving = 0; var multipleDocked = 0; var unclassified = 0
    /// Per display index: samples in which a docked / moving window was there.
    var dockedOn: [Int] = []; var movingOn: [Int] = []
    var displays: [Rect] = []
  }
  var result = Result()
  result.displays = displays
  result.dockedOn = Array(repeating: 0, count: displays.count + 1)
  result.movingOn = Array(repeating: 0, count: displays.count + 1)
  let start = Date()
  while Date().timeIntervalSince(start) < duration {
    var dockedCount = 0, movingCount = 0
    for w in windows(pid: pid) {
      if unclassifiedLarge(w, displays: displays) { result.unclassified += 1 }
      guard let k = kind(w, displays: displays) else { continue }
      let index = displayIndex(w, displays: displays)
      let slot = index < 0 ? displays.count : index
      if k == "docked" { dockedCount += 1; result.dockedOn[slot] += 1 } else { movingCount += 1; result.movingOn[slot] += 1 }
    }
    result.samples += 1
    if dockedCount > 0 { result.docked += 1 }
    if movingCount > 0 { result.moving += 1 }
    if dockedCount > 1 { result.multipleDocked += 1 }
    if movingCount > 1 { result.multipleMoving += 1 }
    if dockedCount + movingCount > 1 { result.both += 1; result.bothAt.append(Date().timeIntervalSince(start)) }
    usleep(every)
  }
  emit(result)
case "front":
  let seconds = Double(args[2])!
  let app = NSApplication.shared
  app.setActivationPolicy(.regular)
  let window = NSWindow(contentRect: NSRect(x: 60, y: 60, width: 360, height: 90), styleMask: [.titled], backing: .buffered, defer: false)
  window.title = "Mimi acceptance foreground helper (test-owned)"
  window.makeKeyAndOrderFront(nil)
  app.activate(ignoringOtherApps: true)
  DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
    emit(["pid": Int(getpid()), "active": NSRunningApplication.current.isActive ? 1 : 0])
    fflush(stdout)
  }
  DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { exit(0) }
  app.run()
case "frontmost":
  emit(["pid": Int(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1)])
case "type":
  for scalar in args[2].utf16 {
    var unit = scalar
    for down in [true, false] {
      let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)!
      event.keyboardSetUnicodeString(stringLength: 1, unicodeString: &unit)
      event.post(tap: .cghidEventTap)
      usleep(25_000)
    }
  }
  emit(["typed": args[2].count])
case "displays":
  var ids = [CGDirectDisplayID](repeating: 0, count: 32)
  var count: UInt32 = 0
  CGGetOnlineDisplayList(32, &ids, &count)
  struct Display: Codable {
    let id: UInt32; let main: Bool; let builtin: Bool; let mirrored: Bool; let active: Bool; let asleep: Bool
    let x: Double; let y: Double; let width: Double; let height: Double
    let modeWidth: Int; let modeHeight: Int; let pixelWidth: Int; let pixelHeight: Int
    let vendor: UInt32; let model: UInt32
  }
  emit(ids.prefix(Int(count)).map { id -> Display in
    let b = CGDisplayBounds(id)
    let mode = CGDisplayCopyDisplayMode(id)
    return Display(id: id, main: CGDisplayIsMain(id) != 0, builtin: CGDisplayIsBuiltin(id) != 0,
      mirrored: CGDisplayIsInMirrorSet(id) != 0, active: CGDisplayIsActive(id) != 0, asleep: CGDisplayIsAsleep(id) != 0,
      x: b.origin.x, y: b.origin.y, width: b.size.width, height: b.size.height,
      modeWidth: mode?.width ?? 0, modeHeight: mode?.height ?? 0,
      pixelWidth: mode?.pixelWidth ?? 0, pixelHeight: mode?.pixelHeight ?? 0,
      vendor: CGDisplayVendorNumber(id), model: CGDisplayModelNumber(id))
  })
case "drag":
  let from = CGPoint(x: Double(args[2])!, y: Double(args[3])!)
  let to = CGPoint(x: Double(args[4])!, y: Double(args[5])!)
  let steps = max(1, Int(args[6])!), stepMicros = UInt32(args[7])! * 1000
  CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: from, mouseButton: .left)!.post(tap: .cghidEventTap)
  usleep(150_000)
  CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left)!.post(tap: .cghidEventTap)
  usleep(120_000)
  for step in 1...steps {
    let t = Double(step) / Double(steps)
    let point = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: point, mouseButton: .left)!.post(tap: .cghidEventTap)
    usleep(stepMicros)
  }
  usleep(150_000)
  CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left)!.post(tap: .cghidEventTap)
  emit(["dragged": true])
default:
  FileHandle.standardError.write("usage: list <pid> | sample <pid> <ms> <everyMs> <x,y,w,h;...> | displays | drag ... | trusted\n".data(using: .utf8)!)
  exit(2)
}
