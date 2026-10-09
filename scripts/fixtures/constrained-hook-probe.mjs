/* Executes inside the actual contained runtime; no JavaScript network mocks. */
/* global HOST_CANARY_PATH */
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import dgram from "node:dgram";
import { spawnSync } from "node:child_process";
const canary = HOST_CANARY_PATH;
const checks = {};
const attempt = (fn) => {
  try {
    fn();
    return { denied: false };
  } catch (error) {
    return {
      denied: ["EPERM", "EACCES", "EROFS", "ENOENT"].includes(error.code),
      code: error.code,
    };
  }
};
checks.approvedRead =
  fs.readFileSync("/resources/inputs/approved.txt", "utf8") === "synthetic approved hook input";
fs.writeFileSync("/scratch/allowed.txt", "private scratch");
checks.privateWrite = fs.readFileSync("/scratch/allowed.txt", "utf8") === "private scratch";
checks.inputWrite = attempt(() => fs.writeFileSync("/resources/inputs/approved.txt", "wrong"));
checks.rootWrite = attempt(() => fs.writeFileSync("/var/wrong.txt", "wrong"));
checks.unmountedHostRead = attempt(() => fs.readFileSync(canary));
checks.unmountedHostWrite = attempt(() => fs.writeFileSync(canary, "wrong"));
checks.hostCredentialDirectoriesAbsent = [
  "/Users/admin",
  "/var/run/docker.sock",
  "/Users/admin/.docker/run/docker.sock",
  "/run/user/501",
].every((path) => !fs.existsSync(path));
checks.operatorEnvironmentAbsent = [
  "CODESHELL_PROBE_CANARY",
  "SSH_AUTH_SOCK",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NODE_OPTIONS",
  "BASH_ENV",
  "ENV",
  "LD_PRELOAD",
  "DYLD_INSERT_LIBRARIES",
].every((key) => process.env[key] === undefined);
const fdTargets = fs.readdirSync("/proc/self/fd").map((fd) => {
  try {
    return { fd: Number(fd), target: fs.readlinkSync(`/proc/self/fd/${fd}`) };
  } catch {
    return { fd: Number(fd), closed: true };
  }
});
checks.noInheritedCanaryFd = !fdTargets.some((row) => row.target === canary);
checks.noSocketFd = !fdTargets.some((row) => row.target?.startsWith("socket:"));
for (const [name, options] of [
  ["tcp4", { host: "127.0.0.1", port: 9 }],
  ["tcp6", { host: "::1", port: 9 }],
  ["unixConnect", { path: "/scratch/nonexistent.sock" }],
])
  checks[name] = await new Promise((resolve) => {
    const socket = net.connect(options);
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("error", (error) =>
      finish({ denied: ["EPERM", "EACCES"].includes(error.code), code: error.code }),
    );
    socket.once("connect", () => finish({ denied: false }));
    socket.setTimeout(1000, () => finish({ denied: false, timeout: true }));
  });
for (const [name, options] of [
  ["tcpListen", { host: "127.0.0.1", port: 0 }],
  ["unixListen", { path: "/scratch/listener.sock" }],
])
  checks[name] = await new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (error) =>
      resolve({ denied: ["EPERM", "EACCES"].includes(error.code), code: error.code }),
    );
    server.listen(options, () => server.close(() => resolve({ denied: false })));
  });
for (const [name, type, address] of [
  ["udp4", "udp4", "127.0.0.1"],
  ["udp6", "udp6", "::1"],
])
  checks[name] = await new Promise((resolve) => {
    const socket = dgram.createSocket(type);
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      try {
        socket.close();
      } catch {}
      resolve({ denied: ["EPERM", "EACCES"].includes(error?.code), code: error?.code });
    };
    socket.once("error", finish);
    socket.send(Buffer.from("synthetic"), 53, address, finish);
  });
const captured = spawnSync(process.execPath, ["--version"], { encoding: "utf8", timeout: 1000 });
checks.capturedChild = { success: captured.status === 0, error: captured.error?.code };
const inherited = spawnSync(process.execPath, ["--version"], {
  stdio: ["ignore", "inherit", "inherit"],
  timeout: 1000,
});
checks.inheritedChild = { success: inherited.status === 0, error: inherited.error?.code };
const failed = Object.entries(checks).filter(
  ([key, value]) =>
    !["capturedChild", "inheritedChild"].includes(key) &&
    (typeof value === "boolean" ? !value : !value.denied),
);
console.log(
  JSON.stringify({
    node: process.version,
    pid: process.pid,
    ppid: process.ppid,
    uid: process.getuid(),
    home: os.homedir(),
    cwd: process.cwd(),
    checks,
    fdTargets,
    status: fs.readFileSync("/proc/self/status", "utf8"),
    failed,
  }),
);
if (failed.length) process.exitCode = 1;
