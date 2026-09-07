import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
const exec = promisify(execFile)

test('promotion requires matching evidence and cannot overwrite an existing build identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-promote-'))
  const archive = join(root, 'artifact.tar.gz')
  const candidate = join(root, 'candidate.json')
  const report = join(root, 'report.json')
  const manifest = join(root, 'manifest.json')
  const sha256 = createHash('sha256').update('abc').digest('hex')
  const artifact = { version: '0.1.3-alpha.1', tag: 'dsh-v0.1.3-alpha.1', commit: 'a'.repeat(40),
    build: 1, platform: 'darwin', arch: 'arm64', minDesktopVersion: '0.1.14', size: 3, sha256,
    url: 'https://github.com/sxiansheng3/deepseek-harness-desktop/releases/download/runtime-test/runtime.tar.gz' }
  const evidence = { sha256, commit: artifact.commit, platform: 'darwin', arch: 'arm64', checks: {} }
  const run = () => exec(process.execPath, ['scripts/promote-runtime.mjs', '--candidate', candidate, '--archive', archive, '--report', report, '--manifest', manifest])
  try {
    await writeFile(archive, 'abc')
    await writeFile(candidate, JSON.stringify({ schemaVersion: 1, releases: [artifact] }))
    await writeFile(report, JSON.stringify(evidence))
    await assert.rejects(run(), /PASS evidence/)
    for (const gate of ['startup', 'web', 'sessions', 'plugins', 'rollback']) evidence.checks[gate] = { status: 'pass', evidence: 'Fixture test completed' }
    await writeFile(report, JSON.stringify(evidence))
    await run()
    const published = JSON.parse(await readFile(manifest))
    assert.equal(published.releases[0].validation.sessions, 'pass')
    const original = await readFile(manifest, 'utf8')
    await assert.rejects(run(), /immutable/)
    assert.equal(await readFile(manifest, 'utf8'), original)
    await writeFile(archive, 'bad')
    await assert.rejects(run(), /match the exact artifact/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
