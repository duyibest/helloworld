import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { loginOnce } from '../login.mjs';
import { SecretError } from '../secrets.mjs';

const origin = 'https://aswbe-i.ana.co.jp';
const login = origin + '/rei11d/international_asw/pages/common/login_standard.xhtml';
const award = origin + '/rei11d/international_asw/pages/award/search/roundtrip/award_search_roundtrip_input.xhtml';
const fake = { anaNumber: '0123456789', password: 'fixture-only-not-real' };
const loginHTML = (action = '/submit') => `<!doctype html><html><body><h1>ANA Member Login</h1><form method="post" action="${action}"><label>ANA Number<input type="text" name="anaNumber"></label><label>Password<input type="password" name="password"></label><button type="submit">Login</button></form></body></html>`;

test('login browser contract using intercepted ANA-origin fixtures only', { timeout: 45000 }, async t => {
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    async function scenario({ html = loginHTML(), result = 'success', secretError, entryURL = login } = {}) {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      let reads = 0, submits = 0;
      const stages = [];
      await context.route('**/*', async route => {
        const req = route.request(), u = new URL(req.url());
        if (u.origin !== origin) { await route.abort(); return; }
        if (u.pathname === '/submit') {
          submits++;
          const fields = new URLSearchParams(req.postData());
          assert.equal(fields.get('anaNumber'), fake.anaNumber); assert.equal(fields.get('password'), fake.password);
          // A client navigation creates a separately intercepted request; never let a mock redirect fall through to the real ANA host.
          if (result === 'success') await route.fulfill({ contentType: 'text/html', body: `<script>location.replace(${JSON.stringify(award)})</script>` });
          else await route.fulfill({ contentType: 'text/html', body: result === 'challenge' ? '<h1>Enter your verification code</h1>' : result === 'ambiguous' ? '<h1>Welcome</h1>' : '<h1>Incorrect password</h1>' });
          return;
        }
        if (u.href === award) { await route.fulfill({ contentType: 'text/html', body: '<h1>Award search</h1><button>Logout</button><form><input name="origin"><input name="destination"></form>' }); return; }
        await route.fulfill({ contentType: 'text/html', body: html });
      });
      try {
        const page = await context.newPage(); page.setDefaultTimeout(500);
        const outcome = await loginOnce({ page, context, entryURL, timeoutMs: 800,
          getCredentials: async () => { reads++; if (secretError) throw new SecretError(secretError); return { ...fake }; }, onStage: stage => stages.push(stage) });
        assert(!JSON.stringify({ outcome, stages }).includes(fake.password));
        return { outcome, reads, submits };
      } finally { await context.close(); }
    }
    await t.test('submit exactly once and verify award page plus Logout', async () => {
      const s = await scenario(); assert.equal(s.outcome.status, 'authenticated'); assert.equal(s.reads, 1); assert.equal(s.submits, 1);
    });
    await t.test('wrong password is terminal and never retried', async () => {
      const s = await scenario({ result: 'rejected' }); assert.equal(s.outcome.status, 'login_rejected'); assert.equal(s.submits, 1);
    });
    await t.test('verification challenge after submit needs a human', async () => {
      const s = await scenario({ result: 'challenge' }); assert.equal(s.outcome.status, 'needs_human'); assert.equal(s.submits, 1);
    });
    await t.test('challenge before login does not access the secret', async () => {
      const s = await scenario({ html: '<h1>Verify you are human</h1>' }); assert.equal(s.outcome.status, 'needs_human'); assert.equal(s.reads, 0);
    });
    await t.test('provider block stops without reading the secret', async () => {
      const s = await scenario({ html: '<h1>Access Denied</h1>' }); assert.equal(s.outcome.status, 'blocked'); assert.equal(s.reads, 0); assert.equal(s.submits, 0);
    });
    await t.test('external form action never reads credentials', async () => {
      const s = await scenario({ html: loginHTML('https://evil.test/submit') }); assert.equal(s.outcome.status, 'unsafe_login_form'); assert.equal(s.reads, 0); assert.equal(s.submits, 0);
    });
    await t.test('ambiguous form never reads credentials', async () => {
      const s = await scenario({ html: loginHTML().replace('<label>Password', '<input type="text" name="unrecognized"><label>Password') }); assert.equal(s.outcome.status, 'unrecognized_login_form'); assert.equal(s.reads, 0);
    });
    await t.test('missing secret fails without submitting', async () => {
      const s = await scenario({ secretError: 'secret_unavailable' }); assert.equal(s.outcome.status, 'secret_unavailable'); assert.equal(s.submits, 0);
    });
    await t.test('generic welcome page cannot claim success', async () => {
      const s = await scenario({ result: 'ambiguous' }); assert.equal(s.outcome.status, 'login_unverified'); assert.equal(s.submits, 1);
    });
    await t.test('blank login page never reads credentials', async () => {
      const s = await scenario({ html: '<h1>Loading</h1>' }); assert.equal(s.outcome.status, 'login_not_ready'); assert.equal(s.reads, 0);
    });
    await t.test('untrusted entry rejected before navigation and secret access', async () => {
      const s = await scenario({ entryURL: 'https://evil.test/' }); assert.equal(s.outcome.status, 'invalid_entry_url'); assert.equal(s.reads, 0);
    });
  } finally { await browser.close(); }
});
