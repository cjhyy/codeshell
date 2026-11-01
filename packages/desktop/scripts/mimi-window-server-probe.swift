// WindowServer view of one process's on-screen windows (no window titles or
// pixels are read, so Screen Recording permission is not required).
//   list <pid>                          one JSON snapshot
//   sample <pid> <durationMs> <everyMs> classify Mimi windows over time
//   trusted                             whether this process may post input
//   capture-access                      whether this process may capture the screen
//   topmost <x> <y>                     owner pid of the frontmost window at a point
//   click <x> <y> [right]               native mouse click (callers check topmost first)
//   key escape|down|return              native key press
//   cursor                              current pointer position
//   stack <x> <y>                       every on-screen window at a point, front to back
//   others <pid>                        on-screen windows of other processes (bounds only)
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

// Docked: 112×112 or 400×380. Moving: the whole display (passed by the caller).
func kind(_ w: Win, displayWidth: Double, displayHeight: Double) -> String? {
  if w.alpha <= 0 { return nil }
  if (w.width == 112 && w.height == 112) || (w.width == 400 && w.height == 380) { return "docked" }
  if w.width == displayWidth && w.height == displayHeight && w.layer > 0 { return "moving" }
  return nil
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
  let displayWidth = Double(args[5])!, displayHeight = Double(args[6])!
  struct Result: Codable { var samples = 0; var docked = 0; var moving = 0; var both = 0; var bothAt: [Double] = [] }
  var result = Result()
  let start = Date()
  while Date().timeIntervalSince(start) < duration {
    let kinds = Set(windows(pid: pid).compactMap { kind($0, displayWidth: displayWidth, displayHeight: displayHeight) })
    result.samples += 1
    if kinds.contains("docked") { result.docked += 1 }
    if kinds.contains("moving") { result.moving += 1 }
    if kinds.count > 1 { result.both += 1; result.bothAt.append(Date().timeIntervalSince(start)) }
    usleep(every)
  }
  emit(result)
default:
  FileHandle.standardError.write("usage: list <pid> | sample <pid> <ms> <everyMs> <displayW> <displayH> | trusted\n".data(using: .utf8)!)
  exit(2)
}
