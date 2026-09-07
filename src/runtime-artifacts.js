import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, posix } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as tar from 'tar'
import { compareRuntimeVersions, runtimeVersionFromReleaseTag } from './runtime-manager.js'

export const RUNTIME_CHANNEL_URL = 'https://github.com/sxiansheng3/deepseek-harness-desktop/releases/download/runtime-channel-v1/runtime-manifest.json'
const ASSET_PREFIX = '/sxiansheng3/deepseek-harness-desktop/releases/download/'
export const RELEASE_GATES = ['startup', 'web', 'sessions', 'plugins', 'rollback']

export function validateRuntimeArtifact(item) {
  if (!item || runtimeVersionFromReleaseTag(item.version) !== item.version
    || runtimeVersionFromReleaseTag(item.tag) !== item.version
    || !/^dsh-v/.test(item.tag) || !/^[a-f0-9]{40}$/.test(item.commit ?? '')
    || !Number.isSafeInteger(item.build) || item.build < 1
    || !['darwin', 'win32', 'linux'].includes(item.platform)
    || !['arm64', 'x64'].includes(item.arch)
    || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '')
    || !Number.isSafeInteger(item.size) || item.size <= 0 || item.size > 4 * 1024 ** 3
    || runtimeVersionFromReleaseTag(item.minDesktopVersion) !== item.minDesktopVersion) {
    throw new Error('Runtime 构建清单字段无效')
  }
  const url = new URL(item.url)
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password
    || !url.pathname.startsWith(ASSET_PREFIX) || /%|\\/.test(url.pathname) || url.search || url.hash
    || !url.pathname.endsWith('.tar.gz')) throw new Error('Runtime 下载地址不属于桌面版发布仓库')
  return { ...item, source: 'source-build' }
}

export function parseRuntimeChannel(manifest, { platform, arch, desktopVersion }) {
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.releases)) throw new Error('Runtime 构建清单格式不受支持')
  const releases = manifest.releases.map(validateRuntimeArtifact)
  return releases.filter(item => item.platform === platform && item.arch === arch
    && compareRuntimeVersions(desktopVersion, item.minDesktopVersion) >= 0
    && RELEASE_GATES.every(gate => item.validation?.[gate] === 'pass')
    && /^[a-f0-9]{64}$/.test(item.validation?.reportSha256 ?? ''))
    .sort((a, b) => compareRuntimeVersions(b.version, a.version) || b.build - a.build)
}

export async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function safeArchiveEntry(entry) {
  const name = entry.path.replace(/^\.\//, '')
  if (!name || name === '.') return
  if (name.includes('\\') || name.includes('\0') || posix.isAbsolute(name)
    || name.split('/').includes('..') || /^[A-Za-z]:/.test(name)) throw new Error('Runtime 归档包含越界路径')
  if (!['File', 'Directory', 'SymbolicLink', 'Link'].includes(entry.type)) throw new Error('Runtime 归档包含不支持的文件类型')
  if (entry.type === 'SymbolicLink' || entry.type === 'Link') {
    const link = entry.linkpath
    const resolved = posix.normalize(posix.join(entry.type === 'Link' ? '.' : posix.dirname(name), link))
    if (!link || posix.isAbsolute(link) || link.includes('\\') || /^[A-Za-z]:/.test(link)
      || resolved === '..' || resolved.startsWith('../')) throw new Error('Runtime 归档包含越界链接')
  }
}

export async function extractRuntimeArchive(archive, directory) {
  // Preflight the entire archive before writing anything. tar also refuses writes through symlinks.
  let invalid
  await tar.t({ file: archive, strict: true, onReadEntry(entry) {
    try { safeArchiveEntry(entry) } catch (error) { invalid ??= error }
  } })
  if (invalid) throw invalid
  await mkdir(directory, { recursive: true })
  await tar.x({ file: archive, cwd: directory, strict: true, preservePaths: false })
}

export async function downloadRuntimeArtifact(artifact, path, { systemFetch, directFetch = fetch, onProgress = () => {} }) {
  validateRuntimeArtifact(artifact)
  const attempts = [...(systemFetch ? [{ label: '系统网络（含代理）', fetcher: systemFetch }] : []), { label: '直接连接', fetcher: directFetch }]
  let failure
  await mkdir(dirname(path), { recursive: true })
  for (const attempt of attempts) {
    const startedAt = Date.now()
    try {
      const response = await attempt.fetcher(artifact.url, { signal: AbortSignal.timeout(100 * 60_000) })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      let received = 0
      const hash = createHash('sha256')
      const meter = new Transform({ transform(chunk, _encoding, callback) {
        received += chunk.length
        if (received > artifact.size) return callback(new Error('Runtime 下载大小超过清单记录'))
        hash.update(chunk)
        onProgress({ phase: 'download', title: `正在下载 Harness ${artifact.version}`, message: attempt.label,
          processedBytes: received, bytesPerSecond: received / Math.max(0.001, (Date.now() - startedAt) / 1000),
          percent: Math.floor(received / artifact.size * 100), indeterminate: false })
        callback(null, chunk)
      } })
      await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(path, { mode: 0o600 }))
      if (received !== artifact.size || hash.digest('hex') !== artifact.sha256) throw new Error('Runtime 安装包大小或 SHA-256 校验失败')
      return path
    } catch (error) {
      failure = error
      await rm(path, { force: true })
    }
  }
  throw new Error(`Runtime 下载失败（已尝试${attempts.map(item => item.label).join('、')}）：${failure.message}`)
}
