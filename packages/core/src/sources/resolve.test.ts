import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "../settings/manager.js";
import { uploadsDir } from "./adapters/local-files.js";
import { bindSource, listBindings, unbindSource } from "./binding.js";
import { saveSourceDefinition } from "./catalog.js";
import { resolveEffectiveSourceAccess } from "./resolve.js";

let home: string;
let cwd: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cs-src-resolve-"));
  cwd = join(home, "ws");
  mkdirSync(cwd, { recursive: true });
  prevHome = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = home;
  saveSourceDefinition({
    id: "m1",
    kind: "mock",
    label: "Mock1",
    adapterConfig: {},
    enabled: true,
  });
  saveSourceDefinition({
    id: "m2",
    kind: "mock",
    label: "Mock2",
    adapterConfig: {},
    credentialRef: "cred-x",
    enabled: true,
  });
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

const okCred = () => "ok" as const;

describe("effective source access", () => {
  test("default deny: unbound sources are invisible without uploads", () => {
    const sm = new SettingsManager(cwd, "full");

    expect(resolveEffectiveSourceAccess({ cwd, settings: sm, credentialStatus: okCred })).toEqual(
      [],
    );
  });

  test("bound source appears with its scopes and implicit local-files source", () => {
    const sm = new SettingsManager(cwd, "full");
    bindSource(sm, cwd, { sourceId: "m1", scopes: ["alpha"], readPolicy: "ask" });

    const access = resolveEffectiveSourceAccess({ cwd, settings: sm, credentialStatus: okCred });

    expect(access.map((item) => item.sourceId).sort()).toEqual(["m1", "project-uploads"]);
    expect(access.find((item) => item.sourceId === "m1")).toMatchObject({
      label: "Mock1",
      kind: "mock",
      scopes: ["alpha"],
      readPolicy: "ask",
      status: "ok",
    });
  });

  test("existing upload exposes implicit local-files without another binding", () => {
    const sm = new SettingsManager(cwd, "full");
    mkdirSync(uploadsDir(cwd), { recursive: true });
    writeFileSync(join(uploadsDir(cwd), "brief.md"), "# Brief\n");

    const access = resolveEffectiveSourceAccess({ cwd, settings: sm, credentialStatus: okCred });

    expect(access).toHaveLength(1);
    expect(access[0]).toMatchObject({
      sourceId: "project-uploads",
      kind: "local-files",
      scopes: ["uploads"],
      readPolicy: "ask",
      status: "ok",
    });
  });

  test("dangling binding stays visible and denied", () => {
    const sm = new SettingsManager(cwd, "full");
    bindSource(sm, cwd, { sourceId: "ghost", scopes: ["x"], readPolicy: "ask" });

    const ghost = resolveEffectiveSourceAccess({
      cwd,
      settings: sm,
      credentialStatus: okCred,
    }).find((item) => item.sourceId === "ghost");

    expect(ghost).toMatchObject({
      label: "ghost",
      kind: "unknown",
      scopes: ["x"],
      readPolicy: "ask",
      status: "dangling",
    });
    expect(ghost?.definition).toBeUndefined();
  });

  test("disabled source and bad credential are unavailable", () => {
    const sm = new SettingsManager(cwd, "full");
    saveSourceDefinition({
      id: "m1",
      kind: "mock",
      label: "Mock1",
      adapterConfig: {},
      enabled: false,
    });
    bindSource(sm, cwd, { sourceId: "m1", scopes: ["alpha"], readPolicy: "ask" });
    bindSource(sm, cwd, { sourceId: "m2", scopes: ["alpha"], readPolicy: "ask" });

    const access = resolveEffectiveSourceAccess({
      cwd,
      settings: sm,
      credentialStatus: (ref) => (ref === "cred-x" ? "expired" : "ok"),
    });

    expect(access.find((item) => item.sourceId === "m1")?.status).toBe("unavailable");
    expect(access.find((item) => item.sourceId === "m2")?.status).toBe("unavailable");
  });

  test("bind and unbind round-trip through project settings", () => {
    const sm = new SettingsManager(cwd, "full");
    bindSource(sm, cwd, { sourceId: "m1", scopes: ["alpha"], readPolicy: "ask" });

    expect(listBindings(sm, cwd)).toEqual([
      { sourceId: "m1", scopes: ["alpha"], readPolicy: "ask" },
    ]);
    unbindSource(sm, cwd, "m1");
    expect(listBindings(sm, cwd)).toEqual([]);
    expect(
      resolveEffectiveSourceAccess({ cwd, settings: sm, credentialStatus: okCred }).find(
        (item) => item.sourceId === "m1",
      ),
    ).toBeUndefined();
  });
});
