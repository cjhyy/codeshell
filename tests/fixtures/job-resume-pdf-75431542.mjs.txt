// Reviewed, dependency-free PDF renderer. All page network and page scripts stay disabled.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

const INPUT_LIMIT = 2 * 1024 * 1024;
const OUTPUT_LIMIT = 24 * 1024 * 1024;
const CSP = "default-src 'none'; script-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

// This function is reviewed package code. Input HTML is passed as data into an inert
// template; no input scripts, styles, navigation or network references are adopted.
async function preparePublicDocument(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll(".resume-point-proof, button, .resume-photo-slot.placeholder").forEach((node) => node.remove());
  const tags = new Set("DIV SPAN MAIN SECTION ARTICLE HEADER FOOTER H1 H2 H3 H4 H5 H6 P UL OL LI STRONG B EM I U S SMALL A IMG BR HR TABLE THEAD TBODY TR TH TD BLOCKQUOTE".split(" "));
  for (const node of template.content.querySelectorAll("*")) {
    if (!tags.has(node.tagName)) { node.remove(); continue; }
    for (const attribute of [...node.attributes]) {
      const name = attribute.name;
      const value = attribute.value;
      const safe = ["class", "data-template", "data-density", "alt"].includes(name) ||
        (node.tagName === "A" && name === "href" && /^(https?:\/\/|mailto:|tel:)/i.test(value)) ||
        (node.tagName === "IMG" && name === "src" && /^data:image\/(png|jpeg|webp);base64,[a-z\d+/=\s]+$/i.test(value));
      if (!safe) node.removeAttribute(name);
    }
    if (node.tagName === "IMG" && !node.getAttribute("src")) throw new Error("简历照片必须是已保存的 PNG、JPEG 或 WebP 图片，请重新选择照片。");
  }
  const root = document.querySelector(".resume-print-root");
  root.replaceChildren(template.content);
  await document.fonts.ready;
  try { await Promise.all([...document.images].map((image) => image.decode())); }
  catch { throw new Error("简历照片无法读取，请重新选择照片后导出。"); }
  return true;
}

async function browserPath() {
  const candidates = [
    process.env.CODESHELL_PDF_BROWSER,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ...String(process.env.PATH || "").split(delimiter).flatMap((root) =>
      ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "msedge"].map((name) => join(root, name))),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch {}
  }
  throw new Error("PDF 生成需要 Chrome、Chromium 或 Edge，请在执行环境安装浏览器后重试。");
}

