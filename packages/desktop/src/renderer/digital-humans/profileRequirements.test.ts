import { describe, expect, test } from "bun:test";
import { ensureDigitalHumanRequirements } from "./profileRequirements";

const t = ((key: string, params?: Record<string, unknown>) =>
  params?.error ? `${key}:${String(params.error)}` : key) as any;

function harness(preview: {
  needsInstall: boolean;
  willRun: string[];
  warnings: string[];
  blockers: string[];
}) {
  const confirmations: unknown[] = [];
  const toasts: unknown[] = [];
  let installCalls = 0;
  return {
    confirmations,
    toasts,
    installCalls: () => installCalls,
    options: {
      name: "director",
      projectPath: "/repo",
      configurationTarget: { projectId: "project" } as const,
      api: {
        previewProfileRequirements: async () => preview,
        installProfileRequirements: async () => {
          installCalls += 1;
          return { ok: true, errors: [] };
        },
      },
      confirm: async (options: unknown) => {
        confirmations.push(options);
        return true;
      },
      toast: (options: unknown) => {
        toasts.push(options);
      },
      t,
    },
  };
}

describe("ensureDigitalHumanRequirements", () => {
  test("uses an explicit Session configuration target when switching an existing Session", async () => {
    const h = harness({ needsInstall: false, willRun: [], warnings: [], blockers: [] });
    const targets: unknown[] = [];
    h.options.api.previewProfileRequirements = async (_name, target) => {
      targets.push(target);
      return { needsInstall: false, willRun: [], warnings: [], blockers: [] };
    };
    expect(
      await ensureDigitalHumanRequirements({
        ...h.options,
        projectPath: "/old-root",
        configurationTarget: { sessionId: "old-session" },
      }),
    ).toBe(true);
    expect(targets).toEqual([{ sessionId: "old-session" }]);
  });

  test("passes through a profile whose dependencies are ready", async () => {
    const h = harness({ needsInstall: false, willRun: [], warnings: [], blockers: [] });
    expect(await ensureDigitalHumanRequirements(h.options)).toBe(true);
    expect(h.confirmations).toEqual([]);
    expect(h.installCalls()).toBe(0);
  });

  test("reviews and installs missing Skills", async () => {
    const h = harness({
      needsInstall: true,
      willRun: ["install skill"],
      warnings: ["trusted source only"],
      blockers: [],
    });
    expect(await ensureDigitalHumanRequirements(h.options)).toBe(true);
    expect(h.confirmations).toHaveLength(1);
    expect(h.installCalls()).toBe(1);
  });

  test("does not install when the user cancels", async () => {
    const h = harness({
      needsInstall: true,
      willRun: ["install skill"],
      warnings: [],
      blockers: [],
    });
    h.options.confirm = async () => false;
    expect(await ensureDigitalHumanRequirements(h.options)).toBe(false);
    expect(h.installCalls()).toBe(0);
  });

  test("honors cancel when only an external tool blocker remains", async () => {
    const h = harness({
      needsInstall: false,
      willRun: [],
      warnings: [],
      blockers: ["ffmpeg is missing"],
    });
    h.options.confirm = async (options: unknown) => {
      h.confirmations.push(options);
      return false;
    };
    expect(await ensureDigitalHumanRequirements(h.options)).toBe(false);
    expect(h.confirmations).toHaveLength(1);
    expect(h.installCalls()).toBe(0);
  });

  test("fails closed when preview or installation fails", async () => {
    const previewFailure = harness({
      needsInstall: true,
      willRun: [],
      warnings: [],
      blockers: [],
    });
    previewFailure.options.api.previewProfileRequirements = async () => {
      throw new Error("preview offline");
    };
    expect(await ensureDigitalHumanRequirements(previewFailure.options)).toBe(false);
    expect(previewFailure.toasts).toHaveLength(1);

    const installFailure = harness({
      needsInstall: true,
      willRun: ["install"],
      warnings: [],
      blockers: [],
    });
    installFailure.options.api.installProfileRequirements = async () => ({
      ok: false,
      errors: ["not visible"],
    });
    expect(await ensureDigitalHumanRequirements(installFailure.options)).toBe(false);
    expect(installFailure.toasts).toHaveLength(1);
  });
});
