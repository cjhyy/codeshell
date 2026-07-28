import {
  PanelAppAlreadyInstalledError,
  PanelAppReviewChangedError,
  installReviewedLocalPanelApp,
  installReviewedPanelAppUpdate,
  previewInstalledPanelAppUpdate,
  previewLocalPanelApp,
  uninstallPanelApp,
  type PanelAppSourceInput,
  type PanelAppPreview,
} from "@cjhyy/code-shell-core";

export async function previewLocalPanelAppForUi(
  input: PanelAppSourceInput,
): Promise<{ ok: true; preview: PanelAppPreview } | { ok: false; error: string }> {
  try {
    return { ok: true, preview: await previewLocalPanelApp(input) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function installLocalPanelAppForUi(input: {
  source: PanelAppSourceInput;
  reviewToken: string;
  overwrite?: boolean;
}): Promise<
  | { ok: true; id: string }
  | { ok: false; alreadyInstalled?: true; previewChanged?: true; error: string }
> {
  try {
    const installed = await installReviewedLocalPanelApp(
      input.source,
      input.reviewToken,
      new Date().toISOString(),
      { overwrite: input.overwrite === true },
    );
    return { ok: true, id: installed.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof PanelAppReviewChangedError) {
      return { ok: false, previewChanged: true, error: message };
    }
    return {
      ok: false,
      ...(error instanceof PanelAppAlreadyInstalledError
        ? { alreadyInstalled: true as const }
        : {}),
      error: message,
    };
  }
}

export async function previewPanelAppUpdateForUi(
  id: string,
): Promise<{ ok: true; preview: PanelAppPreview } | { ok: false; error: string }> {
  try {
    return { ok: true, preview: await previewInstalledPanelAppUpdate(id) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function installPanelAppUpdateForUi(input: {
  id: string;
  reviewToken: string;
}): Promise<{ ok: true; id: string } | { ok: false; previewChanged?: true; error: string }> {
  try {
    const installed = await installReviewedPanelAppUpdate(
      input.id,
      input.reviewToken,
      new Date().toISOString(),
    );
    return { ok: true, id: installed.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      ...(error instanceof PanelAppReviewChangedError ? { previewChanged: true as const } : {}),
      error: message,
    };
  }
}

export async function uninstallPanelAppForUi(id: string): Promise<void> {
  await uninstallPanelApp(id);
}
