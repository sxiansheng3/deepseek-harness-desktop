function decodeHtmlEntities(value) {
  const named = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  }
  return value.replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi, (entity, decimal, hexadecimal, name) => {
    if (decimal !== undefined) return String.fromCodePoint(Number(decimal))
    if (hexadecimal !== undefined) return String.fromCodePoint(Number.parseInt(hexadecimal, 16))
    return named[name.toLowerCase()] ?? entity
  })
}

export function releaseNotesToPlainText(value) {
  if (typeof value !== 'string') return ''
  if (!/<[a-z][\s\S]*?>/i.test(value)) return value.trim()
  return decodeHtmlEntities(value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<\/(?:blockquote|div|h[1-6]|li|ol|p|pre|tr|ul)>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replaceAll('\u00a0', ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function normalizeReleaseNotes(releaseNotes) {
  if (typeof releaseNotes === 'string') return releaseNotesToPlainText(releaseNotes)
  if (!Array.isArray(releaseNotes)) return ''
  return releaseNotes
    .map(note => releaseNotesToPlainText(note?.note))
    .filter(Boolean)
    .join('\n\n')
}

export function isDesktopUpdateNetworkFailure(error) {
  const text = error instanceof Error ? error.message : String(error)
  return /(?:ERR_(?:CONNECTION|NETWORK|PROXY|TIMED_OUT|NAME_NOT_RESOLVED)|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ENOTFOUND|socket hang up|network timeout|fetch failed|HTTP 407)/i.test(text)
}

function publicUpdateInfo(info) {
  if (!info || typeof info.version !== 'string') return undefined
  return {
    version: info.version,
    releaseName: typeof info.releaseName === 'string' ? info.releaseName : undefined,
    releaseNotes: normalizeReleaseNotes(info.releaseNotes),
    releaseDate: typeof info.releaseDate === 'string' ? info.releaseDate : undefined,
  }
}

export class DesktopUpdateManager {
  constructor({ updater, enabled, onStatus, logger = console }) {
    this.updater = updater
    this.enabled = enabled
    this.onStatus = onStatus
    this.logger = logger
    this.networkSession = enabled ? updater.netSession : undefined
    this.status = { available: false, state: enabled ? 'idle' : 'disabled' }
    if (!enabled) return

    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.on('checking-for-update', () => this.setStatus({ available: false, state: 'checking' }))
    updater.on('update-available', info => {
      this.setStatus({ available: true, state: 'available', update: publicUpdateInfo(info) })
    })
    updater.on('update-not-available', () => this.setStatus({ available: false, state: 'idle' }))
    updater.on('download-progress', progress => {
      this.setStatus({
        ...this.status,
        available: true,
        state: 'downloading',
        progress: {
          percent: Number(progress.percent) || 0,
          bytesPerSecond: Number(progress.bytesPerSecond) || 0,
          transferred: Number(progress.transferred) || 0,
          total: Number(progress.total) || 0,
        },
      })
    })
    updater.on('update-downloaded', info => {
      this.setStatus({ available: true, state: 'downloaded', update: publicUpdateInfo(info) ?? this.status.update })
    })
    updater.on('error', error => {
      this.logger.warn(`Desktop update check/download failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  setStatus(status) {
    this.status = status
    this.onStatus?.(status)
  }

  getStatus() {
    return this.status
  }

  async useNetworkRoute(route) {
    await this.networkSession.setProxy({ mode: route.kind === 'direct' ? 'direct' : 'system' })
    await this.networkSession.forceReloadProxyConfig()
  }

  async restoreSystemNetwork() {
    try {
      await this.networkSession.setProxy({ mode: 'system' })
      await this.networkSession.forceReloadProxyConfig()
    } catch (error) {
      this.logger.warn(`Unable to restore updater system proxy mode: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async check() {
    if (!this.enabled) return this.status
    const routes = [
      { kind: 'system', label: '系统网络（含代理）' },
      { kind: 'direct', label: '直接连接' },
    ]
    try {
      for (const [index, route] of routes.entries()) {
        try {
          await this.useNetworkRoute(route)
          await this.updater.checkForUpdates()
          return this.status
        } catch (error) {
          this.logger.warn(`Desktop update check failed through ${route.label}: ${error instanceof Error ? error.message : String(error)}`)
          if (index === routes.length - 1 || !isDesktopUpdateNetworkFailure(error)) break
        }
      }
      this.setStatus({ available: false, state: 'idle' })
    } finally {
      await this.restoreSystemNetwork()
    }
    return this.status
  }

  async download() {
    if (!this.enabled || !this.status.available) throw new Error('当前没有可下载的桌面版更新')
    const update = this.status.update
    const routes = [
      { kind: 'system', label: '系统网络（含代理）' },
      { kind: 'direct', label: '直接连接' },
    ]
    const attemptFailures = []
    try {
      for (const [index, route] of routes.entries()) {
        this.setStatus({ available: true, state: 'downloading', update, route: route.label })
        try {
          await this.useNetworkRoute(route)
          await this.updater.downloadUpdate()
          return this.status
        } catch (error) {
          attemptFailures.push({ label: route.label, error })
          const canRetry = index < routes.length - 1 && isDesktopUpdateNetworkFailure(error)
          if (!canRetry) {
            const failure = new Error(`桌面版 ${update?.version ?? ''} 下载失败`.trim(), { cause: error })
            failure.stage = 'desktop-download'
            failure.attemptFailures = attemptFailures
            throw failure
          }
        }
      }
      return this.status
    } finally {
      await this.restoreSystemNetwork()
    }
  }

  quitAndInstall() {
    if (!this.enabled || this.status.state !== 'downloaded') throw new Error('桌面版更新尚未下载完成')
    this.updater.quitAndInstall(false, true)
  }
}
