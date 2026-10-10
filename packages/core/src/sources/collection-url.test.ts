import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { Readable } from "node:stream";
import { officeZip, textPdf, wordXml } from "../../../../tests/fixtures/upload-documents.mjs";

// Install before the first source/transport import. The injected transport below
// permits one exact synthetic origin and never opens a network socket.
const surfaces = [
  [globalThis, "fetch"],
  [http, "request"],
  [http, "get"],
  [https, "request"],
  [https, "get"],
  [net, "connect"],
  [net, "createConnection"],
  [net.Socket.prototype, "connect"],
] as const;
const prior = surfaces.map(([target, key]) => ({
  target: target as unknown as Record<string, unknown>,
  key,
  descriptor: Object.getOwnPropertyDescriptor(target, key),
}));
const denied: string[] = [];
const wrappers = prior.map(({ target, key }, index) => {
  const wrapper = () => {
    denied.push(`${index}:${key}`);
    throw new Error("Collection URL fixture denied outbound network");
  };
  target[key] = wrapper;
  return wrapper;
});
syncBuiltinESMExports();
expect(() => fetch("https://outside.invalid/probe")).toThrow("denied outbound");
expect(() => https.request("https://outside.invalid/probe")).toThrow("denied outbound");
expect(denied).toHaveLength(2);
const urlModule = await import("./collection-url.js");
const { normalizeCollectionUrl, createCollectionUrlDownloaderForTests, collectionUrlDocumentName } =
  urlModule;
afterAll(() => {
  expect(denied).toHaveLength(2);
  for (const [index, surface] of prior.entries()) {
    expect(surface.target[surface.key]).toBe(wrappers[index]);
    if (surface.descriptor) Object.defineProperty(surface.target, surface.key, surface.descriptor);
    else Reflect.deleteProperty(surface.target, surface.key);
  }
  syncBuiltinESMExports();
});

const ORIGIN = "https://files.example";
const URL_FILE = ORIGIN + "/brief.txt";
const PUBLIC_IP = "93.184.216.34";
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
interface Reply {
  status?: number;
  headers?: Record<string, string>;
  chunks?: Buffer[];
  remote?: string;
  authorized?: boolean;
  hold?: boolean;
  complete?: boolean;
  error?: Error;
}

