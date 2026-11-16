/** Encode a cwd to Claude's project directory: every non-[A-Za-z0-9] char → '-'. */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}
