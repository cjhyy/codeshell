import React from "react";
import type {
  AccountFeatureId,
  AccountFeatureSnapshot,
  AccountFeatureView,
} from "../src/account/features.js";

/** Absent for an independent Hub: cloud identity never gates its local capabilities. */
export const AccountFeaturesContext = React.createContext<AccountFeatureSnapshot | null>(null);

export function useOptionalAccountFeature(id: AccountFeatureId): AccountFeatureView | null {
  return React.useContext(AccountFeaturesContext)?.[id] ?? null;
}

export function useAccountFeature(id: AccountFeatureId): AccountFeatureView {
  return useOptionalAccountFeature(id) ?? { id, state: "hidden" };
}

export function accountFeatureMessage(feature: AccountFeatureView): string {
  return feature.state === "sign-in"
    ? "登录后可用"
    : feature.state === "pending"
      ? "账号服务暂时无法连接，请重试。"
      : "";
}

export function AccountFeatureEntry({
  id,
  children,
  onClick,
}: {
  id: AccountFeatureId;
  children: React.ReactNode;
  onClick: () => void;
}) {
  const feature = useAccountFeature(id);
  if (feature.state === "hidden") return null;
  return (
    <button
      className="website-button"
      disabled={feature.state === "pending"}
      title={accountFeatureMessage(feature) || undefined}
      onClick={() => {
        if (feature.state === "ready") onClick();
        else if (feature.state === "sign-in") window.location.assign("/");
      }}
    >
      {children}
      {feature.state === "sign-in" ? " · 登录后可用" : null}
      {feature.state === "pending" ? " · 暂时无法连接" : null}
    </button>
  );
}
