# Release Workflow

## Channels

- `dev`: default development branch, replacing `main`. Test with a local HTTP server.
- `release_1.0`: maintained 1.0 release line, created when ready to freeze it.
- `release_1.1`, etc.: future release lines, created from tested development commits.
- `v1.0.0`, `v1.0.1`, etc.: immutable tags identifying individual releases.
- `https://clearpcb.org`: stable only, deployed from a published final GitHub Release.

There is no hosted development site and no additional Pages repository.
Normal pushes, draft releases, and prereleases do not deploy stable.
`assets/version.json` is `1.0.0-dev` in development; the release package stamps
the app version from its tag. Project format `1.0` and ZIP container version
`1` are separate from app release versions.

## One-Time GitHub Setup

The local branch has been renamed from `main` to `dev`. No remote rename,
push, release branch, tag, or release was created by this preparation.

1. Before pushing these changes, open repository **Settings > Pages** and
   change **Build and deployment > Source** to **GitHub Actions**. This prevents
   development pushes from deploying via the old branch-based Pages setup.
   Keep the custom domain `clearpcb.org` and HTTPS setting. The existing site
   should remain until the next deployment; verify this in GitHub.
2. In GitHub's branches page, rename `main` to `dev` (do not create a duplicate
   branch and leave `main` behind). Confirm **Settings > General > Default
   branch** now names `dev`. GitHub may require you to update protection rules.
3. After the remote rename, update local tracking:

   ```powershell
   git fetch origin --prune
   git branch --set-upstream-to=origin/dev dev
   ```

4. Review and commit the prepared changes, then push `dev`. The release
   workflow must exist on the default branch before a release is published.
5. In **Settings > Actions > General**, permit the workflow's GitHub Actions
   dependencies and the token permissions requested by the workflow. It uses
   the automatic `GITHUB_TOKEN`; no personal token is needed.
6. In **Settings > Environments > github-pages**, permit release tags (`v*`)
   as deployment sources. If available for this repository, require your
   approval before deployment. Remove any obsolete main-only restriction.
7. Add rulesets for `dev`, `release_*`, and release tags. Disallow force pushes
   and deletion of released history; require reviewed changes on release
   branches. Permit creating new release tags but prohibit rewriting them.

GitHub CLI was unavailable locally, so these settings have not been applied
or verified. No DNS change is needed for local development.

## First Release

Do these steps only after testing and committing the intended release content.

1. Freeze a release branch from the tested development commit:

   ```powershell
   git switch dev
   git switch -c release_1.0
   git push -u origin release_1.0
   ```

2. Test that branch locally. At minimum, verify new/save/open/autorecovery,
   schematic and PCB editing, image import, panelization, Gerber exports,
   worker/WASM loading, and PWA loading. Verify `2.0` files are rejected and
   unsupported multilayer files leave the current document untouched.
3. Run the focused automated checks after approving test execution locally:

   ```powershell
   node tests/test-project-lifecycle.mjs
   node tests/test-project-recovery.mjs
   node tests/test-autosave-revision.mjs
   node tests/test-track-id-recovery.mjs
   node tests/test-board-shape-serialization.mjs
   node tests/test-panelization.mjs
   node tests/test-picture-tracing-dialog.mjs
   ```

4. Inspect the deployable package with `node tools/package-release.mjs v1.0.0`.
   It creates a new `dist` directory and refuses to reuse an existing one;
   remove only that generated directory before rerunning. Serve `dist` locally
   and check asset/worker loading. The package excludes tests, tools, benchmark
   outputs, and local project documents. Development source files are unchanged.
5. Tag the tested release commit and push the tag:

   ```powershell
   git tag -a v1.0.0 -m "ClearPCB 1.0.0"
   git push origin v1.0.0
   ```

6. In GitHub **Releases**, draft release `v1.0.0` from that existing tag, add
   release notes and the format-compatibility warning, and review before
   publishing. Mark it **Latest**, not a prerelease. Publishing is the explicit
   deployment action; pushing the tag alone does not deploy.
7. Check **Publish Stable Release** in Actions. It verifies the tag belongs to
   `release_1.0`, adds `ClearPCB-v1.0.0.zip` to the release, and deploys the same
   packaged site to Pages. Confirm the displayed version and stable workflows.
8. Return to `dev` for ongoing work; bump its app label to the next planned
   development version (for example `1.1.0-dev`).

## Maintenance

Patch fixes belong on the relevant release branch and should also be carried
back to `dev` by merge or cherry-pick. Test and tag the next patch version;
never move an existing release tag. Stable deployment requires the tag's
commit to be reachable from its corresponding `release_MAJOR.MINOR` branch.

Only the GitHub Release marked **Latest** may deploy. An older release-line
patch can be published without replacing a newer stable site; its deployment
workflow will stop at the latest-release guard. To roll back, revert the bad
change on the maintained release branch and publish a new patch release.
Do not repoint a historical tag. Workflow reruns are supported for deployment
failures, but do not modify release assets or tags after distributing them.

## Compatibility Warning

New saves use project format `1.0`. Pre-release `2.0` projects and recovery
snapshots are intentionally rejected, with no automatic migration. Retain the
old app revision and backups for work that must remain accessible. This is a
breaking pre-release transition, not a numeric downgrade migration.

The format supports ordered multilayer copper and via spans, but the current
editor only accepts two-layer boards. Review `clearpcb_file_format.md` before
adding multilayer editing or other manufacturing features.