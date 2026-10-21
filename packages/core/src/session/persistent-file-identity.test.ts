import { describe, expect, test } from "bun:test";
import { mkdtempSync, lstatSync, rmSync, writeFileSync, type BigIntStats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capturePersistentFileIdentity,
  createPersistentFileIdentityReader,
  isValidPersistentFileIdentity,
  matchesPersistentFileIdentity,
  persistentFileIdentityKey,
} from "./persistent-file-identity.js";

const FIRST_UUID = "11111111-2222-3333-4444-555555555555";
const SECOND_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function fixture() {
  const state = {
    dev: 10n,
    ino: 1152921500311879682n,
    birth: 1234567890123456789n,
    nodeTime: 20n,
    mountTime: 30n,
    uuid: FIRST_UUID,
    calls: 0,
    symbolic: false,
  };
  const stats = (path: string): BigIntStats => {
    const node = path === "/dev/disk3s5",
      mount = path === "/System/Volumes/Data";
    if (!node && !mount && path !== "/Users/operator/session/file") throw new Error("ENOENT");
    return {
      dev: node ? 1n : state.dev,
      ino: node ? 100n : mount ? 2n : state.ino,
      rdev: node ? state.dev : 0n,
      birthtimeNs: mount ? 1n : state.birth,
      ctimeNs: node ? state.nodeTime : state.mountTime,
      isBlockDevice: () => node,
      isDirectory: () => mount,
      isFile: () => !node && !mount,
      isSymbolicLink: () => !node && !mount && state.symbolic,
    } as BigIntStats;
  };
  const xml = () =>
    `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>DeviceNode</key><string>/dev/disk3s5</string><key>MountPoint</key><string>/System/Volumes/Data</string><key>VolumeUUID</key><string>${state.uuid}</string></dict></plist>`;
  const options = {
    platform: "darwin" as const,
    lstat: stats,
    deviceNames: () => ["rdisk3s5", "disk3s5", "not-a-disk"],
    diskInfo: (node: string) => {
      expect(node).toBe("/dev/disk3s5");
      state.calls++;
      return xml();
    },
  };
  return { state, stats, xml, options, reader: createPersistentFileIdentityReader(options) };
}
const PATH = "/Users/operator/session/file";

