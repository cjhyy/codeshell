/* Actual source upload, native inspection/render and authenticated browser delivery. */
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

export async function verifyCloudVideoMedia({ page, frame, call, readDocument, until }) {
  const original = audioFixture();
  await frame.locator("[data-editor-media-input]").setInputFiles({
    name: "cloud-source.wav",
    mimeType: "audio/wav",
    buffer: original,
  });
  const asset = await until(async () => {
    const errors = await frame.locator(".editor-import-status li").allTextContents();
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
  await frame.locator(`[data-add-asset="${asset.id}"]`).click();
  await frame.locator('[data-action="export"]').first().click();
  const dialog = frame.locator("#editor-workspace .ew-dialog[open]");
  await dialog.locator('input[name="width"]').fill("320");
  await dialog.locator('input[name="height"]').fill("180");
  const oldIds = new Set((await call("tasks.list")).map((job) => job.id));
  await dialog.getByRole("button", { name: "开始导出", exact: true }).click();
  const rendered = await until(async () => {
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
  return { source: asset.resourceId, jobId: rendered.id, video: result.video.id };
}
