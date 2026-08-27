import { join } from 'node:path'

/** Resolve packaged tool entry points without placing Windows CLIs under node_modules. */
export function bundledToolPath(resourcesPath, platform, name) {
  const nodeRoot = join(resourcesPath, 'node')
  if (platform === 'win32') {
    const tools = {
      node: join(nodeRoot, 'node.exe'),
      npm: join(nodeRoot, 'tools', 'npm', 'bin', 'npm-cli.js'),
      pnpm: join(nodeRoot, 'tools', 'pnpm', 'bin', 'pnpm.cjs'),
    }
    return tools[name]
  }
  const tools = {
    node: join(nodeRoot, 'bin', 'node'),
    npm: join(nodeRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    pnpm: join(nodeRoot, 'lib', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
  }
  return tools[name]
}

/** Directory exposed on PATH so Harness can invoke the bundled package manager. */
export function bundledToolDirectory(resourcesPath, platform) {
  const nodeRoot = join(resourcesPath, 'node')
  return platform === 'win32' ? nodeRoot : join(nodeRoot, 'bin')
}
