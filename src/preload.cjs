const { contextBridge, ipcRenderer } = require('electron')

const desktopHarness = {
  getUpdateStatus: () => ipcRenderer.invoke('desktop-harness:get-update-status'),
  checkForUpdates: () => ipcRenderer.invoke('desktop-harness:check-for-updates'),
  rollback: () => ipcRenderer.invoke('desktop-harness:rollback'),
  onUpdateProgress: callback => {
    const listener = (_event, progress) => callback(progress)
    ipcRenderer.on('desktop-harness:update-progress', listener)
    return () => ipcRenderer.removeListener('desktop-harness:update-progress', listener)
  },
  getDesktopUpdateStatus: () => ipcRenderer.invoke('desktop-shell:get-update-status'),
  startDesktopUpdate: () => ipcRenderer.invoke('desktop-shell:start-update'),
  onDesktopUpdateStatus: callback => {
    const listener = (_event, status) => callback(status)
    ipcRenderer.on('desktop-shell:update-status', listener)
    return () => ipcRenderer.removeListener('desktop-shell:update-status', listener)
  },
  getVisionStatus: () => ipcRenderer.invoke('desktop-vision:get-status'),
  retryLastImage: () => ipcRenderer.invoke('desktop-vision:retry-last'),
  onVisionStatus: callback => {
    const listener = (_event, status) => callback(status)
    ipcRenderer.on('desktop-vision:status', listener)
    return () => ipcRenderer.removeListener('desktop-vision:status', listener)
  },
}

contextBridge.exposeInMainWorld('desktopHarness', desktopHarness)

const STYLE_ID = 'dsh-desktop-settings-style'
const PANEL_ID = 'dsh-desktop-settings-panel'
const SHELL_UPDATE_ID = 'dsh-desktop-shell-update'
const VISION_STATUS_ID = 'dsh-desktop-vision-status'
let lastVisionRetryAt = 0

