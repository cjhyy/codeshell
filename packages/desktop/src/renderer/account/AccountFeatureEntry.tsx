import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { AccountFeatureView } from "../../shared/account-features.js";
import { useT } from "../i18n";
import { openAccountSettings } from "./useAccountFeature";

/** Keep unavailable actions consistent without disabling their separate setup controls. */
export function AccountFeatureEntry({
  feature,
  label,
  children,
  onSignIn = openAccountSettings,
  className,
}: {
  feature: AccountFeatureView;
  label: string;
  children: ReactNode;
  onSignIn?: () => void;
  className?: string;
}) {
  const { t } = useT();
  if (feature.state === "hidden") return null;
  if (feature.state === "ready") return <>{children}</>;
  const detail =
    feature.state === "sign-in"
      ? t("accountFeatures.signIn")
      : t(`accountFeatures.${feature.reason ?? "pending"}`);
  return (
    <Button
      type="button"
      variant="outline"
      className={["h-auto max-w-full flex-wrap whitespace-normal text-left", className]
        .filter(Boolean)
        .join(" ")}
      data-account-feature={feature.id}
      data-account-feature-state={feature.state}
      aria-label={label}
      title={detail}
      disabled={feature.state === "pending"}
      onClick={() => {
        if (feature.state === "sign-in") onSignIn();
      }}
    >
      <span>{label}</span>
      <span className="text-xs font-normal">{detail}</span>
    </Button>
  );
}
