# Desktop release process

The desktop shell and the upstream Harness Runtime are different products with different version numbers and update feeds.

## Desktop shell

1. Update `version` in `package.json` and `package-lock.json`.
2. Add the user-facing desktop changes to the GitHub Release notes. The application displays these notes before downloading.
3. Run `npm run check` and `npm test`.
4. Restore the pinned Apple Silicon Node distribution under `vendor/node` and run `npm run dist:mac` with the Developer ID identity available.
5. Notarize and staple the application before creating the ZIP, then sign, notarize, and staple the outer DMG.
6. Verify the App and DMG with `codesign --verify --deep --strict`, `xcrun stapler validate`, and `spctl`.
7. Publish a non-draft GitHub Release whose tag is `v<version>`. Upload `latest-mac.yml`, the ZIP named in that file, the ZIP blockmap, the DMG, and the DMG blockmap.

The packaged application checks the public GitHub release channel. Equal or older releases remain invisible. A higher release creates the compact desktop-update badge inside the local Harness UI.

## Harness Runtime

The desktop application reads the official npm `latest` tag for `@deepseek-ai/dsh`. It never uses this repository's desktop release to represent an upstream Harness Runtime version. Runtime release notes are shown only when the official `deepseek-ai/deepseek-harness` GitHub repository has notes for the matching tag.

## Credentials and local data

Never commit Developer ID certificates, App Store Connect keys, Apple IDs, app-specific passwords, `.env` files, downloaded Runtime trees, Harness sessions, or the bundled Node distribution. GitHub release assets contain the signed application, not local user data.
