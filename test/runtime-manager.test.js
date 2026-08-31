import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertRuntimeCapabilities,
  assertSafeVersion,
  describeUpdate,
  environmentForNetworkAttempt,
  isNetworkFailure,
  networkAttemptsForProxyResolution,
  parseRuntimeUrl,
  parseRuntimeReleaseFeed,
  pathDelimiter,
  quarantineProfileModuleFallback,
  removeRuntimePath,
  resolveToolInvocation,
  runtimeInstallDirectory,
  runtimeInstallPlan,
  runtimeVersionFromReleaseTag,
  RUNTIME_INSTALL_TIMEOUT_MS,
  runtimeStartupError,
  runtimeSupportsDynamicPort,
  runtimeWebArgs,
  sanitizeRuntimeOutput,
  RuntimeManager,
  terminateChild,
} from '../src/runtime-manager.js'
import { bundledToolDirectory, bundledToolPath } from '../src/tool-layout.js'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { installWindowsRuntimeFsShim, isManagedFallbackLink } = require('../src/windows-runtime-fs-shim.cjs')

test('parses the exact loopback runtime URL from startup output', () => {
  assert.equal(parseRuntimeUrl('ready\ndsh web: http://127.0.0.1:3080\n'), 'http://127.0.0.1:3080/')
  assert.equal(
    parseRuntimeUrl('dsh web: http://127.0.0.1:3080/?token=one-time-token (LAN: http://192.168.1.2:3080/?token=one-time-token)'),
    'http://127.0.0.1:3080/?token=one-time-token',
  )
  assert.equal(parseRuntimeUrl('dsh web: http://0.0.0.0:3080'), undefined)
  assert.equal(parseRuntimeUrl('dsh web: https://127.0.0.1:3080/?token=unsafe'), undefined)
})

test('rejects unsafe version strings before using them in paths or npm specs', () => {
  assert.equal(assertSafeVersion('0.1.0-rc.6'), '0.1.0-rc.6')
  assert.throws(() => assertSafeVersion(undefined), /Invalid Harness version/)
  assert.throws(() => assertSafeVersion('../../latest'))
  assert.throws(() => assertSafeVersion('@scope/package'))
})

test('reports registry dist-tag changes without guessing prerelease ordering', () => {
  assert.deepEqual(describeUpdate('0.1.0-rc.6', '0.1.0-rc.6'), { available: false, version: '0.1.0-rc.6' })
  assert.deepEqual(describeUpdate('0.1.0-rc.5', '0.1.0-rc.6'), { available: true, version: '0.1.0-rc.6' })
})

test('recognizes every official GitHub Runtime release tag form', () => {
  assert.equal(runtimeVersionFromReleaseTag('dsh-v0.1.2-alpha.2'), '0.1.2-alpha.2')
  assert.equal(runtimeVersionFromReleaseTag('v0.1.1-rc.2'), '0.1.1-rc.2')
  assert.equal(runtimeVersionFromReleaseTag('0.1.0-rc.8'), '0.1.0-rc.8')
  assert.equal(runtimeVersionFromReleaseTag('../../latest'), undefined)
  assert.equal(runtimeVersionFromReleaseTag('release-notes'), undefined)
  assert.equal(runtimeVersionFromReleaseTag('%E0%A4%A'), undefined)
})

test('reads prereleases and release notes from the official GitHub Atom feed', () => {
  const releases = parseRuntimeReleaseFeed(`<?xml version="1.0"?>
    <feed>
      <entry>
        <id>tag:github.com,2008:Repository/1/dsh-v0.1.2-alpha.2</id>
        <updated>2026-08-30T13:52:14Z</updated>
        <link rel="alternate" type="text/html" href="https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.2"/>
        <title>v0.1.2-alpha.2</title>
        <content type="html">&lt;h3&gt;新增功能&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;支持 Alpha 更新&lt;/li&gt;&lt;/ul&gt;</content>
      </entry>
      <entry>
        <id>tag:github.com,2008:Repository/1/dsh-v0.1.1-rc.2</id>
        <link rel="alternate" href="https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.1-rc.2"/>
        <title>v0.1.1-rc.2</title>
      </entry>
    </feed>`)
  assert.equal(releases[0].version, '0.1.2-alpha.2')
  assert.equal(releases[0].title, 'v0.1.2-alpha.2')
  assert.match(releases[0].body, /新增功能\n- 支持 Alpha 更新/)
  assert.equal(releases[0].publishedAt, '2026-08-30T13:52:14Z')
  assert.equal(releases[1].version, '0.1.1-rc.2')
})

