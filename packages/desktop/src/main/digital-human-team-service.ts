import { acquireFileLock, readAllHumanRepoEntries } from "@cjhyy/code-shell-core/internal";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";
import { codeShellHome } from "@cjhyy/code-shell-core";
import { listWorkspaceProfiles } from "@cjhyy/code-shell-core/internal";
import {
  DIGITAL_HUMAN_TEAM_ID_RE,
  parseDigitalHumanTeam,
  type DigitalHumanTeam,
} from "../shared/digital-human-team.js";

const MAX_TEAM_FILE_BYTES = 64 * 1024;
const MAX_LOCAL_TEAM_DIRECTORIES = 10_000;

export function digitalHumanTeamsRoot(): string {
  return join(codeShellHome(), "digital-human-teams");
}

function teamFile(id: string): string {
  return join(digitalHumanTeamsRoot(), id, "team.json");
}

function isContained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function checkedTeamsRoot(create = false): string | undefined {
  const root = digitalHumanTeamsRoot();
  if (create) mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!existsSync(root)) return undefined;
  const rootInfo = lstatSync(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error(`Invalid digital-human teams root: ${root}`);
  }
  return root;
}

function checkedTeamDirectory(id: string, create = false): string | undefined {
  const root = checkedTeamsRoot(create);
  if (!root) return undefined;
  const dir = join(root, id);
  if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existsSync(dir)) return undefined;
  const dirInfo = lstatSync(dir);
  if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) {
    throw new Error(`Invalid digital-human team directory: ${dir}`);
  }
  if (!isContained(realpathSync(root), realpathSync(dir))) {
    throw new Error(`Digital-human team directory escapes its root: ${dir}`);
  }
  return dir;
}

function checkedTeamFile(id: string): string | undefined {
  const dir = checkedTeamDirectory(id);
  if (!dir) return undefined;
  const path = join(dir, "team.json");
  if (!existsSync(path)) return undefined;
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_TEAM_FILE_BYTES) {
    throw new Error(`Invalid digital-human team file: ${path}`);
  }
  return path;
}

export function readDigitalHumanTeam(id: string): DigitalHumanTeam | undefined {
  if (!DIGITAL_HUMAN_TEAM_ID_RE.test(id)) return undefined;
  const path = checkedTeamFile(id);
  if (!path) return undefined;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > MAX_TEAM_FILE_BYTES) {
      throw new Error("team file is too large");
    }
    return parseDigitalHumanTeam(JSON.parse(readFileSync(descriptor, "utf-8")));
  } catch (error) {
    throw new Error(
      `Invalid digital-human team "${id}" at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export interface InvalidDigitalHumanTeam {
  id: string;
  path: string;
  error: string;
}

export function listDigitalHumanTeams(options?: {
  onInvalidTeam?: (issue: InvalidDigitalHumanTeam) => void;
}): DigitalHumanTeam[] {
  const root = checkedTeamsRoot();
  const teams: DigitalHumanTeam[] = [];
  if (root) {
    const directory = opendirSync(root);
    let seen = 0;
    try {
      for (;;) {
        const entry = directory.readSync();
        if (!entry) break;
        seen += 1;
        if (seen > MAX_LOCAL_TEAM_DIRECTORIES) {
          throw new Error("Too many entries in the digital-human teams root");
        }
        if (!entry.isDirectory()) continue;
        try {
          const team = readDigitalHumanTeam(entry.name);
          if (team) teams.push(team);
        } catch (error) {
          // One broken local team must not hide the rest of the library.
          options?.onInvalidTeam?.({
            id: entry.name,
            path: teamFile(entry.name),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      directory.closeSync();
    }
  }
  // Repo-provided teams sit alongside locally-authored ones. A local team with
  // the same id wins, but keeps read-only source metadata so the UI can explain
  // that deleting the override restores the repo version.
  const repoTeams = readAllHumanRepoEntries().teams;
  const repoById = new Map(repoTeams.map((team) => [team.id, team]));
  const localTeams = teams.map((team) => {
    const source = repoById.get(team.id);
    return source
      ? {
          ...team,
          sourceRepo: source.sourceRepo,
          localOverride: true,
        }
      : team;
  });
  const localIds = new Set(localTeams.map((team) => team.id));
  for (const team of repoTeams) {
    if (localIds.has(team.id)) continue;
    localTeams.push({
      id: team.id,
      name: team.name,
      ...(team.description ? { description: team.description } : {}),
      members: [...team.members],
      // `mode` is a dead enum kept for schema compatibility; repos never set it.
      mode: "auto",
      ...(team.lead ? { lead: team.lead } : {}),
      ...(team.playbook ? { playbook: team.playbook } : {}),
      sourceRepo: team.sourceRepo,
    });
  }
  return localTeams.sort((a, b) => a.name.localeCompare(b.name));
}

export function saveDigitalHumanTeam(input: DigitalHumanTeam): DigitalHumanTeam {
  const team = parseDigitalHumanTeam(input);
  const knownProfiles = new Set(listWorkspaceProfiles().map((profile) => profile.name));
  const missing = team.members.find((member) => !knownProfiles.has(member));
  if (missing) throw new Error(`Digital human "${missing}" does not exist`);
  const root = checkedTeamsRoot(true);
  if (!root) throw new Error("Unable to create digital-human teams root");
  const release = acquireFileLock(join(root, ".mutation"));
  try {
    const dir = checkedTeamDirectory(team.id, true);
    if (!dir) throw new Error(`Unable to create digital-human team directory: ${team.id}`);
    const path = join(dir, "team.json");
    if (existsSync(path)) {
      const fileInfo = lstatSync(path);
      if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) {
        throw new Error(`Invalid digital-human team file: ${path}`);
      }
    }
    const serialized = `${JSON.stringify(team, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_TEAM_FILE_BYTES) {
      throw new Error("digital-human team file is too large");
    }
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, serialized, {
        encoding: "utf-8",
        mode: 0o600,
        flag: "wx",
      });
      renameSync(tmp, path);
    } finally {
      rmSync(tmp, { force: true });
    }
  } finally {
    release();
  }
  return team;
}

export function deleteDigitalHumanTeam(id: string): void {
  if (!DIGITAL_HUMAN_TEAM_ID_RE.test(id)) throw new Error("invalid digital-human team id");
  const root = checkedTeamsRoot();
  if (!root) return;
  const release = acquireFileLock(join(root, ".mutation"));
  try {
    const dir = checkedTeamDirectory(id);
    if (dir) rmSync(dir, { recursive: true, force: true });
  } finally {
    release();
  }
}
