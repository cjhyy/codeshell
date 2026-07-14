import { describe, it, expect, spyOn } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { detectCodexImageInput, runAgentOnce, runWithLines } from "./external-agent-driver.js";
import { claudeAdapter, claudeAdapter as adp, codexAdapter } from "./agent-adapter.js";
import type { AgentAdapter } from "./agent-adapter.js";
import { probeCli } from "./cc-capability.js";

const RUN_REAL_AGENT_TESTS = process.env.CODESHELL_RUN_REAL_AGENT_TESTS === "1";
const describeRealAgent = RUN_REAL_AGENT_TESTS ? describe : describe.skip;

describe.serial("external agent driver", () => {
  describe("runWithLines（纯解析路径，无子进程）", () => {
    it("returns sessionId + finalText from collected lines", async () => {
      const lines = [
        JSON.stringify({ type: "system", subtype: "init", session_id: "S1" }),
        JSON.stringify({
          type: "assistant",
          session_id: "S1",
          message: { content: [{ type: "text", text: "done" }] },
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          session_id: "S1",
          result: "done",
          is_error: false,
        }),
      ];
      const r = runWithLines(claudeAdapter, lines, 0);
      expect(r.sessionId).toBe("S1");
      expect(r.finalText).toBe("done");
      expect(r.exitCode).toBe(0);
      expect(r.isError).toBe(false);
    });
  });

  describe("detectCodexImageInput", () => {
    it.serial("detects -i/--image support from codex exec --help output", async () => {
      const dir = mkdtempSync(join(tmpdir(), "codex-image-detect-"));
      try {
        const script = join(dir, "fake-codex");
        writeFileSync(script, "#!/bin/sh\necho 'Usage: codex exec -i, --image <path>'\n", "utf-8");
        chmodSync(script, 0o755);
        expect(await detectCodexImageInput(script, dir)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    const itPosix = process.platform === "win32" ? it.skip : it.serial;
    itPosix(
      "waits for an aborted image probe and its stubborn descendant to stop",
      async () => {
        const dir = mkdtempSync(join(tmpdir(), "codex-image-probe-tree-"));
        const script = join(dir, "fake-codex");
        const descendantScript = join(dir, "probe-descendant.mjs");
        const probePidFile = join(dir, "probe.pid");
        const descendantPidFile = join(dir, "descendant.pid");
        const probeMarker = join(dir, "probe.marker");
        const descendantMarker = join(dir, "descendant.marker");
        const controller = new AbortController();
        let probePid = 0;
        let descendantPid = 0;
        const isAlive = (pid: number): boolean => {
          if (!pid) return false;
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        };
        try {
          writeFileSync(
            descendantScript,
            [
              'import { appendFileSync, writeFileSync } from "node:fs";',
              `writeFileSync(${JSON.stringify(descendantPidFile)}, String(process.pid));`,
              'process.on("SIGTERM", () => {});',
              `setInterval(() => appendFileSync(${JSON.stringify(descendantMarker)}, "x"), 20);`,
            ].join("\n"),
            "utf-8",
          );
          writeFileSync(
            script,
            [
              "#!/usr/bin/env node",
              'const { appendFileSync, writeFileSync } = require("node:fs");',
              'const { spawn } = require("node:child_process");',
              `writeFileSync(${JSON.stringify(probePidFile)}, String(process.pid));`,
              `spawn(process.execPath, [${JSON.stringify(descendantScript)}], { stdio: "ignore" });`,
              'process.on("SIGTERM", () => {});',
              `setInterval(() => appendFileSync(${JSON.stringify(probeMarker)}, "x"), 20);`,
            ].join("\n"),
            "utf-8",
          );
          chmodSync(script, 0o755);

          const probe = detectCodexImageInput(script, dir, controller.signal);
          for (
            let i = 0;
            i < 250 && (!existsSync(probeMarker) || !existsSync(descendantMarker));
            i++
          ) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          expect(existsSync(probeMarker)).toBe(true);
          expect(existsSync(descendantMarker)).toBe(true);
          probePid = Number(readFileSync(probePidFile, "utf-8"));
          descendantPid = Number(readFileSync(descendantPidFile, "utf-8"));

          controller.abort();
          await expect(probe).rejects.toThrow(/abort/i);
          const sizes = [statSync(probeMarker).size, statSync(descendantMarker).size];
          await new Promise((resolve) => setTimeout(resolve, 150));

          expect(isAlive(probePid)).toBe(false);
          expect(isAlive(descendantPid)).toBe(false);
          expect([statSync(probeMarker).size, statSync(descendantMarker).size]).toEqual(sizes);
        } finally {
          controller.abort();
          if (!probePid && existsSync(probePidFile)) {
            probePid = Number(readFileSync(probePidFile, "utf-8"));
          }
          if (!descendantPid && existsSync(descendantPidFile)) {
            descendantPid = Number(readFileSync(descendantPidFile, "utf-8"));
          }
          for (const pid of [probePid, descendantPid]) {
            if (!isAlive(pid)) continue;
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              // already exited
            }
          }
          rmSync(dir, { recursive: true, force: true });
        }
      },
      15_000,
    );
  });

  describe("runAgentOnce promptViaStdin（用 cat 做可移植子进程,不依赖 claude/codex）", () => {
    // A fake adapter that drives `cat`: with promptViaStdin the driver must pipe
    // the prompt to the child's stdin, and `cat` echoes it back on stdout. This
    // exercises the real stdin-wiring code path without needing codex installed.
    it.serial(
      "feeds the prompt over stdin when adapter.promptViaStdin is true",
      async () => {
        const catAdapter: AgentAdapter = {
          kind: "cat",
          promptViaStdin: true,
          buildArgs: () => [],
          parseResult: (lines) => ({ sessionId: "", finalText: lines.join("\n"), isError: false }),
        };
        const r = await runAgentOnce(catAdapter, {
          command: "cat",
          prompt: "ECHO_ME_123",
          cwd: process.cwd(),
        });
        expect(r.finalText).toContain("ECHO_ME_123");
      },
      15_000,
    );

    it.serial("passes the explicit model override into adapter.buildArgs", async () => {
      let receivedModel: string | undefined;
      const catAdapter: AgentAdapter = {
        kind: "cat",
        promptViaStdin: true,
        buildArgs: (opts) => {
          receivedModel = opts.model;
          return [];
        },
        parseResult: (lines) => ({ sessionId: "", finalText: lines.join("\n"), isError: false }),
      };

      await runAgentOnce(catAdapter, {
        command: "cat",
        prompt: "model wiring",
        model: "review-model-override",
        cwd: process.cwd(),
      });

      expect(receivedModel).toBe("review-model-override");
    });

    it.serial(
      "does not spawn the main codex CLI when aborted during image support probing",
      async () => {
        const dir = mkdtempSync(join(tmpdir(), "codex-image-abort-"));
        const script = join(dir, "fake-codex");
        const probeStarted = join(dir, "probe-started");
        const releaseProbe = join(dir, "release-probe");
        const mainSpawned = join(dir, "main-spawned");
        const controller = new AbortController();
        let run!: ReturnType<typeof runAgentOnce>;
        try {
          writeFileSync(
            script,
            [
              "#!/bin/sh",
              'if [ "$1" = "exec" ] && [ "$2" = "--help" ]; then',
              `  touch "${probeStarted}"`,
              `  while [ ! -f "${releaseProbe}" ]; do sleep 0.05; done`,
              "  echo 'Usage: codex exec -i, --image <path>'",
              "  exit 0",
              "fi",
              `touch "${mainSpawned}"`,
              'echo \'{"type":"thread.started","thread_id":"T"}\'',
              'echo \'{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\'',
              "exit 0",
              "",
            ].join("\n"),
            "utf-8",
          );
          chmodSync(script, 0o755);
          writeFileSync(join(dir, "image.png"), "png", "utf-8");

          run = runAgentOnce(
            codexAdapter,
            {
              command: script,
              prompt: "inspect image",
              cwd: dir,
              imagePaths: [join(dir, "image.png")],
            },
            controller.signal,
          );

          for (let i = 0; i < 200 && !existsSync(probeStarted); i++) {
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          expect(existsSync(probeStarted)).toBe(true);

          controller.abort();
          writeFileSync(releaseProbe, "1", "utf-8");

          await expect(run).rejects.toThrow(/abort/i);
          expect(existsSync(mainSpawned)).toBe(false);
        } finally {
          controller.abort();
          if (!existsSync(releaseProbe)) writeFileSync(releaseProbe, "1", "utf-8");
          await run?.catch(() => undefined);
          rmSync(dir, { recursive: true, force: true });
        }
      },
      15_000,
    );

    it.serial("uses a positive-pid process.kill fallback on Windows cancellation", async () => {
      const dir = mkdtempSync(join(tmpdir(), "agent-win32-cancel-"));
      const script = join(dir, "stubborn-win32.mjs");
      const marker = join(dir, "started.marker");
      const realPlatform = process.platform;
      const realKill = process.kill.bind(process);
      const controller = new AbortController();
      const calls: Array<{ pid: number; signal: string | number | undefined }> = [];
      let killSpy: ReturnType<typeof spyOn> | undefined;
      try {
        writeFileSync(
          script,
          [
            'import { appendFileSync } from "node:fs";',
            'process.on("SIGTERM", () => {});',
            `setInterval(() => appendFileSync(${JSON.stringify(marker)}, "x"), 20);`,
          ].join("\n"),
          "utf-8",
        );
        const adapter: AgentAdapter = {
          kind: "win32-stubborn",
          buildArgs: () => [script],
          parseResult: () => ({ sessionId: "", finalText: "", isError: false }),
        };
        const run = runAgentOnce(
          adapter,
          { command: process.execPath, prompt: "", cwd: dir },
          controller.signal,
        );
        for (let i = 0; i < 250 && !existsSync(marker); i++) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(existsSync(marker)).toBe(true);

        Object.defineProperty(process, "platform", { value: "win32", configurable: true });
        killSpy = spyOn(process, "kill").mockImplementation((pid, signal?) => {
          calls.push({ pid, signal });
          if (signal === undefined) return realKill(pid, "SIGKILL");
          return realKill(pid, signal);
        });
        controller.abort();
        await run;

        expect(calls.some((call) => call.pid > 0 && call.signal === undefined)).toBe(true);
        expect(calls.some((call) => call.pid < 0 || call.signal === "SIGTERM")).toBe(false);
      } finally {
        killSpy?.mockRestore();
        Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
        controller.abort();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    const itPosix = process.platform === "win32" ? it.skip : it.serial;
    itPosix(
      "keeps the agent in its owning parent process group so parent shutdown cannot orphan it",
      async () => {
        const dir = mkdtempSync(join(tmpdir(), "agent-parent-ownership-"));
        const driverPath = join(import.meta.dir, "external-agent-driver.ts");
        const harnessScript = join(dir, "driver-parent.ts");
        const agentScript = join(dir, "agent-parent.mjs");
        const descendantScript = join(dir, "agent-descendant.mjs");
        const agentPidFile = join(dir, "agent.pid");
        const descendantPidFile = join(dir, "descendant.pid");
        const agentMarker = join(dir, "agent.marker");
        const descendantMarker = join(dir, "descendant.marker");
        let harnessPid = 0;
        let agentPid = 0;
        let descendantPid = 0;
        const isAlive = (pid: number): boolean => {
          if (!pid) return false;
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        };
        try {
          writeFileSync(
            descendantScript,
            [
              'import { appendFileSync, writeFileSync } from "node:fs";',
              `writeFileSync(${JSON.stringify(descendantPidFile)}, String(process.pid));`,
              `setInterval(() => appendFileSync(${JSON.stringify(descendantMarker)}, "x"), 20);`,
            ].join("\n"),
            "utf-8",
          );
          writeFileSync(
            agentScript,
            [
              'import { appendFileSync, writeFileSync } from "node:fs";',
              'import { spawn } from "node:child_process";',
              `writeFileSync(${JSON.stringify(agentPidFile)}, String(process.pid));`,
              `spawn(process.execPath, [${JSON.stringify(descendantScript)}], { stdio: "ignore" });`,
              `setInterval(() => appendFileSync(${JSON.stringify(agentMarker)}, "x"), 20);`,
            ].join("\n"),
            "utf-8",
          );
          writeFileSync(
            harnessScript,
            [
              `import { runAgentOnce } from ${JSON.stringify(driverPath)};`,
              "const adapter = {",
              '  kind: "ownership",',
              `  buildArgs: () => [${JSON.stringify(agentScript)}],`,
              '  parseResult: () => ({ sessionId: "", finalText: "", isError: false }),',
              "};",
              `await runAgentOnce(adapter, { command: process.execPath, prompt: "", cwd: ${JSON.stringify(dir)} });`,
            ].join("\n"),
            "utf-8",
          );

          const harness = spawn(process.execPath, [harnessScript], {
            cwd: dir,
            detached: true,
            stdio: "ignore",
          });
          harnessPid = harness.pid ?? 0;
          expect(harnessPid).toBeGreaterThan(1);
          for (
            let i = 0;
            i < 250 && (!existsSync(agentMarker) || !existsSync(descendantMarker));
            i++
          ) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          expect(existsSync(agentMarker)).toBe(true);
          expect(existsSync(descendantMarker)).toBe(true);
          agentPid = Number(readFileSync(agentPidFile, "utf-8"));
          descendantPid = Number(readFileSync(descendantPidFile, "utf-8"));

          process.kill(-harnessPid, "SIGKILL");
          for (let i = 0; i < 100 && (isAlive(agentPid) || isAlive(descendantPid)); i++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          const sizes = [statSync(agentMarker).size, statSync(descendantMarker).size];
          await new Promise((resolve) => setTimeout(resolve, 150));

          expect(isAlive(agentPid)).toBe(false);
          expect(isAlive(descendantPid)).toBe(false);
          expect([statSync(agentMarker).size, statSync(descendantMarker).size]).toEqual(sizes);
        } finally {
          if (harnessPid) {
            try {
              process.kill(-harnessPid, "SIGKILL");
            } catch {
              // owning group already exited
            }
          }
          if (!agentPid && existsSync(agentPidFile)) {
            agentPid = Number(readFileSync(agentPidFile, "utf-8"));
          }
          if (!descendantPid && existsSync(descendantPidFile)) {
            descendantPid = Number(readFileSync(descendantPidFile, "utf-8"));
          }
          if (agentPid) {
            try {
              process.kill(-agentPid, "SIGKILL");
            } catch {
              // detached group may not exist after the fix
            }
          }
          for (const pid of [agentPid, descendantPid]) {
            if (!isAlive(pid)) continue;
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              // already exited
            }
          }
          rmSync(dir, { recursive: true, force: true });
        }
      },
      15_000,
    );

    itPosix(
      "kills a stubborn attached agent tree with SIGKILL after abort grace expires",
      async () => {
        const dir = mkdtempSync(join(tmpdir(), "agent-stubborn-cancel-"));
        const parentPidFile = join(dir, "parent.pid");
        const childPidFile = join(dir, "child.pid");
        const parentMarker = join(dir, "parent.marker");
        const childMarker = join(dir, "child.marker");
        const parentTermMarker = join(dir, "parent.term");
        const childTermMarker = join(dir, "child.term");
        const childScript = join(dir, "child.mjs");
        const parentScript = join(dir, "parent.mjs");
        let parentPid = 0;
        let childPid = 0;
        let controller: AbortController | undefined;
        let run: ReturnType<typeof runAgentOnce> | undefined;
        const isAlive = (pid: number): boolean => {
          if (!pid) return false;
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        };
        try {
          writeFileSync(
            childScript,
            [
              'import { appendFileSync, writeFileSync } from "node:fs";',
              `writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid));`,
              `process.on("SIGTERM", () => writeFileSync(${JSON.stringify(childTermMarker)}, "term"));`,
              `setInterval(() => appendFileSync(${JSON.stringify(childMarker)}, "x"), 20);`,
            ].join("\n"),
            "utf-8",
          );
          writeFileSync(
            parentScript,
            [
              'import { appendFileSync, writeFileSync } from "node:fs";',
              'import { spawn } from "node:child_process";',
              `writeFileSync(${JSON.stringify(parentPidFile)}, String(process.pid));`,
              `const child = spawn("node", [${JSON.stringify(childScript)}], { stdio: "ignore" });`,
              `writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));`,
              `process.on("SIGTERM", () => writeFileSync(${JSON.stringify(parentTermMarker)}, "term"));`,
              `setInterval(() => appendFileSync(${JSON.stringify(parentMarker)}, "x"), 20);`,
            ].join("\n"),
            "utf-8",
          );
          const stubbornAdapter: AgentAdapter = {
            kind: "stubborn",
            buildArgs: () => [parentScript],
            parseResult: () => ({ sessionId: "", finalText: "", isError: false }),
          };
          controller = new AbortController();
          run = runAgentOnce(
            stubbornAdapter,
            { command: "node", prompt: "", cwd: dir },
            controller.signal,
          );

          for (let i = 0; i < 250 && (!existsSync(parentMarker) || !existsSync(childMarker)); i++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          expect(existsSync(parentMarker)).toBe(true);
          expect(existsSync(childMarker)).toBe(true);
          parentPid = Number(readFileSync(parentPidFile, "utf-8"));
          childPid = Number(readFileSync(childPidFile, "utf-8"));

          controller.abort();
          for (
            let i = 0;
            i < 20 && (!existsSync(parentTermMarker) || !existsSync(childTermMarker));
            i++
          ) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          expect(existsSync(parentTermMarker)).toBe(true);
          expect(existsSync(childTermMarker)).toBe(true);
          expect(isAlive(parentPid)).toBe(true);
          expect(isAlive(childPid)).toBe(true);

          const outcome = await Promise.race([
            run.then(() => "exited" as const),
            new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2_000)),
          ]);
          expect(outcome).toBe("exited");
          for (let i = 0; i < 50 && (isAlive(parentPid) || isAlive(childPid)); i++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          expect(isAlive(parentPid)).toBe(false);
          expect(isAlive(childPid)).toBe(false);
          const sizes = [statSync(parentMarker).size, statSync(childMarker).size];
          await new Promise((resolve) => setTimeout(resolve, 100));
          expect([statSync(parentMarker).size, statSync(childMarker).size]).toEqual(sizes);
        } finally {
          controller?.abort();
          if (run) {
            await Promise.race([
              run.catch(() => undefined),
              new Promise((resolve) => setTimeout(resolve, 750)),
            ]);
          }
          if (!parentPid && existsSync(parentPidFile)) {
            parentPid = Number(readFileSync(parentPidFile, "utf-8"));
          }
          if (!childPid && existsSync(childPidFile)) {
            childPid = Number(readFileSync(childPidFile, "utf-8"));
          }
          if (parentPid) {
            try {
              process.kill(-parentPid, "SIGKILL");
            } catch {
              // process group already exited
            }
          }
          for (const pid of [parentPid, childPid]) {
            if (!isAlive(pid)) continue;
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              // already exited
            }
          }
          rmSync(dir, { recursive: true, force: true });
        }
      },
      10_000,
    );
  });

  describeRealAgent("runAgentOnce（真机集成,需 CODESHELL_RUN_REAL_AGENT_TESTS=1）", () => {
    it("spawns claude and returns a sessionId + final text", async () => {
      const avail = await probeCli("claude");
      if (!avail.available) {
        console.log("claude 未安装,跳过集成测试");
        return;
      }
      const r = await runAgentOnce(adp, {
        command: "claude",
        prompt: "Reply with exactly: PONG",
        permissionMode: "bypassPermissions",
        cwd: process.cwd(),
      });
      expect(r.sessionId.length).toBeGreaterThan(0);
      expect(r.finalText.toUpperCase()).toContain("PONG");
    }, 90_000);

    // The load-bearing guarantee behind "靠一个 session id 串起整件事": passing a
    // prior run's sessionId as resumeSessionId must make `claude --resume <id>`
    // continue the SAME conversation, so CC actually remembers earlier context.
    // Without this, multi-step chaining (task A done → resume its session for the
    // related next step) silently loses context. Skips when claude isn't installed.
    it("resume continues the SAME session with prior context (CC remembers)", async () => {
      const avail = await probeCli("claude");
      if (!avail.available) {
        console.log("claude 未安装,跳过集成测试");
        return;
      }
      // Turn 1: have CC memorize a distinctive token.
      const first = await runAgentOnce(adp, {
        command: "claude",
        prompt: "Remember this exact codeword for later: ZEBRA42. Reply with only: OK",
        permissionMode: "bypassPermissions",
        cwd: process.cwd(),
      });
      expect(first.sessionId.length).toBeGreaterThan(0);
      // Turn 2: resume that session and ask for the codeword — without re-stating it.
      const second = await runAgentOnce(adp, {
        command: "claude",
        prompt: "What was the exact codeword I asked you to remember? Reply with only that word.",
        resumeSessionId: first.sessionId,
        permissionMode: "bypassPermissions",
        cwd: process.cwd(),
      });
      // Same conversation → CC recalls the token from turn 1's context.
      expect(second.finalText.toUpperCase()).toContain("ZEBRA42");
    }, 120_000);
  });

  describeRealAgent("runAgentOnce codex（真机集成,需 CODESHELL_RUN_REAL_AGENT_TESTS=1）", () => {
    it("spawns codex exec, feeds the prompt over stdin, returns thread_id + final text", async () => {
      const avail = await probeCli("codex");
      if (!avail.available) {
        console.log("codex 未安装,跳过集成测试");
        return;
      }
      const r = await runAgentOnce(codexAdapter, {
        command: "codex",
        prompt: "Reply with exactly: PONG",
        permissionMode: "bypassPermissions",
        cwd: process.cwd(),
      });
      expect(r.sessionId.length).toBeGreaterThan(0); // codex thread_id
      expect(r.finalText.toUpperCase()).toContain("PONG");
    }, 120_000);
  });
});
