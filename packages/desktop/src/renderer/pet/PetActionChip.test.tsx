import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PetActionChip } from "./PetActionChip";

describe("PetActionChip", () => {
  test("carries a typed target without encoding ids in its label", () => {
    const html = renderToStaticMarkup(
      <PetActionChip
        label="打开 Work A"
        target={{ agentSessionId: "secret-id", snapshotVersion: 4, generation: 2 }}
        onOpen={() => undefined}
      />,
    );
    expect(html).toContain("打开 Work A");
    expect(html).not.toContain("secret-id");
    expect(html).not.toContain("href=");
    expect(html).toContain('type="button"');
  });
});
