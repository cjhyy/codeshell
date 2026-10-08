import { spawn } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Validate Bun's completed JUnit document, independently of its process exit code. */
export function assertBunTestCompletion(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) {
    throw new Error("Bun test completion report is not a bounded regular file");
  }
  const xml = readFileSync(file, "utf8")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const root = xml.match(/^\s*(?:<\?xml[^>]*\?>\s*)?<testsuites\b([^>]*)>/);
  if (!root || !/<\/testsuites>\s*$/.test(xml) || /<!DOCTYPE|<!ENTITY/.test(xml)) {
    throw new Error("Bun test completion report is missing or incomplete");
  }
  const count = (attributes, name, optional = false) => {
    const matches = [...attributes.matchAll(new RegExp(`\\b${name}="(\\d+)"`, "g"))];
    if (optional && !new RegExp(`\\b${name}=`).test(attributes)) return 0;
    if (matches.length !== 1 || !Number.isSafeInteger(Number(matches[0][1]))) {
      throw new Error(`Bun test completion report has invalid ${name}`);
    }
    return Number(matches[0][1]);
  };
  const tests = count(root[1], "tests");
  const failures = count(root[1], "failures");
  const errors = count(root[1], "errors", true);
  const skipped = count(root[1], "skipped");
  const suites = [...xml.matchAll(/<testsuite\b([^>]*)>/g)];
  let suiteTests = 0;
  const suiteFailures = suites.reduce((total, suite) => total + count(suite[1], "failures"), 0);
  const suiteErrors = suites.reduce((total, suite) => total + count(suite[1], "errors", true), 0);
  // Quoted attribute values can contain '>', including ordinary test names.
  const tags = xml.match(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g) ?? [];
  const stack = [];
  for (const tag of tags) {
    if (tag.startsWith("<?xml")) continue;
    const closing = tag.match(/^<\/([\w:-]+)\s*>$/);
    if (closing) {
      if (stack.pop() !== closing[1])
        throw new Error("Bun test completion report has incomplete test counts");
      continue;
    }
    const opening = tag.match(/^<([\w:-]+)\b/);
    if (!opening) throw new Error("Bun test completion report is incomplete");
    // Bun nests describe() suites. Their counts are already included in each
    // file suite, so only sum suites immediately beneath the document root.
    if (opening[1] === "testsuite" && stack.length === 1 && stack[0] === "testsuites") {
      suiteTests += count(tag, "tests");
    }
    if (!tag.endsWith("/>")) stack.push(opening[1]);
  }
  const testcases = tags.filter((tag) => /^<testcase\b/.test(tag)).length;
  if (failures || errors || suiteFailures || suiteErrors || /<(?:failure|error)\b/.test(xml)) {
    throw new Error("Bun test completion report contains failed tests");
  }
  if (
    !tests ||
    skipped > tests ||
    !suites.length ||
    tests !== suiteTests ||
    tests !== testcases ||
    stack.length > 0
  ) {
    throw new Error(
      `Bun test completion report has incomplete test counts (root=${tests}, suites=${suiteTests}, cases=${testcases})`,
    );
  }
  return { tests, skipped };
}

export async function runBunTestShard(args, options = {}) {
  if (args.some((arg) => arg.startsWith("--reporter") || arg === "--watch" || arg === "-w")) {
    throw new Error("The shard wrapper owns its completion reporter and runs once");
  }
  const directory = mkdtempSync(join(tmpdir(), "codeshell-bun-completion-"));
  const report = join(directory, "junit.xml");
  try {
    const child = spawn(
      options.bun ?? "bun",
      ["test", ...args, "--reporter", "junit", "--reporter-outfile", report],
      {
        cwd: options.cwd ?? process.cwd(),
        env: options.env ?? process.env,
        stdio: "inherit",
      },
    );
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (result.code !== 0 || result.signal) {
      throw new Error(`Bun test process failed (${result.signal ?? result.code ?? "unknown"})`);
    }
    let summary;
    try {
      summary = assertBunTestCompletion(report);
    } catch (error) {
      throw new Error(`Bun test shard did not finish successfully: ${error.message}`);
    }
    console.log(
      `Completed Bun shard: ${summary.tests} tests, ${summary.skipped} skipped; 0 failures.`,
    );
    return summary;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
