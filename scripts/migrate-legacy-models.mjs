#!/usr/bin/env node
/**
 * 一次性迁移:把 ~/.code-shell/settings.json 的 legacy 模型存储
 * (model{} / models[] / providers[] / activeKey / auxModelKey) 转成统一 catalog
 * (credentials[]/modelConnections[]/defaults)。幂等:无 legacy 字段则跳过。
 * 备份原文件为 settings.json.pre-migrate-<ts>。
 *
 * catalogId 映射:按 baseUrl/provider 猜 builtin catalog id;猜不到标 custom。
 * arena.participants 不迁(按用户决策,后续重做 arena)。
 *
 * 用法:node scripts/migrate-legacy-models.mjs [path-to-settings.json]
 *   省略路径则用 ~/.code-shell/settings.json。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const file = process.argv[2] || path.join(os.homedir(), ".code-shell", "settings.json");
if (!fs.existsSync(file)) { console.log("无 settings.json,跳过:", file); process.exit(0); }
const s = JSON.parse(fs.readFileSync(file, "utf-8"));

const hasLegacy = s.model || s.models || s.providers || s.activeKey || s.auxModelKey || s.fallbackModelKeys;
if (!hasLegacy) { console.log("无 legacy 字段,已是统一 catalog,跳过。"); process.exit(0); }

// baseUrl → builtin catalogId 猜测表(builtin 有的 text id:openai/anthropic/openrouter/deepseek/google/ollama/custom)
function guessCatalogId(baseUrl = "") {
  const u = String(baseUrl).toLowerCase();
  if (u.includes("deepseek")) return "deepseek";
  if (u.includes("openrouter")) return "openrouter";
  if (u.includes("api.openai.com")) return "openai";
  if (u.includes("generativelanguage.googleapis") || u.includes("/v1beta/openai")) return "google";
  if (u.includes("anthropic")) return "anthropic";
  if (u.includes("localhost:11434") || u.includes("ollama")) return "ollama";
  // z.ai, bigmodel(智谱), xai, mistral, groq 等 OpenAI 兼容端点 → custom(自带 baseUrl)
  return "custom";
}

const credentials = Array.isArray(s.credentials) ? [...s.credentials] : [];
const modelConnections = Array.isArray(s.modelConnections) ? [...s.modelConnections] : [];
const defaults = (typeof s.defaults === "object" && s.defaults) ? { ...s.defaults } : {};
const report = [];

// 按 (apiKey, baseUrl) 去重凭证
function ensureCred(catalogId, apiKey, baseUrl) {
  let cred = credentials.find((c) => c.apiKey === apiKey && (c.baseUrl ?? "") === (baseUrl ?? ""));
  if (!cred) {
    const id = `${catalogId}-key-${credentials.length}`;
    cred = { id, catalogId, apiKey, baseUrl };
    credentials.push(cred);
  }
  return cred.id;
}

for (const m of s.models ?? []) {
  if (modelConnections.some((c) => c.id === m.key)) continue; // 已存在,不覆盖
  const prov = (s.providers ?? []).find((p) => p.key === m.providerKey);
  const baseUrl = m.baseUrl ?? prov?.baseUrl;
  const apiKey = m.apiKey ?? prov?.apiKey;
  const catalogId = guessCatalogId(baseUrl);
  const credId = apiKey ? ensureCred(catalogId, apiKey, baseUrl) : undefined;
  modelConnections.push({
    id: m.key, catalogId, tag: "text", model: m.model,
    ...(m.baseUrl ? { baseUrl: m.baseUrl } : {}),
    ...(credId ? { credentialId: credId } : {}),
  });
  report.push(`  ${m.key}: model=${m.model} baseUrl=${baseUrl ?? "(无)"} → catalogId=${catalogId}${catalogId === "custom" ? " ⚠️需核对" : ""}`);
}

// activeKey → defaults.text;auxModelKey → defaults.auxText(不覆盖已有)
if (s.activeKey && !defaults.text) defaults.text = s.activeKey;
if (s.auxModelKey && !defaults.auxText) defaults.auxText = s.auxModelKey;

// 删 legacy 字段
delete s.model; delete s.models; delete s.providers;
delete s.activeKey; delete s.auxModelKey; delete s.fallbackModelKeys;

const out = { ...s, credentials, modelConnections, defaults };

// 备份 + 写
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const backup = `${file}.pre-migrate-${ts}`;
fs.copyFileSync(file, backup);
fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n", "utf-8");

console.log("迁移完成。备份:", backup);
console.log("转换的连接:");
console.log(report.join("\n") || "  (无 legacy models[] 需转)");
console.log(`defaults.text=${defaults.text ?? "未设"} defaults.auxText=${defaults.auxText ?? "未设"}`);
console.log("⚠️ 标 custom 的连接请在「连接」页核对 catalogId / baseUrl 是否正确。");
