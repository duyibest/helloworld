# ANA login-only pilot

This is a separate Node/Playwright component. The public Go website never reads
ANA credentials. This pilot does not search flight dates, book flights, run on a
schedule, or grant cloud permissions.

## Current verification boundary

Unit and browser-fixture tests validate the Secret Manager readers, input safety,
and login state machine. They do **not** establish that ANA's current live form
matches the expected layout or that unattended ANA login will work. An actual
successful authenticated search still needs verification with the test account.

The GCP secret `ana-award-credentials` currently needs an enabled version whose
value is JSON:

```json
{"ana_number":"YOUR_10_DIGIT_ANA_NUMBER","password":"YOUR_ANA_WEB_PASSWORD"}
```

Use the GCP Secret Manager console or the private local credential-entry helper.
Never put credentials, cookies, or session URLs in source files, shell arguments,
GitHub, PR comments, or chat.

## Run on the current Ubuntu desktop

Node/npm and full Chromium have been installed under the Ubuntu user's home for
this pilot. Dependencies are installed locally in the ignored `node_modules`.

```bash
cd ~/code/helloworld
./collector/run-login.sh --version 1
```

This uses the existing `gcloud` login and reads version 1 into process memory.
It never runs `gcloud auth login` or prints the secret. A missing/disabled version
or insufficient access produces `secret_unavailable` after the login form is ready.

The default entry is the stable ANA award-search URL. Its redirects can change
routing prefixes and session parameters. A fresh, explicitly supplied ANA login
URL can instead be piped into the process without putting it in shell history:

```bash
python3 -c 'import getpass; print(getpass.getpass("ANA login URL (hidden): "))' \
  | ./collector/run-login.sh --login-url-stdin --version 1
```

The private URL is read from stdin, kept in memory, and never included in results.
A URL copied from another browser may depend on that browser's session; it is not
a durable entry point and is not automatically reused by later runs.

## Browser behavior

Use full Chromium's new headless mode by default (`channel=chromium`), rather than
Playwright's separate headless shell. To compare with installed Google Chrome:

```bash
./collector/run-login.sh --channel chrome --version 1
```

Google Chrome must be installed **inside the same Linux environment** for that
channel. A Chrome instance on Windows is separate. `--headed` requires a graphical
display; `--executable /absolute/path/to/chrome` can select another local binary.

The pilot:

1. Opens ANA and waits a bounded time for the login form.
2. Requires HTTPS on `aswbe-i.ana.co.jp`, the expected login path, exactly one
   visible password field, one account field, and one login button in a POST form
   targeting that same ANA origin. Ambiguous layouts fail closed.
3. Reads `{ana_number,password}` from Secret Manager only after those checks.
4. Fills the form and submits **once**, with no credential retry loop.
5. Requires an ANA award-search URL, a visible Logout control, search-form inputs,
   and no visible password field to report `authenticated`.
6. Stops for CAPTCHA, verification codes, wrong credentials, or unexpected pages.

These recognition rules may need adjustment after inspecting the real login/search
pages. A disappearing password field or generic Welcome page is not enough.

Output contains only fixed stage/status names and the browser version. It never
prints page text, full URLs, credential values, exceptions, or provider response
bodies. No screenshots, network traces, HARs, or videos are recorded. Playwright
interactive/debug logging is rejected because it can expose filled values.

Important status codes:

| Status | Meaning |
|---|---|
| `authenticated` | Award-search page and authenticated UI markers observed |
| `login_not_ready` | No usable login form appeared before the deadline |
| `unrecognized_login_form` | Form layout is ambiguous or unsupported |
| `unsafe_login_form` | Form would send data to an unexpected destination/method |
| `secret_unavailable` | Secret Manager access/version failed; no login submitted |
| `invalid_secret_format` | Secret does not contain the expected JSON fields |
| `needs_human` | Challenge or verification code detected; no automated solving |
| `blocked` | ANA returned 403/429 or a recognized access-block message |
| `site_unavailable` | ANA returned a server error; no login submitted |
| `login_rejected` | ANA displayed a recognized credential error; no retry |
| `login_unverified` | Submitted once, but positive login evidence was not found |
| `overall_timeout` | Overall deadline exceeded; browser is closed |

## Optional private session state

Nothing is saved by default. After a **verified** login, explicitly opt into
saving cookies outside the repository:

```bash
./collector/run-login.sh --version 1 \
  --session-file "$HOME/.local/state/ana-awards/session.json"
```

The file is written atomically with mode 0600. Treat it as a credential. This pilot
does not yet reload the saved state or publish it to GCP; that belongs to the
future date-search collector. A session-file destination inside this repository
is rejected.

## Installation elsewhere

Requires Node 22+ and Linux browser dependencies:

```bash
cd collector
npm ci --ignore-scripts
npx playwright install --with-deps --no-shell chromium
npm test
npm run test:browser
```

The Ubuntu wrapper additionally supports the private shared libraries prepared
under `~/.local/lib/ana-browser`; it does not change global loader settings.

## Future Cloud Run authentication

Use `--secret-auth adc --version 1` to use the official Secret Manager SDK with
Application Default Credentials. On Cloud Run, the SDK uses the assigned service
account. Grant that account Secret Accessor only on the ANA credential secret
before running the collector. No collector service account, job, IAM grant, or
scheduler is created by this PR. The web image does not include this collector.

Production should use an explicitly selected secret version; rotate by uploading
a new version and updating configuration. Local `--version latest` is available
for a deliberate troubleshooting run.

## Tests

Tests use fake credentials and intercepted fixtures, without Secret Manager access
or real ANA login submissions. They cover authenticated UI confirmation, wrong
passwords, human challenges, ambiguous/external forms, missing secrets, and timeouts.
The tests do not use your saved browser profile or the real ANA secret.

References:
- https://playwright.dev/docs/browsers#chromium-new-headless-mode
- https://docs.cloud.google.com/secret-manager/docs/access-secret-version
