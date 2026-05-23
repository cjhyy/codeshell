/**
 * React hook that prints cost summary and saves session costs on process exit.
 */
import { useEffect } from "react";
import { costTracker } from "@cjhyy/code-shell-core";
import { CHALK_COLORIZER } from "../../utils/colorizer.js";

export function useCostSummary(): void {
  useEffect(() => {
    const onExit = () => {
      const tokens = costTracker.getTotalTokens();
      if (tokens.total > 0) {
        process.stdout.write("\n" + costTracker.formatSummary(CHALK_COLORIZER) + "\n");
      }
    };
    process.on("exit", onExit);
    return () => {
      process.off("exit", onExit);
    };
  }, []);
}
