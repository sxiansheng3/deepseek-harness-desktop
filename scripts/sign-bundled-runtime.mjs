import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, open, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import * as tar from 'tar'
import { loadBundledRuntime } from '../src/bundled-runtime.js'

const run = promisify(execFile)
const machHeaders = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'])

export function hasMachHeader(bytes) {
  return bytes.length >= 4 && machHeaders.has(bytes.subarray(0, 4).toString('hex'))
}

/** Scan by file content: upstream native dependencies may have no extension. */
export async function findMachCandidates(root) {
  const result = []
  for (const item of await readdir(root, { withFileTypes: true })) {
    const path = join(root, item.name)
    if (item.isDirectory()) result.push(...await findMachCandidates(path))
    else if (item.isFile()) {
      const handle = await open(path, 'r')
      try {
        const bytes = Buffer.alloc(4)
        const { bytesRead } = await handle.read(bytes, 0, 4, 0)
        if (hasMachHeader(bytes.subarray(0, bytesRead))) result.push(path)
      } finally { await handle.close() }
    }
  }
  return result
}

/** Sign inside the bundled tar before electron-builder signs the enclosing App. */
export default async function signBundledRuntime(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appName = context.packager.appInfo.productFilename
  const resources = join(context.appOutDir, `${appName}.app`, 'Contents', 'Resources')
  const manifestPath = join(resources, 'bundled-runtime.json')
  const bundled = await loadBundledRuntime(manifestPath)
  const source = await readFile(bundled.archive)
  if (createHash('sha256').update(source).digest('hex') !== bundled.sha256) {
    throw new Error('Bundled Runtime archive failed its pre-signing SHA-256 check')
  }
  const { stdout } = await run('security', ['find-identity', '-v', '-p', 'codesigning'])
  const identities = [...stdout.matchAll(/([A-Fa-f0-9]{40}) "(Developer ID Application: [^"]+)"/g)]
  const requested = process.env.CSC_NAME || context.packager.platformSpecificBuildOptions.identity
  const matches = identities.filter((match) => !requested || match[1] === requested || match[2] === requested)
  if (matches.length !== 1) throw new Error('Select one valid Developer ID Application identity using CSC_NAME before packaging the bundled Runtime')
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-sign-runtime-'))
  try {
    await tar.x({ file: bundled.archive, cwd: temporary, strict: true })
    const signedFiles = []
    for (const path of await findMachCandidates(temporary)) {
      // Java class files share the universal Mach-O magic; confirm the actual format.
      const { stdout: format } = await run('file', ['-b', path])
      if (!format.includes('Mach-O')) continue
      await run('codesign', ['--force', '--sign', matches[0][1], '--timestamp', '--options', 'runtime', '--entitlements', join(context.packager.projectDir, 'build/entitlements.mac.plist'), path])
      await run('codesign', ['--verify', '--strict', path])
      const { stderr: signature } = await run('codesign', ['-dvvv', path])
      if (!signature.includes('Authority=Developer ID Application:') || !signature.includes('Timestamp=') || !signature.includes('runtime')) {
        throw new Error(`Bundled Runtime binary lacks distribution signing requirements: ${path}`)
      }
      signedFiles.push(path.slice(temporary.length + 1))
    }
    await tar.c({ file: bundled.archive, cwd: temporary, gzip: true, portable: true }, await readdir(temporary))
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.sha256 = createHash('sha256').update(await readFile(bundled.archive)).digest('hex')
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await writeFile(join(context.appOutDir, 'bundled-runtime-signing.json'), `${JSON.stringify({ version: bundled.version, sha256: manifest.sha256, signedFiles }, null, 2)}\n`)
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
