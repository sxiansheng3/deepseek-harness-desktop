import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { createServer } from 'node:net'
import { access, cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const PACKAGE_NAME = '@deepseek-ai/dsh'
export const RUNTIME_REGISTRY_URL = 'https://registry.npmjs.org/@deepseek-ai%2fdsh'
export const GITHUB_RELEASES_FEED_URL = 'https://github.com/deepseek-ai/deepseek-harness/releases.atom'
const STARTUP_TIMEOUT_MS = 120_000
const COMMAND_TIMEOUT_MS = 120_000
export const RUNTIME_INSTALL_TIMEOUT_MS = 100 * 60_000
const PROGRESS_SAMPLE_MS = 2_000
const RUNTIME_READY_FILE = '.desktop-runtime-ready.json'
const PROXY_ENV_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'npm_config_proxy', 'npm_config_https_proxy', 'npm_config_noproxy',
]

/** Use the host separator when prepending the bundled Node tool directory. */
export function pathDelimiter(platform = process.platform) {
  return platform === 'win32' ? ';' : ':'
}

/** JavaScript CLI entry points must be launched through the bundled Node executable. */
export function resolveToolInvocation(nodeBinary, toolBinary, args = []) {
  if (typeof toolBinary !== 'string' || toolBinary.length === 0) {
    throw new Error('Package-manager entry point is not configured')
  }
  if (/\.(?:cjs|mjs|js)$/i.test(toolBinary)) {
    return { command: nodeBinary, args: [toolBinary, ...args] }
  }
  return { command: toolBinary, args }
}

/** Windows has no catchable POSIX signal; child.kill() performs direct termination there. */
export function terminateChild(child, { force = false, platform = process.platform } = {}) {
  if (platform === 'win32') return child.kill()
  return child.kill(force ? 'SIGKILL' : 'SIGTERM')
}

/** Reject values that could escape an npm package specifier or version path. */
export function assertSafeVersion(version) {
  if (typeof version !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(version)) {
    throw new Error(`Invalid Harness version: ${JSON.stringify(version)}`)
  }
  return version
}

/** Compare SemVer-compatible Harness versions without depending on npm's mutable dist-tags. */
export function compareRuntimeVersions(left, right) {
  const parse = value => {
    const safe = assertSafeVersion(value)
    const match = safe.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
    if (match === null) throw new Error(`Unsupported Harness version: ${safe}`)
    return {
      core: match.slice(1, 4).map(Number),
      prerelease: match[4]?.split('.'),
    }
  }
  const leftVersion = parse(left)
  const rightVersion = parse(right)
  for (let index = 0; index < leftVersion.core.length; index += 1) {
    if (leftVersion.core[index] !== rightVersion.core[index]) {
      return leftVersion.core[index] > rightVersion.core[index] ? 1 : -1
    }
  }
  if (leftVersion.prerelease === undefined || rightVersion.prerelease === undefined) {
    if (leftVersion.prerelease === rightVersion.prerelease) return 0
    return leftVersion.prerelease === undefined ? 1 : -1
  }
  const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = leftVersion.prerelease[index]
    const rightIdentifier = rightVersion.prerelease[index]
    if (leftIdentifier === rightIdentifier) continue
    if (leftIdentifier === undefined) return -1
    if (rightIdentifier === undefined) return 1
    const leftNumeric = /^\d+$/.test(leftIdentifier)
    const rightNumeric = /^\d+$/.test(rightIdentifier)
    if (leftNumeric && rightNumeric) {
      const difference = Number(leftIdentifier) - Number(rightIdentifier)
      if (difference !== 0) return difference > 0 ? 1 : -1
      continue
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftIdentifier > rightIdentifier ? 1 : -1
  }
  return 0
}

/** Extract the loopback URL printed by `dsh web`. */
export function parseRuntimeUrl(output) {
  const match = output.match(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+(?:\/[^\s()]*)?)/)
  if (match?.[1] === undefined) return undefined
  try {
    const url = new URL(match[1])
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port === '') return undefined
    return url.href
  } catch {
    return undefined
  }
}

/** Compare exact versions. Release ordering is owned by GitHub's published-release feed. */
export function describeUpdate(activeVersion, publishedVersion) {
  if (activeVersion === publishedVersion) return { available: false, version: publishedVersion }
  return { available: true, version: publishedVersion }
}

function decodeEntities(value) {
  const named = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' }
  return value.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|amp|apos|gt|lt|nbsp|quot);/gi, (match, entity) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
    }
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
    return named[entity.toLowerCase()] ?? match
  })
}