function installStyles() {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    [data-dsh-desktop-settings="true"] { margin-top: 8px; }
    [data-dsh-desktop-settings="true"].dsh-desktop-selected {
      background: color-mix(in srgb, currentColor 9%, transparent);
    }
    #${PANEL_ID} { padding: 26px 30px; color: inherit; font: inherit; }
    #${PANEL_ID} .dsh-desktop-heading { margin: 0 0 6px; font-size: 20px; font-weight: 650; }
    #${PANEL_ID} .dsh-desktop-copy { margin: 0; opacity: .68; line-height: 1.55; }
    #${PANEL_ID} .dsh-desktop-card {
      margin-top: 22px; padding: 20px; border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
      border-radius: 14px; background: color-mix(in srgb, currentColor 3%, transparent);
    }
    #${PANEL_ID} .dsh-desktop-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; }
    #${PANEL_ID} .dsh-desktop-label { font-size: 14px; font-weight: 600; }
    #${PANEL_ID} .dsh-desktop-value { margin-top: 5px; font-size: 13px; opacity: .64; }
    #${PANEL_ID} .dsh-desktop-actions { display: flex; gap: 10px; margin-top: 18px; }
    #${PANEL_ID} button {
      appearance: none; border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
      border-radius: 9px; padding: 8px 13px; background: transparent; color: inherit;
      font: inherit; font-size: 13px; cursor: pointer;
    }
    #${PANEL_ID} button.dsh-desktop-primary { border-color: #246bfd; background: #246bfd; color: #fff; }
    #${PANEL_ID} button:disabled { cursor: default; opacity: .42; }
    #${PANEL_ID} .dsh-desktop-status { margin-top: 14px; min-height: 20px; font-size: 13px; opacity: .72; }
    #${SHELL_UPDATE_ID} {
      position: fixed; right: 18px; top: 16px; z-index: 2147483647; display: inline-flex; align-items: center; gap: 8px;
      border: 1px solid color-mix(in srgb, #2864ee 45%, transparent); border-radius: 999px; padding: 8px 12px;
      color: #fff; background: #2864ee; box-shadow: 0 10px 30px rgba(40,100,238,.28); font: 600 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      cursor: pointer; animation: dsh-shell-update-enter .24s ease-out;
    }
    #${SHELL_UPDATE_ID}:hover { background: #1f55d5; }
    #${SHELL_UPDATE_ID} svg { width: 14px; height: 14px; }
    #${VISION_STATUS_ID} {
      position: fixed; left: 50%; top: 92px; z-index: 2147483647; transform: translateX(-50%);
      max-width: min(620px, calc(100vw - 40px)); padding: 11px 15px; border-radius: 11px;
      color: #fff; background: rgba(48, 53, 61, .94); box-shadow: 0 14px 38px rgba(0,0,0,.22);
      font: 500 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    #${VISION_STATUS_ID}[data-state="error"] { background: rgba(166, 43, 43, .96); }
    #${VISION_STATUS_ID}[data-state="complete"] { background: rgba(28, 119, 74, .96); }
    @keyframes dsh-shell-update-enter { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
  `
  document.head.appendChild(style)
}

function renderVisionStatus(status) {
  let element = document.getElementById(VISION_STATUS_ID)
  if (!element) {
    element = document.createElement('div')
    element.id = VISION_STATUS_ID
    element.setAttribute('role', 'status')
    element.setAttribute('aria-live', 'polite')
    document.body.appendChild(element)
  }
  element.dataset.state = status?.state ?? 'idle'
  if (status?.state === 'bridging') {
    element.textContent = `Harness 未声明 ${status.provider}/${status.model} 的图片能力，正在自动使用视觉兼容通道…`
  } else if (status?.state === 'complete') {
    element.textContent = `图片已通过 ${status.provider}/${status.model} 成功读取；该模型已记住，后续优先走 Harness 原生图片。`
  } else if (status?.state === 'error') {
    element.textContent = `图片兼容发送失败：${status.message ?? '未知错误'}`
  } else {
    element.textContent = ''
  }
  if (status?.state !== 'bridging') setTimeout(() => element?.remove(), status?.state === 'error' ? 10_000 : 5_000)
}

function renderDesktopUpdateBadge(status) {
  if (location.hostname !== '127.0.0.1') return
  const existing = document.getElementById(SHELL_UPDATE_ID)
  if (!status?.available || !status.update?.version) {
    existing?.remove()
    return
  }
  if (existing) {
    existing.querySelector('span').textContent = `桌面版 ${status.update.version} 可更新`
    return
  }
  const button = document.createElement('button')
  button.id = SHELL_UPDATE_ID
  button.type = 'button'
  button.title = '更新 DeepSeek Harness Desktop（不是 Harness Runtime）'
  button.innerHTML = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2v8m0 0 3-3m-3 3L5 7M3 13h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><span></span>'
  button.querySelector('span').textContent = `桌面版 ${status.update.version} 可更新`
  button.addEventListener('click', () => {
    button.disabled = true
    void desktopHarness.startDesktopUpdate().catch(() => { button.disabled = false })
  })
  document.body.appendChild(button)
}

function findOptions(dialog) {
  const slot = dialog.querySelector('[data-slot="settings.section"]')
  return slot?.parentElement
}

function restoreOfficialSettings(dialog, desktopButton) {
  document.getElementById(PANEL_ID)?.remove()
  const options = findOptions(dialog)
  if (options) for (const child of options.children) child.style.removeProperty('display')
  desktopButton.classList.remove('dsh-desktop-selected')
  desktopButton.removeAttribute('aria-current')
}

async function renderDesktopSettings(dialog, desktopButton) {
  const options = findOptions(dialog)
  if (!options) return
  for (const child of options.children) child.style.display = 'none'
  document.getElementById(PANEL_ID)?.remove()

  const panel = document.createElement('section')
  panel.id = PANEL_ID
  panel.innerHTML = `
    <h2 class="dsh-desktop-heading">Harness 更新</h2>
    <p class="dsh-desktop-copy">桌面版会直接安装并运行 DeepSeek 官方 Harness Runtime。更新前会展示官方 GitHub 已发布的版本说明；安装过程支持系统代理与直接连接自动回退。</p>
    <div class="dsh-desktop-card">
      <div class="dsh-desktop-row">
        <div>
          <div class="dsh-desktop-label">当前版本</div>
          <div class="dsh-desktop-value" data-dsh-version>正在读取…</div>
        </div>
        <div class="dsh-desktop-label" data-dsh-auto>自动检查：已开启</div>
      </div>
      <div class="dsh-desktop-actions">
        <button class="dsh-desktop-primary" type="button" data-dsh-check>检查并安装更新</button>
        <button type="button" data-dsh-rollback disabled>回退上一个版本</button>
      </div>
      <div class="dsh-desktop-status" role="status" aria-live="polite" data-dsh-status></div>
    </div>
    <div class="dsh-desktop-card">
      <div class="dsh-desktop-row">
        <div>
          <div class="dsh-desktop-label">图片兼容</div>
          <div class="dsh-desktop-value" data-dsh-vision>正在读取…</div>
        </div>
        <div class="dsh-desktop-label">原生优先 · 自动回退</div>
      </div>
      <div class="dsh-desktop-status">只对真实成功读取过图片的精确模型启用图片声明；Harness 更新不会被阻止。</div>
    </div>
  `
  options.appendChild(panel)
  desktopButton.classList.add('dsh-desktop-selected')
  desktopButton.setAttribute('aria-current', 'true')

  const version = panel.querySelector('[data-dsh-version]')
  const status = panel.querySelector('[data-dsh-status]')
  const check = panel.querySelector('[data-dsh-check]')
  const rollback = panel.querySelector('[data-dsh-rollback]')
  const vision = panel.querySelector('[data-dsh-vision]')

  async function refresh() {
    try {
      const result = await desktopHarness.getUpdateStatus()
      version.textContent = result.activeVersion
        ? `${result.activeVersion}（官方最新：${result.latestVersion}）`
        : `尚未安装（官方最新：${result.latestVersion}）`
      status.textContent = result.available ? '发现新版本，可以一键更新。' : '当前已是最新版。'
      rollback.disabled = !result.canRollback
      const visionResult = await desktopHarness.getVisionStatus()
      vision.textContent = visionResult.models.length === 0
        ? '尚无已验证模型；首次上传时自动验证并回退'
        : `已验证 ${visionResult.models.length} 个：${visionResult.models.map(item => `${item.provider}/${item.model}`).join('、')}`
    } catch (error) {
      version.textContent = '读取失败'
      status.textContent = error?.message ?? String(error)
    }
  }

  check.addEventListener('click', async () => {
    check.disabled = true
    status.textContent = '正在检查官方 Harness 更新…'
    try {
      await desktopHarness.checkForUpdates()
      await refresh()
    } catch (error) {
      status.textContent = error?.message ?? String(error)
    } finally {
      check.disabled = false
    }
  })
  rollback.addEventListener('click', async () => {
    rollback.disabled = true
    status.textContent = '正在准备回退…'
    try {
      await desktopHarness.rollback()
    } catch (error) {
      status.textContent = error?.message ?? String(error)
      await refresh()
    }
  })
  await refresh()
}

function installIntoSettingsDialog(dialog) {
  const nav = dialog.querySelector('nav')
  const navButtons = nav ? [...nav.querySelectorAll('button')] : []
  if (navButtons.length === 0 || navButtons.some(button => button.dataset.dshDesktopSettings === 'true')) return
  const templateButton = navButtons.at(-1)
  const navList = templateButton.parentElement
  if (!navList) return

  const desktopButton = document.createElement('button')
  desktopButton.type = 'button'
  desktopButton.className = templateButton.className
  desktopButton.dataset.dshDesktopSettings = 'true'
  const labelClass = templateButton.querySelector('span')?.className ?? ''
  desktopButton.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M13.2 5.8A5.5 5.5 0 1 0 13 10.7M13.2 2.8v3h-3M2.8 13.2v-3h3" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <span class="${labelClass}">桌面更新</span>
  `
  navList.appendChild(desktopButton)

  for (const button of navButtons) {
    button.addEventListener('click', () => restoreOfficialSettings(dialog, desktopButton), true)
  }
  desktopButton.addEventListener('click', () => { void renderDesktopSettings(dialog, desktopButton) })
}

