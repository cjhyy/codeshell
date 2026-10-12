import { expect, test } from "bun:test";
import assert, { AssertionError } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import {
  panelLifecycleFailure,
  panelVersionUiFailure,
  summarizeFailure,
} from "../scripts/smoke-project-diagnostics.mjs";

const id = "design-studio";
const secret = "private-password-cookie-grant-url-body-argv-never-print";
const digest = (value) => createHash("sha256").update(value).digest("hex");

test("nested Panel steps retain the original cause and fingerprint without its private text", () => {
  const original = new Error(secret);
  const ui = panelVersionUiFailure(original, id, "review-second");
  const failure = panelLifecycleFailure(ui, id, "select-updated");
  expect(failure.cause).toBe(ui);
  expect(ui.cause).toBe(original);
  const summary = summarizeFailure(failure);
  expect(summary.sha256).toBe(digest(secret));
  expect(summary.panelLifecycle).toEqual({
    source: "candidate-panel-lifecycle",
    panelId: id,
    step: "select-updated",
    uiStep: "review-second",
  });
  expect(JSON.stringify(summary)).not.toContain(secret);
});

test("Panel context only comes from the private factory and fixed ID/step enums", () => {
  for (const make of [
    () => panelLifecycleFailure(new Error(secret), secret, "history"),
    () => panelLifecycleFailure(new Error(secret), id, secret),
    () => panelVersionUiFailure(new Error(secret), id, secret),
  ])
    expect(make).toThrow("Invalid candidate Panel diagnostic context");
  let getters = 0;
  const forged = Object.defineProperty(new Error(secret), "panelLifecycle", {
    get() {
      getters++;
      return { source: "candidate-panel-lifecycle", panelId: id, step: "history" };
    },
  });
  expect(summarizeFailure(forged).panelLifecycle).toBeUndefined();
  expect(getters).toBe(0);
  const mismatched = panelLifecycleFailure(
    panelVersionUiFailure(new Error(secret), "job-hunt-hq", "login"),
    id,
    "select-original",
  );
  expect(summarizeFailure(mismatched).panelLifecycle.uiStep).toBeUndefined();
});

test("only native AssertionError own boolean or bounded finite numeric fields are exported", () => {
  for (const [actual, expected] of [
    [false, true],
    [0, 200],
    [-1_000_000, 1_000_000],
  ]) {
    const error = new AssertionError({ actual, expected, message: secret });
    expect(summarizeFailure(panelLifecycleFailure(error, id, "history")).assertion).toEqual({
      actual,
      expected,
    });
  }
  for (const value of [secret, { password: secret }, [], NaN, Infinity, 1_000_001, undefined]) {
    const error = new AssertionError({ actual: value, expected: value, message: secret });
    const summary = summarizeFailure(panelLifecycleFailure(error, id, "history"));
    expect(summary.assertion).toBeUndefined();
    expect(JSON.stringify(summary)).not.toContain(secret);
  }
  const fake = Object.assign(new Error(secret), { actual: 0, expected: 200 });
  expect(summarizeFailure(panelLifecycleFailure(fake, id, "history")).assertion).toBeUndefined();
});

test("Panel diagnostics never evaluate message, assertion or metadata getters", () => {
  let getters = 0;
  const error = new AssertionError({ actual: secret, expected: secret, message: secret });
  for (const key of ["actual", "expected", "message", "candidateGuardRefusal"])
    Object.defineProperty(error, key, {
      get() {
        getters++;
        throw new Error(secret);
      },
    });
  const summary = summarizeFailure(panelLifecycleFailure(error, id, "history"));
  expect(summary.assertion).toBeUndefined();
  expect(JSON.stringify(summary)).not.toContain(secret);
  expect(getters).toBe(0);
});

test("non-Error failures and browser cleanup aggregates keep primary custody without raw values", () => {
  for (const original of [undefined, false, { password: secret }]) {
    const failure = panelVersionUiFailure(original, id, "login");
    expect(failure.cause).toBe(original);
    expect(JSON.stringify(summarizeFailure(failure))).not.toContain(secret);
  }
  const original = new AssertionError({ actual: 403, expected: 200, message: secret });
  const primary = panelVersionUiFailure(original, id, "login");
  const cleanup = panelVersionUiFailure(new Error(secret), id, "close");
  const both = new AggregateError([primary, cleanup], "Panel cleanup failed", { cause: primary });
  const outer = panelLifecycleFailure(both, id, "select-updated");
  expect(outer.cause).toBe(both);
  expect(both.errors).toEqual([primary, cleanup]);
  expect(both.cause).toBe(primary);
  const summary = summarizeFailure(outer);
  expect(summary.sha256).toBe(digest(secret));
  expect(summary.panelLifecycle.uiStep).toBe("login");
  expect(summary.assertion).toEqual({ actual: 403, expected: 200 });
  expect(JSON.stringify(summary)).not.toContain(secret);
});

// Execute the actual selector function body with controlled transport doubles.
// This checks rejection/cleanup wiring, not native browser or UI acceptance.
function selectorFixture(phase, primary, cleanup) {
  const source = readFileSync(
    new URL("../scripts/smoke-cloud-panel-version-ui.mjs", import.meta.url),
    "utf8",
  );
  let closes = 0;
  const page = {
    setDefaultTimeout() {},
    on() {},
    async goto() {},
    getByLabel() {
      return {
        async fill() {
          throw primary;
        },
      };
    },
    async screenshot() {},
    locator() {
      return {
        async innerText() {
          return secret;
        },
      };
    },
  };
  const browser = {
    async close() {
      closes++;
      if (cleanup !== undefined) throw cleanup;
    },
  };
  const select = runInNewContext(
    source
      .slice(source.indexOf("export async function selectCloudPanelVersion"))
      .replace("export ", "") + "; selectCloudPanelVersion;",
    {
      assert: assert.strict,
      AggregateError,
      assertDockerBrowserGuard() {},
      mkdir: async () => {},
      writeFile: async () => {},
      join,
      chromium: {
        async launch() {
          if (phase === "launch") throw primary;
          return browser;
        },
      },
      panelVersionUiFailure,
    },
  );
  return {
    closes: () => closes,
    run: () =>
      select({
        browserGuard: {
          async createContext() {
            if (phase === "context") throw primary;
            return {
              async newPage() {
                return page;
              },
            };
          },
        },
        serverUrl: "http://127.0.0.1:1",
        password: secret,
        project: secret,
        id,
        digest: "updated",
        json: async () => ({ panels: [{ id, bound: true, packageDigest: "original" }] }),
        evidenceDir: "/unused-controlled-fixture",
      }),
  };
}

for (const phase of ["launch", "context", "login"])
  test(`actual selector body labels ${phase} failure and still attempts owned browser close`, async () => {
    const original = new Error(secret);
    const cleanup = phase === "login" ? new Error("private cleanup error") : undefined;
    const fixture = selectorFixture(phase, original, cleanup);
    let failure;
    try {
      await fixture.run();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    expect(fixture.closes()).toBe(phase === "launch" ? 0 : 1);
    const summary = summarizeFailure(failure);
    expect(summary.panelLifecycle.uiStep).toBe(phase);
    expect(summary.sha256).toBe(digest(secret));
    expect(JSON.stringify(summary)).not.toContain(secret);
    if (cleanup) {
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.errors[0].cause).toBe(original);
      expect(failure.errors[1].cause).toBe(cleanup);
      expect(failure.cause).toBe(failure.errors[0]);
    } else expect(failure.cause).toBe(original);
  });
