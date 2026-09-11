import { describe, expect, test } from "bun:test";
import { browserPartitionForBucket } from "../shared/browser-profile.js";
import type { PreparedAgentRunMetadata } from "./agent-run-metadata.js";
import { resolveAgentRunBrowserRegistration } from "./agent-run-browser-registration.js";

function preparedRun(overrides: Partial<PreparedAgentRunMetadata> = {}): PreparedAgentRunMetadata {
  return {
    parsed: {
      method: "agent/run",
      params: { sessionId: "session-1", projectId: "project-1", requireExisting: true },
    },
    outLine: "{}",
    sessionId: "session-1",
    cwd: "/project/worktree",
    meta: { origin: "host", producer: "automation-resume" },
    ...overrides,
  };
}

describe("resolveAgentRunBrowserRegistration", () => {
  test("a cold scheduled continuation restores the resolved project's browser profile", () => {
    expect(resolveAgentRunBrowserRegistration(preparedRun())).toEqual({
      sessionId: "session-1",
      bucket: "project-1::session-1",
      partition: browserPartitionForBucket("project-1::session-1"),
    });
  });

  test("a resolved run without project authority uses the no-project browser profile", () => {
    const prepared = preparedRun({
      parsed: { method: "agent/run", params: { sessionId: "session-1" } },
      cwd: "/no-repo",
    });
    expect(resolveAgentRunBrowserRegistration(prepared)).toEqual({
      sessionId: "session-1",
      bucket: "__no_repo__::session-1",
      partition: browserPartitionForBucket("__no_repo__::session-1"),
    });
  });

  test("existing host routing and its partition survive a continuation", () => {
    expect(
      resolveAgentRunBrowserRegistration(preparedRun(), {
        existingBucket: "host-owned-workspace",
        existingPartition: "persist:browser:u:chosen-account",
        externalRuntime: true,
      }),
    ).toEqual({
      sessionId: "session-1",
      bucket: "host-owned-workspace",
      partition: "persist:browser:u:chosen-account",
    });
  });

  test("an existing Quick Chat keeps its temporary profile", () => {
    const bucket = "__quick_chat__::chat-1";
    const registration = resolveAgentRunBrowserRegistration(preparedRun(), {
      existingBucket: bucket,
    });
    expect(registration?.bucket).toBe(bucket);
    expect(registration?.partition).toBe(browserPartitionForBucket(bucket));
    expect(registration?.partition.startsWith("persist:")).toBe(false);
  });

  test("a Quick Chat without a registration never acquires a persistent project profile", () => {
    const registration = resolveAgentRunBrowserRegistration(
      preparedRun({ sessionId: "qchat-new" }),
      { externalRuntime: true },
    );
    expect(registration?.bucket).toBe("__quick_chat__::qchat-new");
    expect(registration?.partition.startsWith("persist:")).toBe(false);
  });

  test("a cold external-runtime continuation restores its isolated profile", () => {
    const registration = resolveAgentRunBrowserRegistration(preparedRun(), {
      externalRuntime: true,
    });
    expect(registration).toEqual({
      sessionId: "session-1",
      bucket: "external-runtime:session-1",
      partition: browserPartitionForBucket("external-runtime:session-1"),
    });
    expect(registration?.partition).not.toBe(browserPartitionForBucket("project-1::session-1"));
  });

  test("explicit caller routing takes precedence over restored identities", () => {
    expect(
      resolveAgentRunBrowserRegistration(
        preparedRun({ bucket: "explicit::session-1", browserPartition: "explicit-partition" }),
        {
          existingBucket: "old::session-1",
          existingPartition: "old-partition",
          externalRuntime: true,
        },
      ),
    ).toEqual({
      sessionId: "session-1",
      bucket: "explicit::session-1",
      // Leave partition validation to registerSessionBucket, as before.
      partition: "explicit-partition",
    });
  });

  test("an explicit Quick Chat bucket uses its temporary default partition", () => {
    const bucket = "__quick_chat__::chat-2";
    expect(resolveAgentRunBrowserRegistration(preparedRun({ bucket }))).toEqual({
      sessionId: "session-1",
      bucket,
      partition: browserPartitionForBucket(bucket),
    });
  });

  test("unresolved or non-run context cannot infer a browser identity", () => {
    for (const prepared of [
      preparedRun({ cwd: undefined }),
      preparedRun({ sessionId: undefined }),
      preparedRun({ parsed: { method: "agent/query", params: { projectId: "project-1" } } }),
    ]) {
      expect(resolveAgentRunBrowserRegistration(prepared)).toBeUndefined();
      expect(
        resolveAgentRunBrowserRegistration(prepared, {
          existingBucket: "existing-workspace",
          externalRuntime: true,
        }),
      ).toBeUndefined();
    }
  });
});