function scanSettings() {
  installStyles()
  for (const dialog of document.querySelectorAll('[role="dialog"]')) {
    if (dialog.querySelector('nav')?.textContent?.includes('通用设置')) installIntoSettingsDialog(dialog)
  }
}

function retryNewVisionRejection(mutations) {
  const imageRejected = mutations.some(mutation => [...mutation.addedNodes].some(node => {
    const text = node.nodeType === Node.TEXT_NODE ? node.textContent : node.innerText ?? node.textContent
    return text?.includes('当前模型不支持图片') || text?.includes('MODEL_DOES_NOT_SUPPORT_IMAGES')
  }))
  if (imageRejected && Date.now() - lastVisionRetryAt > 2_000) {
    lastVisionRetryAt = Date.now()
    void desktopHarness.retryLastImage().catch(() => {})
  }
}

window.addEventListener('DOMContentLoaded', () => {
  scanSettings()
  new MutationObserver(mutations => {
    scanSettings()
    retryNewVisionRejection(mutations)
  }).observe(document.body, { childList: true, subtree: true })
  if (location.hostname === '127.0.0.1') {
    desktopHarness.onVisionStatus(renderVisionStatus)
    desktopHarness.onDesktopUpdateStatus(renderDesktopUpdateBadge)
    void desktopHarness.getDesktopUpdateStatus().then(renderDesktopUpdateBadge).catch(() => {})
  }
})
