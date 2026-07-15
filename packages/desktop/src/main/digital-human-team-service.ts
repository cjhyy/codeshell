import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  codeShellHome,
  listWorkspaceProfiles,
  readWorkspaceProfile,
} from "@cjhyy/code-shell-core";
import {
  DIGITAL_HUMAN_TEAM_ID_RE,
  parseDigitalHumanTeam,
  type DigitalHumanTeam,
} from "@cjhyy/code-shell-pet";

export function digitalHumanTeamsRoot(): string {
  return join(codeShellHome(), "digital-human-teams");
}

function teamFile(id: string): string {
  return join(digitalHumanTeamsRoot(), id, "team.json");
}

export function readDigitalHumanTeam(id: string): DigitalHumanTeam | undefined {
  if (!DIGITAL_HUMAN_TEAM_ID_RE.test(id)) return undefined;
  const path = teamFile(id);
  if (!existsSync(path)) return undefined;
  try {
    return parseDigitalHumanTeam(JSON.parse(readFileSync(path, "utf-8")));
  } catch (error) {
    throw new Error(
      `Invalid digital-human team "${id}" at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

export function listDigitalHumanTeams(): DigitalHumanTeam[] {
  const root = digitalHumanTeamsRoot();
  if (!existsSync(root)) return [];
  const teams: DigitalHumanTeam[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const team = readDigitalHumanTeam(entry.name);
      if (team) teams.push(team);
    } catch {
      // One broken local team must not hide the rest of the library.
    }
  }
  return teams.sort((a, b) => a.name.localeCompare(b.name));
}

export function saveDigitalHumanTeam(input: DigitalHumanTeam): DigitalHumanTeam {
  const team = parseDigitalHumanTeam(input);
  const knownProfiles = new Set(listWorkspaceProfiles().map((profile) => profile.name));
  const missing = team.members.find((member) => !knownProfiles.has(member));
  if (missing) throw new Error(`Digital human "${missing}" does not exist`);
  const dir = join(digitalHumanTeamsRoot(), team.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = teamFile(team.id);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(team, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, path);
  return team;
}

export function deleteDigitalHumanTeam(id: string): void {
  if (!DIGITAL_HUMAN_TEAM_ID_RE.test(id)) throw new Error("invalid digital-human team id");
  rmSync(join(digitalHumanTeamsRoot(), id), { recursive: true, force: true });
}

/** Resolve and validate the closed member set before handing it to Pet. */
export function resolveDigitalHumanTeam(id: string): DigitalHumanTeam | undefined {
  const team = readDigitalHumanTeam(id);
  if (!team) return undefined;
  if (team.members.some((member) => !readWorkspaceProfile(member))) return undefined;
  return team;
}
