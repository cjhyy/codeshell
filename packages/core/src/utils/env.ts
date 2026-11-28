/**
 * Environment detection — platform, terminal, shell and CI.
 */

// ─── Platform / Terminal ────────────────────────────────────────────

export const env = {
  platform: process.platform as "darwin" | "linux" | "win32",
  terminal: process.env.TERM_PROGRAM ?? process.env.TERM ?? "unknown",
  shell: process.env.SHELL ?? (process.platform === "win32" ? "cmd.exe" : "/bin/sh"),
  isCI: !!(process.env.CI || process.env.GITHUB_ACTIONS || process.env.GITLAB_CI),
};
