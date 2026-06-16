import React from "react";
import { TokenTab } from "./TokenTab";

/** Link credentials reuse the token form with kind="link" (adds the appUrl field). */
export function LinkTab({ cwd }: { cwd: string }) {
  return <TokenTab cwd={cwd} kind="link" />;
}
