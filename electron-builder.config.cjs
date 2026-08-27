const path = require('node:path')
const notaryProfile = process.env.DSH_DESKTOP_NOTARY_PROFILE?.trim()

module.exports = {
  appId: 'com.songtao.deepseek-harness-desktop',
  productName: 'DeepSeek Harness Desktop',
  copyright: 'Copyright © 2026 tao song. DeepSeek is a trademark of its respective owner.',
  asar: true,
  files: [
    'src/**/*',
    'package.json',
  ],
  directories: {
    buildResources: 'build',
    output: 'dist',
  },
  publish: [
    { provider: 'github', owner: 'sxiansheng3', repo: 'deepseek-harness-desktop', releaseType: 'release' },
  ],
  mac: {
    category: 'public.app-category.developer-tools',
    icon: 'build/icon.icns',
    hardenedRuntime: true,
    notarize: notaryProfile ? { keychainProfile: notaryProfile } : false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    gatekeeperAssess: false,
    signIgnore: [
      '/Contents/Frameworks/Electron Framework\\.framework/(?:Versions/(?:A|Current)/)?Resources/',
      '/Contents/Resources/node/bin/(?:npm|npx|pnpm|corepack)$',
    ],
    target: [
      { target: 'dmg', arch: ['arm64'] },
      { target: 'zip', arch: ['arm64'] },
    ],
    extraResources: [
      { from: 'vendor/node', to: 'node' },
    ],
  },
  win: {
    icon: 'build/icon.ico',
    executableName: 'DeepSeek Harness Desktop',
    artifactName: '${productName}-Setup-${version}-${arch}.${ext}',
    target: [
      { target: 'nsis', arch: ['x64'] },
    ],
    extraResources: [
      { from: 'vendor/node-win', to: 'node', filter: ['**/*', '!node_modules{,/**/*}'] },
      { from: 'vendor/node-win/node_modules/npm', to: 'node/tools/npm', filter: ['**/*', '!node_modules{,/**/*}'] },
      { from: 'vendor/node-win/node_modules/npm/node_modules', to: 'node/tools/npm/node_modules', filter: ['**/*'] },
      { from: 'src/windows-runtime-fs-shim.cjs', to: 'runtime-support/windows-runtime-fs-shim.cjs' },
    ],
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'DeepSeek Harness Desktop',
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
    deleteAppDataOnUninstall: false,
    runAfterFinish: true,
  },
  dmg: {
    sign: true,
    title: '${productName} ${version}',
  },
}