test('allows a Runtime installation to run for 100 minutes', () => {
  assert.equal(RUNTIME_INSTALL_TIMEOUT_MS, 100 * 60_000)
})

test('uses the official no-open flag only when the installed Runtime supports it', () => {
  assert.deepEqual(
    runtimeWebArgs('/runtime/dsh.js', 3080, 'Options:\n  --port <port>'),
    ['/runtime/dsh.js', 'web', '--port', '3080'],
  )
  assert.deepEqual(
    runtimeWebArgs('/runtime/dsh.js', 3080, 'Options:\n  --no-open\n  --port <port>'),
    ['/runtime/dsh.js', 'web', '--no-open', '--port', '3080'],
  )
  const dynamicPortHelp = 'Options:\n  --no-open\n  --port <port>  listen port; pass 0 to let the OS pick a free one'
  assert.equal(runtimeSupportsDynamicPort(dynamicPortHelp), true)
  assert.deepEqual(
    runtimeWebArgs('/runtime/dsh.js', 3080, dynamicPortHelp),
    ['/runtime/dsh.js', 'web', '--no-open', '--port', '0'],
  )
})

test('reports stderr startup failures and removes secrets from the user-visible diagnostics', () => {
  assert.equal(
    sanitizeRuntimeOutput('open http://127.0.0.1:1234/?token=secret-value\nAuthorization: Bearer abc123'),
    'open http://127.0.0.1:1234/?token=[已隐藏]\nAuthorization: Bearer [已隐藏]',
  )
  const error = runtimeStartupError(1, '', 'profile failed for ?api_key=private')
  assert.equal(error.stage, 'start')
  assert.equal(error.exitCode, 1)
  assert.match(error.message, /错误输出：/)
  assert.match(error.message, /api_key=\[已隐藏\]/)
  assert.doesNotMatch(error.message, /private/)
})

