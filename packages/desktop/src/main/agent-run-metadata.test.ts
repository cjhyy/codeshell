import { describe, expect, test } from "bun:test";
import { prepareAgentRunMetadata, resolveCredentialSessionCwd } from "./agent-run-metadata.js";

describe("prepareAgentRunMetadata", () => {
  test("strips main-only browser routing fields and injects main-owned trust", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "agent/run",
      params: {
        cwd: "/repo",
        sessionId: "s1",
        bucket: "repo::s1",
        browserPartition: "persist:browser:repo::s1",
        projectTrusted: true,
        prompt: "hi",
      },
    });

    const prepared = prepareAgentRunMetadata(line, (cwd) => cwd === "/repo");
    expect(prepared).toMatchObject({
      cwd: "/repo",
      sessionId: "s1",
      bucket: "repo::s1",
      browserPartition: "persist:browser:repo::s1",
    });
    const out = JSON.parse(prepared.outLine) as {
      params: Record<string, unknown>;
    };
    expect(out.params.bucket).toBeUndefined();
    expect(out.params.browserPartition).toBeUndefined();
    expect(out.params.projectTrusted).toBe(true);
    expect(out.params.prompt).toBe("hi");
  });

  test("main-owned trust fails closed when cwd is absent or untrusted", () => {
    const trustedMissingCwd = prepareAgentRunMetadata(
      JSON.stringify({ method: "agent/run", params: { sessionId: "s1", projectTrusted: true } }),
      () => true,
    );
    expect(JSON.parse(trustedMissingCwd.outLine).params.projectTrusted).toBe(false);

    const untrusted = prepareAgentRunMetadata(
      JSON.stringify({ method: "agent/run", params: { cwd: "/repo", projectTrusted: true } }),
      () => false,
    );
    expect(JSON.parse(untrusted.outLine).params.projectTrusted).toBe(false);
  });

  test("non-run or malformed lines pass through", () => {
    const query = JSON.stringify({ method: "agent/query", params: { sessionId: "s1" } });
    expect(prepareAgentRunMetadata(query, () => true).outLine).toBe(query);
    expect(prepareAgentRunMetadata("{not json", () => true).outLine).toBe("{not json");
  });

  test("credential cwd resolution uses session or persisted cwd and otherwise fails closed", () => {
    expect(resolveCredentialSessionCwd("s1", new Map([["s1", "/repo"]]), () => "/wrong")).toBe(
      "/repo",
    );
    expect(
      resolveCredentialSessionCwd("s2", new Map(), (sid) => (sid === "s2" ? "/saved" : undefined)),
    ).toBe("/saved");
    expect(() => resolveCredentialSessionCwd("s3", new Map(), () => undefined)).toThrow(
      /no cwd registered/,
    );
  });
});
