import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { TrustedDevice, TrustedDevicePublic } from "./types.js";

export class TrustedDeviceStore {
  constructor(private readonly filePath: string) {}

  addDevice(input: { name: string; secretHash: string }): TrustedDevicePublic {
    const devices = this.readAll();
    // Get-or-create by secretHash. A phone's secret is stable per browser
    // (persisted in localStorage as cs.deviceSecret), so re-scanning the QR
    // code — which the client always prefers over re-auth when the URL carries
    // a fresh pairing token — used to mint a BRAND-NEW device every time, piling
    // up trusted devices unboundedly. Reuse the existing row instead, refreshing
    // its name + lastSeenAt. (mobile-remote device accumulation)
    const existing = devices.find(
      (d) => d.secretHash === input.secretHash && !d.revokedAt,
    );
    if (existing) {
      existing.name = input.name;
      existing.lastSeenAt = Date.now();
      this.writeAll(devices);
      return this.toPublic(existing);
    }
    const device: TrustedDevice = {
      id: randomUUID(),
      name: input.name,
      secretHash: input.secretHash,
      createdAt: Date.now(),
    };
    devices.push(device);
    this.writeAll(devices);
    return this.toPublic(device);
  }

  listDevices(): TrustedDevicePublic[] {
    return this.readAll().map((device) => this.toPublic(device));
  }

  authenticate(id: string, secretHash: string): TrustedDevicePublic | undefined {
    const devices = this.readAll();
    const device = devices.find(
      (item) => item.id === id && item.secretHash === secretHash && !item.revokedAt,
    );
    if (!device) return undefined;
    device.lastSeenAt = Date.now();
    this.writeAll(devices);
    return this.toPublic(device);
  }

  revoke(id: string): boolean {
    const devices = this.readAll();
    const device = devices.find((item) => item.id === id && !item.revokedAt);
    if (!device) return false;
    device.revokedAt = Date.now();
    this.writeAll(devices);
    return true;
  }

  /** Hard-delete a device row entirely (no revoked zombie left behind). */
  remove(id: string): boolean {
    const devices = this.readAll();
    const next = devices.filter((item) => item.id !== id);
    if (next.length === devices.length) return false;
    this.writeAll(next);
    return true;
  }

  /** Rename a device's display label. Rejects blank names and unknown ids. */
  rename(id: string, name: string): boolean {
    const trimmed = name.trim();
    if (!trimmed) return false;
    const devices = this.readAll();
    const device = devices.find((item) => item.id === id);
    if (!device) return false;
    device.name = trimmed;
    this.writeAll(devices);
    return true;
  }

  private readAll(): TrustedDevice[] {
    if (!existsSync(this.filePath)) return [];
    return JSON.parse(readFileSync(this.filePath, "utf-8")) as TrustedDevice[];
  }

  private writeAll(devices: TrustedDevice[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(devices, null, 2), "utf-8");
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
