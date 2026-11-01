# Hello World

A Go HTTP server that responds with exactly `hello world`.

## Local development

```bash
bazel build //:helloworld
python3 scripts/check-server.py
bazel run //:helloworld
```

The default port is 8080. To choose another port:

```bash
PORT=9090 bazel run //:helloworld
```

## CI/CD

`.github/workflows/ci.yml` checks formatting, builds with Bazel, and verifies HTTP
responses for pull requests targeting `main` and pushes to `main`.

After the checks pass on a push to `main`, a separate deployment job builds the
pure Go Linux binary with Bazel, packages it in a minimal non-root container,
pushes a commit-tagged image to Artifact Registry, and deploys its immutable
digest to the existing Cloud Run service. It verifies the public HTTP response
after deployment. A failed post-deployment check marks the workflow failed; it
does not automatically roll back the release.

Target: `yis-project-362902`, `us-west1`, Cloud Run service `helloworld`.
The existing service's runtime identity, public access, scaling, and resource
settings are retained. Cloud Build is not used by this workflow.

### One-time Google Cloud setup

The project uses a shared deployment account and identity pool, reusable by
explicitly approved repositories. Initially, only `duyibest/helloworld` is trusted.
Adding a repository later requires updating the provider allowlist and the
service account's federation binding; sharing the account does not automatically
trust all repositories owned by duyibest.

An administrator must configure these resources before merging this workflow:

- Service account: `github-deploy@yis-project-362902.iam.gserviceaccount.com`.
- Workload identity pool: `github-actions`, provider `github`.
- Trust GitHub OIDC only for repository ID `1442041287`, owner ID `32662916`,
  push events on `refs/heads/main`, and workflow
  `duyibest/helloworld/.github/workflows/ci.yml@refs/heads/main`.
- Grant the matching federated repository identity `roles/iam.workloadIdentityUser`
  on that deployment service account.
- Grant the deployment account `roles/artifactregistry.writer` on the existing
  `us-west1/cloud-run-source-deploy` repository.
- Grant it `roles/run.developer` on the existing `helloworld` service.
- Grant it `roles/iam.serviceAccountUser` on the service's existing runtime account,
  `337849585342-compute@developer.gserviceaccount.com`.
- Enable IAM, IAM Service Account Credentials, and Security Token Service APIs.

All allowed repositories share the deployment account's granted permissions.
Initially, Cloud Run access is scoped to the existing `helloworld` service;
Artifact Registry access covers all images in `cloud-run-source-deploy`.
`roles/iam.serviceAccountUser` lets deployed code execute with the existing runtime
account's permissions. This setup does not add project-wide Editor, Owner,
Cloud Run Admin, or Service Account Token Creator roles. It does not grant the
deployment account permission to modify IAM policy.

No service-account keys or GitHub repository secrets are required. Anyone able to
merge workflow changes into main can exercise these deployment permissions.

### Container build locally (optional)

Docker is needed only for this optional local command; GitHub runners include it.

```bash
bazel build //:helloworld
mkdir -p dist
cp bazel-bin/helloworld_/helloworld dist/helloworld
docker build -t helloworld .
docker run --rm -p 8080:8080 helloworld
```

### GitHub settings

After CI has run, optionally add a main-branch ruleset requiring the
`Format, build, and HTTP checks` status before merge. The workflow itself does
not enforce a merge restriction.
