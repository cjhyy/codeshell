import React from "react";
import QRCode from "qrcode";
import type { LinkAuthorization, LinkAuthorizationResponse } from "@cjhyy/code-shell-link";
import { getLinkAuthorizationStep, safeLinkAuthorizationUrl } from "./link-authorization.js";

export interface LinkAuthorizationLabels {
  openPage: string;
  waitingBrowser: string;
  deviceInstruction: string;
  copy: string;
  submit: string;
  verifyCode: string;
  secondFactor: string;
  detectSession: string;
  bindSession: string;
  notInstalled: string;
  notAuthenticated: string;
  authenticated: string;
  processing: string;
  connected: string;
  cancelled: string;
  failed: string;
  expired: string;
  unsupported: string;
  invalidUrl: string;
  scan: string;
  confirmOnPhone: string;
  qrExpired: string;
  refreshQr: string;
  qrError: string;
  qrAlt: string;
  confirm: string;
  resourcesTruncated: string;
  expiresAt: string;
  rejected: string;
  cliUnavailable: string;
}

const DEFAULT_LABELS: LinkAuthorizationLabels = {
  openPage: "打开授权页面",
  waitingBrowser: "在服务商页面完成授权，返回后会自动确认连接。",
  deviceInstruction: "在授权页面输入此验证码：",
  copy: "复制验证码",
  submit: "验证并保存",
  verifyCode: "输入服务商提供的验证码",
  secondFactor: "完成服务商要求的追加验证",
  detectSession: "检查登录状态",
  bindSession: "使用这个账号",
  notInstalled: "此环境尚未安装对应 CLI。",
  notAuthenticated: "请先在当前环境登录对应 CLI，再检查状态。",
  authenticated: "已登录",
  processing: "正在确认并保存连接…",
  connected: "连接已保存。",
  cancelled: "授权已取消。",
  failed: "授权未完成，请重新连接。",
  expired: "授权已过期，请重新连接。",
  unsupported: "当前客户端不支持这个授权步骤，请更新客户端。",
  invalidUrl: "授权地址无效，请检查服务配置。",
  scan: "使用服务商的手机应用扫描二维码。",
  confirmOnPhone: "已扫码，请在手机上确认。",
  qrExpired: "二维码已过期。",
  refreshQr: "刷新二维码",
  qrError: "无法显示二维码，请重试。",
  qrAlt: "服务商授权二维码",
  confirm: "确认授权",
  resourcesTruncated: "此列表仅显示部分资源，请缩小选择范围后继续。",
  expiresAt: "有效期至",
  rejected: "服务商未接受此凭据，请检查后重试。",
  cliUnavailable: "此环境没有可用的 CLI 登录，请检查登录状态或选择其他方式。",
};

export interface LinkAuthorizationStepViewProps {
  authorization: LinkAuthorization;
  busy?: boolean;
  onRespond: (response: LinkAuthorizationResponse) => void;
  /** The host decides how to open an already validated URL. */
  onOpenUrl: (url: string) => void;
  /** Native remote authorization already has its own controlled window. */
  canOpenUrl?: boolean;
  onCopy?: (value: string) => void;
  labels?: Partial<LinkAuthorizationLabels>;
}

