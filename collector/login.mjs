import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SecretError } from './secrets.mjs';

export const ENTRY_URL = 'https://aswbe-i.ana.co.jp/international_asw/pages/award/search/roundtrip/award_search_roundtrip_input.xhtml?CONNECTION_KIND=JPN&LANG=en';
const HOST = 'aswbe-i.ana.co.jp';
const HUMAN = /captcha|verify (?:that )?you are human|one[- ]time (?:password|code)|verification code|two[- ]factor|認証コード|画像認証/i;
const BLOCKED = /access denied|unusual traffic|too many requests|temporarily blocked/i;
const REJECTED = /(?:incorrect|invalid|wrong).{0,60}(?:password|credential|membership number|ana number)|(?:password|credential).{0,60}(?:incorrect|invalid)|パスワード.{0,30}(?:違|誤)/i;

export function isANAURL(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === HOST && !u.username && !u.password && (u.port === '' || u.port === '443'); }
  catch { return false; }
}
export function isLoginURL(value) { return isANAURL(value) && /\/pages\/common\/login_standard\.xhtml$/.test(new URL(value).pathname); }
export function isAwardURL(value) { return isANAURL(value) && /\/pages\/award\/search\/[^/]+\/[^/]+\.xhtml$/.test(new URL(value).pathname); }

export function classifyObservation(observation) {
  if (!isANAURL(observation.url)) return 'unexpected_page';
  if (observation.challenge || HUMAN.test(observation.text || '')) return 'needs_human';
  if (BLOCKED.test(observation.text || '')) return 'blocked';
  if (REJECTED.test(observation.text || '')) return 'login_rejected';
  // A redirect or disappearing password field alone does not prove login success.
  if (isAwardURL(observation.url) && observation.logoutVisible && observation.passwordCount === 0 && observation.formInputs > 0) return 'authenticated';
  return 'pending';
}

async function bounded(promise, timeout = 1500) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('inspection_timeout')), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

async function observe(page) {
  const url = page.url();
  if (!isANAURL(url)) return { url };
  return bounded(page.evaluate(() => {
    const visible = e => !!(e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
    const controls = [...document.querySelectorAll('a, button, input[type=button], input[type=submit]')].filter(visible);
    return {
      url: location.href,
      text: document.body?.innerText || '',
      passwordCount: [...document.querySelectorAll('input[type=password]')].filter(visible).length,
      formInputs: [...document.querySelectorAll('form input:not([type=hidden]), form select')].filter(visible).length,
      logoutVisible: controls.some(e => /^(?:log\s*out|sign\s*out|ログアウト)$/i.test((e.innerText || e.value || '').trim())),
      challenge: [...document.querySelectorAll('iframe')].filter(visible).some(e => /captcha|challenge|verification/i.test(e.title || '')),
    };
  }));
}

async function inspectLoginForm(page) {
  if (!isLoginURL(page.url())) return { status: 'login_not_ready' };
  const password = page.locator('input[type=password]:visible');
  if (await password.count() !== 1) return { status: 'unrecognized_login_form' };
  const form = page.locator('form').filter({ has: password });
  if (await form.count() !== 1) return { status: 'unrecognized_login_form' };
  const fields = form.locator('input:is([type=text],[type=tel],[type=number],[type=email],:not([type])):visible');
  if (await fields.count() !== 1) return { status: 'unrecognized_login_form' };
  const candidates = form.locator('button:visible, input[type=submit]:visible, input[type=button]:visible');
  const matching = [];
  for (const button of await candidates.all()) {
    const name = await button.evaluate(e => e.innerText || e.value || '');
    if (/^\s*(?:log\s*in|sign\s*in|ログイン)(?:\b|\s|[（(])/i.test(name)) matching.push(button);
  }
  if (matching.length !== 1) return { status: 'unrecognized_login_form' };
  const submit = matching[0];
  const target = await submit.evaluate(e => ({
    action: e.getAttribute('formaction') ? e.formAction : e.form.action,
    method: (e.getAttribute('formmethod') || e.form.method).toLowerCase(),
    formTarget: e.formTarget || e.form.target,
  }));
  if (!isANAURL(target.action) || target.method !== 'post' || (target.formTarget && target.formTarget !== '_self')) return { status: 'unsafe_login_form' };
  return { status: 'ready', password, number: fields, submit };
}

async function saveSession(context, destination) {
  // Explicit opt-in only. Never use the repository as the default cookie store.
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temp = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(await context.storageState()), { mode: 0o600, flag: 'wx' });
    await rename(temp, destination);
  } finally { await unlink(temp).catch(() => {}); }
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function loginOnce({ page, context, getCredentials, entryURL = ENTRY_URL, timeoutMs = 45000, sessionFile, onStage = () => {} }) {
  if (!isANAURL(entryURL)) return { status: 'invalid_entry_url', submitted: false };
  let submitted = false;
  let credentials;
  const deadline = Date.now() + timeoutMs;
  try {
    onStage('opening_ana');
    try {
      const response = await page.goto(entryURL, { waitUntil: 'commit', timeout: Math.min(20000, timeoutMs) });
      if ([403, 429].includes(response?.status())) return { status: 'blocked', submitted };
      if (response && response.status() >= 500) return { status: 'site_unavailable', submitted };
    }
    catch { /* Inspect state after a bounded redirect timeout; never log the URL. */ }
    onStage('waiting_for_login_form');
    let form;
    while (Date.now() < deadline) {
      try {
        const o = await observe(page), state = classifyObservation(o);
        if (['needs_human', 'blocked', 'unexpected_page'].includes(state)) return { status: state, submitted };
        if (o.passwordCount > 0) { form = await bounded(inspectLoginForm(page), 5000); break; }
      } catch { /* The execution context can change while redirects are in progress. */ }
      await pause(200);
    }
    if (!form) return { status: 'login_not_ready', submitted };
    if (form.status !== 'ready') return { status: form.status, submitted };
    onStage('reading_secret');
    credentials = await getCredentials();
    if (!isLoginURL(page.url())) return { status: 'unexpected_page', submitted };
    // No auth state, screenshots, traces, browser-console logs, or values are emitted.
    await form.number.fill(credentials.anaNumber);
    await form.password.fill(credentials.password);
    const beforeSubmit = classifyObservation(await observe(page));
    if (['needs_human', 'blocked'].includes(beforeSubmit)) return { status: beforeSubmit, submitted };
    if (!isLoginURL(page.url())) return { status: 'unexpected_page', submitted };
    onStage('submitting_login');
    submitted = true;
    // One submission only; authentication errors are not retried.
    await form.submit.click({ timeout: 10000, noWaitAfter: true });
    credentials = undefined;
    onStage('verifying_login');
    const verifyDeadline = Date.now() + timeoutMs;
    while (Date.now() < verifyDeadline) {
      try {
        const status = classifyObservation(await observe(page));
        if (status === 'authenticated') {
          if (sessionFile) { onStage('saving_private_session'); await saveSession(context, sessionFile); }
          return { status, submitted, sessionSaved: !!sessionFile };
        }
        if (['needs_human', 'blocked', 'login_rejected', 'unexpected_page'].includes(status)) return { status, submitted };
      } catch { /* Wait for a new document's execution context, within the deadline. */ }
      await pause(200);
    }
    return { status: 'login_unverified', submitted };
  } catch (error) {
    if (error instanceof SecretError) return { status: error.code, submitted };
    // Browser errors often include filled values or session URLs. Discard details.
    return { status: 'browser_error', submitted };
  } finally { credentials = undefined; }
}
