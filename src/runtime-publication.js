const OFFICIAL_SCOPE = '@deepseek-ai/'
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** Check the pinned release family before advertising it, without installing or running packages. */
export async function assertRuntimePublication(rootManifest, loadManifest) {
  const visited = new Set()
  let pending = [rootManifest]
  const missing = []
  while (pending.length) {
    const requirements = []
    for (const manifest of pending) {
      for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
        if (!name.startsWith(OFFICIAL_SCOPE) || Object.hasOwn(manifest.optionalDependencies ?? {}, name)) continue
        // Ranged third-party/framework dependencies are resolved by npm, not guessed here.
        if (typeof version !== 'string' || !EXACT_VERSION.test(version)) continue
        const key = `${name}@${version}`
        if (visited.has(key)) continue
        visited.add(key)
        if (visited.size > 1000) throw new Error('Runtime 依赖清单过大，无法安全确认完整性')
        requirements.push({ name, version, key })
      }
    }
    pending = []
    for (let offset = 0; offset < requirements.length; offset += 8) {
      await Promise.all(requirements.slice(offset, offset + 8).map(async ({ name, version, key }) => {
        const manifest = await loadManifest(name, version)
        if (manifest === null) missing.push(key)
        else if (manifest.name !== name || manifest.version !== version) throw new Error(`Runtime 依赖清单身份不匹配：${key}`)
        else pending.push(manifest)
      }))
    }
  }
  if (missing.length) {
    const error = new Error(`官方依赖尚未发布完整：${missing.sort().join('、')}。当前版本不受影响，请稍后重新检查更新。`)
    error.code = 'RUNTIME_PUBLICATION_INCOMPLETE'
    error.missingPackages = missing.sort()
    throw error
  }
}
