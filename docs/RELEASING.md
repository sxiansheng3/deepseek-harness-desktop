# Desktop release process

The desktop shell and the upstream Harness Runtime are different products with different version numbers and update feeds.

## Desktop shell

1. Update `version` in `package.json` and `package-lock.json`.
2. Add the user-facing desktop changes to the GitHub Release notes. The application displays these notes before downloading.
3. Run `npm run check` and `npm test`.
4. Restore the pinned Apple Silicon Node distribution under `vendor/node` and run `APPLE_KEYCHAIN_PROFILE=<saved-profile> npm run dist:mac` with the Developer ID identity and validated `notarytool` Keychain profile available. The profile name is not a secret; its stored credentials are.
5. The macOS `afterPack` hook verifies the bundled archive hash, discovers every Mach-O file inside it by content, signs and verifies each native dependency with Developer ID, timestamp and hardened runtime, then updates only the packaged archive/manifest. This handles new upstream packages and executable names without a frozen file list. Inspect `dist/mac-arm64/bundled-runtime-signing.json`. Notarize and staple the application before creating the ZIP, then sign, notarize, and staple the outer DMG.
6. Verify the App and DMG with `codesign --verify --deep --strict`, `xcrun stapler validate`, and `spctl`.
7. Publish a non-draft GitHub Release whose tag is `v<version>`. Upload `latest-mac.yml`, the ZIP named in that file, the ZIP blockmap, the DMG, and the DMG blockmap.

The packaged application checks the public GitHub release channel. Equal or older releases remain invisible. A higher release creates the compact desktop-update badge inside the local Harness UI.

## Harness Runtime

The desktop checks GitHub releases, npm, and the verified source-build channel independently. The highest installable version for the current platform is offered; a missing npm version or failed remote source does not erase local status. Official npm wins ties. Source-build archives are keyed by upstream version, build number, platform, and architecture, and must carry SHA-256, exact upstream tag/commit, minimum desktop version, and completed acceptance evidence.

Use the commands and publication order in [RUNTIME-UPDATES.md](RUNTIME-UPDATES.md). Building creates an ineligible candidate. Verification and promotion prepare a local channel manifest; none of these commands commits, pushes, or publishes anything. Upload the immutable Runtime archive and acceptance report before updating `runtime-channel-v1/runtime-manifest.json`. Keep that channel release marked as pre-release so it does not become the desktop shell's Latest release. The first desktop supporting this channel is 0.1.14.

## Credentials and local data

Never commit Developer ID certificates, App Store Connect keys, Apple IDs, app-specific passwords, `.env` files, downloaded Runtime trees, Harness sessions, or the bundled Node distribution. GitHub release assets contain the signed application, not local user data.
