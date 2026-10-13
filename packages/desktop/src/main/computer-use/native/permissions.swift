import CoreGraphics
import Foundation

// Kept outside ASAR and signed with the application. Electron must launch this
// executable directly so macOS attributes the request to the host application.
// No screenshots, network, credentials, or Cua actions are performed here.
@main
struct CodeShellPermissions {
    static func main() {
        let arguments = Array(CommandLine.arguments.dropFirst())
        if arguments == ["--version"] {
            print("codeshell-permissions 1")
            return
        }
        guard arguments == ["request-screen-recording"] else {
            FileHandle.standardError.write(Data("Unsupported permission operation\n".utf8))
            exit(64)
        }
        if #available(macOS 10.15, *) {
            let granted = CGRequestScreenCaptureAccess()
            print("{\"version\":1,\"requested\":true,\"screenRecording\":\(granted)}")
        } else {
            FileHandle.standardError.write(Data("Screen recording permissions require macOS 10.15\n".utf8))
            exit(69)
        }
    }
}
