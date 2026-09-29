/* Actual MediaRecorder in the trusted workbench, actual installed Video Panel,
 * and native inspection in its project container. Only the microphone device is fake. */
/* global window, document */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyCloudSourcePlayback } from "./smoke-cloud-video-media.mjs";

export async function verifyCloudVideoRecording({
  page,
  frame,
  call,
  otherCall,
  readDocument,
  until,
  evidenceDir,
}) {
  const tab = () => frame.locator('#studio .rail [data-tab="recording"]').click();
  await tab();
  assert.equal(await frame.evaluate(() => window.origin), "null");
  await frame.getByRole("button", { name: "打开录音器", exact: true }).click();
  const dialog = page.getByRole("region", { name: "录音", exact: true });
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "开始录音", exact: true }).click();
  await page.waitForFunction(
    () => {
      const alert = document.querySelector('.panel-host-audio [role="alert"]');
      if (alert) throw new Error(alert.textContent);
      return /[2-9]\s+秒/.test(
        document.querySelector('.panel-host-audio [role="status"]')?.textContent ?? "",
      );
    },
    null,
    { timeout: 15000 },
  );
  await dialog.getByRole("button", { name: "停止录音", exact: true }).click();
  await dialog.locator("audio").waitFor();
  await dialog.locator("audio").evaluate((audio) => audio.play());
  await until(() => dialog.locator("audio").evaluate((audio) => audio.currentTime > 0));
  await dialog.locator("audio").evaluate((audio) => audio.pause());
  await page.screenshot({
    path: join(evidenceDir, "cloud-video-recording-review.png"),
    fullPage: true,
  });
  const backup = page.waitForEvent("download");
  await dialog.getByRole("link", { name: "下载本机备份" }).click();
  const bytes = await readFile(await (await backup).path());
  assert.equal(bytes.subarray(0, 4).toString("hex"), "1a45dfa3");
  const resourceId = `asset-${createHash("sha256").update(bytes).digest("hex")}`;
  await dialog.getByRole("button", { name: "保存到当前项目", exact: true }).click();
  const row = frame.locator(`[data-recording-resource="${resourceId}"]`);
  await row.waitFor({ timeout: 150000 });
  assert.equal(
    (await readDocument()).document.assets.some((asset) => asset.resourceId === resourceId),
    false,
  );
  const resource = (await call("resources.get", { id: resourceId })).asset;
  assert.equal(resource.bytes, bytes.length);
  assert.equal(resource.mimeType, "audio/webm");
  await assert.rejects(otherCall("resources.get", { id: resourceId }));
  await page.getByRole("button", { name: "返回面板", exact: true }).click();
  await page
    .locator(".panels-card")
    .filter({ has: page.locator("small", { hasText: /^video-studio$/ }) })
    .getByRole("button", { name: "打开面板", exact: true })
    .click();
  const iframe = page.locator("iframe.panel-host-frame");
  await iframe.waitFor();
  frame = await (await iframe.elementHandle()).contentFrame();
  await frame.locator("#editor-workspace").waitFor({ timeout: 150000 });
  await tab();
  await frame.getByRole("button", { name: "刷新项目音频", exact: true }).click();
  const recovered = frame.locator(`[data-recording-resource="${resourceId}"]`);
  await recovered.waitFor({ timeout: 150000 });
  await frame.locator("#host-recording-name").fill("Cloud recorded original");
  await recovered.getByRole("button", { name: "保存到素材库", exact: true }).click();
  const asset = await until(async () => {
    const error = (await frame.locator('[role="alert"]:visible').allTextContents())
      .map((message) => message.trim())
      .filter(Boolean);
    if (error.length) throw new Error(error.join("\n"));
    return (await readDocument()).document.assets.find((item) => item.resourceId === resourceId);
  });
  assert.equal(asset.kind, "audio");
  assert.equal(asset.name, "Cloud recorded original");
  assert.ok(Number.isSafeInteger(asset.duration) && asset.duration > 0);
  await frame.getByText("录音已加入本工程素材库。", { exact: true }).waitFor({ timeout: 150000 });
  await recovered.getByRole("button", { name: "保存到素材库", exact: true }).click();
  await frame.getByText("录音已加入本工程素材库。", { exact: true }).waitFor({ timeout: 150000 });
  await until(() =>
    recovered.getByRole("button", { name: "保存到素材库", exact: true }).isEnabled(),
  );
  assert.equal(
    (await readDocument()).document.assets.filter((item) => item.resourceId === resourceId).length,
    1,
  );
  await verifyCloudSourcePlayback({ frame, assetId: asset.id, kind: "audio", until });
  await page.screenshot({
    path: join(evidenceDir, "cloud-video-recording-imported.png"),
    fullPage: true,
  });
  console.log(
    "PASS: installed cloud Video records real WebM, saves the original, recovers it after Panel close, inspects in the container and attaches once; another project cannot read it",
  );
  return {
    resourceId,
    assetId: asset.id,
    frame,
    call: (method, params = {}) =>
      frame.evaluate(({ method, params }) => window.codeshellPanel.call(method, params), {
        method,
        params,
      }),
  };
}
