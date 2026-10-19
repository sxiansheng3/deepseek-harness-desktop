import { app, BrowserWindow, ipcMain, screen, session, shell } from 'electron'
import { desktopDialogBounds, showDesktopDialog } from './desktop-dialog.js'
import { assertRuntimeIdle, stopIdleRuntime } from './runtime-session-guard.js'
import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import {
  conciseRuntimeStartupFailure,
  RuntimeManager,
  writeRuntimeStartupDiagnostic,
} from './runtime-manager.js'
import { bundledRuntimeStartupAction, loadBundledRuntime } from './bundled-runtime.js'
import { DesktopUpdateManager } from './desktop-update-manager.js'
import { buildRuntimeUpdateDialogHtml, chineseReleaseNotes, runtimeUpdateDialogAction } from './runtime-update-dialog.js'
import { isHiddenAcceptance, isTrustedHarnessFrame, loadLocalRuntimeUrl, removeStaleHarnessAuthCookies } from './local-runtime-loader.js'
import { installApplicationMenu } from './menu.js'
import { bundledToolDirectory, bundledToolPath } from './tool-layout.js'
import { VisionCompatibilityManager } from './vision-compatibility-manager.js'
import {
  MODEL_CATALOG_ENDPOINT,
  PROJECTIONS_ENDPOINT,
  PROMPT_ENDPOINT,
  compatibilityPromptText,
  imageContentFromPromptRequest,
  isPromptRequestUrl,
  loopbackRequestUrlPatterns,
  parseCapturedPromptRequest,
  promptArgs,
  rpcRequestBody,
  rpcRequestUrl,
  selectionFromModelCatalogPayload,
  selectionFromProjectionPayload,
} from './vision-bridge-protocol.js'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater
const showMessageDialog = (...args) => showDesktopDialog({ BrowserWindow, screen }, ...args)

const APP_NAME = 'DeepSeek Harness Desktop'
// Desktop shell update polling: a quick first check right after startup, then keep
// watching the release channel so a newly published version shows the badge in
// real time without requiring the user to quit and reopen the application.
const DESKTOP_UPDATE_FIRST_CHECK_DELAY_MS = 3_000
const DESKTOP_UPDATE_POLL_INTERVAL_MS = Number(process.env.DSH_DESKTOP_UPDATE_POLL_MS) || 5 * 60_000
// Harness Runtime update polling: keep watching the release channel while the app
// is running so a newly published runtime also surfaces without a manual check.
const HARNESS_UPDATE_FIRST_CHECK_DELAY_MS = 10_000
const HARNESS_UPDATE_POLL_INTERVAL_MS = Number(process.env.DSH_HARNESS_UPDATE_POLL_MS) || 5 * 60_000
let mainWindow
let runtime
let desktopUpdater
let visionCompatibility
let shuttingDown = false
let runtimeUpdateInProgress = false
let promptedHarnessVersion
let promptedDesktopVersion
let updatePromptOpen = false
const recentImagePrompts = new Map()
const visionFallbacks = new Set()
const completedVisionFallbacks = new Set()
const visionFallbackAttempts = new Map()
// One visible error per captured prompt: a retry (or a repeated failure) must
// not spam the status card, and a silent skip must not report anything at all.
const reportedVisionErrors = new Set()
// Observable escape hatch for the silent-degradation paths. The bridge must not
// raise a banner when it cannot name the session's model, so it logs through
// this switch instead: launch the desktop shell with
// `DSH_DESKTOP_VISION_DEBUG=1` to read lines such as
// `[desktop-vision] 当前会话未记录模型选择，跳过视觉桥接` and
// `[desktop-vision] 无法读取当前会话模型，跳过视觉桥接：<reason>`.
const VISION_DEBUG = process.env.DSH_DESKTOP_VISION_DEBUG === '1'
// The original prompt has already been dispatched by the time the capture hook
// runs; wait for its rejection before injecting the text-only replacement.
const VISION_CAPTURE_SETTLE_MS = 450
const MAX_VISION_FALLBACK_ATTEMPTS = 2
const VISION_RETRY_WINDOW_MS = 60_000
const VISION_FORGET_MS = 120_000

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function visionDebug(message) {
  if (VISION_DEBUG) console.debug(`[desktop-vision] ${message}`)
}

