import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { LINK_OPERATION_CONTRACTS } from "../packages/link/src/operations.js";

const snapshotPath = "packages/link/contracts/operations.v1.json";
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const current = Object.fromEntries(
  LINK_OPERATION_CONTRACTS.map((contract) => [contract.operationId, contract]),
);
const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
if (canonical(current) !== canonical(snapshot))
  throw new Error(
    "Link contracts differ from their reviewed snapshot. A breaking contract must use a new action name.",
  );
const base = process.env.LINK_CONTRACT_BASE;
if (base && !/^0+$/.test(base)) {
  if (!/^[a-f0-9]{7,40}$/i.test(base)) throw new Error("LINK_CONTRACT_BASE must be a commit SHA.");
  const commit = spawnSync("git", ["cat-file", "-e", `${base}^{commit}`]);
  if (commit.status !== 0) throw new Error("The Link contract comparison base is unavailable.");
  const listing = spawnSync("git", ["ls-tree", "-z", base, "--", snapshotPath], {
    encoding: "utf8",
  });
  if (listing.error || listing.status !== 0)
    throw new Error("The Link contract base tree is unreadable.");
  if (listing.stdout) {
    if (!/^100644 blob [a-f0-9]+\t[^\0]+\0$/.test(listing.stdout))
      throw new Error("The Link contract baseline must be an ordinary tracked file.");
    const previous = spawnSync("git", ["show", `${base}:${snapshotPath}`], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    if (previous.error || previous.status !== 0)
      throw new Error("The Link contract baseline cannot be read.");
    for (const [id, contract] of Object.entries(JSON.parse(previous.stdout))) {
      if (canonical(current[id]) !== canonical(contract))
        throw new Error(
          `Immutable Link contract changed: ${id}. Keep the old action and publish the new contract under a new action name.`,
        );
    }
  } else {
    // This is the first commit introducing the baseline, not permission to ignore a missing commit.
    console.log("Introducing the initial immutable Link contract baseline.");
  }
}
console.log(`Verified ${LINK_OPERATION_CONTRACTS.length} immutable Link operation contracts.`);
