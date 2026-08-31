import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'
import {
  parseHarnessRequest,
  selectedModelFromSessionModelsResponse,
  stripThinkingTags,
  VisionCompatibilityManager,
} from '../src/vision-compatibility-manager.js'

const SETTINGS = `llm-pi-ai:
  providers:
    youkede:
      apiKeyEnv: YOUKEDE_API_KEY
      api: openai-completions
      baseURL: https://gateway.example/v1
      models:
        - id: text-only
          input:
            - text
        - id: vision-model
          input:
            - text
agent-default-model:
  provider: youkede
  model: vision-model
`

async function fixture(fetchImpl) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-vision-'))
  const harnessHome = join(root, 'harness-home')
  await mkdir(harnessHome)
  await writeFile(join(harnessHome, 'settings.yaml'), SETTINGS)
  await writeFile(join(harnessHome, '.credentials.yaml'), 'version: 1\nrefs:\n  YOUKEDE_API_KEY: test-key\n', { mode: 0o600 })
  const manager = new VisionCompatibilityManager({ root, harnessHome, fetchImpl, logger: { warn() {} } })
  await manager.initialize()
  return { root, harnessHome, manager }
}

test('parses only valid Harness image prompt envelopes', () => {
  const request = {
    type: 'client-request',
    rpcId: 'rpc-1',
    method: 'session.prompt',
    payload: { sessionId: 'session-1', mode: 'queue', content: [{ type: 'image', mediaType: 'image/png', data: 'AA==' }] },
  }
  assert.deepEqual(parseHarnessRequest(Buffer.from(JSON.stringify(request))), request)
  assert.equal(parseHarnessRequest(Buffer.from('{bad')), undefined)
  assert.equal(parseHarnessRequest(Buffer.from(JSON.stringify({ ...request, rpcId: undefined }))), undefined)
})

test('extracts the exact selected provider and model from session.models', () => {
  assert.deepEqual(selectedModelFromSessionModelsResponse({
    type: 'server-response',
    result: { ok: true, value: { current: { provider: 'youkede', model: 'vision-model' } } },
  }), { provider: 'youkede', model: 'vision-model' })
  assert.equal(selectedModelFromSessionModelsResponse({ type: 'server-response', result: { ok: false } }), undefined)
})

test('removes provider-leaked thinking tags without altering the final answer', () => {
  assert.equal(stripThinkingTags('<think>private reasoning</think>\n\nyoukede'), 'youkede')
  assert.equal(stripThinkingTags('<thinking>private reasoning</thinking>\n最终答案'), '最终答案')
})

