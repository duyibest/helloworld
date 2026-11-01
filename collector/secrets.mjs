import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
export class SecretError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function parseCredentials(payload) {
  let value;
  try { value = JSON.parse(Buffer.from(payload).toString('utf8')); }
  catch { throw new SecretError('invalid_secret_format'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof value.ana_number !== 'string' || !/^\d{10}$/.test(value.ana_number)
      || typeof value.password !== 'string' || !value.password.trim()) {
    throw new SecretError('invalid_secret_format');
  }
  return { anaNumber: value.ana_number, password: value.password };
}

export function secretResource({ project, secret, version }) {
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project)
      || !/^[A-Za-z0-9_-]{1,255}$/.test(secret)
      || !/^(?:[1-9]\d*|latest)$/.test(version)) {
    throw new SecretError('invalid_secret_reference');
  }
  return `projects/${project}/secrets/${secret}/versions/${version}`;
}

export async function readCredentials(config, { execute = runFile, makeClient } = {}) {
  const name = secretResource(config);
  let payload;
  try {
    if (config.secretAuth === 'gcloud') {
      const result = await execute(config.gcloud, [
        'secrets', 'versions', 'access', config.version,
        `--secret=${config.secret}`, `--project=${config.project}`,
        '--quiet', '--no-log-http', '--verbosity=error',
      ], { encoding: 'buffer', maxBuffer: 128 * 1024, timeout: 30000,
        env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: '1' } });
      payload = result.stdout;
    } else if (config.secretAuth === 'adc') {
      const client = makeClient ? makeClient() : new (await import('@google-cloud/secret-manager')).SecretManagerServiceClient();
      try {
        const [version] = await client.accessSecretVersion({ name }, { timeout: 30000 });
        payload = version.payload?.data;
      } finally { await client.close(); }
    } else { throw new SecretError('invalid_secret_auth'); }
  } catch (error) {
    if (error instanceof SecretError) throw error;
    // Provider errors can contain sensitive response bodies. Never forward them.
    throw new SecretError('secret_unavailable');
  }
  if (!payload || Buffer.byteLength(payload) > 64 * 1024) throw new SecretError('invalid_secret_format');
  try { return parseCredentials(payload); }
  finally { if (Buffer.isBuffer(payload)) payload.fill(0); }
}
