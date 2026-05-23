/**
 * Chalk-backed Colorizer adapter for the TUI. Plug this into core
 * formatters that take a `Colorizer` argument so terminal output keeps
 * its colors.
 *
 * Defined in tui because chalk is a tui dependency — core stays
 * chalk-agnostic.
 */
import chalk from "chalk";
import type { Colorizer } from "@cjhyy/code-shell-core";

export const CHALK_COLORIZER: Colorizer = {
  dim: (s) => chalk.dim(s),
  bold: (s) => chalk.bold(s),
  red: (s) => chalk.red(s),
  yellow: (s) => chalk.yellow(s),
  green: (s) => chalk.green(s),
  cyan: (s) => chalk.cyan(s),
  white: (s) => chalk.white(s),
  boldCyan: (s) => chalk.bold.cyan(s),
  boldWhite: (s) => chalk.bold.white(s),
};
