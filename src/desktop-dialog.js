import { escapeHtml } from './runtime-update-dialog.js'

export function desktopDialogBounds(parent, workArea, { width = 680, height = 600 } = {}) {
  const margin = 16
  const availableWidth = Math.max(1, workArea.width - margin * 2)
  const availableHeight = Math.max(1, workArea.height - margin * 2)
  const anchor = parent ?? workArea
  const w = Math.min(width, Math.max(320, anchor.width - 64), availableWidth)
  const h = Math.min(height, Math.max(280, anchor.height - 64), availableHeight)
  return {
    width: Math.floor(w), height: Math.floor(h),
    x: Math.round(Math.max(workArea.x + margin, Math.min(anchor.x + (anchor.width - w) / 2, workArea.x + workArea.width - margin - w))),
    y: Math.round(Math.max(workArea.y + margin, Math.min(anchor.y + (anchor.height - h) / 2, workArea.y + workArea.height - margin - h))),
  }
}

export function desktopDialogResponse(url, count, cancelId) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'dsh-dialog:') return undefined
    if (parsed.hostname === 'cancel') return cancelId
    if (!/^\d+$/.test(parsed.hostname)) return undefined
    const response = Number(parsed.hostname)
    return response < count ? response : undefined
  } catch { return undefined }
}

export function buildDesktopDialogHtml(options) {
  const buttons = options.buttons ?? ['确定']
  const defaultId = options.defaultId ?? 0
  const title = escapeHtml(options.title ?? 'DeepSeek Harness Desktop')
  const actions = buttons.map((label, index) => ({ label, index })).reverse().map(({ label, index }) =>
    `<a class="button ${index === defaultId ? 'primary' : 'secondary'}" ${index === defaultId ? 'data-default' : ''} href="dsh-dialog://${index}">${escapeHtml(label)}</a>`).join('')
  return `<!doctype html><html lang="zh-CN"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <title>${title}</title><style>
    :root { color-scheme:light dark; font:14px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif; color:#172033; background:#f8fafc; }
    * { box-sizing:border-box; }
    html,body { margin:0; width:100%; height:100%; overflow:hidden; }
    .dialog { display:flex; flex-direction:column; height:100vh; min-height:0; border:1px solid #dce3ec; }
    header { flex:0 0 auto; display:flex; align-items:center; gap:12px; padding:20px 22px; border-bottom:1px solid #dce3ec; -webkit-app-region:drag; }
    h1 { min-width:0; flex:1; font-size:18px; line-height:1.4; margin:0; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow-wrap:anywhere; }
    .close { display:grid; place-items:center; flex:0 0 32px; height:32px; border-radius:8px; font-size:23px; color:#64748b; text-decoration:none; -webkit-app-region:no-drag; }
    .close:hover { background:#e7edf5; }
    .content { flex:1 1 auto; min-height:0; overflow-y:auto; overscroll-behavior:contain; scrollbar-gutter:stable; background:#fff; padding:22px 24px; }
    .message { font-size:16px; line-height:1.6; font-weight:600; margin:0 0 16px; white-space:pre-wrap; overflow-wrap:anywhere; }
    pre { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; font:inherit; color:#475569; }
    footer { flex:0 0 auto; display:flex; flex-wrap:wrap; justify-content:flex-end; gap:10px; padding:16px 22px; border-top:1px solid #dce3ec; }
    .button { min-width:96px; max-width:100%; padding:9px 16px; border:1px solid #cbd5e1; border-radius:9px; font-weight:600; text-decoration:none; text-align:center; overflow-wrap:anywhere; }
    .secondary { color:#334155; background:#fff; }
    .primary { color:#fff; background:#2563eb; border-color:#2563eb; }
    .primary:hover { background:#1d4ed8; }
    .secondary:hover { background:#eaf0f8; }
    a:focus-visible { outline:3px solid #93b5ff; outline-offset:2px; }
    @media (max-height:420px),(max-width:420px) { header { padding:12px 16px; } .content { padding:14px 16px; } footer { padding:12px 16px; gap:8px; } .button { min-width:80px; padding:7px 12px; } }
    @media (prefers-color-scheme:dark) { :root { color:#edf3fa; background:#1d222b; } .dialog,header,footer { border-color:#343c49; } .content { background:#161a21; } pre,.close { color:#bec8d8; } .secondary { color:#e1e7ef; background:#272e39; border-color:#465163; } .secondary:hover,.close:hover { background:#303846; } }
  </style></head><body><main class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
    <header><h1 id="dialog-title">${title}</h1><a class="close" href="dsh-dialog://cancel" aria-label="关闭窗口">×</a></header>
    <section class="content" aria-label="${options.type === 'error' ? '错误详情' : '详细说明'}" tabindex="0">
      <p class="message">${escapeHtml(options.message ?? '')}</p><pre>${escapeHtml(options.detail ?? '')}</pre>
    </section><footer>${actions}</footer>
  </main></body></html>`
}

/** All desktop-owned long messages share a bounded, scrollable window. */
export function showDesktopDialog({ BrowserWindow, screen }, parentOrOptions, suppliedOptions) {
  const parent = suppliedOptions && parentOrOptions && !parentOrOptions.isDestroyed() ? parentOrOptions : undefined
  const options = suppliedOptions ?? parentOrOptions
  const buttons = options.buttons ?? ['确定']
  const cancelId = options.cancelId ?? (buttons.length > 1 ? buttons.length - 1 : 0)
  const bounds = parent?.getBounds()
  const display = bounds ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay()
  const window = new BrowserWindow({
    ...desktopDialogBounds(bounds, display.workArea, { height: options.detail ? 620 : 320 }),
    ...(parent ? { parent, modal: true } : {}),
    title: options.title, frame: false, show: false, resizable: false,
    minimizable: false, maximizable: false, fullscreenable: false,
    backgroundColor: '#f8fafc', webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = response => {
      if (settled) return
      settled = true
      resolve({ response, checkboxChecked: false })
      if (!window.isDestroyed()) window.close()
    }
    window.webContents.on('will-navigate', (event, url) => {
      event.preventDefault()
      const response = desktopDialogResponse(url, buttons.length, cancelId)
      if (response !== undefined) finish(response)
    })
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); finish(cancelId) }
    })
    window.once('closed', () => finish(cancelId))
    window.once('ready-to-show', () => {
      window.show()
      void window.webContents.executeJavaScript("document.querySelector('[data-default]')?.focus()").catch(() => {})
    })
    window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildDesktopDialogHtml(options))}`).catch(error => {
      if (settled) return
      settled = true
      reject(error)
      if (!window.isDestroyed()) window.close()
    })
  })
}
