/**
 * ThemedText — Text that accepts theme keys for color props.
 *
 * Uses the canonical Theme type from utils/theme.ts (shared with
 * components/design-system/ThemedText). Kept separate because the
 * design-system version depends on the heavy ThemeProvider; this
 * version uses the lightweight ui/theme.ts context.
 */
import React from "react";
import { Text } from "../../ink/index.js";
import { useTheme, resolveColor } from "../theme.js";
import type { Theme } from "../../utils/theme.js";

type ColorProp = keyof Theme | string;

export interface ThemedTextProps {
  color?: ColorProp;
  backgroundColor?: ColorProp;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  inverse?: boolean;
  dimColor?: boolean;
  dim?: boolean;
  wrap?: "wrap" | "truncate" | "truncate-start" | "truncate-middle" | "truncate-end";
  children?: React.ReactNode;
}

export function ThemedText({
  color,
  backgroundColor,
  dimColor,
  dim,
  ...rest
}: ThemedTextProps) {
  const [, theme] = useTheme();

  const resolvedColor = dimColor
    ? resolveColor("inactive", theme)
    : resolveColor(color, theme);
  const resolvedBg = resolveColor(backgroundColor, theme);

  return (
    <Text
      color={resolvedColor}
      backgroundColor={resolvedBg as any}
      dim={dim}
      {...rest}
    />
  );
}
