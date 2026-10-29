let loading: Promise<void> | undefined;
let loadedUrl: string | undefined;

/** Load the locally supplied official Core before importing its renderer adapter. */
export function loadCubismCore(url: string): Promise<void> {
  const parsed = new URL(url, window.location.href);
  if (parsed.href !== "csmimi://assets/Core/live2dcubismcore.min.js") {
    return Promise.reject(new Error("Live2D Core must come from the local companion assets."));
  }
  if (loading) {
    return loadedUrl === parsed.href
      ? loading
      : Promise.reject(new Error("A different Live2D Core is already loading."));
  }
  loadedUrl = parsed.href;
  loading = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    let settled = false;
    script.src = parsed.href;
    script.async = true;
    const timer = window.setTimeout(() => fail(), 15_000);
    const fail = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      script.onerror = null;
      script.onload = null;
      script.remove();
      loading = undefined;
      loadedUrl = undefined;
      reject(new Error("Live2D Core is unavailable. Prepare the local SDK assets first."));
    };
    script.onerror = fail;
    script.onload = () => {
      window.clearTimeout(timer);
      if (!(window as Window & { Live2DCubismCore?: unknown }).Live2DCubismCore) {
        fail();
        return;
      }
      settled = true;
      script.onerror = null;
      script.onload = null;
      resolve();
    };
    document.head.appendChild(script);
  });
  return loading;
}
