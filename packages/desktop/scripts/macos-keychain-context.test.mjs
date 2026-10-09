import { deepStrictEqual, equal, match, throws } from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  bindPrivateKeychainContext,
  keychainPreferenceXml,
  readKeychainReference,
} from "./macos-keychain-context.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const metadata = {
  path: "/metadata/existing-login.keychain-db",
  pathHash: hash("/metadata/existing-login.keychain-db"),
  dev: 1,
  ino: 2,
  uid: process.getuid(),
};
const reference = { version: 1, home: "/metadata/operator-home", ...metadata };

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "private-keychain-context-test-")));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  return { root, home, reference, receiptFile: join(root, "receipt.json") };
}

test("the private preference is only one bounded DefaultKeychain singleton", () => {
  const xml = keychainPreferenceXml("/metadata/<a>&\"b'");
  match(xml, /<key>DefaultKeychain<\/key><array><dict>/);
  match(xml, /&lt;a&gt;&amp;&quot;b&apos;/);
  match(xml, /\{87191ca3-0fc9-11d4-849a-000502b52122\}/);
  match(xml, /<key>SubserviceType<\/key><integer>6<\/integer>/);
  equal((xml.match(/<dict>/g) ?? []).length, 2);
  equal(xml.includes("SearchList"), false);
  equal(xml.includes("LoginKeychain"), false);
  throws(() => keychainPreferenceXml("relative"), /absolute/);
  throws(() => keychainPreferenceXml("/metadata/\ninvalid"), /absolute/);
  throws(() => keychainPreferenceXml(`/${"a".repeat(1_024)}`), /1KiB/);
});

test("preflight checks operator before/private/after and writes only fresh private metadata", (t) => {
  const input = fixture(t);
  const calls = [];
  const receipt = bindPrivateKeychainContext({
    ...input,
    query(home) {
      calls.push(home);
      if (home === input.home) {
        const file = join(home, "Library", "Preferences", "com.apple.security.plist");
        equal(readFileSync(file, "utf8"), keychainPreferenceXml(metadata.path));
        equal(statSync(file).mode & 0o777, 0o600);
        equal(statSync(file).size <= 1_024, true);
      }
      return metadata;
    },
  });
  deepStrictEqual(calls, [reference.home, input.home, reference.home]);
  equal(receipt.privateDefaultMatches, true);
  equal(receipt.operatorDefaultUnchanged, true);
  equal(receipt.defaultPathHash, metadata.pathHash);
  equal(receipt.homeHash, hash(input.home));
  equal(statSync(input.receiptFile).mode & 0o777, 0o600);
  equal(readFileSync(input.receiptFile, "utf8").includes(metadata.path), false);
});

test("changed operator baseline refuses before any private preference is written", (t) => {
  const input = fixture(t);
  throws(
    () => bindPrivateKeychainContext({ ...input, query: () => ({ ...metadata, ino: 3 }) }),
    /changed/,
  );
  equal(existsSync(join(input.home, "Library")), false);
  equal(existsSync(input.receiptFile), false);
});

test("a different private default or changed operator after preflight cannot authorize launch", (t) => {
  for (const failedQuery of [2, 3]) {
    const input = fixture(t);
    let calls = 0;
    throws(
      () =>
        bindPrivateKeychainContext({
          ...input,
          query: () => (++calls === failedQuery ? { ...metadata, ino: 3 } : metadata),
        }),
      /did not preserve/,
    );
    equal(existsSync(input.receiptFile), false);
  }
});

test("HOME and preference directories cannot traverse symlinks or overwrite existing preferences", (t) => {
  const input = fixture(t);
  const alias = join(input.root, "home-link");
  symlinkSync(input.home, alias);
  throws(
    () => bindPrivateKeychainContext({ ...input, home: alias, query: () => metadata }),
    /real HOME/,
  );
  symlinkSync(input.root, join(input.home, "Library"));
  throws(() => bindPrivateKeychainContext({ ...input, query: () => metadata }), /symlink/);
  equal(existsSync(join(input.root, "Preferences")), false);
  rmSync(join(input.home, "Library"));
  const preferences = join(input.home, "Library", "Preferences");
  mkdirSync(preferences, { recursive: true, mode: 0o700 });
  const file = join(preferences, "com.apple.security.plist");
  writeFileSync(file, "existing private preference", { mode: 0o600 });
  throws(() => bindPrivateKeychainContext({ ...input, query: () => metadata }), /EEXIST/);
  equal(readFileSync(file, "utf8"), "existing private preference");
});

test("reference input is a bounded owned private regular file with exact metadata identity", (t) => {
  const input = fixture(t);
  const file = join(input.root, "reference.json");
  writeFileSync(file, JSON.stringify(reference), { mode: 0o600 });
  deepStrictEqual(readKeychainReference(file), reference);
  const alias = join(input.root, "reference-link.json");
  symlinkSync(file, alias);
  throws(() => readKeychainReference(alias));
  chmodSync(file, 0o644);
  throws(() => readKeychainReference(file), /private regular/);
  chmodSync(file, 0o600);
  writeFileSync(file, " ".repeat(4_097));
  throws(() => readKeychainReference(file), /bounded/);
  writeFileSync(file, JSON.stringify({ ...reference, ino: "2" }));
  throws(() => readKeychainReference(file), /Invalid/);
  writeFileSync(file, JSON.stringify({ ...reference, pathHash: hash("/different") }));
  throws(() => readKeychainReference(file), /Invalid/);
});
