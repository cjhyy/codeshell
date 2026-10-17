import { expect, test } from "bun:test";
import {
  groupByProject,
  projectForCwd,
} from "../../../packages/web/src/lib/format.ts";
import {
  MOBILE_MAX_IMAGE_BYTES,
  normalizeMobileImage,
  prepareMobileAttachments,
} from "../../../packages/web/src/lib/mobileAttachments.ts";

test("a filesystem-root project is found at its root but not for its ordinary child cwd", () => {
  const project = { id: "root-project", path: "/", name: "Root project" };
  expect(projectForCwd("/", [project])).toBe(project);
  // Observation of the bug, rather than a product fix expectation.
  expect(projectForCwd("/workspace", [project])).toBeUndefined();
  const groups = groupByProject(
    [
      { id: "root-session", cwd: "/", updatedAt: 1 },
      { id: "child-session", cwd: "/workspace", updatedAt: 2 },
    ],
    [project],
    "en",
  );
  expect(groups).toHaveLength(2);
  expect(groups.map((group) => group.name)).toEqual(["Root project", "workspace"]);
  expect(groups.find((group) => group.cwd === "/workspace")?.projectId).toBeUndefined();
});

test("ordinary project descendants and the longest nested project still match", () => {
  const broad = { id: "broad", path: "/workspace", name: "Broad" };
  const nested = { id: "nested", path: "/workspace/child", name: "Nested" };
  expect(projectForCwd("/workspace/pkg", [broad])).toBe(broad);
  expect(projectForCwd("/workspace/child/pkg", [broad, nested])).toBe(nested);
  expect(projectForCwd("/workspace-other", [broad])).toBeUndefined();
  expect(groupByProject([
    { id: "one", cwd: "/workspace", updatedAt: 1 },
    { id: "two", cwd: "/workspace/pkg", updatedAt: 2 },
  ], [broad], "en")).toHaveLength(1);
});

test("the same filesystem-root descendant boundary also occurs for a V2 secondary root", () => {
  const project = {
    id: "v2-project",
    path: "/primary",
    name: "V2 project",
    roots: [{ path: "/primary" }, { path: "/" }],
  };
  expect(projectForCwd("/primary/child", [project])).toBe(project);
  expect(projectForCwd("/elsewhere", [project])).toBeUndefined();
});

function jpgAlias(size: number): File {
  // Owned synthetic file bytes; this checks MIME/size metadata, not decoding.
  return new File([new Uint8Array(size)], "photo.jpg", { type: "image/jpg" });
}

test("image/jpg normalization returns a jpeg that exceeds the advertised per-image limit", async () => {
  const file = jpgAlias(MOBILE_MAX_IMAGE_BYTES + 1);
  const normalized = await normalizeMobileImage(file);
  expect(normalized.type).toBe("image/jpeg");
  expect(normalized.size).toBe(MOBILE_MAX_IMAGE_BYTES + 1);
  expect(normalized.name).toBe(file.name);
});

test("preparation forwards oversized image/jpg metadata to the injected upload boundary", async () => {
  const metadata: Array<{ name: string; mime: string; size: number }> = [];
  const puts: Array<{ method: string | undefined; size: number; url: string }> = [];
  const result = await prepareMobileAttachments(
    [{ clientId: "large-alias", file: jpgAlias(MOBILE_MAX_IMAGE_BYTES + 1) }],
    {
      beginUpload: async (base) => {
        metadata.push(base);
        return {
          clientId: base.clientId,
          uploadId: "owned-fake-ticket",
          putUrl: "/owned-fake-upload",
          expiresAt: 100,
        };
      },
      fetch: async (url, init) => {
        puts.push({ url: String(url), method: init?.method, size: (init?.body as Blob).size });
        return new Response(null, { status: 201 });
      },
    },
  );
  expect(metadata).toEqual([
    {
      clientId: "large-alias",
      name: "photo.jpg",
      mime: "image/jpeg",
      size: MOBILE_MAX_IMAGE_BYTES + 1,
    },
  ]);
  expect(puts).toEqual([
    { url: "/owned-fake-upload", method: "PUT", size: MOBILE_MAX_IMAGE_BYTES + 1 },
  ]);
  expect(result[0]).toMatchObject({
    transport: "upload",
    mime: "image/jpeg",
    size: MOBILE_MAX_IMAGE_BYTES + 1,
  });
});

test("a small image/jpg stays usable inline and an oversized GIF fails before upload", async () => {
  let begins = 0;
  const options = {
    beginUpload: async () => {
      begins++;
      throw new Error("unexpected upload");
    },
    fetch: async () => {
      throw new Error("unexpected network");
    },
  };
  const result = await prepareMobileAttachments([{ clientId: "small", file: jpgAlias(3) }], options);
  expect(result[0]).toMatchObject({ mime: "image/jpeg", size: 3, transport: "inline" });
  expect(result[0]?.transport === "inline" && result[0].dataUrl).toBe("data:image/jpeg;base64,AAAA");
  const gif = new File([new Uint8Array(MOBILE_MAX_IMAGE_BYTES + 1)], "large.gif", { type: "image/gif" });
  await expect(prepareMobileAttachments([{ clientId: "gif", file: gif }], options))
    .rejects.toThrow("Image exceeds the 10 MiB limit");
  expect(begins).toBe(0);
});
