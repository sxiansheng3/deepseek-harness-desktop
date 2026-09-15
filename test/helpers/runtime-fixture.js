import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function writeRuntimeFixture(directory, version, { brokenApi = false, profileOnly = false, noDump = false } = {}) {
  const root = join(directory, 'node_modules/@deepseek-ai/dsh')
  await mkdir(join(root, 'lib'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version, bin: { dsh: 'lib/bin.js' } }))
  await writeFile(join(root, 'lib/bin.js'), `
const { createServer } = require('node:http');
const args = process.argv.slice(2);
if ((${profileOnly} && args[0] === 'web') || (${noDump} && args.includes('--dump-default-config'))) {
  console.error('error: unknown command or option'); process.exit(1);
}
if (args.includes('--version')) console.log(${JSON.stringify(version)});
else if (args.includes('--dump-default-config')) console.log('- id: renamed-engine\\n  name: future-package');
else if (args.includes('--help')) console.log('--no-open --port <port> pass 0 to let the OS pick a free one');
else {
  const server = createServer((req, res) => {
    if (req.url === '/?token=fixture') {
      res.writeHead(303, { location: '/', 'set-cookie': 'fixture=authenticated; HttpOnly' }); res.end();
    } else if (req.headers.cookie !== 'fixture=authenticated') {
      res.writeHead(401); res.end('Unauthorized');
    } else if (req.url === '/api/session/list') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(${brokenApi ? '{ result: { ok: true, value: { changed: [] } } }' : '{ result: { ok: true, value: { items: [] } } }'}));
    } else { res.end('<html><body>Harness fixture</body></html>'); }
  });
  server.listen(Number(args[args.indexOf('--port') + 1]), '127.0.0.1', () => {
    console.log('dsh web: http://127.0.0.1:' + server.address().port + '/?token=fixture');
  });
}
`)
}
