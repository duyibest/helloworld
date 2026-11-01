# Pacific Seat — ANA award watch

A Go website for ANA Mileage Club awards from SFO to Tokyo and Shanghai, deployed
on the existing Cloud Run service. Pacific flights require ANA-operated business
class; Tokyo → PVG may be business or economy. Waitlists are excluded.

**Live collection is not connected.** The app starts with a truthful unsearched
calendar. It does not fabricate award inventory. See [data-source setup and daily
job design](docs/DATA-SOURCE.md) for the remaining authenticated ANA integration.

## Develop in Ubuntu

```bash
cd ~/code/helloworld
bazel test //:server_test
bazel build //:helloworld
python3 scripts/check-server.py
bazel run //:helloworld
```

Open http://localhost:8080. Use `PORT=9090 bazel run //:helloworld` for a different
port. Assets are embedded by Go and Bazel; no Node build or external fonts needed.

## Data

`GET /api/availability?passengers=1` returns the current calendar, source state,
coverage, and qualifying itineraries. `GET /healthz` is a process health check;
it intentionally does not claim the collector is healthy.

For development, set `SNAPSHOT_FILE` to a normalized snapshot following the
[contract](docs/DATA-SOURCE.md). In Cloud Run set `SNAPSHOT_BUCKET` after a private
bucket and scoped IAM are provisioned. No snapshot configuration means no source.
The public API is read-only. There is no public refresh or import endpoint.

The `refresh` command imports a validated snapshot from an authorized HTTPS
adapter; it does not log into or scrape ANA. Collection is a separate prerequisite.

## CI/CD

GitHub Actions checks Go formatting, builds with Bazel, tests eligibility and
HTTP handling, and smoke-tests the server on default and custom ports. After a
merge to main it builds the container, pushes an immutable image, and deploys to
`helloworld` in project `yis-project-362902`, region `us-west1`.
Deployment success is determined by `gcloud run deploy`, without comparing page
content to an expected text file. Workflow authentication uses the existing
shared `github-deploy` service account and `github-actions` identity pool.

The minimal distroless container includes CA roots for outbound HTTPS; it runs as
a non-root user. GCP data storage and scheduling are not yet provisioned.
