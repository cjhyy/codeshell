import { expect, test } from "bun:test";
import React, { useState } from "react";
import TextInput from "../packages/tui/src/ui/components/TextInput.js";
import { flush, mount } from "./render-fixtures";

function settleInput(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 75));
}

test("TextInput Delete removes the character at the cursor", async () => {
  let latest = "abc";

  function Harness() {
    const [value, setValue] = useState("abc");
    return React.createElement(TextInput, {
      value,
      onChange: (next: string) => {
        latest = next;
        setValue(next);
      },
    });
  }

  const h = mount(React.createElement(Harness));
  try {
    await flush();
    h.stdin.write("\x1b[D");
    await settleInput();
    await flush();
    h.stdin.write("\x1b[3~");
    await settleInput();
    await flush();

    expect(latest).toBe("ab");
  } finally {
    h.unmount();
  }
});
