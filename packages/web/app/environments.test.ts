import { expect, test } from "bun:test";
import {
  environmentAddress,
  readEnvironments,
  saveEnvironment,
  removeEnvironment,
  verifyCurrentEnvironment,
} from "./environments.js";
import { isEnvironmentDescriptor, projectReferenceKey } from "../src/lib/environment.js";

const first = "00000000-0000-4000-8000-000000000001";
const second = "00000000-0000-4000-8000-000000000002";
const environment = {
  version: 1,
  id: first,
  name: "电脑",
  kind: "desktop",
  entryPath: "/mobile",
} as const;
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

test("bookmarks roundtrip without credentials; verified host identity cannot silently change", () => {
  const disk = storage();
  saveEnvironment(disk, {
    name: "电脑",
    address: "https://computer.example/mobile/",
    environmentId: first,
  });
  saveEnvironment(disk, { name: "工作电脑", address: "https://computer.example/mobile" });
  expect(readEnvironments(disk)).toEqual([
    { name: "工作电脑", address: "https://computer.example/mobile", environmentId: first },
  ]);
  expect(() =>
    saveEnvironment(disk, {
      name: "冒名环境",
      address: "https://computer.example/mobile",
      environmentId: second,
    }),
  ).toThrow("身份已变化");
  expect(() =>
    verifyCurrentEnvironment(readEnvironments(disk), "https://computer.example", {
      ...environment,
      id: second,
    }),
  ).toThrow();
  expect(removeEnvironment(disk, "https://computer.example/mobile")).toEqual([]);
});

test.each([
  "javascript:alert(1)",
  "file:///etc/passwd",
  "https://user:secret@example.com/",
  "https://computer.example/mobile?pairing=secret",
  "https://hub.example/#setup=secret",
  "https://hub.example/api/v1/auth/logout",
  "https://example.com/\\evil",
  " https://example.com",
])("refuses secret-bearing or non-workbench address %s", (value) => {
  expect(() => environmentAddress(value)).toThrow();
});

test("one project id in two hosts has different identity; filesystem paths are not project ids", () => {
  expect(projectReferenceKey({ environmentId: first, projectId: first })).not.toBe(
    projectReferenceKey({ environmentId: second, projectId: first }),
  );
  expect(() => projectReferenceKey({ environmentId: first, projectId: "/etc" })).toThrow();
  expect(isEnvironmentDescriptor(environment)).toBe(true);
  expect(isEnvironmentDescriptor({ ...environment, entryPath: "https://other.example" })).toBe(
    false,
  );
});

test("malformed browser data is not trusted or silently overwritten", () => {
  const broken = {
    getItem: () => '[{"name":"X","address":"javascript:alert(1)"}]',
    setItem: () => {
      throw new Error("must not write");
    },
  };
  expect(() => readEnvironments(broken)).toThrow();
  expect(() => saveEnvironment(broken, { name: "Hub", address: "https://hub.example/" })).toThrow();
});
