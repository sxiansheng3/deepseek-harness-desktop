const ACTION_SCHEME = 'dsh-runtime-update:'

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function runtimeUpdateDialogAction(url) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== ACTION_SCHEME) return undefined
    return ['cancel', 'github', 'update'].includes(parsed.hostname) ? parsed.hostname : undefined
  } catch {
    return undefined
  }
}

export function chineseReleaseNotes(value) {
  const body = typeof value === 'string' ? value.replace(/\r/g, '').trim() : ''
  const fallback = '官方本次没有提供中文更新说明。可以点击“在 GitHub 查看”查看原始说明。'
  if (!/[\u3400-\u9fff]/.test(body)) return fallback

  const lines = body.split('\n')
  const languageMarker = lines.findIndex(line => /^\s*中文\s*\|\s*English\s*$/i.test(line))
  const firstChineseLine = lines.findIndex(line => /[\u3400-\u9fff]/.test(line))
  const start = languageMarker >= 0 ? languageMarker + 1 : Math.max(firstChineseLine, 0)
  let selected = lines.slice(start)
  const englishSection = selected.findIndex((line, index) => index > 0
    && /^(?:English|New Features|Improvements|Bug Fixes|Chores|Other Changes|Full Changelog)\s*:?.*$/i.test(line.trim()))
  if (englishSection > 0) selected = selected.slice(0, englishSection)
  const result = selected.join('\n').trim()
  return /[\u3400-\u9fff]/.test(result) ? result : fallback
}

export function buildRuntimeUpdateDialogHtml(update) {
  const version = escapeHtml(update.version)
  const activeVersion = update.activeVersion === undefined ? undefined : escapeHtml(update.activeVersion)
  const notes = escapeHtml(chineseReleaseNotes(update.releaseNotes?.body))
  const summary = activeVersion === undefined
    ? '安装后即可开始使用。'
    : `当前版本 ${activeVersion}。更新失败时会自动恢复旧版本。`
  const githubButton = update.releaseNotes?.url
    ? '<a class="button secondary" href="dsh-runtime-update://github">在 GitHub 查看</a>'
    : ''

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <title>发现 Harness 更新</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif;
      background: #f8fafc;
      color: #172033;
    }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body { background: #f8fafc; }
    .dialog {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100vh;
      overflow: hidden;
      border: 1px solid rgba(72, 92, 120, 0.2);
      background: #f8fafc;
    }
    header {
      position: relative;
      flex: 0 0 auto;
      padding: 28px 68px 20px 28px;
      border-bottom: 1px solid #dce3ec;
      background: rgba(248, 250, 252, 0.96);
      -webkit-app-region: drag;
    }
    h1 { margin: 0; font-size: 20px; line-height: 1.35; letter-spacing: -0.01em; }
    .summary { margin: 10px 0 0; color: #5a6678; font-size: 14px; line-height: 1.6; }
    .close {
      position: absolute;
      top: 18px;
      right: 18px;
      display: grid;
      place-items: center;
      width: 36px;
      height: 36px;
      border: 0;
      border-radius: 10px;
      color: #657186;
      text-decoration: none;
      font-size: 25px;
      line-height: 1;
      -webkit-app-region: no-drag;
    }
    .close:hover { background: #e9eef5; color: #172033; }
    .notes {
      min-height: 0;
      flex: 1 1 auto;
      overflow-y: auto;
      overscroll-behavior: contain;
      scrollbar-gutter: stable;
      padding: 22px 28px 28px;
      background: #fff;
    }
    .notes-title { margin: 0 0 12px; color: #38465c; font-size: 13px; font-weight: 650; }
    pre {
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      color: #273348;
      font: 14px/1.7 -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif;
    }
    footer {
      display: flex;
      flex: 0 0 auto;
      align-items: center;
      justify-content: flex-end;
      gap: 10px;
      padding: 16px 22px;
      border-top: 1px solid #dce3ec;
      background: #f8fafc;
    }
    .button {
      min-width: 104px;
      padding: 9px 16px;
      border-radius: 10px;
      text-align: center;
      text-decoration: none;
      font-size: 14px;
      font-weight: 600;
      -webkit-app-region: no-drag;
    }
    .secondary { border: 1px solid #cbd5e1; color: #334155; background: #fff; }
    .secondary:hover { border-color: #9aa9bc; background: #f1f5f9; }
    .primary { border: 1px solid #2563eb; color: #fff; background: #2563eb; }
    .primary:hover { border-color: #1d4ed8; background: #1d4ed8; }
    a:focus-visible { outline: 3px solid rgba(37, 99, 235, 0.28); outline-offset: 2px; }
    @media (prefers-color-scheme: dark) {
      :root, body, .dialog { color: #edf3fa; background: #161a21; }
      .dialog { border-color: #343c49; }
      header, footer { border-color: #343c49; background: #1d222b; }
      .summary, .close { color: #aeb8c7; }
      .close:hover { color: #fff; background: #303846; }
      .notes { background: #161a21; }
      .notes-title { color: #ccd5e2; }
      pre { color: #e1e7ef; }
      .secondary { border-color: #465163; color: #e1e7ef; background: #272e39; }
      .secondary:hover { border-color: #627086; background: #303846; }
    }
  </style>
</head>
<body>
  <main class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
    <header>
      <h1 id="dialog-title">发现新版本 ${version}</h1>
      <p class="summary">${summary}</p>
      <a class="close" href="dsh-runtime-update://cancel" aria-label="关闭更新窗口">×</a>
    </header>
    <section class="notes" aria-label="官方 GitHub 中文更新说明">
      <p class="notes-title">官方 GitHub 中文更新说明</p>
      <pre>${notes}</pre>
    </section>
    <footer>
      <a class="button secondary" href="dsh-runtime-update://cancel">暂不更新</a>
      ${githubButton}
      <a class="button primary" href="dsh-runtime-update://update">更新并重启 Harness</a>
    </footer>
  </main>
</body>
</html>`
}
