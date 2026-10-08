import { spawn } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Unit shards never inherit the operator's application state or credentials. */
export function createBunTestEnvironment(base, directory) {
  // An allowlist also excludes credentials with arbitrary, unknown variable
  // names. Individual fixtures establish their own application environment.
  const permitted =
    /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|LANG|LANGUAGE|LC_\w+|TZ|TERM|COLORTERM|NO_COLOR|FORCE_COLOR|SHELL|USER|USERNAME|LOGNAME|CI|GITHUB_ACTIONS|GITHUB_WORKSPACE|GITHUB_REPOSITORY|GITHUB_REF|GITHUB_SHA|RUNNER_OS|RUNNER_ARCH|RUNNER_TEMP|RUNNER_TOOL_CACHE|BUN_INSTALL|BUN_INSTALL_CACHE_DIR|BUN_RUNTIME_TRANSPILER_CACHE_PATH|DISPLAY|XAUTHORITY|CHROME_PATH|CODESHELL_TEST_CHROMIUM|PLAYWRIGHT_BROWSERS_PATH|PUPPETEER_EXECUTABLE_PATH)$/i;
  const environment = Object.fromEntries(
    Object.entries(base).filter(([key]) => permitted.test(key)),
  );
  const homePath = join(directory, "home");
  mkdirSync(homePath, { recursive: true, mode: 0o700 });
  const home = realpathSync(homePath);
  const state = join(home, ".code-shell");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, ".run"), { recursive: true, mode: 0o700 });
  writeFileSync(join(state, "settings.json"), "{}\n", { mode: 0o600 });
  return {
    ...environment,
    HOME: home,
    USERPROFILE: home,
    CODE_SHELL_HOME: state,
    CODE_SHELL_TEST_HOME: state,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_RUNTIME_DIR: join(home, ".run"),
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    NODE_USE_ENV_PROXY: "0",
    NODE_ENV: "test",
  };
}

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
        env: createBunTestEnvironment(options.env ?? process.env, directory),
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
