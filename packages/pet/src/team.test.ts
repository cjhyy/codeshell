import { describe, expect, test } from "bun:test";
import { parseDigitalHumanTeam } from "./team.js";

describe("digital-human team", () => {
  test("accepts a bounded team with unique members", () => {
    expect(
      parseDigitalHumanTeam({
        id: "product-studio",
        name: "产品工作室",
        members: ["researcher", "designer", "developer"],
        mode: "divide",
      }),
    ).toEqual({
      id: "product-studio",
      name: "产品工作室",
      members: ["researcher", "designer", "developer"],
      mode: "divide",
    });
  });

  test("rejects a one-person team, duplicate members and invalid modes", () => {
    for (const input of [
      { id: "solo", name: "Solo", members: ["one"], mode: "auto" },
      { id: "dupe", name: "Dupe", members: ["one", "one"], mode: "divide" },
      { id: "bad", name: "Bad", members: ["one", "two"], mode: "serial" },
    ]) {
      expect(() => parseDigitalHumanTeam(input)).toThrow();
    }
  });

  test("rejects member ids that cannot name a digital-human profile", () => {
    for (const member of ["Uppercase", "../escape", "white space", "x".repeat(65)]) {
      expect(() =>
        parseDigitalHumanTeam({
          id: "invalid-member",
          name: "Invalid member",
          members: ["valid", member],
          mode: "divide",
        }),
      ).toThrow("digital-human team members must be unique valid ids");
    }
  });
});
