import { test, expect } from "bun:test";
import { generateSecret } from "./deviceCredential";

test("generateSecret 产出 64 位小写 hex(32 字节)", () => {
  // 注入确定性随机源便于断言。
  const s = generateSecret(() => new Uint8Array(32).fill(0xab));
  expect(s).toBe("ab".repeat(32));
  expect(s).toMatch(/^[0-9a-f]{64}$/);
});

test("不同随机源 → 不同 secret", () => {
  const a = generateSecret(() => new Uint8Array(32).fill(0x01));
  const b = generateSecret(() => new Uint8Array(32).fill(0x02));
  expect(a).not.toBe(b);
});

test("默认用 crypto.getRandomValues,长度 64 hex", () => {
  const s = generateSecret();
  expect(s).toMatch(/^[0-9a-f]{64}$/);
});
