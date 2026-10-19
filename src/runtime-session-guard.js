import { randomUUID } from 'node:crypto'

/** Desktop-shell replacement must honor the same task guard as a Runtime switch. */
export async function stopIdleRuntime(runtime) {
  await runtime.assertCanSwitch()
  await runtime.stop()
}

/** Read the runtime's authoritative session list before stopping it for an update. */
export async function assertRuntimeIdle(url, fetcher) {
  if (!url) return
  const endpoint = new URL('/api/session/list', url)
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1') throw new Error('无效的本机 Runtime 地址')
  const response = await fetcher(endpoint.href, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: endpoint.origin }, credentials: 'include',
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'session/list', payload: { args: { _request: {} } } }),
    signal: AbortSignal.timeout(15_000),
  })
  const result = response.ok ? (await response.json()).result : undefined
  if (!result?.ok || !Array.isArray(result.value?.items) || result.value.items.some(item => typeof item.running !== 'boolean')) {
    throw new Error('暂时无法确认任务状态，请稍后再更新。')
  }
  if (result.value.items.some(item => item.running)) throw new Error('仍有任务正在执行，请等待任务结束后再更新或回退。')
}
