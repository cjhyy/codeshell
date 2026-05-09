/**
 * Public API — re-exports from the custom ink engine matching the npm `ink` API shape.
 * UI components import from here instead of npm `ink`.
 */

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

// Re-export the ScrollBox for use in UI
export { default as ScrollBox, type ScrollBoxHandle, type ScrollBoxProps } from "./components/ScrollBox.js";

// Re-export AlternateScreen
export { AlternateScreen } from "./components/AlternateScreen.js";

// render function
export { default as render, renderSync, createRoot, type RenderOptions, type Instance } from "./root.js";
