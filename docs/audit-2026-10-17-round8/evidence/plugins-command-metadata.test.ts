import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandPluginCommandBody } from "../../../packages/core/src/plugins/pluginCommandsLoader.js";
import { copyCodexCommands } from "../../../packages/core/src/plugins/installer/codex/convertCommands.js";

// Audit proof tests assert the current incorrect result. They are not fixes.
const owned: string[] = [];
afterEach(async () => { for (const p of owned.splice(0)) await rm(p, {recursive: true, force: true}); });

describe("round8 plugin command metadata", () => {
  test("PLUGIN-R8-01: double-quoted empty first argument is dropped and later arguments shift", () => {
    const raw = '"" next last';
    const result = expandPluginCommandBody("one=<$1> two=<$2> three=<$3> raw=<$ARGUMENTS>", raw);
    expect(result).toBe('one=<next> two=<last> three=<> raw=<"" next last>');
    expect(result).not.toBe('one=<> two=<next> three=<last> raw=<"" next last>');
    console.log(JSON.stringify({id: "PLUGIN-R8-01", case: "double-quoted-empty-first", raw, actual: result}));
  });
  test("PLUGIN-R8-01: single-quoted empty middle argument is dropped", () => {
    const raw = "left '' right";
    const result = expandPluginCommandBody("<$1>|<$2>|<$3>", raw);
    expect(result).toBe("<left>|<right>|<>");
    expect(result).not.toBe("<left>|<>|<right>");
    console.log(JSON.stringify({id: "PLUGIN-R8-01", case: "single-quoted-empty-middle", raw, actual: result}));
  });
  test("control: nonempty quoting, named empty value, missing position and raw arguments", () => {
    const raw = 'alpha "two words" FILE=""';
    expect(expandPluginCommandBody("<$1>|<$2>|<$3>|<$FILE>|<$ARGUMENTS>", raw)).toBe('<alpha>|<two words>|<>|<>|<alpha "two words" FILE="">');
    expect(expandPluginCommandBody("$FILE|$FOCUS|$$1", 'FILE=src/a.ts FOCUS="loading state"')).toBe("src/a.ts|loading state|$1");
  });
  test("PLUGIN-R8-02: all-arguments prefix consumes complete named placeholders and unknown names", () => {
    const raw = "ARGUMENTS_FILE=src/example.ts";
    const body = "file=$ARGUMENTS_FILE untouched=$ARGUMENTS_UNKNOWN raw=$ARGUMENTS";
    const result = expandPluginCommandBody(body, raw);
    expect(result).toBe("file=ARGUMENTS_FILE=src/example.ts_FILE untouched=ARGUMENTS_FILE=src/example.ts_UNKNOWN raw=ARGUMENTS_FILE=src/example.ts");
    expect(result).not.toContain("file=src/example.ts ");
    console.log(JSON.stringify({id: "PLUGIN-R8-02", raw, body, actual: result}));
  });
  test("control: unrelated named placeholders and ordinary all-arguments aliases work", () => {
    expect(expandPluginCommandBody("$FILE|$UNKNOWN|$ARGUMENTS|{args}", "FILE=src/example.ts")).toBe("src/example.ts|$UNKNOWN|FILE=src/example.ts|FILE=src/example.ts");
    expect(expandPluginCommandBody("$FILE", 'FILE="$ARGUMENTS_FILE"')).toBe("$ARGUMENTS_FILE");
  });
  test("real converter preserves prompt metadata and both defects reach the expansion output", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeshell-audit-r8-plugin-command-")); owned.push(root);
    const src = join(root,"source"), dest = join(root,"projection");
    await mkdir(join(src,"prompts"), {recursive:true});
    await mkdir(join(src,"commands"), {recursive:true});
    await writeFile(join(src,"prompts","review.md"), "first=$1 file=$ARGUMENTS_FILE");
    await writeFile(join(src,"prompts","collision.md"), "from prompts");
    await writeFile(join(src,"commands","collision.md"), "from commands");
    await writeFile(join(src,"prompts","ignored.txt"), "not a command");
    await copyCodexCommands(src,dest);
    const body = await readFile(join(dest,"commands","review.md"),"utf8");
    expect(body).toBe("first=$1 file=$ARGUMENTS_FILE");
    expect(await readFile(join(dest,"commands","collision.md"),"utf8")).toBe("from commands");
    const raw = '"" next ARGUMENTS_FILE=src/example.ts';
    const actual = expandPluginCommandBody(body,raw);
    expect(actual).toBe('first=next file="" next ARGUMENTS_FILE=src/example.ts_FILE');
    console.log(JSON.stringify({case:"converter-to-expander",body,raw,actual}));
  });
});
