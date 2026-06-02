import { describe, it, expect } from "vitest";
import { SettingsSchema } from "../schema.js";

describe("agent personalization schema", () => {
  it("accepts responseLanguage / userProfile / instructions", () => {
    const parsed = SettingsSchema.parse({
      agent: {
        responseLanguage: "简体中文",
        userProfile: "叫我 maki",
        instructions: { compatClaude: false, compatCodex: true },
      },
    });
    expect(parsed.agent.responseLanguage).toBe("简体中文");
    expect(parsed.agent.userProfile).toBe("叫我 maki");
    expect(parsed.agent.instructions?.compatClaude).toBe(false);
    expect(parsed.agent.instructions?.compatCodex).toBe(true);
  });

  it("defaults both compat flags to true when instructions present-but-empty", () => {
    const parsed = SettingsSchema.parse({ agent: { instructions: {} } });
    expect(parsed.agent.instructions?.compatClaude).toBe(true);
    expect(parsed.agent.instructions?.compatCodex).toBe(true);
  });
});
