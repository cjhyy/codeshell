import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { TrustedDevice, TrustedDevicePublic } from "./types.js";

export class TrustedDeviceStore {
  constructor(private readonly filePath: string) {}

  addDevice(input: { name: string; secretHash: string }): TrustedDevicePublic {
    const devices = this.readAll();
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
