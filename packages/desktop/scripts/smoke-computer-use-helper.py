#!/usr/bin/env python3
"""Exercise native launch identity and lifetime without requesting OS permissions.

All compiler outputs, cwd, HOME, and TMPDIR are isolated in one fresh directory.
The driver is an inert stdin-lease fixture: no screenshots or UI actions occur.
Run on macOS: python3 packages/desktop/scripts/smoke-computer-use-helper.py
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import plistlib
import signal
import subprocess
import sys
import tempfile
import time

SOURCE = Path(__file__).resolve().parents[1] / "src/main/computer-use/native/computer-use.swift"
BUNDLE_ID = "com.cjhyy.codeshell.computer-use"
STUB = r'''
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
int main(int argc, char **argv) {
    const char *socket = NULL;
    int lease = 0;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--socket") && i + 1 < argc) socket = argv[++i];
        else if (!strcmp(argv[i], "--parent-liveness-stdio")) lease = 1;
    }
    if (!socket || !lease) return 64;
    signal(SIGTERM, SIG_IGN); // EOF, not cooperative termination, must release this fixture.
    char path[1024];
    snprintf(path, sizeof(path), "%s.receipt", socket);
    FILE *file = fopen(path, "w");
    if (!file) return 70;
    fprintf(file, "pid=%d\nparent=%d\nbundle=%s\nmode=%s\nsecret=%s\n", getpid(), getppid(),
        getenv("CUA_DRIVER_HOST_BUNDLE_ID") ?: "", getenv("CUA_DRIVER_PERMISSION_MODE") ?: "",
        getenv("CODESHELL_NATIVE_SMOKE_SECRET") ?: "");
    fclose(file);
    char byte;
    while (read(STDIN_FILENO, &byte, 1) > 0) {}
    return 0;
}
'''


def wait_until(check, description, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(0.05)
    raise AssertionError("Timed out: " + description)


def exited(pid):
    result = subprocess.run(["/bin/ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True)
    return result.returncode != 0 or result.stdout.strip().startswith("Z")


def main():
    if sys.platform != "darwin":
        raise SystemExit("Native Computer Use smoke requires macOS")
    # Resolve the source before changing directory, then make the test parent
    # itself disposable. Never run a native fixture with a repository as cwd.
    original_cwd = Path.cwd()
    with tempfile.TemporaryDirectory(prefix="codeshell-native-smoke-", dir="/tmp") as folder:
        root = Path(folder).resolve()
        for name in ["home", "tmp", "work"]:
            (root / name).mkdir(mode=0o700)
        os.chdir(root / "work")
        environment = {
            "PATH": "/usr/bin:/bin",
            "HOME": str(root / "home"),
            "TMPDIR": str(root / "tmp") + "/",
            "LANG": "en_US.UTF-8",
            "CODESHELL_NATIVE_SMOKE_SECRET": "must-not-reach-driver",
        }
        print(json.dumps({"cwd": str(Path.cwd()), "HOME": environment["HOME"],
                          "TMPDIR": environment["TMPDIR"], "test": "no permission requests or UI actions"}), flush=True)

        def run(args, **options):
            return subprocess.run(args, cwd=root / "work", env=environment, check=True,
                                  capture_output=True, text=True, timeout=120, **options)

        app = root / "CodeShell Computer Use.app"
        executable = app / "Contents/MacOS/codeshell-computer-use"
        resources = app / "Contents/Resources"
        executable.parent.mkdir(parents=True)
        resources.mkdir()
        (app / "Contents/Info.plist").write_bytes(plistlib.dumps({
            "CFBundleIdentifier": BUNDLE_ID,
            "CFBundleExecutable": executable.name,
            "CFBundleName": "CodeShell Computer Use",
            "CFBundleDisplayName": "CodeShell Computer Use",
            "CFBundlePackageType": "APPL",
            "CFBundleVersion": "1",
            "CFBundleShortVersionString": "1.0",
            "LSUIElement": True,
            "NSPrincipalClass": "NSApplication",
            "LSMinimumSystemVersion": "11.0",
        }))
        channel_tests = root / "channel-tests"
        run(["/usr/bin/xcrun", "swiftc", "-O", "-parse-as-library", "-D", "COMPUTER_USE_NATIVE_TESTS",
             str(SOURCE), "-o", str(channel_tests)])
        print(run([str(channel_tests)]).stdout.strip(), flush=True)
        run(["/usr/bin/xcrun", "swiftc", "-O", "-parse-as-library", str(SOURCE), "-o", str(executable)])
        stub = root / "driver.c"
        stub.write_text(STUB)
        run(["/usr/bin/xcrun", "clang", str(stub), "-o", str(resources / "cua-driver")])
        run(["/usr/bin/codesign", "--force", "--sign", "-", str(resources / "cua-driver")])
        run(["/usr/bin/codesign", "--force", "--sign", "-", str(app)])
        run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(app)])

        for _ in range(2):
            result = json.loads(run([str(executable), "launch", "status"]).stdout)
            assert result["version"] == 1 and result["requested"] is False, result
            assert isinstance(result["accessibility"], bool) and isinstance(result["screenRecording"], bool), result
            assert not list((root / "tmp").glob("cs-cua-launch-*")), "status leaked its channel"
            print("Permission status: " + json.dumps(result, sort_keys=True), flush=True)
        print("LaunchServices permission status passed (no prompt requested)", flush=True)

        for termination in ["bridge-term", "bridge-kill", "app-kill"]:
            socket = root / "work" / (termination + ".sock")
            receipt = Path(str(socket) + ".receipt")
            with subprocess.Popen([str(executable), "launch", "serve", "--socket", str(socket)],
                                  cwd=root / "work", env=environment,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) as bridge:
                try:
                    def complete_receipt():
                        try:
                            text = receipt.read_text()
                            values = dict(line.split("=", 1) for line in text.splitlines())
                            if text.endswith("\n") and set(values) == {"pid", "parent", "bundle", "mode", "secret"}:
                                return values
                        except (FileNotFoundError, ValueError):
                            pass
                        return None

                    values = wait_until(complete_receipt, termination + " complete driver receipt")
                    driver_pid = int(values["pid"])
                    app_pid = int(values["parent"])
                    assert values["bundle"] == BUNDLE_ID and values["mode"] == "standard", values
                    assert values["secret"] == "", values
                    if termination == "bridge-term":
                        bridge.terminate()
                    elif termination == "bridge-kill":
                        bridge.kill()
                    else:
                        os.kill(app_pid, signal.SIGKILL)
                    stdout, stderr = bridge.communicate(timeout=10)
                    wait_until(lambda: exited(driver_pid), termination + " driver exit")
                    wait_until(lambda: exited(app_pid), termination + " helper exit")
                    if termination == "bridge-term":
                        assert bridge.returncode == 0, (bridge.returncode, stdout, stderr)
                    elif termination == "app-kill":
                        assert bridge.returncode != 0, (bridge.returncode, stdout, stderr)
                    print(termination + " passed; helper and driver exited", flush=True)
                finally:
                    if bridge.poll() is None:
                        bridge.terminate()
                        try:
                            bridge.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            bridge.kill()
                            bridge.wait(timeout=5)
        # A SIGKILLed bridge cannot remove its own tiny response directory; the
        # surrounding disposable root owns any such residue. No other path is used.
        assert (root / "work/keep-cwd-sentinel").read_text() == "preserve"
        os.chdir(original_cwd)
    print("Native Computer Use smoke passed", flush=True)


if __name__ == "__main__":
    main()
