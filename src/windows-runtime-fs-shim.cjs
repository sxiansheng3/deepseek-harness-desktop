'use strict'

const fs = require('node:fs')
const { syncBuiltinESMExports } = require('node:module')
const path = require('node:path')

function isInside(parent, candidate, pathApi) {
  const relative = pathApi.relative(pathApi.resolve(parent), pathApi.resolve(candidate))
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative)
}

function canonicalPath(candidate, pathApi) {
  try {
    return fs.realpathSync.native(candidate)
  } catch {
    try {
      return pathApi.join(fs.realpathSync.native(pathApi.dirname(candidate)), pathApi.basename(candidate))
    } catch {
      return pathApi.resolve(candidate)
    }
  }
}

/**
 * The official Harness creates a flat profiles/node_modules fallback made of
 * directory links. In the desktop layout the Harness home deliberately lives
 * below the matching runtime, so Node's normal parent walk reaches the same
 * runtime/node_modules without those links. Only suppress that exact managed
 * fallback; every other symlink request keeps Node's original behavior.
 */
function isManagedFallbackLink(target, link, env = process.env, platform = process.platform) {
  const enabled = platform === 'win32' || env.DSH_DESKTOP_LINKLESS_PROFILE_FALLBACK === '1'
  if (!enabled) return false
  const runtimeDirectory = env.DSH_DESKTOP_RUNTIME_DIRECTORY
  const harnessHome = env.DSH_HOME
  if (!runtimeDirectory || !harnessHome) return false
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const canonicalRuntime = canonicalPath(runtimeDirectory, pathApi)
  const canonicalHome = canonicalPath(harnessHome, pathApi)
  if (!isInside(canonicalRuntime, canonicalHome, pathApi)) return false

  const runtimeModules = canonicalPath(pathApi.join(runtimeDirectory, 'node_modules'), pathApi)
  const fallbackModules = canonicalPath(pathApi.join(harnessHome, 'profiles', 'node_modules'), pathApi)
  const canonicalTarget = canonicalPath(String(target), pathApi)
  const canonicalLink = canonicalPath(String(link), pathApi)
  return isInside(runtimeModules, canonicalTarget, pathApi) && isInside(fallbackModules, canonicalLink, pathApi)
}

function installWindowsRuntimeFsShim(env = process.env, platform = process.platform) {
  const originalSymlinkSync = fs.symlinkSync
  fs.symlinkSync = function desktopSymlinkSync(target, link, type) {
    if (isManagedFallbackLink(target, link, env, platform)) return undefined
    return originalSymlinkSync.call(this, target, link, type)
  }
  syncBuiltinESMExports()
  return () => {
    fs.symlinkSync = originalSymlinkSync
    syncBuiltinESMExports()
  }
}

if (process.platform === 'win32' || process.env.DSH_DESKTOP_LINKLESS_PROFILE_FALLBACK === '1') {
  installWindowsRuntimeFsShim()
}

module.exports = { installWindowsRuntimeFsShim, isManagedFallbackLink }
