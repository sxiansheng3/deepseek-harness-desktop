import { readFile, writeFile } from 'node:fs/promises'
import WebSocket from 'ws'

const debuggingPort = Number(process.env.DSH_DESKTOP_CDP_PORT ?? 9223)

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url)
    this.sequence = 0
    this.pending = new Map()
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.socket.once('open', resolve)
      this.socket.once('error', reject)
    })
    this.socket.on('message', data => {
      let message
      try {
        message = JSON.parse(data.toString())
      } catch {
        return
      }
      const pending = this.pending.get(message.id)
      if (pending === undefined) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
  }

  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result.value
  }

  close() {
    this.socket.close()
  }
}

const pages = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)).json()
const page = pages.find(candidate => candidate.type === 'page' && candidate.url.startsWith('http://127.0.0.1:'))
if (page === undefined) throw new Error('Harness desktop page not found')
const client = new CdpClient(page.webSocketDebuggerUrl)
await client.connect()
try {
  await client.call('Runtime.enable')
  await client.call('Page.enable')
  const setupExpression = process.env.DSH_DESKTOP_CDP_EVALUATE
  if (setupExpression) {
    await client.evaluate(setupExpression)
    await new Promise(resolve => setTimeout(resolve, Number(process.env.DSH_DESKTOP_CDP_WAIT_MS ?? 500)))
  }
  const uploadPath = process.env.DSH_DESKTOP_CDP_UPLOAD
  if (uploadPath) {
    const image = await readFile(uploadPath)
    const mediaType = uploadPath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'
    const prompt = process.env.DSH_DESKTOP_CDP_PROMPT ?? '你能看到什么？能看到图片里的什么？'
    const uploadResult = await client.evaluate(`(async () => {
      const editor = document.querySelector('[contenteditable="true"][aria-label]')
      if (!editor) throw new Error('Composer editor not found')
      const bytes = Uint8Array.from(atob(${JSON.stringify(image.toString('base64'))}), character => character.charCodeAt(0))
      const file = new File([bytes], ${JSON.stringify(uploadPath.split('/').at(-1))}, { type: ${JSON.stringify(mediaType)} })
      const transfer = new DataTransfer()
      transfer.items.add(file)
      editor.focus()
      const pasted = editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }))
      document.execCommand('insertText', false, ${JSON.stringify(prompt)})
      return { pasted, text: editor.innerText }
    })()`)
    await new Promise(resolve => setTimeout(resolve, 1200))
    if (process.env.DSH_DESKTOP_CDP_SEND === '1') {
      const sendResult = await client.evaluate(`(() => {
        const button = document.querySelector('button[aria-label="发送消息"]')
        if (!button || button.disabled) return { sent: false, disabled: button?.disabled ?? true }
        button.click()
        return { sent: true, disabled: false }
      })()`)
      process.stderr.write(`${JSON.stringify({ uploadResult, sendResult })}\n`)
      await new Promise(resolve => setTimeout(resolve, Number(process.env.DSH_DESKTOP_CDP_WAIT_MS ?? 1500)))
    } else {
      process.stderr.write(`${JSON.stringify({ uploadResult })}\n`)
    }
  }
  const snapshot = await client.evaluate(`(() => ({
    title: document.title,
    url: location.href,
    text: document.body.innerText.slice(0, 8000),
    controls: [...document.querySelectorAll('button, textarea, input, [role="button"], [contenteditable="true"]')]
      .map((element, index) => ({
        index,
        tag: element.tagName,
        type: element.type || undefined,
        ariaLabel: element.getAttribute('aria-label') || undefined,
        title: element.title || undefined,
        text: (element.innerText || element.placeholder || element.value || '').slice(0, 180),
        disabled: Boolean(element.disabled),
        rect: (() => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height } })(),
      }))
  }))()`)
  const screenshot = await client.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const screenshotPath = process.env.DSH_DESKTOP_CDP_SCREENSHOT
  if (screenshotPath) await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  process.stdout.write(JSON.stringify({ ...snapshot, screenshotPath }, null, 2) + '\n')
} finally {
  client.close()
}