function fixture(replies: Reply[] = [{ chunks: [Buffer.from("fixture document")] }]) {
  const requests: Array<{
    options: https.RequestOptions;
    request: EventEmitter & { destroyed: boolean };
    response?: Readable;
  }> = [];
  let lookupCount = 0,
    timerCallback: (() => void) | undefined,
    activeTimer = false;
  let addresses = [{ address: PUBLIC_IP, family: 4 }];
  let resolveLookup: (() => void) | undefined,
    holdLookup = false;
  const request = ((
    options: https.RequestOptions,
    callback: (response: http.IncomingMessage) => void,
  ) => {
    expect(new URL(`${options.protocol}//${options.hostname}:${options.port}`).origin).toBe(ORIGIN);
    expect(options.method).toBe("GET");
    expect(options.agent).toBe(false);
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.servername).toBe("files.example");
    expect(options.autoSelectFamily).toBe(false);
    expect(options.headers).toEqual({
      Accept: "application/octet-stream",
      "Accept-Encoding": "identity",
    });
    let pinned = "";
    (
      options.lookup as (
        host: string,
        options: object,
        callback: (error: unknown, ip: string, family: number) => void,
      ) => void
    )("files.example", {}, (error: unknown, ip: string, family: number) => {
      expect(error).toBeNull();
      expect(family).toBe(4);
      pinned = ip;
    });
    expect(pinned).toBe(PUBLIC_IP);
    const reply = replies[requests.length] ?? replies.at(-1)!;
    const req = new EventEmitter() as EventEmitter & {
      destroyed: boolean;
      end: () => void;
      destroy: () => typeof req;
    };
    req.destroyed = false;
    const item: (typeof requests)[number] = { options, request: req };
    requests.push(item);
    req.destroy = () => {
      if (!req.destroyed) {
        req.destroyed = true;
        item.response?.destroy();
        queueMicrotask(() => req.emit("close"));
      }
      return req;
    };
    req.end = () =>
      queueMicrotask(() => {
        if (req.destroyed) return;
        if (reply.error) {
          req.emit("error", reply.error);
          return;
        }
        const socket = Object.assign(new EventEmitter(), {
          authorized: reply.authorized ?? true,
          remoteAddress: reply.remote ?? pinned,
        });
        req.emit("socket", socket);
        socket.emit("secureConnect");
        if (req.destroyed) return;
        let delivered = false;
        const response = new Readable({
          read() {
            if (delivered) return;
            delivered = true;
            for (const chunk of reply.chunks ?? []) this.push(chunk);
            if (!reply.hold) {
              (this as unknown as http.IncomingMessage).complete = reply.complete ?? true;
              this.push(null);
            }
          },
        });
        Object.assign(response, {
          statusCode: reply.status ?? 200,
          headers: reply.headers ?? {},
          socket,
          complete: false,
        });
        item.response = response;
        callback(response as http.IncomingMessage);
      });
    return req;
  }) as typeof https.request;
  const download = createCollectionUrlDownloaderForTests({
    request,
    lookup: async (host) => {
      expect(host).toBe("files.example");
      lookupCount++;
      if (holdLookup)
        await new Promise<void>((resolve) => {
          resolveLookup = resolve;
        });
      return addresses;
    },
    setTimer: ((callback: () => void, delay: number) => {
      expect(delay).toBe(30_000);
      timerCallback = callback;
      activeTimer = true;
      return 123;
    }) as unknown as typeof setTimeout,
    clearTimer: (() => {
      activeTimer = false;
    }) as typeof clearTimeout,
  });
  return {
    download,
    requests,
    get lookupCount() {
      return lookupCount;
    },
    get activeTimer() {
      return activeTimer;
    },
    setAddresses(value: typeof addresses) {
      addresses = value;
    },
    holdLookup() {
      holdLookup = true;
    },
    releaseLookup() {
      resolveLookup?.();
    },
    expire() {
      timerCallback!();
    },
    assertClosed() {
      expect(activeTimer).toBe(false);
      for (const item of requests) {
        expect(item.request.destroyed).toBe(true);
        if (item.response) expect(item.response.closed).toBe(true);
      }
    },
  };
}
async function tick() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("collection static-file URL validation", () => {
  test("pure normalization preserves query and never starts listing traffic", () => {
    expect(normalizeCollectionUrl("https://FILES.example:443/a%20b.txt?v=1")).toBe(
      "https://files.example/a%20b.txt?v=1",
    );
    expect(denied).toHaveLength(2);
  });
  for (const value of [
    "http://files.example/a.txt",
    "file:///tmp/a",
    "https://u:p@files.example/a.txt",
    "https://files.example/a#x",
    "https://files.example/",
    "https://localhost/a",
    "https://foo.internal/a",
    "https://127.1/a",
    "https://0x7f000001/a",
    "https://[::1]/a",
    "https://[::ffff:7f00:1]/a",
    "https://[2002:7f00:1::]/a",
    "https://[2001:db8::1]/a",
    "https://[3fff::1]/a",
    "https://192.0.2.1/a",
    "https://files.example/a\n",
    1,
  ]) {
    test(`refuses unsafe or non-file URL ${String(value)}`, () =>
      expect(() => normalizeCollectionUrl(value)).toThrow());
  }
});

