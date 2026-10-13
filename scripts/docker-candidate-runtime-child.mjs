// Resolve only reviewed fixture entries inside the pinned project image/volumes.
import { basename } from "node:path";
import { realpathSync } from "node:fs";
import { candidateFile, candidateHash } from "./docker-candidate-guard.mjs";
import { validateCandidateNativeArguments } from "./docker-candidate-native-argv.mjs";

const deny = () => {
  throw new Error("Docker candidate refused an unreviewed runtime child");
};
export function candidateRuntimeChild(config, command, args, options) {
  if (
    !config.runtime ||
    !Array.isArray(args) ||
    args.length > 96 ||
    args.some((arg) => typeof arg !== "string" || arg.length > 8192 || /[\0\r\n]/.test(arg)) ||
    options.shell
  )
    deny();
  const approvedAlias =
    command === "node"
      ? process.execPath
      : config.runtime.nativePrograms?.find((value) => basename(value.path) === command)?.path;
  const path = realpathSync(command.startsWith("/") ? command : (approvedAlias ?? deny()));
  const pin = candidateFile(path, { maximum: 128 * 1024 * 1024 });
  const cwd = realpathSync(options.cwd ?? process.cwd());
  if (!["/workspace", "/tmp", "/data"].some((root) => cwd === root || cwd.startsWith(root + "/")))
    deny();
  if (path === realpathSync(process.execPath)) {
    const node = {
      path,
      sha256: pin.sha256,
      args,
      cwd,
      reinject: true,
      allowDetached: true,
      role: "installer",
    };
    if (config.runtime.offline === "none" && args[0] === config.runtime.recoveryEntry) {
      if (
        !args[0].startsWith("/opt/codeshell/") ||
        !["inspect", "repair", "restore"].includes(args[1]) ||
        args.at(-2) !== "--project" ||
        args.at(-1) !== "/workspace" ||
        args.length > 14
      )
        deny();
      return {
        ...node,
        entry: args[0],
        entryHash: candidateFile(args[0]).sha256,
        allowDetached: false,
      };
    }
    if (args.length === 1 && args[0] === config.runtime.workerEntry) {
      const entry = realpathSync(args[0]);
      if (
        !entry.startsWith("/opt/codeshell/") ||
        !entry.endsWith("/dist/cli/agent-server-stdio.js")
      )
        deny();
      return {
        ...node,
        entry,
        entryHash: candidateFile(entry).sha256,
        allowDetached: false,
        role: "worker",
      };
    }
    if (
      args.length === 2 &&
      args[0] === "-e" &&
      config.runtime.inlinePrograms?.includes(candidateHash(args[1]))
    )
      return node;
    if (!args[0]?.startsWith("/") || args[0].includes("/../")) deny();
    const entry = realpathSync(args[0]);
    if (
      ![`${config.home}/.code-shell/panel-apps/`, "/workspace/"].some((root) =>
        entry.startsWith(root),
      )
    )
      deny();
    const entryHash = candidateFile(entry).sha256;
    if (!config.runtime.entryHashes?.includes(entryHash)) deny();
    return {
      ...node,
      entry,
      entryHash,
      role: entry === "/workspace/model-fixture.mjs" ? "model" : "installer",
    };
  }
  // These immutable image programs execute only after the namespace ACK. Their
  // binary bytes, bounded argv, owned cwd and network addresses are checked;
  // arbitrary native interpreters and shells are never admitted.
  const native = config.runtime.nativePrograms?.find((value) => value.path === path);
  if (
    !native ||
    native.sha256 !== pin.sha256 ||
    !["ffmpeg", "ffprobe", "whisper-server", "yt-dlp", "chromium"].includes(basename(path))
  )
    deny();
  validateCandidateNativeArguments(path, args, cwd);
  for (const arg of args) {
    const urls = arg.match(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s]+/g) ?? [];
    for (const url of urls) if (!config.origins.includes(new URL(url).origin)) deny();
  }
  return {
    path,
    sha256: pin.sha256,
    args,
    cwd,
    reinject: true,
    allowDetached: true,
    role: "installer",
  };
}
