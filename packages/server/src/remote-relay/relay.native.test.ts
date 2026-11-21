import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test.each(["direct", "desktop-host"])(
  "account relay %s continuity uses real TLS and only its exact fixture sockets",
  async (transport) => {
    const temporary = await mkdtemp(join(tmpdir(), "relay-continuity-native-"));
    try {
      const source = dirname(fileURLToPath(import.meta.url));
      const root = resolve(source, "../../../..");
      await symlink(resolve(source, "../../node_modules"), join(temporary, "node_modules"));
      const build = await Bun.build({
        entrypoints: ["connector", "protocol"].map((name) => join(source, `${name}.ts`)),
        outdir: temporary,
        naming: "[name].js",
        target: "node",
        external: ["ws"],
      });
      expect(build.success, String(build.logs)).toBe(true);
      if (transport === "desktop-host") {
        const hosted = await Bun.build({
          entrypoints: [join(root, "tests/fixtures/device-relay/hosted-connector.ts")],
          outdir: temporary,
          naming: "connector.js",
          target: "node",
          external: ["ws"],
        });
        expect(hosted.success, String(hosted.logs)).toBe(true);
      }
      await writeFile(join(temporary, "package.json"), '{"type":"module"}');
      const child = Bun.spawn(
        ["node", resolve(root, "tests/fixtures/device-relay/continuity-runner.mjs"), temporary],
        { stdout: "pipe", stderr: "pipe" },
      );
      const timer = setTimeout(() => child.kill(), 20_000);
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(code, `${stdout}\n${stderr}`).toBe(0);
        expect(stdout).toContain("PASS account connector continuity");
      } finally {
        clearTimeout(timer);
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
  25_000,
);

// Exercise Node's ws parser, TLS verification and TCP backpressure, not Bun's
// compatibility WebSocket transport (which has different maxPayload semantics).
test("device relay uses verified TLS, fenced connections, binary streams and actual Host gates", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "device-relay-native-"));
  try {
    const source = dirname(fileURLToPath(import.meta.url));
    const root = resolve(source, "../../../..");
    await symlink(resolve(source, "../../node_modules"), join(temporary, "node_modules"));
    const build = await Bun.build({
      entrypoints: [
        resolve(source, "../index.remote-relay.ts"),
        ...[
          "remote-host-manager",
          "trusted-device-store",
          "access-passcode",
          "mobile-upload-service",
        ].map((name) => resolve(source, `../mobile-remote/${name}.ts`)),
      ],
      outdir: temporary,
      naming: "[name].js",
      target: "node",
      external: ["ws", "@cjhyy/code-shell-core/internal"],
    });
    expect(build.success, String(build.logs)).toBe(true);
    await writeFile(join(temporary, "package.json"), '{"type":"module"}');
    const child = Bun.spawn(
      ["node", resolve(root, "tests/fixtures/device-relay/runner.mjs"), temporary],
      { stdout: "pipe", stderr: "pipe" },
    );
    const timer = setTimeout(() => child.kill(), 35_000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, `${stdout}\n${stderr}`).toBe(0);
      expect(stdout).toContain("PASS device relay native acceptance");
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 40_000);