function releaseNotesFromHtml(value) {
  const html = decodeEntities(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li(?:\s[^>]*)?>/gi, '- ')
    .replace(/<\/(?:h[1-6]|li|ol|p|pre|ul)>/gi, '\n')
    .replace(/<hr(?:\s[^>]*)?\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
  return decodeEntities(html)
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function atomElement(entry, name) {
  return entry.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1]
}

/** Parse the official GitHub Releases feed, including releases marked as Pre-release. */
export function parseRuntimeReleaseFeed(feed) {
  if (typeof feed !== 'string') throw new Error('GitHub release feed is not text')
  return [...feed.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].flatMap(match => {
    const entry = match[1]
    const href = entry.match(/<link\s[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*\/?\s*>/i)?.[1]
      ?? entry.match(/<link\s[^>]*href=["']([^"']+)["'][^>]*rel=["']alternate["'][^>]*\/?\s*>/i)?.[1]
    const tag = href?.match(/\/releases\/tag\/([^/?#]+)/)?.[1]
      ?? atomElement(entry, 'id')?.match(/\/([^/]+)$/)?.[1]
    const version = runtimeVersionFromReleaseTag(tag)
    if (version === undefined) return []
    const title = decodeEntities(atomElement(entry, 'title') ?? tag ?? version).trim()
    const body = releaseNotesFromHtml(atomElement(entry, 'content') ?? '')
    return [{
      version,
      title: title || version,
      body,
      url: href === undefined ? undefined : decodeEntities(href),
      publishedAt: decodeEntities(atomElement(entry, 'updated') ?? '').trim() || undefined,
    }]
  })
}

/** Accept the tag forms used by the official repository, including dsh-v prereleases. */
export function runtimeVersionFromReleaseTag(tag) {
  if (typeof tag !== 'string') return undefined
  try {
    const decoded = decodeEntities(decodeURIComponent(tag)).trim()
    const version = decoded.startsWith('dsh-v')
      ? decoded.slice('dsh-v'.length)
      : decoded.startsWith('v') ? decoded.slice(1) : decoded
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) return undefined
    return assertSafeVersion(version)
  } catch {
    return undefined
  }
}

/** Convert Chromium's system-proxy result into npm-compatible connection attempts. */
export function networkAttemptsForProxyResolution(proxyResolution = '') {
  const attempts = []
  const seen = new Set()
  const append = attempt => {
    const key = `${attempt.kind}:${attempt.proxyUrl ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    attempts.push(attempt)
  }
  for (const entry of proxyResolution.split(';').map(value => value.trim()).filter(Boolean)) {
    if (entry.toUpperCase() === 'DIRECT') {
      append({ kind: 'direct', label: '直接连接' })
      continue
    }
    const match = entry.match(/^(PROXY|HTTP|HTTPS|SOCKS|SOCKS5)\s+(.+)$/i)
    if (!match) continue
    const protocol = match[1].toUpperCase().startsWith('SOCKS') ? 'socks5' : 'http'
    append({
      kind: 'proxy',
      label: '系统代理',
      proxyUrl: `${protocol}://${match[2]}`,
    })
  }
  if (!attempts.some(attempt => attempt.kind === 'direct')) {
    append({ kind: 'direct', label: '直接连接' })
  }
  return attempts
}

/** Remove inherited proxy settings for a genuinely direct npm attempt. */
export function environmentForNetworkAttempt(environment, attempt) {
  const result = { ...environment }
  if (attempt.kind === 'proxy') {
    result.HTTP_PROXY = attempt.proxyUrl
    result.HTTPS_PROXY = attempt.proxyUrl
    result.ALL_PROXY = attempt.proxyUrl
    result.npm_config_proxy = attempt.proxyUrl
    result.npm_config_https_proxy = attempt.proxyUrl
  } else if (attempt.kind === 'direct') {
    for (const key of PROXY_ENV_KEYS) delete result[key]
    result.npm_config_proxy = 'null'
    result.npm_config_https_proxy = 'null'
  }
  return result
}

/** Newer Harness versions can hold an OS-selected port without a reserve-then-release race. */
export function runtimeSupportsDynamicPort(helpText) {
  return /--port <port>[\s\S]{0,120}pass 0 to let the OS pick/i.test(helpText)
}

/** Old Harness versions lack --no-open and dynamic ports; detect both from their own CLI help. */
export function runtimeWebArgs(entry, port, helpText) {
  const selectedPort = runtimeSupportsDynamicPort(helpText) ? 0 : port
  return [entry, 'web', ...(helpText.includes('--no-open') ? ['--no-open'] : []), '--port', String(selectedPort)]
}

function redactRuntimeOutput(output) {
  return String(output ?? '')
    .replace(/([?&](?:access_token|api_key|key|password|secret|token)=)[^&\s)]+/gi, '$1[已隐藏]')
    .replace(/(authorization:\s*(?:basic|bearer)\s+)\S+/gi, '$1[已隐藏]')
}

/** Keep startup diagnostics useful without exposing one-time URLs or credentials in an error dialog. */
export function sanitizeRuntimeOutput(output) {
  return redactRuntimeOutput(output)
    .trim()
    .slice(-8_000)
}

export function conciseRuntimeStartupFailure(error, diagnosticPath) {
  const source = [error?.stderr, error?.stdout, error?.message]
    .filter(value => typeof value === 'string' && value.trim() !== '')
    .join('\n')
  const loaderEntries = [...source.matchAll(/loader entry\s+([^\s(]+)\s*\([^)]*\)/gi)].map(match => match[1])
  const loader = loaderEntries.findLast(entry => !/^(?:include|web)$/i.test(entry)) ?? loaderEntries.at(-1)
  const client = source.match(/mcp-client\(([^)]+)\)/i)?.[1]
  const mcp = source.match(/MCP error\s*(-?\d+)\s*:\s*([^\n]+)/i)
  const directCause = mcp
    ? `MCP ${mcp[1]}：${mcp[2].trim()}`
    : source.split('\n').map(line => line.trim()).find(line =>
      line !== ''
      && !/^(?:at\s|file:|listtoolsrequest|processing request|throw new error|\^)/i.test(line)
      && !/^(?:标准输出|错误输出)/.test(line))
  const component = [loader, client && client !== loader ? client : undefined].filter(Boolean).join(' / ')
  return [
    component ? `失败组件：${component}` : undefined,
    directCause ? `直接原因：${directCause.slice(0, 360)}` : '直接原因：Harness Runtime 在启动期间退出。',
    component
      ? '建议：检查或暂时停用该 MCP 插件后，再重新打开桌面版。其他模型、会话和 Runtime 数据不会因此被删除。'
      : '建议：重新打开桌面版；如果仍失败，请根据诊断日志检查最后一个启动组件。',
    diagnosticPath ? '完整诊断日志已保存，可点击“打开日志目录”查看。' : undefined,
  ].filter(Boolean).join('\n')
}

export async function writeRuntimeStartupDiagnostic(root, error, timestamp = Date.now()) {
  const directory = join(root, 'logs')
  const path = join(directory, `startup-error-${new Date(timestamp).toISOString().replaceAll(':', '-')}.log`)
  const stdout = error?.diagnosticStdout ?? error?.stdout ?? ''
  const stderr = error?.diagnosticStderr ?? error?.stderr ?? ''
  const fallback = error instanceof Error ? error.stack || error.message : String(error)
  const body = [
    `timestamp: ${new Date(timestamp).toISOString()}`,
    `stage: ${error?.stage ?? 'unknown'}`,
    `exitCode: ${error?.exitCode ?? 'unknown'}`,
    stdout ? `\n[stdout]\n${stdout}` : undefined,
    stderr ? `\n[stderr]\n${stderr}` : undefined,
    !stdout && !stderr ? `\n[error]\n${fallback}` : undefined,
  ].filter(Boolean).join('\n')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(path, `${redactRuntimeOutput(body).trim()}\n`, { mode: 0o600 })
  return path
}

/** Preserve both output streams because upstream startup failures are commonly written only to stderr. */
export function runtimeStartupError(code, stdout, stderr) {
  const diagnosticStdout = redactRuntimeOutput(stdout).trim()
  const diagnosticStderr = redactRuntimeOutput(stderr).trim()
  const safeStdout = sanitizeRuntimeOutput(stdout)
  const safeStderr = sanitizeRuntimeOutput(stderr)
  const details = [
    ...(safeStdout ? ['标准输出：', safeStdout] : []),
    ...(safeStderr ? ['错误输出：', safeStderr] : []),
  ]
  const error = new Error([
    `Harness 启动期间退出（code ${code ?? 'unknown'}）`,
    ...(details.length > 0 ? ['', ...details] : []),
  ].join('\n'))
  error.stage = 'start'
  error.exitCode = code
  error.stdout = safeStdout
  error.stderr = safeStderr
  error.diagnosticStdout = diagnosticStdout
  error.diagnosticStderr = diagnosticStderr
  return error
}

/**
 * Move the shared installation fallback aside before one compatibility retry.
 * This directory is generated by Harness; sessions, settings, credentials,
 * profile manifests, user patches, and profile-local plugin modules stay put.
 */
export async function quarantineProfileModuleFallback(harnessHome, backupRoot, version, timestamp = Date.now()) {
  const source = join(harnessHome, 'profiles', 'node_modules')
  try {
    await lstat(source)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  const destination = join(backupRoot, `${timestamp}-${assertSafeVersion(version)}-profile-module-fallback`)
  await mkdir(backupRoot, { recursive: true })
  await rename(source, destination)
  await mkdir(source, { recursive: true })
  return destination
}

export function isNetworkFailure(error) {
  const text = error instanceof Error ? `${error.message}\n${error.stderr ?? ''}` : String(error)
  return /(?:ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ENOTFOUND|socket hang up|network timeout|network request|fetch failed|proxy|HTTP 407)/i.test(text)
}

/** Runtime installs use npm on every platform; pnpm 11's Windows global store requires symlinks. */
export function runtimeInstallPlan(npmBinary, version) {
  const safeVersion = assertSafeVersion(version)
  return {
    toolBinary: npmBinary,
    args: [
      'install',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      `${PACKAGE_NAME}@${safeVersion}`,
    ],
  }
}

/** Windows cannot reliably rename or immediately delete a freshly populated module tree. */
export function runtimeInstallDirectory(target, platform = process.platform, timestamp = Date.now()) {
  return platform === 'win32' ? target : `${target}.installing-${timestamp}`
}

/** Retry transient Windows locks and optionally defer cleanup without hiding the original failure. */
export async function removeRuntimePath(path, {
  platform = process.platform,
  remove = rm,
  required = true,
  logger = console,
} = {}) {
  try {
    await remove(path, {
      recursive: true,
      force: true,
      ...(platform === 'win32' ? { maxRetries: 12, retryDelay: 250 } : {}),
    })
    return true
  } catch (error) {
    if (required) throw error
    logger.warn(`Deferred Runtime cleanup for ${path}: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

export const REQUIRED_WEB_CAPABILITIES = [
  'code-runtime',
  'goal',
  'llm-deepseek',
  'permission',
  'plan-mode',
  'plugin-inventory',
  'session-persistence-jsonl',
  'skill-filesystem',
  'subagent-spawn-in-process',
  'tool-bash',
  'tool-fs',
  'tool-pwsh',
  'tool-skill',
  'tool-subagent',
  'tool-web',
  'tool-workflow',
  'web-runtime',
]

export const REQUIRED_RUNTIME_PACKAGES = [
  'dsh-headless',
  'dsh-mcp-client',
  'dsh-pwsh-local',
  'dsh-pwsh-sandbox',
  'dsh-sandbox-windows-acl',
  'dsh-skill-filesystem',
  'dsh-subagent-spawn-in-process',
  'dsh-terminal-bash',
  'dsh-tool-pwsh',
  'dsh-web-app',
  'dsh-workflow-worker-thread',
]

/** Confirm that an updated official Web profile still contains every product capability the desktop depends on. */
export function assertRuntimeCapabilities(configOutput) {
  const missing = REQUIRED_WEB_CAPABILITIES.filter(id => !configOutput.includes(`id: ${id}`))
  if (missing.length > 0) throw new Error(`Harness Web profile is missing required capabilities: ${missing.join(', ')}`)
}

async function assertRuntimePackages(directory) {
  const packageRoots = [
    join(directory, 'node_modules', '@deepseek-ai'),
    join(directory, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'),
  ]
  const missing = []
  for (const packageName of REQUIRED_RUNTIME_PACKAGES) {
    let found = false
    for (const packageRoot of packageRoots) {
      try {
        await access(join(packageRoot, packageName, 'package.json'))
        found = true
        break
      } catch {
        // pnpm's hoisted linker may keep transitive packages beside dsh instead of at the project root.
      }
    }
    if (!found) missing.push(packageName)
  }
  if (missing.length > 0) throw new Error(`Harness installation is missing required packages: ${missing.join(', ')}`)
}

async function reservePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Unable to reserve a local port')
  const port = address.port
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      terminateChild(child)
      reject(new Error(`${command} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on('data', chunk => {
      const text = chunk.toString()
      stdout += text
      options.onOutput?.({ stream: 'stdout', text })
    })
    child.stderr.on('data', chunk => {
      const text = chunk.toString()
      stderr += text
      options.onOutput?.({ stream: 'stderr', text })
    })
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', code => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else {
        const error = new Error(`${command} exited with ${code}\n${stderr || stdout}`)
        error.exitCode = code
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
      }
    })
  })
}

