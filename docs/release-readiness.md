# Release Readiness

What stands between `dev` and the next stable release, and how changes are made.
Finished work is recorded in the git history, not here; the state of the code
(what is enforced, what is unfinished) is in the
[developer guide](developer-guide.md#handover-where-things-stand).

## Open items

| Item | Status | What remains |
| --- | --- | --- |
| Merge protection | Checks pass; protection not enabled | **Regression Checks** runs the regression gate, the type check and four browser-test shards on every push to `dev` and on pull requests (see [releases](releases.md#automated-regression-gate)). Require those checks in the `dev` and `release_*` branch rulesets (see [releases](releases.md#branch-protection)). |
| Prebuilt KiCad index on the live site | Implemented, not yet verified | Stable releases publish `assets/kicad-index.json`, which the app loads before falling back to fetching the index live; a weekly workflow reports when it is missing or behind KiCad (see [releases](releases.md#kicad-library-index)). The first release that includes it verifies it on clearpcb.org. |
| Licence and notices | Pending | A standalone licence and third-party notices file for the distributed site, and approval to distribute. |
| Release acceptance | Pending | Run the gate, type check and browser tests on the final revision; test real boards in the browser; have the manufacturing output (Gerber, drill, BOM, pick-and-place) reviewed independently; record known limitations; approve the release. |

Decided against for now: exact recovery of a live editing session. Recovery
restores the last serialized project, so Undo history and the selection are not
restored after a crash.

## How changes are made

- Keep changes to one concern per commit, with a message that says what changed
  and why. Push only what has passed the routine in the
  [developer guide](developer-guide.md#before-you-commit), and check that CI is
  green afterwards.
- Keep existing behaviour and user-facing contracts unless the change is meant to
  alter them, and then update the contract page in the same commit. A failing test
  is investigated, not weakened to make the gate pass.
- Do not modify users' board files, and do not tag or publish a release without
  the owner's approval.
- A green test run is necessary but not sufficient for a release: review the
  change for consistency with the architecture, performance and the docs.
