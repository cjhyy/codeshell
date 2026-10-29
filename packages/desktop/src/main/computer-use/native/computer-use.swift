import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation

private let helperBundleID = "com.cjhyy.codeshell.computer-use"
private let helperVersion = "codeshell-computer-use 1"
private let allowedEnvironment = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR"]

private func stderr(_ text: String) {
    FileHandle.standardError.write(Data((text + "\n").utf8))
}

private func fail(_ text: String, code: Int32 = 1) -> Never {
    stderr(text)
    exit(code)
}

private func cleanEnvironment() -> [String: String] {
    var environment: [String: String] = [:]
    for key in allowedEnvironment {
        environment[key] = ProcessInfo.processInfo.environment[key]
    }
    environment["CUA_DRIVER_EMBEDDED"] = "1"
    environment["CUA_DRIVER_HOST_BUNDLE_ID"] = helperBundleID
    environment["CUA_DRIVER_PERMISSION_MODE"] = "standard"
    return environment
}

private enum Operation {
    case serve(String)
    case status
    case accessibility
    case screenRecording

    init(_ arguments: [String]) throws {
        switch arguments {
        case ["status"]: self = .status
        case ["request-accessibility"]: self = .accessibility
        case ["request-screen-recording"]: self = .screenRecording
        default:
            guard arguments.count == 3, arguments[0] == "serve", arguments[1] == "--socket",
                  arguments[2].hasPrefix("/"), arguments[2].utf8.count < 104 else {
                throw HelperError.invalidArguments
            }
            self = .serve(arguments[2])
        }
    }

    var arguments: [String] {
        switch self {
        case .serve(let path): return ["serve", "--socket", path]
        case .status: return ["status"]
        case .accessibility: return ["request-accessibility"]
        case .screenRecording: return ["request-screen-recording"]
        }
    }

    var isServe: Bool {
        if case .serve = self { return true }
        return false
    }
}

private enum HelperError: Error {
    case invalidArguments
    case invalidBundle
    case invalidChannel
}

/// The bundle must be addressed by its own on-disk URL, never by a global bundle-ID lookup.
private func helperBundle() throws -> Bundle {
    let executable = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
    let bundleURL = executable.deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent()
    guard let bundle = Bundle(url: bundleURL), bundle.bundleIdentifier == helperBundleID,
          bundle.executableURL?.standardizedFileURL == executable else {
        throw HelperError.invalidBundle
    }
    return bundle
}

/// A per-launch private channel carries only bounded completion data; daemon traffic uses
/// the host's independently protected socket. It is never a shared, long-lived IPC endpoint.
private final class Channel {
    let directory: URL
    let token: String
    private let ownsDirectory: Bool
    private let identity: (device: dev_t, inode: ino_t)

    init() throws {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("cs-cua-launch-XXXXXX")
        var template = Array(base.path.utf8CString)
        let createdPath = template.withUnsafeMutableBufferPointer { buffer -> String? in
            guard let start = buffer.baseAddress, mkdtemp(start) != nil else { return nil }
            // Copy while the mutable buffer is borrowed; mkdtemp's pointer must
            // never escape this closure or be read after Swift releases it.
            return String(cString: start)
        }
        guard let path = createdPath, path.hasPrefix("/"),
              URL(fileURLWithPath: path).lastPathComponent.range(of: "^cs-cua-launch-[A-Za-z0-9]{6}$", options: .regularExpression) != nil,
              URL(fileURLWithPath: path).deletingLastPathComponent().resolvingSymlinksInPath()
                == base.deletingLastPathComponent().resolvingSymlinksInPath() else {
            throw HelperError.invalidChannel
        }
        var info = stat()
        guard lstat(path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR,
              info.st_uid == getuid(), info.st_mode & 0o777 == 0o700 else {
            throw HelperError.invalidChannel
        }
        identity = (info.st_dev, info.st_ino)
        directory = URL(fileURLWithPath: path, isDirectory: true)
        token = UUID().uuidString
        ownsDirectory = true
        try Data(token.utf8).write(to: directory.appendingPathComponent("token"), options: .atomic)
    }

    init(path: String, token: String) throws {
        let url = URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL
        var info = stat()
        guard path.hasPrefix("/"), lstat(url.path, &info) == 0,
              info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid(),
              info.st_mode & 0o777 == 0o700,
              token.count == 36,
              try String(contentsOf: url.appendingPathComponent("token"), encoding: .utf8) == token else {
            throw HelperError.invalidChannel
        }
        directory = url
        identity = (info.st_dev, info.st_ino)
        self.token = token
        ownsDirectory = false
    }

    func write(_ value: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        guard data.count <= 32_768 else { throw HelperError.invalidChannel }
        try data.write(to: directory.appendingPathComponent("result.json"), options: .atomic)
    }

    func read() throws -> [String: Any]? {
        let url = directory.appendingPathComponent("result.json")
        var info = stat()
        guard lstat(url.path, &info) == 0 else { return nil }
        guard info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(),
              info.st_size > 0, info.st_size <= 32_768,
              let value = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] else {
            throw HelperError.invalidChannel
        }
        return value
    }

