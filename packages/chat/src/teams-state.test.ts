import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamsAdapter } from "./teams.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "codeshell-teams-state-"));
  roots.push(value);
  return value;
}

function reference(target: string, serviceUrl = "https://smba.trafficmanager.net/amer/") {
  return {
    channelId: "msteams",
    serviceUrl,
    conversation: { id: target },
    bot: { id: "bot" },
    user: { id: "owner" },
  };
}

function references(adapter: TeamsAdapter): Map<string, unknown> {
  return (adapter as unknown as { references: Map<string, unknown> }).references;
}

describe("Teams conversation state", () => {
  test("loads a bounded valid conversation reference", () => {
    const dir = root();
    const statePath = join(dir, "teams.json");
    writeFileSync(statePath, JSON.stringify({ room: reference("room") }));
    const adapter = new TeamsAdapter({ appId: "app", appPassword: "secret", statePath });
    expect(references(adapter).has("room")).toBe(true);
  });

  test("ignores references that can redirect proactive delivery to local services", () => {
    const dir = root();
    const statePath = join(dir, "teams.json");
    writeFileSync(
      statePath,
      JSON.stringify({
        loopback: reference("loopback", "https://127.0.0.1:9443/"),
        plaintext: reference("plaintext", "http://example.com/"),
        mismatch: reference("another-room"),
      }),
    );
    const adapter = new TeamsAdapter({ appId: "app", appPassword: "secret", statePath });
    expect([...references(adapter).keys()]).toEqual([]);
  });

  test("ignores linked state and refuses to replace it on save", () => {
    const dir = root();
    const outside = join(dir, "outside.json");
    const statePath = join(dir, "teams.json");
    writeFileSync(outside, JSON.stringify({ room: reference("room") }));
    symlinkSync(outside, statePath);
    const adapter = new TeamsAdapter({ appId: "app", appPassword: "secret", statePath });
    expect(references(adapter).size).toBe(0);
    references(adapter).set("room", reference("room"));
    expect(() =>
      (adapter as unknown as { saveReferences(): void }).saveReferences(),
    ).toThrow(/regular file/);
    expect(JSON.parse(readFileSync(outside, "utf8"))).toEqual({ room: reference("room") });
  });

  test("ignores oversized state", () => {
    const dir = root();
    const statePath = join(dir, "teams.json");
    writeFileSync(statePath, "x".repeat(4 * 1024 * 1024 + 1));
    const adapter = new TeamsAdapter({ appId: "app", appPassword: "secret", statePath });
    expect(references(adapter).size).toBe(0);
  });
});
