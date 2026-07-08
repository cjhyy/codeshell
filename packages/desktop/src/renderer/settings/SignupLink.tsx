import React from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n/I18nProvider";

export interface SignupLinkProps {
  url?: string;
}

export function SignupLink({ url }: SignupLinkProps) {
  const { t } = useT();
  if (!url) return null;
  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      className="h-auto shrink-0 gap-1 p-0 text-xs"
      title={url}
      onClick={() => void window.codeshell.openExternal(url)}
    >
      <ExternalLink className="h-3.5 w-3.5" />
      {t("settingsX.searchConn.getKey")}
    </Button>
  );
}
