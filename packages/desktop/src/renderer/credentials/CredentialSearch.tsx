import React from "react";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "../i18n/I18nProvider";
import type { MaskedCredentialView } from "./types";

/** Search visible metadata only; masked hints and secret values are excluded. */
export function credentialMatchesQuery(credential: MaskedCredentialView, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const metadata = [
    credential.label,
    credential.id,
    credential.exposeAsEnv,
    credential.meta?.platform,
    credential.meta?.domain,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return terms.every((term) => metadata.includes(term));
}

export function CredentialSearch({
  query,
  onChange,
  onClear,
  inputRef,
  placeholder,
  count,
  total,
}: {
  query: string;
  onChange: (query: string) => void;
  onClear: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  placeholder: string;
  count: number;
  total: number;
}) {
  const { t } = useT();
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-border/70 bg-card p-2.5 sm:flex-row sm:items-center sm:gap-4">
      <div className="relative min-w-0 flex-1" role="search">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          ref={inputRef}
          type="search"
          value={query}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(event) => onChange(event.target.value)}
          className="h-9 border-transparent bg-muted/50 pl-9 pr-9 focus-visible:bg-background [&::-webkit-search-cancel-button]:appearance-none"
        />
        {query && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-0.5 top-0.5 size-8 rounded-lg text-muted-foreground"
            aria-label={t("ext.credentials.clearSearch")}
            onClick={onClear}
          >
            <X className="size-3.5" aria-hidden />
          </Button>
        )}
      </div>
      <span className="shrink-0 px-1 text-xs tabular-nums text-muted-foreground" role="status">
        {t("ext.credentials.searchResults", { count, total })}
      </span>
    </div>
  );
}

export function CredentialNoMatches({ onClear }: { onClear: () => void }) {
  const { t } = useT();
  return (
    <div className="rounded-2xl border border-dashed border-border bg-muted/15 px-5 py-9 text-center">
      <Search className="mx-auto size-6 text-muted-foreground" aria-hidden />
      <p className="mt-3 text-sm font-medium">{t("ext.credentials.noMatches")}</p>
      <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-muted-foreground">
        {t("ext.credentials.noMatchesHint")}
      </p>
      <Button type="button" variant="outline" size="sm" className="mt-4" onClick={onClear}>
        {t("ext.credentials.clearSearch")}
      </Button>
    </div>
  );
}
