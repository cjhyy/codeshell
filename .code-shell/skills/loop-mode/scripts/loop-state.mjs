#!/usr/bin/env node
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const command = args.shift();
const options = new Map();
for (let index = 0; index < args.length; index += 2) {
  const key = args[index];
  if (!key?.startsWith("--") || args[index + 1] === undefined) throw new Error(`Invalid option: ${key}`);
  options.set(key.slice(2), args[index + 1]);
}
const required = (name) => {
  const value = options.get(name);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
};
const root = resolve(required("root"));
const slug = required("slug");
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error("slug must be lowercase kebab-case");
const loopDir = join(root, ".loop", slug);
const statePath = join(loopDir, "STATE.json");
const runsPath = join(loopDir, "RUNS.jsonl");
const now = () => new Date().toISOString();
const readState = async () => JSON.parse(await readFile(statePath, "utf8"));
const atomicWrite = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, path);
};
const event = async (type, message, extra = {}) => {
  await appendFile(runsPath, `${JSON.stringify({ at: now(), type, message, ...extra })}\n`, "utf8");
};

if (command === "init") {
  const attendance = required("attendance");
  if (!["attended", "unattended"].includes(attendance)) throw new Error("invalid attendance");
  const maxRounds = Number(required("max-rounds"));
  if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new Error("max-rounds must be a positive integer");
  const state = {
    version: 1, slug, objective: required("objective"), attendance, status: "ready",
    phase: "milestone", round: 0, maxRounds, deadline: options.get("deadline") ?? null,
    candidateBranch: `loop/${slug}/candidate`, activeGate: null,
    nextAction: "run_next_round", createdAt: now(), updatedAt: now(),
  };
  await mkdir(join(loopDir, "rounds"), { recursive: true });
  await atomicWrite(statePath, state);
  await event("initialized", "loop initialized", { status: state.status });
  console.log(JSON.stringify(state, null, 2));
} else if (command === "transition") {
  const allowed = new Set(["ready", "running", "validating", "reviewing", "paused", "waiting_review", "completed", "stopped", "blocked"]);
  const status = required("status");
  if (!allowed.has(status)) throw new Error(`invalid status: ${status}`);
  const state = await readState();
  if (["completed", "stopped"].includes(state.status) && state.status !== status) throw new Error(`terminal loop cannot transition from ${state.status}`);
  state.status = status;
  state.updatedAt = now();
  if (options.has("next-action")) state.nextAction = options.get("next-action");
  if (options.has("round")) state.round = Number(options.get("round"));
  await atomicWrite(statePath, state);
  await event("transition", options.get("reason") ?? `status -> ${status}`, { status });
  console.log(JSON.stringify(state, null, 2));
} else if (command === "event") {
  await mkdir(loopDir, { recursive: true });
  await event(required("type"), required("message"));
} else if (command === "status") {
  console.log(JSON.stringify(await readState(), null, 2));
} else {
  throw new Error("Usage: loop-state.mjs init|transition|event|status ...");
}
