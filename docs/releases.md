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

## One-Time GitHub Setup

The local and GitHub default branches have been renamed to `dev`, and
`release_1.0` and `v1.0.0` have been created and published. Pages uses GitHub
Actions, with release tags (`v*`) permitted by the `github-pages` environment.
The steps below are setup reference, not tasks to repeat for each patch.

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

Additional branch/tag protection rules and review requirements should be
checked separately; they are not implied by the Pages setup. No DNS change
is needed for local development.

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