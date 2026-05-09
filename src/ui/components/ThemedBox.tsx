/**
 * ThemedBox — Box that accepts theme keys for color props.
 *
 * Uses the canonical Theme type from utils/theme.ts (shared with
 * components/design-system/ThemedBox). Kept as a separate file because
 * the design-system version depends on the heavy ThemeProvider; this
 * version uses the lightweight ui/theme.ts context.
 */
import React from "react";
import { Box, type BoxProps } from "../../render/index.js";
import { useTheme, resolveColor } from "../theme.js";
import type { Theme } from "../../utils/theme.js";

type ColorProp = keyof Theme | string;

export interface ThemedBoxProps extends Omit<BoxProps, "borderColor" | "backgroundColor"> {
  borderColor?: ColorProp;
  backgroundColor?: ColorProp;
  children?: React.ReactNode;
}

export function ThemedBox({ borderColor, backgroundColor, ...rest }: ThemedBoxProps) {
  const [, theme] = useTheme();
  return (
    <Box
      borderColor={resolveColor(borderColor, theme)}
      backgroundColor={resolveColor(backgroundColor, theme) as any}
      {...rest}
    />
  );
}
