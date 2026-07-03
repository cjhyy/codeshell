export interface RunAfterModelSwitchArgs<RunResult> {
  sessionId: string;
  model: string | null | undefined;
  text: string;
  opts: Record<string, unknown>;
  run: (text: string, opts: Record<string, unknown>) => Promise<RunResult>;
}

export async function runAfterModelSwitch<RunResult>({
  model,
  text,
  opts,
  run,
}: RunAfterModelSwitchArgs<RunResult>): Promise<RunResult> {
  return run(text, model ? { ...opts, model } : opts);
}
