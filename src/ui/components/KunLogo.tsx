/**
 * 蔡徐坤打篮球 ASCII art — "鸡你太美"经典动作
 *
 * 动画流程：运球 → 身体右倾靠肩 → 回正 → 循环
 */
import { useState, useEffect } from "react";
import { Box, Text } from "../../ink/index.js";

const H = "rgb(40,30,25)";        // Hair
const S = "rgb(240,200,160)";     // Skin
const T = "rgb(80,80,180)";       // 背带 strap
const W = "rgb(255,255,255)";     // White shirt
const P = "rgb(80,80,180)";       // Pants
const B = "rgb(255,140,30)";      // Ball
const F = "rgb(255,255,255)";     // Feet

const FRAME_COUNT = 6;
const FRAME_MS = 350;

export function KunLogo() {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % FRAME_COUNT);
    }, FRAME_MS);
    return () => clearInterval(timer);
  }, []);

  switch (frame) {
    case 0: return <F0 />;
    case 1: return <F1 />;
    case 2: return <F2 />;
    case 3: return <F3 />;
    case 4: return <F4 />;
    case 5: return <F5 />;
    default: return <F0 />;
  }
}

/** Frame 0: 站立持球 */
function F0() {
  return (
    <Box flexDirection="column">
      <Text>{"  "}<Text color={H}>{"◓"}</Text>{"    "}</Text>
      <Text>{" "}<Text color={S}>{"╱"}</Text><Text color={W}>{"█"}</Text><Text color={S}>{"╲"}</Text>{"   "}</Text>
      <Text>{" "}<Text color={T}>{"╿"}</Text><Text color={P}>{"█"}</Text><Text color={T}>{"╿"}</Text>{"   "}</Text>
      <Text>{" "}<Text color={P}>{"│"}</Text>{" "}<Text color={P}>{"│"}</Text><Text color={B}>{" ◎"}</Text>{" "}</Text>
      <Text>{" "}<Text color={F}>{"▘"}</Text>{" "}<Text color={F}>{"▘"}</Text>{"   "}</Text>
    </Box>
  );
}

/** Frame 1: 运球下拍 */
function F1() {
  return (
    <Box flexDirection="column">
      <Text>{"  "}<Text color={H}>{"◓"}</Text>{"    "}</Text>
      <Text>{" "}<Text color={S}>{"╱"}</Text><Text color={W}>{"█"}</Text><Text color={S}>{"╲"}</Text>{"   "}</Text>
      <Text>{" "}<Text color={T}>{"╿"}</Text><Text color={P}>{"█"}</Text><Text color={T}>{"╿"}</Text>{"   "}</Text>
      <Text>{" "}<Text color={P}>{"╱"}</Text>{" "}<Text color={P}>{"╲"}</Text>{"   "}</Text>
      <Text><Text color={F}>{"▝"}</Text>{"   "}<Text color={F}>{"▘"}</Text><Text color={B}>{"◎"}</Text>{" "}</Text>
    </Box>
  );
}

/** Frame 2: 球弹回 */
function F2() {
  return (
    <Box flexDirection="column">
      <Text>{"  "}<Text color={H}>{"◓"}</Text>{" "}<Text color={B}>{"◎"}</Text>{"  "}</Text>
      <Text>{" "}<Text color={S}>{"╱"}</Text><Text color={W}>{"█"}</Text><Text color={S}>{"╲"}</Text>{"   "}</Text>
      <Text>{" "}<Text color={T}>{"╿"}</Text><Text color={P}>{"█"}</Text><Text color={T}>{"╿"}</Text>{"   "}</Text>
      <Text>{" "}<Text color={P}>{"╱"}</Text>{" "}<Text color={P}>{"╲"}</Text>{"   "}</Text>
      <Text><Text color={F}>{"▝"}</Text>{"   "}<Text color={F}>{"▘"}</Text>{"  "}</Text>
    </Box>
  );
}

/** Frame 3: 右肩下沉 */
function F3() {
  return (
    <Box flexDirection="column">
      <Text>{"   "}<Text color={H}>{"◓"}</Text><Text color={B}>{"◎"}</Text>{"  "}</Text>
      <Text>{"  "}<Text color={S}>{"╱"}</Text><Text color={W}>{"█"}</Text><Text color={S}>{"─"}</Text>{"  "}</Text>
      <Text>{"  "}<Text color={T}>{"╿"}</Text><Text color={P}>{"█"}</Text><Text color={T}>{"╿"}</Text>{"  "}</Text>
      <Text>{" "}<Text color={P}>{"╱"}</Text>{"  "}<Text color={P}>{"╲"}</Text>{"  "}</Text>
      <Text><Text color={F}>{"▝"}</Text>{"    "}<Text color={F}>{"▘"}</Text>{" "}</Text>
    </Box>
  );
}

/** Frame 4: 经典右靠 pose */
function F4() {
  return (
    <Box flexDirection="column">
      <Text>{"   "}<Text color={B}>{"◎"}</Text><Text color={H}>{"◓"}</Text>{"  "}</Text>
      <Text>{"   "}<Text color={W}>{"█"}</Text><Text color={S}>{"╲"}</Text>{"  "}</Text>
      <Text>{"  "}<Text color={T}>{"╿"}</Text><Text color={P}>{"█"}</Text><Text color={T}>{"╿"}</Text>{"  "}</Text>
      <Text>{" "}<Text color={P}>{"╱"}</Text>{"  "}<Text color={P}>{"╲"}</Text>{"  "}</Text>
      <Text><Text color={F}>{"▝"}</Text>{"    "}<Text color={F}>{"▘"}</Text>{" "}</Text>
    </Box>
  );
}

/** Frame 5: 回正 */
function F5() {
  return (
    <Box flexDirection="column">
      <Text>{"   "}<Text color={H}>{"◓"}</Text>{"   "}</Text>
      <Text>{"  "}<Text color={S}>{"╱"}</Text><Text color={W}>{"█"}</Text><Text color={S}>{"╲"}</Text>{"  "}</Text>
      <Text>{"  "}<Text color={T}>{"╿"}</Text><Text color={P}>{"█"}</Text><Text color={T}>{"╿"}</Text>{"  "}</Text>
      <Text>{" "}<Text color={P}>{"╱"}</Text>{"  "}<Text color={P}>{"╲"}</Text>{"  "}</Text>
      <Text><Text color={F}>{"▝"}</Text>{"    "}<Text color={F}>{"▘"}</Text>{" "}</Text>
    </Box>
  );
}
