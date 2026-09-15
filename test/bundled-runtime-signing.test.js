import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasMachHeader, findMachCandidates } from '../scripts/sign-bundled-runtime.mjs'

test('recognizes native Mach-O headers for both architectures and universal binaries', () => {
  for (const magic of ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']) {
    assert.equal(hasMachHeader(Buffer.from(magic, 'hex')), true)
  }
  for (const bytes of [Buffer.from(''), Buffer.from('cf', 'hex'), Buffer.from('some javascript'), Buffer.from('7f454c46', 'hex')]) {
    assert.equal(hasMachHeader(bytes), false)
  }
})

test('discovers nested native dependencies without fixed package names or extensions and skips symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sign-test-'))
  try {
    await mkdir(join(root, 'new-native-package'))
    const binary = join(root, 'new-native-package', 'new-executable-name')
    await writeFile(binary, Buffer.from('cffaedfe00000000', 'hex'))
    await writeFile(join(root, 'misleading.node'), 'plain text')
    await symlink(root, join(root, 'recursive-link'))
    await symlink(binary, join(root, 'binary-link'))
    assert.deepEqual(await findMachCandidates(root), [binary])
  } finally { await rm(root, { recursive: true, force: true }) }
})
