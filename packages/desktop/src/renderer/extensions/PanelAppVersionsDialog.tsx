import { useEffect, useRef, useState } from "react";
import type {
  PanelPackageHistory,
  PanelPackageRestoreReview,
} from "@cjhyy/code-shell-server/panels";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

const permissionLabels: Record<string, string> = {
  "context.session": "读取当前对话信息",
  "context.workspace": "读取当前工作区信息",
  storage: "保存面板自己的数据",
  "external.open": "打开外部网页",
  "agent.submitPrompt": "向当前对话提交任务",
  "agent.task": "创建和管理 Agent 任务",
  "workspace.info": "查看工作区信息",
  "workspace.read": "读取工作区文件",
  "workspace.write": "修改工作区文件",
  "notifications.send": "发送通知",
  "audio.transcribe": "将音频转成文字",
  "credentials.cookies": "使用已授权的网站登录",
  "credentials.connections": "使用选定的服务连接",
  "automations.manage": "管理自动化任务",
  process: "运行已审核工具与后台任务",
  resources: "存取已授权文件与工具结果",
  media: "处理音视频文件",
  "media.capture": "使用麦克风、摄像头或屏幕录制",
};

export function PanelAppVersionsDialog({
  projectPath,
  appId,
  revision,
  onClose,
  onChanged,
}: {
  projectPath: string;
  appId: string;
  revision: string;
  onClose(): void;
  onChanged(): void;
}) {
  const [history, setHistory] = useState<PanelPackageHistory>();
  const [review, setReview] = useState<PanelPackageRestoreReview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(false);
  const pending = useRef(false);
  useEffect(() => {
    alive.current = true;
    let current = true;
    setHistory(undefined);
    setReview(undefined);
    void window.codeshell
      .getPanelAppPackageHistory(projectPath, appId, revision)
      .then((value) => {
        if (current) setHistory(value);
      })
      .catch((cause) => {
        if (current) setError(String(cause instanceof Error ? cause.message : cause));
      });
    return () => {
      current = false;
      alive.current = false;
    };
  }, [projectPath, appId, revision]);

  async function run<T>(operation: () => Promise<T>, accept: (value: T) => void) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const value = await operation();
      if (alive.current) accept(value);
    } catch (cause) {
      if (alive.current) {
        setError(String(cause instanceof Error ? cause.message : cause));
        setReview(undefined);
      }
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {history?.title["zh-CN"] ?? history?.title.default ?? appId} · 项目版本
          </DialogTitle>
          <DialogDescription className="break-all">{projectPath}</DialogDescription>
        </DialogHeader>
        <p className="text-sm">仅切换当前项目的程序版本，其他项目继续使用各自版本。</p>
        <p className="rounded border p-3 text-sm">
          切换程序版本不会恢复旧数据。请先备份项目，确认该版本支持当前文档格式；任务与产物记录会保留。
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {!history && !error && <p role="status">正在检查保留版本…</p>}
        {history && (
          <>
            <p className="text-sm">项目记录版本：{history.current.version}</p>
            {history.current.unavailable && (
              <p role="status" className="text-sm">
                当前安装包不可用，无法读取原权限；恢复前需重新审阅目标版本的全部权限。
              </p>
            )}
            {history.unavailablePackages > 0 && (
              <p className="text-sm">
                有 {history.unavailablePackages} 个保留包无法校验，暂不能选择。
              </p>
            )}
            {!history.versions.length && <p>没有可用的保留版本。</p>}
            {history.versions.map((version) => (
              <div
                key={version.packageDigest}
                className="flex flex-wrap items-center justify-between gap-2 rounded border p-3"
              >
                <div>
                  <strong>v{version.version}</strong>
                  <p className="text-xs text-muted-foreground">
                    内容编号 {version.packageDigest.slice(0, 12)}
                  </p>
                </div>
                <Button
                  variant="outline"
                  disabled={
                    busy ||
                    !version.compatibility.supported ||
                    version.packageDigest === history.current.packageDigest
                  }
                  onClick={() =>
                    void run(
                      () =>
                        window.codeshell.previewPanelAppRestore(
                          projectPath,
                          appId,
                          version.packageDigest,
                          history.expectedRevision,
                        ),
                      setReview,
                    )
                  }
                >
                  {version.packageDigest === history.current.packageDigest
                    ? "当前项目版本"
                    : `审阅 v${version.version}`}
                </Button>
              </div>
            ))}
          </>
        )}
        {review && (
          <section className="space-y-2 rounded border p-3" aria-label="确认恢复项目版本">
            <h3>
              v{review.current.version} → v{review.version}
            </h3>
            <p>此版本请求的权限：</p>
            {!review.permissions.length && <p>未申请宿主权限。</p>}
            <ul className="space-y-1 text-sm">
              {review.permissions.map((permission) => (
                <li key={permission}>
                  {permissionLabels[permission] ?? permission}
                  {review.addedPermissions.includes(permission) &&
                    (review.current.unavailable ? " · 需重新确认" : " · 新增权限")}
                </li>
              ))}
            </ul>
            <Button
              disabled={busy || !review.compatibility.supported}
              onClick={() => {
                if (review.expiresAt <= Date.now()) {
                  setReview(undefined);
                  setError("版本审阅已过期，请重新选择。");
                  return;
                }
                void run(
                  () => window.codeshell.restorePanelAppPackage(projectPath, review.reviewToken),
                  () => {
                    onChanged();
                    onClose();
                  },
                );
              }}
            >
              确认权限并恢复项目版本
            </Button>
          </section>
        )}
        <Button variant="outline" disabled={busy} onClick={onClose}>
          关闭版本记录
        </Button>
      </DialogContent>
    </Dialog>
  );
}