test('quarantines only the generated shared profile fallback and preserves user profile data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-fallback-'))
  const harnessHome = join(root, 'harness-home')
  const fallback = join(harnessHome, 'profiles', 'node_modules')
  const profile = join(harnessHome, 'profiles', 'web')
  try {
    await mkdir(join(fallback, '@deepseek-ai', 'dsh-web-app'), { recursive: true })
    await mkdir(profile, { recursive: true })
    await writeFile(join(fallback, '@deepseek-ai', 'dsh-web-app', 'package.json'), '{"version":"old"}')
    await writeFile(join(profile, 'cordis.patch.yml'), 'user-owned: true\n')
    const destination = await quarantineProfileModuleFallback(
      harnessHome,
      join(root, 'backups'),
      '0.1.2-alpha.2',
      123,
    )
    assert.equal(destination, join(root, 'backups', '123-0.1.2-alpha.2-profile-module-fallback'))
    assert.equal(await readFile(join(destination, '@deepseek-ai', 'dsh-web-app', 'package.json'), 'utf8'), '{"version":"old"}')
    assert.deepEqual(await readdir(fallback), [])
    assert.equal(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), 'user-owned: true\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rebuilds the generated fallback once after an update startup failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-retry-'))
  const runtime = new RuntimeManager({ root, nodeBinary: 'node', npmBinary: 'npm', platform: 'darwin' })
  const fallbackMarker = join(runtime.harnessHome, 'profiles', 'node_modules', 'legacy', 'package.json')
  const settings = join(runtime.harnessHome, 'settings.yaml')
  let starts = 0
  let activated
  try {
    await mkdir(join(root, 'versions'), { recursive: true })
    await writeFile(runtime.statePath, JSON.stringify({ version: '0.1.1-rc.2' }))
    await mkdir(join(fallbackMarker, '..'), { recursive: true })
    await writeFile(fallbackMarker, '{"version":"old"}')
    await writeFile(settings, 'provider: user-owned\n')
    runtime.install = async () => {}
    runtime.start = async version => {
      starts += 1
      if (starts === 1) throw runtimeStartupError(1, '', 'incompatible generated fallback')
      assert.equal(version, '0.1.2-alpha.2')
      return 'http://127.0.0.1:1234/'
    }
    runtime.activate = async (version, history) => { activated = { version, history } }

    const result = await runtime.updateAndRestart('0.1.2-alpha.2')
    assert.equal(starts, 2)
    assert.equal(result.url, 'http://127.0.0.1:1234/')
    assert.equal(activated.version, '0.1.2-alpha.2')
    assert.equal(await readFile(settings, 'utf8'), 'provider: user-owned\n')
    assert.deepEqual(await readdir(join(runtime.harnessHome, 'profiles', 'node_modules')), [])
    assert.equal(await readFile(join(result.recoveryPath, 'legacy', 'package.json'), 'utf8'), '{"version":"old"}')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('restores the complete previous home when the compatibility retry still fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-retry-rollback-'))
  const runtime = new RuntimeManager({ root, nodeBinary: 'node', npmBinary: 'npm', platform: 'darwin' })
  const fallbackMarker = join(runtime.harnessHome, 'profiles', 'node_modules', 'legacy', 'package.json')
  const settings = join(runtime.harnessHome, 'settings.yaml')
  const starts = []
  try {
    await mkdir(join(root, 'versions'), { recursive: true })
    await writeFile(runtime.statePath, JSON.stringify({ version: '0.1.1-rc.2' }))
    await mkdir(join(fallbackMarker, '..'), { recursive: true })
    await writeFile(fallbackMarker, '{"version":"old"}')
    await writeFile(settings, 'provider: user-owned\n')
    runtime.install = async () => {}
    runtime.start = async version => {
      starts.push(version)
      if (version === '0.1.2-alpha.2') throw runtimeStartupError(1, '', 'still incompatible')
      return 'http://127.0.0.1:4321/'
    }

    await assert.rejects(runtime.updateAndRestart('0.1.2-alpha.2'), /still incompatible/)
    assert.deepEqual(starts, ['0.1.2-alpha.2', '0.1.2-alpha.2', '0.1.1-rc.2'])
    assert.equal(await readFile(settings, 'utf8'), 'provider: user-owned\n')
    assert.equal(await readFile(fallbackMarker, 'utf8'), '{"version":"old"}')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('tries the system proxy and retains a direct-download fallback', () => {
  assert.deepEqual(
    networkAttemptsForProxyResolution('PROXY 127.0.0.1:7890; DIRECT'),
    [
      { kind: 'proxy', label: '系统代理', proxyUrl: 'http://127.0.0.1:7890' },
      { kind: 'direct', label: '直接连接' },
    ],
  )
  assert.deepEqual(networkAttemptsForProxyResolution('DIRECT'), [{ kind: 'direct', label: '直接连接' }])
  assert.deepEqual(networkAttemptsForProxyResolution(''), [{ kind: 'direct', label: '直接连接' }])
})

test('direct downloads do not accidentally inherit proxy environment variables', () => {
  const direct = environmentForNetworkAttempt({
    PATH: '/usr/bin',
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    npm_config_proxy: 'http://127.0.0.1:7890',
  }, { kind: 'direct', label: '直接连接' })
  assert.equal(direct.PATH, '/usr/bin')
  assert.equal(direct.HTTPS_PROXY, undefined)
  assert.equal(direct.npm_config_proxy, 'null')
  assert.equal(direct.npm_config_https_proxy, 'null')

  const proxied = environmentForNetworkAttempt({ PATH: '/usr/bin' }, {
    kind: 'proxy',
    label: '系统代理',
    proxyUrl: 'http://127.0.0.1:7890',
  })
  assert.equal(proxied.HTTPS_PROXY, 'http://127.0.0.1:7890')
  assert.equal(proxied.npm_config_https_proxy, 'http://127.0.0.1:7890')
})

test('only connection failures trigger an alternate download route', () => {
  assert.equal(isNetworkFailure(new Error('connect ETIMEDOUT 127.0.0.1:7890')), true)
  assert.equal(isNetworkFailure(new Error('npm exited with 1\nERESOLVE unable to resolve dependency tree')), false)
})

test('version checks follow the newest GitHub release even when npm latest still points to an RC', async () => {
  const calls = []
  const feed = `<feed><entry>
    <id>tag:github.com,2008:Repository/1/dsh-v0.1.2-alpha.2</id>
    <link rel="alternate" href="https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.2"/>
    <title>v0.1.2-alpha.2</title>
    <content type="html">&lt;p&gt;Alpha release&lt;/p&gt;</content>
  </entry></feed>`
  const runtime = new RuntimeManager({
    root: '/tmp/runtime',
    nodeBinary: 'node',
    npmBinary: 'npm',
    systemFetch: async url => {
      calls.push(`system:${url}`)
      if (url.includes('github.com')) throw new Error('proxy connection failed')
      return new Response(JSON.stringify({
        'dist-tags': { latest: '0.1.1-rc.2', alpha: '0.1.2-alpha.2' },
        versions: { '0.1.1-rc.2': {}, '0.1.2-alpha.2': {} },
      }), { status: 200 })
    },
    directFetch: async url => {
      calls.push(`direct:${url}`)
      return new Response(feed, { status: 200 })
    },
  })
  assert.equal(await runtime.getLatestVersion(), '0.1.2-alpha.2')
  assert.deepEqual(calls, [
    'system:https://github.com/deepseek-ai/deepseek-harness/releases.atom',
    'system:https://registry.npmjs.org/@deepseek-ai%2fdsh',
    'direct:https://github.com/deepseek-ai/deepseek-harness/releases.atom',
  ])
})

test('reports a published GitHub release that has no installable npm package yet', async () => {
  const feed = `<feed><entry>
    <id>tag:github.com,2008:Repository/1/dsh-v0.1.3-alpha.1</id>
    <link rel="alternate" href="https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.1"/>
    <title>v0.1.3-alpha.1</title>
  </entry></feed>`
  const runtime = new RuntimeManager({
    root: '/tmp/runtime',
    nodeBinary: 'node',
    npmBinary: 'npm',
    directFetch: async url => url.includes('github.com')
      ? new Response(feed, { status: 200 })
      : new Response(JSON.stringify({ versions: { '0.1.2-alpha.2': {} } }), { status: 200 }),
  })
  await assert.rejects(
    runtime.getLatestVersion(),
    /已发布 Harness 0\.1\.3-alpha\.1，但对应 npm 安装包尚未发布/,
  )
})

test('version-check failures retain every attempted network route', async () => {
  const runtime = new RuntimeManager({
    root: '/tmp/runtime',
    nodeBinary: 'node',
    npmBinary: 'npm',
    systemFetch: async () => { throw new Error('proxy unavailable') },
    directFetch: async () => { throw new Error('direct unavailable') },
  })
  await assert.rejects(runtime.getLatestVersion(), error => {
    assert.equal(error.stage, 'check')
    assert.deepEqual(error.attemptFailures.map(attempt => attempt.label), ['系统网络（含代理）', '直接连接'])
    return true
  })
})

test('rejects an update that drops a required official Web capability', () => {
  const complete = [
    'code-runtime', 'goal', 'llm-deepseek', 'permission', 'plan-mode',
    'plugin-inventory', 'session-persistence-jsonl', 'skill-filesystem',
    'subagent-spawn-in-process', 'tool-bash', 'tool-fs', 'tool-pwsh', 'tool-skill',
    'tool-subagent', 'tool-web', 'tool-workflow', 'web-runtime',
  ].map(id => `- id: ${id}`).join('\n')
  assert.doesNotThrow(() => assertRuntimeCapabilities(complete))
  assert.throws(() => assertRuntimeCapabilities(complete.replace('- id: tool-web', '')), /tool-web/)
})

test('uses native PATH delimiters for packaged tools on macOS and Windows', () => {
  assert.equal(pathDelimiter('darwin'), ':')
  assert.equal(pathDelimiter('linux'), ':')
  assert.equal(pathDelimiter('win32'), ';')
})

test('launches packaged npm and pnpm JavaScript entry points through bundled Node', () => {
  assert.deepEqual(
    resolveToolInvocation('C:\\App\\node.exe', 'C:\\App\\npm-cli.js', ['--version']),
    { command: 'C:\\App\\node.exe', args: ['C:\\App\\npm-cli.js', '--version'] },
  )
  assert.deepEqual(
    resolveToolInvocation('node', 'pnpm', ['--version']),
    { command: 'pnpm', args: ['--version'] },
  )
})

test('uses direct Windows termination and POSIX escalation signals', () => {
  const calls = []
  const child = { kill: signal => { calls.push(signal); return true } }
  terminateChild(child, { platform: 'win32' })
  terminateChild(child, { platform: 'darwin' })
  terminateChild(child, { platform: 'darwin', force: true })
  assert.deepEqual(calls, [undefined, 'SIGTERM', 'SIGKILL'])
})

test('keeps packaged Windows package managers outside the filtered node_modules tree', () => {
  assert.equal(
    bundledToolPath('C:\\Program Files\\DeepSeek\\resources', 'win32', 'npm'),
    'C:\\Program Files\\DeepSeek\\resources/node/tools/npm/bin/npm-cli.js',
  )
  assert.equal(
    bundledToolPath('C:\\Program Files\\DeepSeek\\resources', 'win32', 'pnpm'),
    'C:\\Program Files\\DeepSeek\\resources/node/tools/pnpm/bin/pnpm.cjs',
  )
  assert.equal(
    bundledToolPath('C:\\Program Files\\DeepSeek\\resources', 'win32', 'node'),
    'C:\\Program Files\\DeepSeek\\resources/node/node.exe',
  )
  assert.equal(
    bundledToolDirectory('C:\\Program Files\\DeepSeek\\resources', 'win32'),
    'C:\\Program Files\\DeepSeek\\resources/node',
  )
})

test('installs the Windows Runtime with npm and never routes it through pnpm', () => {
  const plan = runtimeInstallPlan('C:\\App\\resources\\node\\tools\\npm\\bin\\npm-cli.js', '0.1.0-rc.7')
  assert.equal(plan.toolBinary, 'C:\\App\\resources\\node\\tools\\npm\\bin\\npm-cli.js')
  assert.deepEqual(plan.args, [
    'install',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    '@deepseek-ai/dsh@0.1.0-rc.7',
  ])
  assert.equal(JSON.stringify(plan).includes('pnpm'), false)
})

test('installs Windows directly into the final version directory without an installing rename', () => {
  const target = 'C:\\Runtime\\versions\\0.1.0-rc.7'
  assert.equal(runtimeInstallDirectory(target, 'win32', 123), target)
  assert.equal(runtimeInstallDirectory('/runtime/versions/0.1.0-rc.7', 'darwin', 123), '/runtime/versions/0.1.0-rc.7.installing-123')
})

test('retries Windows locks and never lets best-effort cleanup replace the original failure', async () => {
  const cleanupError = Object.assign(new Error('resource busy'), { code: 'EBUSY' })
  const calls = []
  const warnings = []
  const removed = await removeRuntimePath('C:\\Runtime\\incomplete', {
    platform: 'win32',
    required: false,
    remove: async (path, options) => {
      calls.push({ path, options })
      throw cleanupError
    },
    logger: { warn: message => warnings.push(message) },
  })
  assert.equal(removed, false)
  assert.equal(calls[0].options.maxRetries, 12)
  assert.equal(calls[0].options.retryDelay, 250)
  assert.match(warnings[0], /Deferred Runtime cleanup/)
  await assert.rejects(
    removeRuntimePath('C:\\Runtime\\incomplete', {
      platform: 'win32',
      remove: async () => { throw cleanupError },
    }),
    error => error === cleanupError,
  )
})

test('does not accept a partial Windows Runtime until its verification marker exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-ready-'))
  const runtime = new RuntimeManager({
    root,
    nodeBinary: 'node.exe',
    npmBinary: 'npm-cli.js',
    platform: 'win32',
  })
  const target = runtime.runtimeDirectory('0.1.0-rc.7')
  const packageRoot = join(target, 'node_modules', '@deepseek-ai', 'dsh')
  try {
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ version: '0.1.0-rc.7' }))
    assert.equal(await runtime.isInstalledRuntimeReady(target, '0.1.0-rc.7'), false)
    await writeFile(join(target, '.desktop-runtime-ready.json'), JSON.stringify({ version: '0.1.0-rc.7' }))
    assert.equal(await runtime.isInstalledRuntimeReady(target, '0.1.0-rc.7'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('keeps the Windows Harness home inside its matching runtime installation', () => {
  const runtime = new RuntimeManager({
    root: 'C:\\Users\\Test\\AppData\\Local\\DeepSeek Harness Desktop\\runtime',
    nodeBinary: 'node.exe',
    npmBinary: 'npm-cli.js',
    pnpmBinary: 'pnpm.cjs',
    toolDirectory: 'C:\\App\\resources\\node',
    platform: 'win32',
  })
  assert.equal(
    runtime.harnessHomeForVersion('0.1.0-rc.7'),
    join(runtime.runtimeDirectory('0.1.0-rc.7'), '.harness-home'),
  )
  assert.deepEqual(
    runtime.runtimeNodeArgs(['dsh.js', 'web']),
    ['dsh.js', 'web'],
  )
  runtime.runtimePreload = 'C:\\App\\windows-runtime-fs-shim.cjs'
  assert.deepEqual(
    runtime.runtimeNodeArgs(['dsh.js', 'web']),
    ['--require', 'C:\\App\\windows-runtime-fs-shim.cjs', 'dsh.js', 'web'],
  )
  assert.equal(runtime.runtimeEnvironment().PNPM_HOME, undefined)
  assert.equal(runtime.runtimeEnvironment().PATH.startsWith('C:\\App\\resources\\node;'), true)
})

test('suppresses only the official Windows profile fallback links inside the active runtime', () => {
  const runtimeDirectory = 'C:\\Users\\Test\\AppData\\Local\\DeepSeek Harness Desktop\\runtime\\versions\\0.1.0-rc.7'
  const harnessHome = `${runtimeDirectory}\\.harness-home`
  const env = { DSH_DESKTOP_RUNTIME_DIRECTORY: runtimeDirectory, DSH_HOME: harnessHome }
  assert.equal(isManagedFallbackLink(
    `${runtimeDirectory}\\node_modules\\@deepseek-ai\\dsh`,
    `${harnessHome}\\profiles\\node_modules\\@deepseek-ai\\dsh`,
    env,
    'win32',
  ), true)
  assert.equal(isManagedFallbackLink(
    'C:\\Users\\Test\\Documents',
    `${harnessHome}\\profiles\\node_modules\\foreign`,
    env,
    'win32',
  ), false)
  assert.equal(isManagedFallbackLink(
    `${runtimeDirectory}\\node_modules\\@deepseek-ai\\dsh`,
    'C:\\Users\\Test\\Desktop\\dsh',
    env,
    'win32',
  ), false)
  assert.equal(isManagedFallbackLink(
    `${runtimeDirectory}\\node_modules\\@deepseek-ai\\dsh`,
    `${harnessHome}\\profiles\\node_modules\\@deepseek-ai\\dsh`,
    env,
    'darwin',
  ), false)

  const restore = installWindowsRuntimeFsShim(env, 'win32')
  try {
    assert.doesNotThrow(() => {
      require('node:fs').symlinkSync(
        `${runtimeDirectory}\\node_modules\\@deepseek-ai\\dsh`,
        `${harnessHome}\\profiles\\node_modules\\@deepseek-ai\\dsh`,
        'junction',
      )
    })
  } finally {
    restore()
  }
})
