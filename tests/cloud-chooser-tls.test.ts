import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { X509Certificate, createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyChooserCertificate } from "../packages/desktop/scripts/cloud-chooser-tls.mjs";

test("native chooser accepts only its minted leaf despite Electron fingerprint formatting", () => {
  const directory = mkdtempSync(join(tmpdir(), "chooser-leaf-pin-"));
  try {
    const certificates = ["cloud", "other"].map((name) => {
      const path = join(directory, `${name}.pem`);
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
          "/CN=chooser-cloud",
          "-addext",
          "subjectAltName=IP:127.0.0.1",
          "-keyout",
          join(directory, `${name}.key`),
          "-out",
          path,
        ],
        { stdio: "ignore", timeout: 10000 },
      );
      return readFileSync(path, "utf8");
    });
    const leaf = new X509Certificate(certificates[0]);
    const formatted = `sha256/${createHash("sha256").update(leaf.raw).digest("base64")}`;
    const request = {
      hostname: "127.0.0.1",
      certificate: { data: certificates[0], fingerprint: formatted },
    };
    // The previous fixture compared this Chromium format to Node's hexadecimal form.
    expect(formatted.replaceAll(":", "").toLowerCase()).not.toBe(
      leaf.fingerprint256.replaceAll(":", "").toLowerCase(),
    );
    expect(verifyChooserCertificate(request, leaf.fingerprint256)).toBe(0);
    expect(
      verifyChooserCertificate({ ...request, hostname: "localhost" }, leaf.fingerprint256),
    ).toBe(-2);
    expect(verifyChooserCertificate({ ...request, hostname: "::1" }, leaf.fingerprint256)).toBe(-2);
    expect(
      verifyChooserCertificate(
        { ...request, certificate: { data: certificates[1], fingerprint: formatted } },
        leaf.fingerprint256,
      ),
    ).toBe(-2);
    expect(
      verifyChooserCertificate(
        { ...request, certificate: { data: "invalid", fingerprint: formatted } },
        leaf.fingerprint256,
      ),
    ).toBe(-2);
    expect(
      verifyChooserCertificate(
        { ...request, certificate: { fingerprint: formatted } },
        leaf.fingerprint256,
      ),
    ).toBe(-2);
    expect(verifyChooserCertificate(undefined, leaf.fingerprint256)).toBe(-2);
    expect(verifyChooserCertificate(request, "")).toBe(-2);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
