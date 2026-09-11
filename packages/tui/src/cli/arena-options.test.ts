import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_PRESETS } from "@cjhyy/code-shell-arena/runtime";

test("real Arena CLI preserves connection IDs and model paths while accepting mixed-case aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "codeshell-arena-options-"));
  try {
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const configDir = join(workspace, ".code-shell");
    await mkdir(configDir, { recursive: true });
    await mkdir(home);
    const definitions = [
      { id: "TeamA", model: "Test/UpperModel", credentialId: "upper" },
      { id: "teama", model: "Test/LowerModel", credentialId: "lower" },
      { id: "GPT4O", model: "Test/CustomAliasModel", credentialId: "custom" },
    ];
    await writeFile(
      join(configDir, "settings.json"),
      JSON.stringify({
        defaults: { text: "TeamA" },
        modelConnections: definitions.map((entry) => ({
          ...entry,
          tag: "text",
          catalogId: "openrouter",
        })),
        credentials: definitions.map((entry) => ({
          id: entry.credentialId,
          catalogId: "openrouter",
          apiKey: `fixture-${entry.credentialId}`,
          baseUrl: "https://arena-fixture.invalid/v1",
        })),
      }),
    );
    const capture = join(root, "capture.json");
    const topic = "Review A  B --models keep-this-inside-the-topic";
    const cli = fileURLToPath(new URL("./main.ts", import.meta.url));
    const preload = fileURLToPath(
      new URL("../../../../tests/fixtures/arena-cli-preload.ts", import.meta.url),
    );
    const result = spawnSync(
      process.execPath,
      [
        "--preload",
        preload,
        cli,
        "arena",
        topic,
        "--models",
        " TeamA , teama , GPT4O , cLaUdE , Org/CaseSensitive-Model ",
        "--mode",
        "planning",
      ],
      {
        cwd: workspace,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          CODE_SHELL_HOME: configDir,
          CODESHELL_ARENA_CLI_CAPTURE: capture,
        },
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const recorded = JSON.parse(await readFile(capture, "utf8"));
    expect(recorded.topic).toBe(topic);
    expect(recorded.options.mode).toBe("planning");
    expect(recorded.config.participants.map((entry: any) => entry.llm.model)).toEqual([
      "Test/UpperModel",
      "Test/LowerModel",
      "Test/CustomAliasModel",
      MODEL_PRESETS.claude!.model,
      "Org/CaseSensitive-Model",
    ]);
    expect(recorded.config.participants.map((entry: any) => entry.llm.apiKey)).toEqual([
      "fixture-upper",
      "fixture-lower",
      "fixture-custom",
      "fixture-upper",
      "fixture-upper",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
