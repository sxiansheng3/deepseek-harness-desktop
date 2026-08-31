import test from 'node:test'
import assert from 'node:assert/strict'
import { isHiddenAcceptance, isTransientLocalLoadError, loadLocalRuntimeUrl } from '../src/local-runtime-loader.js'

test('enables hidden acceptance only through the exact internal flag', () => {
  assert.equal(isHiddenAcceptance({ DSH_DESKTOP_ACCEPTANCE_HIDDEN: '1' }), true)
  assert.equal(isHiddenAcceptance({ DSH_DESKTOP_ACCEPTANCE_HIDDEN: 'true' }), false)
  assert.equal(isHiddenAcceptance({}), false)
})

test('retries a transient loopback load race and then succeeds', async () => {
  const calls = []
  const waits = []
  const result = await loadLocalRuntimeUrl(async url => {
    calls.push(url)
    if (calls.length < 3) throw new Error("ERR_FAILED (-2) loading 'http://127.0.0.1:51996/'")
    return 'loaded'
  }, 'http://127.0.0.1:51996/?token=secret', {
    attempts: 4,
    retryDelayMs: 125,
    wait: async delay => waits.push(delay),
  })

  assert.equal(result, 'loaded')
  assert.equal(calls.length, 3)
  assert.deepEqual(waits, [125, 125])
})

test('does not retry remote pages or unrelated local failures', async () => {
  assert.equal(isTransientLocalLoadError(new Error('ERR_FAILED (-2)'), 'https://example.com'), false)
  assert.equal(isTransientLocalLoadError(new Error('certificate rejected'), 'http://127.0.0.1:1'), false)

  let calls = 0
  await assert.rejects(() => loadLocalRuntimeUrl(async () => {
    calls += 1
    throw new Error('certificate rejected')
  }, 'http://127.0.0.1:51996/', { wait: async () => {} }), /certificate rejected/)
  assert.equal(calls, 1)
})

test('stops after the configured local retry budget', async () => {
  let calls = 0
  await assert.rejects(() => loadLocalRuntimeUrl(async () => {
    calls += 1
    throw new Error('ERR_CONNECTION_REFUSED (-102)')
  }, 'http://localhost:51996/', {
    attempts: 3,
    wait: async () => {},
  }), /ERR_CONNECTION_REFUSED/)
  assert.equal(calls, 3)
})
