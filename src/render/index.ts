/**
 * Public API — re-exports from the custom ink engine matching the npm `ink` API shape.
 * UI components import from here instead of npm `ink`.
 */

import instances from "./instances.js";

export { default as Box, type Props as BoxProps } from "./components/Box.js";
export { default as Text, type Props as TextProps } from "./components/Text.js";
export { default as Spacer } from "./components/Spacer.js";
export { default as Newline } from "./components/Newline.js";

export { default as useApp } from "./hooks/use-app.js";
export { default as useInput } from "./hooks/use-input.js";
export { default as useStdin } from "./hooks/use-stdin.js";

// useStdout — CC's ink doesn't have a direct equivalent of npm ink's useStdout.
// Provide a shim that returns process.stdout.
export function useStdout() {
  return {
    stdout: process.stdout,
    write: (data: string) => process.stdout.write(data),
  };
}

// Clear the visible terminal and force a full redraw.
//
// `clearScrollback` (CSI 3J) is used at view-boundary transitions where the
// previous frame's content is a *different* conversation — e.g. switching
// from a sub-agent transcript back to main. In flow mode log-update's
// incremental shrink path only erases within the viewport, and content
// that scrolled into native scrollback bleeds through as residue. Wiping
// scrollback at the boundary gives a clean canvas.
export function forceRedraw(
  options: { stdout?: NodeJS.WriteStream; clearScrollback?: boolean } = {},
): void {
  const stdout = options.stdout ?? process.stdout;
  instances.get(stdout)?.forceRedraw({ clearScrollback: options.clearScrollback });
}

// Re-export the ScrollBox for use in UI
export { default as ScrollBox, type ScrollBoxHandle, type ScrollBoxProps } from "./components/ScrollBox.js";

// Re-export AlternateScreen
export { AlternateScreen } from "./components/AlternateScreen.js";

// Re-export Ansi
export { Ansi } from "./Ansi.js";

// Re-export NoSelect
export { NoSelect } from "./components/NoSelect.js";

// Re-export Button
export { default as Button } from "./components/Button.js";

// Re-export Link
export { default as Link } from "./components/Link.js";

// Re-export RawAnsi
export { RawAnsi } from "./components/RawAnsi.js";

// Re-export Static
export { Static } from "./components/Static.js";

// render function
export { default as render, renderSync, createRoot, type RenderOptions, type Instance } from "./root.js";
