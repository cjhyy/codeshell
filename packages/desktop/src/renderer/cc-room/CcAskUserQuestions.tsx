import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface CcAskUserQuestion {
  question: string;
  header?: string;
  options: string[];
  multiSelect: boolean;
}

/**
 * One AskUserQuestion control request can carry several questions, but the CLI
 * accepts exactly one response for all of them. Collect an answer for every
 * question (chosen labels, or free text that overrides them) and respond once
 * with `answers` keyed by question text.
 */
export function CcAskUserQuestions({
  questions,
  resolving,
  onAnswer,
  onCancel,
}: {
  questions: CcAskUserQuestion[];
  resolving: boolean;
  onAnswer: (answers: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const [picked, setPicked] = useState<string[][]>(() => questions.map(() => []));
  const [free, setFree] = useState<string[]>(() => questions.map(() => ""));
  const answers = questions.map((_q, index) => free[index]?.trim() || picked[index]!.join(", "));
  const complete = answers.every(Boolean);

  const pick = (index: number, option: string, multiSelect: boolean) =>
    setPicked((all) =>
      all.map((labels, i) =>
        i !== index
          ? labels
          : multiSelect
            ? labels.includes(option)
              ? labels.filter((label) => label !== option)
              : [...labels, option]
            : [option],
      ),
    );

  return (
    <div className="flex flex-col gap-3">
      {questions.map((q, index) => (
        <div key={`${index}:${q.question}`} className="flex flex-col gap-2">
          <p className="text-sm">
            {q.header && <span className="mr-1 text-xs text-muted-foreground">{q.header}</span>}
            {q.question}
          </p>
          <div className="flex flex-wrap gap-2">
            {q.options.map((option) => (
              <Button
                key={option}
                disabled={resolving}
                size="sm"
                variant={picked[index]!.includes(option) ? "default" : "outline"}
                onClick={() => pick(index, option, q.multiSelect)}
              >
                {option}
              </Button>
            ))}
          </div>
          <Input
            value={free[index]}
            disabled={resolving}
            onChange={(e) =>
              setFree((all) => all.map((text, i) => (i === index ? e.target.value : text)))
            }
            placeholder="或输入自定义回答…"
          />
        </div>
      ))}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={resolving || !complete}
          onClick={() =>
            onAnswer(Object.fromEntries(questions.map((q, index) => [q.question, answers[index]!])))
          }
        >
          提交回答
        </Button>
        <Button size="sm" variant="ghost" disabled={resolving} onClick={onCancel}>
          取消
        </Button>
      </div>
    </div>
  );
}
