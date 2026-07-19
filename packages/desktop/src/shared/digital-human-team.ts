export const DIGITAL_HUMAN_TEAM_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const DIGITAL_HUMAN_ID_RE = DIGITAL_HUMAN_TEAM_ID_RE;

export type DigitalHumanTeamMode = "auto" | "divide" | "compare";

/** Reusable project workflow that creates one independently bound Session per member. */
export interface DigitalHumanTeam {
  id: string;
  name: string;
  description?: string;
  members: string[];
  mode: DigitalHumanTeamMode;
}

const TEAM_MODES = new Set<DigitalHumanTeamMode>(["auto", "divide", "compare"]);

export function parseDigitalHumanTeam(input: unknown): DigitalHumanTeam {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("digital-human team must be an object");
  }
  const value = input as Record<string, unknown>;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const description = typeof value.description === "string" ? value.description.trim() : undefined;
  const mode = value.mode as DigitalHumanTeamMode;
  if (!DIGITAL_HUMAN_TEAM_ID_RE.test(id)) throw new Error("invalid digital-human team id");
  if (!name || name.length > 120) throw new Error("invalid digital-human team name");
  if (description !== undefined && description.length > 1_000) {
    throw new Error("digital-human team description is too long");
  }
  if (!TEAM_MODES.has(mode)) throw new Error("invalid digital-human team mode");
  if (!Array.isArray(value.members) || value.members.length < 2 || value.members.length > 8) {
    throw new Error("digital-human team must contain 2 to 8 members");
  }
  const members = value.members.map((member) => (typeof member === "string" ? member.trim() : ""));
  if (
    members.some((member) => !DIGITAL_HUMAN_ID_RE.test(member)) ||
    new Set(members).size !== members.length
  ) {
    throw new Error("digital-human team members must be unique valid ids");
  }
  return { id, name, ...(description ? { description } : {}), members, mode };
}
