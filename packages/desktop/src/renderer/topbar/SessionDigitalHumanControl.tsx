import React, { useEffect, useState } from "react";
import { MoreHorizontal, UserRound } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { useT } from "../i18n";
import { IconButton } from "../ui/IconButton";

export interface SessionDigitalHumanProfile {
  name: string;
  label: string;
  description?: string;
}

interface Props {
  sessionId?: string | null;
  profile?: string | null;
  profiles: ReadonlyArray<SessionDigitalHumanProfile>;
  disabled?: boolean;
  onProfileChange?: (name: string) => void;
}

/** The library is an action source; only a Session binding earns an identity badge. */
export function SessionDigitalHumanControl({
  sessionId,
  profile,
  profiles,
  disabled = false,
  onProfileChange,
}: Props) {
  const { t } = useT();
  const [openForSession, setOpenForSession] = useState<string | null>(null);
  useEffect(() => setOpenForSession(null), [sessionId, profile]);
  const current = profiles.find((candidate) => candidate.name === profile);
  const label = current?.label ?? profile;

  if (!sessionId || (!profile && (!onProfileChange || profiles.length === 0))) return null;

  return (
    <DropdownMenu
      open={openForSession === sessionId}
      onOpenChange={(open) => setOpenForSession(open ? sessionId : null)}
    >
      <DropdownMenuTrigger asChild>
        {profile ? (
          <button
            type="button"
            data-session-profile="true"
            aria-label={t("digitalHumans.sessionBinding.view", { name: label ?? profile })}
            className="flex min-w-0 max-w-40 items-center gap-1 rounded-full border border-primary/15 bg-primary/5 px-2 py-1 text-[11px] text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <UserRound size={11} className="shrink-0" aria-hidden="true" />
            <span className="truncate">{label}</span>
          </button>
        ) : (
          <IconButton
            label={t("digitalHumans.sessionBinding.actions")}
            data-session-actions="true"
            disabled={disabled}
          >
            <MoreHorizontal size={14} />
          </IconButton>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={profile ? "start" : "end"}
        className="w-64"
        aria-label={t("digitalHumans.sessionBinding.actions")}
      >
        {profile && (
          <>
            <DropdownMenuLabel>{t("digitalHumans.sessionBinding.current")}</DropdownMenuLabel>
            <div className="space-y-1 px-2 pb-2">
              <p className="text-sm font-medium text-foreground">{label}</p>
              <p className="text-xs text-muted-foreground">
                {current?.description ||
                  (!current ? t("digitalHumans.sessionBinding.unavailable") : null)}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("digitalHumans.sessionBinding.changeHint")}
              </p>
            </div>
            <DropdownMenuSeparator />
          </>
        )}
        {onProfileChange && profiles.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={disabled}>
              <UserRound size={14} aria-hidden="true" />
              {t(
                profile
                  ? "digitalHumans.sessionBinding.change"
                  : "digitalHumans.sessionBinding.use",
              )}
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent aria-label={t("digitalHumans.sessionBinding.pick")}>
                <DropdownMenuRadioGroup
                  value={profile ?? ""}
                  onValueChange={(name) => {
                    if (!disabled && name !== profile) onProfileChange(name);
                  }}
                >
                  {profiles.map((candidate) => (
                    <DropdownMenuRadioItem
                      key={candidate.name}
                      value={candidate.name}
                      disabled={disabled}
                    >
                      {candidate.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
        )}
        {profile && onProfileChange && (
          <DropdownMenuItem
            disabled={disabled}
            onSelect={() => {
              if (!disabled) onProfileChange("");
            }}
          >
            <div>
              <p>{t("digitalHumans.sessionBinding.followDefault")}</p>
              <p className="text-xs text-muted-foreground">
                {t("digitalHumans.sessionBinding.clearHint")}
              </p>
            </div>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
