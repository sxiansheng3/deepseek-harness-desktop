# DeepSeek Harness Desktop

DeepSeek Harness Desktop is an Electron shell around the official, open-source DeepSeek Harness. The shell and Harness Runtime have separate release lifecycles: a Harness update installs into a versioned directory and does not require rebuilding the desktop application.

## Current prototype

- Starts the official `@deepseek-ai/dsh` Web profile in a loopback-only child process.
- Loads the existing Harness React UI in a hardened Electron window.
- Stores Harness state under the Electron user-data directory on macOS. Windows keeps downloaded Runtime data under `%LOCALAPPDATA%` so large packages and module mappings do not depend on a roaming profile.
- Follows every published official GitHub Release, including releases marked as Pre-release, and offers a one-click Runtime update.
- Ships the complete current macOS arm64 Harness Runtime inside the signed desktop application. A clean installation copies and verifies that bundled Runtime locally, so first launch does not depend on npm or GitHub being reachable.
- Confirms the matching official npm package exists before offering installation, then shows the GitHub Release notes and source link.
- Shows the Chinese section of bilingual Runtime release notes in a fixed-height, scrollable dialog whose close and update controls remain visible.
- Resolves the operating system proxy through Electron, retries network failures through a direct connection, and never changes system proxy settings.
- Shows a dedicated update screen with the active network route, elapsed work, processed data, and an estimated download/extraction write rate.
- Allows a Runtime installation to run for up to 100 minutes and reports the exact failed stage, attempted network routes, and underlying package-manager error.
- Uses an independent GitHub release channel for the desktop shell. A compact upper-right badge is created only when a higher desktop version has actually been published.
- Shows desktop-shell release notes before downloading, then reports exact percentage, transferred bytes, total bytes, download speed, and the active system-proxy/direct route.
- Retries desktop-shell network failures through a direct connection without changing the operating system's proxy configuration.
- Installs updates beside the active version, switches only after a successful start, and restarts the previous version after a failed start.
- When a newer desktop build carries a newer bundled Runtime, upgrades an existing older Runtime from the local application resources before starting. A later user-installed Runtime is never downgraded.
- Snapshots the Harness home before an update and exposes a one-click rollback that restores both the prior Runtime and its compatible data.
- Verifies the official Web profile still contains the model, MCP, plan, persistence, Skill, subagent, terminal, filesystem, web, workflow, and UI capabilities before accepting an update.
- Stops the Runtime when the desktop application quits.
- Starts newer Harness Web Runtimes with their official `--no-open` switch so the desktop application does not also launch the default browser; older Runtimes are detected and remain compatible.
- Lets newer Harness Runtimes ask the operating system for a free port directly, avoiding a reserve-then-release race during restart.
- If a macOS/Linux update finds an incompatible shared module fallback from an older Runtime, moves only that generated fallback into the recoverable update backups, regenerates it, and retries startup once. Sessions, settings, credentials, profile patches, and profile-local plugins are left unchanged.
- Captures sanitized startup stdout and stderr so a failed update reports the actual upstream startup error without exposing one-time tokens or credentials.
- Preserves the official one-time local launch token introduced by newer Harness Runtimes while continuing to reject non-loopback startup URLs.
- Verifies image capability against the exact configured provider/model route, then persists only models that have successfully read a real image; provider-wide guessing is never used.
- Prefers the official Harness image path, automatically bridges the first undeclared image request through that same model, and restores verified declarations after independent Harness Runtime updates without blocking those updates.
- Prevents native attachments from being re-read through image tools and handles provider-specific thinking controls so ordinary image answers do not expose internal reasoning or duplicate tool workflows.
- Forces Harness session telemetry to `DISABLED` unless the deployment explicitly overrides it.
- Uses the DeepSeek fish mark from the official Harness repository. This desktop application is an independent build and must not be represented as an official DeepSeek distribution.
- Packages separate native Node.js toolchains for Apple Silicon macOS and x64 Windows, while keeping one shared desktop shell and Runtime update flow.
- Installs each Windows Harness Runtime with the bundled npm CLI, so first launch never enters pnpm's global virtual store or asks Windows to create a project symlink.
- Installs Windows packages directly into their final version directory and activates them only after writing a verification marker. This avoids renaming or deleting a freshly populated module tree while Windows Defender or the package manager still has a transient handle open.
- Holds a single-instance lock so installer auto-launch and an extra desktop double-click cannot run two first-install writers at the same time.
- Keeps each Windows Harness home below its matching versioned Runtime. The official profile fallback therefore resolves through the Runtime's real `node_modules` tree without requiring Windows Developer Mode, administrator rights, symlinks, or junctions.

## Development

Requirements: Node.js 22.19+ or 24+, and npm.

The pinned redistributable Node toolchains used by packaged builds live under `vendor/` locally and are intentionally excluded from Git. They contain no application source and can be restored separately before packaging.

```sh
npm install
npm test
npm run check
npm run icons:win
npm start
npm run dist:win
```

See [docs/RELEASING.md](docs/RELEASING.md) for the signed desktop release and independent update-feed process.

For isolated development data:

```sh
DSH_DESKTOP_RUNTIME_ROOT="$PWD/runtime-data" npm start
```

## Update model

Harness updates and desktop-shell updates are intentionally separate.

1. **Harness Runtime update:** the signed macOS application carries the complete Runtime version recorded in `resources/bundled-runtime.json`. Fresh installs copy and verify it locally without npm or GitHub access; upgrades prefer it when it is newer than the active Runtime and never downgrade a later user-installed version. After installation, the application still reads the newest entry from the official GitHub Releases feed, including Pre-releases, confirms that exact `@deepseek-ai/dsh` version exists in the npm registry, installs later releases under `runtime/versions/<version>`, verifies `dsh --version`, starts them, then atomically records them as active. If a GitHub Release has no matching npm package yet, the application reports that it is published but not installable. If startup fails, the previous active version is restarted.
2. **Desktop application update:** required only when Electron integration or desktop UI changes. Packaged builds check the public `sxiansheng3/deepseek-harness-desktop` GitHub release channel. If a newer signed build exists, the local Harness page shows a compact badge; clicking it displays the release notes and downloads through the system network route with a direct fallback. Equal or older releases produce no badge.

The packaged application ships pinned Node, npm, and pnpm tools. npm owns Runtime installation on all platforms. pnpm remains available for the official `dsh plugin` command, with its Windows global virtual store disabled and a hoisted linker selected. Development overrides are available through `DSH_DESKTOP_NODE_BINARY`, `DSH_DESKTOP_NPM_BINARY`, and `DSH_DESKTOP_PNPM_BINARY`.

## Distribution status

The macOS package uses hardened runtime and Developer ID signing when a valid identity is available. Apple notarization additionally requires an App Store Connect API key or a saved `notarytool` keychain profile. A signed but non-notarized package is not described as publicly distributable.

The Windows target is an x64 NSIS installer with Start-menu and desktop shortcuts. It uses the official Harness Windows composition (PowerShell tool and Windows ACL sandbox) and installs the same independently updatable Runtime. The packaged Windows build explicitly carries npm and pnpm under `resources/node/tools` because generic NSIS resource filtering excludes the Node distribution's top-level `node_modules` tree. A publicly trusted Windows build additionally requires an Authenticode certificate; Apple Developer ID credentials cannot sign Windows executables.
