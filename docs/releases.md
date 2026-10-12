# Release Workflow

## Channels

- `dev`: default development branch. Test with a local HTTP server.
- `release_1.0`: maintained 1.0 release line (`v1.0.x` patches).
- `release_1.1`, etc.: future release lines, created from tested development commits
  (see [New Release Line](#new-release-line)).
- `v1.0.0`, `v1.0.1`, etc.: immutable tags identifying individual releases.
- `https://clearpcb.org`: stable only, deployed from a published final GitHub Release.

There is no hosted development site and no additional Pages repository.
Normal pushes, draft releases, and prereleases do not deploy stable.
`assets/version.json` holds the next planned version during development; the release
package stamps the app version from its tag. Project format `1.0` and ZIP container
version `1` are separate from app release versions.

The experimental MCP Worker is deployed separately through the **Deploy MCP
Worker** workflow. GitHub Pages continues to serve the application; Cloudflare
intercepts only `clearpcb.org/mcp*`. See [mcp.md](mcp.md) for the required
Cloudflare zone, repository secrets, local testing, and security limitations.

## Automated Regression Gate

**Regression Checks** runs on pushes and pull requests targeting `dev` and
`release_*`, and can be started manually. Its **Regression gate** job runs
`node tools/regression.mjs` on Node 22: the import-boundary check, the PCB,
schematic and shared private-access checks, the doc-reference check, every unit
regression test, and the autorouter clearance baseline. Any hard failure fails
the job. Track/via-count differences remain visible soft warnings, not evidence
that routing quality is unchanged.

Its **Strict type check** job installs TypeScript 5.9.3 and runs `node tools/typecheck.mjs`,
which runs one strict `checkJs` pass on `src/` with `jsconfig.json`. Any
TypeScript error fails the job. Use the same TypeScript version locally (installed as
in the [README](../README.md#testing)). Vendored modules are not checked:
`assets/vendor/fflate.module.d.ts` declares the fflate API in use.

Its **Browser tests** jobs install Playwright 1.55.0 with Chromium (with short apt
network timeouts and up to three bounded attempts, so a stalled package mirror cannot
hold a job until it times out) and run
`node tools/browser-test.mjs --shard=i/4`: four jobs run in parallel, each taking
every fourth scenario, so together they run every scenario once. Each scenario in `tests/browser/` gets a fresh
browser context against `tools/serve.mjs`, offline: requests to any other host
(the KiCad library proxy, GitLab, LCSC) are refused, so the scenarios cannot depend
on external services. They drive the real app with real
pointer input: switching modes, drawing and undoing tracks, the WebGL 3D view,
Properties panel edits and their shared control order, track/shape conversions,
schematic selection and cancellation, reopening a board through autosave
recovery, and speed checks of pointer moves, panel rebuilds, pour refresh and
picture import on a large board, which print their timings to the job log. Any uncaught page error fails the scenario; failure screenshots are
uploaded as the `browser-test-failures-<shard>` artifact.

**Publish Stable Release** independently runs the same gate against the checked-out
release tag before packaging, uploading the downloadable ZIP, or deploying.
A failed gate leaves the existing stable deployment untouched. GitHub may already
show the release as published; this check blocks distribution by the workflow,
not creation of the release entry itself.

## KiCad Library Index

The schematic component picker needs the names of every KiCad symbol and footprint.
Building that list live takes about 380 GitLab API pages per new visitor, all through
the Cloudflare CORS proxy. Instead, **Publish Stable Release** runs
`node tools/build-kicad-index.mjs dist/assets/kicad-index.json` after packaging. It
calls GitLab directly, at the latest stable KiCad library tag, and validates the
result with the same rules as the app
(`src/components/kicad-index-format.js`). The file is about 1.2 MB, 170 KB gzipped,
and is not committed.

The app loads `assets/kicad-index.json` first and takes its KiCad tag as the release
for symbol and footprint lookups. If the file is missing or invalid (a local
checkout, or a release whose index build failed), the app falls back to live loading
through the proxy. A GitLab outage therefore does not block a release: that step is
`continue-on-error`.

**KiCad Index Check** runs every Monday and on demand. It fails when clearpcb.org has
no valid index, or when KiCad has published a newer library release than the deployed
index. Publish a ClearPCB release (a patch release is enough) to rebuild it. To build
one locally, run `node tools/build-kicad-index.mjs assets/kicad-index.json` (git-ignored).

After pushing the workflow and seeing its first successful hosted run, configure
the `dev` and `release_*` branch rulesets to require **Regression gate** before
merging. Workflow files alone do not enable branch protection. Hosted execution
and ruleset configuration must be verified in GitHub; a local pass does not
prove those settings are active.

The outstanding release evidence and working agreements are maintained in
[Release Readiness](release-readiness.md).

## Patch Release Using the GitHub Website

Use this checklist after testing, committing, and pushing a fix on `dev`.
The example publishes app version `1.0.1` from the existing `release_1.0`
branch. For later patches, use the next unused tag, such as `v1.0.2`.

Keep VS Code on `dev` throughout these website steps. The branch dropdown on
GitHub does not change your local VS Code checkout.

### 1. Create a Pull Request on github.com

1. Open [the ClearPCB repository](https://github.com/ma261065/ClearPCB).
2. Select **Pull requests > New pull request**.
3. Set **base: `release_1.0`** (the branch receiving the fix).
4. Set **compare: `dev`** (the branch supplying the fix).
5. Review **Commits** and **Files changed**. Include only tested changes that
   belong in this release. This comparison includes all differences from
   `dev`, not just its most recent commit. If unrelated or unfinished changes
   appear, stop: use a dedicated patch branch with selected fixes instead.
6. Click **Create pull request**, enter a descriptive title, and submit it.

The direction is **dev into release_1.0**, not the other way around.

### 2. Merge on github.com

1. On that pull request page, confirm the destination is `release_1.0`.
2. After reviewing the changes and any required checks, click
   **Merge pull request > Confirm merge**. Prefer a normal merge commit for
   this long-lived branch workflow so later comparisons retain shared history.
3. **Do not delete `dev`** if GitHub offers to delete the source branch.

There is no branch to switch to for this button: the pull request already
defines its source and destination. Merging alone does not deploy the site.

### 3. Publish on github.com

1. Open [Releases](https://github.com/ma261065/ClearPCB/releases) and click
   **Draft a new release**.
2. In **Choose a tag**, enter `v1.0.1` and select **Create new tag on publish**.
   The leading **`v` is required**: `1.0.1` is not a valid stable-release tag.
   Use a new tag; never reuse or move `v1.0.0` or another published tag.
3. Set **Target** to **`release_1.0`**, not `dev`. The new tag will identify
   the release branch's current commit, including the merged fix.
4. Enter the title **ClearPCB 1.0.1** and describe the changes. For example:
   "Improved PCB loading and zoom performance by caching and batching
   copper-cutout calculations."
5. Leave **Set as a pre-release** unchecked and mark the release **Latest**.
6. Review the tag, target branch, and notes, then click **Publish release**.

Publishing is the action that triggers deployment to `clearpcb.org`.
The workflow stamps app version `1.0.1` into the package automatically;
the project file format remains `1.0`.

### 4. Check Deployment on github.com

1. Open **Actions > Publish Stable Release**, then the run for `v1.0.1`.
2. Wait for both **package** and **deploy** to succeed. A published release
   does not mean deployment has finished.
3. Open `https://clearpcb.org` and check the displayed version. Save any open
   work before reloading an existing app tab.
4. If deployment fails, inspect the failed job and its annotations. If tags
   are blocked, check **Settings > Environments > github-pages > Deployment
   branches and tags**: the allowed tag rule is `v*`, not a `main`-only rule.
   After fixing the cause, use **Re-run jobs > Re-run failed jobs**. Do not
   recreate the release or move its tag merely to retry deployment.

### If validation says "Stable releases must use tags such as v1.0.0."

Check the failed step's `RELEASE_TAG` value. The tag must be exactly
`vMAJOR.MINOR.PATCH`, for example `v1.0.4`, not `1.0.4`. Changing the release
title does not change its tag, and rerunning the same job will fail again.

For a mistakenly published `1.0.4` tag:

1. Check that `release_1.0` contains the tested commit intended for release.
2. Create a new release with the unused tag **`v1.0.4`**, targeting
   **`release_1.0`**. If that tag already exists, verify its commit before using
   it; do not overwrite it.
3. Mark the corrected release **Latest**, leave prerelease unchecked, and
   publish it.
4. Check the new **Publish Stable Release** run, not a rerun of the failed
   `1.0.4` run. Both **package** and **deploy** must succeed.

Leave the original tag unchanged. Add a note to the mistaken release pointing
to the corrected release so users know which one to use. A failure at this
validation step occurs before packaging or deployment and leaves the stable
site unchanged.

### Branch and Version Reference

| Item | Purpose |
| --- | --- |
| `dev` | Everyday development; committing or pushing does not deploy stable. |
| `release_1.0` | Maintained release branch for all `1.0.x` patches. |
| `v1.0.1` | Immutable tag for one exact patch release commit. |
| GitHub Release | Release notes and downloads associated with a tag; publishing a final Latest release triggers deployment. |
| `release_1.1` | A new branch for a future 1.1 release line, not needed for a 1.0 patch. |

Continue development in VS Code on `dev`. No local branch switch or pull is
needed merely because you merged into the remote release branch. There is
no public `clearpcb.org/dev` site; local testing uses `http://localhost:8000`.

## Repository Settings

These GitHub settings are in place; this is reference for checking or recreating
them, not a per-release task.

- **Settings > General > Default branch** is `dev`.
- **Settings > Pages > Build and deployment > Source** is **GitHub Actions**, with
  the custom domain `clearpcb.org` and HTTPS enforced. Pushes do not deploy.
- **Settings > Actions > General** permits the workflows' action dependencies and
  token permissions. They use the automatic `GITHUB_TOKEN`; no personal token is
  needed. The release workflow must exist on the default branch.
- **Settings > Environments > github-pages** permits release tags (`v*`) as
  deployment sources, with no main-only restriction. Require your approval before
  deployment if that option is available.
- Rulesets for `dev`, `release_*` and release tags disallow force pushes and
  deletion of released history, require reviewed changes on release branches, and
  permit creating new release tags but not rewriting them.

No DNS change is needed for local development.

### Branch Protection

Make the CI jobs merge-blocking (repository admin, on github.com):

1. Let each job run at least once on `dev`, so GitHub knows the check names.
2. **Settings > Rules > Rulesets > New branch ruleset**: name it
   `dev and release branches`, set **Enforcement status** to Active, and add the
   target branch patterns `dev` and `release_*`.
3. Enable **Restrict deletions**, **Block force pushes** and **Require a pull
   request before merging** (one approval for `release_*` if reviewers exist).
4. Enable **Require status checks to pass**, tick **Require branches to be up to
   date before merging**, and add the checks `Regression gate`, `Type check` and
   `Browser tests (1/4)` to `Browser tests (4/4)` (source: GitHub Actions).
5. Save, then open a test pull request to confirm the six checks are listed as
   required.

## New Release Line

Start a new `release_MAJOR.MINOR` line (for example `release_1.1` and `v1.1.0`)
only after testing and committing the intended release content on `dev`.

1. Freeze a release branch from the tested development commit:

   ```powershell
   git switch dev
   git switch -c release_1.1
   git push -u origin release_1.1
   ```

2. Test that branch locally. At minimum, verify new/save/open/autorecovery,
   schematic and PCB editing, image import, panelization, Gerber exports,
   worker/WASM loading, and PWA loading. Verify `2.0` files are rejected and
   unsupported multilayer files leave the current document untouched.
3. Run the complete automated gate on the intended release revision:

   ```powershell
   node tools/regression.mjs
   ```

   Review any soft warnings as well as failures. A passing gate is necessary,
   but does not replace the manual checks above or independent fabrication review.

4. Inspect the deployable package with `node tools/package-release.mjs v1.1.0`.
   It creates a new `dist` directory and refuses to reuse an existing one;
   remove only that generated directory before rerunning. Serve `dist` locally
   and check asset/worker loading. The package excludes tests, tools, benchmark
   outputs, and local project documents, and stamps the version from the tag into
   its `assets/version.json`. Development source files are unchanged.
5. Tag the tested release commit and push the tag:

   ```powershell
   git tag -a v1.1.0 -m "ClearPCB 1.1.0"
   git push origin v1.1.0
   ```

6. In GitHub **Releases**, draft release `v1.1.0` from that existing tag, add
   release notes and any format-compatibility warning, and review before
   publishing. Mark it **Latest**, not a prerelease. Publishing is the explicit
   deployment action; pushing the tag alone does not deploy.
7. Check **Publish Stable Release** in Actions. It verifies the tag belongs to
   its `release_MAJOR.MINOR` branch, adds `ClearPCB-v1.1.0.zip` to the release, and
   deploys the same packaged site to Pages. Confirm the displayed version and
   stable workflows.
8. Return to `dev` for ongoing work and set `assets/version.json` to the next
   planned version.

## Maintenance

Patch fixes belong on the relevant release branch and should also be carried
back to `dev` by merge or cherry-pick. Test and tag the next patch version;
never move an existing release tag. Stable deployment requires the tag's
commit to be reachable from its corresponding `release_MAJOR.MINOR` branch.

Only the GitHub Release marked **Latest** may deploy. A previous release-line
patch can be published without replacing a newer stable site; its deployment
workflow will stop at the latest-release guard. To roll back, revert the bad
change on the maintained release branch and publish a new patch release.
Do not repoint a historical tag. Workflow reruns are supported for deployment
failures, but do not modify release assets or tags after distributing them.

## Compatibility Warning

New saves use project format `1.0`. Pre-release `2.0` projects and recovery
snapshots are intentionally rejected, with no automatic migration. Retain the
matching app revision and backups for work that must remain accessible. This is a
breaking pre-release transition, not a numeric downgrade migration.

The format supports ordered multilayer copper and via spans, but the current
editor only accepts two-layer boards. Review `clearpcb_file_format.md` before
adding multilayer editing or other manufacturing features.