describe("collection URL pinned transport and bounded proof", () => {
  test("returns exact bytes/hash, HTTPS authority and a pinned native lookup", async () => {
    const body = Buffer.from("fixture document"),
      f = fixture([
        {
          chunks: [body],
          headers: {
            "content-length": String(body.length),
            "content-type": "text/plain; charset=utf-8",
          },
        },
      ]);
    const result = await f.download({
      url: URL_FILE,
      expected: { sizeBytes: body.length, sha256: digest(body) },
    });
    expect(result.bytes).toEqual(body);
    expect(result.proof).toEqual({
      requestedUrl: URL_FILE,
      finalUrl: URL_FILE,
      sizeBytes: body.length,
      sha256: digest(body),
      mimeType: "text/plain",
    });
    expect(f.lookupCount).toBe(1);
    f.assertClosed();
  });
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "192.168.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "::",
    "::ffff:7f00:1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "2002:808:808::1",
  ]) {
    test(`rejects mixed DNS containing ${address} before opening`, async () => {
      const f = fixture();
      f.setAddresses([
        { address: PUBLIC_IP, family: 4 },
        { address, family: address.includes(":") ? 6 : 4 },
      ]);
      await expect(f.download({ url: URL_FILE })).rejects.toThrow("only to public");
      expect(f.requests).toHaveLength(0);
      f.assertClosed();
    });
  }
  test("rejects actual peer mismatch and failed TLS authorization", async () => {
    for (const reply of [{ remote: "127.0.0.1" }, { authorized: false }]) {
      const f = fixture([reply]);
      await expect(f.download({ url: URL_FILE })).rejects.toThrow("TLS connection");
      f.assertClosed();
    }
  });
  test("same-origin redirects close each response and resolve DNS afresh", async () => {
    const f = fixture([
      { status: 302, headers: { location: "/current.txt" } },
      { chunks: [Buffer.from("new")] },
    ]);
    const result = await f.download({ url: URL_FILE });
    expect(result.proof.finalUrl).toBe(ORIGIN + "/current.txt");
    expect(f.lookupCount).toBe(2);
    f.assertClosed();
  });
  test("rejects cross-origin, downgrade/private redirects and loops", async () => {
    for (const location of [
      "https://other.example/file.txt",
      "http://files.example/file.txt",
      "https://127.0.0.1/a",
      "/brief.txt",
    ]) {
      const f = fixture([{ status: 302, headers: { location } }]);
      await expect(f.download({ url: URL_FILE })).rejects.toThrow();
      expect(f.requests.length).toBe(location === "/brief.txt" ? 4 : 1);
      f.assertClosed();
    }
  });
  test("rejects non-200, HTML, compressed transfers and incomplete length", async () => {
    for (const reply of [
      { status: 404 },
      { status: 206 },
      { headers: { "content-type": "text/html" } },
      { headers: { "content-encoding": "gzip" } },
      { headers: { "content-length": "3" }, chunks: [Buffer.from("x")] },
      { chunks: [Buffer.from("x")], complete: false },
    ]) {
      const f = fixture([reply]);
      await expect(f.download({ url: URL_FILE })).rejects.toThrow();
      f.assertClosed();
    }
  });
  test("exact 20MiB succeeds; declared and streamed +1 byte fail without truncated proof", async () => {
    const bytes = Buffer.alloc(20 * 1024 * 1024, 120);
    const valid = fixture([{ chunks: [bytes] }]);
    expect((await valid.download({ url: URL_FILE })).proof.sizeBytes).toBe(bytes.length);
    valid.assertClosed();
    for (const reply of [
      { headers: { "content-length": String(bytes.length + 1) } },
      { chunks: [bytes, Buffer.from("x")] },
    ]) {
      const f = fixture([reply]);
      await expect(f.download({ url: URL_FILE })).rejects.toThrow("20 MiB");
      f.assertClosed();
    }
  });
  test("changed size/hash never returns newly downloaded content as the saved version", async () => {
    const f = fixture();
    await expect(
      f.download({ url: URL_FILE, expected: { sizeBytes: 16, sha256: "0".repeat(64) } }),
    ).rejects.toThrow("changed");
    f.assertClosed();
  });
  test("cancellation destroys an active body and settles close before rejection", async () => {
    const f = fixture([{ hold: true, chunks: [Buffer.from("partial")] }]),
      c = new AbortController(),
      reason = new Error("user cancelled");
    const work = f.download({ url: URL_FILE }, { signal: c.signal });
    await tick();
    c.abort(reason);
    try {
      await work;
      throw new Error("Unexpected success");
    } catch (cause) {
      expect(cause).toBe(reason);
    }
    f.assertClosed();
  });
  test("the fixed total timeout destroys the request and clears its timer", async () => {
    const f = fixture([{ hold: true }]);
    const work = f.download({ url: URL_FILE });
    await tick();
    f.expire();
    await expect(work).rejects.toThrow("30 second time limit");
    f.assertClosed();
  });
  test("cancelled DNS cannot launch a later request", async () => {
    const f = fixture(),
      c = new AbortController();
    f.holdLookup();
    const work = f.download({ url: URL_FILE }, { signal: c.signal });
    await tick();
    c.abort();
    await expect(work).rejects.toThrow();
    f.releaseLookup();
    await tick();
    expect(f.requests).toHaveLength(0);
    f.assertClosed();
  });
  test("revoked authority and transport errors preserve failure and close resources", async () => {
    let calls = 0;
    const f = fixture();
    await expect(
      f.download(
        { url: URL_FILE },
        {
          assertAuthorized: () => {
            if (++calls === 4) throw new Error("revoked");
          },
        },
      ),
    ).rejects.toThrow("revoked");
    f.assertClosed();
    const broken = fixture([{ error: new Error("fixture transport failed") }]);
    await expect(broken.download({ url: URL_FILE })).rejects.toThrow("fixture transport failed");
    broken.assertClosed();
  });
});

