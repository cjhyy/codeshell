/** Narrow custody for this fixture's hdiutil commands, never a general mount helper. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export function isInside(parent, child) {
  const part = relative(parent, child);
  return Boolean(part && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

export function ownedImageFromInfo(info, image) {
  assert.ok(
    Array.isArray(info.images) && info.images.length < 1024,
    "Invalid hdiutil image metadata",
  );
  // Do not stat, resolve symlinks, or retain metadata for anybody else's image.
  const matches = info.images.filter((row) => row["image-path"] === image);
  assert.ok(matches.length <= 1, "Ambiguous owned disk image");
  if (!matches.length) return null;
  const entities = matches[0]["system-entities"];
  assert.ok(Array.isArray(entities) && entities.length < 64, "Invalid owned image entities");
  const devices = entities.map((row) => row["dev-entry"]).filter(Boolean);
  assert.ok(
    devices.length && devices.every((device) => /^\/dev\/disk\d+(?:s\d+)*$/.test(device)),
    "Invalid owned image device",
  );
  const mounts = entities.map((row) => row["mount-point"]).filter(Boolean);
  assert.equal(mounts.length, 1, "One owned image volume must be mounted");
  assert.ok(isAbsolute(mounts[0]), "Invalid owned mountpoint");
  return { image, devices, mountpoint: mounts[0] };
}

export function assertOwnedReadonlyVolume(volume, attachment) {
  assert.equal(volume.MountPoint, attachment.mountpoint, "Readonly mountpoint changed");
  assert.ok(attachment.devices.includes(volume.DeviceNode), "Foreign readonly volume device");
  assert.equal(volume.BusProtocol, "Disk Image", "Expected the owned mounted disk image");
  // Actual diskutil info -plist uses Writable* booleans, not ReadOnlyVolume.
  // Missing fields never count as readonly evidence.
  for (const key of ["Writable", "WritableVolume", "WritableMedia"])
    assert.equal(volume[key], false, `The actual mounted ${key} must be false`);
  return {
    mountpoint: volume.MountPoint,
    deviceNode: volume.DeviceNode,
    writable: volume.Writable,
    writableVolume: volume.WritableVolume,
    writableMedia: volume.WritableMedia,
  };
}

export function authorizeDmgCommand(
  args,
  state,
  {
    exists = (path) => {
      try {
        lstatSync(path);
        return true;
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    },
    canonicalParent = (path) => realpathSync(dirname(path)),
  } = {},
) {
  assert.ok(
    Array.isArray(args) && args.every((arg) => typeof arg === "string" && !/[\0\r\n]/.test(arg)),
    "Invalid hdiutil arguments",
  );
  assert.ok(!args.includes("-force"), "Forced detach is forbidden");
  const value = (flag) => {
    const index = args.indexOf(flag);
    assert.ok(index > 0 && index < args.length - 1, `Missing ${flag}`);
    return args[index + 1];
  };
  const ownedNew = (path, parent) => {
    assert.ok(
      isAbsolute(path) && resolve(path) === path && isInside(parent, path),
      "Foreign disk image path",
    );
    assert.ok(
      isInside(parent, canonicalParent(path)) || canonicalParent(path) === parent,
      "Image parent escaped owned directory",
    );
    assert.equal(exists(path), false, "Preexisting image/output is forbidden");
  };
  switch (args[0]) {
    case "create": {
      assert.equal(state.stageImage, undefined, "Only one stage image may be created");
      assert.equal(value("-srcfolder"), state.sourceApp, "Foreign app source");
      assert.equal(value("-volname"), state.volumeName, "Foreign volume name");
      assert.equal(value("-format"), "UDRW");
      assert.ok(args.includes("-nospotlight") && args.includes("-anyowners"));
      assert.equal(value("-fs"), state.arch === "arm64" ? "APFS" : "HFS+");
      const image = args.filter((arg) => arg.endsWith(".dmg")).at(-1);
      assert.deepEqual(
        args,
        [
          "create",
          "-srcfolder",
          state.sourceApp,
          "-volname",
          state.volumeName,
          "-anyowners",
          "-nospotlight",
          "-format",
          "UDRW",
          "-quiet",
          "-fs",
          ...(state.arch === "arm64" ? ["APFS"] : ["HFS+", "-fsargs", "-c c=64,a=16,e=16"]),
          image,
        ],
        "Unexpected production create arguments",
      );
      ownedNew(image, state.temporary);
      return { kind: "create", image };
    }
    case "resize":
      assert.equal(args.at(-1), state.stageImage, "Foreign resize image");
      assert.ok(
        Number(value("-size")) > 0 && Number(value("-size")) < 12 * 1024 ** 3,
        "Unbounded image size",
      );
      assert.deepEqual(args, ["resize", "-size", value("-size"), state.stageImage]);
      return { kind: "resize", image: state.stageImage };
    case "attach": {
      const image = args.at(-1);
      assert.ok(image === state.stageImage || image === state.artifact, "Foreign attach image");
      const readonly = image === state.artifact;
      const mountpoint = readonly ? state.readonlyMount : state.stageMount;
      assert.ok(args.includes("-noautoopen"), "Image must never auto-open");
      if (readonly) {
        assert.ok(
          args.includes("-readonly") && args.includes("-nobrowse") && !args.includes("-readwrite"),
        );
        assert.equal(value("-mountpoint"), mountpoint);
        assert.deepEqual(args, [
          "attach",
          "-readonly",
          "-nobrowse",
          "-noautoopen",
          "-mountpoint",
          mountpoint,
          "-plist",
          image,
        ]);
      } else {
        assert.ok(args.includes("-readwrite") && !args.includes("-mountpoint"));
        assert.equal(exists(mountpoint), false, "Preexisting build mountpoint is forbidden");
        assert.deepEqual(args, ["attach", "-noverify", "-noautoopen", "-readwrite", image]);
      }
      assert.ok(
        !state.attachments.some((row) => row.image === image && !row.detached),
        "Image already attached",
      );
      return { kind: "attach", image, mountpoint, readonly };
    }
    case "detach": {
      assert.equal(args.length, 3);
      assert.equal(args[1], "-quiet");
      const attachment = state.attachments.find(
        (row) => !row.detached && row.devices.includes(args[2]),
      );
      assert.ok(attachment, "Foreign or preexisting detach is forbidden");
      return { kind: "detach", image: attachment.image, attachment, device: args[2] };
    }
    case "convert": {
      assert.equal(args[1], state.stageImage, "Foreign convert image");
      assert.equal(value("-format"), "UDZO", "Production default compressed DMG is required");
      const image = value("-o");
      assert.deepEqual(args, [
        "convert",
        state.stageImage,
        "-ov",
        "-format",
        "UDZO",
        "-o",
        image,
        "-imagekey",
        "zlib-level=9",
        "-quiet",
      ]);
      ownedNew(image, state.artifacts);
      assert.ok(
        state.attachments.some((row) => row.image === state.stageImage && row.detached),
        "Stage must detach before conversion",
      );
      return { kind: "convert", image };
    }
    case "verify":
      assert.deepEqual(args, ["verify", state.artifact]);
      return { kind: "verify", image: state.artifact };
    default:
      throw new Error(`Unsupported fixture hdiutil command: ${args[0]}`);
  }
}

function readState(file) {
  assert.equal(realpathSync(file), resolve(file), "Guard reference must not traverse symlinks");
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(descriptor);
    assert.ok(
      info.isFile() &&
        info.uid === process.getuid() &&
        (info.mode & 0o777) === 0o600 &&
        info.nlink === 1 &&
        info.size <= 64 * 1024,
      "Invalid owned guard reference",
    );
    const state = JSON.parse(readFileSync(descriptor, "utf8"));
    const root = lstatSync(state.root);
    assert.ok(
      root.isDirectory() &&
        !root.isSymbolicLink() &&
        root.uid === process.getuid() &&
        (root.mode & 0o777) === 0o700,
    );
    assert.equal(realpathSync(state.root), state.root);
    assert.ok(
      isInside(state.root, file) && /^CodeShell-Owned-[a-f0-9-]{36}$/.test(state.volumeName),
    );
    assert.equal(state.stageMount, `/Volumes/${state.volumeName}`);
    for (const key of ["temporary", "artifacts", "readonlyMount"])
      assert.ok(isInside(state.root, state[key]));
    return state;
  } finally {
    closeSync(descriptor);
  }
}
function saveState(file, state) {
  const pending = file + ".next";
  writeFileSync(pending, JSON.stringify(state, null, 2), { flag: "wx", mode: 0o600 });
  renameSync(pending, file);
}
export function readOwnedDmgState(file) {
  return readState(file);
}
export function queryOwnedDmgImage(image) {
  const xml = execFileSync("/usr/bin/hdiutil", ["info", "-plist"], {
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const json = execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], {
    input: xml,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return ownedImageFromInfo(JSON.parse(json), image);
}

export function runGuardedHdiutil(file, args) {
  assert.equal(process.platform, "darwin");
  const state = readState(file);
  const command = authorizeDmgCommand(args, state);
  if (command.kind === "attach")
    assert.equal(
      queryOwnedDmgImage(command.image),
      null,
      "Preexisting attached image is forbidden",
    );
  if (command.kind === "detach") {
    const current = queryOwnedDmgImage(command.image);
    assert.ok(current && current.devices.includes(command.device), "Owned device identity changed");
    assert.equal(current.mountpoint, command.attachment.mountpoint, "Owned mountpoint changed");
    assert.deepEqual(current.devices, command.attachment.devices, "Owned device set changed");
  }
  let output, failure;
  try {
    output = execFileSync("/usr/bin/hdiutil", args, {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: process.env.HOME,
        TMPDIR: state.temporary,
      },
    });
  } catch (error) {
    failure = error;
  }
  // Preserve ownership even when attach reports an error after mounting.
  if (command.kind === "attach") {
    const attached = queryOwnedDmgImage(command.image);
    if (attached) {
      state.attachments.push({ ...attached, readonly: command.readonly, detached: false });
      saveState(file, state);
      assert.equal(
        attached.mountpoint,
        command.mountpoint,
        "Unexpected owned image mountpoint; cleanup receipt retained",
      );
    }
    if (!failure) assert.ok(attached, "Attach returned without an owned mounted image");
  }
  if (failure) throw failure;
  if (command.kind === "create") state.stageImage = command.image;
  if (command.kind === "convert") state.artifact = command.image;
  if (command.kind === "detach") {
    assert.equal(queryOwnedDmgImage(command.image), null, "Owned image remains attached");
    command.attachment.detached = true;
  }
  state.commands.push({ kind: command.kind, image: command.image, completed: true });
  saveState(file, state);
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(
      runGuardedHdiutil(process.env.CODESHELL_DMG_GUARD_REFERENCE, process.argv.slice(2)),
    );
  } catch (error) {
    console.error(`Owned DMG hdiutil guard refused/failed: ${error.message}`);
    process.exitCode = 1;
  }
}
