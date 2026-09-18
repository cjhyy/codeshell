import { describe, expect, test } from "bun:test";
import { PermissionClassifier, classifyBashCommand } from "./permission.js";

const skillFile = "~/.code-shell/skills/example/SKILL.md";

describe("Bash skill documentation reads", () => {
  test.each([
    `cat ${skillFile}`,
    `head -80 ${skillFile}`,
    `tail -40 ${skillFile}`,
    `rg -n instructions ${skillFile}`,
    `rg -n token ${skillFile}`,
    `rg -n credentials ${skillFile}`,
    `rg -e token ${skillFile}`,
    `rg -e credentials -g auth.json ${skillFile}`,
    `rg --glob token.txt --encoding utf-8 credentials ${skillFile}`,
    `grep -n token ${skillFile}`,
    `grep -n credentials ${skillFile}`,
    `grep -e token ${skillFile}`,
    `grep -e credentials --include auth.json ${skillFile}`,
    `sed -n '1,200p' ${skillFile}`,
    `sed -n '20p' ${skillFile}`,
    `sed -n '20,$p' ${skillFile}`,
    `sed -n -e '1,200p' ${skillFile}`,
    `sed -n '1,200p' -- ${skillFile}`,
    "sed -n '1,200p' -- *.md",
    `sed -n '1,200p' '/tmp/skill with spaces/SKILL.md'`,
    `sed -n '1,200p' ${skillFile} | head -40`,
    `cat ${skillFile} | sed -n '1,200p'`,
    "cat ~/.code-shell/skills/example/authController.ts",
    "sed -n '1,200p' ~/.code-shell/skills/example/authController.ts",
    "sed -n '1,200p' ~/.code-shell/skills/example/token-counter.ts",
  ])("keeps an ordinary documentation read auto-allowed: %s", (command) => {
    expect(classifyBashCommand(command)).toBe("safe-read");
    expect(new PermissionClassifier([], "default").classify("Bash", { command })).toBe("allow");
  });

  test.each([
    `sed -i '1,200p' ${skillFile}`,
    `sed -n '1,200p' -i ${skillFile}`,
    `sed -n '1,200p' -e 'e touch /tmp/changed' ${skillFile}`,
    `sed -n '1,200p' -f /tmp/script.sed ${skillFile}`,
    "sed -n '1,200p' *.md",
    "sed -n '1,200p' {-f,/tmp/script.sed}",
    `sed -n '1,200w /tmp/copy' ${skillFile}`,
    `sed -n '1,200p;w /tmp/copy' ${skillFile}`,
    `sed -n '1e touch /tmp/changed' ${skillFile}`,
    `sed -n '1r /tmp/secret' ${skillFile}`,
    `sed -n "$SCRIPT" ${skillFile}`,
    `sed -n '1,200p' ${skillFile} > /tmp/copy`,
    `sed -n '1,200p' ${skillFile} | sh`,
    `sed -n '1,200p' ${skillFile} && sh /tmp/run.sh`,
  ])("does not auto-allow sed writes, execution, or dynamic scripts: %s", (command) => {
    expect(classifyBashCommand(command)).not.toBe("safe-read");
    expect(new PermissionClassifier([], "default").classify("Bash", { command })).toBe("ask");
  });

  test.each([
    "sed -n '1,200p' ~/.ssh/id_rsa",
    "sed -n '1,200p' ~/.code-shell/credentials.json",
    "sed -n '1,200p' ~/.code-shell/skills/example/.env",
    "sed -n '1,200p' ~/.code-shell/skills/example/credentials.json | head -40",
  ])("preserves the sensitive-read downgrade for sed: %s", (command) => {
    expect(classifyBashCommand(command)).toBe("unsafe");
  });

  test.each(
    ["auth.json", "token.txt", "secret.pem"].flatMap((name) => [
      `cat ~/.code-shell/skills/example/${name}`,
      `head -n 20 ~/.code-shell/skills/example/${name}`,
      `tail -c 200 -- ~/.code-shell/skills/example/${name}`,
      `sed -n '1,200p' '~/.code-shell/skills/example/${name}'`,
    ]),
  )("shares sensitive resource basenames across Bash readers: %s", (command) => {
    expect(classifyBashCommand(command)).toBe("unsafe");
    expect(new PermissionClassifier([], "default").classify("Bash", { command })).toBe("ask");
  });

  test("preserves acceptEdits and explicit deny rules for skill reads", () => {
    const args = { command: `sed -n '1,200p' ${skillFile}` };
    expect(new PermissionClassifier([], "acceptEdits").classify("Bash", args)).toBe("ask");
    expect(
      new PermissionClassifier([{ tool: "Bash", decision: "deny" }], "default").classify(
        "Bash",
        args,
      ),
    ).toBe("deny");
  });
});
