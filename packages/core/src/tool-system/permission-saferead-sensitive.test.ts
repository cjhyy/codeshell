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
