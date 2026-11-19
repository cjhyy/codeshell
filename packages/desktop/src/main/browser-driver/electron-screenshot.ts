import type { CdpImageData, CdpScreenshotRequest } from "../../browser-library/page-utils.js";
import type { Rectangle, WebContents } from "electron";

/** Capture the existing Electron target without opening another browser or CDP port. */
export async function captureElectronPage(
  contents: WebContents,
  request: CdpScreenshotRequest,
): Promise<CdpImageData> {
  if (contents.isDestroyed()) return { ok: false, detail: "browser target was destroyed" };
  try {
    let rect: Rectangle | undefined;
    if (request.region) {
      // capturePage accepts viewport DIPs. DOM boxes use viewport CSS pixels;
      // page zoom converts those once, while Electron handles display density.
      const zoom = contents.getZoomFactor();
      const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
      const { x, y, width, height } = request.region;
      const left = Math.ceil(x * scale);
      const top = Math.ceil(y * scale);
      rect = {
        x: left,
        y: top,
        width: Math.floor((x + width) * scale) - left,
        height: Math.floor((y + height) * scale) - top,
      };
      if (rect.width < 1 || rect.height < 1) {
        return { ok: false, detail: "capture region is empty" };
      }
    }
    const image = await contents.capturePage(rect, { stayHidden: true });
    if (image.isEmpty()) return { ok: false, detail: "screenshot returned no image" };
    const size = image.getSize();
    const factor = Math.min(1, request.maxDim / Math.max(size.width, size.height));
    const output =
      factor < 1
        ? image.resize({
            width: Math.max(1, Math.floor(size.width * factor)),
            height: Math.max(1, Math.floor(size.height * factor)),
            quality: "best",
          })
        : image;
    const base64 = output.toJPEG(80).toString("base64");
    if (rect) return { ok: true, mediaType: "image/jpeg", base64 };
    // Only a whole-viewport frame says anything about the page having rendered,
    // and classifying it must never cost the caller its screenshot.
    let blank: boolean | undefined;
    try {
      blank = isFlatBitmap(output.toBitmap());
    } catch {
      blank = undefined;
    }
    return { ok: true, mediaType: "image/jpeg", base64, blank };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * True when a 4-bytes-per-pixel bitmap is (almost) one flat color: an unpainted
 * or still-empty page. A sparse grid is enough, and a little tolerance keeps a
 * spinner or a hairline border from hiding an otherwise empty frame.
 */
export function isFlatBitmap(bitmap: Uint8Array): boolean {
  const pixels = Math.floor(bitmap.length / 4);
  if (pixels === 0) return false;
  const stride = Math.max(1, Math.floor(pixels / 20_000));
  let sampled = 0;
  let differing = 0;
  for (let pixel = 0; pixel < pixels; pixel += stride) {
    const at = pixel * 4;
    sampled += 1;
    if (
      Math.abs(bitmap[at] - bitmap[0]) > 8 ||
      Math.abs(bitmap[at + 1] - bitmap[1]) > 8 ||
      Math.abs(bitmap[at + 2] - bitmap[2]) > 8
    )
      differing += 1;
  }
  return differing / sampled < 0.005;
}
