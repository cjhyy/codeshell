/* Installed Job Hunt, trusted MediaRecorder and durable container tasks.
 * The microphone and speech response are controlled; resource bytes, selected
 * credential handoff, HTTP request, cancellation and persistence are real. */
/* global document */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const TRANSCRIPT = "这是受控服务返回的面试转写，用于验证保存和恢复。";
export async function verifyCloudInterviewAudio({ a, b, open, until, evidenceDir, readRequests }) {
  const practice = async ({ frame }) => {
    await frame.locator('.side-nav [data-view-target="interviews"]').click();
    await frame.locator("#quick-practice-interview-question").click();
    await frame.locator("#panel-interview-stage").waitFor({ state: "visible" });
    const ui = frame.locator(".interview-cloud-audio");
    await ui.waitFor();
    return ui;
  };
  const refresh = (ui) =>
    ui.getByRole("button", { name: "刷新录音、连接与任务", exact: true }).click();
  const consent = async (page) => {
    const dialog = page.locator(".panel-host-confirm");
    await dialog.waitFor({ state: "visible", timeout: 30_000 });
    assert.match(await dialog.locator("h2").innerText(), /^启动 .+ 的后台工具？$/);
    assert.match(await dialog.locator("pre").innerText(), /interview-transcribe/);
    await dialog.getByRole("button", { name: "确认执行", exact: true }).click();
  };
  let ui = await practice(a);
  await ui.getByRole("button", { name: "打开项目录音器", exact: true }).click();
  const dialog = a.page.getByRole("region", { name: "录音", exact: true });
  await dialog.getByRole("button", { name: "开始录音", exact: true }).click();
  await a.page.waitForFunction(
    () => {
      const error = document.querySelector('.panel-host-audio [role="alert"]')?.textContent?.trim();
      if (error) throw new Error(error);
      return /[2-9]\s+秒/.test(
        document.querySelector('.panel-host-audio [role="status"]')?.textContent ?? "",
      );
    },
    null,
    { timeout: 15000 },
  );
  await dialog.getByRole("button", { name: "停止录音", exact: true }).click();
  await dialog.locator("audio").waitFor();
  const backup = a.page.waitForEvent("download");
  await dialog.getByRole("link", { name: "下载本机备份" }).click();
  const bytes = await readFile(await (await backup).path());
  assert.equal(bytes.subarray(0, 4).toString("hex"), "1a45dfa3");
  const assetId = `asset-${createHash("sha256").update(bytes).digest("hex")}`;
  await dialog.getByRole("button", { name: "保存到当前项目", exact: true }).click();
  await until(
    async () => (await a.frame.locator("#interview-audio-resource").inputValue()) === assetId,
    "interview recording is durably selected",
  );
  assert.equal((await a.call("resources.get", { id: assetId })).asset.bytes, bytes.length);
  await assert.rejects(b.call("resources.get", { id: assetId }));
  await refresh(ui);
  await a.frame.locator("#interview-audio-connection").selectOption("audio-fixture");
  await a.frame.locator("#panel-interview-answer").fill("原始回答");
  await ui.getByRole("button", { name: "确认发送录音并转写", exact: true }).click();
  await consent(a.page);
  const findJob = async (connection, status) => {
    const jobs = await a.call("tasks.list", { limit: 50 });
    for (const summary of jobs) {
      if (summary.entry?.name !== "interview-transcribe") continue;
      const job = await a.call("tasks.get", { id: summary.id });
      if (job.input.request.connection.id !== connection) continue;
      if (["failed", "interrupted"].includes(job.status))
        throw new Error(`Interview transcription failed: ${JSON.stringify(job.error)}`);
      if (job.status === status) return job;
    }
    return null;
  };
  const succeeded = await until(
    () => findJob("audio-fixture", "succeeded"),
    "installed interview transcription finishes",
  );
  assert.equal((succeeded.result?.result ?? succeeded.result).text, TRANSCRIPT);
  assert.doesNotMatch(JSON.stringify(succeeded), /audio-smoke-only|原始回答/);
  assert.equal(succeeded.recovery, "manual");
  await assert.rejects(b.call("tasks.get", { id: succeeded.id }));
  await refresh(ui);
  await ui.getByRole("button", { name: "确认发送录音并转写", exact: true }).click();
  await until(
    () => a.frame.locator("#interview-audio-resource").isEnabled(),
    "duplicate submit resolves existing task",
  );
  assert.equal((await readRequests()).length, 1, "same accepted request is never sent twice");
  // Reopen through a separate authenticated browser context, not a fake bridge.
  await a.page.close();
  a = await open();
  ui = await practice(a);
  await refresh(ui);
  const row = ui.locator(`[data-audio-task-id="${succeeded.id}"]`);
  await row.getByLabel("转写文字，可选中复制").waitFor();
  assert.equal(await row.getByLabel("转写文字，可选中复制").inputValue(), TRANSCRIPT);
  await a.frame.locator("#panel-interview-answer").fill("新的手动回答");
  await row.getByRole("button", { name: "加入当前回答", exact: true }).click();
  await ui.getByRole("status").filter({ hasText: "题目或回答已经变化" }).waitFor();
  assert.equal(await a.frame.locator("#panel-interview-answer").inputValue(), "新的手动回答");
  await a.frame.locator("#panel-interview-answer").fill("原始回答");
  await row.getByRole("button", { name: "加入当前回答", exact: true }).click();
  await until(
    async () =>
      (await a.frame.locator("#panel-interview-answer").inputValue()) === `原始回答\n${TRANSCRIPT}`,
    "reviewed transcript is added to unchanged answer",
  );
  await until(
    async () =>
      (await a.call("storage.getSnapshot", { key: "job-hunt-state-v1" })).value?.interviewDraft
        ?.answer === `原始回答\n${TRANSCRIPT}`,
    "transcribed answer draft persists in original project",
  );
  await a.frame.locator("#interview-audio-resource").selectOption(assetId);
  await a.frame.locator("#interview-audio-connection").selectOption("audio-fixture-slow");
  await ui.getByRole("button", { name: "确认发送录音并转写", exact: true }).click();
  await consent(a.page);
  const running = await until(
    () => findJob("audio-fixture-slow", "running"),
    "slow speech request starts",
  );
  await until(
    async () => (await readRequests()).length === 2,
    "provider received slow request before cancellation",
  );
  await refresh(ui);
  await ui
    .locator(`[data-audio-task-id="${running.id}"]`)
    .getByRole("button", { name: "取消转写", exact: true })
    .click();
  await until(
    () => findJob("audio-fixture-slow", "cancelled"),
    "native speech process is cancelled",
  );
  assert.equal((await a.call("resources.get", { id: assetId })).asset.bytes, bytes.length);
  assert.equal((await readRequests()).length, 2);
  await a.page.screenshot({ path: join(evidenceDir, "cloud-job-hunt-audio.png"), fullPage: true });
  console.log(
    "PASS: installed cloud Job Hunt records original WebM, explicitly hands the selected connection to its native task, resumes the transcript across browser sessions, preserves changed answers and cancels without resending or deleting audio",
  );
  const download = async (client) => {
    const audio = await practice(client);
    await refresh(audio);
    await audio
      .locator(`[data-audio-task-id="${succeeded.id}"]`)
      .getByRole("button", { name: "打开原录音", exact: true })
      .click();
    const preview = client.page.getByRole("region", { name: "文件预览", exact: true });
    await preview.waitFor();
    const saved = client.page.waitForEvent("download");
    await preview.getByRole("link", { name: "保存到此设备", exact: true }).click();
    assert.deepEqual(await readFile(await (await saved).path()), bytes);
    await client.page.getByRole("button", { name: "关闭预览", exact: true }).click();
  };
  await a.frame.locator("#close-panel-interview").click();
  await download(a);
  return async (client) => {
    const job = await client.call("tasks.get", { id: succeeded.id });
    assert.equal(job.status, "succeeded");
    assert.equal((job.result?.result ?? job.result).text, TRANSCRIPT);
    assert.equal((await client.call("tasks.get", { id: running.id })).status, "cancelled");
    assert.equal(
      (await client.call("storage.getSnapshot", { key: "job-hunt-state-v1" })).value.interviewDraft
        .answer,
      `原始回答\n${TRANSCRIPT}`,
    );
    assert.equal(
      (await readRequests()).length,
      2,
      "restart must not repeat manual-recovery speech tasks",
    );
    await download(client);
    console.log(
      "PASS: cloud interview recording bytes, completed/cancelled tasks and reviewed answer survive project stop/start and package-source removal without another provider request",
    );
  };
}
