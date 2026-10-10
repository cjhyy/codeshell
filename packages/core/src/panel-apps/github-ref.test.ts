import { describe, expect, test } from "bun:test";
import { resolveGitHubPanelAppCommit } from "./github-ref.js";

const head = "a".repeat(40);
const other = "b".repeat(40);
const tagObject = "c".repeat(40);
const source = { kind: "git" as const, url: "https://github.com/acme/panels.git" };

function packet(value: string): string {
  return (Buffer.byteLength(value) + 4).toString(16).padStart(4, "0") + value;
}

function advertisement(
  refs = [
    `${head} HEAD\0symref=HEAD:refs/heads/main\n`,
    `${head} refs/heads/main\n`,
    `${other} refs/heads/feature/editor\n`,
    `${tagObject} refs/tags/v1.0\n`,
    `${other} refs/tags/v1.0^{}\n`,
    `${other} refs/tags/main\n`,
  ],
): string {
  return packet("# service=git-upload-pack\n") + "0000" + refs.map(packet).join("") + "0000";
}

function response(body = advertisement(), headers: Record<string, string> = {}): Response {
  return new Response(body, {
    headers: {
      "content-type": "application/x-git-upload-pack-advertisement",
      ...headers,
    },
  });
}

describe("GitHub Panel App Git ref resolution", () => {
  test("resolves the default HEAD through one bounded Git advertisement, without the API", async () => {
    let calls = 0;
    const commit = await resolveGitHubPanelAppCommit(source, {
      fetch: async (url, init) => {
        calls++;
        expect(String(url)).toBe(
          "https://github.com/acme/panels.git/info/refs?service=git-upload-pack",
        );
        expect(init?.redirect).toBe("error");
        expect(init?.credentials).toBe("omit");
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect(new Headers(init?.headers).has("Git-Protocol")).toBe(false);
        return response();
      },
    });
    expect(commit).toBe(head);
    expect(calls).toBe(1);
  });

  test.each([
    ["main", head],
    ["feature/editor", other],
    ["refs/heads/main", head],
    ["v1.0", other],
    ["refs/tags/v1.0", other],
  ])(
    "resolves %s, including peeled annotated tags and branch precedence",
    async (ref, expected) => {
      expect(
        await resolveGitHubPanelAppCommit({ ...source, ref }, { fetch: async () => response() }),
      ).toBe(expected);
    },
  );

  test("accepts an explicit SHA without any network request", async () => {
    expect(
      await resolveGitHubPanelAppCommit(
        { ...source, ref: other.toUpperCase() },
        {
          fetch: async () => {
            throw new Error("unexpected network");
          },
        },
      ),
    ).toBe(other);
  });

  test("validates the GitHub origin even for a pinned SHA", async () => {
    await expect(
      resolveGitHubPanelAppCommit({ ...source, url: "https://example.com/acme/panels", ref: head }),
    ).rejects.toThrow("public https://github.com");
  });

  test("reports a missing ref and an empty repository", async () => {
    await expect(
      resolveGitHubPanelAppCommit({ ...source, ref: "missing" }, { fetch: async () => response() }),
    ).rejects.toThrow("ref was not found");
    await expect(
      resolveGitHubPanelAppCommit(source, { fetch: async () => response(advertisement([])) }),
    ).rejects.toThrow("ref was not found");
  });

  test.each([
    "not a Git advertisement",
    advertisement().slice(0, -1),
    advertisement() + "0000",
    advertisement([`${head} HEAD\n`, `${other} HEAD\n`]),
    advertisement([`${head} HEAD\n`, `${other} refs/heads/main\0capability\n`]),
    packet("# service=git-upload-pack\n") + "0000" + "0001",
  ])("rejects malformed or ambiguous protocol packets", async (body) => {
    await expect(
      resolveGitHubPanelAppCommit(source, { fetch: async () => response(body) }),
    ).rejects.toThrow("invalid Git ref advertisement");
  });

  test("rejects high-bit packet lengths instead of normalizing them to ASCII hex", async () => {
    const body = Buffer.from(advertisement());
    body[0] |= 0x80;
    await expect(
      resolveGitHubPanelAppCommit(source, {
        fetch: async () =>
          new Response(body, {
            headers: { "content-type": "application/x-git-upload-pack-advertisement" },
          }),
      }),
    ).rejects.toThrow("invalid Git ref advertisement");
  });

  test("rejects a non-Git content type and a false Content-Length", async () => {
    for (const headers of [{ "content-type": "text/html" }, { "content-length": "1" }]) {
      await expect(
        resolveGitHubPanelAppCommit(source, { fetch: async () => response(undefined, headers) }),
      ).rejects.toThrow(/invalid Git ref advertisement|length does not match/);
    }
  });

  test("caps both declared and streamed advertisements with an actionable SHA fallback", async () => {
    for (const reply of [
      response(undefined, { "content-length": String(4 * 1024 * 1024 + 1) }),
      response("x".repeat(4 * 1024 * 1024 + 1)),
    ]) {
      await expect(
        resolveGitHubPanelAppCommit(source, { fetch: async () => reply }),
      ).rejects.toThrow("4 MiB limit; use a full commit SHA");
    }
  });

  test.each([404, 403, 429, 503])("preserves HTTP %s failures", async (status) => {
    await expect(
      resolveGitHubPanelAppCommit(source, { fetch: async () => new Response(null, { status }) }),
    ).rejects.toThrow(status === 404 ? "ref was not found" : `HTTP ${status}`);
  });

  test("bounds a hung request even when the transport ignores the signal", async () => {
    await expect(
      resolveGitHubPanelAppCommit(source, {
        timeoutMs: 5,
        fetch: () => new Promise(() => undefined),
      }),
    ).rejects.toThrow("timed out");
  });

  test("bounds a stalled body and cancels it without awaiting stalled cancellation", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from(packet("# service=git-upload-pack\n")));
      },
      cancel() {
        cancelled = true;
        return new Promise(() => undefined);
      },
    });
    await expect(
      resolveGitHubPanelAppCommit(source, {
        timeoutMs: 5,
        fetch: async () =>
          new Response(body, {
            headers: { "content-type": "application/x-git-upload-pack-advertisement" },
          }),
      }),
    ).rejects.toThrow("timed out");
    expect(cancelled).toBe(true);
  });
});
