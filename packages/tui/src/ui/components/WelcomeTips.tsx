import { existsSync } from "node:fs";
import { join } from "node:path";
import { Box, Text } from "../../render/index.js";

interface WelcomeTipsProps {
  cwd: string;
}

interface Tip {
  done: boolean;
  text: string;
}

function detectProjectDoc(cwd: string): string | null {
  for (const name of ["CODESHELL.md", "AGENTS.md", "CLAUDE.md"]) {
    if (existsSync(join(cwd, name))) return name;
  }
  return null;
}

function buildTips(cwd: string): Tip[] {
  const found = detectProjectDoc(cwd);
  return [
    {
      done: found !== null,
      text: found
        ? `${found} 已存在 — 项目说明会自动加载`
        : "运行 /init 生成 CODESHELL.md，告诉模型如何理解本项目",
    },
    { done: false, text: "让模型帮你分析、编辑文件，或执行 bash / git 命令" },
    { done: false, text: "像跟同事沟通一样写清楚需求，越具体效果越好" },
    { done: false, text: "随时输入 /status 查看当前模型、用量、配置" },
  ];
}

export function WelcomeTips({ cwd }: WelcomeTipsProps) {
  const tips = buildTips(cwd);

  return (
    <Box flexDirection="column" marginBottom={1} paddingX={1}>
      <Box>
        <Text color="ansi:cyan" bold>{"✻ 欢迎使用 Code Shell"}</Text>
      </Box>
      <Box marginTop={0}>
        <Text dim>{"  /help 查看帮助 · /status 查看当前配置"}</Text>
      </Box>

      <Box marginTop={1}>
        <Text dim>{"─".repeat(60)}</Text>
      </Box>
      <Box marginTop={1}>
        <Text bold>{" 上手提示："}</Text>
      </Box>
      {tips.map((tip, i) => (
        <Box key={i}>
          <Text>{" "}</Text>
          {tip.done ? (
            <Text color="ansi:green">{"✔ "}</Text>
          ) : (
            <Text dim>{`${i + 1}. `}</Text>
          )}
          <Text dim={tip.done}>{tip.text}</Text>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text dim>{"─".repeat(60)}</Text>
      </Box>
    </Box>
  );
}
