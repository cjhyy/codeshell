import type { StreamEvent } from "../types.js";
import type { ChatSession, TurnOpts } from "./chat-session.js";

interface AsyncUserAnswerOptions {
  session: ChatSession;
  requestId: string;
  question: string;
  answer: string;
  continuation: TurnOpts;
  /** Identity of the turn that asked the question, not whichever turn is now active. */
  requestingRun: Promise<void>;
  isCurrent(): boolean;
  resolveWorkspace(): Promise<Pick<TurnOpts, "cwd" | "workspaceContext">>;
  onStream(event: StreamEvent): void;
  onBoundary(status: "start" | "end" | "error"): void;
  onError(error: unknown): void;
}

/** Resolve at admission, then monitor delivery without holding the user's ACK. */
export async function deliverAsyncUserAnswer({
  session,
  requestId,
  question,
  answer,
  continuation,
  requestingRun,
  isCurrent,
  resolveWorkspace,
  onStream,
  onBoundary,
  onError,
}: AsyncUserAnswerOptions): Promise<void> {
  const text = `Answer to your earlier question:\n${question}\n\nUser answer:\n${answer}`;
  const clientMessageId = `ask-user-${requestId}`;
  const requireCurrent = () => {
    if (!isCurrent()) throw new Error("Question session is no longer active");
  };
  const queueFollowUp = async () => {
    for (;;) {
      requireCurrent();
      const owner = session.engine;
      const boundary = session.settled;
      const workspace = await resolveWorkspace();
      // Revalidate authority after workspace lookup yields. A different active
      // run may own the Engine now; the follow-up retains its own turn options.
      requireCurrent();
      if (session.engine !== owner || session.settled !== boundary) continue;
      onBoundary("start");
      const run = session.enqueueTurn(text, {
        ...continuation,
        ...workspace,
        clientMessageId,
        displayText: text,
        onStream,
      });
      void run.then(
        () => onBoundary("end"),
        (error) => {
          onBoundary("error");
          onError(error);
        },
      );
      return;
    }
  };

  requireCurrent();
  const engine = session.engine;
  if (session.settled === requestingRun) {
    const steered = engine.enqueueSteer(session.id, text, requestId, clientMessageId);
    if (steered.accepted) {
      // Acceptance is the ACK boundary. At run completion, reclaim only our
      // unconsumed entry and queue it with the original turn's authority.
      void requestingRun
        .then(async () => {
          if (!engine.unsteer(session.id, requestId) || !isCurrent()) return;
          await queueFollowUp();
        })
        .catch(onError);
      return;
    }
  }
  await queueFollowUp();
}
