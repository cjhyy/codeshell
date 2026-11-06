import { describe, test, expect } from "bun:test";
import { classifyBashCommand } from "./permission.js";

/**
 * Reads are not gated (aligned with Codex / Claude Code, which ship no
 * built-in read deny list): reading a credential file or dumping the
 * environment classifies like any other read-only command. Write and exec
 * shapes are classified elsewhere and are unaffected.
 */
describe("credential reads and env dumps are ordinary safe-reads", () => {
  test("credential and CodeShell state files", () => {
    for (const command of [
      "cat ~/.ssh/id_rsa",
      "head -1 ~/.aws/credentials",
      "cat .env",
      "less ~/.config/gh/hosts.yml",
      "cat ~/.code-shell/settings.json",
      "cat .code-shell/settings.local.json",
      "grep -r apiKey ~/.code-shell",
      "rg token .code-shell/",
    ])
      expect(classifyBashCommand(command)).toBe("safe-read");
  });

  test("env / printenv", () => {
    for (const command of ["env", "printenv", "printenv OPENAI_API_KEY", "printenv -0"])
      expect(classifyBashCommand(command)).toBe("safe-read");
  });

  test("pipes of reads stay safe-read", () => {
    expect(classifyBashCommand("cat ~/.ssh/config | head -5")).toBe("safe-read");
    expect(classifyBashCommand("env | grep KEY")).toBe("safe-read");
  });

  test("lookalikes do not inherit the read classification", () => {
    expect(classifyBashCommand("printenv-helper")).not.toBe("safe-read");
    expect(classifyBashCommand("env FOO=1 node script.js")).not.toBe("safe-read");
  });

  test("ordinary reads stay safe-read", () => {
    expect(classifyBashCommand("cat README.md")).toBe("safe-read");
    expect(classifyBashCommand("cat src/index.ts")).toBe("safe-read");
    expect(classifyBashCommand("ls -la")).toBe("safe-read");
    expect(classifyBashCommand("grep foo src/app.ts")).toBe("safe-read");
  });
});
