import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { buildDesktopDialogHtml, desktopDialogBounds, desktopDialogResponse, showDesktopDialog } from '../src/desktop-dialog.js'

test('clamps a dialog inside small and offset displays even when its parent is off-screen', () => {
  for (const area of [{ x: 0, y: 24, width: 640, height: 440 }, { x: -1600, y: -200, width: 1280, height: 720 }]) {
    const bounds = desktopDialogBounds({ x: -4000, y: 800, width: 2200, height: 1800 }, area)
    assert.ok(bounds.width <= area.width - 32)
    assert.ok(bounds.height <= area.height - 32)
    assert.ok(bounds.x >= area.x && bounds.x + bounds.width <= area.x + area.width)
    assert.ok(bounds.y >= area.y && bounds.y + bounds.height <= area.y + area.height)
  }
})

test('long update notes and errors share a scroll area and pinned actions without executable markup', () => {
  const detail = '最后一行 <img src=x onerror=alert(1)>\n'.repeat(1000)
  for (const type of ['info', 'error']) {
    const html = buildDesktopDialogHtml({ type, title: '更新', message: '摘要', detail, buttons: ['立即更新', '稍后'] })
    assert.match(html, /min-height:0; overflow-y:auto/)
    assert.match(html, /footer \{ flex:0 0 auto/)
    assert.match(html, /aria-label="关闭窗口"/)
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
    assert.doesNotMatch(html, /<img/)
    assert.equal((html.match(/最后一行/g) ?? []).length, 1000)
    assert.match(html, /href="dsh-dialog:\/\/0">立即更新/)
    assert.match(html, /href="dsh-dialog:\/\/1">稍后/)
  }
})

test('dialog navigation accepts only bounded response IDs and an explicit cancel action', () => {
  assert.equal(desktopDialogResponse('dsh-dialog://0', 2, 1), 0)
  assert.equal(desktopDialogResponse('dsh-dialog://cancel', 2, 1), 1)
  for (const url of ['https://example.com', 'dsh-dialog://2', 'dsh-dialog://-1', 'dsh-dialog://garbage']) {
    assert.equal(desktopDialogResponse(url, 2, 1), undefined)
  }
})

test('Escape and window close resolve to cancel rather than starting an update', async () => {
  let created
  class FakeWindow extends EventEmitter {
    constructor() { super(); this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {}; created = this }
    loadURL() { return Promise.resolve() }
    isDestroyed() { return false }
    close() { this.emit('closed') }
  }
  const dependencies = { BrowserWindow: FakeWindow, screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }) } }
  const options = { buttons: ['立即更新', '稍后'], defaultId: 0, cancelId: 1 }
  const escaped = showDesktopDialog(dependencies, options)
  let prevented = false
  created.webContents.emit('before-input-event', { preventDefault() { prevented = true } }, { type: 'keyDown', key: 'Escape' })
  assert.equal((await escaped).response, 1)
  assert.equal(prevented, true)
  const closed = showDesktopDialog(dependencies, options)
  created.close()
  assert.equal((await closed).response, 1)
})