export async function renderResumePdf(input, { directory, signal } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
    Object.keys(input).some((key) => !["action", "html", "source", "jobId", "scopeKey"].includes(key)) ||
    input.action !== "resume-pdf" || typeof input.html !== "string" ||
    !input.html.trim() || Buffer.byteLength(JSON.stringify(input)) > INPUT_LIMIT)
    throw new Error("PDF 请求格式或大小无效。");
  if (input.source !== undefined && (!input.source || typeof input.source !== "object" ||
    Object.keys(input.source).some((key) => !["resumeId", "updatedAt"].includes(key)) ||
    typeof input.source.resumeId !== "string" || !input.source.resumeId || input.source.resumeId.length > 100 ||
    typeof input.source.updatedAt !== "string" || input.source.updatedAt.length > 80))
    throw new Error("PDF 简历来源记录无效。");
  if (!directory || signal?.aborted) throw new Error("PDF 任务目录不可用或任务已取消。");
  const root = await realpath(directory);
  const profile = await mkdtemp(join(root, ".pdf-browser-"));
  let browser;
  let browserClosed;
  let outputWritten;
  let browserDiagnostics = "";
  let session;
  let sequence = 0;
  let buffer = Buffer.alloc(0);
  let failed;
  const pending = new Map();
  const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60000)]);
  const rejectAll = (reason) => {
    failed ??= reason;
    for (const item of pending.values()) item.reject(reason);
    pending.clear();
  };
  const abort = () => { rejectAll(new Error("PDF 生成已取消或超过时间限制。")); browser?.kill("SIGTERM"); };
  const command = (method, params = {}, sessionId = session) => {
    if (failed) return Promise.reject(failed);
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      browser.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0", (error) => {
        if (error) rejectAll(new Error("PDF 浏览器连接已关闭。"));
      });
    });
  };
  try {
    const executable = await browserPath();
    if (deadline.aborted) throw new Error("PDF 生成已取消。");
    browser = spawn(executable, [
      "--headless=new", "--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check",
      "--disable-background-networking", "--disable-component-update", "--disable-sync",
      "--disable-extensions", "--disable-breakpad", "--metrics-recording-only",
      `--user-data-dir=${profile}`, "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], windowsHide: true });
    browserClosed = new Promise((resolve) => browser.once("close", resolve));
    browser.stdio[3].on("error", () => rejectAll(new Error("PDF 浏览器连接已关闭。")));
    browser.stdio[4].on("error", () => rejectAll(new Error("PDF 浏览器连接已关闭。")));
    browser.stderr.on("data", (chunk) => {
      // Keep bounded diagnostics private. Only classify known setup failures for
      // the user; raw browser logs may contain document or local path details.
      browserDiagnostics = (browserDiagnostics + chunk.toString("utf8")).slice(-8192);
    });
    browser.on("error", () => rejectAll(new Error("PDF 浏览器无法启动。")));
    browser.on("exit", () => rejectAll(new Error("PDF 浏览器已退出，请检查浏览器安装与沙箱配置。")));
    browser.stdio[4].on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > OUTPUT_LIMIT * 2) { abort(); return; }
      let end;
      while ((end = buffer.indexOf(0)) >= 0) {
        const bytes = buffer.subarray(0, end);
        buffer = buffer.subarray(end + 1);
        let message;
        try { message = JSON.parse(bytes.toString("utf8")); } catch { rejectAll(new Error("PDF 浏览器响应无效。")); continue; }
        if (message.method === "Fetch.requestPaused") {
          void command("Fetch.failRequest", { requestId: message.params.requestId, errorReason: "BlockedByClient" }, message.sessionId).catch(() => {});
        }
        const waiter = pending.get(message.id);
        if (!waiter) continue;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(`PDF 浏览器操作失败：${String(message.error.message).slice(0, 160)}`));
        else waiter.resolve(message.result);
      }
    });
    deadline.addEventListener("abort", abort, { once: true });
    const { browserContextId } = await command("Target.createBrowserContext", {}, undefined);
    const { targetId } = await command("Target.createTarget", { url: "about:blank", browserContextId }, undefined);
    const attached = await command("Target.attachToTarget", { targetId, flatten: true }, undefined);
    session = attached.sessionId;
    await command("Page.enable");
    await command("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    await command("Emulation.setScriptExecutionDisabled", { value: true });
    await command("Emulation.setEmulatedMedia", { media: "print" });
    const { frameTree } = await command("Page.getFrameTree");
    const css = (await readFile(new URL("../style.css", import.meta.url), "utf8")).replace(/<\/style/gi, "<\\/style");
    await command("Page.setDocumentContent", {
      frameId: frameTree.frame.id,
      html: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>${css}</style></head><body class="printing-resume"><div class="resume-print-root"></div></body></html>`,
    });
    const ready = await command("Runtime.evaluate", {
      expression: `(${preparePublicDocument.toString()})(${JSON.stringify(input.html)})`,
      awaitPromise: true, returnByValue: true,
    });
    if (ready.exceptionDetails || ready.result?.value !== true) {
      const detail = ready.exceptionDetails?.exception?.description || "";
      throw new Error(/简历照片/.test(detail) ? detail.split("\n")[0].replace(/^Error: /, "") : "PDF 字体或图片准备失败。");
    }
    const { stream } = await command("Page.printToPDF", {
      printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false,
      paperWidth: 8.2677165354, paperHeight: 11.692913386,
      marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
      transferMode: "ReturnAsStream",
    });
    const parts = [];
    let length = 0;
    try {
      for (;;) {
        const part = await command("IO.read", { handle: stream, size: 65536 });
        const bytes = Buffer.from(part.data, part.base64Encoded ? "base64" : "utf8");
        length += bytes.length;
        if (length > OUTPUT_LIMIT) throw new Error("PDF 超过大小限制，请减少简历图片或页数。");
        parts.push(bytes);
        if (part.eof) break;
      }
    } finally { await command("IO.close", { handle: stream }).catch(() => {}); }
    if (deadline.aborted) throw new Error("PDF 生成已取消。");
    const pdf = Buffer.concat(parts);
    if (!pdf.subarray(0, 5).equals(Buffer.from("%PDF-")) || pdf.length < 100)
      throw new Error("浏览器没有生成有效 PDF。");
    const sha256 = createHash("sha256").update(pdf).digest("hex");
    // A previous attempt may have written its PDF before the Host captured the
    // result. Content-addressed outputs permit explicit retry without replacing
    // an existing file or becoming permanently stuck on EEXIST after restart.
    const file = `resume-${sha256}.pdf`;
    const output = join(root, file);
    try {
      await writeFile(output, pdf, { flag: "wx", mode: 0o600 });
      outputWritten = output;
    } catch (error) {
      if (error.code !== "EEXIST" || !(await readFile(output)).equals(pdf)) throw error;
    }
    if (deadline.aborted) throw new Error("PDF 生成已取消。");
    return { artifacts: [{ file, name: "resume.pdf", role: "pdf", mimeType: "application/pdf", bytes: pdf.length, sha256, assetId: `asset-${sha256}` }] };
  } catch (error) {
    if (outputWritten) await rm(outputWritten, { force: true });
    if (!deadline.aborted && /No usable sandbox|Failed to move to new namespace|Operation not permitted|Running as root without --no-sandbox|AppArmor/i.test(browserDiagnostics))
      throw new Error("PDF 浏览器沙箱无法启动，请由管理员检查非 root 运行、用户命名空间及容器安全策略；不会自动关闭浏览器沙箱。");
    throw error;
  } finally {
    deadline.removeEventListener("abort", abort);
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      browser.kill("SIGTERM");
      const force = setTimeout(() => browser.kill("SIGKILL"), 2000);
      await browserClosed;
      clearTimeout(force);
    }
    rejectAll(new Error("PDF 浏览器已关闭。"));
    await rm(profile, { recursive: true, force: true });
  }
}

async function main() {
  const controller = new AbortController();
  for (const event of ["SIGINT", "SIGTERM"]) process.once(event, () => controller.abort());
  try {
    const chunks = [];
    let length = 0;
    for await (const part of process.stdin) {
      length += part.length;
      if (length > INPUT_LIMIT) throw new Error("PDF 请求超过大小限制。");
      chunks.push(part);
    }
    const index = process.argv.indexOf("--job-dir");
    if (index < 0 || !process.argv[index + 1]) throw new Error("PDF 任务缺少授权目录。");
    const result = await renderResumePdf(JSON.parse(Buffer.concat(chunks).toString("utf8")), {
      directory: process.argv[index + 1], signal: controller.signal,
    });
    process.stdout.write(JSON.stringify({ type: "result", result }) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : "PDF 生成失败。" }) + "\n");
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
