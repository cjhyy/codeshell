import { describe, test, expect } from "bun:test";
import { classifyBashCommand } from "./permission.js";

/**
 * safe-read must not become a zero-approval exfil channel. `Read ~/.ssh/id_rsa`
 * goes through path-policy and asks; the equivalent `cat ~/.ssh/id_rsa` was
 * being YOLO-classified safe-read → auto-allowed with sandbox off. Likewise
 * `env` / `printenv` dump injected credential env vars. Both must downgrade to
 * `unsafe` (which routes to `ask`) while ordinary reads stay safe-read.
 */
describe("safe-read downgrades on sensitive args / env dump", () => {
  test("cat of an SSH private key is not safe-read", () => {
    expect(classifyBashCommand("cat ~/.ssh/id_rsa")).toBe("unsafe");
    expect(classifyBashCommand("cat /Users/x/.ssh/id_ed25519")).toBe("unsafe");
  });

  test("reading credential / secret files is not safe-read", () => {
    expect(classifyBashCommand("cat ~/.code-shell/credentials.json")).toBe("unsafe");
    expect(classifyBashCommand("head -1 ~/.aws/credentials")).toBe("unsafe");
    expect(classifyBashCommand("cat .env")).toBe("unsafe");
    expect(classifyBashCommand("less ~/.config/gh/hosts.yml")).toBe("unsafe");
  });

  test("CodeShell settings and recursive credential-container reads require approval", () => {
    for (const command of [
      "cat ~/.code-shell/settings.json",
      "cat .code-shell/settings.local.json",
      "cat ~/.code-shell/serve/access.json",
      "grep -r apiKey ~/.code-shell",
      "rg token .code-shell/",
      "head .code-shell/settings.local.yaml",
    ])
      expect(classifyBashCommand(command)).toBe("unsafe");
  });

  test("equivalent secret paths and recursive credential parents require approval", () => {
    for (const command of [
      "cat .code-shell/./settings.local.json",
      "cat .code-shell//settings.local.json",
      "cat '.code-shell/docs/../settings.local.yaml'",
      'cat ".code-shell"/settings.json',
      "grep -r apiKey ~/.code-shell/serve",
      "rg apiKey ~/.code-shell/serve/",
      "rg token ~/.code-shell//chat/./wechat",
      "grep -r token ~/.code-shell/desktop",
      "rg token ~/.code-shell/project-control/",
      "rg token ~/.code-shell/browser-runtime",
      "rg token ~/.code-shell/im-gateway",
    ])
      expect(classifyBashCommand(command)).toBe("unsafe");
  });

  test("ordinary CodeShell skill documentation stays readable", () => {
    for (const command of [
      "cat .code-shell/skills/example/SKILL.md",
      "cat .code-shell//skills/./example/SKILL.md",
      "rg token .code-shell/skills",
      "grep -r instruction ~/.code-shell/skills/",
    ])
      expect(classifyBashCommand(command)).toBe("safe-read");
  });

  test("env / printenv dump is not safe-read (leaks injected credential env)", () => {
    expect(classifyBashCommand("env")).toBe("unsafe");
    expect(classifyBashCommand("printenv")).toBe("unsafe");
    expect(classifyBashCommand("printenv OPENAI_API_KEY")).toBe("unsafe");
  });

  test("sensitive read anywhere in a pipe is not safe-read", () => {
    expect(classifyBashCommand("cat ~/.ssh/id_rsa | base64")).toBe("unsafe");
    expect(classifyBashCommand("env | grep KEY")).toBe("unsafe");
  });

  test("ordinary reads stay safe-read", () => {
    expect(classifyBashCommand("cat README.md")).toBe("safe-read");
    expect(classifyBashCommand("cat src/index.ts")).toBe("safe-read");
    expect(classifyBashCommand("ls -la")).toBe("safe-read");
    expect(classifyBashCommand("grep foo src/app.ts")).toBe("safe-read");
    // A file that merely mentions "env" in its name but isn't a dotenv secret.
    expect(classifyBashCommand("cat environment.md")).toBe("safe-read");
  });
});
