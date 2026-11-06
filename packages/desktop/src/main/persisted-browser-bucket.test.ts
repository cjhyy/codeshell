import { describe, expect, test } from "bun:test";
import type { SessionCatalogSnapshot, SessionSummary } from "../shared/session-catalog.js";
import { resolvePersistedBrowserBucket } from "./persisted-browser-bucket.js";

function row(id: string, engineSessionId?: string): SessionSummary {
  return { id, engineSessionId, title: "Saved", createdAt: 1, updatedAt: 1 };
}

function fixture(rows: SessionSummary[] = []) {
  const catalog: SessionCatalogSnapshot = {
    revision: 1,
    indices: { project: { sessions: rows, activeSessionId: null } },
  };
  return {
    catalog,
    resolve: (requestedBucket?: string) =>
      resolvePersistedBrowserBucket({
        sessionId: "engine-session",
        projectKey: "project",
        requestedBucket,
        readCatalog: () => catalog,
      }),
  };
}

describe("resolvePersistedBrowserBucket", () => {
  test("uses the canonical bucket only when no saved alias exists", () => {
    const f = fixture();
    expect(f.resolve().bucket).toBe("project::engine-session");
    expect(f.resolve("project::engine-session").bucket).toBe("project::engine-session");
    expect(() => f.resolve("project::arbitrary")).toThrow("saved conversation");
  });

  test("uses one Main-owned UI alias without a renderer hint", () => {
    const f = fixture([row("native-ui", "engine-session")]);
    const access = f.resolve();
    expect(access.bucket).toBe("project::native-ui");
    access.assertCurrent();
    expect(() => f.resolve("project::engine-session")).toThrow("saved conversation");
  });

  test("accepts a saved row whose UI and engine IDs are identical", () => {
    expect(fixture([row("engine-session")]).resolve().bucket).toBe("project::engine-session");
  });

  test("canonical fallback cannot collide with a UI ID bound to another engine", () => {
    const f = fixture([row("engine-session", "other-engine")]);
    expect(() => f.resolve()).toThrow("another saved conversation");
    expect(() => f.resolve("project::engine-session")).toThrow("another saved conversation");
  });

  test("multiple aliases require an exact saved hint", () => {
    const f = fixture([row("first", "engine-session"), row("second", "engine-session")]);
    expect(() => f.resolve()).toThrow("multiple saved aliases");
    expect(f.resolve("project::second").bucket).toBe("project::second");
    expect(() => f.resolve("other-project::second")).toThrow("saved conversation");
    expect(() => f.resolve("project::second-extra")).toThrow("saved conversation");
  });

  test("cannot use a saved row bound to another engine Session or project", () => {
    const f = fixture([row("native-ui", "other-engine")]);
    f.catalog.indices.other = {
      sessions: [row("foreign-ui", "engine-session")],
      activeSessionId: null,
    };
    expect(() => f.resolve("project::native-ui")).toThrow("saved conversation");
    expect(() => f.resolve("other::foreign-ui")).toThrow("saved conversation");
    expect(() => f.resolve("project::foreign-ui")).toThrow("saved conversation");
  });

  test.each(["delete", "rebind", "move"])("invalidates an alias after %s", (change) => {
    const f = fixture([row("native-ui", "engine-session")]);
    const access = f.resolve();
    if (change === "rebind") f.catalog.indices.project.sessions[0].engineSessionId = "other";
    else {
      if (change === "move") f.catalog.indices.other = f.catalog.indices.project;
      delete f.catalog.indices.project;
    }
    expect(() => access.assertCurrent()).toThrow("alias changed");
  });

  test("title, selection, unrelated aliases and catalog revisions do not revoke a selected alias", () => {
    const f = fixture([row("native-ui", "engine-session")]);
    const access = f.resolve();
    f.catalog.indices.project.sessions[0].title = "Renamed";
    f.catalog.indices.project.sessions[0].updatedAt++;
    f.catalog.indices.project.activeSessionId = "native-ui";
    f.catalog.indices.project.sessions.push(row("another-ui", "engine-session"));
    f.catalog.revision++;
    access.assertCurrent();
  });

  test("a new alias invalidates a previously unindexed canonical fallback", () => {
    const f = fixture();
    const access = f.resolve();
    f.catalog.indices.project.sessions.push(row("native-ui", "engine-session"));
    expect(() => access.assertCurrent()).toThrow("alias changed");
  });
});
