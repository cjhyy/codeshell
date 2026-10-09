import type { ConstrainedProcessLaunch } from "./types.js";

export function isSnapshotName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value) <= 1024 &&
    value.split("/").length <= 16 &&
    value
      .split("/")
      .every((part) => /^[A-Za-z0-9_.-]+$/.test(part) && part !== "." && part !== "..")
  );
}

/** Validate the whole layout before opening even the first mapped resource. */
export function validateResourceLayout(names: readonly string[], declared?: readonly string[]) {
  if (names.length > 256 || names.some((name) => !isSnapshotName(name)))
    throw new Error("Invalid constrained resource mapping");
  const files = new Set(names);
  if (files.size !== names.length) throw new Error("Duplicate constrained resource mapping");
  const directories = new Set<string>();
  for (const name of names) {
    const parts = name.split("/");
    while (parts.length > 1) {
      parts.pop();
      directories.add(parts.join("/"));
    }
  }
  if (declared !== undefined) {
    if (
      declared.length > 256 ||
      declared.some((name) => !isSnapshotName(name)) ||
      new Set(declared).size !== declared.length ||
      [...directories].some((name) => !declared.includes(name))
    )
      throw new Error("Invalid constrained resource directories");
    for (const name of declared) {
      const parts = name.split("/");
      while (parts.length > 1) {
        parts.pop();
        if (!declared.includes(parts.join("/")))
          throw new Error("Undeclared constrained resource parent");
      }
      directories.add(name);
    }
  }
  for (const file of files) {
    if (
      directories.has(file) ||
      [...files, ...directories].some((name) => name.startsWith(`${file}/`))
    )
      throw new Error("Constrained resource path collision");
  }
  return [...directories].sort();
}

export function validateProcessLaunch(
  launch: ConstrainedProcessLaunch,
  files: readonly string[],
  directories: readonly string[],
): Readonly<ConstrainedProcessLaunch> {
  if (
    !launch ||
    Object.keys(launch).some(
      (key) => !["interpreter", "entry", "argv", "cwd", "planSha256"].includes(key),
    ) ||
    !["node", "sh"].includes(launch.interpreter) ||
    !isSnapshotName(launch.entry) ||
    !files.includes(launch.entry) ||
    !Array.isArray(launch.argv) ||
    launch.argv.length > 32 ||
    launch.argv.some(
      (arg) => typeof arg !== "string" || arg.includes("\0") || Buffer.byteLength(arg) > 1024,
    ) ||
    launch.argv.reduce((total, arg) => total + Buffer.byteLength(arg), 0) > 8192 ||
    (launch.cwd !== undefined && launch.cwd !== "." && !directories.includes(launch.cwd)) ||
    typeof launch.planSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(launch.planSha256)
  )
    throw new Error("Invalid constrained process launch");
  return Object.freeze({ ...launch, argv: Object.freeze([...launch.argv]) });
}