test('a real successful image call remembers and patches only the exact model', async () => {
  const requests = []
  const context = await fixture(async (url, init) => {
    requests.push({ url, init })
    return new Response(JSON.stringify({ choices: [{ message: { content: '图中是测试内容' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  try {
    const result = await context.manager.analyzeAndRemember({
      provider: 'youkede',
      model: 'vision-model',
      content: [
        { type: 'text', text: '你看到了什么？' },
        { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' },
      ],
    })
    assert.equal(result, '图中是测试内容')
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, 'https://gateway.example/v1/chat/completions')
    const body = JSON.parse(requests[0].init.body)
    assert.equal(body.model, 'vision-model')
    assert.match(body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/)
    const settings = parse(await readFile(join(context.harnessHome, 'settings.yaml'), 'utf8'))
    assert.deepEqual(settings['llm-pi-ai'].providers.youkede.models[0], { id: 'text-only', input: ['text'] })
    assert.deepEqual(settings['llm-pi-ai'].providers.youkede.models[1], { id: 'vision-model', input: ['text', 'image'] })
    assert.equal(context.manager.publicStatus().models[0].model, 'vision-model')

    await writeFile(join(context.harnessHome, 'settings.yaml'), SETTINGS)
    await context.manager.reapplyVerifiedModels()
    const restored = parse(await readFile(join(context.harnessHome, 'settings.yaml'), 'utf8'))
    assert.deepEqual(restored['llm-pi-ai'].providers.youkede.models[1].input, ['text', 'image'])
  } finally {
    context.manager.dispose()
    await rm(context.root, { recursive: true, force: true })
  }
})

test('unknown OpenAI-compatible models optimistically allow images without overriding explicit text-only models', async () => {
  const context = await fixture(async () => new Response('{}', { status: 500 }))
  try {
    const unknownSettings = `llm-pi-ai:
  providers:
    youkede:
      api: openai-completions
      models:
        - id: claude-opus-4-8
        - id: future-vision-model
        - id: explicitly-text-only
          input:
            - text
    native-provider:
      api: anthropic-messages
      models:
        - id: untouched-model
`
    await writeFile(join(context.harnessHome, 'settings.yaml'), unknownSettings)
    assert.equal(await context.manager.applyOptimisticImageDeclarations(), true)
    assert.equal(await context.manager.applyOptimisticImageDeclarations(), false)
    const settings = parse(await readFile(join(context.harnessHome, 'settings.yaml'), 'utf8'))
    const youkede = settings['llm-pi-ai'].providers.youkede.models
    assert.deepEqual(youkede[0], { id: 'claude-opus-4-8', input: ['text', 'image'] })
    assert.deepEqual(youkede[1], { id: 'future-vision-model', input: ['text', 'image'] })
    assert.deepEqual(youkede[2], { id: 'explicitly-text-only', input: ['text'] })
    assert.deepEqual(settings['llm-pi-ai'].providers['native-provider'].models[0], { id: 'untouched-model' })

    await writeFile(join(context.harnessHome, 'settings.yaml'), unknownSettings)
    assert.equal(await context.manager.applyOptimisticImageDeclarations(), true)
    const restored = parse(await readFile(join(context.harnessHome, 'settings.yaml'), 'utf8'))
    assert.deepEqual(restored['llm-pi-ai'].providers.youkede.models[0].input, ['text', 'image'])
  } finally {
    context.manager.dispose()
    await rm(context.root, { recursive: true, force: true })
  }
})

test('clean install waits for Runtime settings and applies the image policy when the file appears', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-vision-clean-install-'))
  const harnessHome = join(root, 'harness-home')
  await mkdir(harnessHome)
  const manager = new VisionCompatibilityManager({
    root,
    harnessHome,
    fetchImpl: async () => new Response('{}', { status: 500 }),
    logger: { warn() {} },
  })
  try {
    await manager.initialize()
    assert.equal(await manager.applyOptimisticImageDeclarations(), false)
    await writeFile(join(harnessHome, 'settings.yaml'), `llm-pi-ai:
  providers:
    youkede:
      api: openai-completions
      models:
        - id: claude-opus-4-8
`)

    const deadline = Date.now() + 2_000
    let input
    while (Date.now() < deadline) {
      const settings = parse(await readFile(join(harnessHome, 'settings.yaml'), 'utf8'))
      input = settings?.['llm-pi-ai']?.providers?.youkede?.models?.[0]?.input
      if (Array.isArray(input)) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.deepEqual(input, ['text', 'image'])
  } finally {
    manager.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('provider failure does not over-claim image support or mutate settings', async () => {
  const context = await fixture(async () => new Response(JSON.stringify({ error: { message: 'image unsupported' } }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  }))
  try {
    await assert.rejects(context.manager.analyzeAndRemember({
      provider: 'youkede',
      model: 'text-only',
      content: [{ type: 'image', mediaType: 'image/png', data: 'AA==' }],
    }), /image unsupported/)
    assert.equal(context.manager.publicStatus().models.length, 0)
    assert.equal(await readFile(join(context.harnessHome, 'settings.yaml'), 'utf8'), SETTINGS)
  } finally {
    context.manager.dispose()
    await rm(context.root, { recursive: true, force: true })
  }
})

test('detects DeepSeek-style thinking disable and persists it on the exact model', async () => {
  let calls = 0
  const context = await fixture(async (_url, init) => {
    calls += 1
    const body = JSON.parse(init.body)
    const content = body.thinking?.type === 'disabled'
      ? 'youkede'
      : '<think>long private reasoning</think>\n\nyoukede'
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
  })
  try {
    const answer = await context.manager.analyzeAndRemember({
      provider: 'youkede',
      model: 'vision-model',
      content: [{ type: 'image', mediaType: 'image/png', data: 'AA==' }],
    })
    assert.equal(answer, 'youkede')
    assert.equal(calls, 2)
    assert.equal(await context.manager.applyModelDeclaration('youkede', 'vision-model'), false)
    const settings = parse(await readFile(join(context.harnessHome, 'settings.yaml'), 'utf8'))
    const model = settings['llm-pi-ai'].providers.youkede.models[1]
    assert.deepEqual(model.reasoningEfforts, { off: null, high: 'high' })
    assert.deepEqual(model.compat, { thinkingFormat: 'deepseek' })
    assert.equal(context.manager.publicStatus().models[0].model, 'vision-model')
  } finally {
    context.manager.dispose()
    await rm(context.root, { recursive: true, force: true })
  }
})

test('narrows the stock image-reader skill so native attachments are not read twice', async () => {
  const context = await fixture(async () => new Response('{}', { status: 500 }))
  const skillDirectory = join(context.harnessHome, 'skills', 'qwen-mm-plugins-core')
  const original = `---
name: qwen-mm-plugins-core
description: Local MCP tools to read and visualize any file — images, video, documents, code, data, 3D, notebooks, and more — plus image tools for cropping, annotating, and extracting frames.
---

# Qwen-MM-Plugins Core

Original body.
`
  try {
    await mkdir(skillDirectory, { recursive: true })
    await writeFile(join(skillDirectory, 'SKILL.md'), original)
    assert.equal(await context.manager.harmonizeImageReaderSkill(), true)
    assert.equal(await context.manager.harmonizeImageReaderSkill(), false)
    const guarded = await readFile(join(skillDirectory, 'SKILL.md'), 'utf8')
    assert.match(guarded, /Do not invoke for an image already attached/)
    assert.match(guarded, /dsh-desktop-native-vision-guard-v1/)
    assert.equal(
      await readFile(join(context.root, 'compatibility-backups', 'qwen-mm-plugins-core-SKILL.md'), 'utf8'),
      original,
    )
  } finally {
    context.manager.dispose()
    await rm(context.root, { recursive: true, force: true })
  }
})

test('adds an idempotent global native-vision guard without replacing user instructions', async () => {
  const context = await fixture(async () => new Response('{}', { status: 500 }))
  const instructionPath = join(context.harnessHome, 'AGENTS.md')
  const original = '# User instructions\n\nKeep this content.\n'
  try {
    await writeFile(instructionPath, original)
    assert.equal(await context.manager.harmonizeGlobalInstructions(), true)
    assert.equal(await context.manager.harmonizeGlobalInstructions(), false)
    const guarded = await readFile(instructionPath, 'utf8')
    assert.match(guarded, /^# User instructions/)
    assert.match(guarded, /dsh-desktop-native-vision-instructions-v1/)
    assert.match(guarded, /Do not load an image-reading skill/)
    await readFile(join(context.root, 'compatibility-backups', 'global-AGENTS.md'), 'utf8')
  } finally {
    context.manager.dispose()
    await rm(context.root, { recursive: true, force: true })
  }
})
