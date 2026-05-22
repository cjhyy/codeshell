/**
 * SpinnerWithVerb — animated spinner with random verbs, elapsed time, and token count.
 */
import { useState, useEffect, useRef, memo, type MutableRefObject } from "react";
import { Box, Text } from "../../render/index.js";
import { logger as uiLogger } from "../../logging/logger.js";
import { stringWidth } from "../../render/stringWidth.js";

function getDefaultCharacters(): string[] {
  if (process.env.TERM === 'xterm-ghostty') {
    return ['·', '✢', '✳', '✶', '✻', '*'];
  }
  return process.platform === 'darwin'
    ? ['·', '✢', '✳', '✶', '✻', '✽']
    : ['·', '✢', '*', '✶', '✻', '✽'];
}

// 卡尔(祈求者)台词 —— 摘自 DOTA2 中文配音
const SPINNER_VERBS = [
  '祈求者!',
  '在那黑色的无知之海上,吾乃闪耀的知识灯塔',
  // ikun
  'music!',
  '哎呦,你干嘛~',
  '小黑子,露出鸡脚了吧',
  // JoJo 的奇妙冒险
  'オラオラオラオラッ!',           // 欧拉欧拉
  'ムダムダムダムダッ!',           // 木大木大
  '黄金の精神',                    // 黄金精神
  'ザ・ワールド!時よ止まれ!',     // The World! 时间停止
  // 龙珠
  'カカロット!',                  // 卡卡罗特
  'か……め……は……め……波ーっ!', // 龟派气功
  // 名侦探柯南
  '真実はいつもひとつ!',           // 真相只有一个
  // Fate
  '無限の剣製(アンリミテッドブレイドワークス)', // 无限剑制
  '問おう、貴方が私のマスターか',  // 我问你,你是我的Master吗
  // 凉宫春日的忧郁
  'ただの人間には興味ありません',  // 对普通人类没兴趣
  'SOS団、結成!',                 // SOS团,成立!
  // 吹响吧!上低音号
  '全国大会、行きたいんです!',     // 我想去全国大赛!
  '久美子、好きだ!',              // 久美子,我喜欢你!
  // 为美好的世界献上祝福!
  'この素晴らしい世界に祝福を!',   // 为美好的世界献上祝福!
  'わたし、めぐみんっ!',          // 我!惠惠!
  'エクスプロージョン!',           // 爆裂魔法!
  'アクシズ教へようこそ!',         // 欢迎来到阿克西斯教!
  // 刀剑神域
  'スターバースト・ストリーム!',   // 星爆气流斩
  'ユイ、パパだよ',                // 结衣,我是爸爸
  // 中二病也要谈恋爱!
  '邪王真眼、解放!',               // 邪王真眼,解放!
  'バニッシュメント・ディス・ワールド!', // Vanishment This World!
  // 齐木楠雄的灾难
  'やれやれ……',                   // 真是的……
  '完全無欠の超能力者',            // 完美无缺的超能力者
  // 某科学的超电磁炮
  'ビリビリ',                      // 滋滋(电击声,炮姐外号)
  '本当の力、見せてあげる',        // 让你见识一下我真正的力量
  // 白色相簿2
  '你怎么这么熟练',       
  // 命运石之门
  'これは、運命石の扉の選択だ',    // 这就是命运石之门的选择
];

const DEFAULT_CHARACTERS = getDefaultCharacters();
const FRAMES = [...DEFAULT_CHARACTERS, ...[...DEFAULT_CHARACTERS].reverse()];

const TOOL_VERBS = [
  "邪王真眼発動!",       // 中二病
  "ザ・ワールド!",       // JoJo The World
  "エクスプロージョン!", // Konosuba 爆裂魔法
  "卍解!",               // 死神
];

export type SpinnerMode = "responding" | "tool-use" | "thinking";

