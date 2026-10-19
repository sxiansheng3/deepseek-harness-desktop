/**
 * Pure protocol helpers for the desktop vision bridge.
 *
 * The bridge has to speak the same wire protocol as the Harness Web client.
 * Everything here is intentionally free of Electron, filesystem, and network
 * dependencies so it can be unit tested with `node --test`:
 *
 * - request capture: which URL is a prompt request, and how the 0.2.x
 *   `{ type, rpcId, method, payload: { args } }` envelope is unwrapped;
 * - RPC framing: `/api/<namespace>/<method>` plus the `{ args }` payload the
 *   gateway's `remoteRequest()` requires (see `@deepseek-ai/dsh-api-gateway`
 *   `remoteRequest`: exactly one plain-object `args` field, endpoint split into
 *   exactly two `/`-separated segments);
 * - model resolution: reading the session's effective selection out of the
 *   `session/projections` payload, with the `session/modelCatalog` deployment
 *   default as the fallback DSH itself uses when a session has no selection.
 *
 * @module vision-bridge-protocol
 */

/** Canonical prompt endpoint; the gateway rejects any other segment count. */
export const PROMPT_ENDPOINT = 'session/prompt'
/** Durable per-session projections, including `modelSelection`. */
export const PROJECTIONS_ENDPOINT = 'session/projections'
/** Provider-grouped model catalog plus the deployment default selection. */
export const MODEL_CATALOG_ENDPOINT = 'session/modelCatalog'
/** Exact path of the prompt RPC the page issues. */
export const PROMPT_REQUEST_PATH = '/api/session/prompt'
/** Default loopback hosts the desktop loads the Harness UI from. */
export const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]']
/**
 * Hosts usable inside a `webRequest` match pattern.
 *
 * Chromium match patterns accept hostnames and IPv4 literals; an IPv6 literal
 * is refused at registration, so the filter covers only the spellings the
 * desktop actually loads. {@link isPromptRequestUrl} still accepts `[::1]`
 * for tests and for a future loopback spelling.
 */
export const MATCH_PATTERN_HOSTS = ['127.0.0.1', 'localhost']
/** RPC channel prefix every Harness connection uses. */
export const RPC_CHANNEL = '/api'

/**
 * Electron/Chromium match patterns for the prompt capture filter.
 *
 * Match patterns carry no port: `http://127.0.0.1/*` matches the page's request
 * to `http://127.0.0.1:<port>/api/session/prompt`. The path is filtered in
 * {@link isPromptRequestUrl} instead, because the match pattern language cannot
 * express the two-segment endpoint reliably.
 * @param hosts - loopback hosts to cover.
 * @returns match-pattern strings for `webRequest` filters.
 */
export function loopbackRequestUrlPatterns(hosts = MATCH_PATTERN_HOSTS) {
  return hosts.map(host => `http://${host}/*`)
}

/**
 * Whether one captured request URL is the page's `session/prompt` RPC.
 * @param rawUrl - absolute request URL from the webRequest details.
 * @param hosts - loopback hosts accepted as the Harness origin.
 * @returns whether the URL targets the prompt endpoint on loopback.
 */
export function isPromptRequestUrl(rawUrl, hosts = LOOPBACK_HOSTS) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return false
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (!hosts.includes(url.hostname)) return false
  return url.pathname === PROMPT_REQUEST_PATH
}

/**
 * Absolute RPC URL for one endpoint.
 * @param baseUrl - Harness base URL (the page origin).
 * @param endpoint - `<namespace>/<method>` endpoint.
 * @returns the absolute URL of the RPC call.
 */
export function rpcRequestUrl(baseUrl, endpoint) {
  return new URL(`${RPC_CHANNEL}/${endpoint}`, baseUrl)
}

/**
 * Connection RPC request body for one endpoint.
 * @param endpoint - `<namespace>/<method>` endpoint.
 * @param rpcId - correlation id the response must echo.
 * @param args - named arguments object; zero-parameter endpoints pass `{}`.
 * @returns the `client-request` envelope.
 */
export function rpcRequestBody(endpoint, rpcId, args = {}) {
  return { type: 'client-request', rpcId, method: endpoint, payload: { args } }
}

/**
 * Unwrap one captured prompt envelope into the facts the bridge needs.
 *
 * The 0.2.x page sends `payload.args.request`; older shells sent the request at
 * `payload` directly, which is still accepted so the bridge degrades instead of
 * crashing on an unexpected shell version.
 * @param envelope - parsed `client-request` envelope, or anything else.
 * @returns `{ rpcId, request }`, or `undefined` when this is not a usable prompt.
 */