    func clean() {
        guard ownsDirectory else { return }
        // Keep deletion anchored to the inode created by mkdtemp, even if its
        // pathname is replaced later. Only fixed names may be removed, never a
        // recursive tree or a directory supplied by a caller.
        let descriptor = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard descriptor >= 0 else { return }
        defer { close(descriptor) }
        var opened = stat()
        guard fstat(descriptor, &opened) == 0,
              opened.st_dev == identity.device, opened.st_ino == identity.inode else { return }
        for name in ["token", "result.json", "driver.pid"] {
            unlinkat(descriptor, name, 0)
        }
        var current = stat()
        if lstat(directory.path, &current) == 0,
           current.st_dev == identity.device, current.st_ino == identity.inode {
            rmdir(directory.path)
        }
    }
}

private final class Lifetime {
    private var sources: [DispatchSourceProtocol] = []

    /// Process sources follow the original process, avoiding PID-reuse polling races.
    func watch(_ pid: pid_t, exit handler: @escaping () -> Void) {
        let source = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: .main)
        source.setEventHandler(handler: handler)
        source.resume()
        sources.append(source)
        if kill(pid, 0) != 0 && errno == ESRCH { handler() }
    }

    func signals(_ handler: @escaping () -> Void) {
        for number in [SIGTERM, SIGINT, SIGHUP] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler(handler: handler)
            source.resume()
            sources.append(source)
        }
    }
}

/// Launched directly by Electron. This bridge has no TCC operations; LaunchServices
/// establishes the separate responsibility chain of the actual helper app instance.
private final class Bridge {
    private let operation: Operation
    private let channel: Channel
    private let lifetime = Lifetime()
    private var application: NSRunningApplication?
    private var stopping = false
    private var finished = false

    init(operation: Operation) throws {
        self.operation = operation
        channel = try Channel()
    }

    func start() throws {
        let bundle = try helperBundle()
        lifetime.signals { self.stop() }
        let parent = getppid()
        guard parent > 1 else { throw HelperError.invalidArguments }
        lifetime.watch(parent) { self.stop() }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.createsNewApplicationInstance = true
        configuration.allowsRunningApplicationSubstitution = false
        configuration.activates = false
        configuration.addsToRecentItems = false
        configuration.promptsUserIfNeeded = false
        configuration.environment = cleanEnvironment()
        configuration.arguments = [
            "run", "--owner-pid", String(getpid()), "--channel", channel.directory.path,
            "--token", channel.token,
        ] + operation.arguments
        NSWorkspace.shared.openApplication(at: bundle.bundleURL, configuration: configuration) { app, error in
            DispatchQueue.main.async {
                if let error = error {
                    stderr("Unable to launch CodeShell Computer Use: \(error.localizedDescription)")
                    self.finish(1)
                    return
                }
                guard let app = app else {
                    stderr("LaunchServices did not return a Computer Use application")
                    self.finish(1)
                    return
                }
                // A fast permission check may exit before this callback; macOS
                // then clears bundleURL on the returned NSRunningApplication.
                if let url = app.bundleURL,
                   url.resolvingSymlinksInPath() != bundle.bundleURL.resolvingSymlinksInPath() {
                    stderr("LaunchServices returned a different Computer Use application")
                    self.finish(1)
                    return
                }
                self.application = app
                if app.isTerminated {
                    self.applicationExited()
                } else {
                    self.lifetime.watch(app.processIdentifier) { self.applicationExited() }
                    if self.stopping { self.stopApplication() }
                }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
            if self.application == nil && !self.finished {
                stderr("Timed out launching CodeShell Computer Use")
                self.stop()
            }
        }
    }

    private func applicationExited() {
        guard !finished else { return }
        do {
            if let result = try channel.read() {
                if let error = result["error"] as? String { stderr(error) }
                if operation.isServe {
                    finish((result["exitCode"] as? NSNumber)?.int32Value ?? 1)
                } else {
                    let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
                    FileHandle.standardOutput.write(data)
                    FileHandle.standardOutput.write(Data("\n".utf8))
                    finish(result["error"] == nil ? 0 : 1)
                }
            } else {
                if !stopping { stderr("Computer Use helper exited without a result") }
                finish(stopping ? 0 : 1)
            }
        } catch {
            stderr("Invalid Computer Use helper response: \(error)")
            finish(1)
        }
    }

    private func stopApplication() {
        guard let app = application, !app.isTerminated else { return }
        // Only this exact LaunchServices result is signalled, never an app found by name.
        kill(app.processIdentifier, SIGTERM)
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            if !app.isTerminated { _ = app.forceTerminate() }
        }
    }

