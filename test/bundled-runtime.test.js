import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { bundledRuntimeStartupAction, loadBundledRuntime } from '../src/bundled-runtime.js'
import {
  compareRuntimeVersions,
  REQUIRED_RUNTIME_PACKAGES,
  REQUIRED_WEB_CAPABILITIES,
  RuntimeManager,
} from '../src/runtime-manager.js'

const execFileAsync = promisify(execFile)
const TEST_SHA256 = 'a'.repeat(64)

test('loads a bundled Runtime manifest only from inside the application resources folder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bundled-manifest-'))
  const manifestPath = join(root, 'bundled-runtime.json')
  try {
    await mkdir(join(root, 'bundled-runtime'), { recursive: true })
    await writeFile(manifestPath, JSON.stringify({
      version: '0.1.2-alpha.2',
      archive: 'bundled-runtime/0.1.2-alpha.2.tar.gz',
      sha256: TEST_SHA256,
    }))
    assert.deepEqual(await loadBundledRuntime(manifestPath), {
      version: '0.1.2-alpha.2',
      archive: join(root, 'bundled-runtime', '0.1.2-alpha.2.tar.gz'),
      sha256: TEST_SHA256,
    })
    await writeFile(manifestPath, JSON.stringify({
      version: '0.1.2-alpha.2', archive: '../outside.tar.gz', sha256: TEST_SHA256,
    }))
    await assert.rejects(loadBundledRuntime(manifestPath), /escapes the application resources folder/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('prefers a newer bundled Runtime without downgrading a later user-installed version', () => {
  assert.equal(compareRuntimeVersions('0.1.2-alpha.2', '0.1.1-rc.2'), 1)
  assert.equal(compareRuntimeVersions('0.1.2-alpha.2', '0.1.2-alpha.1'), 1)
  assert.equal(compareRuntimeVersions('0.1.2', '0.1.2-alpha.2'), 1)
  assert.equal(compareRuntimeVersions('0.1.2-alpha.2', '0.1.2-alpha.2'), 0)
  assert.deepEqual(bundledRuntimeStartupAction(undefined, '0.1.2-alpha.2'), {
    action: 'fresh-install', version: '0.1.2-alpha.2',
  })
  assert.deepEqual(bundledRuntimeStartupAction('0.1.1-rc.2', '0.1.2-alpha.2'), {
    action: 'upgrade', version: '0.1.2-alpha.2',
  })
  assert.deepEqual(bundledRuntimeStartupAction('0.1.2-alpha.2', '0.1.2-alpha.2'), {
    action: 'ensure-installed', version: '0.1.2-alpha.2',
  })
  assert.deepEqual(bundledRuntimeStartupAction('0.1.3-alpha.1', '0.1.2-alpha.2'), {
    action: 'use-active', version: '0.1.3-alpha.1',
  })
})

test('installs and verifies the complete bundled Runtime without invoking npm', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bundled-install-'))
  const version = '0.1.2-alpha.2'
  const source = join(root, 'runtime-source')
  const archive = join(root, 'application-resources', 'bundled-runtime', `${version}.tar.gz`)
  const dshRoot = join(source, 'node_modules', '@deepseek-ai', 'dsh')
  const progress = []
  try {
    await mkdir(join(dshRoot, 'lib'), { recursive: true })
    await writeFile(join(dshRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
    const config = REQUIRED_WEB_CAPABILITIES.map(id => `- id: ${id}`).join('\\n')
    await writeFile(join(dshRoot, 'lib', 'bin.js'), [
      "const args = process.argv.slice(2)",
      `if (args.includes('--version')) console.log('${version}')`,
      `else if (args.includes('--dump-default-config')) console.log(${JSON.stringify(config)})`,
      "else process.exitCode = 2",
    ].join('\n'))
    for (const packageName of REQUIRED_RUNTIME_PACKAGES) {
      const packageRoot = join(source, 'node_modules', '@deepseek-ai', packageName)
      await mkdir(packageRoot, { recursive: true })
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${packageName}`, version }))
    }
    await mkdir(join(source, 'node_modules', '.bin'), { recursive: true })
    await symlink('../@deepseek-ai/dsh/lib/bin.js', join(source, 'node_modules', '.bin', 'dsh'))
    await mkdir(join(root, 'application-resources', 'bundled-runtime'), { recursive: true })
    await execFileAsync('/usr/bin/tar', ['-czf', archive, '-C', source, '.'])
    const archiveHash = createHash('sha256').update(await readFile(archive)).digest('hex')

    const runtime = new RuntimeManager({
      root: join(root, 'user-runtime'),
      nodeBinary: process.execPath,
      npmBinary: join(root, 'npm-must-not-run'),
      bundledRuntime: { version, archive, sha256: archiveHash },
      platform: 'darwin',
      onProgress: value => progress.push(value),
    })
    await runtime.initialize()
    const target = await runtime.install(version)
    assert.equal(target, runtime.runtimeDirectory(version))
    assert.equal(JSON.parse(await readFile(join(target, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))).version, version)
    assert.equal(await readlink(join(target, 'node_modules', '.bin', 'dsh')), '../@deepseek-ai/dsh/lib/bin.js')
    assert.equal(await runtime.isInstalledRuntimeReady(target, version), true)
    assert.equal(progress.some(item => item.phase === 'install' && item.message.includes('无需下载')), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
