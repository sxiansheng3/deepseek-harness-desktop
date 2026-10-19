import { createHash } from 'node:crypto'

const TRANSIENT_LOCAL_LOAD_CODES = new Set([
  'ERR_FAILED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_ABORTED',
  'ERR_EMPTY_RESPONSE',
])

export function isHiddenAcceptance(env = process.env) {
  return env.DSH_DESKTOP_ACCEPTANCE_HIDDEN === '1'
}

function isLoopbackUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1')
  } catch {
    return false
  }
}

export function isTrustedHarnessFrame(senderUrl, runtimeUrl) {
  if (!isLoopbackUrl(runtimeUrl) || !isLoopbackUrl(senderUrl)) return false
  return new URL(senderUrl).origin === new URL(runtimeUrl).origin
}

/** Old port-bound login cookies are sent to every new localhost port and can cause HTTP 431. */
export async function removeStaleHarnessAuthCookies(cookieStore, runtimeUrl) {
  if (!isLoopbackUrl(runtimeUrl)) return 0
  const origin = new URL(runtimeUrl).origin
  const currentName = 'dsh-auth-' + createHash('sha256').update(new URL(runtimeUrl).host).digest('base64url')
  const cookies = await cookieStore.get({ url: origin })
  let removed = 0
  for (const cookie of cookies) {
    if (!/^dsh-auth-[A-Za-z0-9_-]{43}$/.test(cookie.name) || cookie.name === currentName) continue
    await cookieStore.remove(origin, cookie.name)
    removed += 1
  }
  return removed
}

export function isTransientLocalLoadError(error, url) {
  if (!isLoopbackUrl(url)) return false
  const text = error instanceof Error ? `${error.name}\n${error.message}` : String(error)
  return [...TRANSIENT_LOCAL_LOAD_CODES].some(code => text.includes(code))
}

export async function loadLocalRuntimeUrl(loadUrl, url, {
  attempts = 20,
  retryDelayMs = 250,
  wait = delay => new Promise(resolve => setTimeout(resolve, delay)),
} = {}) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await loadUrl(url)
    } catch (error) {
      lastError = error
      if (attempt === attempts || !isTransientLocalLoadError(error, url)) throw error
      await wait(retryDelayMs)
    }
  }
  throw lastError
}
