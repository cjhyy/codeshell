export interface RunAfterModelSwitchArgs<RunResult> {
  sessionId: string;
  model: string | null | undefined;
  text: string;
  opts: Record<string, unknown>;
  configure: (params: { sessionId: string; model: string }) => Promise<unknown>;
  run: (text: string, opts: Record<string, unknown>) => Promise<RunResult>;
}

export async function runAfterModelSwitch<RunResult>({
  sessionId,
  model,
  text,
  opts,
  configure,
  run,
}: RunAfterModelSwitchArgs<RunResult>): Promise<RunResult> {
  if (model) {
    await configure({ sessionId, model });
  }
  return run(text, opts);
}
