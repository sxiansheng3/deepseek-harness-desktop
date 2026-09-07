import { readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { hashFile, RELEASE_GATES, validateRuntimeArtifact } from '../src/runtime-artifacts.js'

const { values } = parseArgs({ options: { candidate: { type: 'string' }, archive: { type: 'string' }, report: { type: 'string' }, manifest: { type: 'string' } } })
if (Object.values(values).length !== 4) throw new Error('Usage: npm run runtime:promote -- --candidate <json> --archive <tar.gz> --report <acceptance.json> --manifest <channel.json>')
const candidate = JSON.parse(await readFile(values.candidate, 'utf8'))
if (candidate.schemaVersion !== 1 || candidate.releases?.length !== 1) throw new Error('Expected one candidate')
const artifact = validateRuntimeArtifact(candidate.releases[0])
const report = JSON.parse(await readFile(values.report, 'utf8'))
if (await hashFile(values.archive) !== artifact.sha256 || report.sha256 !== artifact.sha256 || report.commit !== artifact.commit
  || report.platform !== artifact.platform || report.arch !== artifact.arch
  || !RELEASE_GATES.every(gate => report.checks?.[gate]?.status === 'pass' && typeof report.checks[gate].evidence === 'string' && report.checks[gate].evidence.trim())) {
  throw new Error('Acceptance report must match the exact artifact and contain PASS evidence for every gate')
}
let channel = { schemaVersion: 1, releases: [] }
try { channel = JSON.parse(await readFile(values.manifest, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
if (channel.schemaVersion !== 1 || !Array.isArray(channel.releases)) throw new Error('Invalid existing channel')
channel.releases.forEach(validateRuntimeArtifact)
if (channel.releases.some(item => item.version === artifact.version && item.build === artifact.build && item.platform === artifact.platform && item.arch === artifact.arch)) throw new Error('Published build identities are immutable; increment the build number')
artifact.validation = { ...Object.fromEntries(RELEASE_GATES.map(gate => [gate, 'pass'])), reportSha256: await hashFile(values.report) }
channel.releases.push(artifact)
await writeFile(values.manifest, JSON.stringify(channel, null, 2) + '\n')
console.log('Local channel manifest prepared. Upload the verified archive and report first, then publish this manifest.')
