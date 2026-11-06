import type { StreamEvent } from "../types.js";
import {
  buildNotificationMessage,
  type NotificationResultClaim,
} from "../tool-system/builtin/agent-notifications.js";

export interface BackgroundResultMailbox {
  claimResults(sessionId: string): NotificationResultClaim | undefined;
}

export interface BackgroundContinuationAdmission {
  /** Physical Session/run ownership; never resolve this to a newer owner. */
  isCurrent(): boolean;
  /** User Stop is a Session policy, independent of whether it has a Goal. */
  isStopped(): boolean;
  /** Adapter-specific constraints such as authority, headless mode or Goal pause. */
  isEligible(): boolean;
}

/** Provider activity, as distinct from host journal acceptance or request dispatch. */
function provesProviderAcceptance(event: StreamEvent): boolean {
  if ("agentId" in event && event.agentId !== undefined) return false;
  switch (event.type) {
    case "text_delta":
    case "thinking_delta":
    case "tool_use_start":
    case "tool_use_args_delta":
    case "tool_result":
    case "assistant_message":
      return true;
    case "usage_update":
      return event.promptTokensSource === "provider_usage";
    case "turn_complete":
      return event.reason === "completed";
    default:
      return false;
  }
}

/** One delivery attempt. Its callbacks can settle only its original claim. */
export class BackgroundResultDelivery {
  readonly message: string;
  private accepted = false;
  private finished = false;

  constructor(private readonly claim: NotificationResultClaim) {
    this.message = buildNotificationMessage(claim.results);
  }

  get wasAccepted(): boolean {
    return this.accepted;
  }

  accept(): void {
    if (this.finished || this.accepted) return;
    this.accepted = true;
    this.claim.acknowledge();
  }

  observe(event: StreamEvent): void {
    if (provesProviderAcceptance(event)) this.accept();
  }

  /** Every exit path releases an unaccepted result once, including a refused turn. */
  finish(): number {
    if (this.finished) return 0;
    this.finished = true;
    return this.accepted ? 0 : this.claim.restore();
  }
}

/**
 * Shared admission and delivery policy. Hosts retain their own serialized turn
 * queues and authority resolution; they call claim only inside the chosen slot.
 */
export class BackgroundContinuationController {
  constructor(
    private readonly mailbox: BackgroundResultMailbox,
    private readonly sessionId: string,
    private readonly admission: BackgroundContinuationAdmission,
  ) {}

  canContinue(): boolean {
    return this.admission.isCurrent() && !this.admission.isStopped() && this.admission.isEligible();
  }

  claim(): BackgroundResultDelivery | undefined {
    if (!this.canContinue()) return undefined;
    const claim = this.mailbox.claimResults(this.sessionId);
    if (!claim) return undefined;
    // Mailbox subscribers can synchronously close/Stop the Session on reserve.
    try {
      if (this.canContinue()) return new BackgroundResultDelivery(claim);
    } catch (error) {
      claim.restore();
      throw error;
    }
    claim.restore();
    return undefined;
  }
}
