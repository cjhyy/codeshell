import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("native account HTTPS validates TLS, rejects redirects/oversized replies, and uses fresh access for logout", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-account-native-"));
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
        "/CN=account-test",
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
    const compiler = Bun.spawn(
      [
        process.execPath,
        "build",
        "packages/desktop/src/main/cloud-account-manager.ts",
        "packages/desktop/src/main/cloud-account-http.ts",
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
      new Response(compiler.stdout).text(),
      new Response(compiler.stderr).text(),
      compiler.exited,
    ]);
    expect(buildCode, `${buildOut}\n${buildError}`).toBe(0);
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    const child = Bun.spawn(["node", resolve("tests/fixtures/cloud-account-native.mjs"), root], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 20_000);
    try {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exit, `${stdout}\n${stderr}`).toBe(0);
      expect(stdout).toContain("PASS native cloud account");
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 25_000);
