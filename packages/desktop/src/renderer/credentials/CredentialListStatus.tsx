import { Button } from "@/components/ui/button";
import { useT } from "../i18n/I18nProvider";

export function CredentialListStatus({
  loading,
  error,
  onRetry,
}: {
  loading: boolean;
  error: string;
  onRetry: () => void;
}) {
  const { t } = useT();
  if (error) {
    return (
      <div className="min-w-0 space-y-3 rounded-xl border border-border/70 bg-muted/15 p-4">
        <p role="alert" className="text-sm text-status-err [overflow-wrap:anywhere]">
          {t("ext.common.loadFailed", { error })}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading}
          aria-busy={loading}
          onClick={onRetry}
        >
          {t("ext.common.retry")}
        </Button>
      </div>
    );
  }
  return loading ? (
    <p role="status" className="text-sm text-muted-foreground">
      {t("ext.common.loading")}
    </p>
  ) : null;
}
