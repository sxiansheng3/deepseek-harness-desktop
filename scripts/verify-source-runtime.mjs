import { readFile, writeFile, mkdir, cp } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import assert from 'node:assert/strict'
import { RuntimeManager } from '../src/runtime-manager.js'
import { assertRuntimeIdle } from '../src/runtime-session-guard.js'
const { values } = parseArgs({ options: { candidate: { type: 'string' }, archive: { type: 'string' }, previous: { type: 'string' }, work: { type: 'string' }, 'node-bin': { type: 'string', default: process.execPath } } })
if (!values.candidate || !values.archive || !values.previous || !values.work) throw new Error('Usage: npm run runtime:verify -- --candidate <json> --archive <tar.gz> --previous <installed-runtime-directory> --work <new-test-directory> [--node-bin <node>]')
const base=resolve(values.work)
await mkdir(base)
const candidate=JSON.parse(await readFile(values.candidate)).releases[0]
const oldVersion=JSON.parse(await readFile(join(values.previous,'node_modules/@deepseek-ai/dsh/package.json'))).version
const report={sha256:candidate.sha256,commit:candidate.commit,platform:candidate.platform,arch:candidate.arch,checks:{}}
const root=join(base,'runtime')
const m=new RuntimeManager({root,nodeBinary:resolve(values['node-bin']),
 directFetch:async()=>new Response(Readable.toWeb(createReadStream(resolve(values.archive))))})
await m.initialize()
await cp(resolve(values.previous),m.runtimeDirectory(oldVersion),{recursive:true})
await writeFile(m.statePath,JSON.stringify({version:oldVersion}))
await mkdir(join(m.harnessHome,'profiles/web'),{recursive:true})
const plugin=join(base,'fixture-plugin.mjs')
await writeFile(plugin, `import {appendFileSync} from 'node:fs';import {join} from 'node:path';export function apply(){appendFileSync(join(process.env.DSH_HOME,'fixture-plugin-runs.txt'),'loaded\\n')}`)
await writeFile(join(m.harnessHome,'profiles/web/cordis.patch.yml'), `- insert:\n    - id: desktop-acceptance-plugin\n      name: '${plugin}'\n`)
let cookie=''
async function authenticate(){
 const response=await fetch(m.currentUrl,{redirect:'manual'})
 cookie=response.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ')
 assert.equal(response.status,303);assert.ok(cookie,'Expected local authentication cookie')
}
async function authenticated(url,options={}){return fetch(url,{...options,headers:{...options.headers,cookie,origin:new URL(m.currentUrl).origin}})}
async function rpc(method,args){
 const response=await authenticated(new URL('/api/'+method,m.currentUrl),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'qa-'+Date.now(),method,payload:{args}})})
 const text=await response.text();let data;try{data=JSON.parse(text)}catch{throw new Error(`${method}: HTTP ${response.status} non-JSON response`)}; if(!response.ok||!data.result?.ok)throw new Error(`${method}: ${response.status} ${JSON.stringify(data)}`)
 return data.result.value
}
m.assertCanSwitch=()=>assertRuntimeIdle(m.currentUrl,authenticated)
try{
 await m.start(oldVersion);await authenticate();await m.assertCanSwitch();console.log('old idle guard PASS')
 const created=await rpc('session/create',{request:{cwd:base}})
 await rpc('session/rename',{request:{sessionId:created.sessionId,title:'Runtime upgrade acceptance fixture'}})
 await writeFile(join(m.harnessHome,'acceptance-marker.txt'),'before update')
 const pluginRunsBefore=(await readFile(join(m.harnessHome,'fixture-plugin-runs.txt'),'utf8')).trim().split('\n').length
 console.log('old session created and renamed')
 await m.updateAndRestart(candidate.version,{...candidate,source:'source-build'})
 await authenticate();await m.assertCanSwitch()
 report.checks.startup={status:'pass',evidence:'Actual previous version -> source archive installation, CLI/version/profile checks and Web process startup completed.'}
 const page=await authenticated(new URL('/',m.currentUrl));assert.equal(page.status,200);assert.match(await page.text(),/<html/i)
 report.checks.web={status:'pass',evidence:'Installed source Runtime served HTTP 200 HTML; Visual acceptance must additionally be performed before public release.'}
 const list=await rpc('session/list',{_request:{}});assert.ok(list.items.some(x=>x.sessionId===created.sessionId))
 await rpc('session/rename',{request:{sessionId:created.sessionId,title:'Updated on source runtime'}})
 report.checks.sessions={status:'pass',evidence:'Created and renamed an previous version fixture session; source Runtime listed and renamed it after upgrade.'}
 assert.ok((await readFile(join(m.harnessHome,'fixture-plugin-runs.txt'),'utf8')).trim().split('\n').length > pluginRunsBefore)
 report.checks.plugins={status:'pass',evidence:'A user profile patch with an external fixture plugin loaded on previous version and again after the source Runtime upgrade.'}
 await writeFile(join(m.harnessHome,'acceptance-marker.txt'),'after update')
 const rollback=await m.rollback();await authenticate();await m.assertCanSwitch()
 assert.equal(await m.getActiveVersion(),oldVersion);assert.equal(await readFile(join(m.harnessHome,'acceptance-marker.txt'),'utf8'),'before update')
 assert.equal(await readFile(join(rollback.preservedHome,'acceptance-marker.txt'),'utf8'),'after update')
 const restored=await rpc('session/list',{_request:{}});assert.ok(restored.items.some(x=>x.sessionId===created.sessionId))
 report.checks.rollback={status:'pass',evidence:'Real rollback restarted previous version, restored old data and session, and preserved post-upgrade data in a separate backup.'}
 console.log('actual source install/session/rollback PASS')
}catch(error){console.error(error.message);report.error=error.message;process.exitCode=1}
finally{await m.stop();await writeFile(join(base,'acceptance-report.json'),JSON.stringify(report,null,2)+'\n')}
