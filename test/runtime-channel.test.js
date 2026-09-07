import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as tar from 'tar'
import { RuntimeManager, describeUpdate, REQUIRED_RUNTIME_PACKAGES, REQUIRED_WEB_CAPABILITIES } from '../src/runtime-manager.js'
import { parseRuntimeChannel, validateRuntimeArtifact, downloadRuntimeArtifact, extractRuntimeArchive, hashFile } from '../src/runtime-artifacts.js'

const artifact = (extra = {}) => ({ version: '0.1.3-alpha.1', tag: 'dsh-v0.1.3-alpha.1', commit: 'a'.repeat(40),
  build: 1, platform: 'darwin', arch: 'arm64', minDesktopVersion: '0.1.14', size: 3, sha256: createHash('sha256').update('abc').digest('hex'),
  url: 'https://github.com/sxiansheng3/deepseek-harness-desktop/releases/download/runtime-test/runtime.tar.gz',
  validation: { startup: 'pass', web: 'pass', sessions: 'pass', plugins: 'pass', rollback: 'pass', reportSha256: 'b'.repeat(64) }, ...extra })
const feed = versions => '<feed>' + versions.map(v => `<entry><link rel="alternate" href="https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v${v}"/><title>${v}</title></entry>`).join('') + '</feed>'
const response = value => new Response(typeof value === 'string' ? value : JSON.stringify(value))
const runtime = (extra = {}) => new RuntimeManager({ root: '/tmp/nonexistent-dsh-catalog', platform: 'darwin', arch: 'arm64', desktopVersion: '0.1.14',
  directFetch: async url => url.includes('releases.atom') ? response(feed(['0.1.3-alpha.1', '0.1.2-rc.1']))
    : url.includes('registry.npmjs.org') ? response({ versions: { '0.1.2-rc.1': {} } }) : response({ schemaVersion: 1, releases: [] }), ...extra })

