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
