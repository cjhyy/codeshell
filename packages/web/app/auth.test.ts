import { afterEach, describe, expect, test } from "bun:test";
import { api, ApiError, readAuthStatus, takeSetupToken, uploadFile } from "./auth.js";
import { setApiProject, setApiWorkspace } from "./api-context.js";
const nativeFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = nativeFetch;
  setApiProject(null);
  setApiWorkspace(undefined);
});

describe("Hub browser authentication", () => {
  test("consumes setup token from fragment without retaining it in browser history", () => {
    const calls: unknown[][] = [];
    const location = { hash: "#setup=secret%2Btoken&tab=chat", pathname: "/", search: "?lang=zh" };
    const history = {
      state: { existing: true },
      replaceState: (...args: unknown[]) => calls.push(args),
    };
    expect(takeSetupToken(location, history)).toBe("secret+token");
    expect(calls).toEqual([[{ existing: true }, "", "/?lang=zh#tab=chat"]]);
  });

  test("does not rewrite unrelated fragments", () => {
    let rewritten = false;
    expect(
      takeSetupToken(
        { hash: "#chat", pathname: "/", search: "" },
        {
          state: null,
          replaceState: () => {
            rewritten = true;
          },
        },
      ),
    ).toBe("");
    expect(rewritten).toBe(false);
  });

  test("only 404 permits the legacy no-account client", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
    await expect(readAuthStatus()).resolves.toBeNull();
    globalThis.fetch = (async () =>
      new Response('{"error":"Unavailable"}', { status: 503 })) as typeof fetch;
    await expect(readAuthStatus()).rejects.toThrow("Unavailable");
    globalThis.fetch = (async () => {
      throw new TypeError("Offline");
    }) as unknown as typeof fetch;
    await expect(readAuthStatus()).rejects.toThrow("Offline");
  });

  test("invalid successful status responses cannot open the client", async () => {
    globalThis.fetch = (async () => new Response("<!doctype html>offline")) as typeof fetch;
    await expect(readAuthStatus()).rejects.toThrow("无效的登录状态");
  });

  test("API calls use same-origin cookies and bypass caches", async () => {
    let options: RequestInit | undefined;
    globalThis.fetch = (async (_path, init) => {
      options = init;
      return new Response('{"authenticated":true}');
    }) as typeof fetch;
    await expect(api("/api/v1/auth/status")).resolves.toEqual({ authenticated: true });
    expect(options?.credentials).toBe("same-origin");
    expect(options?.cache).toBe("no-store");
  });

  test("401 keeps a typed status for the login gate", async () => {
    globalThis.fetch = (async () =>
      new Response('{"error":"Session revoked"}', { status: 401 })) as typeof fetch;
    try {
      await api("/api/v1/auth/sessions");
      throw new Error("must reject");
    } catch (cause) {
      expect(cause).toBeInstanceOf(ApiError);
      expect((cause as ApiError).status).toBe(401);
    }
  });

  test("uploads a binary file with encoded filename and returns server-issued ID", async () => {
    let path: string | undefined;
    let options: RequestInit | undefined;
    globalThis.fetch = (async (input, init) => {
      path = String(input);
      options = init;
      return new Response(
        JSON.stringify({
          id: "server-id",
          name: "截图.png",
          mimeType: "image/png",
          size: 3,
          path: "/server/file",
        }),
      );
    }) as typeof fetch;
    const file = new File([new Uint8Array([1, 2, 3])], "截图.png", { type: "image/png" });
    const uploaded = await uploadFile(file);
    expect(path).toStartWith("/api/v1/uploads/");
    expect(options?.method).toBe("PUT");
    expect(options?.body).toBe(file);
    expect(options?.headers).toEqual({
      "Content-Type": "image/png",
      "X-File-Name": encodeURIComponent("截图.png"),
    });
    expect(uploaded.id).toBe("server-id");
  });
});

test("an explicit API scope cannot inherit a later project prefix or workspace headers", async () => {
  setApiProject("22222222-2222-4222-8222-222222222222");
  setApiWorkspace("/later");
  let path = "",
    headers: Headers;
  globalThis.fetch = (async (value, init) => {
    path = String(value);
    headers = new Headers(init?.headers);
    return Response.json({ ok: true });
  }) as typeof fetch;
  await api(
    "/api/v1/links/authorizations/attempt",
    { method: "DELETE" },
    { projectId: null, workspace: "/original" },
  );
  expect(path).toBe("/api/v1/links/authorizations/attempt?workspace=%2Foriginal");
  expect(headers!.get("X-CodeShell-Workspace")).toBe("%2Foriginal");
  await api(
    "/api/v1/links/authorizations/attempt",
    { method: "DELETE" },
    { projectId: null, workspace: "" },
  );
  expect(path).toBe("/api/v1/links/authorizations/attempt");
  expect(headers!.get("X-CodeShell-Workspace")).toBeNull();
});
