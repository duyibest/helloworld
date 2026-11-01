import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCredentials, readCredentials, secretResource } from '../secrets.mjs';
import { isANAURL, isLoginURL, classifyObservation, safeLoginEvidence } from '../login.mjs';

const fake = { ana_number: '0123456789', password: 'fixture-password-not-a-real-account' };
const config = { project: 'yis-project-362902', secret: 'ana-award-credentials', version: '1', secretAuth: 'gcloud', gcloud: '/fixture/gcloud' };

test('validate JSON without exposing invalid payloads', () => {
  assert.deepEqual(parseCredentials(Buffer.from(JSON.stringify(fake))), { anaNumber: fake.ana_number, password: fake.password });
  for (const bad of ['not-json-secret-marker', '{}', 'null', JSON.stringify({ ...fake, ana_number: 1234567890 }), JSON.stringify({ ...fake, password: '' })]) {
    assert.throws(() => parseCredentials(Buffer.from(bad)), e => e.code === 'invalid_secret_format' && !e.message.includes('marker'));
  }
});
test('gcloud captures the secret in memory and uses no shell or secret arguments', async () => {
  const stdout = Buffer.from(JSON.stringify(fake));
  const value = await readCredentials(config, { execute: async (exe, args, options) => {
    assert.equal(exe, '/fixture/gcloud'); assert(args.includes('--no-log-http'));
    assert.equal(args.includes(fake.password), false); assert.equal(options.encoding, 'buffer');
    return { stdout };
  } });
  assert.equal(value.password, fake.password); assert(stdout.every(byte => byte === 0));
});
test('provider errors are replaced with static safe errors', async () => {
  await assert.rejects(readCredentials(config, { execute: async () => { throw new Error(fake.password); } }), e => e.code === 'secret_unavailable' && !e.message.includes(fake.password));
});
test('ADC requests only the configured secret version and closes its client', async () => {
  let closed = false;
  const result = await readCredentials({ ...config, secretAuth: 'adc' }, { makeClient: () => ({
    accessSecretVersion: async request => { assert.equal(request.name, secretResource(config)); return [{ payload: { data: Buffer.from(JSON.stringify(fake)) } }]; },
    close: async () => { closed = true; },
  }) });
  assert.equal(result.anaNumber, fake.ana_number); assert(closed);
});
test('credential references and destinations fail closed', () => {
  for (const version of ['../2', '1 --log-http', '', '0']) assert.throws(() => secretResource({ ...config, version }));
  for (const url of ['http://aswbe-i.ana.co.jp/', 'https://aswbe-i.ana.co.jp.evil.test/', 'https://evil.test/', 'https://user:pass@aswbe-i.ana.co.jp/', 'https://aswbe-i.ana.co.jp:9999/']) assert.equal(isANAURL(url), false);
  assert(isLoginURL('https://aswbe-i.ana.co.jp/rei11d/international_asw/pages/common/login_standard.xhtml'));
});
test('a fresh blank tab remains pending without proving authentication', () => {
  assert.equal(classifyObservation({ url: 'about:blank' }), 'pending');
});
test('neither a redirect nor an absent password proves authentication', () => {
  const o = { url: 'https://aswbe-i.ana.co.jp/rei11d/international_asw/pages/award/search/roundtrip/award_search_roundtrip_input.xhtml', logoutVisible: false, passwordCount: 0, formInputs: 3, text: '' };
  assert.equal(classifyObservation(o), 'pending');
  assert.equal(classifyObservation({ ...o, logoutVisible: true }), 'authenticated');
  assert.equal(classifyObservation({ ...o, logoutVisible: true, text: 'Enter your verification code' }), 'needs_human');
  assert.equal(classifyObservation({ ...o, text: 'Incorrect password' }), 'login_rejected');
  assert.equal(classifyObservation({ ...o, url: 'https://evil.test/' }), 'unexpected_page');
});

test('post-login diagnostics contain booleans and page categories, never URLs or text', () => {
  const observation = {
    url: 'https://aswbe-i.ana.co.jp/rei11d/international_asw/pages/common/login_standard.xhtml?rdtk=fixture-session-token',
    text: 'fixture-private-page-text', passwordCount: 1, logoutVisible: false, formInputs: 2,
  };
  const evidence = safeLoginEvidence(observation), serialized = JSON.stringify(evidence);
  assert.equal(evidence.page, 'login'); assert.equal(evidence.passwordVisible, true);
  for (const forbidden of ['fixture-session-token', 'fixture-private-page-text', 'https://', 'rdtk']) assert.equal(serialized.includes(forbidden), false);
});
