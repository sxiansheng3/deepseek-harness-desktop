# Runtime build and acceptance

Desktop 0.1.14 separates the installed version, newest GitHub release, and newest installable version. It queries GitHub, npm, and the source-build channel independently. Failed sources add a concise warning; valid sources remain usable. Only a strictly greater upstream version is offered. If npm and a source build have the same version, npm is preferred for new installations. Existing same-version installations stay in place, including when a new build number appears. Build numbers identify immutable artifacts; automatic same-version repair is not implemented.

## Source-built Runtime

The build script checks out an official `dsh-v*` tag, verifies its remote commit and clean source, installs the frozen source lockfile, runs the official build, packs both Harness and vendored framework release families, and packs the Landlock entry. It installs those local tarballs into a fresh consumer and verifies the CLI version and required Web capabilities. The result is a self-contained `node_modules` archive; users do not need Git, a compiler, or a local source build. External npm dependencies are resolved at build time, so a rebuild receives a new build identity; the archive digest identifies the exact tested bytes.

Run on the target operating system and architecture, with the Node version shipped by that desktop distribution:

```sh
npm run runtime:build -- --tag dsh-v0.1.3-alpha.1 --work /path/to/new-build --out /path/to/output --node-bin /path/to/bundled/node
```

The work and output directories must contain only this build's generated data. The script refuses a dirty source checkout, an existing consumer tree, or an existing output archive. A retry can reuse its clean source and generated `dist/`, but a failed consumer install requires a fresh work directory. `runtime-candidate.json` records version, tag, commit, build number, OS, architecture, minimum desktop version, size, SHA-256 and expected release URL. Every acceptance gate starts as `unverified`, so a freshly built candidate cannot be offered to users.

## Verification

```sh
npm run check
npm test
npm run runtime:verify -- --candidate /path/to/output/runtime-candidate.json --archive /path/to/output/harness-VERSION-build.1-darwin-arm64.tar.gz --previous /path/to/previous/runtime --work /path/to/new-acceptance-directory --node-bin /path/to/bundled/node
```

The verifier copies the previous installation into an isolated directory. It creates a local fixture session and plugin, installs the source archive, checks CLI/profile/Web startup, reads and renames the old session, confirms the external plugin reloads, and performs a real rollback. It checks that the old snapshot is restored and post-upgrade changes survive in a separate backup. It makes no model requests and uses no user credentials or production Harness home. A failed check exits nonzero and leaves an explicit incomplete report.

Before public distribution, also open the changed desktop against the new Runtime and check the actual settings, update/cancel/progress, history and plugin flows. The verifier's Web check is HTTP/startup evidence, not screenshot acceptance. For a runtime with a new session format, the metadata fixture is a minimum gate, not proof that every historical model/tool transcript or third-party integration is compatible. Extend acceptance with representative fixtures before a wide rollout. The 0.1.3-alpha.1 release has an upstream session-loading performance caveat; it should not be preferred over a higher verified/installable release.

## Promote and publish

```sh
npm run runtime:promote -- --candidate /path/to/output/runtime-candidate.json --archive /path/to/output/harness-VERSION-build.1-darwin-arm64.tar.gz --report /path/to/acceptance/acceptance-report.json --manifest /path/to/output/runtime-manifest.json
```

Promotion requires the exact archive hash, commit, OS and architecture to match the report. `startup`, `web`, `sessions`, `plugins`, and `rollback` must each contain `status: "pass"` and an evidence description. The local manifest retains prior releases and rejects reuse of an existing version/build/platform/architecture identity. The complete report hash is recorded in the manifest. These scripts do not publish automatically.

Publication order:

1. Upload the archive and report to an immutable release such as `runtime-0.1.3-alpha.1-build.1`. Verify the public download hash and platform identity. Mark Runtime-only releases as pre-release so they cannot replace the desktop shell's Latest release.
2. Publish the prepared `runtime-manifest.json` asset under the dedicated `runtime-channel-v1` release, also marked as pre-release.
3. From a supported older desktop, verify actual channel discovery, download, restart, local version readback and rollback. Release 0.1.14 of the desktop shell is required for existing users to receive this capability.

The client accepts only HTTPS archive URLs inside this desktop repository's GitHub release-download path. It checks size and SHA-256 before archive preflight, rejects escaping paths/links, verifies the installed CLI and capabilities, and activates only after startup. A 404 for the not-yet-created channel is an empty source; other failures produce a warning and do not disable npm.

## Switching and data

Runtime downloads and installation occur while the old Runtime remains available. Before switching, the desktop asks the authoritative local `session/list` endpoint whether any session is running. Unknown or running states stop the switch. After the process stops, its home is snapshotted; a failed switch restores it and restarts the old Runtime. Concurrent update/rollback operations are rejected. Rollback keeps a fresh backup of post-upgrade data and restores the pre-upgrade snapshot; if the old Runtime cannot start, it restores the new data and restarts the current Runtime.

The guard protects known running sessions. It does not add an upstream atomic maintenance lock across independent clients: avoid starting a new external task while a user-confirmed switch is underway. The UI explains that active tasks must finish and that post-upgrade data is retained separately when rolling back.

## Local package retention

After a successful update or desktop startup, the client keeps only the active Runtime and the previous version referenced by rollback state. Older managed version directories and abandoned installation staging directories are removed. A successful rollback consumes the rollback state, so only the restored active program is retained. Failed updates do not trigger cleanup; cleanup failures are logged and retried on a later successful startup without failing the update.

Cleanup never removes session/configuration backups, unknown directories, or symbolic links. If an old version contains a Windows `.harness-home`, it is moved to `backups` before removing the program files. Downloaded source archives are removed after installation (including failures), so rollback uses the already installed previous Runtime without keeping a duplicate compressed archive. Retained data backups have a separate lifecycle and are not subject to the two-program-version limit.
