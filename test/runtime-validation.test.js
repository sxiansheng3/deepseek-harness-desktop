import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertRuntimeCapabilities, assertRuntimePackages, assertRuntimeWebReady, resolveRuntimeEntry } from '../src/runtime-validation.js'
import { RuntimeManager } from '../src/runtime-manager.js'
import { writeRuntimeFixture } from './helpers/runtime-fixture.js'

test('accepts renamed upstream plugins and safely parses dynamic defaults', () => {
  for (const name of ['code-runtime', 'ptc-runtime', 'future-runtime']) {
    assert.doesNotThrow(() => assertRuntimeCapabilities(`- id: ${name}\n  name: renamed-package\n  config: !!js process.exit(1)`))
  }
  for (const config of ['', '[]', 'id: web-runtime', '- text', '[invalid']) {
    assert.throws(() => assertRuntimeCapabilities(config), /配置/)
  }
})

test('checks actual transitive dependencies including nested layouts and optional exclusions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dependency-'))
  const dsh = join(root, 'node_modules/@deepseek-ai/dsh')
  const worker = join(dsh, 'node_modules/new-workflow')
  const engine = join(root, 'node_modules/new-engine')
  try {
    await mkdir(worker, { recursive: true }); await mkdir(engine, { recursive: true })
    await writeFile(join(dsh, 'package.json'), JSON.stringify({ dependencies: { 'new-workflow': '*', 'other-platform': '*' }, optionalDependencies: { 'other-platform': '*' } }))
    await writeFile(join(worker, 'package.json'), JSON.stringify({ name: 'new-workflow', dependencies: { 'new-engine': '*' } }))
    await writeFile(join(engine, 'package.json'), '{}')
    await assertRuntimePackages(root)
    await rename(engine, engine + '-missing')
    await assert.rejects(assertRuntimePackages(root), /new-engine.*new-workflow/)
    await rename(engine + '-missing', engine)
    await writeFile(join(engine, 'package.json'), JSON.stringify({ dependencies: { 'new-workflow': '*' } }))
    // A dependency cannot borrow a sibling's nested dependency.
    await assert.rejects(assertRuntimePackages(root), /new-workflow/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('rejects dependencies escaping the installation through symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dependency-link-'))
  try {
    await writeRuntimeFixture(join(root, 'runtime'), '0.1.6-alpha.1')
    await mkdir(join(root, 'external'))
    await writeFile(join(root, 'external/package.json'), '{}')
    const dsh = join(root, 'runtime/node_modules/@deepseek-ai/dsh/package.json')
    await writeFile(dsh, JSON.stringify({ dependencies: { external: '*' } }))
    await symlink(join(root, 'external'), join(root, 'runtime/node_modules/external'))
    await assert.rejects(assertRuntimePackages(join(root, 'runtime')), /outside/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('rejects external authentication redirects without following them', async () => {
  let requests = 0
  await assert.rejects(assertRuntimeWebReady('http://127.0.0.1:3000/?token=test', async () => {
    requests += 1
    return new Response(null, { status: 303, headers: { location: 'https://example.com' } })
  }), /登录跳转/)
  assert.equal(requests, 1)
})

test('supports an unauthenticated older Runtime and rejects broken pages', async () => {
  await assertRuntimeWebReady('http://127.0.0.1:3000/', async url => new Response(
    url.endsWith('/api/session/list') ? JSON.stringify({ result: { ok: true, value: { items: [] } } }) : '<html>Legacy</html>',
  ))
  await assert.rejects(assertRuntimeWebReady('http://127.0.0.1:3000/', async () => new Response('unavailable', { status: 503 })), /页面/)
})

test('discovers a relocated CLI and supports profile-only releases without config dumping', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cli-layout-'))
  try {
    await writeRuntimeFixture(root, '0.2.0', { profileOnly: true, noDump: true })
    const pkg = join(root, 'node_modules/@deepseek-ai/dsh')
    await rename(join(pkg, 'lib/bin.js'), join(pkg, 'future.cjs'))
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0', bin: { dsh: './future.cjs' } }))
    assert.equal(await resolveRuntimeEntry(root), await realpath(join(pkg, 'future.cjs')))
    const m = new RuntimeManager({ root: join(root, 'managed'), nodeBinary: process.execPath, logger: { warn() {} } })
    await m.verifyRuntimeDirectory(root, '0.2.0')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('real isolated preflight authenticates and rejects a changed API before touching active data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-preflight-'))
  const manager = new RuntimeManager({ root: join(root, 'active'), nodeBinary: process.execPath })
  try {
    await manager.initialize()
    await writeFile(manager.statePath, JSON.stringify({ version: '0.1.5-rc.2' }))
    await writeFile(join(manager.harnessHome, 'marker'), 'user data')
    await writeRuntimeFixture(manager.runtimeDirectory('0.1.5-rc.2'), '0.1.5-rc.2')
    await manager.start('0.1.5-rc.2')
    const activeProcess = manager.process
    const candidate = join(root, 'candidate')
    await writeRuntimeFixture(candidate, '0.1.6-alpha.1')
    await manager.verifyRuntimeDirectory(candidate, '0.1.6-alpha.1')
    await writeRuntimeFixture(candidate, '0.1.6-alpha.1', { brokenApi: true })
    await assert.rejects(manager.verifyRuntimeDirectory(candidate, '0.1.6-alpha.1'), /会话接口.*不兼容/)
    assert.equal(await manager.getActiveVersion(), '0.1.5-rc.2')
    assert.equal(await readFile(join(manager.harnessHome, 'marker'), 'utf8'), 'user data')
    assert.equal((await readdir(candidate)).includes('.verification-home'), false)
    assert.equal(manager.process, activeProcess)
    assert.equal(activeProcess.exitCode, null)
  } finally { await manager.stop(); await rm(root, { recursive: true, force: true }) }
})
