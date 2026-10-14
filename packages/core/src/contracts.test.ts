import { describe, expect, test } from "bun:test";
import { CONTRACTS } from "./contracts.js";

describe("CONTRACTS", () => {
  // Changing a version is a compatibility decision. Update docs/compatibility
  // notes and every peer (Desktop, services, mobile) in the same change.
  test("pins every externally visible contract version", () => {
    expect(CONTRACTS).toEqual({
      agentProtocol: { supported: ["1"], preferred: "1" },
      panelApi: 14,
      cloudManagementAuthority: 2,
      cloudBrowserAuthority: 1,
      relayProtocol: 1,
      desktopControl: 1,
      mobileRemote: 1,
      outputJournal: 1,
    });
  });

  test("cannot be mutated at runtime", () => {
    expect(Object.isFrozen(CONTRACTS)).toBe(true);
    expect(Object.isFrozen(CONTRACTS.agentProtocol)).toBe(true);
    expect(Object.isFrozen(CONTRACTS.agentProtocol.supported)).toBe(true);
  });
});
