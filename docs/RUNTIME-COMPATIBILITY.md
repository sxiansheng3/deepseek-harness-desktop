# Runtime compatibility — Desktop 0.1.17

## Reported failure and cause

On 2026-09-15 the user reported that accepting the automatic Runtime update to
`0.1.6-alpha.1` failed with `missing required packages: dsh-workflow-worker-thread`.
The user also required compatibility with future upstream architecture changes,
using several independent verification methods rather than a version-specific rename.

The official release replaced `workflow-worker-thread` with `workflow-ptc` and
renamed PTC services. Desktop 0.1.16 required old package names and plugin IDs
(`code-runtime`, `llm-deepseek`, `plugin-inventory`) even when the new release no
longer shipped them. A clean official npm installation reproduced the obsolete
package requirement. This was a desktop validation defect, not a network failure.

Upstream reference: https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.1

## Implemented policy

| Upstream change | Desktop handling |
| --- | --- |
| Rename, split or combine internal packages | Recursively inspect the target's required dependency declarations instead of a fixed list; follow Node's nested resolution paths; skip optional dependencies. Reject missing required dependencies and links outside the installation. |
| Move the CLI file | Read the package's `bin.dsh` or string `bin`; retain the old file location for packages without a declaration; confine the resolved entry to its package. |
| Rename plugin IDs or change default feature composition | Parse the default YAML without evaluating `!!js`; let the actual Runtime load its own profile. No hard-coded internal capability IDs. |
| Remove the `web` CLI alias | On an explicit unsupported-command error, try `--profile web`; genuine startup errors are not suppressed. |
| Remove the default-config dump command | Try the alternate CLI form. If both explicitly reject the option, rely on the real Web/API probe. Malformed output and other errors still fail. |
| Change supported launch options | Detect `--no-open` and dynamic port support through help output; retain the legacy reserved-port path. |
| Old unprotected UI or newer token authentication | Probe the actual page and same-origin login redirect, preserve its cookie for the session API. Never follow an external authentication redirect. The probe has a separate home and does not consume the real user's launch token. |
| Change the session protocol or break the Web app | Reject before stopping the old Runtime if HTML, authentication or the desktop's `session/list` contract fails. Do not guess mutation protocols. |
| Local profile/plugin incompatibility | Preserve the existing backup/start/recovery/rollback flow. Only the generated stale module fallback is rebuilt automatically; user configuration is not rewritten speculatively. |
| One release source unavailable | Existing npm/source-build discovery remains independent. All install routes, including bundled archives, now share the same validation path. |

Validation starts a separate child process with an empty temporary Harness home
and workspace. It does not load user credentials, send model prompts, or stop the
current Runtime. It checks the CLI version, the default profile where supported,
actual Web startup, HTTP page, authentication and session-list schema, and stops
the probe in `finally`. The verified package is activated only through the normal
running-task guard, backup and successful startup flow.

This policy automatically tolerates internal refactors. It does not promise
arbitrary future authentication, API, runtime-engine or persisted-data formats.
Those require an explicit adapter and new fixtures. An empty-profile probe also
cannot prove every third-party plugin or every historical model/tool transcript.

## Repeatable acceptance

Run `npm run check`, `npm test`, and `git diff --check`.
Tests cover renamed plugins, nested/transitive dependencies, missing dependencies,
optional packages, escaping links, changed CLI paths, profile-only CLI, missing
config dump support, old/no-token and new/cookie authentication, invalid redirects,
bad pages, changed session API, and isolation/data preservation. Existing tests
cover running tasks, concurrent switches, install failures, backup and rollback.

For a real official npm upgrade:

```sh
npm run runtime:verify-upgrade -- \
  --version <target-runtime-version> \
  --previous <previous-installed-runtime-directory> \
  --work <new-isolated-evidence-directory> \
  --node-bin <bundled-node> \
  --npm-bin <bundled-npm-cli.js>
```

The script copies only the previous program installation, creates a test session,
data marker and external test plugin, installs from official npm, verifies session
and plugin continuity, then rolls back and verifies both restored old data and
preserved post-upgrade data. It writes `acceptance-report.json` and exits nonzero
on failure. No real user home is copied.

Desktop 0.1.17 validation: 89 tests passed; a real `0.1.5-rc.2` to
`0.1.6-alpha.1` npm upgrade, session continuity, test plugin loading and rollback
passed. The installer bundles Runtime `0.1.6-alpha.1`. Packaged desktop UI,
signature/notarization and public online-update evidence are recorded separately
under `dist/release-evidence/0.1.17/`.

## Long update and error dialogs

The same task included a user screenshot showing an automatic update prompt taller
than the display, with unreachable actions. The manual Runtime dialog was already
scrollable, but automatic prompts, desktop update confirmation and failure/startup
messages still used native `showMessageBox` with long `detail` text.

All desktop update/error/startup messages now use `showDesktopDialog`: fixed header
and footer, separately scrollable message/details, word wrapping for long paths,
Escape/close mapped to cancel, and bounds clamped to the current display work area.
The manual Runtime dialog uses the same display-bound calculation and compact CSS
for small windows. Release notes no longer need character truncation to fit.

Rendered tests used the production HTML at 680 x 620 and 488 x 356, with 100 entries.
Both were scrolled to the last entry; Later, Close and Return Harness were clicked.
The small error footer ended at y=355.11 within the 356-pixel viewport. Browser
console warnings/errors were empty. These were isolated layout fixtures; packaged
application action routing is checked separately before release.
