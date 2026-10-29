import React from "react";
import { OutputHistoryRecovery, translate } from "@cjhyy/code-shell-web";
import { useT } from "../i18n/I18nProvider";
import { Button } from "../components/ui/button";
import type { RecoveryHeldInput } from "./useRunController";

/** Native adapter: the Host owns validation; held inputs require a separate user action. */
export function NativeOutputHistoryRecovery(props: {
  sessionId: string | null;
  identity: string;
  failed: boolean;
  historicalGap: boolean;
  disabled: boolean;
  pending: boolean;
  heldInputs: RecoveryHeldInput[];
  beforeApply(): void;
  onApplied(): void;
  onReload(): void;
  onConfirmHeld(): void;
}) {
  const { lang, t } = useT();
  const { sessionId } = props;
  const plan = window.codeshell.getSessionOutputRecoveryPlan;
  const apply = window.codeshell.applySessionOutputRecovery;
  return (
    <div className="shrink-0 px-4" data-native-output-recovery>
      {sessionId && plan && apply && (
        <OutputHistoryRecovery
          {...props}
          sessionId={sessionId}
          plan={plan}
          apply={apply}
          t={(key, params) => translate(lang, key, params)}
        />
      )}
      {props.pending && (
        <Button size="sm" variant="ghost" disabled={props.disabled} onClick={props.onReload}>
          {t("chat.retryHistory")}
        </Button>
      )}
      {props.heldInputs.length > 0 && (
        <div className="my-2 rounded-md border p-3 text-sm" role="status">
          <p>{t("chat.recoveryHeld")}</p>
          <ul className="my-2 max-h-40 overflow-auto whitespace-pre-wrap break-words">
            {props.heldInputs.map((item) => (
              <li key={item.clientMessageId}>
                {item.displayText ?? item.text}
                {item.manualReviewOnly && (
                  <p className="text-xs text-muted-foreground">{t("chat.recoveryCachedDraft")}</p>
                )}
                {item.cachedAttachments?.map((attachment) => (
                  <p className="text-xs" key={attachment.absPath}>
                    {attachment.originalName ?? attachment.path}: {attachment.absPath}
                  </p>
                ))}
                {(item.attachments?.length ?? 0) > 0 && (
                  <span>
                    {" "}
                    ({t("chat.recoveryAttachments", { count: item.attachments!.length })})
                  </span>
                )}
              </li>
            ))}
          </ul>
          <Button
            size="sm"
            variant="outline"
            disabled={
              props.pending ||
              props.failed ||
              props.disabled ||
              !props.heldInputs.some((item) => !item.manualReviewOnly)
            }
            onClick={props.onConfirmHeld}
          >
            {t("chat.recoveryResend")}
          </Button>
        </div>
      )}
    </div>
  );
}
