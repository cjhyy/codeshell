/**
 * 蔡徐坤中分头 icon — 静态 logo
 *
 *   ▄██▄
 *  █▙  ▟█
 *  ▜ ●● ▛
 *   ▜▄▄▛
 *    ▀▀
 */
import { Box, Text } from "../../render/index.js";

const HAIR = "rgb(40,30,25)";
const SKIN = "rgb(240,200,160)";
const EYE  = "rgb(20,20,20)";

export function KunHead() {
  return (
    <Box flexDirection="column">
      {/* Row 1: Hair top — 中分 */}
      <Text>
        <Text>{" "}</Text>
        <Text color={HAIR}>{"▄"}</Text>
        <Text color={HAIR} backgroundColor={SKIN}>{"▙▟"}</Text>
        <Text color={HAIR}>{"▄"}</Text>
      </Text>
      {/* Row 2: Hair sides + forehead */}
      <Text>
        <Text color={HAIR}>{"█▛"}</Text>
        <Text color={SKIN}>{"  "}</Text>
        <Text color={HAIR}>{"▜█"}</Text>
      </Text>
      {/* Row 3: Eyes */}
      <Text>
        <Text color={HAIR}>{"▜"}</Text>
        <Text color={SKIN}>{" "}</Text>
        <Text color={EYE} backgroundColor={SKIN}>{"●●"}</Text>
        <Text color={SKIN}>{" "}</Text>
        <Text color={HAIR}>{"▛"}</Text>
      </Text>
      {/* Row 4: Lower face */}
      <Text>
        <Text>{" "}</Text>
        <Text color={SKIN}>{"▜▄▄▛"}</Text>
      </Text>
      {/* Row 5: Chin */}
      <Text>
        <Text>{"  "}</Text>
        <Text color={SKIN}>{"▀▀"}</Text>
      </Text>
    </Box>
  );
}
