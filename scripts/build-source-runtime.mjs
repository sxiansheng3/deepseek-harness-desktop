import { spawn } from 'node:child_process'
import { access, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { delimiter, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import * as tar from 'tar'
import { RuntimeManager, runtimeVersionFromReleaseTag } from '../src/runtime-manager.js'
import { hashFile } from '../src/runtime-artifacts.js'

const { values } = parseArgs({ options: {
  tag: { type: 'string' }, work: { type: 'string' }, out: { type: 'string' },
  build: { type: 'string', default: '1' }, 'node-bin': { type: 'string', default: process.execPath },
  'min-desktop': { type: 'string', default: '0.1.14' },
} })
const version = runtimeVersionFromReleaseTag(values.tag)
if (!version || values.tag !== `dsh-v${version}` || !values.work || !values.out || !/^[1-9]\d*$/.test(values.build)) {
  throw new Error('Usage: npm run runtime:build -- --tag dsh-v<VERSION> --work <new-build-directory> --out <output-directory> [--build 1]')
}
const work = resolve(values.work)
const out = resolve(values.out)
const source = join(work, 'source')
const consumer = join(work, 'runtime')
const nodeBinary = resolve(values['node-bin'])
const environment = { ...process.env, PATH: `${dirname(nodeBinary)}${delimiter}${process.env.PATH ?? ''}`,
  DSH_TELEMETRY_MODE: 'DISABLED', DSH_TELEMETRY_DISABLED: '1', DSH_HOME: join(work, 'build-home') }
for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'DSH_AGENTS_HOME']) delete environment[key]
async function run(command, args, cwd = source, capture = false) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env: environment, stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'] })
    let output = ''
    if (capture) { child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => process.stderr.write(chunk)) }
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolveRun(output.trim()) : reject(new Error(`${command} exited with ${code}`)))
  })
}
await mkdir(work, { recursive: true })
await mkdir(out, { recursive: true })
try { await access(source) } catch { await run('git', ['clone', '--depth', '1', '--branch', values.tag, 'https://github.com/deepseek-ai/deepseek-harness.git', source], work) }
const origin = await run('git', ['remote', 'get-url', 'origin'], source, true)
const commit = await run('git', ['rev-parse', 'HEAD'], source, true)
const tagCommit = await run('git', ['rev-parse', `${values.tag}^{commit}`], source, true)
const remoteTag = await run('git', ['ls-remote', origin, `refs/tags/${values.tag}`, `refs/tags/${values.tag}^{}`], source, true)
if (origin !== 'https://github.com/deepseek-ai/deepseek-harness.git' || commit !== tagCommit
  || !remoteTag.split('\n').some(line => line.startsWith(`${commit}\t`))
  || (await run('git', ['status', '--porcelain', '--untracked-files=normal'], source, true)).split('\n').filter(line => line && line !== '?? dist/').length) throw new Error('Source must be a clean checkout of the exact official release tag')
await run('pnpm', ['install', '--frozen-lockfile'])
await run('pnpm', ['run', 'build:official'])
for (const family of ['dsh', 'vendor']) await run('pnpm', ['run', 'release:pack', '--family', family, '--out', `dist/npm-${family}`])
await run('pnpm', ['--dir', 'native/landlock-run', 'run', 'build:ts'])
await run('pnpm', ['--dir', 'native/landlock-run/packages/entry', 'pack', '--pack-destination', join(source, 'dist/npm-landlock')])
const dependencies = {}
for (const folder of ['npm-dsh', 'npm-vendor', 'npm-landlock']) {
  for (const file of await readdir(join(source, 'dist', folder))) {
    if (!file.endsWith('.tgz')) continue
    const path = join(source, 'dist', folder, file)
    let manifest
    await tar.t({ file: path, onReadEntry(entry) {
      if (entry.path !== 'package/package.json') return
      let text = ''
      entry.on('data', chunk => { text += chunk })
      entry.on('end', () => { manifest = JSON.parse(text) })
    } })
    if (!manifest?.name) throw new Error(`Missing package identity: ${file}`)
    dependencies[manifest.name] = pathToFileURL(path).href
  }
}
// Refuse to reuse a consumer tree; the resulting bundle must be a fresh install.
await mkdir(consumer)
await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, dependencies }, null, 2))
await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--package-lock=false'], consumer)
const manager = new RuntimeManager({ root: join(work, 'verification'), nodeBinary })
await manager.verifyRuntimeDirectory(consumer, version)
// Runtime packages are fully installed. Do not ship build-machine file: paths or npm cache locks.
await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, version }))
await rm(join(consumer, 'node_modules', '.package-lock.json'), { force: true })
const name = `harness-${version}-build.${values.build}-${process.platform}-${process.arch}.tar.gz`
const archive = join(out, name)
try { await access(archive); throw new Error('Artifact already exists; use a new build number or output directory') } catch (error) { if (error.code !== 'ENOENT') throw error }
await tar.c({ cwd: consumer, file: archive, gzip: true, portable: true }, ['package.json', 'node_modules'])
const { stat } = await import('node:fs/promises')
const artifact = { version, tag: values.tag, commit, build: Number(values.build), platform: process.platform, arch: process.arch,
  minDesktopVersion: values['min-desktop'], size: (await stat(archive)).size, sha256: await hashFile(archive),
  url: `https://github.com/sxiansheng3/deepseek-harness-desktop/releases/download/runtime-${version}-build.${values.build}/${name}`,
  validation: { startup: 'unverified', web: 'unverified', sessions: 'unverified', plugins: 'unverified', rollback: 'unverified' } }
await writeFile(join(out, 'runtime-candidate.json'), JSON.stringify({ schemaVersion: 1, releases: [artifact] }, null, 2) + '\n')
console.log(`Built ${archive}. Candidate is NOT eligible for updates until acceptance gates pass.`)