describe("persistent file identity", () => {
  test("a new process resolves the same volume and file after device-number rollover", () => {
    const f = fixture();
    const old = f.reader.capturePersistentFileIdentity(PATH);
    f.state.dev = 40n;
    const afterReboot = createPersistentFileIdentityReader(f.options);
    expect(afterReboot.matchesPersistentFileIdentity(PATH, old)).toBe(true);
    expect(afterReboot.capturePersistentFileIdentity(PATH)).toEqual(old);
    expect(old.fileId).toBe("1152921500311879682");
    expect(old.birthtimeNs).toBe("1234567890123456789");
    expect(f.state.calls).toBe(2);
  });

  test("file replacement and inode reuse with a different birth time remain rejected", () => {
    const f = fixture();
    const original = f.reader.capturePersistentFileIdentity(PATH);
    f.state.ino++;
    expect(f.reader.matchesPersistentFileIdentity(PATH, original)).toBe(false);
    f.state.ino--;
    f.state.birth++;
    expect(f.reader.matchesPersistentFileIdentity(PATH, original)).toBe(false);
  });

  test("the same inode and birth time on another volume are not the same file", () => {
    const f = fixture();
    const original = f.reader.capturePersistentFileIdentity(PATH);
    f.state.uuid = SECOND_UUID;
    const otherVolume = createPersistentFileIdentityReader(f.options);
    expect(otherVolume.matchesPersistentFileIdentity(PATH, original)).toBe(false);
  });

  test("opened descriptor and named path must still refer to the same live file", () => {
    const f = fixture();
    const opened = f.stats(PATH);
    f.state.ino++;
    expect(() => f.reader.capturePersistentFileIdentity(PATH, opened)).toThrow(
      "does not match the opened file",
    );
  });

  test("the UUID is cached while device and mount fingerprints remain unchanged", () => {
    const f = fixture();
    for (let index = 0; index < 20; index++) f.reader.capturePersistentFileIdentity(PATH);
    expect(f.state.calls).toBe(1);
    f.state.uuid = SECOND_UUID;
    f.state.nodeTime++;
    expect(f.reader.capturePersistentFileIdentity(PATH).volume).toBe(
      `darwin-volume:${SECOND_UUID}`,
    );
    expect(f.state.calls).toBe(2);
    f.state.mountTime++;
    f.reader.capturePersistentFileIdentity(PATH);
    expect(f.state.calls).toBe(3);
  });

  test("a device change during the bounded UUID lookup fails closed", () => {
    const f = fixture();
    const reader = createPersistentFileIdentityReader({
      ...f.options,
      diskInfo: () => {
        f.state.nodeTime++;
        return f.xml();
      },
    });
    expect(() => reader.capturePersistentFileIdentity(PATH)).toThrow("changed during UUID lookup");
  });

  test("unavailable disk information never falls back to the transient macOS device number", () => {
    const f = fixture();
    const reader = createPersistentFileIdentityReader({
      ...f.options,
      diskInfo: () => {
        throw new Error("diskutil unavailable");
      },
    });
    expect(() => reader.capturePersistentFileIdentity(PATH)).toThrow("diskutil unavailable");
  });

  test("malformed, missing, nested, or conflicting UUID authority is rejected", () => {
    const f = fixture();
    for (const xml of [
      "not XML",
      f.xml().replace(FIRST_UUID, "not-a-uuid"),
      f.xml().replace("<key>VolumeUUID</key>", "<key>DiskUUID</key>"),
      f
        .xml()
        .replace("<key>VolumeUUID</key>", "<key>Other</key><dict><key>VolumeUUID</key>")
        .replace("</dict></plist>", "</dict></dict></plist>"),
      f
        .xml()
        .replace(
          "</dict></plist>",
          `<key>VolumeUUID</key><string>${SECOND_UUID}</string></dict></plist>`,
        ),
      f.xml().replace("/dev/disk3s5", "/dev/disk9s9"),
    ]) {
      const reader = createPersistentFileIdentityReader({ ...f.options, diskInfo: () => xml });
      expect(() => reader.capturePersistentFileIdentity(PATH)).toThrow();
    }
  });

  test("symbolic links and unbounded device inventories are rejected", () => {
    const f = fixture();
    f.state.symbolic = true;
    expect(() => f.reader.capturePersistentFileIdentity(PATH)).toThrow("named file");
    f.state.symbolic = false;
    const reader = createPersistentFileIdentityReader({
      ...f.options,
      deviceNames: () => Array.from({ length: 513 }, (_, index) => `disk${index}`),
    });
    expect(() => reader.capturePersistentFileIdentity(PATH)).toThrow("inventory exceeds");
  });

  test("stored identities have bounded, unambiguous fields", () => {
    const original = fixture().reader.capturePersistentFileIdentity(PATH);
    expect(isValidPersistentFileIdentity(original)).toBe(true);
    expect(persistentFileIdentityKey({ ...original })).toBe(persistentFileIdentityKey(original));
    for (const bad of [
      null,
      { ...original, version: 2 },
      { ...original, volume: "some-volume" },
      { ...original, fileId: "00123" },
      { ...original, fileId: "-1" },
      { ...original, birthtimeNs: "1e20" },
    ])
      expect(isValidPersistentFileIdentity(bad)).toBe(false);
  });

  test("other platforms preserve explicit device-scoped semantics", () => {
    const f = fixture();
    const reader = createPersistentFileIdentityReader({ ...f.options, platform: "linux" });
    const original = reader.capturePersistentFileIdentity(PATH);
    expect(original.volume).toBe("device:linux:10");
    f.state.dev = 20n;
    expect(reader.matchesPersistentFileIdentity(PATH, original)).toBe(false);
    expect(f.state.calls).toBe(0);
  });

  test("the production resolver binds a real temporary file without truncating its identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "persistent-file-identity-"));
    try {
      const path = join(directory, "file");
      writeFileSync(path, "untouched");
      const identity = capturePersistentFileIdentity(path, lstatSync(path));
      expect(matchesPersistentFileIdentity(path, identity)).toBe(true);
      expect(identity.fileId).toBe(lstatSync(path, { bigint: true }).ino.toString());
      if (process.platform === "darwin")
        expect(identity.volume.startsWith("darwin-volume:")).toBe(true);
      rmSync(path);
      writeFileSync(path, "replacement");
      expect(matchesPersistentFileIdentity(path, identity)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
