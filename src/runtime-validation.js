import { createRequire } from 'node:module'
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseDocument } from 'yaml'
import { assertRuntimeIdle } from './runtime-session-guard.js'

function isInside(root, path) {
  const child = relative(root, path)
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

/** npm's bin declaration can move independently of the desktop release. */
export async function resolveRuntimeEntry(directory) {
  const root = await realpath(join(directory, 'node_modules/@deepseek-ai/dsh'))
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
  const path = await realpath(resolve(root, bin ?? 'lib/bin.js'))
  if (!isInside(root, path)) throw new Error('Runtime CLI entry escapes its package')
  return path
}

/** Follow this release's dependency graph, not another release's internal package names. */
export async function assertRuntimePackages(directory) {
  const root = await realpath(directory)
  const visited = new Set()
  async function visit(manifestPath) {
    const path = await realpath(manifestPath)
    if (!isInside(root, path)) throw new Error('Runtime dependency resolves outside its installation')
    if (visited.has(path)) return
    visited.add(path)
    const manifest = JSON.parse(await readFile(path, 'utf8'))
    const require = createRequire(path)
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (Object.hasOwn(manifest.optionalDependencies ?? {}, name)) continue
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new Error('Invalid Runtime dependency name')
      let dependency
      for (const base of require.resolve.paths(name) ?? []) {
        if (!isInside(root, base)) continue
        try {
          dependency = await realpath(join(base, name, 'package.json'))
          break
        } catch (error) {
          if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
        }
      }
      if (!dependency) throw new Error(`Runtime 缺少该版本声明的依赖：${name}（由 ${manifest.name ?? 'Runtime'} 引用）`)
      await visit(dependency)
    }
  }
  await visit(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
}

/** Inspect YAML without evaluating upstream !!js expressions or freezing plugin IDs. */
export function assertRuntimeCapabilities(output) {
  const document = parseDocument(output, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }],
  })
  if (document.errors.length) throw new Error('Runtime 默认 Web 配置无法解析')
  const entries = document.toJS({ maxAliasCount: 100 })
  if (!Array.isArray(entries) || entries.length === 0
    || entries.some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
    throw new Error('Runtime 默认 Web 配置格式不兼容')
  }
}

/** Exercise only the local contracts the desktop needs, using an isolated probe home. */
export async function assertRuntimeWebReady(url, fetcher = fetch) {
  const launch = new URL(url)
  if (launch.protocol !== 'http:' || launch.hostname !== '127.0.0.1') throw new Error('无效的本机 Runtime 地址')
  const request = (target, options = {}) => fetcher(target, {
    ...options, redirect: 'manual', signal: AbortSignal.timeout(15_000),
  })
  const response = await request(launch.href)
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const headers = { cookie, origin: launch.origin }
  let page = response
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location')
    const destination = location && new URL(location, launch)
    if (!destination || destination.origin !== launch.origin) throw new Error('Runtime 登录跳转不兼容')
    await response.body?.cancel()
    page = await request(destination.href, { headers })
  }
  if (!page.ok || !/<html[\s>]/i.test(await page.text())) throw new Error('Runtime 页面未正常就绪')
  try {
    await assertRuntimeIdle(launch.href, (target, options) => request(target, {
      ...options, headers: { ...options.headers, ...headers },
    }))
  } catch (error) {
    throw new Error(`Runtime 会话接口与桌面端不兼容：${error.message}`, { cause: error })
  }
}
