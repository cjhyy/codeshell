import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveWorkspaceProfile } from "@cjhyy/code-shell-core/internal";
import {
  activateProfile,
  clearProfileImportReviewsForTests,
  deleteProfile,
  deactivateProfile,
  exportProfileDefinition,
  forceDeleteProfile,
  importReviewedProfileDefinition,
  installCatalogProfile,
  listProfileCatalog,
  listProfiles,
  MAX_PROFILE_DEFINITION_IMPORT_BYTES,
  previewProfileDefinitionImport,
  previewProfileDeletion,
  saveProfile,
  setSessionWorkspaceProfile,
} from "./profiles-service.js";
import { SessionManager } from "@cjhyy/code-shell-core";

let home: string;
let cwd: string;
let prevHome: string | undefined;
const externalRoots: string[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cs-desk-profiles-"));
  cwd = join(home, "ws");
  mkdirSync(cwd, { recursive: true });
  prevHome = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = home;
  clearProfileImportReviewsForTests();
  saveWorkspaceProfile({
    name: "seedance",
    label: "Seedance",
    basePreset: "general",
    plugins: [],
    skills: [],
    mcp: [],
    agents: [],
    portableMemory: false,
  });
});

afterEach(() => {
  clearProfileImportReviewsForTests();
  if (prevHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
  for (const root of externalRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("desktop profiles service", () => {
  test("lists library profiles with active mark for a cwd", () => {
    activateProfile(cwd, "seedance");
    const profiles = listProfiles(cwd);
    expect(profiles).toEqual([
      {
        name: "seedance",
        label: "Seedance",
        description: undefined,
        basePreset: "general",
        plugins: [],
        skills: [],
        mcp: [],
        agents: [],
        mainInstruction: undefined,
        active: true,
        portableMemory: false,
        // Union is the default: a digital human guarantees its own capabilities
        // without switching off whatever the user enabled by hand.
        exclusiveCapabilities: false,
        version: undefined,
      },
    ]);
  });

  test("lists the library without a selected workspace", () => {
    expect(listProfiles()[0]).toMatchObject({ name: "seedance", active: false });
  });

  test("switches an existing Session digital human and tolerates a planned Session", () => {
    const sessions = new SessionManager();
    sessions.create(cwd, "test-model", "test-provider", "switchable-session");

    expect(setSessionWorkspaceProfile("switchable-session", "seedance")).toEqual({
      persisted: true,
    });
    expect(sessions.readSessionState("switchable-session")?.workspaceProfile).toBe("seedance");
    expect(setSessionWorkspaceProfile("planned-ui-session", "seedance")).toEqual({
      persisted: false,
    });
    expect(() => setSessionWorkspaceProfile("switchable-session", "missing-profile")).toThrow(
      /does not exist/,
    );
  });

  test("the bundled catalog ships empty", () => {
    // The 8 hardcoded starters were removed: they carried no capability
    // difference (plugins/skills/mcp/agents all empty) and fabricated usage
    // counts. The read model stays so a remote catalog can fill it later.
    expect(listProfileCatalog()).toEqual([]);
  });

  test("installing an unknown catalog entry fails loudly", () => {
    expect(() => installCatalogProfile("product-researcher")).toThrow(/Unknown digital human/);
    expect(listProfiles().some((entry) => entry.name === "product-researcher")).toBe(false);
  });

  test("creates and updates a digital human with assigned skills", () => {
    saveProfile({
      name: "research-lead",
      label: "研究负责人",
      description: "负责研究与交付",
      basePreset: "general",
      plugins: [],
      skills: ["web-search", "spreadsheets:analysis"],
      mcp: [],
      agents: [],
      mainInstruction: "先核对来源，再综合结论。",
      portableMemory: true,
      version: "1.0.0",
    });

    expect(listProfiles().find((profile) => profile.name === "research-lead")).toMatchObject({
      label: "研究负责人",
      skills: ["web-search", "spreadsheets:analysis"],
      mainInstruction: "先核对来源，再综合结论。",
      portableMemory: true,
    });

    saveProfile({
      name: "research-lead",
      label: "首席研究员",
      basePreset: "general",
      plugins: [],
      skills: ["web-search"],
      mcp: [],
      agents: [],
      mainInstruction: "只使用可追溯来源。",
      portableMemory: false,
      version: "1.0.1",
    });

    expect(listProfiles().find((profile) => profile.name === "research-lead")).toMatchObject({
      label: "首席研究员",
      skills: ["web-search"],
      mainInstruction: "只使用可追溯来源。",
      portableMemory: false,
      version: "1.0.1",
    });
  });

  test("previews a validated definition without mutating, then commits the reviewed snapshot", () => {
    const filePath = join(home, "researcher.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        name: "researcher",
        label: "Researcher",
        description: "Checks sources",
        basePreset: "general",
        plugins: ["browser"],
        skills: ["web-search", "documents"],
        mcp: ["linear"],
        agents: ["critic"],
        portableMemory: true,
        version: "1.2.0",
        ignored: "schema strips unknown keys",
      }),
    );

    const preview = previewProfileDefinitionImport(filePath);
    expect(preview).toMatchObject({
      sourceFileName: "researcher.json",
      name: "researcher",
      label: "Researcher",
      description: "Checks sources",
      basePreset: "general",
      portableMemory: true,
      version: "1.2.0",
      capabilityCounts: { plugins: 1, skills: 2, mcp: 1, agents: 1, total: 5 },
      alreadyExists: false,
    });
    expect(listProfiles().some((profile) => profile.name === "researcher")).toBe(false);

    writeFileSync(
      filePath,
      JSON.stringify({
        name: "researcher",
        label: "Changed after review",
        basePreset: "general",
      }),
    );
    expect(importReviewedProfileDefinition({ reviewToken: preview.reviewToken })).toEqual({
      ok: true,
      name: "researcher",
      label: "Researcher",
    });
    expect(listProfiles().find((profile) => profile.name === "researcher")).toMatchObject({
      label: "Researcher",
      plugins: ["browser"],
      skills: ["web-search", "documents"],
      mcp: ["linear"],
      agents: ["critic"],
      portableMemory: true,
    });
    expect(() => importReviewedProfileDefinition({ reviewToken: preview.reviewToken })).toThrow(
      /review expired/,
    );
  });

  test("rejects non-regular, oversized, and invalid definition imports before mutation", () => {
    const directory = join(home, "definition-directory");
    mkdirSync(directory);
    expect(() => previewProfileDefinitionImport(directory)).toThrow(/regular file/);

    const oversized = join(home, "oversized.json");
    writeFileSync(oversized, " ".repeat(MAX_PROFILE_DEFINITION_IMPORT_BYTES + 1));
    expect(() => previewProfileDefinitionImport(oversized)).toThrow(/exceeds/);

    const invalid = join(home, "invalid.json");
    writeFileSync(invalid, JSON.stringify({ name: "INVALID NAME", label: "Invalid" }));
    expect(() => previewProfileDefinitionImport(invalid)).toThrow(/Invalid digital-human/);

    if (process.platform !== "win32") {
      const valid = join(home, "valid.json");
      const link = join(home, "linked.json");
      writeFileSync(
        valid,
        JSON.stringify({ name: "linked", label: "Linked", basePreset: "general" }),
      );
      symlinkSync(valid, link, "file");
      expect(() => previewProfileDefinitionImport(link)).toThrow(/regular file/);
    }

    expect(listProfiles()).toHaveLength(1);
    expect(listProfiles()[0]?.name).toBe("seedance");
  });

  test("requires explicit overwrite confirmation for a same-name import", () => {
    const filePath = join(home, "seedance-import.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        name: "seedance",
        label: "Seedance Updated",
        basePreset: "general",
        portableMemory: true,
      }),
    );
    const preview = previewProfileDefinitionImport(filePath);
    expect(preview.alreadyExists).toBe(true);
    expect(importReviewedProfileDefinition({ reviewToken: preview.reviewToken })).toEqual({
      ok: false,
      alreadyExists: true,
      name: "seedance",
      label: "Seedance Updated",
    });
    expect(listProfiles()[0]?.label).toBe("Seedance");

    expect(
      importReviewedProfileDefinition({
        reviewToken: preview.reviewToken,
        overwrite: true,
      }),
    ).toEqual({ ok: true, name: "seedance", label: "Seedance Updated" });
    expect(listProfiles()[0]).toMatchObject({
      label: "Seedance Updated",
      portableMemory: true,
    });
  });

  test("keeps all active reviews committable when the bounded cache is exactly full", () => {
    const previews = Array.from({ length: 16 }, (_, index) => {
      const name = `review-${index}`;
      const filePath = join(home, `${name}.json`);
      writeFileSync(
        filePath,
        JSON.stringify({ name, label: `Review ${index}`, basePreset: "general" }),
      );
      return previewProfileDefinitionImport(filePath);
    });

    expect(
      importReviewedProfileDefinition({ reviewToken: previews[0]!.reviewToken }),
    ).toMatchObject({
      ok: true,
      name: "review-0",
    });
  });

  test("atomically exports definition JSON without portable-memory content", () => {
    saveProfile({
      name: "seedance",
      label: "Seedance",
      basePreset: "general",
      plugins: ["browser"],
      skills: ["video-editing"],
      mcp: [],
      agents: [],
      portableMemory: true,
    });
    const memoryDir = join(home, "profiles", "seedance", "memory", "user");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "private-note.md"), "DO-NOT-EXPORT-ME");

    const outputDir = join(home, "exports");
    mkdirSync(outputDir);
    const output = join(outputDir, "seedance.codeshell-profile.json");
    writeFileSync(output, "old content");

    expect(exportProfileDefinition("seedance", output)).toEqual({
      canceled: false,
      fileName: "seedance.codeshell-profile.json",
      name: "seedance",
      label: "Seedance",
    });
    const text = readFileSync(output, "utf-8");
    const definition = JSON.parse(text);
    expect(definition).toMatchObject({
      name: "seedance",
      label: "Seedance",
      skills: ["video-editing"],
      portableMemory: true,
    });
    expect(text).not.toContain("DO-NOT-EXPORT-ME");
    expect(definition.memory).toBeUndefined();
    expect(readdirSync(outputDir)).toEqual(["seedance.codeshell-profile.json"]);
  });

  test("refuses to export through a symlink destination", () => {
    if (process.platform === "win32") return;
    const outputDir = join(home, "exports");
    mkdirSync(outputDir);
    const outside = join(home, "outside.json");
    const output = join(outputDir, "seedance.json");
    writeFileSync(outside, "outside");
    symlinkSync(outside, output, "file");

    expect(() => exportProfileDefinition("seedance", output)).toThrow(/regular file/);
    expect(readFileSync(outside, "utf-8")).toBe("outside");
  });

  test("activate writes the subtree; deactivate removes it", () => {
    activateProfile(cwd, "seedance");
    const raw = () => JSON.parse(readFileSync(join(cwd, ".code-shell", "settings.json"), "utf-8"));
    expect(raw().profile.active).toBe("seedance");
    deactivateProfile(cwd);
    expect(raw().profile).toBeUndefined();
    expect(listProfiles(cwd)[0]?.active).toBe(false);
  });

  test("requires an explicit active-default clear before deleting a profile", () => {
    activateProfile(cwd, "seedance");
    expect(() => deleteProfile("seedance", { cwd })).toThrow(/active project default/);
    expect(listProfiles(cwd)[0]).toMatchObject({ name: "seedance", active: true });

    deleteProfile("seedance", { cwd, clearActiveProject: true });
    expect(listProfiles(cwd)).toEqual([]);
    const raw = JSON.parse(readFileSync(join(cwd, ".code-shell", "settings.json"), "utf-8"));
    expect(raw.profile).toBeUndefined();
  });

  test("rejects deletion while a team still references the profile", async () => {
    saveWorkspaceProfile({
      name: "developer",
      label: "Developer",
      basePreset: "general",
      plugins: [],
      skills: [],
      mcp: [],
      agents: [],
      portableMemory: false,
    });
    const { saveDigitalHumanTeam } = await import("./digital-human-team-service.js");
    saveDigitalHumanTeam({
      id: "delivery",
      name: "Delivery",
      members: ["seedance", "developer"],
      mode: "divide",
    });

    expect(() => deleteProfile("seedance", { cwd })).toThrow(/Delivery/);
    expect(listProfiles().some((profile) => profile.name === "seedance")).toBe(true);
  });

  test("rejects deletion while a durable Session is still bound to the profile", () => {
    const sessionDir = join(home, "sessions", "session-pinned");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "state.json"), JSON.stringify({ workspaceProfile: "seedance" }));

    expect(() => deleteProfile("seedance", { cwd })).toThrow(/session-pinned/);
    expect(listProfiles().some((profile) => profile.name === "seedance")).toBe(true);
  });

  test("previewProfileDeletion reports blockers before the confirm dialog", async () => {
    const sessionDir = join(home, "sessions", "session-pinned");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "state.json"), JSON.stringify({ workspaceProfile: "seedance" }));
    saveWorkspaceProfile({
      name: "developer",
      label: "Developer",
      basePreset: "general",
      plugins: [],
      skills: [],
      mcp: [],
      agents: [],
      portableMemory: false,
    });
    const { saveDigitalHumanTeam } = await import("./digital-human-team-service.js");
    saveDigitalHumanTeam({
      id: "delivery",
      name: "Delivery",
      members: ["seedance", "developer"],
      mode: "divide",
    });

    const preview = previewProfileDeletion("seedance", cwd);
    // The user must learn WHY it cannot be deleted before confirming, not from
    // a raw backend error afterwards.
    expect(preview.canDelete).toBe(false);
    expect(preview.blockingSessions.map((s) => s.id)).toEqual(["session-pinned"]);
    expect(preview.blockingTeams).toEqual(["Delivery"]);
  });

  test("an empty profile name unbinds the Session's digital human", () => {
    const sessionDir = join(home, "sessions", "session-bound");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "state.json"),
      JSON.stringify({ sessionId: "session-bound", workspaceProfile: "seedance" }),
    );

    // Binding used to be one-way: you could swap digital humans but never get
    // back to the plain project default.
    expect(setSessionWorkspaceProfile("session-bound", "").persisted).toBe(true);
    const after = JSON.parse(readFileSync(join(sessionDir, "state.json"), "utf-8")) as {
      workspaceProfile?: string;
    };
    expect(after.workspaceProfile).toBeUndefined();
  });

  test("an unknown profile name is still rejected", () => {
    const sessionDir = join(home, "sessions", "session-guard");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "state.json"),
      JSON.stringify({ sessionId: "session-guard", workspaceProfile: "seedance" }),
    );
    expect(() => setSessionWorkspaceProfile("session-guard", "no-such-human")).toThrow(
      /does not exist/,
    );
  });

  test("an archived Session does not block deletion", () => {
    const sessionDir = join(home, "sessions", "session-archived");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "state.json"),
      JSON.stringify({ workspaceProfile: "seedance", archivedAt: 1785137194100 }),
    );

    // Archived means the work is closed; requiring the user to delete closed
    // history just to remove a digital human is disproportionate. A dangling
    // name is already tolerated by resolveActiveWorkspaceProfile.
    expect(previewProfileDeletion("seedance", cwd).canDelete).toBe(true);
    deleteProfile("seedance", { cwd });
    expect(listProfiles().some((profile) => profile.name === "seedance")).toBe(false);
  });

  test("blocking Sessions carry a title and workspace, not just an id", () => {
    const sessionDir = join(home, "sessions", "session-named");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "state.json"),
      JSON.stringify({
        sessionId: "session-named",
        workspaceProfile: "seedance",
        title: "技术方案与配置文件创建",
        cwd: "/repo/alpha",
      }),
    );

    // An opaque id list ("still bound to 3 sessions") is unactionable — the user
    // cannot tell which conversations to unbind.
    const [blocked] = previewProfileDeletion("seedance", cwd).blockingSessions;
    expect(blocked.id).toBe("session-named");
    expect(blocked.title).toBe("技术方案与配置文件创建");
    expect(blocked.workspace).toBe("/repo/alpha");
  });

  test("a Session with no title still reports its id", () => {
    const sessionDir = join(home, "sessions", "session-bare");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "state.json"),
      JSON.stringify({ sessionId: "session-bare", workspaceProfile: "seedance" }),
    );
    const [blocked] = previewProfileDeletion("seedance", cwd).blockingSessions;
    expect(blocked.id).toBe("session-bare");
    expect(blocked.title).toBeUndefined();
  });

  test("previewProfileDeletion clears once nothing references the profile", () => {
    const preview = previewProfileDeletion("seedance", cwd);
    expect(preview.canDelete).toBe(true);
    expect(preview.blockingSessions).toEqual([]);
    expect(preview.blockingTeams).toEqual([]);
  });

  test("previewProfileDeletion flags the active project default without blocking", () => {
    activateProfile(cwd, "seedance");
    const preview = previewProfileDeletion("seedance", cwd);
    // Being the project default is recoverable (we clear it on delete), so it
    // is a warning, not a blocker.
    expect(preview.isActiveProjectDefault).toBe(true);
    expect(preview.canDelete).toBe(true);
  });

  test("force delete unbinds Sessions and drops the profile from teams", async () => {
    const sessionDir = join(home, "sessions", "session-a");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "state.json"),
      JSON.stringify({ sessionId: "session-a", workspaceProfile: "seedance", title: "A" }),
    );
    saveWorkspaceProfile({
      name: "developer",
      label: "Developer",
      basePreset: "general",
      plugins: [],
      skills: [],
      mcp: [],
      agents: [],
      portableMemory: false,
    });
    saveWorkspaceProfile({
      name: "reviewer",
      label: "Reviewer",
      basePreset: "general",
      plugins: [],
      skills: [],
      mcp: [],
      agents: [],
      portableMemory: false,
    });
    const teamService = await import("./digital-human-team-service.js");
    teamService.saveDigitalHumanTeam({
      id: "trio",
      name: "Trio",
      members: ["seedance", "developer", "reviewer"],
      mode: "divide",
      lead: "seedance",
    });

    const result = forceDeleteProfile("seedance", { cwd });
    expect(result.unboundSessions).toEqual(["session-a"]);
    expect(result.updatedTeams).toEqual(["Trio"]);
    expect(listProfiles().some((p) => p.name === "seedance")).toBe(false);

    // The Session survives, just without the binding — force delete must not
    // destroy conversations.
    const after = JSON.parse(readFileSync(join(sessionDir, "state.json"), "utf-8")) as {
      workspaceProfile?: string;
      title?: string;
    };
    expect(after.workspaceProfile).toBeUndefined();
    expect(after.title).toBe("A");

    // The team keeps its remaining members and loses the lead it can no longer use.
    const team = teamService.readDigitalHumanTeam("trio");
    expect(team?.members).toEqual(["developer", "reviewer"]);
    expect(team?.lead).toBeUndefined();
  });

  test("force delete removes a team that would drop below two members", async () => {
    saveWorkspaceProfile({
      name: "solo",
      label: "Solo",
      basePreset: "general",
      plugins: [],
      skills: [],
      mcp: [],
      agents: [],
      portableMemory: false,
    });
    const teamService = await import("./digital-human-team-service.js");
    teamService.saveDigitalHumanTeam({
      id: "pair",
      name: "Pair",
      members: ["seedance", "solo"],
      mode: "divide",
    });

    const result = forceDeleteProfile("seedance", { cwd });
    // A one-member team cannot be saved (schema requires 2..8), so it is removed
    // rather than left in an unparseable state.
    expect(result.removedTeams).toEqual(["Pair"]);
    expect(teamService.readDigitalHumanTeam("pair")).toBeUndefined();
  });

  test("force delete clears the active project default", () => {
    activateProfile(cwd, "seedance");
    const result = forceDeleteProfile("seedance", { cwd });
    expect(result.clearedProjectDefault).toBe(true);
    expect(listProfiles(cwd).some((p) => p.name === "seedance")).toBe(false);
  });

  test("refuses to delete through a symlinked profile directory", () => {
    if (process.platform === "win32") return;
    rmSync(join(home, "profiles", "seedance"), { recursive: true, force: true });
    const outside = mkdtempSync(join(tmpdir(), "cs-desk-profile-outside-"));
    externalRoots.push(outside);
    writeFileSync(
      join(outside, "profile.json"),
      JSON.stringify({ name: "seedance", label: "Outside", basePreset: "general" }),
    );
    symlinkSync(outside, join(home, "profiles", "seedance"), "dir");

    expect(() => deleteProfile("seedance", { cwd })).toThrow(/profile directory/);
    expect(JSON.parse(readFileSync(join(outside, "profile.json"), "utf-8"))).toMatchObject({
      label: "Outside",
    });
  });
});
