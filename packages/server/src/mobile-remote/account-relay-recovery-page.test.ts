import { expect, test } from "bun:test";
import { accountRelayRecoveryPage } from "./account-relay-recovery-page.js";

test("account relay recovery page embeds one nonce-bound, parseable bootstrap script", () => {
  const page = accountRelayRecoveryPage('https://account.example/app"><x>');
  const scripts = [...page.html.matchAll(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/g)];
  expect(scripts).toHaveLength(1);
  const [, nonce, source] = scripts[0]!;
  expect(page.policy).toContain(`script-src 'nonce-${nonce}'`);
  expect(page.policy).toContain("connect-src 'self'");
  expect(page.policy).toContain("form-action 'none'");
  // The shared bootstrap is serialized with Function#toString; it must stay
  // self-contained after compilation or the pre-SPA page silently breaks.
  expect(() => new Function(source!)).not.toThrow();
  expect(page.html).not.toContain('"><x>');
  expect(page.html).toContain("&quot;&gt;&lt;x&gt;");
  expect(accountRelayRecoveryPage("https://account.example/app").policy).not.toBe(page.policy);
});
