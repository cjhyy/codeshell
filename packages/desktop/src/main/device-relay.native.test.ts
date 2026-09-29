import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

test("desktop registration and lifecycle use real Node TLS, encrypted storage and the actual Host connector", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-relay-native-"));
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=desktop-relay-test",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-keyout",
        join(root, "key.pem"),
        "-out",
        join(root, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    await symlink(resolve("packages/server/node_modules"), join(root, "node_modules"));
    // A separate compiler process avoids Bun test's module-resolution cache;
    // runtime assertions run under native Node, never Bun's TLS/WS emulation.
    const compile = Bun.spawn(
      [
        process.execPath,
        "build",
        "packages/desktop/src/main/mobile-remote-controller.ts",
        "packages/desktop/src/main/device-relay-store.ts",
        "packages/desktop/src/main/device-relay-enrollment.ts",
        "packages/server/src/index.mobile-remote.ts",
        "--outdir",
        root,
        "--entry-naming",
        "[name].js",
        "--target=node",
        "--external=ws",
        "--external=@cjhyy/code-shell-core/internal",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [buildOut, buildError, buildCode] = await Promise.all([
      new Response(compile.stdout).text(),
      new Response(compile.stderr).text(),
      compile.exited,
    ]);
    expect(buildCode, `${buildOut}\n${buildError}`).toBe(0);
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    const child = Bun.spawn(["node", resolve("tests/fixtures/desktop-device-relay.mjs"), root], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: join(root, "cert.pem") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const deadline = setTimeout(() => child.kill(), 25_000);
    try {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exit, `${stdout}\n${stderr}`).toBe(0);
      expect(stdout).toContain("PASS desktop relay TLS lifecycle");
    } finally {
      clearTimeout(deadline);
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);
