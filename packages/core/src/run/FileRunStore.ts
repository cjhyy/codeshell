/**
 * FileRunStore — local filesystem implementation of RunStore.
 *
 * Layout:
 *   ~/.code-shell/runs/<runId>/
 *     run.json              — current snapshot
 *     events.jsonl          — append-only event log
 *     checkpoints/<id>.json — structured checkpoints
 *     approvals/<id>.json   — approval records
 *     artifacts/refs.jsonl  — artifact reference log
 */

import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { RunStore } from "./RunStore.js";
import type {
  RunSnapshot,
  RunEvent,
  RunCheckpoint,
  RunApproval,
  RunArtifactRef,
  ListRunsQuery,
} from "./types.js";

export class FileRunStore implements RunStore {
  private readonly runsDir: string;

  constructor(storageDir?: string) {
    this.runsDir = storageDir ?? join(homedir(), ".code-shell", "runs");
    mkdirSync(this.runsDir, { recursive: true });
  }

  // ─── Helpers ───────────────────────────────────────────────────

  private runDir(runId: string): string {
    return join(this.runsDir, runId);
  }

  private ensureRunDir(runId: string): string {
    const dir = this.runDir(runId);
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, "checkpoints"), { recursive: true });
    mkdirSync(join(dir, "approvals"), { recursive: true });
    mkdirSync(join(dir, "artifacts"), { recursive: true });
    return dir;
  }

  private writeJson(filePath: string, data: unknown): void {
    const tmp = filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    // Atomic rename — prevents partial writes on crash
    renameSync(tmp, filePath);
  }

  private readJson<T>(filePath: string): T | null {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  }

  /** Serializes concurrent JSONL appends per file path. */
  private readonly appendLocks = new Map<string, Promise<void>>();

  private async appendJsonl(filePath: string, data: unknown): Promise<void> {
    // Serialize writes to the same file to prevent interleaved output
    const prev = this.appendLocks.get(filePath) ?? Promise.resolve();
    const current = prev.then(() => {
      appendFileSync(filePath, JSON.stringify(data) + "\n", "utf-8");
    });
    this.appendLocks.set(filePath, current);
    await current;
  }

  private readJsonl<T>(filePath: string): T[] {
    if (!existsSync(filePath)) return [];
    const content = readFileSync(filePath, "utf-8");
    if (!content) return [];
    return content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as T);
  }

  // ─── Snapshot ──────────────────────────────────────────────────

  async create(snapshot: RunSnapshot): Promise<void> {
    const dir = this.ensureRunDir(snapshot.runId);
    this.writeJson(join(dir, "run.json"), snapshot);
  }

  async update(snapshot: RunSnapshot): Promise<void> {
    const dir = this.runDir(snapshot.runId);
    if (!existsSync(dir)) {
      throw new Error(`Run not found: ${snapshot.runId}`);
    }
    this.writeJson(join(dir, "run.json"), snapshot);
  }

  async get(runId: string): Promise<RunSnapshot | null> {
    return this.readJson<RunSnapshot>(join(this.runDir(runId), "run.json"));
  }

  async list(query?: ListRunsQuery): Promise<RunSnapshot[]> {
    if (!existsSync(this.runsDir)) return [];

    const entries = readdirSync(this.runsDir, { withFileTypes: true });
    const snapshots: RunSnapshot[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const snapshot = this.readJson<RunSnapshot>(
        join(this.runsDir, entry.name, "run.json"),
      );
      if (!snapshot) continue;

      // Filter by status
      if (query?.status) {
        const statuses = Array.isArray(query.status) ? query.status : [query.status];
        if (!statuses.includes(snapshot.status)) continue;
      }

      // Filter by tag
      if (query?.tag && !snapshot.tags.includes(query.tag)) continue;

      snapshots.push(snapshot);
    }

    // Sort by createdAt descending (newest first)
    snapshots.sort((a, b) => b.createdAt - a.createdAt);

    // Pagination
    const offset = query?.offset ?? 0;
    const limit = query?.limit ?? 50;
    return snapshots.slice(offset, offset + limit);
  }

  async delete(runId: string): Promise<void> {
    const dir = this.runDir(runId);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ─── Events ────────────────────────────────────────────────────

  async appendEvent(event: RunEvent): Promise<void> {
    this.ensureRunDir(event.runId);
    const dir = this.runDir(event.runId);
    await this.appendJsonl(join(dir, "events.jsonl"), event);
  }

  async listEvents(runId: string): Promise<RunEvent[]> {
    return this.readJsonl<RunEvent>(join(this.runDir(runId), "events.jsonl"));
  }

  // ─── Checkpoints ───────────────────────────────────────────────

  async saveCheckpoint(cp: RunCheckpoint): Promise<void> {
    const dir = this.runDir(cp.runId);
    this.writeJson(join(dir, "checkpoints", `${cp.checkpointId}.json`), cp);
  }

  async getLatestCheckpoint(runId: string): Promise<RunCheckpoint | null> {
    const cpDir = join(this.runDir(runId), "checkpoints");
    if (!existsSync(cpDir)) return null;

    const files = readdirSync(cpDir).filter((f) => f.endsWith(".json"));
    if (files.length === 0) return null;

    // Find the latest by createdAt
    let latest: RunCheckpoint | null = null;
    for (const file of files) {
      const cp = this.readJson<RunCheckpoint>(join(cpDir, file));
      if (cp && (!latest || cp.createdAt > latest.createdAt)) {
        latest = cp;
      }
    }
    return latest;
  }

  // ─── Approvals ─────────────────────────────────────────────────

  async saveApproval(approval: RunApproval): Promise<void> {
    const dir = this.runDir(approval.runId);
    this.writeJson(
      join(dir, "approvals", `${approval.approvalId}.json`),
      approval,
    );
  }

  async getApproval(runId: string, approvalId: string): Promise<RunApproval | null> {
    return this.readJson<RunApproval>(
      join(this.runDir(runId), "approvals", `${approvalId}.json`),
    );
  }

  async getPendingApproval(runId: string): Promise<RunApproval | null> {
    const approvalDir = join(this.runDir(runId), "approvals");
    if (!existsSync(approvalDir)) return null;

    const files = readdirSync(approvalDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const approval = this.readJson<RunApproval>(join(approvalDir, file));
      if (approval?.status === "pending") return approval;
    }
    return null;
  }

  // ─── Artifact Refs ─────────────────────────────────────────────

  async appendArtifactRef(ref: RunArtifactRef): Promise<void> {
    this.ensureRunDir(ref.runId);
    const dir = this.runDir(ref.runId);
    await this.appendJsonl(join(dir, "artifacts", "refs.jsonl"), ref);
  }

  async listArtifactRefs(runId: string): Promise<RunArtifactRef[]> {
    return this.readJsonl<RunArtifactRef>(
      join(this.runDir(runId), "artifacts", "refs.jsonl"),
    );
  }
}
