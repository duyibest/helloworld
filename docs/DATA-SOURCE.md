# ANA data collection: status and contract

## Current status

The dashboard, eligibility rules, snapshot reader/writer, and refresh command are
implemented. An authenticated ANA collector is **not** implemented or connected.
No daily job is provisioned. The default website has no invented seat inventory.
The refresh command imports a normalized feed; it does not search ANA itself.

Scope: ANA Mileage Club awards for one-way SFO → HND/NRT in business, optionally
continuing from the same Tokyo airport to PVG in business or economy. All segments
must be operated by NH, explicitly available, and have enough seats. The full
itinerary must be available in a single ANA award search. Separate legs must not
be joined and presented as a bookable itinerary. Airport changes are excluded.

## Establishing an authorized source

1. User signs into ANA on their own desktop. Never commit credentials, cookies,
   login responses, account numbers, or passenger information.
2. Inspect the authenticated award search, including a known available itinerary,
   waitlist result, no-availability result, and session-expired response.
3. Verify operating carrier separately from marketing carrier. Verify seat counts,
   pricing per traveler, and the full itinerary's availability.
4. Determine a supported, authorized collection method and its rate limits. A
   visible authenticated session is not proof that unattended collection will work.
5. Pause on login expiry, CAPTCHA, 401/403, or a provider block. Record `blocked`
   or `error`; do not turn these into empty successful results. Do not attempt to
   bypass the challenge or evade blocking. A daily job may still need human login.
6. Confirm coverage and connection logic against real ANA results before enabling
   unattended daily runs.

Partner-program feeds cannot stand in for ANA Mileage Club inventory or pricing.
Seats.aero's documented source list does not include ANA Mileage Club:
https://developers.seats.aero/reference/concepts-copy

ANA booking rules: reservations start 355 days ahead at 09:00 JST, ending 96 hours
before the first flight. A displayed year is a calendar horizon, not evidence
that every date has been searched:
https://www.ana.co.jp/en/jp/guide/amc/award/international/application/

## Snapshot schema (version 1)

All timestamps are RFC3339 with explicit UTC offset. `date` is the SFO departure
date. All costs are ANA miles **per passenger, one-way**. `seats` is an observed
count, never inferred from a paid seat map. A source unable to provide a verified
count must use zero; that itinerary will be excluded.

```json
{
  "version": 1,
  "program": "ANA Mileage Club",
  "source": "Name of the authorized ANA collector",
  "generated_at": "2026-11-01T18:00:00Z",
  "scans": [
    {
      "date": "2026-12-01",
      "destination": "HND",
      "status": "complete",
      "checked_at": "2026-11-01T17:59:00Z",
      "itineraries": []
    }
  ]
}
```

The example is a **schema illustration, not real availability**. Do not use it as
production inventory. A complete scan with an empty itinerary list means the
source actually completed that search and found no seats. Omit unsearched dates;
use `blocked` or `error` for failed attempts. Results older than 26 hours are stale.

A confirmed itinerary inside `itineraries` has:

- `id`: stable source identifier; `status`: `available`; `seats`: verified count.
- `miles`: positive integer; `taxes`: optional display string with currency.
- `segments`: ordered legs, each containing `origin`, `destination`, `operator`
  (`NH`, the actual operator), `flight`, `cabin` (`business` or `economy`), `status`
  (`available`), `departure`, `arrival`, and `seats`.

Other statuses such as `waitlisted` or unknown data fail the display eligibility
check. The adapter must establish legal connection times; the dashboard additionally
requires same-airport forward connections under 24 hours. It does not validate
published minimum connection times or ticketing rules itself.

## Refresh pipeline

The same container has two modes:

- No arguments: serve the website and read the snapshot.
- `refresh`: fetch and validate a complete snapshot from `AWARD_FEED_URL` (HTTPS)
  and atomically replace the local file or Cloud Storage object.

Variables:

| Variable | Meaning |
|---|---|
| `SNAPSHOT_FILE` | Local snapshot path for development; no default inventory |
| `SNAPSHOT_BUCKET` | Private Cloud Storage bucket; overrides local file |
| `SNAPSHOT_OBJECT` | Defaults to `availability/latest.json` |
| `AWARD_FEED_URL` | Authorized adapter endpoint, used only by refresh job |
| `AWARD_FEED_TOKEN` | Optional source bearer token; inject from Secret Manager |

The public website never calls ANA on a page request and never exposes credentials.
Cloud Storage uses the workload's metadata identity. The server caches reads for
one minute. Failed writes retain the last snapshot; its timestamps expose age.
After a failed read, cached availability is suppressed until storage recovers.
A newly blocked collector should publish blocked scans rather than silently
serving old positives. A failed refresh job must also be monitored operationally.

## Proposed GCP resources (not created)

Reuse project `yis-project-362902`, service `helloworld`, region `us-west1`.

- Private bucket `yis-project-362902-ana-awards`, uniform bucket access, public
  access prevention. Store the current snapshot only initially.
- Dedicated runtime account `ana-award-web`: object viewer on this bucket.
- Dedicated collector account `ana-award-collector`: object user on this bucket;
  accessor only on its source credential secret if one is needed.
- Cloud Run Job `ana-award-refresh` using the same release image, argument
  `refresh`, one task, zero retries initially, 30-minute timeout. Configure only
  after a working authorized adapter exists.
- Cloud Scheduler `ana-award-daily`, `0 10 * * *`, time zone `Asia/Tokyo` (one hour
  after the daily release). A dedicated scheduler identity gets `roles/run.invoker`
  on this job, using an OAuth token to call the jobs.run API.
- Deployment account `github-deploy` needs `roles/iam.serviceAccountUser` on the
  dedicated web runtime account before the service switches to it. Provisioning
  the collector job would require additional scoped deployment grants.

Bucket, job, Scheduler, Secret Manager, runtime identity changes and related IAM
are intentionally not applied as part of this PR. A scheduled feed import alone
would not solve the ANA login/collection requirement.

## Coverage and daily collection plan

Once the adapter is proven, scan every eligible SFO departure date through the
355-day booking window for HND, NRT, and PVG itineraries. Respect the precise
96-hour cutoff and new-date release time in the adapter. Use the site's supported
date-range requests if available; do not assume a particular undocumented endpoint.
Use serial/limited concurrency, bounded retries for transient failures, checkpointing,
and an explicit status per route/date. Never repeatedly retry authentication blocks.
The initial sweep may take many requests and needs a measured rate budget.

Once-daily scans can miss short-lived seats. Show source timestamps, not a
promise of real-time availability. Notifications and frequent sweeps can be added
only after daily collection is reliable.
