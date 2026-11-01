import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readCredentials, secretResource } from './secrets.mjs';
import { ENTRY_URL, loginOnce, isANAURL } from './login.mjs';

const emit = value => console.log(JSON.stringify(value));
async function main() {
  const { values } = parseArgs({ options: {
    project: { type: 'string', default: 'yis-project-362902' },
    secret: { type: 'string', default: 'ana-award-credentials' },
    version: { type: 'string', default: '1' },
    'secret-auth': { type: 'string', default: 'gcloud' },
    gcloud: { type: 'string', default: join(homedir(), '.local/bin/gcloud') },
    'login-url-stdin': { type: 'boolean', default: false },
    channel: { type: 'string', default: 'chromium' },
    executable: { type: 'string' },
    headed: { type: 'boolean', default: false },
    timeout: { type: 'string', default: '45' },
    'session-file': { type: 'string' },
    help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    console.log('ANA login-only pilot. Reads Secret Manager JSON {ana_number,password}.');
    console.log('Options: --project ID --secret ID --version NUMBER --secret-auth gcloud|adc');
    console.log('         --channel chromium|chrome --executable PATH --headed --timeout SECONDS');
    console.log('         --login-url-stdin (read a session URL privately from stdin)');
    console.log('         --session-file ABSOLUTE_PATH (opt-in: save cookies after verified login)');
    return;
  }
  if (/pw:|\*/i.test(process.env.DEBUG || '') || process.env.PWDEBUG) {
    emit({ status: 'unsafe_debug_environment', message: 'Disable Playwright debug output before using credentials.' }); process.exitCode = 1; return;
  }
  const timeoutMs = Number(values.timeout) * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 5000 || timeoutMs > 120000
      || !['chromium', 'chrome'].includes(values.channel) || !['gcloud', 'adc'].includes(values['secret-auth'])) throw new Error('invalid_configuration');
  const config = { project: values.project, secret: values.secret, version: values.version, secretAuth: values['secret-auth'], gcloud: values.gcloud };
  secretResource(config);
  const entryURL = values['login-url-stdin'] ? readFileSync(0, 'utf8').trim() : ENTRY_URL;
  if (!isANAURL(entryURL)) throw new Error('invalid_configuration');
  let sessionFile;
  if (values['session-file']) {
    sessionFile = resolve(values['session-file']);
    const repo = await realpath(fileURLToPath(new URL('..', import.meta.url)));
    const destinationDir = await realpath(resolve(sessionFile, '..')).catch(() => resolve(sessionFile, '..'));
    if (destinationDir === repo || destinationDir.startsWith(repo + '/')) throw new Error('invalid_session_destination');
  }
  const { chromium } = await import('playwright');
  let browser;
  let stage = 'starting_browser';
  // Bound every phase, including a hung renderer or SDK call. Close the browser
  // and let the process exit without printing any exception or command arguments.
  const watchdog = setTimeout(() => {
    emit({ status: 'overall_timeout', stage });
    browser?.close().catch(() => {});
    setTimeout(() => process.exit(1), 1500).unref();
  }, timeoutMs * 2 + 60000);
  try {
    browser = await chromium.launch({
      ...(values.executable ? { executablePath: values.executable } : { channel: values.channel }),
      headless: !values.headed, timeout: 30000,
    });
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
    await context.route('**/*', async route => {
      const req = route.request();
      if (req.isNavigationRequest() && req.frame() === context.pages()[0]?.mainFrame() && !isANAURL(req.url())) await route.abort();
      else await route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(5000);
    const result = await loginOnce({ page, context, entryURL, timeoutMs, sessionFile,
      getCredentials: () => readCredentials(config), onStage: next => { stage = next; emit({ stage }); } });
    emit({ ...result, browserVersion: browser.version() });
    if (result.status !== 'authenticated') process.exitCode = 1;
  } catch { emit({ status: 'browser_error', stage }); process.exitCode = 1; }
  finally { clearTimeout(watchdog); if (browser) await browser.close().catch(() => {}); }
}
main().catch(() => { emit({ status: 'invalid_configuration' }); process.exitCode = 1; });