function resolveTool(name, override) {
  if (override) return override
  if (app.isPackaged) return bundledToolPath(process.resourcesPath, process.platform, name)
  return name
}

function resolveToolDirectory() {
  if (!app.isPackaged) return undefined
  return bundledToolDirectory(process.resourcesPath, process.platform)
}

export function defaultRuntimeRoot({ platform = process.platform, localAppData, userData }) {
  if (platform === 'win32' && localAppData) {
    return join(localAppData, APP_NAME, 'runtime')
  }
  return join(userData, 'runtime')
}

function resolveRuntimePreload() {
  if (process.platform !== 'win32') return undefined
  if (app.isPackaged) return join(process.resourcesPath, 'runtime-support', 'windows-runtime-fs-shim.cjs')
  return join(import.meta.dirname, 'windows-runtime-fs-shim.cjs')
}

async function resolveBundledRuntime() {
  const manifestPath = process.env.DSH_DESKTOP_BUNDLED_RUNTIME_MANIFEST
    || (app.isPackaged && process.platform === 'darwin' ? join(process.resourcesPath, 'bundled-runtime.json') : undefined)
  return manifestPath === undefined ? undefined : loadBundledRuntime(manifestPath)
}

function createWindow() {
  const hiddenAcceptance = isHiddenAcceptance()
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    title: APP_NAME,
    backgroundColor: '#f7f8fa',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(import.meta.dirname, 'preload.cjs'),
    },
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (!hiddenAcceptance) window.once('ready-to-show', () => window.show())
  window.on('closed', () => { if (mainWindow === window) mainWindow = undefined })
  return window
}

function assertTrustedHarnessSender(event) {
  const senderUrl = event.senderFrame?.url ?? ''
  if (event.sender !== mainWindow?.webContents || !isTrustedHarnessFrame(senderUrl, runtime?.currentUrl)) {
    throw new Error('Desktop update controls are only available inside the local Harness UI')
  }
}

