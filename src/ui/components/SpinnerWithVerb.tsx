/**
 * SpinnerWithVerb — animated spinner with random verbs, elapsed time, and token count.
 */
import { useState, useEffect, useRef, type MutableRefObject } from "react";
import { Box, Text } from "../../render/index.js";

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

export function SpinnerWithVerb({
  mode,
  streamingTokensRef,
  runStartRef,
  thinkingContent,
}: SpinnerWithVerbProps) {
  const [tick, setTick] = useState(0);
  const verbRef = useRef(pickRandom(SPINNER_VERBS));
  const lastVerbChangeRef = useRef(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 200);
    return () => clearInterval(timer);
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

  return (
    <Box flexDirection="column" marginLeft={2} marginY={1}>
      <Box>
        <Text color={color}>{frame}</Text>
        <Text>{"  "}{verb}…</Text>
        {elapsed > 0 && <Text dim>{"  "}{elapsed}s</Text>}
        {tokens > 0 && <Text dim>{" · "}{formatTokens(tokens)}</Text>}
      </Box>
      {thinkingContent && (
        <Box marginLeft={4}>
          <Text dim italic>
            {truncateThinking(thinkingContent)}
          </Text>
        </Box>
      )}
    </Box>
  );
}

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
