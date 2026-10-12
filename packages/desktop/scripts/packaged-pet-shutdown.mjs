/** Keep assertion, close, integrity and cleanup failures together. Exit receipt
 * parsing failures never authorize deleting a possibly live child's HOME. */
export async function settlePackagedPet({
  failures = [],
  closeApp,
  closeModel,
  verifyUnchanged,
  readNativeCalls,
  canCleanup,
  cleanup,
  retainedHome,
}) {
  const errors = [...failures];
  for (const close of [closeApp, closeModel]) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  let artifacts;
  let nativeCalls;
  let safeToCleanup = false;
  try {
    artifacts = await verifyUnchanged();
    nativeCalls = await readNativeCalls();
    safeToCleanup = await canCleanup();
  } catch (error) {
    errors.push(error);
  }
  let privateHomeRemoved = false;
  if (safeToCleanup) {
    try {
      await cleanup();
      privateHomeRemoved = true;
    } catch (error) {
      errors.push(error);
    }
  } else
    errors.push(
      Error(`Packaged Main/worker exit was not confirmed; HOME retained at ${retainedHome}`),
    );
  return { errors, artifacts, nativeCalls, privateHomeRemoved };
}