/** Fixed React controls only: provider metadata never supplies HTML or handlers. */
export function LinkAuthorizationStepView(props: LinkAuthorizationStepViewProps) {
  const labels = { ...DEFAULT_LABELS, ...props.labels };
  const step = getLinkAuthorizationStep(props.authorization);
  const [fields, setFields] = React.useState<Record<string, string>>({});
  const [selection, setSelection] = React.useState<Record<string, string[]>>({});
  const [qrImage, setQrImage] = React.useState<string>();
  const [qrError, setQrError] = React.useState(false);
  const [now, setNow] = React.useState(Date.now());
  const deadline = Math.min(
    props.authorization.expiresAt ? Date.parse(props.authorization.expiresAt) : Infinity,
    step ? Date.parse(step.expiresAt) : Infinity,
  );
  const qrDeadline =
    step?.kind === "qr-code" && step.qr ? Date.parse(step.qr.challengeExpiresAt) : Infinity;
  const qrPayload =
    step?.kind === "qr-code" && step.phase !== "expired" ? step.qr?.payload : undefined;

  React.useEffect(() => {
    setFields({});
    setSelection({});
  }, [props.authorization.id, step?.id]);
  React.useEffect(() => {
    setNow(Date.now());
    const expires = Math.min(deadline, qrDeadline);
    if (!Number.isFinite(expires)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, expires - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [deadline, qrDeadline]);
  React.useEffect(() => {
    let active = true;
    setQrImage(undefined);
    setQrError(false);
    if (!qrPayload || qrPayload.length > 4_096 || qrDeadline <= Date.now()) {
      if (qrPayload && qrPayload.length > 4_096) setQrError(true);
      return;
    }
    // Render the literal challenge locally. Never fetch or navigate QR content.
    void QRCode.toDataURL(qrPayload, { width: 220, margin: 2, errorCorrectionLevel: "M" })
      .then((value) => {
        if (active) setQrImage(value);
      })
      .catch(() => {
        if (active) setQrError(true);
      });
    return () => {
      active = false;
    };
  }, [qrPayload, qrDeadline]);

  if (props.authorization.state !== "pending") {
    const message =
      props.authorization.state === "connected"
        ? props.authorization.connection
          ? labels.connected
          : labels.processing
        : props.authorization.state === "cancelled"
          ? labels.cancelled
          : props.authorization.errorCode === "authorization_expired"
            ? labels.expired
            : labels.failed;
    return (
      <p className="link-authorization-status" role="status">
        {message}
      </p>
    );
  }
  if (!step) return <p role="alert">{labels.unsupported}</p>;
  if (!Number.isFinite(deadline) || deadline <= now)
    return (
      <p className="link-authorization-status" role="status">
        {labels.expired}
      </p>
    );
  const disabled = Boolean(props.busy);
  const respond = (
    operation: LinkAuthorizationResponse["operation"],
    input?: LinkAuthorizationResponse["input"],
  ) => props.onRespond({ stepId: step.id, operation, ...(input ? { input } : {}) });
  const openButton = (value?: string) => {
    if (props.canOpenUrl === false) return null;
    const url = safeLinkAuthorizationUrl(value);
    return url ? (
      <button type="button" disabled={disabled} onClick={() => props.onOpenUrl(url)}>
        {labels.openPage} ↗
      </button>
    ) : (
      <p role="alert">{labels.invalidUrl}</p>
    );
  };
  const expires = (
    <p className="link-authorization-expires">
      {labels.expiresAt} {new Date(deadline).toLocaleTimeString()}
    </p>
  );

  const error = props.authorization.errorCode ? (
    <p className="link-authorization-error" role="alert">
      {props.authorization.errorCode === "provider_rejected"
        ? labels.rejected
        : props.authorization.errorCode === "cli_unavailable"
          ? labels.cliUnavailable
          : labels.failed}
    </p>
  ) : null;
  const content = () => {
    switch (step.kind) {
      case "redirect":
        return (
          <div className="link-authorization-step" role="status">
            <p>{labels.waitingBrowser}</p>
            {openButton(step.authorizationUrl)}
            {expires}
          </div>
        );
      case "device-code":
        return (
          <div className="link-authorization-step link-authorization-device">
            <p>{labels.deviceInstruction}</p>
            <strong className="link-authorization-code">{step.userCode}</strong>
            <div className="link-authorization-actions">
              {props.onCopy && (
                <button type="button" onClick={() => props.onCopy?.(step.userCode)}>
                  {labels.copy}
                </button>
              )}
              {openButton(step.verificationUriComplete ?? step.verificationUri)}
            </div>
            {expires}
          </div>
        );
      case "qr-code": {
        const challengeExpired = step.phase === "expired" || qrDeadline <= now;
        return (
          <div className="link-authorization-step link-authorization-qr">
            <p role="status">
              {challengeExpired
                ? labels.qrExpired
                : step.phase === "awaiting-confirmation"
                  ? labels.confirmOnPhone
                  : labels.scan}
            </p>
            {!challengeExpired && qrImage && (
              <img width={220} height={220} src={qrImage} alt={labels.qrAlt} />
            )}
            {!challengeExpired && qrError && <p role="alert">{labels.qrError}</p>}
            {!challengeExpired &&
              step.qr?.instructions.map((instruction, index) => <p key={index}>{instruction}</p>)}
            {step.canRefresh && (
              <button type="button" disabled={disabled} onClick={() => respond("refresh-qr")}>
                {labels.refreshQr}
              </button>
            )}
            {expires}
          </div>
        );
      }
      case "credential-input":
        return (
          <form
            className="link-authorization-step link-authorization-fields"
            onSubmit={(event) => {
              event.preventDefault();
              if (disabled) return;
              const input: Record<string, string> = {};
              for (const field of step.fields) input[field.id] = fields[field.id] ?? "";
              // Secrets are one-shot UI input. An uncertain response is reconciled with GET.
              setFields({});
              respond("submit", input);
            }}
          >
            {step.purpose !== "credential" && (
              <p>
                {step.purpose === "verification-code" ? labels.verifyCode : labels.secondFactor}
              </p>
            )}
            {step.fields.map((field) => (
              <label key={field.id}>
                {field.label}
                <input
                  name={field.id}
                  type={field.secret ? "password" : "text"}
                  autoComplete="off"
                  spellCheck={false}
                  value={fields[field.id] ?? ""}
                  placeholder={field.placeholder}
                  maxLength={Math.min(field.maxLength ?? 16_384, 16_384)}
                  required={field.required}
                  disabled={disabled}
                  onChange={(event) =>
                    setFields((current) => ({ ...current, [field.id]: event.target.value }))
                  }
                />
              </label>
            ))}
            <button
              type="submit"
              disabled={
                disabled || step.fields.some((field) => field.required && !fields[field.id]?.trim())
              }
            >
              {labels.submit}
            </button>
            {expires}
          </form>
        );
      case "local-session":
        return (
          <div className="link-authorization-step">
            <p role="status">
              {step.session.authenticated
                ? `${labels.authenticated}${step.session.account ? `：${step.session.account}` : ""}`
                : step.session.installed
                  ? labels.notAuthenticated
                  : labels.notInstalled}
            </p>
            {step.session.message && <p>{step.session.message}</p>}
            <div className="link-authorization-actions">
              <button type="button" disabled={disabled} onClick={() => respond("detect-session")}>
                {labels.detectSession}
              </button>
              {step.session.authenticated && (
                <button type="button" disabled={disabled} onClick={() => respond("bind-session")}>
                  {labels.bindSession}
                </button>
              )}
            </div>
            {expires}
          </div>
        );
      case "consent": {
        const permissionIds =
          selection.permissions ??
          step.permissions.filter((item) => item.required).map((item) => item.id);
        const toggle = (key: string, id: string, checked: boolean, current: string[]) =>
          setSelection((previous) => ({
            ...previous,
            [key]: checked
              ? [...new Set([...current, id])]
              : current.filter((value) => value !== id),
          }));
        const invalid = step.resourceGroups.some((group) => {
          const size = (selection[group.id] ?? []).length;
          return (
            size < (group.minSelected ?? 0) ||
            size > (group.maxSelected ?? Infinity) ||
            group.truncated
          );
        });
        return (
          <form
            className="link-authorization-step link-authorization-consent"
            onSubmit={(event) => {
              event.preventDefault();
              if (!disabled && !invalid)
                respond("confirm", { ...selection, permissions: permissionIds });
            }}
          >
            <p>
              <strong>{step.account.label}</strong>
            </p>
            <div>
              {step.permissions.map((permission) => (
                <label key={permission.id}>
                  <input
                    type="checkbox"
                    checked={permission.required || permissionIds.includes(permission.id)}
                    disabled={disabled || permission.required}
                    onChange={(event) =>
                      toggle("permissions", permission.id, event.target.checked, permissionIds)
                    }
                  />
                  {permission.label}
                  {permission.description && <small>{permission.description}</small>}
                </label>
              ))}
            </div>
            {step.resourceGroups.map((group) => (
              <fieldset key={group.id}>
                <legend>{group.label}</legend>
                {group.items.map((item) => (
                  <label key={item.id}>
                    <input
                      type="checkbox"
                      checked={(selection[group.id] ?? []).includes(item.id)}
                      disabled={disabled}
                      onChange={(event) =>
                        toggle(group.id, item.id, event.target.checked, selection[group.id] ?? [])
                      }
                    />
                    {item.label}
                    {item.description && <small>{item.description}</small>}
                  </label>
                ))}
                {group.truncated && <p>{labels.resourcesTruncated}</p>}
              </fieldset>
            ))}
            <button type="submit" disabled={disabled || invalid}>
              {labels.confirm}
            </button>
            {expires}
          </form>
        );
      }
      case "processing":
        return (
          <p className="link-authorization-status" role="status">
            {labels.processing}
          </p>
        );
      default:
        return <p role="alert">{labels.unsupported}</p>;
    }
  };
  return (
    <>
      {error}
      {content()}
    </>
  );
}
