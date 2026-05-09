/**
 * Dog ASCII art logo – a Papillon (蝴蝶犬) mascot for Code Shell.
 *
 * Designed to look like a cute Papillon with:
 * - Big butterfly ears (black with pink inner)
 * - White face stripe, black sides
 * - Round dark eyes, small black nose
 * - Pink tongue sticking out
 * - Fluffy white chest
 *
 * 9 cols wide × 5 rows tall, similar footprint to Clawd.
 */
import { Box, Text } from "../../render/index.js";

// Papillon colors
const BLK  = "rgb(45,42,40)";        // Black fur
const WHT  = "rgb(250,247,240)";     // White fur
const PINK = "rgb(235,130,140)";     // Tongue / inner ear
const NOSE = "rgb(25,25,25)";        // Nose
const EYE  = "rgb(60,40,20)";        // Eye color
const EYEBG = "rgb(250,247,240)";    // Eye surround (white face)

export function DogLogo() {
  // All rows are 7 columns wide to stay aligned.
  //
  //  col: 1234567
  //  R1:  ▟▖   ▗▙     ear tips
  //  R2:  ▐█▙▄▟█▌     ears + forehead
  //  R3:  ▝•▄▼▄•▘     eyes + nose
  //  R4:   ▜▄▛        mouth + tongue
  //  R5:   ▝▀▀▀▘      chest fluff
  return (
    <Box flexDirection="column">
      {/* Row 1: Ear tips */}
      <Text>
        <Text color={BLK}>{"▟"}</Text>
        <Text color={PINK}>{"▖"}</Text>
        <Text>{"   "}</Text>
        <Text color={PINK}>{"▗"}</Text>
        <Text color={BLK}>{"▙"}</Text>
      </Text>
      {/* Row 2: Ears + forehead */}
      <Text>
        <Text color={BLK}>{"▐█"}</Text>
        <Text color={BLK}>{"▙"}</Text>
        <Text color={WHT}>{"▄"}</Text>
        <Text color={BLK}>{"▟"}</Text>
        <Text color={BLK}>{"█▌"}</Text>
      </Text>
      {/* Row 3: Eyes + nose (same 7 cols) */}
      <Text>
        <Text color={BLK}>{"▝"}</Text>
        <Text color={EYE} backgroundColor={EYEBG}>{"●"}</Text>
        <Text color={WHT}>{"▄"}</Text>
        <Text color={NOSE}>{"▼"}</Text>
        <Text color={WHT}>{"▄"}</Text>
        <Text color={EYE} backgroundColor={EYEBG}>{"●"}</Text>
        <Text color={BLK}>{"▘"}</Text>
      </Text>
      {/* Row 4: Mouth + tongue (7 cols) */}
      <Text>
        <Text>{"  "}</Text>
        <Text color={WHT}>{"▜"}</Text>
        <Text color={PINK}>{"▄"}</Text>
        <Text color={WHT}>{"▛"}</Text>
        <Text>{"  "}</Text>
      </Text>
      {/* Row 5: Chest fluff (7 cols) */}
      <Text>
        <Text>{" "}</Text>
        <Text color={WHT}>{"▝▀▀▀▘"}</Text>
        <Text>{" "}</Text>
      </Text>
    </Box>
  );
}
