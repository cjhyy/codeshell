import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The only persisted state: whether remote viewers may use terminals at all. */
export class RemoteTerminalPolicy {
  private value: boolean;

  constructor(private readonly filePath: string) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      this.value =
        typeof parsed === "object" && parsed !== null && "enabled" in parsed
          ? parsed.enabled === true
          : false;
    } catch {
      this.value = false;
    }
  }

  get enabled(): boolean {
    return this.value;
  }

  set(enabled: boolean): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ enabled })}\n`, { mode: 0o600 });
    renameSync(tmp, this.filePath);
    this.value = enabled;
  }
}
