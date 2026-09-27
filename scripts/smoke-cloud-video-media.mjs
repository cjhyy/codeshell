/* Actual source upload, native inspection/render and authenticated browser delivery. */
/* global document, window, HTMLMediaElement */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

function audioFixture() {
  const rate = 22050,
    samples = rate;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    bytes.writeInt16LE(Math.round(8192 * Math.sin((2 * Math.PI * 440 * i) / rate)), 44 + i * 2);
  return bytes;
}

/** Exercise the installed source-monitor UI and observe its actual media element. */
export async function verifyCloudSourcePlayback({ frame, assetId, kind, until }) {
  await frame.evaluate(() => {
    const original = HTMLMediaElement.prototype.play;
    window.__cloudSourcePlayback = { original, media: undefined };
    HTMLMediaElement.prototype.play = function (...args) {
      window.__cloudSourcePlayback.media = this;
      return original.apply(this, args);
    };
  });
  try {
    await frame.locator('#studio .rail [data-tab="media"]').click();
    await frame.locator(`[data-preview-asset="${assetId}"]`).click();
    await frame.locator('[data-action="play"]').first().click();
    await until(() =>
      frame.evaluate((kind) => {
        const media = window.__cloudSourcePlayback.media;
        return (
          !!media &&
          media.tagName.toLowerCase() === kind &&
          media.readyState >= 2 &&
          media.currentTime > 0.1 &&
          Number.isFinite(media.duration) &&
          media.duration > 0 &&
          new URL(media.currentSrc).pathname.includes("/_codeshell_resources/") &&
          !media.error &&
          (kind !== "video" || (media.videoWidth > 0 && media.videoHeight > 0))
        );
      }, kind),
    );
    if (kind === "video") {
      assert.ok(
        await frame.locator("#preview").evaluate((canvas) => {
          const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
          return pixels.data.length > 0 && canvas.toDataURL("image/png").length > 100;
        }),
        "The source monitor canvas must remain readable in the opaque iframe",
      );
    }
    console.log(
      `PASS: installed cloud source monitor decodes and plays actual ${kind} through its scoped grant`,
    );
  } finally {
    await frame.evaluate(() => {
      const state = window.__cloudSourcePlayback;
      if (state) {
        state.media?.pause();
        HTMLMediaElement.prototype.play = state.original;
        delete window.__cloudSourcePlayback;
      }
    });
    await frame.locator('#studio .rail [data-tab="media"]').click();
  }
}

export async function verifyCloudVideoMedia({ page, frame, call, readDocument, until }) {
  const original = audioFixture();
  await frame.locator("[data-editor-media-input]").setInputFiles({
    name: "cloud-source.wav",
    mimeType: "audio/wav",
    buffer: original,
  });
  const asset = await until(async () => {
    const errors = await frame.locator(".editor-import-status li").allTextContents();
    const pending = await frame
      .locator('.editor-import-status:visible [role="status"]')
      .allTextContents();
    errors.push(...pending.filter((message) => message.startsWith("素材尚未加入工程：")));
    if (errors.length) throw new Error(errors.join("\n"));
    const value = await readDocument();
    return value.document.assets.find((item) => item.name === "cloud-source.wav");
  });
  assert.equal(asset.kind, "audio");
  assert.equal(asset.fingerprint, createHash("sha256").update(original).digest("hex"));
  assert.match(asset.resourceId, /^asset-[a-f0-9]{64}$/);
  const chunks = [];
  for (let offset = 0; offset < original.length; ) {
    const part = await call("resources.read", { assetId: asset.resourceId, offset, length: 32768 });
    const bytes = Buffer.from(part.dataBase64, "base64");
    assert.equal(part.offset, offset);
    assert.equal(part.totalBytes, original.length);
    assert.ok(bytes.length > 0);
    chunks.push(bytes);
    offset += bytes.length;
  }
  assert.deepEqual(Buffer.concat(chunks), original);
  console.log(
    "PASS: cloud Video imports actual WAV bytes and persists native-inspected source metadata",
  );
  await verifyCloudSourcePlayback({ frame, assetId: asset.id, kind: "audio", until });
  await frame.locator(`[data-add-asset="${asset.id}"]`).click();
  await frame.locator('[data-action="export"]').first().click();
  const dialog = frame.locator("#editor-workspace .ew-dialog[open]");
  await dialog.locator('input[name="width"]').fill("320");
  await dialog.locator('input[name="height"]').fill("180");
  assert.deepEqual(
    await dialog
      .locator("form")
      .evaluate((form) =>
        [...form.elements]
          .filter((item) => item.willValidate && !item.validity.valid)
          .map((item) => ({ name: item.name, message: item.validationMessage })),
      ),
    [],
  );
  const oldIds = new Set((await call("tasks.list")).map((job) => job.id));
  await dialog.getByRole("button", { name: "开始导出", exact: true }).click();
  const rendered = await until(async () => {
    const error = await frame.evaluate(() => document.querySelector(".ew-form-error")?.textContent);
    if (error) throw new Error(`Cloud export submission: ${error}`);
    for (const item of await call("tasks.list")) {
      if (oldIds.has(item.id) || item.entry?.name !== "editor-runtime") continue;
      const job = await call("tasks.get", { id: item.id });
      if (["failed", "cancelled", "interrupted"].includes(job.status))
        throw new Error(`Cloud export ${job.input?.request?.action}: ${JSON.stringify(job.error)}`);
      if (job.input?.request?.action === "render" && job.status === "succeeded") return job;
    }
    return false;
  });
  const result = rendered.result?.result ?? rendered.result;
  assert.equal(result.verified, true);
  assert.match(result.video.id, /^asset-[a-f0-9]{64}$/);
  const row = frame.locator(`[data-job-id="${rendered.id}"]`);
  await row.getByRole("button", { name: "预览与保存", exact: true }).click();
  const preview = page.getByRole("region", { name: "文件预览", exact: true });
  await preview.waitFor();
  await until(() =>
    preview
      .locator("video")
      .evaluate(
        (video) => video.readyState >= 1 && video.videoWidth === 320 && video.videoHeight === 180,
      ),
  );
  const pending = page.waitForEvent("download");
  await preview.getByRole("link", { name: "保存到此设备", exact: true }).click();
  const saved = await readFile(await (await pending).path());
  assert.equal(`asset-${createHash("sha256").update(saved).digest("hex")}`, result.video.id);
  console.log(
    "PASS: cloud Video renders actual MP4, decodes the preview and saves exact verified output bytes",
  );
  // Re-import the actual output, then play it in the editor (not the outer workbench viewer).
  await page.getByRole("button", { name: "关闭预览", exact: true }).click();
  await frame.locator("[data-editor-media-input]").setInputFiles({
    name: "cloud-rendered-source.mp4",
    mimeType: "video/mp4",
    buffer: saved,
  });
  const imported = await until(async () => {
    const errors = await frame.locator(".editor-import-status li").allTextContents();
    if (errors.length) throw new Error(errors.join("\n"));
    return (await readDocument()).document.assets.find(
      (item) => item.name === "cloud-rendered-source.mp4",
    );
  });
  assert.equal(imported.resourceId, result.video.id);
  await verifyCloudSourcePlayback({ frame, assetId: imported.id, kind: "video", until });
  return {
    source: asset.resourceId,
    sourceAsset: asset.id,
    videoAsset: imported.id,
    jobId: rendered.id,
    video: result.video.id,
  };
}
