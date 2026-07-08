import { expect, test } from "bun:test";
import React from "react";
import { ProviderModelFlow } from "../packages/tui/src/ui/components/ProviderModelFlow.js";
import { flush, mount, plainText } from "./render-fixtures";

function settleInput(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 75));
}

test("ProviderModelFlow masks API key input while typing", async () => {
  const secret = "sk-live-secret-123456";

  const harness = mount(
    <ProviderModelFlow
      existingProviders={[]}
      existingModelKeys={[]}
      switchToNewModelOnFinish={false}
      onFinish={() => {}}
      onCancel={() => {}}
    />,
    { columns: 100 },
  );
  try {
    await flush();
    harness.stdin.write("\r");
    await settleInput();
    await flush();

    harness.stdin.write(secret);
    await settleInput();
    await flush();

    const output = plainText(harness);
    expect(output).toContain("API Key:");
    expect(output).not.toContain(secret);
  } finally {
    harness.unmount();
  }
});
