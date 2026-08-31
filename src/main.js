import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { RuntimeManager } from './runtime-manager.js'
import { DesktopUpdateManager } from './desktop-update-manager.js'
import { buildRuntimeUpdateDialogHtml, runtimeUpdateDialogAction } from './runtime-update-dialog.js'
import { installApplicationMenu } from './menu.js'
import { bundledToolDirectory, bundledToolPath } from './tool-layout.js'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

const APP_NAME = 'DeepSeek Harness Desktop'
let mainWindow
let runtime
let desktopUpdater
let shuttingDown = false

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

function createWindow() {
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
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => { if (mainWindow === window) mainWindow = undefined })
  return window
}

function assertTrustedHarnessSender(event) {
  const senderUrl = event.senderFrame?.url ?? ''
  if (!senderUrl.startsWith('http://127.0.0.1:')) {
    throw new Error('Desktop update controls are only available inside the local Harness UI')
  }
}

function installDesktopUpdateIpc() {
  ipcMain.handle('desktop-harness:get-update-status', async event => {
    assertTrustedHarnessSender(event)
    const state = await runtime.getState()
    const latestVersion = await runtime.getLatestVersion()
    return {
      activeVersion: state?.version,
      latestVersion,
      available: state?.version !== latestVersion,
      canRollback: state?.previousVersion !== undefined && state.backupPath !== undefined,
    }
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
}

async function showSplash(message) {
  const file = join(import.meta.dirname, 'splash.html')
  await access(file)
  await mainWindow.loadFile(file, { query: { message } })
}

async function showUpdateProgress(version) {
  const file = join(import.meta.dirname, 'update-progress.html')
  await access(file)
  await mainWindow.loadFile(file, { query: { version } })
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
  const parentBounds = mainWindow.getContentBounds()
  const width = Math.min(680, Math.max(520, parentBounds.width - 80))
  const height = Math.min(720, Math.max(480, parentBounds.height - 80))
  const updateWindow = new BrowserWindow({
    parent: mainWindow,
    modal: true,
    width,
    height,
    useContentSize: true,
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

async function startDesktopApplicationUpdate() {
  const status = desktopUpdater.getStatus()
  if (!status.available || !status.update?.version) return
  const releaseNotes = status.update.releaseNotes?.trim()
  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'DeepSeek Harness Desktop 更新',
    message: `桌面版 ${status.update.version} 可以更新`,
    detail: `这是桌面应用自身更新，不是 Harness Runtime 更新。${releaseNotes ? `\n\n更新内容：\n${releaseNotes.slice(0, 8_000)}` : ''}`,
    buttons: [status.state === 'downloaded' ? '重启并安装' : '下载更新', '稍后'],
    defaultId: 0,
    cancelId: 1,
  })
  if (confirmation.response !== 0) return

  try {
    if (status.state !== 'downloaded') {
      await showDesktopUpdateProgress(status.update.version)
      await desktopUpdater.download()
    }
    const install = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '桌面版更新已下载',
      message: `DeepSeek Harness Desktop ${status.update.version} 已准备好`,
      detail: '重启后会安装桌面版更新。当前 Harness Runtime 与会话数据不会被删除。',
      buttons: ['立即重启并安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
    })
    if (install.response !== 0) {
      if (runtime?.currentUrl && !mainWindow.isDestroyed()) await mainWindow.loadURL(runtime.currentUrl)
      return
    }
    await runtime.stop()
    shuttingDown = true
    desktopUpdater.quitAndInstall()
  } catch (error) {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: '桌面版更新失败',
      message: '桌面版安装包没有下载完成，当前版本未被替换。',
      detail: formatUpdateFailure(error, status.update.version),
      buttons: ['返回 Harness'],
    })
    if (runtime?.currentUrl && !mainWindow.isDestroyed()) await mainWindow.loadURL(runtime.currentUrl)
  }
}

async function checkForUpdates({ interactive = true } = {}) {
  let targetVersion
  try {
    const update = await runtime.checkForUpdate()
    targetVersion = update.version
    if (!update.available) {
      if (interactive) {
        await dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'Harness 更新',
          message: `当前已是最新版 ${update.version}`,
        })
      }
      return
    }
    const action = await showRuntimeUpdateDialog(update)
    if (action !== 'update') return
    await showUpdateProgress(update.version)
    const installed = await runtime.updateAndRestart(update.version)
    await mainWindow.loadURL(installed.url)
    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '更新完成',
      message: `Harness 已更新到 ${installed.version}`,
    })
  } catch (error) {
    const detail = formatUpdateFailure(error, targetVersion)
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Harness 更新失败',
      message: '更新没有完成，已保留或恢复原来的可用版本。',
      detail,
      buttons: ['返回 Harness'],
    })
    if (runtime?.currentUrl && !mainWindow.isDestroyed()) await mainWindow.loadURL(runtime.currentUrl)
  }
}

async function rollbackRuntime() {
  const state = await runtime.getState()
  if (state?.previousVersion === undefined || state.backupPath === undefined) {
    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Harness 回退',
      message: '当前没有可回退的 Harness 更新。',
    })
    return
  }
  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: '回退 Harness',
    message: `回退到 ${state.previousVersion}？`,
    detail: '同时恢复更新前的会话与配置快照。',
    buttons: ['回退并重启', '取消'],
    defaultId: 1,
    cancelId: 1,
  })
  if (confirmation.response !== 0) return
  try {
    await showSplash(`正在回退到 Harness ${state.previousVersion}…`)
    const result = await runtime.rollback()
    await mainWindow.loadURL(result.url)
  } catch (error) {
    await dialog.showMessageBox(mainWindow, {
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
  })
  desktopUpdater = new DesktopUpdateManager({
    updater: autoUpdater,
    enabled: app.isPackaged && process.env.DSH_DESKTOP_DISABLE_SHELL_UPDATES !== '1',
    onStatus: status => {
      if (mainWindow === undefined || mainWindow.isDestroyed()) return
      mainWindow.webContents.send('desktop-shell:update-status', status)
    },
  })
  await runtime.initialize()
  installDesktopUpdateIpc()
  installApplicationMenu({
    runtime,
    window: () => mainWindow,
    getVersion: () => runtime.getActiveVersion(),
    onCheckForUpdates: () => { void checkForUpdates() },
    onRollback: () => { void rollbackRuntime() },
  })

  let version = await runtime.getActiveVersion()
  if (version === undefined) {
    version = await runtime.getLatestVersion()
    await showSplash(`首次安装 Harness ${version}，可能需要几分钟…`)
    await runtime.activate(version)
  }
  const url = await runtime.start(version)
  await mainWindow.loadURL(url)
  setTimeout(() => { void checkForUpdates({ interactive: false }) }, 10_000)
  setTimeout(() => { void desktopUpdater.check() }, 20_000)
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
    await dialog.showErrorBox('无法启动 DeepSeek Harness Desktop', error instanceof Error ? error.stack || error.message : String(error))
    app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && runtime?.currentUrl) {
      mainWindow = createWindow()
      void mainWindow.loadURL(runtime.currentUrl)
    }
  })

  app.on('before-quit', event => {
    if (shuttingDown || runtime === undefined) return
    event.preventDefault()
    shuttingDown = true
    void runtime.stop().finally(() => app.quit())
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
