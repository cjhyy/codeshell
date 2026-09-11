import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHyperframesAdapter, detectHyperframesRuntime } from "./hyperframes-adapter.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "codeshell-hyperframes-test-"));
  roots.push(root);
  const workspace = join(root, "workspace"),
    cache = join(root, "cache");
  await mkdir(workspace);
  return {
    root,
    workspace,
    cache,
    adapter: createHyperframesAdapter({ workspaceRoot: workspace, cacheRoot: cache }),
  };
}
const html =
  '<!doctype html><html><body><div id="scene" data-composition-id="scene" data-no-timeline data-width="640" data-height="360" data-duration="1.2"></div></body></html>';

test("imports existing sources as detached content-hashed snapshots with pin and dependency metadata", async () => {
  const { workspace, adapter } = await fixture();
  await mkdir(join(workspace, "existing"));
  await writeFile(join(workspace, "existing/index.html"), html);
  await writeFile(
    join(workspace, "existing/package.json"),
    JSON.stringify({
      scripts: { render: "npx hyperframes@0.8.30 render" },
      dependencies: { gsap: "3.14.2" },
    }),
  );
  const source = await adapter.importProject("existing");
  expect(source.pinnedVersion).toBe("0.8.30");
  expect(source.packageDependencies).toEqual(["gsap"]);
  expect(source.durationSeconds).toBe(1.2);
  expect(JSON.parse(await readFile(source.paramsPath, "utf8")).originalRelativeDir).toBe(
    "existing",
  );
  await writeFile(join(workspace, "existing/index.html"), html.replace("1.2", "2.4"));
  const updated = await adapter.importProject("existing");
  expect(updated.contentHash).not.toBe(source.contentHash);
  expect(updated.projectDir).not.toBe(source.projectDir);
  expect(await readFile(source.sourcePath, "utf8")).toBe(html);
});

test("rejects absolute paths, workspace escapes and linked source assets", async () => {
  const { root, workspace, adapter } = await fixture();
  await mkdir(join(workspace, "existing"));
  await writeFile(join(workspace, "existing/index.html"), html);
  await expect(adapter.importProject(workspace)).rejects.toThrow(/relative/);
  await expect(adapter.importProject("..")).rejects.toThrow(/outside/);
  await writeFile(join(root, "private.txt"), "private");
  await symlink(join(root, "private.txt"), join(workspace, "existing/linked.txt"));
  await expect(adapter.importProject("existing")).rejects.toThrow(/symbolic links/);
});

test("detects remote render dependencies and rejects oversized or malformed scene parameters", async () => {
  const { workspace, adapter } = await fixture();
  await mkdir(join(workspace, "existing"));
  await writeFile(
    join(workspace, "existing/index.html"),
    html.replace("</body>", '<img src="https://example.test/image.png"></body>'),
  );
  expect((await adapter.inspectProject("existing")).externalUrls).toEqual([
    "https://example.test/image.png",
  ]);
  await expect(
    adapter.createScene({ kind: "chapter", title: "Title", width: 641 }),
  ).rejects.toThrow(/even/);
  await expect(
    adapter.createScene({ kind: "chapter", title: "Title", durationSeconds: Infinity }),
  ).rejects.toThrow(/duration/);
  await expect(
    adapter.createScene({ kind: "explainer", title: "Title", bullets: Array(5).fill("point") }),
  ).rejects.toThrow(/four/);
  await expect(
    adapter.createScene({
      kind: "chapter",
      title: "Title",
      palette: { background: "url(secret)", foreground: "#ffffff", accent: "#000000" },
    }),
  ).rejects.toThrow(/hex/);
});

test("cancelled source creation does not publish a snapshot", async () => {
  const { adapter } = await fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(
    adapter.createScene({ kind: "chapter", title: "Cancelled" }, { signal: controller.signal }),
  ).rejects.toThrow(/cancelled/);
});

const integration = process.env.CODESHELL_HYPERFRAMES_INTEGRATION === "1" ? test : test.skip;
integration(
  "real HyperFrames check, H.264 render, source import, verified cache, preview and process cancellation",
  async () => {
    const { workspace, adapter } = await fixture();
    const runtime = await detectHyperframesRuntime();
    expect(runtime.available).toBe(true);
    const source = await adapter.createScene({
      kind: "chapter",
      title: "从想法，到成片。",
      subtitle: "HyperFrames 真实制作验证",
      durationSeconds: 1.2,
      width: 640,
      height: 360,
    });
    const output = await adapter.render(source, { quality: "draft" });
    expect((await stat(output.artifactPath)).size).toBeGreaterThan(1000);
    expect(output.durationSeconds).toBeCloseTo(1.2, 1);
    expect(output.width).toBe(640);
    expect(output.height).toBe(360);
    expect(output.cached).toBe(false);
    const cached = await adapter.render(source, { quality: "draft" });
    expect(cached.cached).toBe(true);
    expect(cached.artifactPath).toBe(output.artifactPath);

    await mkdir(join(workspace, "imported"));
    for (const file of ["index.html", "package.json", "hyperframes.json"])
      await writeFile(
        join(workspace, "imported", file),
        await readFile(join(source.projectDir, file)),
      );
    const imported = await adapter.importProject("imported");
    const importedOutput = await adapter.render(imported, { quality: "draft" });
    expect(importedOutput.durationSeconds).toBeCloseTo(1.2, 1);

    const explanation = await adapter.createScene({
      kind: "explainer",
      title: "让素材成为故事",
      bullets: ["看见关键画面", "保留核心信息", "检查字幕与声音"],
      durationSeconds: 1.2,
      width: 640,
      height: 360,
    });
    const explained = await adapter.render(explanation, { quality: "draft" });
    expect((await stat(explained.artifactPath)).size).toBeGreaterThan(1000);
    expect(JSON.parse(await readFile(explanation.paramsPath, "utf8")).params.bullets).toHaveLength(
      3,
    );

    const previewController = new AbortController();
    const preview = await adapter.preview(source, { signal: previewController.signal });
    expect((await fetch(preview.url)).status).toBe(200);
    previewController.abort();
    await preview.stop();
    await expect(fetch(preview.url)).rejects.toThrow();

    const renderController = new AbortController();
    let sawProcessOutput = false;
    await expect(
      adapter.render(source, {
        quality: "high",
        signal: renderController.signal,
        onProgress(event) {
          if (event.phase === "render" && event.message !== "Rendering scene with HyperFrames") {
            sawProcessOutput = true;
            renderController.abort();
          }
        },
      }),
    ).rejects.toThrow(/cancelled/);
    expect(sawProcessOutput).toBe(true);
  },
  180_000,
);
