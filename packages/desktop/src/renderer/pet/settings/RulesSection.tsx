import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useT } from "../../i18n";
import { useOptionalConfirm } from "../../ui/DialogProvider";
import type { ConfirmDialogOptions } from "../../ui/dialogState";
import type { PetApi } from "../../../preload/pet-api";
import type {
  PetNoticeRuleAction,
  PetNoticeRuleSummary,
  PetProactiveStatus,
} from "../../../shared/pet-notices";
import {
  heartbeatUsage,
  ruleCronTitle,
  ruleGroup,
  ruleLast,
  ruleNext,
  ruleTarget,
  ruleTitle,
  ruleWhen,
  type RuleGroup,
} from "./noticeRuleText";
import { defaultNoticesApi, usePetNoticesState, type NoticesReadApi } from "./usePetNoticesState";

export type RulesApi = NoticesReadApi & Pick<PetApi, "updateNoticeRule">;

const SOURCE_VARIANT: Record<PetNoticeRuleSummary["source"], "accent" | "info" | "secondary"> = {
  owner: "accent",
  "follow-up": "accent",
  delegation: "info",
  watch: "info",
  system: "secondary",
};

function stateVariant(state: PetNoticeRuleSummary["state"]): "success" | "warning" | "secondary" {
  if (state === "active") return "success";
  return state === "paused" ? "warning" : "secondary";
}

function RuleRow({
  rule,
  proactive,
  pending,
  onAction,
  onOpenSession,
}: {
  rule: PetNoticeRuleSummary;
  proactive?: PetProactiveStatus;
  pending: boolean;
  onAction: (rule: PetNoticeRuleSummary, action: PetNoticeRuleAction) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const { t, lang } = useT();
  const title = ruleTitle(rule, t);
  const next = ruleNext(rule, t, lang);
  const last = ruleLast(rule, t, lang);
  const usage =
    rule.kind === "system-heartbeat"
      ? heartbeatUsage(proactive, t, "mimiSettings.rules.heartbeatUsage")
      : undefined;
  return (
    <li
      data-pet-rule={rule.id}
      data-rule-kind={rule.kind}
      data-state={rule.state}
      className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-xl border border-border/70 px-4 py-3"
    >
      {/* At least ~16rem of text before the actions sit beside it; narrower, they wrap below. */}
      <div className="min-w-0 flex-1 basis-64 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 text-sm font-medium [overflow-wrap:anywhere]">{title}</span>
          <Badge variant={SOURCE_VARIANT[rule.source]} data-rule-source={rule.source}>
            {t(`mimiSettings.rules.source.${rule.source}`)}
          </Badge>
          {rule.state !== "active" && (
            <Badge variant={stateVariant(rule.state)}>
              {t(`mimiSettings.rules.state.${rule.state}`)}
            </Badge>
          )}
        </div>
        <p
          className="text-xs text-muted-foreground [overflow-wrap:anywhere]"
          data-rule-when
          title={ruleCronTitle(rule, t)}
        >
          {ruleWhen(rule, t, lang)}
          {next && (
            <span className="text-foreground/80" data-rule-next>
              {t("mimiSettings.rules.eventSeparator")}
              {next}
            </span>
          )}
        </p>
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]" data-rule-target>
          {ruleTarget(rule, t)}
        </p>
        {usage && (
          <p className="text-xs text-muted-foreground" data-rule-usage>
            {usage}
          </p>
        )}
        {last && (
          <p className="text-xs text-muted-foreground" data-rule-last>
            {last}
          </p>
        )}
      </div>
      {(rule.actions.length > 0 || (rule.sessionId && onOpenSession)) && (
        <div className="flex flex-wrap items-center gap-2">
          {rule.sessionId && onOpenSession && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-rule-open-session
              aria-label={t("mimiSettings.rules.action.openSessionAria", {
                title: rule.sessionTitle ?? title,
              })}
              onClick={() => onOpenSession(rule.sessionId!)}
            >
              {t("mimiSettings.rules.action.openSession")}
            </Button>
          )}
          {rule.actions.map((action) => (
            <Button
              key={action}
              type="button"
              variant={action === "cancel" ? "destructive" : "outline"}
              size="sm"
              disabled={pending}
              data-rule-action={action}
              aria-label={t(`mimiSettings.rules.action.${action}Aria`, { title })}
              onClick={() => onAction(rule, action)}
            >
              {t(`mimiSettings.rules.action.${action}`)}
            </Button>
          ))}
        </div>
      )}
    </li>
  );
}

