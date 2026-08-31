import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRuntimeUpdateDialogHtml,
  chineseReleaseNotes,
  escapeHtml,
  runtimeUpdateDialogAction,
} from '../src/runtime-update-dialog.js'

test('escapes untrusted GitHub release content before rendering it', () => {
  assert.equal(escapeHtml('<script>&"\''), '&lt;script&gt;&amp;&quot;&#39;')
  const html = buildRuntimeUpdateDialogHtml({
    version: '0.1.2-alpha.2',
    activeVersion: '0.1.1-rc.2',
    releaseNotes: { body: '问题修复：<img src=x onerror=alert(1)>', url: 'https://example.com' },
  })
  assert.doesNotMatch(html, /<img src=x/)
  assert.match(html, /问题修复：&lt;img src=x onerror=alert\(1\)&gt;/)
})

test('shows only the Chinese section from an official bilingual release', () => {
  const notes = chineseReleaseNotes(`中文 | English

新增功能

- 支持自动重连 @imccyu

问题修复

- 修复启动失败问题 @LegGasai

New Features

- Support automatic reconnection by @imccyu

Bug Fixes

- Fix startup failures by @LegGasai

Full Changelog: dsh-v0.1.1...dsh-v0.1.2`)
  assert.match(notes, /新增功能/)
  assert.match(notes, /修复启动失败问题/)
  assert.doesNotMatch(notes, /New Features|Bug Fixes|Full Changelog|automatic reconnection/)
})

test('uses a Chinese explanation instead of displaying an English-only release', () => {
  assert.equal(
    chineseReleaseNotes('Bug Fixes\n\n- Fix startup failures'),
    '官方本次没有提供中文更新说明。可以点击“在 GitHub 查看”查看原始说明。',
  )
})

test('keeps long release notes scrollable with fixed header, close action, and footer actions', () => {
  const html = buildRuntimeUpdateDialogHtml({
    version: '0.1.2-alpha.2',
    activeVersion: '0.1.1-rc.2',
    releaseNotes: { body: '更新说明\n'.repeat(500), url: 'https://example.com' },
  })
  assert.match(html, /height: 100vh/)
  assert.match(html, /overflow-y: auto/)
  assert.match(html, /aria-label="关闭更新窗口"/)
  assert.match(html, />暂不更新</)
  assert.match(html, />在 GitHub 查看</)
  assert.match(html, />更新并重启 Harness</)
})

test('accepts only known runtime update dialog actions', () => {
  assert.equal(runtimeUpdateDialogAction('dsh-runtime-update://cancel'), 'cancel')
  assert.equal(runtimeUpdateDialogAction('dsh-runtime-update://github'), 'github')
  assert.equal(runtimeUpdateDialogAction('dsh-runtime-update://update'), 'update')
  assert.equal(runtimeUpdateDialogAction('dsh-runtime-update://delete'), undefined)
  assert.equal(runtimeUpdateDialogAction('https://example.com/update'), undefined)
})
