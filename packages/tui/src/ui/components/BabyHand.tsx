/**
 * 蔡徐坤说"贝贝" — 双手胸前左右晃，晃完说贝贝，然后贝贝消失
 *
 * Frame 0-1: 双手胸前，身体左晃
 * Frame 2-3: 双手胸前，身体右晃
 * Frame 4-5: 再左晃
 * Frame 6-7: 再右晃
 * Frame 8-11: 回正，嘴巴说"贝贝"（气泡出现）
 * Frame 12+: 气泡消失，静止
 */
import { useState, useEffect } from "react";
import { Box, Text } from "../../render/index.js";

const H = "rgb(40,30,25)";
const S = "rgb(240,200,160)";
const W = "rgb(255,255,255)";
const T = "rgb(80,80,180)";
const P = "rgb(80,80,180)";
const F = "rgb(255,255,255)";
const WORD = "rgb(255,100,120)";

const FRAME_MS = 300;
const TOTAL_FRAMES = 12;

export function BabyHand() {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % TOTAL_FRAMES);
    }, FRAME_MS);
    return () => clearInterval(timer);
  }, []);

  const f = frame;

  // 身体晃动方向
  // 0-1 左, 2-3 右, 4-5 左, 6-7 右, 8+ 正
  const phase =
    f <= 1 ? "left" :
    f <= 3 ? "right" :
    f <= 5 ? "left" :
    f <= 7 ? "right" : "center";

  // 贝贝气泡: frame 8-11 显示
  const showBubble = f >= 8 && f <= 11;

  if (phase === "left") return <PoseLeft showBubble={false} />;
  if (phase === "right") return <PoseRight showBubble={false} />;
  return <PoseCenter showBubble={showBubble} />;
}

function PoseLeft({ showBubble }: { showBubble: boolean }) {
  return (
    <Box flexDirection="column">
      <Text>{" "}<Text color={H}>{"◓"}</Text>{"    "}{showBubble ? <Text color={WORD} bold>{"贝贝"}</Text> : "    "}</Text>
      <Text><Text color={S}>{"╱"}</Text><Text color={W}>{"█"}</Text><Text color={S}>{"╲"}</Text>{"   "}</Text>
      <Text><Text color={S}>{"╱"}</Text><Text color={W}>{"██"}</Text><Text color={S}>{"╲"}</Text>{"  "}</Text>
      <Text>{" "}<Text color={T}>{"╿"}</Text><Text color={P}>{"█"}</Text><Text color={T}>{"╿"}</Text>{"  "}</Text>
      <Text>{" "}<Text color={P}>{"│"}</Text>{" "}<Text color={P}>{"│"}</Text>{"  "}</Text>
    </Box>
  );
}

function PoseRight({ showBubble }: { showBubble: boolean }) {
  return (
    <Box flexDirection="column">
      <Text>{"   "}<Text color={H}>{"◓"}</Text>{"  "}{showBubble ? <Text color={WORD} bold>{"贝贝"}</Text> : "    "}</Text>
      <Text>{"  "}<Text color={S}>{"╱"}</Text><Text color={W}>{"█"}</Text><Text color={S}>{"╲"}</Text>{" "}</Text>
      <Text>{"  "}<Text color={S}>{"╱"}</Text><Text color={W}>{"██"}</Text><Text color={S}>{"╲"}</Text></Text>
      <Text>{"  "}<Text color={T}>{"╿"}</Text><Text color={P}>{"█"}</Text><Text color={T}>{"╿"}</Text>{" "}</Text>
      <Text>{"  "}<Text color={P}>{"│"}</Text>{" "}<Text color={P}>{"│"}</Text>{" "}</Text>
    </Box>
  );
}

function PoseCenter({ showBubble }: { showBubble: boolean }) {
  return (
    <Box flexDirection="column">
      <Text>{"  "}<Text color={H}>{"◓"}</Text>{"   "}{showBubble ? <Text color={WORD} bold>{"贝贝"}</Text> : "    "}</Text>
      <Text>{" "}<Text color={S}>{"╱"}</Text><Text color={W}>{"█"}</Text><Text color={S}>{"╲"}</Text>{"  "}</Text>
      <Text>{" "}<Text color={S}>{"╱"}</Text><Text color={W}>{"██"}</Text><Text color={S}>{"╲"}</Text>{" "}</Text>
      <Text>{" "}<Text color={T}>{"╿"}</Text><Text color={P}>{"█"}</Text><Text color={T}>{"╿"}</Text>{"  "}</Text>
      <Text>{" "}<Text color={P}>{"│"}</Text>{" "}<Text color={P}>{"│"}</Text>{"  "}</Text>
    </Box>
  );
}
