import { execFile } from "node:child_process";
import type { ToolProbeResult } from "@cjhyy/code-shell-core";

/** Probe version tools without blocking Main, with bounded output and duration. */
export function probeProfileTool(bin: string): Promise<ToolProbeResult> {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(bin)) return Promise.resolve({ status: "failed" });
  return new Promise((resolve) => {
    execFile(
      bin,
      ["--version"],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) resolve({ status: error.code === "ENOENT" ? "not-found" : "failed" });
        else resolve({ status: "ok", output: `${stdout}${stderr}`.trim() });
      },
    );
  });
}

export async function probeProfileTools(
  bins: readonly string[],
): Promise<Map<string, ToolProbeResult>> {
  const unique = [...new Set(bins)];
  const results = new Map<string, ToolProbeResult>();
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, unique.length) }, async () => {
      while (index < unique.length) {
        const bin = unique[index++]!;
        results.set(bin, await probeProfileTool(bin));
      }
    }),
  );
  return results;
}