    private func stop() {
        stopping = true
        stopApplication()
        // If the launch callback never arrives, exiting also releases the app's owner lease.
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self.finish(0) }
    }

    private func finish(_ code: Int32) {
        guard !finished else { return }
        finished = true
        channel.clean()
        exit(code)
    }
}

/// The independently launched app owns both permission operations and the driver child.
private final class HelperApplication: NSObject, NSApplicationDelegate {
    private let operation: Operation
    private let owner: pid_t
    private let channel: Channel
    private let lifetime = Lifetime()
    private var driver: Process?
    private var driverInput: Pipe?
    private var driverErrors: Pipe?
    private var errorTail = Data()
    private let errorLock = NSLock()
    private var stopping = false

    init(arguments: [String]) throws {
        guard arguments.count >= 7, arguments[0] == "--owner-pid",
              let owner = Int32(arguments[1]), owner > 1,
              arguments[2] == "--channel", arguments[4] == "--token" else {
            throw HelperError.invalidArguments
        }
        self.owner = owner
        channel = try Channel(path: arguments[3], token: arguments[5])
        operation = try Operation(Array(arguments.dropFirst(6)))
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        lifetime.signals { self.stop() }
        lifetime.watch(owner) { self.stop() }
        if stopping { return }
        do {
            switch operation {
            case .serve(let socket): try serve(socket: socket)
            default:
                // A system permission dialog must not block lease and signal handling.
                DispatchQueue.global(qos: .userInitiated).async { self.permissions() }
            }
        } catch {
            complete(["version": 1, "exitCode": 1, "error": "Computer Use startup failed: \(error)"])
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        stop()
        return .terminateCancel
    }

    private func serve(socket: String) throws {
        let bundle = try helperBundle()
        guard let resources = bundle.resourceURL else { throw HelperError.invalidBundle }
        let process = Process()
        process.executableURL = resources.appendingPathComponent("cua-driver")
        process.arguments = ["serve", "--embedded", "--parent-liveness-stdio", "--socket", socket, "--pid-file", channel.directory.appendingPathComponent("driver.pid").path]
        process.environment = cleanEnvironment()
        let input = Pipe()
        driverInput = input
        process.standardInput = input
        process.standardOutput = FileHandle.nullDevice
        let errors = Pipe()
        driverErrors = errors
        process.standardError = errors
        errors.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            self.errorLock.lock()
            self.errorTail.append(data)
            if self.errorTail.count > 16_384 { self.errorTail.removeFirst(self.errorTail.count - 16_384) }
            self.errorLock.unlock()
        }
        process.terminationHandler = { child in
            DispatchQueue.main.async {
                self.errorLock.lock()
                let tail = String(data: self.errorTail, encoding: .utf8) ?? ""
                self.errorLock.unlock()
                var result: [String: Any] = ["version": 1, "exitCode": self.stopping ? 0 : child.terminationStatus]
                if !self.stopping && child.terminationStatus != 0 && !tail.isEmpty { result["error"] = tail }
                self.complete(result)
            }
        }
        driver = process
        try process.run()
        // Only the helper retains the write end. Even SIGKILL produces EOF in the
        // driver's parent-liveness reader, so an orphan cannot keep controlling apps.
        try? input.fileHandleForReading.close()
    }

    private func permissions() {
        var requested = false
        switch operation {
        case .accessibility:
            requested = true
            _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        case .screenRecording:
            requested = true
            _ = CGRequestScreenCaptureAccess()
        default: break
        }
        let result: [String: Any] = [
            "version": 1,
            "requested": requested,
            "accessibility": AXIsProcessTrusted(),
            "screenRecording": CGPreflightScreenCaptureAccess(),
        ]
        DispatchQueue.main.async { self.complete(result) }
    }

    private func stop() {
        guard !stopping else { return }
        stopping = true
        try? driverInput?.fileHandleForWriting.close()
        guard let child = driver, child.isRunning else { complete(["version": 1, "exitCode": 0]); return }
        child.terminate()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            if child.isRunning { kill(child.processIdentifier, SIGKILL) }
        }
    }

    private func complete(_ value: [String: Any]) {
        driverErrors?.fileHandleForReading.readabilityHandler = nil
        do { try channel.write(value) }
        catch { stderr("Unable to return Computer Use result: \(error)") }
        exit(0)
    }
}

