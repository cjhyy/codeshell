import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { acquireFileLock } from "@cjhyy/code-shell-core/internal";
import type { TrustedDevice, TrustedDevicePublic } from "./types.js";

const MAX_DEVICE_ID_LENGTH = 512;
const MAX_DEVICE_NAME_LENGTH = 512;
const MAX_DEVICE_SECRET_LENGTH = 4_096;
const MAX_TRUSTED_DEVICE_ROWS = 4_096;
const MAX_TRUSTED_DEVICE_FILE_BYTES = 32 * 1024 * 1024;

/**
 * Constant-time compare for a device's bearer credential (secretHash), so
 * authentication doesn't leak hash bytes through compare-timing (Y-3).
 * `timingSafeEqual` requires equal-length buffers and throws otherwise — a
 * length mismatch is itself a non-match, so we short-circuit to false. The
 * length check isn't constant-time, but it only reveals the (fixed, public)
 * length of a correct hash, not its content.
 */
function secretHashEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export class TrustedDeviceStore {
  constructor(private readonly filePath: string) {}

  addDevice(input: { name: string; secretHash: string }): TrustedDevicePublic {
    const name = normalizeDeviceName(input.name);
    if (!name) throw new Error("Invalid trusted device name");
    if (!isBoundedOpaqueString(input.secretHash, MAX_DEVICE_SECRET_LENGTH)) {
      throw new Error("Invalid trusted device secret");
    }
    return this.mutate((devices) => {
      // Get-or-create by secretHash. A phone's secret is stable per browser
      // (persisted in localStorage as cs.deviceSecret), so re-scanning the QR
      // code must reuse its live row rather than accumulating duplicates.
      const existing = devices.find((d) => secretHashEquals(d.secretHash, input.secretHash));
      if (existing) {
        if (existing.revokedAt) {
          throw new Error("Trusted device was revoked; remove it before pairing again");
        }
        existing.name = name;
        existing.lastSeenAt = Date.now();
        return { result: this.toPublic(existing), changed: true };
      }
      if (devices.length >= MAX_TRUSTED_DEVICE_ROWS) {
        throw new Error("Trusted device limit reached");
      }
      const device: TrustedDevice = {
        id: randomUUID(),
        name,
        secretHash: input.secretHash,
        createdAt: Date.now(),
      };
      devices.push(device);
      return { result: this.toPublic(device), changed: true };
    });
  }

  listDevices(): TrustedDevicePublic[] {
    return this.readAll().map((device) => this.toPublic(device));
  }

  authenticate(id: string, secretHash: string): TrustedDevicePublic | undefined {
    if (
      !isBoundedOpaqueString(id, MAX_DEVICE_ID_LENGTH) ||
      !isBoundedOpaqueString(secretHash, MAX_DEVICE_SECRET_LENGTH)
    ) {
      return undefined;
    }
    return this.mutate((devices) => {
      const device = devices.find(
        (item) =>
          item.id === id && !item.revokedAt && secretHashEquals(item.secretHash, secretHash),
      );
      if (!device) return { result: undefined, changed: false };
      device.lastSeenAt = Date.now();
      return { result: this.toPublic(device), changed: true };
    });
  }

  revoke(id: string): boolean {
    if (!isBoundedOpaqueString(id, MAX_DEVICE_ID_LENGTH)) return false;
    return this.mutate((devices) => {
      const device = devices.find((item) => item.id === id && !item.revokedAt);
      if (!device) return { result: false, changed: false };
      device.revokedAt = Date.now();
      return { result: true, changed: true };
    });
  }

  /** Hard-delete a device row entirely (no revoked zombie left behind). */
  remove(id: string): boolean {
    if (!isBoundedOpaqueString(id, MAX_DEVICE_ID_LENGTH)) return false;
    return this.mutate((devices) => {
      const index = devices.findIndex((item) => item.id === id);
      if (index < 0) return { result: false, changed: false };
      devices.splice(index, 1);
      return { result: true, changed: true };
    });
  }

  /** Rename a device's display label. Rejects blank names and unknown ids. */
  rename(id: string, name: string): boolean {
    if (!isBoundedOpaqueString(id, MAX_DEVICE_ID_LENGTH)) return false;
    const trimmed = normalizeDeviceName(name);
    if (!trimmed) return false;
    return this.mutate((devices) => {
      const device = devices.find((item) => item.id === id);
      if (!device) return { result: false, changed: false };
      device.name = trimmed;
      return { result: true, changed: true };
    });
  }

  /** Serialize read-modify-write across desktop/server processes. */
  private mutate<R>(mutation: (devices: TrustedDevice[]) => { result: R; changed: boolean }): R {
    this.ensurePrivateParent();
    const release = acquireFileLock(this.filePath);
    try {
      // Crucially reload INSIDE the lock; atomic rename alone cannot prevent
      // two writers that both read revision N from losing one update.
      const devices = this.readAll();
      const { result, changed } = mutation(devices);
      if (changed) this.writeAll(devices);
      return result;
    } finally {
      release();
    }
  }

  private readAll(): TrustedDevice[] {
    let descriptor: number | undefined;
    try {
      const pathInfo = lstatSync(this.filePath);
      if (
        pathInfo.isSymbolicLink() ||
        !pathInfo.isFile() ||
        pathInfo.size > MAX_TRUSTED_DEVICE_FILE_BYTES
      ) {
        throw new Error("Trusted device store is corrupt");
      }
      descriptor = openSync(this.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.size > MAX_TRUSTED_DEVICE_FILE_BYTES) {
        throw new Error("Trusted device store is corrupt");
      }
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      if (error instanceof Error && error.message === "Trusted device store is corrupt") {
        throw error;
      }
      throw new Error("Trusted device store is corrupt", { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(descriptor, "utf-8"));
    } catch (error) {
      throw new Error("Trusted device store is corrupt", { cause: error });
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length > MAX_TRUSTED_DEVICE_ROWS ||
      !parsed.every(isTrustedDevice)
    ) {
      throw new Error("Trusted device store is corrupt");
    }
    const ids = new Set<string>();
    for (const device of parsed) {
      if (ids.has(device.id)) throw new Error("Trusted device store is corrupt");
      ids.add(device.id);
    }
    return parsed;
  }

  private writeAll(devices: TrustedDevice[]): void {
    this.ensurePrivateParent();
    const serialized = JSON.stringify(devices, null, 2);
    if (Buffer.byteLength(serialized, "utf8") > MAX_TRUSTED_DEVICE_FILE_BYTES) {
      throw new Error("Trusted device store is too large");
    }
    try {
      const target = lstatSync(this.filePath);
      if (target.isSymbolicLink() || !target.isFile()) {
        throw new Error("Trusted device store is corrupt");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // 0o600: devices.json holds each device's secretHash (its bearer credential).
    // Owner-only, same hardening as settings.json/credentials.json/cookie leases.
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tempPath, serialized, {
        encoding: "utf-8",
        flag: "wx",
        mode: 0o600,
      });
      renameSync(tempPath, this.filePath);
      try {
        chmodSync(this.filePath, 0o600);
      } catch {
        // Best effort: tighten an existing file on platforms that support it.
      }
    } finally {
      try {
        rmSync(tempPath, { force: true });
      } catch {
        // Never hide the original write/rename error with cleanup failure.
      }
    }
  }

  private ensurePrivateParent(): string {
    const parent = dirname(this.filePath);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const metadata = lstatSync(parent);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("Trusted device store parent must be a real directory");
    }
    try {
      chmodSync(parent, 0o700);
    } catch {
      // Best effort on platforms/filesystems without POSIX permissions.
    }
    return parent;
  }

  private toPublic(device: TrustedDevice): TrustedDevicePublic {
    return {
      id: device.id,
      name: device.name,
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt,
      revokedAt: device.revokedAt,
    };
  }
}

function isTrustedDevice(value: unknown): value is TrustedDevice {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const device = value as Record<string, unknown>;
  return (
    isBoundedOpaqueString(device.id, MAX_DEVICE_ID_LENGTH) &&
    typeof device.name === "string" &&
    device.name.length <= MAX_DEVICE_NAME_LENGTH &&
    !device.name.includes("\0") &&
    isBoundedOpaqueString(device.secretHash, MAX_DEVICE_SECRET_LENGTH) &&
    isTimestamp(device.createdAt) &&
    (device.lastSeenAt === undefined || isTimestamp(device.lastSeenAt)) &&
    (device.revokedAt === undefined || isTimestamp(device.revokedAt))
  );
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedOpaqueString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !value.includes("\0")
  );
}

function normalizeDeviceName(value: unknown): string | undefined {
  if (typeof value !== "string" || value.includes("\0")) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_DEVICE_NAME_LENGTH ? trimmed : undefined;
}
