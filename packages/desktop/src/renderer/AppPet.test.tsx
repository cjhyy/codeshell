import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const rendererRoot = join(import.meta.dir);
const appSource = readFileSync(join(rendererRoot, "App.tsx"), "utf8");
const mainSource = readFileSync(join(rendererRoot, "main.tsx"), "utf8");
const petSource = readdirSync(join(rendererRoot, "pet"))
  .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
  .map((name) => readFileSync(join(rendererRoot, "pet", name), "utf8"))
  .join("\n");

describe("App Pet lifecycle boundaries", () => {
  test("keeps the provider outside App and Settings as a mounted-shell overlay", () => {
    expect(mainSource).toContain("<PetStateProvider>");
    expect(mainSource).toContain("<App />");
    expect(appSource).toContain('className={isSettingsPage ? "hidden"');
    expect(appSource).toContain("{isSettingsPage && (");
    expect(appSource).not.toMatch(/if\s*\(isSettingsPage\)\s*return/);
  });

  test("contains no Pet approval, direction, Team, or quick-chat cleanup route", () => {
    expect(petSource).not.toContain("codeshell.approve");
    expect(petSource).not.toContain("ApprovalResult");
    expect(petSource).not.toContain("PetSendDirection");
    expect(petSource).not.toContain("send_direction");
    expect(petSource).not.toContain("teamId");
    expect(petSource).not.toContain("cleanupQuickChatSession");
    expect(petSource).not.toContain('type: "evict"');
  });

  test("opens overview only from explicit entry or peek action wiring", () => {
    const openCalls = appSource.match(/set-overview-open", open: true/g) ?? [];
    expect(openCalls).toHaveLength(2);
    expect(appSource).toContain("onOpenPetOverview");
    expect(appSource).toContain("handlePetPeekAction");
  });
});