test('source-only release does not block an intermediate npm upgrade or local rollback status', async () => {
  const m = runtime(); m.getLocalStatus = async () => ({ activeVersion: '0.1.2-alpha.5', canRollback: true })
  const status = await m.checkForUpdate()
  assert.equal(status.available, true); assert.equal(status.version, '0.1.2-rc.1'); assert.equal(status.canRollback, true)
  assert.equal(status.latestPublishedVersion, '0.1.3-alpha.1'); assert.match(status.message, /尚未就绪/)
})
test('version comparison never offers downgrades or reinstallation on source change', () => {
  assert.equal(describeUpdate('0.1.3-alpha.1', '0.1.2-rc.1').available, false)
  assert.equal(describeUpdate('0.1.3-alpha.1', '0.1.3-alpha.1').available, false)
  assert.equal(describeUpdate('0.1.2-alpha.10', '0.1.2-alpha.9').available, false)
  assert.equal(describeUpdate('0.1.2-rc.1', undefined).available, false)
})
test('verified source build fills the npm gap and npm wins for the same version', async () => {
  const a = artifact()
  const m = runtime({ directFetch: async url => url.includes('releases.atom') ? response(feed([a.version]))
    : url.includes('registry') ? response({ versions: { '0.1.2-rc.1': {} } }) : response({ schemaVersion: 1, releases: [a] }) })
  assert.equal((await m.checkForUpdate()).candidate.source, 'source-build')
  const original = m.directFetch
  m.directFetch = url => url.includes('registry') ? Promise.resolve(response({ versions: { [a.version]: {} } })) : original(url)
  assert.equal((await m.checkForUpdate()).candidate.source, 'npm')
})
test('offline and invalid channel preserve local state; a failed GitHub source does not disable npm', async () => {
  const m = runtime({ directFetch: async () => { throw new Error('offline') } })
  m.getLocalStatus = async () => ({ activeVersion: '0.1.2-rc.1', canRollback: true })
  const status = await m.checkForUpdate()
  assert.equal(status.activeVersion, '0.1.2-rc.1'); assert.equal(status.canRollback, true)
  assert.equal(status.checkComplete, false); assert.equal(status.warnings.length, 3)
  assert.doesNotMatch(status.message, /当前已是/)
  m.directFetch = async url => url.includes('registry') ? response({ versions: { '0.1.3-alpha.1': {} } }) : response('malformed')
  assert.equal((await m.checkForUpdate()).available, true)
})
test('a not-yet-created channel is empty rather than an error', async () => {
  const m = runtime(); const original = m.directFetch
  m.directFetch = url => url.includes('runtime-manifest') ? Promise.resolve(new Response('', { status: 404 })) : original(url)
  assert.deepEqual((await m.checkForUpdate()).warnings, [])
})
test('unverified, mismatched platform and too-new desktop artifacts are not offered', () => {
  const options = { platform: 'darwin', arch: 'arm64', desktopVersion: '0.1.14' }
  const releases = [artifact({ arch: 'x64' }), artifact({ minDesktopVersion: '0.1.15' }), artifact({ validation: { startup: 'pass' } })]
  assert.deepEqual(parseRuntimeChannel({ schemaVersion: 1, releases }, options), [])
  assert.throws(() => validateRuntimeArtifact(artifact({ url: 'https://evil.test/runtime.tar.gz' })))
  assert.throws(() => validateRuntimeArtifact(artifact({ tag: 'dsh-v0.1.2-rc.1' })))
  assert.throws(() => validateRuntimeArtifact(artifact({ sha256: 'bad' })))
})
test('artifact download retries direct, verifies bytes, and removes corrupt downloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-download-')); const path = join(root, 'a.tgz'); const calls = []
  try {
    await downloadRuntimeArtifact(artifact(), path, { systemFetch: async () => { calls.push('proxy'); throw new Error('offline') },
      directFetch: async () => { calls.push('direct'); return response('abc') } })
    assert.deepEqual(calls, ['proxy', 'direct']); assert.equal(await readFile(path, 'utf8'), 'abc')
    await assert.rejects(downloadRuntimeArtifact(artifact(), path, { directFetch: async () => response('abd') }), /SHA-256/)
    await assert.rejects(access(path))
    await assert.rejects(downloadRuntimeArtifact(artifact(), path, { directFetch: async () => response('abcd') }), /超过/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('archive preflight rejects links escaping the runtime directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-archive-'))
  try {
    await symlink('../../outside', join(root, 'escape'))
    const archive = join(root, 'bad.tgz'); await tar.c({ cwd: root, file: archive, gzip: true }, ['escape'])
    await assert.rejects(extractRuntimeArchive(archive, join(root, 'extracted')), /越界链接/)
    await assert.rejects(access(join(root, 'extracted')))
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('source artifact really installs from an archive and executes version and capability checks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-source-install-'))
  try {
    const source = join(root, 'source'); const entryRoot = join(source, 'node_modules/@deepseek-ai/dsh')
    await mkdir(join(entryRoot, 'lib'), { recursive: true })
    await writeFile(join(entryRoot, 'package.json'), JSON.stringify({ version: '0.1.3-alpha.1' }))
    await writeFile(join(entryRoot, 'lib/bin.js'), `console.log(process.argv.includes('--version') ? '0.1.3-alpha.1' : ${JSON.stringify(REQUIRED_WEB_CAPABILITIES.map(id => `id: ${id}`).join('\n'))})`)
    for (const pkg of REQUIRED_RUNTIME_PACKAGES) {
      const dir = join(source, 'node_modules/@deepseek-ai', pkg); await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'package.json'), '{}')
    }
    const file = join(root, 'runtime.tgz'); await tar.c({ cwd: source, file, gzip: true }, ['node_modules'])
    const bytes = await readFile(file); const a = artifact({ size: bytes.length, sha256: await hashFile(file) })
    const m = runtime({ root: join(root, 'managed'), nodeBinary: process.execPath, directFetch: async () => new Response(bytes) })
    await m.install(a.version, { ...a, source: 'source-build' })
    assert.equal(await m.isInstalledRuntimeReady(m.runtimeDirectory(a.version), a.version), true)
    const marker = JSON.parse(await readFile(join(m.runtimeDirectory(a.version), '.desktop-runtime-ready.json')))
    assert.equal(marker.commit, a.commit); assert.equal(marker.source, 'source-build')
    // Installing is not activation and cannot alter a running user's state.
    assert.equal(await m.getActiveVersion(), undefined)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('running task and concurrent update guards prevent switching; backup follows stop', async () => {
  const m = runtime(); const calls = []
  m.getState = async () => ({ version: '0.1.2-rc.1' })
  m.install = async () => { calls.push('install') }; m.stop = async () => { calls.push('stop') }
  m.assertCanSwitch = async () => { throw new Error('running') }
  await assert.rejects(m.updateAndRestart('0.1.3-alpha.1'), /running/); assert.deepEqual(calls, ['install'])
  m.assertCanSwitch = async () => { calls.push('idle') }; m.backupHarnessHome = async () => { calls.push('backup'); return '/backup' }
  m.start = async () => 'http://127.0.0.1:1/'; m.activate = async () => {}
  await m.updateAndRestart('0.1.3-alpha.1'); assert.deepEqual(calls.slice(1), ['install', 'idle', 'stop', 'backup'])
  m.switching = true; await assert.rejects(m.updateAndRestart('0.1.3-alpha.1'), /正在进行/)
})
test('rollback preserves new data and restores it if the previous runtime fails to start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rollback-data-'))
  const m = runtime({ root }); const calls = []
  try {
    await m.initialize(); await writeFile(join(m.harnessHome, 'session.txt'), 'new conversation')
    const old = join(root, 'old'); await mkdir(old); await writeFile(join(old, 'session.txt'), 'old conversation')
    await writeFile(m.statePath, JSON.stringify({ version: '0.1.3-alpha.1', previousVersion: '0.1.2-rc.1', backupPath: old }))
    m.start = async version => { calls.push(version); if (version === '0.1.2-rc.1') throw new Error('old failed'); return 'url' }
    await assert.rejects(m.rollback(), /old failed/)
    assert.equal(await readFile(join(m.harnessHome, 'session.txt'), 'utf8'), 'new conversation')
    assert.equal(await m.getActiveVersion(), '0.1.3-alpha.1')
    assert.deepEqual(calls, ['0.1.2-rc.1', '0.1.3-alpha.1'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('idle guard uses the official named RPC argument and rejects busy or unknown responses', async () => {
  const { assertRuntimeIdle } = await import('../src/runtime-session-guard.js')
  await assertRuntimeIdle('http://127.0.0.1:1/', async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:1/api/session/list')
    assert.deepEqual(JSON.parse(options.body).payload.args, { _request: {} })
    return response({ result: { ok: true, value: { items: [{ running: false }] } } })
  })
  await assert.rejects(assertRuntimeIdle('http://127.0.0.1:1/', async () => response({ result: { ok: true, value: { items: [{ running: true }] } } })), /仍有任务/)
  await assert.rejects(assertRuntimeIdle('http://127.0.0.1:1/', async () => response({ result: { ok: true, value: { items: [{}] } } })), /无法确认/)
})

test('cleanup retains active and rollback versions, removes stale packages and preserves user data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-retention-'))
  const m = runtime({ root })
  async function installed(version) {
    const path = join(m.runtimeDirectory(version), 'node_modules/@deepseek-ai/dsh')
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'package.json'), JSON.stringify({ version }))
  }
  try {
    await m.initialize()
    for (const version of ['0.1.1-rc.2', '0.1.2-alpha.5', '0.1.2-rc.1']) await installed(version)
    await writeFile(m.statePath, JSON.stringify({ version: '0.1.2-rc.1', previousVersion: '0.1.2-alpha.5', backupPath: join(root, 'backups', 'old') }))
    const retiredHome = join(m.runtimeDirectory('0.1.1-rc.2'), '.harness-home')
    await mkdir(retiredHome); await writeFile(join(retiredHome, 'session.txt'), 'keep retired data')
    await mkdir(join(m.versionsRoot, '0.1.1-rc.1.installing-123'))
    await mkdir(join(m.versionsRoot, 'user-notes')); await writeFile(join(m.harnessHome, 'session.txt'), 'current data')
    const outside = join(root, 'outside'); await mkdir(outside)
    await symlink(outside, join(m.versionsRoot, '0.1.0-rc.1'))
    const preview = await m.cleanupRuntimeVersions({ expectedVersion: '0.1.2-rc.1', dryRun: true })
    assert.deepEqual(preview.removed.sort(), ['0.1.1-rc.1.installing-123', '0.1.1-rc.2'])
    assert.equal(await readFile(join(retiredHome, 'session.txt'), 'utf8'), 'keep retired data')
    const result = await m.cleanupRuntimeVersions({ expectedVersion: '0.1.2-rc.1' })
    assert.deepEqual(result.retained, ['0.1.2-rc.1', '0.1.2-alpha.5'])
    assert.equal(result.removed.length, 2); assert.ok(result.reclaimedBytes > 0)
    await assert.rejects(access(m.runtimeDirectory('0.1.1-rc.2')))
    assert.equal(await readFile(join(m.harnessHome, 'session.txt'), 'utf8'), 'current data')
    const { readdir } = await import('node:fs/promises')
    const backup = (await readdir(join(root, 'backups'))).find(name => name.endsWith('retired-home'))
    assert.equal(await readFile(join(root, 'backups', backup, 'session.txt'), 'utf8'), 'keep retired data')
    await access(join(m.versionsRoot, 'user-notes')); await access(outside)
    await access(m.runtimeDirectory('0.1.2-alpha.5'))
    assert.deepEqual((await m.cleanupRuntimeVersions()).removed, [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('cleanup refuses an unknown or mismatched active version and a failed update never prunes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-retention-failure-'))
  const m = runtime({ root }); let cleaned = false
  try {
    await m.initialize(); await mkdir(m.runtimeDirectory('0.1.0-rc.1'))
    assert.deepEqual((await m.cleanupRuntimeVersions()).removed, [])
    await writeFile(m.statePath, JSON.stringify({ version: '0.1.2-rc.1' }))
    assert.deepEqual((await m.cleanupRuntimeVersions({ expectedVersion: '0.1.3-alpha.1' })).removed, [])
    m.cleanupRuntimeVersions = async () => { cleaned = true }
    m.install = async () => { throw new Error('download failed') }
    await assert.rejects(m.updateAndRestart('0.1.3-alpha.1'), /download failed/)
    assert.equal(cleaned, false); await access(m.runtimeDirectory('0.1.0-rc.1'))
  } finally { await rm(root, { recursive: true, force: true }) }
})