interface SpinnerWithVerbProps {
  mode: SpinnerMode;
  /**
   * Per-turn streamed token count — used purely as a "still alive" signal so
   * the user sees activity. NOT a measure of context size; that's in the
   * StatusLine ctx bar.
   */
  streamingTokensRef?: MutableRefObject<number>;
  runStartRef?: MutableRefObject<number>;
  thinkingContent?: string;
}

function pickRandom(arr: string[]): string {
  return arr[Math.floor(Math.random() * arr.length)];
}

function SpinnerWithVerbImpl({
  mode,
  streamingTokensRef,
  runStartRef,
  thinkingContent,
}: SpinnerWithVerbProps) {
  const [tick, setTick] = useState(0);
  const verbRef = useRef(pickRandom(SPINNER_VERBS));
  const lastVerbChangeRef = useRef(Date.now());

  useEffect(() => {
    uiLogger.info("flicker.spinner_mount", { cat: "flicker", mode });
    const timer = setInterval(() => setTick((t) => t + 1), 200);
    return () => {
      uiLogger.info("flicker.spinner_unmount", { cat: "flicker" });
      clearInterval(timer);
    };
    // Intentionally only on mount/unmount, not on `mode` changes — verb mode
    // can flip per tool call and we want one log line per real lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Change verb every ~8 seconds
  if (Date.now() - lastVerbChangeRef.current > 8000) {
    const verbs = mode === "tool-use" ? TOOL_VERBS : SPINNER_VERBS;
    verbRef.current = pickRandom(verbs);
    lastVerbChangeRef.current = Date.now();
  }

  const frame = FRAMES[tick % FRAMES.length];
  const elapsed = runStartRef
    ? Math.floor((Date.now() - runStartRef.current) / 1000)
    : 0;
  const tokens = streamingTokensRef?.current ?? 0;

  const verb = verbRef.current;
  const color = mode === "thinking" ? "ansi:magenta" : "ansi:cyan";
  const thinkingLine = thinkingContent ? truncateThinking(thinkingContent) : "";

  // Single-row layout — mirrors Claude Code's SpinnerAnimationRow
  // (claude-code-sourcemap/.../Spinner/SpinnerAnimationRow.tsx:226).
  // Earlier column layouts toggled the outer Box's height between
  // 1 row and 2 rows when thinkingContent appeared/disappeared, which
  // Yoga sees as a layout shift and Ink amplifies into a 100%-writes
  // storm visible as ~700 ms freezes on `isRunning` flips. Folding
  // everything into one row + flexWrap lets the thinking text grow
  // and shrink in-place without ever changing the spinner's height.
  //
  // Format: `<frame>  <verb>…  <elapsed>s · <tokens>  · <thinking>`
  // Thinking is appended at the tail so a long line wraps gracefully
  // (flexWrap puts the overflow on the next visual row, but the Box's
  // declared height is still 1; subsequent rows are flex-wrapped
  // continuations of the same logical line, not new children).
  let spinnerLine = `${frame}  ${verb}…`;
  if (elapsed > 0) spinnerLine += `  ${elapsed}s`;
  if (tokens > 0) spinnerLine += ` · ${formatTokens(tokens)}`;
  if (thinkingContent !== undefined && thinkingLine) {
    spinnerLine += `  · ${thinkingLine}`;
  }

  // FLICKER FIX: pad to SPINNER_FIXED_WIDTH so the string's terminal
  // width is constant across ticks. Without this, varying-width fields
  // (elapsed 9s→10s; verb 8s rotation; thinking tail churn at 50ms
  // intervals during thinking-mode) change the Text node's measured
  // width every frame, Yoga reports a layout shift, didLayoutShift()
  // flips on, and render-node-to-output forces a full-screen damage
  // backstop. That backstop manifests as `blit=0 write=1500+` every
  // 200ms — visible to the user as a uniform high-frequency flicker
  // during long LLM thinking pauses.
  //
  // We compute *terminal* width via stringWidth (CJK = 2, control = 0)
  // rather than .length, since the verb table includes CJK strings.
  // Truncate if over budget so width stays exactly fixed; pad with
  // trailing spaces if under.
  spinnerLine = fitToFixedWidth(spinnerLine, SPINNER_FIXED_WIDTH);

  // height=1 + overflow=hidden lock the Box's measured height to a single
  // row regardless of terminal width. Without this, narrow terminals (<80
  // columns) would wrap the fixed-width spinnerLine onto a second row, and
  // every wrap-toggle would itself be a layout shift — defeating the
  // padding fix above. Long spinner content is simply clipped at the
  // viewport edge, which is fine: every relevant field (elapsed, verb,
  // truncated thinking) sits at the start of the string anyway.
  return (
    <Box marginLeft={2} marginY={1} width="100%" height={1} overflow="hidden">
      <Text color={color}>{spinnerLine}</Text>
    </Box>
  );
}

/**
 * Pad-or-truncate `s` so its terminal display width equals exactly `target`.
 * Padding is added as trailing spaces (width 1 each). Truncation is
 * codepoint-by-codepoint from the tail until width fits — slow but the
 * input is at most ~80 chars and runs at most once per 200ms frame.
 */
function fitToFixedWidth(s: string, target: number): string {
  const w = stringWidth(s);
  if (w === target) return s;
  if (w < target) return s + " ".repeat(target - w);
  // Over budget — trim from the end. Use Array.from to split on grapheme
  // boundaries (single CJK codepoint != single JS string index).
  const chars = Array.from(s);
  let acc = "";
  let accW = 0;
  for (const c of chars) {
    const cw = stringWidth(c);
    if (accW + cw > target) break;
    acc += c;
    accW += cw;
  }
  // Pad any small gap (e.g. dropped a width-2 char with 1 column left over)
  if (accW < target) acc += " ".repeat(target - accW);
  return acc;
}

/**
 * Width budget for the spinner subtree. Wide enough for the longest verb
 * (~40 columns in CJK) plus `  120s · 99.9K tokens` suffix (~22 columns)
 * with margin. If a future verb exceeds this, it will be clipped — that's
 * better than flicker, and the truncation will be visible enough to
 * prompt shortening the verb table.
 */
const SPINNER_FIXED_WIDTH = 80;

/**
 * Memo so App-level re-renders (chatStore subscribe firing on every
 * text_delta flush, StatusLine 1s tick, etc.) do not redundantly re-commit
 * the spinner subtree. The component owns its own 200ms tick internally;
 * everything visible from outside is in props.
 *
 * Comparator:
 *   mode               — string literal, compare by value.
 *   streamingTokensRef — mutable ref (live token counter); React identity
 *                        is stable, but the live value changes constantly.
 *                        We DON'T want to re-render for token-counter
 *                        ticks (the spinner's own setInterval picks them
 *                        up on the next 200ms frame). Ignore.
 *   runStartRef        — same shape; reference-stable. Ignore.
 *   thinkingContent    — changes ~every 50ms during thinking. We DO want
 *                        the thinking line to update, but only when the
 *                        truncated tail (last ~80 chars) actually changes.
 *                        Compare truncated form to avoid re-renders that
 *                        produce identical output.
 */
function spinnerPropsEqual(
  prev: SpinnerWithVerbProps,
  next: SpinnerWithVerbProps,
): boolean {
  if (prev.mode !== next.mode) return false;
  const prevLine = prev.thinkingContent ? truncateThinking(prev.thinkingContent) : "";
  const nextLine = next.thinkingContent ? truncateThinking(next.thinkingContent) : "";
  if (prevLine !== nextLine) return false;
  // Refs themselves are stable; ignoring their live values is the whole point.
  return true;
}

export const SpinnerWithVerb = memo(SpinnerWithVerbImpl, spinnerPropsEqual);

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M tokens";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K tokens";
  return `${n} tokens`;
}

function truncateThinking(text: string): string {
  // Show last ~80 chars of thinking content
  const clean = text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  if (clean.length > 80) return "…" + clean.slice(-79);
  return clean;
}
