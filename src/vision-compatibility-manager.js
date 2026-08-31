import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile, watch } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parse, parseDocument } from 'yaml'

const REGISTRY_VERSION = 1
const MAX_PROVIDER_RESPONSE_BYTES = 8 * 1024 * 1024
const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const IMAGE_READER_SKILL = 'qwen-mm-plugins-core'
const IMAGE_READER_ORIGINAL_DESCRIPTION = 'Local MCP tools to read and visualize any file — images, video, documents, code, data, 3D, notebooks, and more — plus image tools for cropping, annotating, and extracting frames.'
const IMAGE_READER_SAFE_DESCRIPTION = 'Local MCP tools for explicit local file paths, unsupported document/media formats, cropping, annotation, and frame extraction. Do not invoke for an image already attached to a natively visual model.'
const IMAGE_READER_GUARD = '<!-- dsh-desktop-native-vision-guard-v1 -->'
const GLOBAL_VISION_GUARD = '<!-- dsh-desktop-native-vision-instructions-v1 -->'
const GLOBAL_VISION_INSTRUCTIONS = `${GLOBAL_VISION_GUARD}

# DeepSeek Harness Desktop native vision

When the current user message already contains one or more image attachments and the selected model accepts image input, the image pixels are already visible in the model request. Inspect those attachments directly and answer the user in the same step.

Do not load an image-reading skill, inspect Harness attachment storage, copy the attachment to another path, or call \`read_image\`, \`crop\`, \`run_code\`, \`bash\`, or similar tools merely to view the same attached image. Image tools remain appropriate when the user explicitly supplies a filesystem path instead of an attachment, asks for a tool-specific transformation, or the attached format cannot be consumed natively.`
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const YAML_NODE_INTERNAL_KEYS = new Set(['items', 'range', 'schema'])

function safeMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function normalizedBaseUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('模型地址必须使用 HTTP 或 HTTPS')
  return url.href.replace(/\/$/, '')
}

function chatCompletionsUrl(baseURL) {
  return `${normalizedBaseUrl(baseURL)}/chat/completions`
}

function textFromProviderResponse(body) {
  const content = body?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map(part => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '')
    .filter(Boolean)
    .join('\n')
    .trim()
}

function credentialFromDocument(document, ref) {
  if (typeof document?.refs?.[ref] === 'string') return document.refs[ref].trim()
  if (typeof document?.[ref] === 'string') return document[ref].trim()
  return undefined
}

function registryKey(provider, model) {
  return `${encodeURIComponent(provider)}/${encodeURIComponent(model)}`
}

function modelInputHasImage(entry) {
  return Array.isArray(entry?.input) && entry.input.includes('image')
}

function plainYamlValue(value) {
  return typeof value?.toJSON === 'function' ? value.toJSON() : value
}

function cleanRecord(value, allowKey = () => true) {
  const plain = plainYamlValue(value)
  if (!plain || typeof plain !== 'object' || Array.isArray(plain)) return {}
  return Object.fromEntries(Object.entries(plain).filter(([key]) => !YAML_NODE_INTERNAL_KEYS.has(key) && allowKey(key)))
}

