/** Explicit local-only WER dump copy. No system WER discovery or registry changes. */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const WER_DUMP_LIMITS = Object.freeze({
  files: 4,
  fileBytes: 64 * 1024 * 1024,
  outputBytes: 256 * 1024 * 1024,
  manifestBytes: 64 * 1024,
  entries: 128,
  nameBytes: 255,
  listedNameBytes: 16 * 1024,
  ancestors: 64,
  pathChars: 4096,
  chunkBytes: 64 * 1024,
  readBytes: 512 * 1024 * 1024,
});
// Windows EXE names are matched case-insensitively, even on a case-sensitive host.
// Product/Setup basis: ../package.json build.productName and build.nsis.artifactName.
const DUMP_NAME = /^(code-shell|electron|code-shell-Setup-[\w.-]+)\.exe\.\d+\.dmp$/i;
const MANIFEST = "wer-dumps.json";
const sameIdentity = (a, b) => ["dev", "ino", "mode"].every((key) => a[key] === b[key]);
const sameFile = (a, b) =>
  sameIdentity(a, b) && ["size", "mtimeNs", "ctimeNs"].every((key) => a[key] === b[key]);
const plainDirectory = (info) => info.isDirectory() && !info.isSymbolicLink();
const plainFile = (info) => info.isFile() && !info.isSymbolicLink();
const samePath = (a, b) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const refuse = () => {
  throw Error("WER evidence refused; no successful collection claimed");
};

/** Mirrors the reviewed NSIS ancestor checks and composer same-fd guard reader.
 * Portable Node checks detect observed identity changes; not a kernel race sandbox.
 * The caller supplies existing plain directories (including plain ancestors). */