async function directorySize(path) {
  let total = 0
  const directories = [path]
  while (directories.length > 0) {
    const directory = directories.pop()
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    for (const entry of entries) {
      const child = join(directory, entry.name)
      if (entry.isDirectory()) directories.push(child)
      else if (entry.isFile()) total += (await stat(child)).size
    }
  }
  return total
}

function stageError(stage, message, cause, details = {}) {
  const error = new Error(message, { cause })
  error.stage = stage
  Object.assign(error, details)
  return error
}

async function sha256File(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export class RuntimeManager {
  constructor({
    root,
    nodeBinary,
    npmBinary,
    pnpmBinary,
    toolDirectory,
    runtimePreload,
    resolveProxy,
    systemFetch,
    directFetch,
    onProgress,
    bundledRuntime,
    platform = process.platform,
    logger = console,
  }) {
    this.root = root
    this.nodeBinary = nodeBinary
    this.npmBinary = npmBinary
    this.pnpmBinary = pnpmBinary
    this.toolDirectory = toolDirectory
    this.runtimePreload = runtimePreload
    this.resolveProxy = resolveProxy
    this.systemFetch = systemFetch
    this.directFetch = directFetch ?? fetch
    this.onProgress = onProgress
    this.bundledRuntime = bundledRuntime === undefined ? undefined : {
      version: assertSafeVersion(bundledRuntime.version),
      archive: bundledRuntime.archive,
      sha256: bundledRuntime.sha256,
    }
    if (this.bundledRuntime !== undefined && (typeof this.bundledRuntime.archive !== 'string' || this.bundledRuntime.archive === '')) {
      throw new Error('Bundled Harness Runtime archive is not configured')
    }
    if (this.bundledRuntime !== undefined && !/^[a-f0-9]{64}$/.test(this.bundledRuntime.sha256 ?? '')) {
      throw new Error('Bundled Harness Runtime archive SHA-256 is invalid')
    }
    this.platform = platform
    this.logger = logger
    this.process = undefined
    this.currentUrl = undefined
  }

  reportProgress(progress) {
    this.onProgress?.({ timestamp: Date.now(), ...progress })
  }

  async runTool(toolBinary, args, options = {}) {
    const invocation = resolveToolInvocation(this.nodeBinary, toolBinary, args)
    return run(invocation.command, invocation.args, options)
  }

  get versionsRoot() { return join(this.root, 'versions') }
  get statePath() { return join(this.root, 'active.json') }
  get harnessHome() { return join(this.root, 'harness-home') }

  /**
   * Windows keeps each Harness home below its matching installation. Node can
   * then resolve profile plugins by walking up to the installation's real
   * node_modules without creating privileged symlinks or junctions.
   */
  harnessHomeForVersion(version) {
    if (this.platform !== 'win32') return this.harnessHome
    return join(this.runtimeDirectory(version), '.harness-home')
  }

  runtimeNodeArgs(args) {
    if (this.platform !== 'win32' || this.runtimePreload === undefined) return args
    return ['--require', this.runtimePreload, ...args]
  }

  async initialize() {
    await mkdir(this.versionsRoot, { recursive: true })
    if (this.platform !== 'win32') await mkdir(this.harnessHome, { recursive: true })
  }

  async getActiveVersion() {
    return (await this.getState())?.version
  }

  async getState() {
    try {
      const state = JSON.parse(await readFile(this.statePath, 'utf8'))
      const version = assertSafeVersion(state.version)
      const previousVersion = state.previousVersion === undefined ? undefined : assertSafeVersion(state.previousVersion)
      const backupPath = typeof state.backupPath === 'string' ? state.backupPath : undefined
      return { version, previousVersion, backupPath }
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  }

  async getLatestVersion() {
    return (await this.getLatestRelease()).version
  }

  async fetchOfficialResource(url, { accept, label, parse }) {
    const attempts = [
      ...(this.systemFetch ? [{ label: '系统网络（含代理）', fetcher: this.systemFetch }] : []),
      { label: '直接连接', fetcher: this.directFetch },
    ]
    const attemptFailures = []
    for (const attempt of attempts) {
      try {
        const response = await attempt.fetcher(url, {
          headers: {
            accept,
            'user-agent': 'DeepSeek-Harness-Desktop',
          },
          signal: AbortSignal.timeout(15_000),
        })
        if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`)
        return await parse(response)
      } catch (error) {
        attemptFailures.push({ label: attempt.label, error })
      }
    }
    throw stageError('check', `无法读取${label}`, attemptFailures.at(-1)?.error, { attemptFailures })
  }

  async getLatestRelease() {
    const [feed, metadata] = await Promise.all([
      this.fetchOfficialResource(GITHUB_RELEASES_FEED_URL, {
        accept: 'application/atom+xml',
        label: 'DeepSeek 官方 GitHub Release',
        parse: response => response.text(),
      }),
      this.fetchOfficialResource(RUNTIME_REGISTRY_URL, {
        accept: 'application/vnd.npm.install-v1+json',
        label: 'DeepSeek 官方 npm Registry',
        parse: response => response.json(),
      }),
    ])
    const release = parseRuntimeReleaseFeed(feed)[0]
    if (release === undefined) {
      throw stageError('check', 'DeepSeek 官方 GitHub 尚未发布可识别的 Harness Release')
    }
    if (metadata?.versions?.[release.version] === undefined) {
      throw stageError(
        'check',
        `DeepSeek 官方已发布 Harness ${release.version}，但对应 npm 安装包尚未发布，暂时无法安装`,
      )
    }
    return release
  }

  async checkForUpdate() {
    const [activeVersion, latestRelease] = await Promise.all([
      this.getActiveVersion(),
      this.getLatestRelease(),
    ])
    const update = { activeVersion, ...describeUpdate(activeVersion, latestRelease.version) }
    if (update.available && latestRelease.body) {
      update.releaseNotes = {
        title: latestRelease.title,
        body: latestRelease.body,
        url: latestRelease.url,
      }
    }
    return update
  }

  runtimeDirectory(version) {
    return join(this.versionsRoot, assertSafeVersion(version))
  }

  runtimeEntry(version) {
    return join(this.runtimeDirectory(version), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  }

  async isInstalledRuntimeReady(target, version) {
    try {
      const packageJson = JSON.parse(await readFile(join(target, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
      if (packageJson.version !== version) return false
      if (this.platform !== 'win32') return true
      const ready = JSON.parse(await readFile(join(target, RUNTIME_READY_FILE), 'utf8'))
      return ready.version === version
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return false
      throw error
    }
  }

  async installBundledRuntime(version, target) {
    const safeVersion = assertSafeVersion(version)
    if (this.bundledRuntime?.version !== safeVersion) return undefined
    const source = this.bundledRuntime.archive
    const installDirectory = `${target}.bundled-${Date.now()}`
    const verificationHome = join(installDirectory, '.verification-home')
    this.reportProgress({
      phase: 'install',
      title: `正在安装内置 Harness ${safeVersion}`,
      message: '无需下载，正在解压桌面安装包内的完整 Runtime',
      indeterminate: true,
    })
    try {
      const archiveHash = await sha256File(source)
      if (archiveHash !== this.bundledRuntime.sha256) {
        throw new Error(`Bundled Runtime archive SHA-256 mismatch: ${archiveHash}`)
      }
      await removeRuntimePath(installDirectory, { platform: this.platform, logger: this.logger })
      await mkdir(installDirectory, { recursive: true })
      await run('/usr/bin/tar', ['-xzf', source, '-C', installDirectory], {
        timeout: RUNTIME_INSTALL_TIMEOUT_MS,
      })
      const sourcePackage = JSON.parse(await readFile(join(installDirectory, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
      if (sourcePackage.version !== safeVersion) {
        throw new Error(`Bundled Harness reported ${sourcePackage.version}, expected ${safeVersion}`)
      }
      await assertRuntimePackages(installDirectory)
      const entry = join(installDirectory, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      const environment = this.runtimeEnvironment({ harnessHome: verificationHome, runtimeDirectory: installDirectory })
      const versionCheck = await run(this.nodeBinary, this.runtimeNodeArgs([entry, '--version']), {
        cwd: installDirectory,
        env: environment,
      })
      if (versionCheck.stdout.trim() !== safeVersion) {
        throw new Error(`Bundled Harness reported ${versionCheck.stdout.trim()}, expected ${safeVersion}`)
      }
      const configVerification = await run(this.nodeBinary, this.runtimeNodeArgs([entry, 'web', '--dump-default-config']), {
        cwd: installDirectory,
        env: environment,
      })
      assertRuntimeCapabilities(configVerification.stdout)
      await removeRuntimePath(verificationHome, {
        platform: this.platform,
        required: false,
        logger: this.logger,
      })
      await removeRuntimePath(target, { platform: this.platform, logger: this.logger })
      await rename(installDirectory, target)
      return target
    } catch (error) {
      await removeRuntimePath(installDirectory, {
        platform: this.platform,
        required: false,
        logger: this.logger,
      })
      if (error?.stage) throw error
      throw stageError('verify', `内置 Harness ${safeVersion} 校验或安装失败`, error)
    }
  }

  async install(version) {
    const safeVersion = assertSafeVersion(version)
    const target = this.runtimeDirectory(safeVersion)
    if (await this.isInstalledRuntimeReady(target, safeVersion)) return target
    const bundledTarget = await this.installBundledRuntime(safeVersion, target)
    if (bundledTarget !== undefined) return bundledTarget

    const installDirectory = runtimeInstallDirectory(target, this.platform)
    const proxyResolution = await this.resolveProxy?.(RUNTIME_REGISTRY_URL).catch(error => {
      this.logger.warn(`Unable to resolve system proxy: ${error instanceof Error ? error.message : String(error)}`)
      return ''
    }) ?? ''
    const networkAttempts = networkAttemptsForProxyResolution(proxyResolution)
    const attemptFailures = []
    try {
      const installPlan = runtimeInstallPlan(this.npmBinary, safeVersion)
      for (const [index, attempt] of networkAttempts.entries()) {
        await removeRuntimePath(installDirectory, { platform: this.platform, logger: this.logger })
        await mkdir(installDirectory, { recursive: true })
        await writeFile(join(installDirectory, 'package.json'), JSON.stringify({ private: true }, null, 2) + '\n')
        const startedAt = Date.now()
        let lastSize = 0
        let lastSampleAt = startedAt
        let sampling = false
        const emitSample = async () => {
          if (sampling) return
          sampling = true
          try {
            const processedBytes = await directorySize(installDirectory)
            const now = Date.now()
            const bytesPerSecond = Math.max(0, processedBytes - lastSize) / Math.max(0.001, (now - lastSampleAt) / 1000)
            lastSize = processedBytes
            lastSampleAt = now
            this.reportProgress({
              phase: 'download',
              title: `正在安装 Harness ${safeVersion}`,
              message: `${attempt.label} · 下载并解压依赖`,
              attempt: index + 1,
              attemptCount: networkAttempts.length,
              elapsedMs: now - startedAt,
              processedBytes,
              bytesPerSecond,
              indeterminate: true,
            })
          } catch (error) {
            this.logger.warn(`Unable to sample Runtime progress: ${error instanceof Error ? error.message : String(error)}`)
          } finally {
            sampling = false
          }
        }
        await emitSample()
        const sampleTimer = setInterval(() => { void emitSample() }, PROGRESS_SAMPLE_MS)
        try {
          await this.runTool(installPlan.toolBinary, installPlan.args, {
            cwd: installDirectory,
            timeoutMs: RUNTIME_INSTALL_TIMEOUT_MS,
            env: environmentForNetworkAttempt(this.runtimeEnvironment(), attempt),
          })
          clearInterval(sampleTimer)
          await emitSample()
          break
        } catch (error) {
          clearInterval(sampleTimer)
          attemptFailures.push({ label: attempt.label, error })
          const canRetry = index < networkAttempts.length - 1 && isNetworkFailure(error)
          if (!canRetry) {
            throw stageError(
              'download',
              `Harness ${safeVersion} 下载或安装失败`,
              error,
              { attemptFailures },
            )
          }
          this.reportProgress({
            phase: 'retry',
            title: `正在切换下载线路`,
            message: `${attempt.label}失败，即将尝试${networkAttempts[index + 1].label}`,
            attempt: index + 1,
            attemptCount: networkAttempts.length,
            indeterminate: true,
          })
        }
      }

      const entry = join(installDirectory, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      this.reportProgress({ phase: 'verify', title: '正在校验更新', message: '检查 Runtime 版本与完整能力', indeterminate: true })
      await assertRuntimePackages(installDirectory)
      const verificationHome = join(installDirectory, '.verification-home')
      const verificationEnvironment = this.runtimeEnvironment({
        harnessHome: verificationHome,
        runtimeDirectory: installDirectory,
      })
      const verification = await run(this.nodeBinary, this.runtimeNodeArgs([entry, '--version']), {
        cwd: installDirectory,
        env: verificationEnvironment,
      })
      if (verification.stdout.trim() !== safeVersion) {
        throw new Error(`Installed Harness reported ${verification.stdout.trim()}, expected ${safeVersion}`)
      }
      await this.runTool(this.npmBinary, ['--version'], { env: this.runtimeEnvironment() })
      if (this.pnpmBinary !== undefined) {
        await this.runTool(this.pnpmBinary, ['--version'], { env: this.runtimeEnvironment() })
      }
      const configVerification = await run(this.nodeBinary, this.runtimeNodeArgs([entry, 'web', '--dump-default-config']), {
        cwd: installDirectory,
        env: verificationEnvironment,
      })
      assertRuntimeCapabilities(configVerification.stdout)
      await removeRuntimePath(verificationHome, {
        platform: this.platform,
        required: false,
        logger: this.logger,
      })
      if (this.platform === 'win32') {
        await writeFile(
          join(target, RUNTIME_READY_FILE),
          JSON.stringify({ version: safeVersion, verifiedAt: new Date().toISOString() }, null, 2) + '\n',
        )
      } else {
        this.reportProgress({ phase: 'activate', title: '正在启用更新', message: '切换到已校验的新 Runtime', indeterminate: true })
        await removeRuntimePath(target, { platform: this.platform, logger: this.logger })
        await rename(installDirectory, target)
      }
      return target
    } catch (error) {
      await removeRuntimePath(installDirectory, {
        platform: this.platform,
        required: false,
        logger: this.logger,
      })
      if (error?.stage) throw error
      throw stageError('verify', `Harness ${safeVersion} 校验或启用失败`, error)
    }
  }

  async activate(version, history = {}) {
    const safeVersion = assertSafeVersion(version)
    await this.install(safeVersion)
    const nextState = `${this.statePath}.next`
    await mkdir(dirname(this.statePath), { recursive: true })
    await writeFile(nextState, JSON.stringify({ version: safeVersion, ...history }, null, 2) + '\n')
    await rename(nextState, this.statePath)
    return safeVersion
  }

  async backupHarnessHome(version, label) {
    const harnessHome = this.harnessHomeForVersion(version)
    await mkdir(harnessHome, { recursive: true })
    const backupPath = join(this.root, 'backups', `${Date.now()}-${label}`)
    await mkdir(dirname(backupPath), { recursive: true })
    await cp(harnessHome, backupPath, { recursive: true, force: false, preserveTimestamps: true })
    return backupPath
  }

  async restoreHarnessHome(version, backupPath) {
    const harnessHome = this.harnessHomeForVersion(version)
    await rm(harnessHome, { recursive: true, force: true })
    await cp(backupPath, harnessHome, { recursive: true, force: false, preserveTimestamps: true })
  }

  async copyHarnessHome(fromVersion, toVersion) {
    if (this.platform !== 'win32') return
    const source = this.harnessHomeForVersion(fromVersion)
    const destination = this.harnessHomeForVersion(toVersion)
    await mkdir(source, { recursive: true })
    await rm(destination, { recursive: true, force: true })
    await cp(source, destination, { recursive: true, force: false, preserveTimestamps: true })
  }

  runtimeEnvironment({ harnessHome = this.harnessHome, runtimeDirectory } = {}) {
    const toolPath = this.toolDirectory === undefined
      ? process.env.PATH ?? ''
      : `${this.toolDirectory}${pathDelimiter(this.platform)}${process.env.PATH ?? ''}`
    const environment = {
      ...process.env,
      PATH: toolPath,
      ...(this.toolDirectory === undefined || this.platform === 'win32' ? {} : { PNPM_HOME: this.toolDirectory }),
      DSH_HOME: harnessHome,
      ...(runtimeDirectory === undefined ? {} : { DSH_DESKTOP_RUNTIME_DIRECTORY: runtimeDirectory }),
      ...(this.platform === 'win32' ? { DSH_DESKTOP_LINKLESS_PROFILE_FALLBACK: '1' } : {}),
      DSH_TELEMETRY_MODE: process.env.DSH_TELEMETRY_MODE ?? 'DISABLED',
    }
    if (this.platform === 'win32') delete environment.PNPM_HOME
    return environment
  }

  async start(version) {
    await this.stop()
    const safeVersion = assertSafeVersion(version)
    const runtimeDirectory = this.runtimeDirectory(safeVersion)
    const harnessHome = this.harnessHomeForVersion(safeVersion)
    await mkdir(harnessHome, { recursive: true })
    const entry = this.runtimeEntry(safeVersion)
    this.reportProgress({ phase: 'start', title: `正在启动 Harness ${safeVersion}`, message: '等待本机服务就绪', indeterminate: true })
    const help = await run(this.nodeBinary, this.runtimeNodeArgs([entry, 'web', '--help']), {
      cwd: process.env.DSH_DESKTOP_WORKSPACE || process.cwd(),
      env: this.runtimeEnvironment({ harnessHome, runtimeDirectory }),
    })
    const helpText = `${help.stdout}\n${help.stderr}`
    const port = runtimeSupportsDynamicPort(helpText) ? 0 : await reservePort()
    const webArgs = runtimeWebArgs(entry, port, helpText)
    const child = spawn(this.nodeBinary, this.runtimeNodeArgs(webArgs), {
      cwd: process.env.DSH_DESKTOP_WORKSPACE || process.cwd(),
      env: this.runtimeEnvironment({ harnessHome, runtimeDirectory }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.process = child

    const url = await new Promise((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        terminateChild(child)
        const error = new Error(`Harness 未能在 ${STARTUP_TIMEOUT_MS / 1000} 秒内启动`)
        error.stage = 'start'
        error.stdout = sanitizeRuntimeOutput(stdout)
        error.stderr = sanitizeRuntimeOutput(stderr)
        reject(error)
      }, STARTUP_TIMEOUT_MS)
      const onData = chunk => {
        stdout += chunk.toString()
        const parsed = parseRuntimeUrl(stdout)
        if (parsed !== undefined) {
          settled = true
          clearTimeout(timer)
          resolve(parsed)
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', chunk => {
        const text = chunk.toString()
        stderr += text
        this.logger.warn(sanitizeRuntimeOutput(text))
      })
      child.once('error', error => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        error.stage = 'start'
        reject(error)
      })
      child.once('exit', code => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(runtimeStartupError(code, stdout, stderr))
      })
    })
    this.currentUrl = url
    this.reportProgress({ phase: 'complete', title: `Harness ${safeVersion} 已就绪`, message: '正在打开桌面界面', indeterminate: false, percent: 100 })
    child.once('exit', () => {
      if (this.process === child) {
        this.process = undefined
        this.currentUrl = undefined
      }
    })
    return url
  }

  async restart(version) {
    await this.stop()
    return this.start(version)
  }

  async stop() {
    const child = this.process
    this.process = undefined
    this.currentUrl = undefined
    if (child === undefined || child.exitCode !== null) return
    terminateChild(child)
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 5_000)),
    ])
    if (child.exitCode === null) terminateChild(child, { force: true })
  }

  async updateAndRestart(version) {
    const previousState = await this.getState()
    const previous = previousState?.version
    const backupPath = previous === undefined
      ? undefined
      : await this.backupHarnessHome(previous, `${previous}-to-${assertSafeVersion(version)}`)
    await this.install(version)
    if (previous !== undefined) await this.copyHarnessHome(previous, version)
    try {
      let url
      let recoveryPath
      try {
        url = await this.start(version)
      } catch (initialStartError) {
        if (this.platform === 'win32' || backupPath === undefined || previous === undefined) throw initialStartError
        recoveryPath = await quarantineProfileModuleFallback(
          this.harnessHomeForVersion(version),
          join(this.root, 'backups'),
          version,
        )
        if (recoveryPath === undefined) throw initialStartError
        this.reportProgress({
          phase: 'retry',
          title: '正在兼容旧版 Runtime 数据',
          message: '已保留旧模块映射，正在重新生成并启动',
          indeterminate: true,
        })
        try {
          url = await this.start(version)
        } catch (retryError) {
          retryError.initialStartError = initialStartError
          retryError.recoveryPath = recoveryPath
          throw retryError
        }
      }
      await this.activate(version, { previousVersion: previous, backupPath })
      return { version, url, previous, backupPath, recoveryPath }
    } catch (error) {
      await this.stop()
      if (this.platform === 'win32') {
        await rm(this.harnessHomeForVersion(version), { recursive: true, force: true })
      } else if (backupPath !== undefined && previous !== undefined) {
        await this.restoreHarnessHome(previous, backupPath)
      }
      if (previous !== undefined) await this.start(previous)
      if (!error?.stage) error.stage = 'start'
      throw error
    }
  }

  async rollback() {
    const state = await this.getState()
    if (state?.previousVersion === undefined || state.backupPath === undefined) {
      throw new Error('No previous Harness update is available to roll back')
    }
    await this.stop()
    await this.restoreHarnessHome(state.previousVersion, state.backupPath)
    const url = await this.start(state.previousVersion)
    await this.activate(state.previousVersion)
    return { version: state.previousVersion, url }
  }
}
