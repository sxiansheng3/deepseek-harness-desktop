import { readFile, writeFile, mkdir, cp } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import assert from 'node:assert/strict'
import { RuntimeManager } from '../src/runtime-manager.js'
import { assertRuntimeIdle } from '../src/runtime-session-guard.js'
const { values } = parseArgs({ options: {
  version: { type: 'string' }, previous: { type: 'string' }, work: { type: 'string' },
  'node-bin': { type: 'string', default: process.execPath }, 'npm-bin': { type: 'string' },
} })
if (!values.version || !values.previous || !values.work || !values['npm-bin']) {
  throw new Error('Usage: node scripts/verify-runtime-upgrade.mjs --version <version> --previous <runtime-directory> --work <new-test-directory> --npm-bin <npm-cli.js> [--node-bin <node>]')
}
const base = resolve(values.work)
await mkdir(base)
const version = values.version
const oldVersion=JSON.parse(await readFile(join(values.previous,'node_modules/@deepseek-ai/dsh/package.json'))).version
const report={version,previousVersion:oldVersion,platform:process.platform,arch:process.arch,checks:{}}
const root=join(base,'runtime')
const m=new RuntimeManager({root,nodeBinary:resolve(values['node-bin']),npmBinary:resolve(values['npm-bin'])})
await m.initialize()
await cp(resolve(values.previous),m.runtimeDirectory(oldVersion),{
 recursive:true,filter:source=>!['.harness-home','.verification-home'].includes(basename(source)),
})
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
 await m.updateAndRestart(version)
 await authenticate();await m.assertCanSwitch()
 report.checks.startup={status:'pass',evidence:'Actual previous version -> official npm installation, CLI/version/profile checks and Web process startup completed.'}
 const page=await authenticated(new URL('/',m.currentUrl));assert.equal(page.status,200);assert.match(await page.text(),/<html/i)
 report.checks.web={status:'pass',evidence:'Installed new Runtime served HTTP 200 HTML; Visual acceptance must additionally be performed before public release.'}
 const list=await rpc('session/list',{_request:{}});assert.ok(list.items.some(x=>x.sessionId===created.sessionId))
 await rpc('session/rename',{request:{sessionId:created.sessionId,title:'Updated on new Runtime'}})
 report.checks.sessions={status:'pass',evidence:'Created and renamed an previous version fixture session; new Runtime listed and renamed it after upgrade.'}
 assert.ok((await readFile(join(m.harnessHome,'fixture-plugin-runs.txt'),'utf8')).trim().split('\n').length > pluginRunsBefore)
 report.checks.plugins={status:'pass',evidence:'A user profile patch with an external fixture plugin loaded on previous version and again after the new Runtime upgrade.'}
 await writeFile(join(m.harnessHome,'acceptance-marker.txt'),'after update')
 const rollback=await m.rollback();await authenticate();await m.assertCanSwitch()
 assert.equal(await m.getActiveVersion(),oldVersion);assert.equal(await readFile(join(m.harnessHome,'acceptance-marker.txt'),'utf8'),'before update')
 assert.equal(await readFile(join(rollback.preservedHome,'acceptance-marker.txt'),'utf8'),'after update')
 const restored=await rpc('session/list',{_request:{}});assert.ok(restored.items.some(x=>x.sessionId===created.sessionId))
 report.checks.rollback={status:'pass',evidence:'Real rollback restarted previous version, restored old data and session, and preserved post-upgrade data in a separate backup.'}
 console.log('actual npm install/session/plugin/rollback PASS')
}catch(error){console.error(error.message);report.error=error.message;process.exitCode=1}
finally{await m.stop();await writeFile(join(base,'acceptance-report.json'),JSON.stringify(report,null,2)+'\n')}
