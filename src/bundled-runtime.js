import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { assertSafeVersion, compareRuntimeVersions } from './runtime-manager.js'

/** Load a packaged Runtime manifest without allowing its directory to escape the resources folder. */
export async function loadBundledRuntime(manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const version = assertSafeVersion(manifest.version)
  if (typeof manifest.archive !== 'string' || manifest.archive.trim() === '' || isAbsolute(manifest.archive)) {
    throw new Error('Bundled Harness Runtime archive must be a non-empty relative path')
  }
  if (typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sha256)) {
    throw new Error('Bundled Harness Runtime archive SHA-256 is invalid')
  }
  const resourcesRoot = dirname(manifestPath)
  const archive = resolve(resourcesRoot, manifest.archive)
  const relativeArchive = relative(resourcesRoot, archive)
  if (relativeArchive === '..' || relativeArchive.startsWith(`..${sep}`)) {
    throw new Error('Bundled Harness Runtime archive escapes the application resources folder')
  }
  return { version, archive, sha256: manifest.sha256 }
}

/** Decide how startup should combine persistent user data with the Runtime carried by this desktop build. */
export function bundledRuntimeStartupAction(activeVersion, bundledVersion) {
  if (bundledVersion === undefined) return { action: 'use-active', version: activeVersion }
  if (activeVersion === undefined) return { action: 'fresh-install', version: bundledVersion }
  const comparison = compareRuntimeVersions(bundledVersion, activeVersion)
  if (comparison > 0) return { action: 'upgrade', version: bundledVersion }
  if (comparison === 0) return { action: 'ensure-installed', version: activeVersion }
  return { action: 'use-active', version: activeVersion }
}