export function parseCapturedPromptRequest(envelope) {
  if (envelope === null || typeof envelope !== 'object') return undefined
  if (envelope.type !== 'client-request') return undefined
  if (typeof envelope.rpcId !== 'string' || envelope.rpcId.length === 0) return undefined
  const payload = envelope.payload
  if (payload === null || typeof payload !== 'object') return undefined
  const nested = payload.args
  const candidate = nested !== null && typeof nested === 'object' && nested.request !== null && typeof nested.request === 'object'
    ? nested.request
    : payload
  if (typeof candidate.sessionId !== 'string' || candidate.sessionId.length === 0) return undefined
  if (!Array.isArray(candidate.content)) return undefined
  return {
    rpcId: envelope.rpcId,
    request: {
      sessionId: candidate.sessionId,
      mode: candidate.mode,
      content: candidate.content,
      ...(typeof candidate.clientTimeZone === 'string' ? { clientTimeZone: candidate.clientTimeZone } : {}),
    },
  }
}

/**
 * Text and image parts of one prompt request.
 * @param request - normalized captured request.
 * @returns the relevant content parts in order.
 */
export function imageContentFromPromptRequest(request) {
  if (!Array.isArray(request?.content)) return []
  return request.content.filter(part => part?.type === 'text' || part?.type === 'image')
}

/**
 * Named arguments for the prompt RPC. `requestId` is required by the 0.2.x
 * schema and is what deduplicates the exact accepted message.
 * @param input - session, mode, content, and optional request identity.
 * @returns the args object for {@link rpcRequestBody}.
 */
export function promptArgs({ requestId, sessionId, mode, content, clientTimeZone }) {
  return {
    request: {
      requestId,
      sessionId,
      mode: bridgePromptMode(mode),
      content,
      ...(typeof clientTimeZone === 'string' ? { clientTimeZone } : {}),
    },
  }
}

/**
 * Delivery mode the prompt RPC accepts.
 * @param mode - the captured request's mode.
 * @returns `steer` or `queue`.
 */
export function bridgePromptMode(mode) {
  return mode === 'steer' ? 'steer' : 'queue'
}

/**
 * Read the session's effective model selection from one projections payload.
 *
 * The wire view is `{ lastUsed, next }` and `next` is `pending ?? lastUsed`
 * (`model-selection-projection.js`), which matches the agent's own resolution
 * order: pending selection, then the last recorded request header.
 * @param value - `result.value` of a `session/projections` response.
 * @returns `{ provider, model }`, or `undefined` when the session records none.
 */
export function selectionFromProjectionPayload(value) {
  const values = value?.values
  const selection = values?.modelSelection?.next ?? values?.modelSelection?.lastUsed
  return normalizeSelection(selection)
}

/**
 * Read the deployment default selection from one model catalog payload.
 *
 * DSH falls back to `agentDefaultModel.currentSelection()` when a session has
 * neither a pending selection nor a recorded request header.
 * @param value - `result.value` of a `session/modelCatalog` response.
 * @returns `{ provider, model }`, or `undefined` when the catalog is unusable.
 */
export function selectionFromModelCatalogPayload(value) {
  return normalizeSelection(value?.default)
}

/**
 * Keep only a usable `{ provider, model }` identity.
 * @param selection - candidate selection object.
 * @returns a trimmed selection, or `undefined`.
 */
export function normalizeSelection(selection) {
  if (selection === null || typeof selection !== 'object') return undefined
  const provider = selection.provider
  const model = selection.model
  if (typeof provider !== 'string' || provider.length === 0) return undefined
  if (typeof model !== 'string' || model.length === 0) return undefined
  return { provider, model }
}

/**
 * Compatibility prompt injected after the bridge has read the image itself.
 * @param input - the user's original question and the local vision result.
 * @returns prompt text for the text-only model.
 */
export function compatibilityPromptText({ question, analysis }) {
  const trimmed = typeof question === 'string' ? question.trim() : ''
  return [
    '[DeepSeek Harness Desktop 视觉兼容层]',
    '桌面端已经使用当前模型成功读取了用户本次上传的图片。请直接依据下面的视觉结果回答用户，不要声称无法看到图片，也不要要求用户重复上传。',
    trimmed.length > 0 ? `用户原问题：\n${trimmed}` : '用户原问题：请描述上传的图片。',
    `视觉读取结果：\n${analysis}`,
  ].join('\n\n')
}