function RuleList({
  labelledBy,
  rules,
  ...row
}: {
  labelledBy: string;
  rules: PetNoticeRuleSummary[];
  proactive?: PetProactiveStatus;
  pendingId: string | null;
  onAction: (rule: PetNoticeRuleSummary, action: PetNoticeRuleAction) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  return (
    <ul className="grid gap-2" aria-labelledby={labelledBy}>
      {rules.map((rule) => (
        <RuleRow
          key={rule.id}
          rule={rule}
          proactive={row.proactive}
          pending={row.pendingId === rule.id}
          onAction={row.onAction}
          onOpenSession={row.onOpenSession}
        />
      ))}
    </ul>
  );
}

function GroupHeading({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h3 id={id} className="text-sm font-medium text-foreground">
      {children}
    </h3>
  );
}

/**
 * 规则与跟进: the one place to see and manage every trigger that can fire.
 * Rows come from main's structured summaries; pause / resume / delete go back
 * with the version the owner saw. Rules are made by Mimi from the owner's
 * words, so the empty state points there too.
 */
export function RulesSection({
  onOpenNotifications,
  onOpenSession,
  api,
  confirm,
}: {
  onOpenNotifications: () => void;
  /** Jump to a rule's Session (the same navigation the follow-up list uses). */
  onOpenSession?: (sessionId: string) => void;
  api?: RulesApi;
  /** Injected in tests; the app's confirm dialog otherwise. */
  confirm?: (options: ConfirmDialogOptions) => Promise<boolean>;
}) {
  const { t } = useT();
  const appConfirm = useOptionalConfirm();
  const ask = confirm ?? appConfirm;
  const [rulesApi] = useState<RulesApi | undefined>(() => api ?? defaultNoticesApi());
  const notices = usePetNoticesState(api ?? rulesApi);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [endedOpen, setEndedOpen] = useState(false);
  const ids = useId();
  const rules = notices.state?.rules ?? [];
  const groups: Record<RuleGroup, PetNoticeRuleSummary[]> = {
    sessions: [],
    followUps: [],
    proactive: [],
    ended: [],
  };
  for (const rule of rules) groups[ruleGroup(rule)].push(rule);

  const act = async (rule: PetNoticeRuleSummary, action: PetNoticeRuleAction) => {
    if (!rulesApi?.updateNoticeRule || pendingId) return;
    const title = ruleTitle(rule, t);
    if (action === "cancel") {
      const ok = await ask({
        title: t("mimiSettings.rules.confirmCancel.title"),
        message: t("mimiSettings.rules.confirmCancel.message", { title }),
        confirmLabel: t("mimiSettings.rules.confirmCancel.confirm"),
        destructive: true,
      });
      if (!ok) return;
    }
    setPendingId(rule.id);
    setMessage(null);
    try {
      const result = await rulesApi.updateNoticeRule({
        ruleId: rule.id,
        expectedVersion: rule.version,
        action,
      });
      if (!result.ok)
        setMessage({
          tone: "info",
          text: t(
            result.reason === "version_conflict"
              ? "mimiSettings.rules.conflict"
              : result.reason === "not_found"
                ? "mimiSettings.rules.notFound"
                : "mimiSettings.rules.notAllowed",
          ),
        });
    } catch (cause) {
      setMessage({
        tone: "error",
        text: t("mimiSettings.rules.actionFailed", {
          error: cause instanceof Error ? cause.message : String(cause),
        }),
      });
    } finally {
      setPendingId(null);
      notices.reload();
    }
  };

  const rowProps = {
    proactive: notices.state?.proactive,
    pendingId,
    onAction: (rule: PetNoticeRuleSummary, action: PetNoticeRuleAction) => void act(rule, action),
    onOpenSession,
  };

  return (
    <Card data-pet-setting="rules" className="rounded-2xl">
      <CardContent className="grid gap-5 p-6 max-[480px]:p-4">
        {notices.loadState === "loading" ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t("ext.common.loading")}
          </p>
        ) : !notices.state ? (
          <div className="grid gap-2">
            <p role="alert" className="text-sm text-status-err [overflow-wrap:anywhere]">
              {t("ext.common.loadFailed", { error: notices.loadError })}
            </p>
            <Button type="button" className="justify-self-start" onClick={notices.reload}>
              {t("ext.common.retry")}
            </Button>
          </div>
        ) : (
          <div
            role="region"
            className="grid min-w-0 gap-5"
            aria-label={t("mimiSettings.rules.listLabel")}
          >
            {message && (
              <p
                role={message.tone === "error" ? "alert" : "status"}
                data-rules-message={message.tone}
                className={cn(
                  "text-sm [overflow-wrap:anywhere]",
                  message.tone === "error" ? "text-status-err" : "text-muted-foreground",
                )}
              >
                {message.text}
              </p>
            )}
            {groups.sessions.length === 0 && groups.followUps.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-rules-empty>
                {t("mimiSettings.rules.empty")}
              </p>
            ) : (
              <>
                {groups.sessions.length > 0 && (
                  <section className="grid gap-2" data-rules-group="sessions">
                    <GroupHeading id={`${ids}-sessions`}>
                      {t("mimiSettings.rules.groupSessions")}
                    </GroupHeading>
                    <RuleList
                      labelledBy={`${ids}-sessions`}
                      rules={groups.sessions}
                      {...rowProps}
                    />
                  </section>
                )}
                {groups.followUps.length > 0 && (
                  <section className="grid gap-2" data-rules-group="followUps">
                    <GroupHeading id={`${ids}-follow-ups`}>
                      {t("mimiSettings.rules.groupFollowUps")}
                    </GroupHeading>
                    <RuleList
                      labelledBy={`${ids}-follow-ups`}
                      rules={groups.followUps}
                      {...rowProps}
                    />
                  </section>
                )}
              </>
            )}
            {groups.proactive.length > 0 && (
              <section className="grid gap-2" data-rules-group="proactive">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <GroupHeading id={`${ids}-proactive`}>
                    {t("mimiSettings.rules.groupProactive")}
                  </GroupHeading>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-pet-rules-open-notifications
                    onClick={onOpenNotifications}
                  >
                    {t("mimiSettings.rules.openNotifications")}
                  </Button>
                </div>
                <RuleList labelledBy={`${ids}-proactive`} rules={groups.proactive} {...rowProps} />
              </section>
            )}
            {groups.ended.length > 0 && (
              <section className="grid gap-2" data-rules-group="ended">
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto justify-between rounded-xl px-0 py-1 text-left font-medium"
                  aria-expanded={endedOpen}
                  id={`${ids}-ended-toggle`}
                  aria-controls={endedOpen ? `${ids}-ended` : undefined}
                  data-rules-ended-toggle
                  onClick={() => setEndedOpen((open) => !open)}
                >
                  <span className="text-sm">
                    {t("mimiSettings.rules.groupEnded", { count: groups.ended.length })}
                  </span>
                  <ChevronDown
                    className={cn(
                      "size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
                      endedOpen && "rotate-180",
                    )}
                    aria-hidden
                  />
                </Button>
                {endedOpen && (
                  <div id={`${ids}-ended`}>
                    <RuleList
                      labelledBy={`${ids}-ended-toggle`}
                      rules={groups.ended}
                      {...rowProps}
                    />
                  </div>
                )}
              </section>
            )}
          </div>
        )}
        <div className="grid gap-1 text-xs leading-5 text-muted-foreground">
          <p data-rules-talk-hint>{t("mimiSettings.rules.talkHint")}</p>
          <p>{t("mimiSettings.rules.sessionNote")}</p>
        </div>
      </CardContent>
    </Card>
  );
}