#if !COMPUTER_USE_NATIVE_TESTS
@main
struct CodeShellComputerUse {
    static func main() {
        let arguments = Array(CommandLine.arguments.dropFirst())
        if arguments == ["--version"] { print(helperVersion); return }
        do {
            _ = try helperBundle()
            if arguments.first == "launch" {
                let bridge = try Bridge(operation: Operation(Array(arguments.dropFirst())))
                try bridge.start()
                withExtendedLifetime(bridge) { RunLoop.main.run() }
            } else if arguments.first == "run" {
                let delegate = try HelperApplication(arguments: Array(arguments.dropFirst()))
                let application = NSApplication.shared
                application.setActivationPolicy(.accessory)
                application.delegate = delegate
                withExtendedLifetime(delegate) { application.run() }
            } else {
                throw HelperError.invalidArguments
            }
        } catch { fail("CodeShell Computer Use: \(error)", code: 64) }
    }
}

#else
/// Compiled only by smoke-computer-use-helper.py. No test command is exposed by
/// the shipped application, and every test runs in a disposable working folder.
@main
struct ComputerUseNativeTests {
    static func check(_ condition: @autoclosure () -> Bool, _ description: String) {
        if !condition() { fail("Native channel regression: " + description) }
    }

    static func main() throws {
        let working = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        let sentinel = working.appendingPathComponent("keep-cwd-sentinel")
        try Data("preserve".utf8).write(to: sentinel)
        for invalid in ["", ".", "../", "/does-not-exist-codeshell-channel"] {
            do {
                let channel = try Channel(path: invalid, token: UUID().uuidString)
                channel.clean()
                fail("Invalid channel path was accepted: " + invalid)
            } catch HelperError.invalidChannel {}
        }
        check(FileManager.default.fileExists(atPath: sentinel.path), "invalid path removed cwd sentinel")
        let channel = try Channel()
        check(channel.directory != working, "mkdtemp resolved to the working directory")
        check(channel.directory.lastPathComponent.hasPrefix("cs-cua-launch-"), "channel has no private name")
        try channel.write(["version": 1, "requested": false])
        let result = try channel.read()
        check((result?["version"] as? Int) == 1, "completion did not round trip")
        channel.clean()
        check(!FileManager.default.fileExists(atPath: channel.directory.path), "owned channel was not removed")
        check(FileManager.default.fileExists(atPath: sentinel.path), "owned cleanup removed cwd sentinel")

        let retained = try Channel()
        let unrelated = retained.directory.appendingPathComponent("keep-unrelated")
        try Data("preserve".utf8).write(to: unrelated)
        retained.clean()
        check(FileManager.default.fileExists(atPath: unrelated.path), "cleanup removed an unrelated file")
        unlink(unrelated.path)
        retained.clean()
        check(!FileManager.default.fileExists(atPath: retained.directory.path), "empty retained channel was not removed")

        let replaced = try Channel()
        let moved = replaced.directory.appendingPathExtension("saved")
        check(rename(replaced.directory.path, moved.path) == 0, "could not move owned channel")
        check(mkdir(replaced.directory.path, 0o700) == 0, "could not create replacement inode")
        let replacementToken = replaced.directory.appendingPathComponent("token")
        try Data("replacement".utf8).write(to: replacementToken)
        replaced.clean()
        check(FileManager.default.fileExists(atPath: replacementToken.path), "cleanup removed a replacement inode's files")
        unlink(replacementToken.path)
        rmdir(replaced.directory.path)
        check(rename(moved.path, replaced.directory.path) == 0, "could not restore owned channel")
        replaced.clean()

        let linked = try Channel()
        let original = linked.directory.appendingPathExtension("saved")
        let target = try Channel()
        check(rename(linked.directory.path, original.path) == 0, "could not move symlink-test channel")
        check(symlink(target.directory.path, linked.directory.path) == 0, "could not install test symlink")
        linked.clean()
        check(FileManager.default.fileExists(atPath: target.directory.appendingPathComponent("token").path), "cleanup followed a symlink")
        unlink(linked.directory.path)
        check(rename(original.path, linked.directory.path) == 0, "could not restore symlink-test channel")
        linked.clean()
        target.clean()
        check(FileManager.default.fileExists(atPath: sentinel.path), "final cwd sentinel is missing")
        print("Native channel regressions passed")
    }
}
#endif
