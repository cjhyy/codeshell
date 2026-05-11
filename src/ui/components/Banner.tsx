/**
 * Startup banner — matches Claude Code's CondensedLogo layout.
 *
 * Layout:
 *   🐕 logo   Code Shell v0.1.0
 *              Model (effort) · billing
 *              ~/path/to/cwd
 */
import { Box, Text } from "../../render/index.js";
import { DogLogo } from "./DogLogo.js";
import { KunLogo } from "./KunLogo.js";
import { KunHead } from "./KunHead.js";
import { BabyHand } from "./BabyHand.js";
import { getCurrentVersion } from "../../cli/updater.js";

// Logo selection: random from all four (or CODESHELL_LOGO env to force one)
type LogoKind = "dog" | "kunhead" | "kunball" | "baby";

function pickLogo(): LogoKind {
  const env = process.env.CODESHELL_LOGO;
  if (env === "dog" || env === "kunhead" || env === "kunball" || env === "baby") return env;
  // Random: 1/4 each
  const r = Math.random();
  if (r < 0.25) return "dog";
  if (r < 0.50) return "kunhead";
  if (r < 0.75) return "kunball";
  return "baby";
}

const logoKind = pickLogo();
const LOGO_MAP = { dog: DogLogo, kunhead: KunHead, kunball: KunLogo, baby: BabyHand };
const LogoComponent = LOGO_MAP[logoKind];
const isKunHead = logoKind === "kunhead";

interface BannerProps {
  model: string;
  effort: string;
  maxTurns: number;
  cwd: string;
}

export function Banner({ model, effort, cwd }: BannerProps) {
  const shortCwd = shortenPath(cwd);
  const modelName = formatModel(model);
  const effortSuffix = effort !== "high" ? ` (${effort})` : "";
  const title = isKunHead ? "iKun Shell" : "Code Shell";

  return (
    <Box flexDirection="column" marginBottom={0}>
      <Text> </Text>
      {isKunHead && (
        <Box paddingLeft={1} marginBottom={0}>
          <Text color="rgb(255,200,60)" bold>{"全民制作人们大家好"}</Text>
        </Box>
      )}
      <Box flexDirection="row" gap={2} alignItems="center">
        <LogoComponent />
        <Box flexDirection="column">
          <Box>
            <Text bold>{title}</Text>
            <Text dim>{" v" + getCurrentVersion()}</Text>
          </Box>
          <Box>
            <Text>{modelName}</Text>
            <Text dim>{effortSuffix}</Text>
          </Box>
          <Box>
            <Text dim>{shortCwd}</Text>
          </Box>
        </Box>
      </Box>
      <Text> </Text>
    </Box>
  );
}

function shortenPath(p: string): string {
  const home = process.env.HOME ?? "";
  if (home && p.startsWith(home)) {
    return "~" + p.slice(home.length);
  }
  return p;
}

function formatModel(model: string): string {
  const name = model.split("/").pop() ?? model;
  return name
    .replace("claude-opus-4-6", "Claude Opus 4.6")
    .replace("claude-sonnet-4-6", "Claude Sonnet 4.6")
    .replace("claude-haiku-4-5", "Claude Haiku 4.5")
    .replace("claude-", "Claude ");
}