export function stripThinkingTags(value) {
  return String(value ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim()
}

export function selectedModelFromSessionModelsResponse(response) {
  if (response?.type !== 'server-response' || response?.result?.ok !== true) return undefined
  const current = response.result.value?.current
  if (typeof current?.provider !== 'string' || typeof current?.model !== 'string') return undefined
  return { provider: current.provider, model: current.model }
}

export function parseHarnessRequest(bytes) {
  try {
    const request = JSON.parse(Buffer.from(bytes).toString('utf8'))
    if (request?.type !== 'client-request' || typeof request?.rpcId !== 'string') return undefined
    if (typeof request?.payload?.sessionId !== 'string') return undefined
    return request
  } catch {
    return undefined
  }
}

export class VisionCompatibilityManager {
  constructor({ root, harnessHome, fetchImpl, logger = console }) {
    this.root = root
    this.harnessHome = harnessHome
    this.fetchImpl = fetchImpl
    this.logger = logger
    this.registryPath = join(root, 'desktop-vision-capabilities.json')
    this.settingsPath = join(harnessHome, 'settings.yaml')
    this.credentialsPath = join(harnessHome, '.credentials.yaml')
    this.registry = { version: REGISTRY_VERSION, models: {} }
    this.watcherAbort = undefined
    this.reapplyTimer = undefined
  }

  async initialize() {
    await mkdir(this.root, { recursive: true })
    try {
      const stored = JSON.parse(await readFile(this.registryPath, 'utf8'))
      if (stored?.version === REGISTRY_VERSION && stored?.models && typeof stored.models === 'object') {
        this.registry = stored
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger.warn(`Unable to read vision capability registry: ${safeMessage(error)}`)
    }
    await this.reapplyVerifiedModels()
    await this.harmonizeImageReaderSkill()
    await this.harmonizeGlobalInstructions()
    this.startSettingsWatcher()
  }

  dispose() {
    this.watcherAbort?.abort()
    this.watcherAbort = undefined
    if (this.reapplyTimer !== undefined) clearTimeout(this.reapplyTimer)
    this.reapplyTimer = undefined
  }

  startSettingsWatcher() {
    this.watcherAbort?.abort()
    const abort = new AbortController()
    this.watcherAbort = abort
    void (async () => {
      try {
        for await (const _event of watch(this.harnessHome, { signal: abort.signal, persistent: false })) {
          if (this.reapplyTimer !== undefined) clearTimeout(this.reapplyTimer)
          this.reapplyTimer = setTimeout(() => {
            this.reapplyTimer = undefined
            void this.reapplyVerifiedModels().catch(error => {
              this.logger.warn(`Unable to restore vision declarations: ${safeMessage(error)}`)
            })
            void this.harmonizeImageReaderSkill().catch(error => {
              this.logger.warn(`Unable to harmonize image-reader skill: ${safeMessage(error)}`)
            })
            void this.harmonizeGlobalInstructions().catch(error => {
              this.logger.warn(`Unable to harmonize global vision instructions: ${safeMessage(error)}`)
            })
          }, 350)
        }
      } catch (error) {
        if (error?.name !== 'AbortError') this.logger.warn(`Unable to watch Harness settings: ${safeMessage(error)}`)
      }
    })()
  }

  publicStatus() {
    const models = Object.values(this.registry.models)
      .filter(entry => entry?.verified === true)
      .map(({ provider, model, verifiedAt, source }) => ({ provider, model, verifiedAt, source }))
      .sort((left, right) => `${left.provider}/${left.model}`.localeCompare(`${right.provider}/${right.model}`))
    return { mode: models.length > 0 ? 'native-with-fallback' : 'automatic-fallback', models }
  }

  isVerified(provider, model) {
    return this.registry.models[registryKey(provider, model)]?.verified === true
  }

  async readSettings() {
    const source = await readFile(this.settingsPath, 'utf8')
    const value = parse(source)
    return { source, value }
  }

  async resolveRoute(provider, model) {
    const { value } = await this.readSettings()
    const profile = value?.['llm-pi-ai']?.providers?.[provider]
    if (!profile || typeof profile !== 'object') return undefined
    const entry = Array.isArray(profile.models) ? profile.models.find(item => item?.id === model) : undefined
    if (entry === undefined) return undefined
    return { provider, model, profile, entry }
  }

  async routeDeclaresImage(provider, model) {
    const route = await this.resolveRoute(provider, model)
    return route !== undefined && modelInputHasImage(route.entry)
  }

  async readCredential(ref) {
    if (typeof ref !== 'string' || ref.trim() === '') return undefined
    const environmentValue = process.env[ref]
    if (typeof environmentValue === 'string' && environmentValue.trim() !== '') return environmentValue.trim()
    const document = parse(await readFile(this.credentialsPath, 'utf8'))
    return credentialFromDocument(document, ref)
  }

  async callVisionModel({ provider, model, content, probeCode, requestOverrides = {} }) {
    const route = await this.resolveRoute(provider, model)
    if (route === undefined) throw new Error(`未找到模型配置：${provider}/${model}`)
    if (route.profile.api !== 'openai-completions') {
      throw new Error(`视觉桥接暂不支持协议：${route.profile.api ?? '未声明'}`)
    }
    if (typeof route.profile.baseURL !== 'string') throw new Error('模型配置缺少 baseURL')
    const apiKey = await this.readCredential(route.profile.apiKeyEnv)
    if (!apiKey) throw new Error(`未配置凭据：${route.profile.apiKeyEnv ?? 'apiKeyEnv'}`)

    const text = content.filter(part => part?.type === 'text').map(part => part.text).join('\n').trim()
    const images = content.filter(part => part?.type === 'image' && SUPPORTED_IMAGE_TYPES.has(part.mediaType))
    if (images.length === 0) throw new Error('本次请求没有可用的图片')
    const instruction = probeCode === undefined
      ? `请读取用户上传的图片并回答原问题。原问题：${text || '请描述图片内容。'}\n请给出准确、完整、可直接供另一个助手继续回答用户的视觉分析。`
      : `读取图片中央的验证码，只回复该验证码，不要添加其他文字。验证码：${probeCode}`
    const userContent = [
      { type: 'text', text: instruction },
      ...images.map(part => ({
        type: 'image_url',
        image_url: { url: `data:${part.mediaType};base64,${part.data}` },
      })),
    ]
    const response = await this.fetchImpl(chatCompletionsUrl(route.profile.baseURL), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: userContent }], stream: false, ...requestOverrides }),
      signal: AbortSignal.timeout(120_000),
    })
    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > MAX_PROVIDER_RESPONSE_BYTES) {
      throw new Error('视觉模型响应超过安全上限')
    }
    const bodyText = await response.text()
    if (Buffer.byteLength(bodyText) > MAX_PROVIDER_RESPONSE_BYTES) throw new Error('视觉模型响应超过安全上限')
    let body
    try {
      body = JSON.parse(bodyText)
    } catch {
      throw new Error(`视觉模型返回了非 JSON 响应（HTTP ${response.status}）`)
    }
    if (!response.ok) {
      const providerMessage = body?.error?.message ?? body?.message
      throw new Error(`视觉模型请求失败（HTTP ${response.status}）${providerMessage ? `：${String(providerMessage).slice(0, 500)}` : ''}`)
    }
    const result = textFromProviderResponse(body)
    if (result === '') throw new Error('视觉模型没有返回可用内容')
    if (probeCode !== undefined && !result.toUpperCase().includes(probeCode.toUpperCase())) {
      throw new Error('模型响应成功，但未正确读取测试图片')
    }
    return result
  }

  async markVerified(provider, model, source, compatibility = {}) {
    this.registry.models[registryKey(provider, model)] = {
      provider,
      model,
      verified: true,
      source,
      ...compatibility,
      verifiedAt: new Date().toISOString(),
    }
    await this.writeRegistry()
    await this.applyModelDeclaration(provider, model)
  }

  async writeRegistry() {
    const next = `${this.registryPath}.next-${process.pid}-${randomUUID()}`
    await writeFile(next, JSON.stringify(this.registry, null, 2) + '\n', { mode: 0o600 })
    await rename(next, this.registryPath)
  }

  async applyModelDeclaration(provider, model, compatibility = this.registry.models[registryKey(provider, model)] ?? {}) {
    const source = await readFile(this.settingsPath, 'utf8')
    const document = parseDocument(source)
    const models = document.getIn(['llm-pi-ai', 'providers', provider, 'models'], true)
    if (!models?.items) throw new Error(`未找到模型配置：${provider}/${model}`)
    const item = models.items.find(candidate => candidate?.get?.('id') === model)
    if (item === undefined) throw new Error(`未找到模型配置：${provider}/${model}`)
    const current = plainYamlValue(item.get('input'))
    let changed = false
    if (!Array.isArray(current) || !current.includes('image')) {
      item.set('input', ['text', 'image'])
      changed = true
    }
    if (compatibility.thinkingFormat === 'deepseek') {
      const currentEfforts = item.get('reasoningEfforts')
      const declaredEfforts = cleanRecord(currentEfforts, key => THINKING_LEVELS.has(key))
      const hasThinkingEffort = Object.keys(declaredEfforts).some(level => level !== 'off')
      const effortsWereSanitized = Object.keys(plainYamlValue(currentEfforts) ?? {}).length !== Object.keys(declaredEfforts).length
      if (!Object.hasOwn(declaredEfforts, 'off') || declaredEfforts.off !== null || !hasThinkingEffort || effortsWereSanitized) {
        // Harness rejects an effort map that offers only `off`. A valueless off
        // plus one real level resolves to reasoning=true while leaving `off`
        // absent from pi-ai's wire map, which makes the DeepSeek dialect send
        // the provider's explicit `thinking: { type: "disabled" }` request.
        item.set('reasoningEfforts', {
          ...declaredEfforts,
          off: null,
          ...(hasThinkingEffort ? {} : { high: 'high' }),
        })
        changed = true
      }
      const currentCompatNode = item.get('compat')
      const currentCompat = cleanRecord(currentCompatNode)
      const compatWasSanitized = Object.keys(plainYamlValue(currentCompatNode) ?? {}).length !== Object.keys(currentCompat).length
      if (currentCompat.thinkingFormat !== 'deepseek' || compatWasSanitized) {
        item.set('compat', { ...currentCompat, thinkingFormat: 'deepseek' })
        changed = true
      }
    }
    if (!changed) return false
    const next = `${this.settingsPath}.next-${process.pid}-${randomUUID()}`
    await mkdir(dirname(this.settingsPath), { recursive: true })
    await writeFile(next, document.toString(), { mode: 0o600 })
    await rename(next, this.settingsPath)
    return true
  }

  async reapplyVerifiedModels() {
    for (const entry of Object.values(this.registry.models)) {
      if (entry?.verified !== true) continue
      try {
        await this.applyModelDeclaration(entry.provider, entry.model)
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          this.logger.warn(`Unable to reapply ${entry.provider}/${entry.model} vision capability: ${safeMessage(error)}`)
        }
      }
    }
  }

  async harmonizeImageReaderSkill() {
    const skillPath = join(this.harnessHome, 'skills', IMAGE_READER_SKILL, 'SKILL.md')
    let source
    try {
      source = await readFile(skillPath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw error
    }
    if (source.includes(IMAGE_READER_GUARD)) return false
    if (!source.includes(`description: ${IMAGE_READER_ORIGINAL_DESCRIPTION}`)) return false
    const guarded = source
      .replace(`description: ${IMAGE_READER_ORIGINAL_DESCRIPTION}`, `description: ${IMAGE_READER_SAFE_DESCRIPTION}`)
      .replace(
        '# Qwen-MM-Plugins Core',
        `# Qwen-MM-Plugins Core\n\n${IMAGE_READER_GUARD}\n\nWhen an image is already attached to the current user message and the selected model has native image input, inspect that attachment directly. Do not load this skill and do not call \`read_image\` merely to re-read the same attachment. Use this skill for explicit local paths, formats the model cannot consume natively, or when the user explicitly asks for these tools.`,
      )
    const backupPath = join(this.root, 'compatibility-backups', `${IMAGE_READER_SKILL}-SKILL.md`)
    try {
      await readFile(backupPath)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await mkdir(dirname(backupPath), { recursive: true })
      await writeFile(backupPath, source, { mode: 0o600 })
    }
    const next = `${skillPath}.next-${process.pid}-${randomUUID()}`
    await writeFile(next, guarded)
    await rename(next, skillPath)
    return true
  }

  async harmonizeGlobalInstructions() {
    const instructionPath = join(this.harnessHome, 'AGENTS.md')
    let source = ''
    try {
      source = await readFile(instructionPath, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (source.includes(GLOBAL_VISION_GUARD)) return false
    const backupPath = join(this.root, 'compatibility-backups', 'global-AGENTS.md')
    try {
      await readFile(backupPath)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await mkdir(dirname(backupPath), { recursive: true })
      await writeFile(backupPath, source, { mode: 0o600 })
    }
    const prefix = source.trimEnd()
    const nextSource = `${prefix}${prefix === '' ? '' : '\n\n'}${GLOBAL_VISION_INSTRUCTIONS}\n`
    const next = `${instructionPath}.next-${process.pid}-${randomUUID()}`
    await writeFile(next, nextSource, { mode: 0o600 })
    await rename(next, instructionPath)
    return true
  }

  async analyzeAndRemember({ provider, model, content }) {
    let result = await this.callVisionModel({ provider, model, content })
    let thinkingFormat
    if (/<think(?:ing)?>/i.test(result)) {
      try {
        const withoutThinking = await this.callVisionModel({
          provider,
          model,
          content,
          requestOverrides: { thinking: { type: 'disabled' } },
        })
        if (!/<think(?:ing)?>/i.test(withoutThinking)) {
          result = withoutThinking
          thinkingFormat = 'deepseek'
        }
      } catch {
        // The provider may not understand DeepSeek's thinking control; retain the successful baseline.
      }
    }
    const cleanResult = stripThinkingTags(result)
    if (cleanResult === '') throw new Error('视觉模型只返回了思考过程，没有可用答案')
    await this.markVerified(provider, model, 'real-image', thinkingFormat ? { thinkingFormat } : {})
    return cleanResult
  }

  async verifyWithProbe({ provider, model, image, code }) {
    const result = await this.callVisionModel({ provider, model, content: [
      { type: 'text', text: '读取测试图片验证码' },
      { type: 'image', mediaType: 'image/png', data: image },
    ], probeCode: code })
    await this.markVerified(provider, model, 'probe')
    return result
  }
}
