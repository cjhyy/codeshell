/** Compatibility import path. Production Electron actions now use Puppeteer
 * against the same webContents, retaining the native screenshot adapter. */
export {
  getElectronBrowser as driverFor,
  acquireElectronBrowser,
  authorizeElectronBrowser,
  releaseElectronBrowser,
} from "./electron-puppeteer.js";
