/**
 * `/init` — bootstrap CODESHELL.md for the current repo.
 *
 * Scope: documentation only. This command never writes to settings.json or
 * settings.local.json — those belong to Code Shell's own onboarding/permission
 * flows and must stay decoupled from arbitrary target repos.
 *
 * Four intents, picked from cwd state:
 *   improve  — CODESHELL.md already exists; LLM edits in place with diffs.
 *   migrate  — other AI configs (CLAUDE.md, .cursorrules, ...) exist; LLM
 *              treats them as investigation sources and synthesizes.
 *   create   — code present (manifest/source/README) but no AI config; LLM
 *              surveys the repo and writes from scratch.
 *   empty    — truly empty repo; LLM asks the user a few questions via the
 *              AskUserQuestion tool, then writes (with TODO placeholders as
 *              needed). Hard limit: ≤4 AskUserQuestion calls per prompt.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { SlashCommand } from "../../registry.js";
import { detect, pickIntent, summarize, type Detection, type Intent } from "./detect.js";

function readTemplate(name: string): string {
  return readFileSync(new URL(`./templates/${name}.md`, import.meta.url), "utf-8");
}

const createTemplate = readTemplate("create");
const migrateTemplate = readTemplate("migrate");
const improveTemplate = readTemplate("improve");
const emptyTemplate = readTemplate("empty");
const rulesScaffoldSuffix = readTemplate("rules-scaffold-suffix");

/**
 * Cap the inlined CODESHELL.md context so a freshly generated multi-thousand-
 * line file (rare, but possible on a migrate from a verbose CLAUDE.md) can't
 * blow up the next turn's prompt. CODESHELL.md is meant to be terse; if a user
 * goes way past this they can always read it back via the file tools.
 */
const CONTEXT_INJECT_MAX_CHARS = 8000;

function buildPrompt(intent: Intent, d: Detection, cwd: string): string {
  const targetPath = join(cwd, "CODESHELL.md");

  const existingConfigs: string[] = [];
  if (d.hasClaude) existingConfigs.push(join(cwd, "CLAUDE.md"));
  if (d.hasAgents) existingConfigs.push(join(cwd, "AGENTS.md"));
  if (d.hasCursorRulesDir) existingConfigs.push(join(cwd, ".cursor/rules/"));
  if (d.hasCursorRules) existingConfigs.push(join(cwd, ".cursorrules"));
  if (d.hasWindsurfRules) existingConfigs.push(join(cwd, ".windsurfrules"));
  if (d.hasClinerules) existingConfigs.push(join(cwd, ".clinerules"));
  if (d.hasCopilotInstructions) existingConfigs.push(join(cwd, ".github/copilot-instructions.md"));

  const template = pickTemplate(intent);
  // Append the rules-scaffold opt-in only for create/migrate when the user
  // doesn't already have a .codeshell/rules/ directory. improve doesn't get
  // it (they already have CODESHELL.md and presumably know the layout).
  const offerRulesSplit =
    (intent === "create" || intent === "migrate") && !d.hasCodeshellRulesDir;
  const body = offerRulesSplit ? `${template}\n\n${rulesScaffoldSuffix}` : template;

  return body
    .replaceAll("${targetPath}", targetPath)
    .replaceAll("${cwd}", cwd)
    .replaceAll("${existingConfigs}", existingConfigs.map((p) => `- ${p}`).join("\n"));
}

function pickTemplate(intent: Intent): string {
  switch (intent) {
    case "improve":
      return improveTemplate;
    case "migrate":
      return migrateTemplate;
    case "create":
      return createTemplate;
    case "empty":
      return emptyTemplate;
  }
}

function statusForIntent(intent: Intent): string {
  switch (intent) {
    case "improve":
      return "Improving existing CODESHELL.md…";
    case "migrate":
      return "Migrating from existing AI configs into CODESHELL.md…";
    case "create":
      return "Creating new CODESHELL.md…";
    case "empty":
      return "Empty repo — asking you a few questions before writing CODESHELL.md…";
  }
}

export const initCommand: SlashCommand = {
  name: "/init",
  group: "config",
  description: "Bootstrap or improve CODESHELL.md for this repo",
  execute: async (_arg, ctx) => {
    const d = detect(ctx.cwd);
    const intent = pickIntent(d);

    ctx.addStatus(summarize(d));
    ctx.addStatus(statusForIntent(intent));

    if (!ctx.queryGuard.reserve()) {
      ctx.addStatus("Busy — wait for current turn to finish.");
      return;
    }
    const ac = new AbortController();
    ctx.queryGuard.tryStart(ac);
    try {
      const result = await ctx.client.run(buildPrompt(intent, d, ctx.cwd), ctx.sessionId);
      ctx.setSessionId(result.sessionId);

      const targetPath = join(ctx.cwd, "CODESHELL.md");
      if (existsSync(targetPath)) {
        ctx.addStatus(intent === "improve" ? `Updated ${targetPath}` : `Created ${targetPath}`);

        // The /init turn ran in this same session, so its prompt + assistant
        // output + tool calls are already in the engine transcript. But that
        // transcript is verbose (long instruction prompt, Edit tool calls,
        // status chatter) and prone to being compacted away.
        //
        // Inject the *resulting* CODESHELL.md content directly into the
        // session transcript via engine.injectContext() — this gives the
        // model a clean, durable reference that persists through compaction,
        // independent of how the init turn gets summarised later.
        try {
          const content = readFileSync(targetPath, "utf-8");
          const truncated =
            content.length > CONTEXT_INJECT_MAX_CHARS
              ? content.slice(0, CONTEXT_INJECT_MAX_CHARS) +
                `\n\n[truncated — ${content.length - CONTEXT_INJECT_MAX_CHARS} more chars in ${targetPath}]`
              : content;
          await ctx.client.inject(
            result.sessionId,
            `CODESHELL.md was ${intent === "improve" ? "updated" : "created"} by /init at ${targetPath}:\n\n${truncated}`,
          );
          ctx.addStatus(
            "CODESHELL.md injected into session context — the model will see it on every turn.",
          );
        } catch {
          /* file disappeared between existsSync and read — ignore */
        }
      } else {
        ctx.addStatus("Init finished without writing a file — see the output above.");
      }
    } catch (err) {
      ctx.addStatus(`Init failed during ${intent} phase: ${(err as Error).message}`);
    } finally {
      ctx.queryGuard.end();
    }
  },
};
