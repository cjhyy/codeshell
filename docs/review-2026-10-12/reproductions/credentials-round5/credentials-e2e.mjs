import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const evidence = fileURLToPath(new URL("./", import.meta.url));
const { launchCodeShellElectron, findCodeShellWindow, navigateSettingsMenu, makeIsolatedElectronHome } = await import(pathToFileURL(join(repo, 'packages/desktop/scripts/electron-harness.mjs')));
const { prepareConfinedElectronFixture } = await import(pathToFileURL(join(repo, 'packages/desktop/scripts/confined-electron-fixture.mjs')));
const isolated = await makeIsolatedElectronHome('codeshell-review-credentials-');
const appDir = join(repo, 'packages/desktop');
const fixture = await prepareConfinedElectronFixture({ appDir, isolated, origin: 'http://127.0.0.1:9' });
await mkdir(isolated.codeShellHome, { recursive: true });
await writeFile(join(isolated.codeShellHome, 'settings.json'), JSON.stringify({ autoUpdates: false }));
let app, win;
const observations = [], pageerrors = [];
const credentialPath = join(isolated.codeShellHome, 'credentials.json');
const diskCookie = async () => {
  const stored = JSON.parse(await readFile(credentialPath, 'utf8')).credentials.find(item => item.type === 'cookie');
  const plaintext = stored.secret.replace(/^plain:/, '');
  return { stored, jar: JSON.parse(plaintext) };
};
try {
  app = await launchCodeShellElectron({ appDir, home: isolated.home, userDataDir: isolated.userDataDir, env: fixture.env, mainEntry: fixture.mainEntry });
  win = await findCodeShellWindow(app);
  win.on('pageerror', e => pageerrors.push(e.message));
  win.setDefaultTimeout(10000);
  const viewOnly = win.getByRole('button', { name: /仅查看|View only/i });
  if (await viewOnly.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false)) await viewOnly.click();
  await win.route('http://**/*', route => route.abort());
  await win.route('https://**/*', route => route.abort());
  await win.setViewportSize({ width: 1280, height: 850 });
  await fixture.assertWorker(app, { requireWorker: false });
  await app.evaluate(({ ipcMain, safeStorage }) => {
    // Storage availability fixture selects production's supported plain fallback; all data is synthetic.
    safeStorage.isEncryptionAvailable = () => false;
    globalThis.__credentialReviewFixture = { logins: 0, captures: 0 };
    ipcMain.removeHandler('credentials:loginCapture');
    ipcMain.handle('credentials:loginCapture', () => {
      const count = ++globalThis.__credentialReviewFixture.logins;
      return { ok: true, domain: 'accounts.example.test', jar: [{ name: 'session', value: `SYNTHETIC_ACCOUNT_${count}`, domain: 'accounts.example.test', path: '/', secure: true }] };
    });
    ipcMain.removeHandler('credentials:captureAllCookiesAllSessions');
    ipcMain.handle('credentials:captureAllCookiesAllSessions', () => {
      const count = ++globalThis.__credentialReviewFixture.captures;
      return { count: 1, jar: [{ name: 'session', value: `SYNTHETIC_BROWSER_${count}`, domain: 'browser.example.test', path: '/', secure: true }] };
    });
  });
  await navigateSettingsMenu(win, '凭证');
  await win.locator('[data-cookie-page]').waitFor();
  async function addLogin() {
    await win.locator('#cookie-login-url').fill('accounts.example.test');
    await win.getByRole('button', { name: '弹窗登录并保存', exact: true }).click();
    await win.waitForFunction(() => document.querySelector('#cookie-login-url')?.value === '');
  }
  console.log('step: sequential login');
  await addLogin();
  const first = await win.evaluate(() => window.codeshell.credentials.list(''));
  assert.equal(first.length, 1);
  assert.equal((await diskCookie()).jar[0].value, 'SYNTHETIC_ACCOUNT_1');
  await win.evaluate(credential => window.codeshell.credentials.patchMeta('', 'user', credential.id, { label: 'Fixture Alice', autoUseByAI: true, autoInjectByAI: true, meta: { ...credential.meta, switchMode: 'clear', note: 'Original fixture metadata marker' } }), first[0]);
  const beforeSecond = (await win.evaluate(() => window.codeshell.credentials.list('')))[0];
  await addLogin();
  const second = await win.evaluate(() => window.codeshell.credentials.list(''));
  assert.equal(second.length, 1);
  assert.equal(second[0].id, first[0].id);
  assert.equal(second[0].label, '账号');
  assert.equal(second[0].autoUseByAI, undefined);
  assert.equal(second[0].autoInjectByAI, undefined);
  assert.equal(second[0].meta.note, undefined);
  assert.equal(second[0].meta.switchMode, 'merge');
  assert.equal((await diskCookie()).jar[0].value, 'SYNTHETIC_ACCOUNT_2');
  const summary = ({id,label,autoUseByAI,autoInjectByAI,meta}) => ({ id, label, autoUseByAI: autoUseByAI ?? null, autoInjectByAI: autoInjectByAI ?? null, meta });
  observations.push({ scenario: 'sequential new logins overwrite renamed first account', beforeSecond: summary(beforeSecond), afterSecond: second.map(summary), oldCookieValueReplaced: true, oldMetadataMarkerAbsent: true });
  await win.evaluate(id => window.codeshell.credentials.remove('', 'user', id), first[0].id);
  await win.locator('[id$="-tab-token"]').click();
  await win.locator('[id$="-tab-cookie"]').click();
  async function addBrowser(label) {
    await win.getByRole('button', { name: '抓全部', exact: true }).click();
    const dialog = win.getByRole('dialog');
    await dialog.waitFor();
    await dialog.getByRole('textbox').fill(label);
    await dialog.getByRole('button', { name: '确定', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await win.getByRole('article', { name: label, exact: true }).waitFor();
  }
  console.log('step: Chinese browser labels');
  await addBrowser('工作账号');
  const beforeBrowser = await win.evaluate(() => window.codeshell.credentials.list(''));
  assert.equal((await diskCookie()).jar[0].value, 'SYNTHETIC_BROWSER_1');
  await addBrowser('个人账号');
  const afterBrowser = await win.evaluate(() => window.codeshell.credentials.list(''));
  assert.equal(beforeBrowser.length, 1);
  assert.equal(afterBrowser.length, 1);
  assert.equal(beforeBrowser[0].id, 'browser__account');
  assert.equal(afterBrowser[0].id, 'browser__account');
  assert.equal(afterBrowser[0].label, '个人账号');
  assert.equal((await diskCookie()).jar[0].value, 'SYNTHETIC_BROWSER_2');
  observations.push({ scenario: 'two distinct Chinese account names overwrite', before: beforeBrowser.map(({id,label}) => ({id,label})), after: afterBrowser.map(({id,label}) => ({id,label})), oldCookieValueReplaced: true });
  await win.screenshot({ path: join(evidence, 'cookie-overwrite.png') });
  await win.locator('[id$="-tab-token"]').click();
  await win.locator('#token-id').fill('fixture-token');
  await win.locator('#token-name').fill('Fixture token');
  await win.locator('#token-secret').fill('SYNTHETIC_TOKEN');
  // Corruption is confined to this fixture's own store and restores immediately after observation.
  const savedStore = await readFile(credentialPath, 'utf8');
  await writeFile(credentialPath, '{fixture-corrupt');
  const priorErrorCount = pageerrors.length;
  await win.locator('[data-token-page]').getByRole('button', { name: '保存', exact: true }).click();
  await win.waitForFunction(() => document.querySelector('#token-id')?.value === 'fixture-token');
  await new Promise(done => setTimeout(done, 500));
  const failureView = await win.evaluate(() => ({ text: document.body.innerText, id: document.querySelector('#token-id')?.value, secret: Boolean(document.querySelector('#token-secret')?.value), alerts: [...document.querySelectorAll('[role="alert"]')].map(n => n.textContent) }));
  assert.equal(pageerrors.length, priorErrorCount + 1);
  assert.match(pageerrors.at(-1), /refusing to modify an unreadable credential store/);
  assert.ok(!failureView.text.includes('refusing to modify an unreadable credential store'));
  assert.equal(failureView.alerts.length, 0);
  assert.equal(failureView.id, 'fixture-token');
  assert.equal(failureView.secret, true);
  observations.push({ scenario: 'Token save real store failure has no user feedback', pageerror: pageerrors.at(-1), visibleAlerts: failureView.alerts, draftId: failureView.id, draftSecretRetained: failureView.secret });
  await win.screenshot({ path: join(evidence, 'token-write-failure.png'), mask: [win.locator('#token-secret')] });
  await writeFile(credentialPath, savedStore);
  await win.locator('[data-token-page]').getByRole('button', { name: '保存', exact: true }).click();
  await win.getByRole('article', { name: 'Fixture token', exact: true }).waitFor();
  assert.equal(await win.locator('#token-id').inputValue(), '');
  observations.push({ scenario: 'store restored then same Save succeeds', passed: true });
  await rm(join(evidence, 'failure.json'), { force: true });
  await rm(join(evidence, 'failure.png'), { force: true });
  await writeFile(join(evidence, 'observations.json'), JSON.stringify({ baseline: '84740d56', observations, pageerrors }, null, 2));
  console.log(JSON.stringify({ passed: true, scenarios: observations.length, observations }, null, 2));
} catch (error) {
  await writeFile(join(evidence, 'failure.json'), JSON.stringify({ message: error.message, observations, pageerrors }, null, 2));
  if (win) await win.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
  await isolated.cleanup();
}
