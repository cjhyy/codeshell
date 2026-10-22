import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InputAttachmentMeta } from "@cjhyy/code-shell-server/storage";
import {
  PetChatAttachmentContext,
  selectPetChatAttachments,
} from "./pet-chat-attachment-context.js";

const roots: string[] = [];
const scope = { routeKey: "im:wechat\0target-a\0sender-a", sessionId: "pet-manager" };
const now = 10_000;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "codeshell-pet-attachment-context-"));
  roots.push(root);
  const attachment: InputAttachmentMeta = {
    id: "att-first",
    sessionId: scope.sessionId,
    kind: "image",
    origin: "im-gateway",
    path: ".code-shell/attachments/pet-manager/screenshot.jpg",
    relPath: "attachments/screenshot.jpg",
    absPath: join(root, "source-not-read.jpg"),
    mime: "image/jpeg",
    size: 100,
    sha256: "a".repeat(64),
    createdAt: now,
    width: 100,
    height: 50,
    vision: { include: true, detail: "high" },
  };
  return { root, attachment, store: new PetChatAttachmentContext(root) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("PetChatAttachmentContext", () => {
  test("retains a source image across text followups and restart without reading its file", async () => {
    const { root, attachment, store } = await fixture();
    await store.remember({ ...scope, attachments: [attachment], now });
    await store.remember({ ...scope, attachments: [], now: now + 1 });
    const restarted = new PetChatAttachmentContext(root);
    expect(await restarted.list({ ...scope, now: now + 2 })).toEqual([attachment]);
    expect(
      await restarted.select({
        ...scope,
        objective: `读图：\n\`${attachment.path}\``,
        now: now + 2,
      }),
    ).toEqual([attachment]);
    await expect(stat(attachment.absPath)).rejects.toThrow();
    if (process.platform !== "win32")
      expect((await stat(join(root, "chat-attachment-context.json"))).mode & 0o777).toBe(0o600);
  });

  test("selects only explicit complete references to a stored path alias", async () => {
    const { attachment, store } = await fixture();
    await store.remember({ ...scope, attachments: [attachment], now });
    for (const alias of [attachment.path, attachment.relPath!, attachment.absPath]) {
      expect(await store.select({ ...scope, objective: `检查 \`${alias}\`。`, now })).toEqual([
        attachment,
      ]);
      expect(await store.select({ ...scope, objective: `${alias}.bak`, now })).toEqual([]);
      expect(await store.select({ ...scope, objective: `读取（${alias}）`, now })).toEqual([
        attachment,
      ]);
      expect(await store.select({ ...scope, objective: `Read ${alias}.`, now })).toEqual([
        attachment,
      ]);
    }
    expect(await store.select({ ...scope, objective: "请解释刚才的图片", now })).toEqual([]);
    expect(
      await store.select({ ...scope, objective: `/other/${attachment.relPath}`, now }),
    ).toEqual([]);
    expect(await store.select({ ...scope, objective: "screenshot.jpg", now })).toEqual([]);
  });

  test("selects a frozen turn snapshot without including a successor turn's images", async () => {
    const { attachment, store } = await fixture();
    await store.remember({ ...scope, attachments: [attachment], now });
    const frozen = await store.list({ ...scope, now });
    await store.remember({
      ...scope,
      attachments: [
        {
          ...attachment,
          id: "att-successor",
          path: "new.jpg",
          relPath: "new.jpg",
          absPath: "/new.jpg",
        },
      ],
      now: now + 1,
    });
    expect(selectPetChatAttachments(frozen, `Read \`${attachment.path}\``)).toEqual([attachment]);
    expect(selectPetChatAttachments(frozen, `${attachment.path}.bak`)).toEqual([]);
    expect(await store.select({ ...scope, objective: attachment.path, now: now + 1 })).toEqual([
      attachment,
    ]);
    expect(selectPetChatAttachments(frozen, "new.jpg")).toEqual([]);
    const selected = selectPetChatAttachments(frozen, attachment.absPath);
    selected[0].vision!.include = false;
    expect(frozen[0].vision!.include).toBe(true);
  });

  test("bounds only selected images when a turn snapshot combines old and new batches", async () => {
    const { attachment } = await fixture();
    const candidates = Array.from({ length: 16 }, (_, index) => ({
      ...attachment,
      id: `att-${index}`,
      path: `image-${index}.jpg`,
      relPath: `image-${index}.jpg`,
      absPath: `/image-${index}.jpg`,
    }));
    expect(selectPetChatAttachments(candidates, "`image-15.jpg`")).toEqual([candidates[15]]);
    expect(
      selectPetChatAttachments(
        candidates,
        candidates
          .slice(8)
          .map((item) => item.path)
          .join("\n"),
      ),
    ).toEqual(candidates.slice(8));
    expect(() =>
      selectPetChatAttachments(candidates, candidates.map((item) => item.path).join("\n")),
    ).toThrow(/limits/);
  });

  test("isolates conversation routes and manager Sessions including NUL route separators", async () => {
    const { attachment, store } = await fixture();
    await store.remember({ ...scope, attachments: [attachment], now });
    for (const other of [
      { ...scope, routeKey: "im:wechat\0target-a\0sender-b" },
      { ...scope, routeKey: "desktop" },
      { ...scope, sessionId: "pet-new-manager" },
    ]) {
      expect(await store.list({ ...other, now })).toEqual([]);
      expect(await store.select({ ...other, objective: attachment.absPath, now })).toEqual([]);
    }
  });

  test("retains consecutive image batches for an explicit comparison after text followups", async () => {
    const { attachment, store } = await fixture();
    await store.remember({ ...scope, attachments: [attachment], now });
    const next = {
      ...attachment,
      id: "att-next",
      path: "next.jpg",
      absPath: `${attachment.absPath}.next`,
      relPath: "next.jpg",
      createdAt: now + 1,
    };
    await store.remember({ ...scope, attachments: [next], now: now + 1 });
    await store.remember({
      ...scope,
      attachments: [{ ...attachment, kind: "file" }],
      now: now + 2,
    });
    expect(await store.list({ ...scope, now: now + 3 })).toEqual([attachment, next]);
    expect(
      await store.select({ ...scope, objective: `${attachment.path}\nnext.jpg`, now: now + 3 }),
    ).toEqual([attachment, next]);
  });

  test("expires each image independently so a newer image never renews an older image", async () => {
    const { root, attachment, store } = await fixture();
    await store.remember({ ...scope, attachments: [attachment], now });
    const next = {
      ...attachment,
      id: "att-next",
      path: "next.jpg",
      relPath: "next.jpg",
      absPath: `${attachment.absPath}.next`,
      createdAt: now + 3_599_999,
    };
    await store.remember({ ...scope, attachments: [next], now: next.createdAt });
    await store.remember({ ...scope, attachments: [attachment], now: next.createdAt });
    expect(await store.list({ ...scope, now: next.createdAt })).toEqual([attachment, next]);
    const restarted = new PetChatAttachmentContext(root);
    expect(await restarted.list({ ...scope, now: now + 3_600_000 })).toEqual([next]);
    expect(
      await restarted.select({
        ...scope,
        objective: `${attachment.path}\nnext.jpg`,
        now: now + 3_600_000,
      }),
    ).toEqual([next]);
    expect(await restarted.list({ ...scope, now: next.createdAt + 3_600_000 })).toEqual([]);
  });

  test("evicts oldest images by count and bytes while repeated identities preserve their order", async () => {
    const { attachment, store } = await fixture();
    const images = Array.from({ length: 10 }, (_, index) => ({
      ...attachment,
      id: `att-${index}`,
      path: `image-${index}.jpg`,
      relPath: `image-${index}.jpg`,
      absPath: `${attachment.absPath}.${index}`,
      createdAt: now + index,
    }));
    await store.remember({ ...scope, attachments: images.slice(0, 8), now: now + 8 });
    await store.remember({ ...scope, attachments: images.slice(8), now: now + 10 });
    expect(await store.list({ ...scope, now: now + 10 })).toEqual(images.slice(2));
    await store.remember({ ...scope, attachments: [images[2]], now: now + 11 });
    expect(await store.list({ ...scope, now: now + 11 })).toEqual(images.slice(2));
    const large = {
      ...attachment,
      id: "att-large",
      path: "large.jpg",
      relPath: "large.jpg",
      absPath: `${attachment.absPath}.large`,
      createdAt: now + 12,
      size: 20 * 1024 * 1024,
    };
    await store.remember({ ...scope, attachments: [large], now: now + 12 });
    expect(await store.list({ ...scope, now: now + 12 })).toEqual([large]);
  });

  test("expires after one hour without letting text followups renew the image", async () => {
    const { root, attachment, store } = await fixture();
    await store.remember({ ...scope, attachments: [attachment], now });
    await store.remember({ ...scope, attachments: [], now: now + 3_599_999 });
    const restarted = new PetChatAttachmentContext(root);
    expect(await restarted.list({ ...scope, now: now + 3_599_999 })).toEqual([attachment]);
    expect(await restarted.list({ ...scope, now: now + 3_600_000 })).toEqual([]);
    expect(
      await restarted.select({ ...scope, objective: attachment.path, now: now + 3_600_000 }),
    ).toEqual([]);
    expect(await restarted.list({ ...scope, now: now - 1 })).toEqual([]);
  });

  test("dedupes repeated source metadata without renewing its retention window", async () => {
    const { root, attachment, store } = await fixture();
    await store.remember({ ...scope, attachments: Array(12).fill(attachment), now });
    expect(await store.list({ ...scope, now })).toEqual([attachment]);
    await store.remember({ ...scope, attachments: [attachment], now: now + 3_599_999 });
    const restarted = new PetChatAttachmentContext(root);
    expect(await restarted.list({ ...scope, now: now + 3_600_000 })).toEqual([]);
    await restarted.remember({ ...scope, attachments: [attachment], now: now + 3_600_001 });
    expect(await restarted.list({ ...scope, now: now + 3_600_001 })).toEqual([]);
    await expect(
      restarted.remember({
        ...scope,
        attachments: [attachment, { ...attachment, absPath: "/different" }],
        now,
      }),
    ).rejects.toThrow(/Conflicting/);
  });

  test("copies ingress and returned metadata including nested vision settings", async () => {
    const { attachment, store } = await fixture();
    const input = { ...scope, attachments: [attachment], now };
    const pending = store.remember(input);
    input.routeKey = "another-route";
    attachment.absPath = "/changed";
    attachment.vision!.include = false;
    await pending;
    const listed = await store.list({ ...scope, now });
    expect(listed[0].absPath).not.toBe("/changed");
    expect(listed[0].vision!.include).toBe(true);
    listed[0].vision!.include = false;
    listed[0].absPath = "/also-changed";
    expect((await store.list({ ...scope, now }))[0].vision!.include).toBe(true);
    expect((await store.list({ ...scope, now }))[0].absPath).not.toBe("/also-changed");
  });

  test("clears only the selected route and manager Session durably", async () => {
    const { root, attachment, store } = await fixture();
    const other = { ...scope, routeKey: "desktop" };
    await store.remember({ ...scope, attachments: [attachment], now });
    await store.remember({ ...other, attachments: [attachment], now });
    await store.clear(scope);
    const restarted = new PetChatAttachmentContext(root);
    expect(await restarted.list({ ...scope, now })).toEqual([]);
    expect(await restarted.list({ ...other, now })).toEqual([attachment]);
  });

  test("serializes concurrent admissions and bounds persisted conversation records", async () => {
    const { root, attachment, store } = await fixture();
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        store.remember({
          ...scope,
          routeKey: `route-${index}`,
          attachments: [attachment],
          now: now + index,
        }),
      ),
    );
    const state = JSON.parse(await readFile(join(root, "chat-attachment-context.json"), "utf8"));
    expect(state.records).toHaveLength(32);
    expect(await store.list({ ...scope, routeKey: "route-0", now: now + 40 })).toEqual([]);
    const restarted = new PetChatAttachmentContext(root);
    expect(await restarted.list({ ...scope, routeKey: "route-39", now: now + 40 })).toEqual([
      attachment,
    ]);
  });

  test("rejects oversized batches and keeps the existing context after rejection", async () => {
    const { attachment, store } = await fixture();
    await store.remember({ ...scope, attachments: [attachment], now });
    await expect(
      store.remember({
        ...scope,
        attachments: Array.from({ length: 9 }, (_, index) => ({
          ...attachment,
          id: `att-${index}`,
        })),
        now,
      }),
    ).rejects.toThrow(/limits/);
    await expect(
      store.remember({
        ...scope,
        attachments: Array.from({ length: 2 }, (_, index) => ({
          ...attachment,
          id: `att-large-${index}`,
          size: 11 * 1024 * 1024,
        })),
        now,
      }),
    ).rejects.toThrow(/limits/);
    expect(await store.list({ ...scope, now })).toEqual([attachment]);
  });

  test("rejects invalid attachment identity, paths, hashes, timestamps and vision metadata", async () => {
    const { attachment, store } = await fixture();
    for (const invalid of [
      { id: "" },
      { origin: "unknown" },
      { absPath: "relative/path" },
      { path: "bad\0path" },
      { sha256: "bad" },
      { size: -1 },
      { createdAt: NaN },
      { width: 0 },
      { vision: { include: "yes" } },
      { vision: { include: true, mediaPath: "bad\0path" } },
    ]) {
      await expect(
        store.remember({
          ...scope,
          attachments: [{ ...attachment, ...invalid } as InputAttachmentMeta],
          now,
        }),
      ).rejects.toThrow(/metadata/);
    }
    await expect(store.list({ ...scope, sessionId: "", now })).rejects.toThrow(/scope/);
    await expect(store.list({ ...scope, now: Infinity })).rejects.toThrow(/time/);
    expect(await store.list({ ...scope, now })).toEqual([]);
  });

  test("quarantines corrupt state instead of trusting or overwriting it", async () => {
    const { root, attachment, store } = await fixture();
    const file = join(root, "chat-attachment-context.json");
    await writeFile(file, "{broken state");
    expect(await store.list({ ...scope, now })).toEqual([]);
    const corrupt = (await readdir(root)).find((name) => name.endsWith(".corrupt"));
    expect(corrupt).toBeDefined();
    expect(await readFile(join(root, corrupt!), "utf8")).toBe("{broken state");
    await store.remember({ ...scope, attachments: [attachment], now });
    expect(await new PetChatAttachmentContext(root).list({ ...scope, now })).toEqual([attachment]);
  });

  test("rejects persisted metadata without a trusted admission timestamp", async () => {
    const { root, attachment, store } = await fixture();
    await writeFile(
      join(root, "chat-attachment-context.json"),
      JSON.stringify({
        version: 1,
        records: [{ ...scope, attachments: [attachment] }],
      }),
    );
    expect(await store.list({ ...scope, now })).toEqual([]);
    expect((await readdir(root)).some((name) => name.endsWith(".corrupt"))).toBe(true);
  });
});