function sendVisionStatus(status) {
  if (mainWindow === undefined || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('desktop-vision:status', status)
}

function harnessApiUrl(endpoint) {
  if (runtime?.currentUrl === undefined) throw new Error('Harness Runtime 尚未就绪')
  // The gateway claims only `<namespace>/<method>` endpoints under `/api`.
  return rpcRequestUrl(runtime.currentUrl, endpoint)
}

async function loadHarnessUrl(url) {
  await removeStaleHarnessAuthCookies(session.defaultSession.cookies, url)
  return loadLocalRuntimeUrl(value => mainWindow.loadURL(value), url)
}

/**
 * Invoke one Harness connection RPC.
 *
 * The 0.2.x envelope is `{ type, rpcId, method, payload: { args } }`: the
 * gateway's `remoteRequest()` insists on exactly one plain-object `args` field,
 * and every method's named arguments live inside it. The bare request object a
 * pre-0.2 shell sent is rejected before dispatch, so `args` is mandatory.
 * @param endpoint - `<namespace>/<method>` endpoint.
 * @param args - named arguments object; zero-parameter endpoints pass `{}`.
 * @returns the decoded `result.value`.
 */
async function callHarness(endpoint, args = {}) {
  const rpcId = randomUUID()
  const response = await session.defaultSession.fetch(harnessApiUrl(endpoint), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(rpcRequestBody(endpoint, rpcId, args)),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`Harness ${endpoint} 请求失败（HTTP ${response.status}）`)
  const body = await response.json()
  if (body?.type !== 'server-response' || body.rpcId !== rpcId) throw new Error(`Harness ${endpoint} 返回了无效响应`)
  if (body.result?.ok !== true) throw new Error(body.result?.error?.message ?? `Harness ${endpoint} 请求被拒绝`)
  return body.result.value
}

/**
 * Resolve the model this session will actually answer with.
 *
 * `session/projections` exposes `modelSelection.next` (`pending ?? lastUsed`),
 * the same order the Controller uses — pending selection first, then the last
 * recorded request header. A session that never recorded a selection answers
 * with the deployment default, which `session/modelCatalog` publishes. Both
 * reads are model-free of side effects. Returns `undefined` when neither read
 * can name a model, which callers must treat as "skip silently".
 * @param sessionId - the session the captured prompt targets.
 * @returns `{ provider, model }`, or `undefined`.
 */
async function resolveSessionModel(sessionId) {
  const projections = await callHarness(PROJECTIONS_ENDPOINT, { request: { sessionId } })
  const projected = selectionFromProjectionPayload(projections)
  if (projected !== undefined) return projected
  const catalog = await callHarness(MODEL_CATALOG_ENDPOINT, {})
  return selectionFromModelCatalogPayload(catalog)
}

function reportVisionError(rpcId, error) {
  const message = errorMessage(error)
  visionDebug(`视觉桥接失败：${message}`)
  if (reportedVisionErrors.has(rpcId)) return
  reportedVisionErrors.add(rpcId)
  sendVisionStatus({ state: 'error', message })
}

async function bridgeImagePrompt(capture, { force = false } = {}) {
  if (visionCompatibility === undefined) return false
  const rpcId = capture?.rpcId
  if (typeof rpcId !== 'string' || rpcId.length === 0) return false
  if (visionFallbacks.has(rpcId)) return false
  if (completedVisionFallbacks.has(rpcId)) return true
  const content = imageContentFromPromptRequest(capture.request)
  if (!content.some(part => part?.type === 'image')) return false
  visionFallbacks.add(rpcId)
  try {
    let selected
    try {
      selected = await resolveSessionModel(capture.request.sessionId)
    } catch (error) {
      // A runtime without these methods (or an unavailable session) must not
      // turn into an error banner: the prompt already failed on its own.
      // Silent by design — `DSH_DESKTOP_VISION_DEBUG=1` makes the skip visible.
      visionDebug(`无法读取当前会话模型，跳过视觉桥接：${errorMessage(error)}`)
      return false
    }
    if (selected === undefined) {
      // Same contract: no model, no bridge, no banner. The debug switch above
      // is the only observable trace of this path.
      visionDebug('当前会话未记录模型选择，跳过视觉桥接')
      return false
    }
    let declaresImage = false
    try {
      declaresImage = await visionCompatibility.routeDeclaresImage(selected.provider, selected.model)
    } catch (error) {
      visionDebug(`读取图片能力声明失败，按未声明处理：${errorMessage(error)}`)
    }
    if (!force && declaresImage) return false
    const attempts = visionFallbackAttempts.get(rpcId) ?? 0
    if (attempts >= MAX_VISION_FALLBACK_ATTEMPTS) {
      visionDebug('视觉桥接重试次数已达上限，跳过')
      return false
    }
    visionFallbackAttempts.set(rpcId, attempts + 1)
    sendVisionStatus({ state: 'bridging', provider: selected.provider, model: selected.model })
    const analysis = await visionCompatibility.analyzeAndRemember({ ...selected, content })
    const question = content.filter(part => part?.type === 'text').map(part => part.text).join('\n')
    await callHarness(PROMPT_ENDPOINT, promptArgs({
      requestId: randomUUID(),
      sessionId: capture.request.sessionId,
      mode: capture.request.mode,
      content: [{ type: 'text', text: compatibilityPromptText({ question, analysis }) }],
      clientTimeZone: capture.request.clientTimeZone,
    }))
    completedVisionFallbacks.add(rpcId)
    sendVisionStatus({
      state: 'complete',
      provider: selected.provider,
      model: selected.model,
      mode: 'bridge-and-remember',
    })
    return true
  } catch (error) {
    reportVisionError(rpcId, error)
    return false
  } finally {
    visionFallbacks.delete(rpcId)
  }
}

function installVisionPromptCapture() {
  // Match patterns carry no port, so the filter is the loopback origin and the
  // exact `/api/session/prompt` path is asserted per request.
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: loopbackRequestUrlPatterns() },
    details => {
      if (!isPromptRequestUrl(details.url)) return
      const chunks = details.uploadData?.flatMap(item => item.bytes === undefined ? [] : [Buffer.from(item.bytes)]) ?? []
      if (chunks.length === 0) return
      let envelope
      try {
        envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        return
      }
      const capture = parseCapturedPromptRequest(envelope)
      if (capture === undefined) return
      if (!imageContentFromPromptRequest(capture.request).some(part => part?.type === 'image')) return
      recentImagePrompts.set(details.webContentsId, { capture, capturedAt: Date.now() })
      setTimeout(() => { void bridgeImagePrompt(capture) }, VISION_CAPTURE_SETTLE_MS)
      setTimeout(() => {
        const recent = recentImagePrompts.get(details.webContentsId)
        if (recent?.capture.rpcId === capture.rpcId) recentImagePrompts.delete(details.webContentsId)
        completedVisionFallbacks.delete(capture.rpcId)
        visionFallbackAttempts.delete(capture.rpcId)
        reportedVisionErrors.delete(capture.rpcId)
      }, VISION_FORGET_MS)
    },
  )
}

