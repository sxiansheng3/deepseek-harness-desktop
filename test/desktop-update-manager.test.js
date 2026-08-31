import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  DesktopUpdateManager,
  isDesktopUpdateNetworkFailure,
  normalizeReleaseNotes,
  releaseNotesToPlainText,
} from '../src/desktop-update-manager.js'

class FakeUpdater extends EventEmitter {
  constructor({ checks = [], downloads = [] } = {}) {
    super()
    this.checks = checks
    this.downloads = downloads
    this.proxyModes = []
    this.reloadCount = 0
    this.netSession = {
      setProxy: async config => { this.proxyModes.push(config.mode) },
      forceReloadProxyConfig: async () => { this.reloadCount += 1 },
    }
  }

  async checkForUpdates() {
    this.emit('checking-for-update')
    const result = this.checks.shift()
    if (result instanceof Error) {
      this.emit('error', result)
      throw result
    }
    if (result) this.emit('update-available', result)
    else this.emit('update-not-available', { version: '0.1.5' })
    return { updateInfo: result }
  }

  async downloadUpdate() {
    const result = this.downloads.shift()
    if (result instanceof Error) {
      this.emit('error', result)
      throw result
    }
    this.emit('download-progress', {
      percent: 42.5,
      bytesPerSecond: 3_000_000,
      transferred: 85,
      total: 200,
    })
    this.emit('update-downloaded', result)
    return ['/tmp/update.zip']
  }

  quitAndInstall(isSilent, isForceRunAfter) {
    this.installArguments = [isSilent, isForceRunAfter]
  }
}

test('normalizes desktop release notes from macOS updater metadata', () => {
  assert.equal(normalizeReleaseNotes('  修复更新问题  '), '修复更新问题')
  assert.equal(normalizeReleaseNotes([
    { version: '0.1.7', note: '新增更新速度' },
    { version: '0.1.6', note: '支持代理回退' },
  ]), '新增更新速度\n\n支持代理回退')
  assert.equal(normalizeReleaseNotes(undefined), '')
})

test('renders GitHub HTML release notes as readable plain text', () => {
  const html = '<h2>图片兼容修复</h2><ul><li>修复图片能力判断。</li><li>避免 read_image &amp; crop 重复调用。</li></ul><script>alert(1)</script>'
  assert.equal(
    releaseNotesToPlainText(html),
    '图片兼容修复\n• 修复图片能力判断。\n• 避免 read_image & crop 重复调用。',
  )
  assert.equal(normalizeReleaseNotes([{ note: '<p>第一项</p>' }, { note: '<p>第二项</p>' }]), '第一项\n\n第二项')
})

test('recognizes only network failures as eligible for a direct retry', () => {
  assert.equal(isDesktopUpdateNetworkFailure(new Error('net::ERR_PROXY_CONNECTION_FAILED')), true)
  assert.equal(isDesktopUpdateNetworkFailure(new Error('connect ETIMEDOUT')), true)
  assert.equal(isDesktopUpdateNetworkFailure(new Error('sha512 checksum mismatch')), false)
})

test('keeps the desktop update hidden when this build is not packaged', async () => {
  const updater = new FakeUpdater()
  const manager = new DesktopUpdateManager({ updater, enabled: false })
  assert.deepEqual(manager.getStatus(), { available: false, state: 'disabled' })
  assert.deepEqual(await manager.check(), { available: false, state: 'disabled' })
  assert.deepEqual(updater.proxyModes, [])
})

test('checks through the system route and falls back to a direct route on a proxy failure', async () => {
  const update = {
    version: '0.1.6',
    releaseName: 'DeepSeek Harness Desktop 0.1.6',
    releaseNotes: '显示更新进度与速度',
    releaseDate: '2026-08-27T00:00:00.000Z',
  }
  const updater = new FakeUpdater({ checks: [new Error('net::ERR_PROXY_CONNECTION_FAILED'), update] })
  const statuses = []
  const manager = new DesktopUpdateManager({
    updater,
    enabled: true,
    onStatus: status => statuses.push(status),
    logger: { warn() {} },
  })

  const status = await manager.check()
  assert.equal(status.available, true)
  assert.equal(status.state, 'available')
  assert.equal(status.update.version, '0.1.6')
  assert.equal(status.update.releaseNotes, '显示更新进度与速度')
  assert.deepEqual(updater.proxyModes, ['system', 'direct', 'system'])
  assert.equal(statuses.some(value => value.state === 'available'), true)
})

test('reports exact desktop download progress and preserves the update contents', async () => {
  const update = { version: '0.1.6', releaseNotes: '更新内容' }
  const updater = new FakeUpdater({ checks: [update], downloads: [update] })
  const statuses = []
  const manager = new DesktopUpdateManager({
    updater,
    enabled: true,
    onStatus: status => statuses.push(status),
    logger: { warn() {} },
  })
  await manager.check()
  const status = await manager.download()

  assert.equal(status.available, true)
  assert.equal(status.state, 'downloaded')
  assert.equal(status.update.releaseNotes, '更新内容')
  assert.equal(statuses.some(value => value.progress?.bytesPerSecond === 3_000_000), true)
  assert.deepEqual(updater.proxyModes, ['system', 'system', 'system', 'system'])
  manager.quitAndInstall()
  assert.deepEqual(updater.installArguments, [false, true])
})

test('retains detailed failure reasons for system and direct desktop downloads', async () => {
  const update = { version: '0.1.6' }
  const updater = new FakeUpdater({
    checks: [update],
    downloads: [new Error('net::ERR_TIMED_OUT'), new Error('net::ERR_NAME_NOT_RESOLVED')],
  })
  const manager = new DesktopUpdateManager({ updater, enabled: true, logger: { warn() {} } })
  await manager.check()

  await assert.rejects(manager.download(), error => {
    assert.equal(error.stage, 'desktop-download')
    assert.deepEqual(error.attemptFailures.map(attempt => attempt.label), ['系统网络（含代理）', '直接连接'])
    assert.match(error.cause.message, /NAME_NOT_RESOLVED/)
    return true
  })
  assert.deepEqual(updater.proxyModes, ['system', 'system', 'system', 'direct', 'system'])
})