export function collectWerDumpEvidence({ source, output }, { io = fs } = {}) {
  const limits = WER_DUMP_LIMITS;
  const created = [];
  let directory,
    manifestFd,
    sourcePin,
    readBytes = 0;
  const pins = new Map();
  const stat = (path) => io.lstatSync(path, { bigint: true });
  const pinDirectory = (path) => {
    for (let current = path, depth = 0; ; current = dirname(current), depth++) {
      if (depth === limits.ancestors) refuse();
      const info = stat(current);
      if (!plainDirectory(info)) refuse();
      if (pins.has(current) && !sameIdentity(pins.get(current), info)) refuse();
      pins.set(current, info);
      if (dirname(current) === current) break;
    }
    if (
      !samePath(io.realpathSync.native ? io.realpathSync.native(path) : io.realpathSync(path), path)
    )
      refuse();
  };
  const checkDirectories = () => {
    for (const [path, before] of pins) {
      const after = stat(path);
      if (!plainDirectory(after) || !sameIdentity(before, after)) refuse();
    }
    // Source enumeration and bytes must describe one unchanged directory view.
    if (sourcePin && !sameFile(sourcePin, stat(source))) refuse();
  };
  const absent = (path) => {
    try {
      stat(path);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    refuse();
  };
  const newOutput = (name) => {
    checkDirectories();
    const path = join(output, name);
    const fd = io.openSync(
      path,
      fs.constants.O_RDWR |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    // Keep ownership/descriptor even if subsequent checks fail, for private cleanup.
    const item = { path, fd, info: null };
    created.push(item);
    item.info = io.fstatSync(fd, { bigint: true });
    if (!plainFile(item.info) || item.info.nlink !== 1n || item.info.size !== 0n) refuse();
    checkDirectories();
    const current = stat(path);
    if (!plainFile(current) || !sameIdentity(item.info, current)) refuse();
    return item;
  };
  const write = (fd, buffer) => {
    let offset = 0;
    while (offset < buffer.length) {
      const count = io.writeSync(fd, buffer, offset, buffer.length - offset);
      if (!Number.isSafeInteger(count) || count <= 0 || count > buffer.length - offset) refuse();
      offset += count;
    }
  };
  const read = (fd, buffer, wanted, position) => {
    const count = io.readSync(fd, buffer, 0, wanted, position);
    if (!Number.isSafeInteger(count) || count < 0 || count > wanted) refuse();
    readBytes += count;
    if (readBytes > limits.readBytes) refuse();
    return count;
  };
  const verifyOutput = (item, size, expectedHash, expectedBytes) => {
    const before = io.fstatSync(item.fd, { bigint: true });
    if (
      !plainFile(before) ||
      before.nlink !== 1n ||
      before.size !== BigInt(size) ||
      !sameIdentity(item.info, before)
    )
      refuse();
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(limits.chunkBytes);
    for (let position = 0; position < size; ) {
      const count = read(item.fd, buffer, Math.min(buffer.length, size - position), position);
      if (!count) refuse();
      const chunk = buffer.subarray(0, count);
      hash.update(chunk);
      if (expectedBytes && !chunk.equals(expectedBytes.subarray(position, position + count)))
        refuse();
      position += count;
    }
    if (
      read(item.fd, buffer, 1, size) !== 0 ||
      (expectedHash && hash.digest("hex") !== expectedHash)
    )
      refuse();
    const after = io.fstatSync(item.fd, { bigint: true }),
      current = stat(item.path);
    if (
      !plainFile(current) ||
      current.nlink !== 1n ||
      after.nlink !== 1n ||
      !sameFile(before, after) ||
      !sameFile(after, current)
    )
      refuse();
    return after;
  };
  try {
    for (const path of [source, output])
      if (
        typeof path !== "string" ||
        !path ||
        path.length > limits.pathChars ||
        /[\0\r\n]/.test(path) ||
        !isAbsolute(path) ||
        resolve(path) !== path
      )
        refuse();
    // Refuse equal/nested scopes, including Windows case aliases.
    const folded = (path) => (process.platform === "win32" ? path.toLowerCase() : path);
    const inside = (a, b) => {
      const part = relative(folded(a), folded(b));
      return !part || (!part.startsWith(".." + sep) && part !== ".." && !isAbsolute(part));
    };
    if (inside(source, output) || inside(output, source)) refuse();
    pinDirectory(source);
    pinDirectory(output);
    sourcePin = stat(source);
    const outputPin = stat(output);
    if (sourcePin.dev === outputPin.dev && sourcePin.ino === outputPin.ino) refuse();
    const report = {
      schemaVersion: 1,
      dumps: [],
      skipped: [],
      truncated: false,
      reasons: [],
      limits,
      boundary:
        "Explicit local synthetic-or-user-supplied files only; sensitive memory remains local. No WER discovery, registry, network, upload or native-fault/root-cause claim. Total output includes a reserved manifest budget. Node 0o600 is not a Windows ACL; portable identity checks are not a kernel race sandbox.",
    };
    const truncate = (reason) => {
      report.truncated = true;
      if (!report.reasons.includes(reason)) report.reasons.push(reason);
    };
    const names = [];
    let listedBytes = 0;
    directory = io.opendirSync(source, { bufferSize: 1 });
    checkDirectories();
    for (let count = 0; ; count++) {
      const entry = directory.readSync();
      if (!entry) break;
      if (count === limits.entries) {
        truncate("entry-limit");
        break;
      }
      const name = entry.name;
      if (
        typeof name !== "string" ||
        !name ||
        /[\\/\0]/.test(name) ||
        name === "." ||
        name === ".."
      )
        refuse();
      const bytes = Buffer.byteLength(name);
      if (bytes > limits.nameBytes) {
        truncate("name-limit");
        continue;
      }
      if (listedBytes + bytes > limits.listedNameBytes) {
        truncate("listed-name-limit");
        break;
      }
      listedBytes += bytes;
      // '$' can match before a final newline: require the match to consume all bytes.
      const match = DUMP_NAME.exec(name);
      if (match && match[0] === name) names.push(name);
    }
    directory.closeSync();
    directory = undefined;
    checkDirectories();
    names.sort(); // Only the bounded enumerated subset is sorted, never the whole directory.
    const foldedNames = new Set();
    const candidates = names.map((name) => {
      if (foldedNames.has(name.toLowerCase())) refuse();
      foldedNames.add(name.toLowerCase());
      const info = stat(join(source, name));
      if (!plainFile(info) || info.size < 0n || info.size > BigInt(Number.MAX_SAFE_INTEGER))
        refuse();
      return { name, info, size: Number(info.size) };
    });
    // Unknown existing files are never overwritten, including an old manifest.
    absent(join(output, MANIFEST));
    for (const { name } of candidates) absent(join(output, name));
    let payloadBytes = 0;
    for (const { name, info, size } of candidates) {
      const reason =
        size > limits.fileBytes
          ? "file-size-limit"
          : report.dumps.length === limits.files
            ? "file-count-limit"
            : payloadBytes + size > limits.outputBytes - limits.manifestBytes
              ? "total-output-limit"
              : null;
      if (reason) {
        truncate(reason);
        report.skipped.push({ name, size, reason });
        continue;
      }
      checkDirectories();
      const path = join(source, name);
      const fd = io.openSync(
        path,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
      );
      try {
        const opened = io.fstatSync(fd, { bigint: true });
        if (!plainFile(opened) || !sameFile(info, opened) || !sameFile(opened, stat(path)))
          refuse();
        checkDirectories();
        const target = newOutput(name);
        const hash = createHash("sha256");
        const buffer = Buffer.alloc(limits.chunkBytes);
        for (let position = 0; position < size; ) {
          const wanted = Math.min(buffer.length, size - position);
          const count = read(fd, buffer, wanted, position);
          if (!count) refuse();
          const chunk = buffer.subarray(0, count);
          hash.update(chunk);
          write(target.fd, chunk);
          position += count;
        }
        if (read(fd, buffer, 1, size) !== 0) refuse();
        const after = io.fstatSync(fd, { bigint: true }),
          current = stat(path);
        if (!plainFile(current) || !sameFile(opened, after) || !sameFile(after, current)) refuse();
        checkDirectories();
        const sha256 = hash.digest("hex");
        target.completed = verifyOutput(target, size, sha256);
        if (!sameFile(opened, io.fstatSync(fd, { bigint: true })) || !sameFile(opened, stat(path)))
          refuse();
        payloadBytes += size;
        report.dumps.push({
          name,
          size,
          sha256,
          mtime: new Date(Number(opened.mtimeMs)).toISOString(),
        });
      } finally {
        io.closeSync(fd);
      }
    }
    const checkCompleted = () => {
      for (const item of created) {
        if (!item.completed) continue;
        const opened = io.fstatSync(item.fd, { bigint: true }),
          current = stat(item.path);
        if (
          !plainFile(opened) ||
          !plainFile(current) ||
          opened.nlink !== 1n ||
          current.nlink !== 1n ||
          !sameFile(item.completed, opened) ||
          !sameFile(opened, current)
        )
          refuse();
      }
    };
    checkDirectories();
    checkCompleted();
    const manifest = Buffer.from(JSON.stringify(report, null, 2) + "\n");
    if (
      manifest.length > limits.manifestBytes ||
      payloadBytes + manifest.length > limits.outputBytes
    )
      refuse();
    const target = newOutput(MANIFEST);
    manifestFd = target.fd;
    write(target.fd, manifest);
    verifyOutput(target, manifest.length, null, manifest);
    checkDirectories();
    checkCompleted();
    const final = io.fstatSync(target.fd, { bigint: true });
    if (final.size !== BigInt(manifest.length) || !sameFile(final, stat(target.path))) refuse();
    // All retained destination fds are closed only once the manifest is verified.
    for (const item of created) {
      io.closeSync(item.fd);
      item.fd = undefined;
    }
    return report;
  } catch {
    // Invalidate a written manifest through its fd even if its directory moved.
    if (manifestFd !== undefined) {
      try {
        io.ftruncateSync(manifestFd, 0);
      } catch {
        /* fd may already be closed */
      }
    }
    for (const item of created.reverse()) {
      if (item.fd !== undefined) {
        try {
          io.closeSync(item.fd);
        } catch {
          /* preserve refusal */
        }
      }
      try {
        const current = stat(item.path);
        if (item.info && plainFile(current) && sameIdentity(item.info, current))
          io.unlinkSync(item.path);
      } catch {
        /* Never remove an unknown/replaced path. */
      }
    }
    refuse();
  } finally {
    if (directory) {
      try {
        directory.closeSync();
      } catch {
        /* preserve refusal */
      }
    }
  }
}

const HELP =
  "Usage: node windows-wer-dump-evidence.mjs --source <absolute-directory> --output <absolute-directory>\nBoth directories must already exist with plain ancestors. Dumps contain sensitive memory; default is local only, no network or upload. Source is read-only. New files request mode 0o600; this is not a Windows ACL. Use a private Windows directory/ACL. No fault root-cause claim.";
export function runWerDumpEvidenceCli(
  argv,
  { collect = collectWerDumpEvidence, print = console.log } = {},
) {
  if (argv.length === 1 && argv[0] === "--help") {
    print(HELP);
    return 0;
  }
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index],
      value = argv[index + 1];
    if (
      !["--source", "--output"].includes(key) ||
      options.has(key) ||
      typeof value !== "string" ||
      !value ||
      value.startsWith("--")
    ) {
      print(HELP);
      return 1;
    }
    options.set(key, value);
  }
  if (options.size !== 2) {
    print(HELP);
    return 1;
  }
  try {
    const report = collect({ source: options.get("--source"), output: options.get("--output") });
    print(
      `Local WER evidence: ${report.dumps.length} dump(s); truncated=${report.truncated}. Sensitive memory remains local.`,
    );
    return 0;
  } catch {
    print(
      "WER evidence refused; inspect explicit private directories locally. No successful collection claimed.",
    );
    return 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runWerDumpEvidenceCli(process.argv.slice(2));