function installDesktopUpdateIpc() {
  ipcMain.handle('desktop-harness:get-update-status', async event => {
    assertTrustedHarnessSender(event)
    return runtime.checkForUpdate()
  })
  ipcMain.handle('desktop-harness:get-local-status', async event => {
    assertTrustedHarnessSender(event)
    return runtime.getLocalStatus()
  })
  ipcMain.handle('desktop-harness:check-for-updates', async event => {
    assertTrustedHarnessSender(event)
    await checkForUpdates()
  })
  ipcMain.handle('desktop-harness:rollback', async event => {
    assertTrustedHarnessSender(event)
    await rollbackRuntime()
  })
  ipcMain.handle('desktop-shell:get-update-status', async event => {
    assertTrustedHarnessSender(event)
    return desktopUpdater.getStatus()
  })
  ipcMain.handle('desktop-shell:start-update', async event => {
    assertTrustedHarnessSender(event)
    await startDesktopApplicationUpdate()
  })
  ipcMain.handle('desktop-vision:get-status', async event => {
    assertTrustedHarnessSender(event)
    return visionCompatibility.publicStatus()
  })
  ipcMain.handle('desktop-vision:retry-last', async event => {
    assertTrustedHarnessSender(event)
    const recent = recentImagePrompts.get(event.sender.id)
    if (recent === undefined || Date.now() - recent.capturedAt > VISION_RETRY_WINDOW_MS) return false
    return bridgeImagePrompt(recent.capture, { force: true })
  })
}

async function showSplash(message) {
  const file = join(import.meta.dirname, 'splash.html')
  await access(file)
  await mainWindow.loadFile(file, { query: { message } })
}

async function showUpdateProgress(version, source = 'npm') {
  const file = join(import.meta.dirname, 'update-progress.html')
  await access(file)
  await mainWindow.loadFile(file, { query: { version, source } })
}

async function showDesktopUpdateProgress(version) {
  const file = join(import.meta.dirname, 'desktop-update-progress.html')
  await access(file)
  await mainWindow.loadFile(file, { query: { version } })
}

function errorText(error) {
  if (!(error instanceof Error)) return String(error)
  const lines = [error.message]
  if (error.cause instanceof Error && error.cause.message !== error.message) lines.push(error.cause.message)
  return [...new Set(lines)].join('\n')
}

