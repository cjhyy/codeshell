/** Wheel dispatch does not await the page's rendering work. Observe boundedly
 * after one input event; never repeat the wheel to manufacture progress. */
export async function observeScrollProgress<T>(
  observe: () => Promise<T>,
  hasProgress: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 1000;
  let latest!: T;
  // The attempt limit also bounds waiting if the system clock moves backwards.
  for (let attempt = 0; attempt < 14; attempt++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 75));
    latest = await observe();
    if (hasProgress(latest) || Date.now() >= deadline) break;
  }
  return latest;
}