describe("static-link document metadata reaches the real collection consumers", () => {
  test("parser hints use the final filename or supported MIME without inventing unsupported types", () => {
    const hint = (path: string, mimeType = "application/octet-stream", savedName?: string) =>
      collectionUrlDocumentName({ finalUrl: ORIGIN + path, mimeType }, savedName);
    expect(hint("/manual.DOCX?filename=bad.txt")).toBe("manual.DOCX");
    expect(hint("/download", "application/pdf")).toBe("download.pdf");
    expect(hint("/download.php", "application/pdf")).toBe("download.php.pdf");
    expect(hint("/download", "application/octet-stream", "legacy.docx")).toBe("legacy.docx");
    expect(hint("/manual.xlsx", "application/octet-stream", "legacy.docx")).toBe("manual.xlsx");
    expect(hint("/download", "application/zip")).toBe("download");
    expect(hint("/download", "application/msword")).toBe("download");
    expect(hint("/download", "__proto__")).toBe("download");
    expect(hint("/%E8%B5%84%E6%96%99", "application/pdf")).toBe("资料.pdf");
    expect(hint("/" + "x".repeat(512), "application/pdf")).toHaveLength(512);
    for (const path of ["/bad%", "/bad%2fname", "/bad%5cname", "/bad%00name", "/bad%0aname"])
      expect(() => hint(path, "application/pdf")).toThrow("链接文件名无效");
    expect(denied).toHaveLength(2);
  });

  const documents = [
    {
      name: "download",
      format: "docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes: officeZip({ "word/document.xml": wordXml("legacy static milestone") }),
    },
    {
      name: "download",
      format: "pptx",
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      bytes: officeZip({
        "ppt/slides/slide1.xml":
          '<a:p xmlns:a="urn:a"><a:r><a:t>legacy static milestone</a:t></a:r></a:p>',
      }),
    },
    {
      name: "download",
      format: "xlsx",
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes: officeZip({
        "xl/worksheets/sheet1.xml":
          '<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>legacy static milestone</t></is></c></row></sheetData></worksheet>',
      }),
    },
    {
      name: "download",
      format: "pdf",
      mime: "application/pdf",
      bytes: textPdf("legacy static milestone"),
    },
    {
      name: "legacy.docx",
      format: "docx",
      mime: "application/octet-stream",
      bytes: officeZip({ "word/document.xml": wordXml("legacy static milestone") }),
    },
  ];
  test.each(documents)(
    "saved $name URL records parse actual $format bytes and recheck the version on cached reads",
    async ({ bytes, mime, format, name }) => {
      const f = fixture([
        {
          chunks: [bytes],
          headers: { "content-type": mime },
        },
        {
          chunks: [Buffer.concat([bytes, Buffer.from("changed")])],
          headers: { "content-type": mime },
        },
      ]);
      const download = spyOn(urlModule, "downloadCollectionUrl").mockImplementation(f.download);
      const root = realpathSync(mkdtempSync(join(tmpdir(), "collection-url-read-")));
      try {
        const { collectionAdapter } = await import("./adapters/collection.js");
        const definition = {
          id: "static_docs",
          kind: "collection" as const,
          label: "Static docs",
          enabled: true,
          adapterConfig: {
            version: 1,
            revision: randomUUID(),
            entries: [
              {
                id: "entry_legacy",
                kind: "url",
                name,
                url: ORIGIN + "/download",
                sizeBytes: bytes.length,
                sha256: digest(bytes),
                checkedAt: new Date().toISOString(),
              },
            ],
          },
        };
        const result = await collectionAdapter.read(definition, "entry_legacy", {
          cwd: root,
          maxBytes: 4096,
          assertAuthorized: () => {},
          query: "milestone",
        });
        expect(result.text).toContain("legacy static milestone");
        expect(result.text).toContain(`"format":"${format}"`);
        expect(result.resourceId).toBe("entry_legacy");
        expect(definition.adapterConfig.entries[0]!.name).toBe(name);
        await expect(
          collectionAdapter.read(definition, "entry_legacy", {
            cwd: root,
            maxBytes: 4096,
            assertAuthorized: () => {},
          }),
        ).rejects.toThrow("Static file changed; refresh the collection entry");
        f.assertClosed();
      } finally {
        download.mockRestore();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