function formatUpdateFailure(error, version) {
  const stageLabels = {
    check: '检查官方版本',
    download: '下载或安装 Runtime',
    verify: '校验或启用 Runtime',
    start: '启动新 Runtime',
    'desktop-download': '下载桌面版安装包',
  }
  const lines = [
    `目标版本：${version ?? '未知'}`,
    `失败阶段：${stageLabels[error?.stage] ?? error?.stage ?? '检查或更新'}`,
  ]
  if (Array.isArray(error?.attemptFailures) && error.attemptFailures.length > 0) {
    lines.push('', '已尝试的网络线路：')
    for (const attempt of error.attemptFailures) {
      lines.push(`- ${attempt.label}：${errorText(attempt.error)}`)
    }
  } else {
    lines.push('', '底层错误：', errorText(error))
  }
  return lines.join('\n').slice(0, 16_000)
}

async function showRuntimeUpdateDialog(update) {
  const parentBounds = mainWindow.getBounds()
  const workArea = screen.getDisplayMatching(parentBounds).workArea
  const updateWindow = new BrowserWindow({
    parent: mainWindow,
    modal: true,
    ...desktopDialogBounds(parentBounds, workArea, { height: 720 }),
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    show: false,
    backgroundColor: '#f8fafc',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  updateWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  return await new Promise((resolve, reject) => {
    let settled = false
    const finish = action => {
      if (settled) return
      settled = true
      resolve(action)
      if (!updateWindow.isDestroyed()) updateWindow.close()
    }
    const fail = error => {
      if (settled) return
      settled = true
      reject(error)
      if (!updateWindow.isDestroyed()) updateWindow.close()
    }

    updateWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault()
        finish('cancel')
      }
    })
    updateWindow.webContents.on('will-navigate', (event, url) => {
      const action = runtimeUpdateDialogAction(url)
      if (action === undefined) return
      event.preventDefault()
      if (action === 'github') {
        if (update.releaseNotes?.url) void shell.openExternal(update.releaseNotes.url)
        return
      }
      finish(action)
    })
    updateWindow.once('ready-to-show', () => updateWindow.show())
    updateWindow.once('closed', () => finish('cancel'))
    const html = buildRuntimeUpdateDialogHtml(update)
    updateWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(fail)
  })
}

async function startDesktopApplicationUpdate({ skipConfirmation = false } = {}) {
  const status = desktopUpdater.getStatus()
  if (!status.available || !status.update?.version) return
  if (!skipConfirmation) {
    const releaseNotes = status.update.releaseNotes?.trim()
    const confirmation = await showMessageDialog(mainWindow, {
      type: 'info',
      title: 'DeepSeek Harness Desktop 更新',
      message: `桌面版 ${status.update.version} 可以更新`,
      detail: `这是桌面应用自身更新，不是 Harness Runtime 更新。${releaseNotes ? `\n\n更新内容：\n${releaseNotes}` : ''}`,
      buttons: [status.state === 'downloaded' ? '重启并安装' : '下载更新', '稍后'],
      defaultId: 0,
      cancelId: 1,
    })
    if (confirmation.response !== 0) return
  }

  try {
    if (status.state !== 'downloaded') {
      await showDesktopUpdateProgress(status.update.version)
      await desktopUpdater.download()
    }
    const install = await showMessageDialog(mainWindow, {
      type: 'info',
      title: '桌面版更新已下载',
      message: `DeepSeek Harness Desktop ${status.update.version} 已准备好`,
      detail: '重启后会安装桌面版更新。当前 Harness Runtime 与会话数据不会被删除。',
      buttons: ['立即重启并安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
    })
    if (install.response !== 0) {
      if (runtime?.currentUrl && !mainWindow.isDestroyed()) await loadHarnessUrl(runtime.currentUrl)
      return
    }
    await stopIdleRuntime(runtime)
    shuttingDown = true
    desktopUpdater.quitAndInstall()
  } catch (error) {
    await showMessageDialog(mainWindow, {
      type: 'error',
      title: '桌面版更新失败',
      message: '桌面版更新未完成，当前版本未被替换。',
      detail: formatUpdateFailure(error, status.update.version),
      buttons: ['返回 Harness'],
    })
    if (runtime?.currentUrl && !mainWindow.isDestroyed()) await loadHarnessUrl(runtime.currentUrl)
  }
}

async function checkForUpdates({ interactive = true, notify = false } = {}) {
  if (runtimeUpdateInProgress) return
  runtimeUpdateInProgress = true
  let targetVersion
  try {
    const update = await runtime.checkForUpdate()
    targetVersion = update.version
    if (!update.available) {
      promptedHarnessVersion = undefined
      if (interactive) {
        await showMessageDialog(mainWindow, {
          type: 'info',
          title: 'Harness 更新',
          message: update.message,
        })
      }
      return
    }
    if (!interactive) {
      if (!notify || update.version === promptedHarnessVersion) return
      const activeVersion = update.activeVersion === undefined ? '' : '\n当前 Harness Runtime 版本：' + update.activeVersion
      const shown = await promptAvailableUpdate({
        version: update.version,
        detail: activeVersion + '\n请等待任务结束后更新；更新失败时会恢复原来的可用版本。' + harnessUpdateNotes(update),
        apply: () => installHarnessUpdate(update),
      })
      if (shown) promptedHarnessVersion = update.version
      return
    }
    const action = await showRuntimeUpdateDialog(update)
    if (action !== 'update') return
    await installHarnessUpdate(update)
  } catch (error) {
    if (!interactive) return
    const detail = formatUpdateFailure(error, targetVersion)
    await showMessageDialog(mainWindow, {
      type: 'error',
      title: 'Harness 更新失败',
      message: '更新没有完成，已保留或恢复原来的可用版本。',
      detail,
      buttons: ['返回 Harness'],
    })
    if (runtime?.currentUrl && !mainWindow.isDestroyed()) await loadHarnessUrl(runtime.currentUrl)
  } finally {
    runtimeUpdateInProgress = false
  }
}

// 桌面应用自身的主动提示：轮询发现 GitHub Release 有新版本时立刻询问用户。
async function noticeDesktopUpdate(status) {
  if (status?.state !== 'available') return
  const version = status.update?.version
  if (typeof version !== 'string' || version === '' || version === promptedDesktopVersion) return
  if (runtimeUpdateInProgress || updatePromptOpen) return
  const releaseNotes = typeof status.update?.releaseNotes === 'string' ? status.update.releaseNotes.trim() : ''
  const shown = await promptAvailableUpdate({
    version,
    detail: '这是桌面应用自身更新（不是 Harness Runtime），下载完成后需要重启应用来安装。'
      + (releaseNotes === '' ? '' : '\n\n更新内容：\n' + releaseNotes),
    apply: () => startDesktopApplicationUpdate({ skipConfirmation: true }),
  })
  if (shown) promptedDesktopVersion = version
}

function harnessUpdateNotes(update) {
  const body = typeof update?.releaseNotes?.body === 'string' ? update.releaseNotes.body.trim() : ''
  if (body === '') return ''
  return '\n\n更新说明：\n' + chineseReleaseNotes(body)
}

// 主动更新提示：启动时和运行期间只要检测到新版本就询问用户，点“立即更新”立刻开始更新。
async function promptAvailableUpdate({ version, detail, apply }) {
  if (updatePromptOpen) return false
  if (mainWindow === undefined || mainWindow.isDestroyed()) return false
  updatePromptOpen = true
  try {
    const confirmation = await showMessageDialog(mainWindow, {
      type: 'info',
      title: 'DeepSeek Harness 更新',
      message: '发现 DeepSeek Harness 新版本，是否要更新？',
      detail: '新版本：' + version + detail,
      buttons: ['立即更新', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (confirmation.response !== 0) return true
    try {
      await apply()
    } catch (error) {
      await showMessageDialog(mainWindow, {
        type: 'error',
        title: 'DeepSeek Harness 更新失败',
        message: '更新没有完成，已保留或恢复原来的可用版本。',
        detail: formatUpdateFailure(error, version),
        buttons: ['返回 Harness'],
      })
      if (runtime?.currentUrl && !mainWindow.isDestroyed()) await loadHarnessUrl(runtime.currentUrl)
    }
    return true
  } finally {
    updatePromptOpen = false
  }
}

async function installHarnessUpdate(update) {
  await showUpdateProgress(update.version, update.candidate?.source)
  const installed = await runtime.updateAndRestart(update.version, update.candidate)
  await loadHarnessUrl(installed.url)
  await showMessageDialog(mainWindow, {
    type: 'info',
    title: '更新完成',
    message: 'Harness 已更新到 ' + installed.version,
  })
}

async function rollbackRuntime() {
  const state = await runtime.getState()
  if (state?.previousVersion === undefined || state.backupPath === undefined) {
    await showMessageDialog(mainWindow, {
      type: 'info',
      title: 'Harness 回退',
      message: '当前没有可回退的 Harness 更新。',
    })
    return
  }
  const confirmation = await showMessageDialog(mainWindow, {
    type: 'warning',
    title: '回退 Harness',
    message: `回退到 ${state.previousVersion}？`,
    detail: '会恢复更新前的会话与配置快照。升级后新增的会话和修改不会显示在旧版本中；回退前会另存当前数据备份。请先结束正在执行的任务。',
    buttons: ['回退并重启', '取消'],
    defaultId: 1,
    cancelId: 1,
  })
  if (confirmation.response !== 0) return
  try {
    await showSplash(`正在回退到 Harness ${state.previousVersion}…`)
    const result = await runtime.rollback()
    await loadHarnessUrl(result.url)
  } catch (error) {
    await showMessageDialog(mainWindow, {
      type: 'error',
      title: 'Harness 回退失败',
      message: '无法恢复上一个 Harness 版本。',
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}

async function boot() {
  app.setName(APP_NAME)
  mainWindow = createWindow()
  await showSplash('正在准备 DeepSeek Harness Runtime…')

  const bundledRuntime = await resolveBundledRuntime()
  runtime = new RuntimeManager({
    root: process.env.DSH_DESKTOP_RUNTIME_ROOT || defaultRuntimeRoot({
      platform: process.platform,
      localAppData: process.env.LOCALAPPDATA,
      userData: app.getPath('userData'),
    }),
    nodeBinary: resolveTool('node', process.env.DSH_DESKTOP_NODE_BINARY),
    npmBinary: resolveTool('npm', process.env.DSH_DESKTOP_NPM_BINARY),
    pnpmBinary: resolveTool('pnpm', process.env.DSH_DESKTOP_PNPM_BINARY),
    toolDirectory: resolveToolDirectory(),
    runtimePreload: resolveRuntimePreload(),
    resolveProxy: url => session.defaultSession.resolveProxy(url),
    systemFetch: (input, init) => session.defaultSession.fetch(input, init),
    onProgress: progress => {
      if (mainWindow === undefined || mainWindow.isDestroyed()) return
      mainWindow.webContents.send('desktop-harness:update-progress', progress)
    },
    bundledRuntime,
    desktopVersion: app.getVersion(),
    assertCanSwitch: () => assertRuntimeIdle(runtime.currentUrl, (input, init) => session.defaultSession.fetch(input, init)),
  })
  desktopUpdater = new DesktopUpdateManager({
    updater: autoUpdater,
    enabled: app.isPackaged && process.env.DSH_DESKTOP_DISABLE_SHELL_UPDATES !== '1',
    onStatus: status => {
      if (mainWindow === undefined || mainWindow.isDestroyed()) return
      mainWindow.webContents.send('desktop-shell:update-status', status)
      if (status?.state === 'available') void noticeDesktopUpdate(status)
    },
  })
  await runtime.initialize()
  visionCompatibility = new VisionCompatibilityManager({
    root: runtime.root,
    harnessHome: runtime.harnessHome,
    fetchImpl: (input, init) => globalThis.fetch(input, init),
  })
  await visionCompatibility.initialize()
  installVisionPromptCapture()
  installDesktopUpdateIpc()
  installApplicationMenu({
    runtime,
    window: () => mainWindow,
    getVersion: () => runtime.getActiveVersion(),
    onCheckForUpdates: () => { void checkForUpdates() },
    onRollback: () => { void rollbackRuntime() },
  })

  let version = await runtime.getActiveVersion()
  const activeVersionBeforeBundledUpgrade = version
  const startupAction = bundledRuntimeStartupAction(version, bundledRuntime?.version)
  let url
  let bundledUpgradeError
  if (startupAction.action === 'fresh-install') {
    version = startupAction.version
    await showSplash(`正在安装内置 Harness ${version}，无需联网下载…`)
    await runtime.activate(version)
    url = await runtime.start(version)
  } else if (startupAction.action === 'upgrade') {
    version = startupAction.version
    await showSplash(`正在启用桌面安装包内置的 Harness ${version}…`)
    try {
      const installed = await runtime.updateAndRestart(version)
      url = installed.url
    } catch (error) {
      if (runtime.currentUrl === undefined || activeVersionBeforeBundledUpgrade === undefined) throw error
      bundledUpgradeError = error
      version = activeVersionBeforeBundledUpgrade
      url = runtime.currentUrl
    }
  } else {
    version = startupAction.version
    if (version === undefined) {
      const candidate = await runtime.getLatestRelease()
      version = candidate.version
      await showSplash(`首次安装 Harness ${version}，可能需要几分钟…`)
      await runtime.install(version, candidate)
      await runtime.activate(version)
    } else if (startupAction.action === 'ensure-installed') {
      await showSplash(`正在校验内置 Harness ${version}…`)
      await runtime.install(version)
    }
    url = await runtime.start(version)
  }
  await loadHarnessUrl(url)
  if (!bundledUpgradeError) await runtime.cleanupRuntimeVersions({ expectedVersion: version })
  if (bundledUpgradeError !== undefined) {
    await showMessageDialog(mainWindow, {
      type: 'warning',
      title: '已恢复原 Harness Runtime',
      message: '安装包内置 Runtime 未能启动，已继续使用原来的可用版本。',
      detail: formatUpdateFailure(bundledUpgradeError, bundledRuntime?.version),
      buttons: ['继续使用'],
    })
  }
  setTimeout(
    () => { void checkForUpdates({ interactive: false, notify: true }) },
    HARNESS_UPDATE_FIRST_CHECK_DELAY_MS,
  )
  setInterval(
    () => { void checkForUpdates({ interactive: false, notify: true }) },
    HARNESS_UPDATE_POLL_INTERVAL_MS,
  )
  setTimeout(() => { void desktopUpdater.check() }, DESKTOP_UPDATE_FIRST_CHECK_DELAY_MS)
  setInterval(() => { void desktopUpdater.check() }, DESKTOP_UPDATE_POLL_INTERVAL_MS)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow === undefined) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(boot).catch(async error => {
    let diagnosticPath
    if (runtime?.root) {
      try {
        diagnosticPath = await writeRuntimeStartupDiagnostic(runtime.root, error)
      } catch (diagnosticError) {
        console.warn(`Unable to write startup diagnostic: ${diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)}`)
      }
    }
    if (isHiddenAcceptance()) {
      console.error(conciseRuntimeStartupFailure(error, diagnosticPath))
      app.exit(1)
      return
    }
    const result = await showMessageDialog({
      type: 'error',
      title: '无法启动 DeepSeek Harness Desktop',
      message: 'Harness Runtime 未能启动',
      detail: conciseRuntimeStartupFailure(error, diagnosticPath),
      buttons: diagnosticPath ? ['退出', '打开日志目录'] : ['退出'],
      defaultId: 0,
      cancelId: 0,
    })
    if (result.response === 1 && diagnosticPath) shell.showItemInFolder(diagnosticPath)
    app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && runtime?.currentUrl) {
      mainWindow = createWindow()
      void loadHarnessUrl(runtime.currentUrl)
    }
  })

  app.on('before-quit', event => {
    if (shuttingDown || runtime === undefined) return
    event.preventDefault()
    shuttingDown = true
    visionCompatibility?.dispose()
    void runtime.stop().finally(() => app.quit())
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
