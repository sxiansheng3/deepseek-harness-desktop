import { randomUUID } from 'node:crypto'
// watcher 用 node:fs 的同步 watch()：它返回时监听已生效；fs/promises 的 watch 是
// async generator，首次 next() 才注册，会让 initialize() 返回后出现丢事件窗口。
import { watch as watchCallback } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { isMap, isSeq, parse, parseDocument } from 'yaml'

// ---------------------------------------------------------------------------
// 配置层（2026-10，desktop 0.1.19 / runtime 0.2.1-rc.2 实测）
//
// Harness 的 provider 配置不再只来自 `$DSH_HOME/settings.yaml`：
//   1. $DSH_HOME/profiles/<profile>/cordis.patch.yml  profile 自己的 patch 层
//   2. $DSH_HOME/cordis.patch.yml                     机器级 patch 层（最后应用）
//   3. $DSH_HOME/settings.yaml                        旧版单文件配置（兼容保留）
// settings.yaml 在本机已经不存在（只剩 .bak/imported 备份），旧实现因此完全
// 失效。本 manager 把配置源抽象成 configurationSources()，让「乐观图片声明」
// 「registry 重应用」「路由解析」都看同一批源，避免出现“声明已补但桥接仍说
// 找不到模型配置”的不一致。
//
// api 白名单为什么只认显式声明：
// dsh-llm-pi-ai 的 resolveRouteModels() 解析协议的方式是
//   const api = request.api ?? base?.api ?? routeApi
// provider 未声明 api 时，协议来自 pi-ai 内置 catalog（自定义 route 若 catalog
// 无描述会直接判为非法配置），sharedCatalogApi() 在 catalog 内协议不唯一时也
// 返回 undefined。discoverModels() 里的 `request.api ?? "openai-completions"`
// 只服务于“拉取模型列表”，不能证明未声明 api 的 route 讲 openai-completions。
// 因此这里保守处理：只有显式 api 命中 OPTIMISTIC_IMAGE_APIS 的 provider 才做
// 乐观图片声明；未声明 api 的 provider（例如由内置 catalog 描述的 minimax-cn，
// 默认 baseURL 指向 /anthropic）保持原样。
// ---------------------------------------------------------------------------

const REGISTRY_VERSION = 1
const MAX_PROVIDER_RESPONSE_BYTES = 8 * 1024 * 1024
const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const IMAGE_READER_SKILL = 'qwen-mm-plugins-core'
const IMAGE_READER_ORIGINAL_DESCRIPTION = 'Local MCP tools to read and visualize any file — images, video, documents, code, data, 3D, notebooks, and more — plus image tools for cropping, annotating, and extracting frames.'
const IMAGE_READER_SAFE_DESCRIPTION = 'Local MCP tools for explicit local file paths, unsupported document/media formats, cropping, annotation, and frame extraction. Do not invoke for an image already attached to a natively visual model.'
const IMAGE_READER_GUARD = '<!-- dsh-desktop-native-vision-guard-v1 -->'
const GLOBAL_VISION_GUARD = '<!-- dsh-desktop-native-vision-instructions-v1 -->'
const OPTIMISTIC_IMAGE_APIS = new Set(['openai-completions'])
const LLM_PI_AI_PLUGIN_ID = 'llm-pi-ai'
// 文本级保真写入使用的固定键块（相对缩进由条目位置决定）。
const IMAGE_INPUT_BLOCK = ['input:', '  - text', '  - image']
const DEEPSEEK_COMPAT_BLOCK = ['compat:', '  thinkingFormat: deepseek']
const PATCH_FILE_PATTERN = /\.patch\.ya?ml$/i
// profiles/ 下除真实 profile 外还可能有依赖目录（pnpm 的 node_modules 等），
// 它们内部也可能藏着 *.patch.yml；必须只按 profile 特征文件识别，避免误读/误改。
const PROFILE_IGNORED_DIRECTORIES = new Set(['node_modules', '.git', '.pnpm', '.cache', '.tmp'])
const PROFILE_MARKER_FILES = new Set(['cordis.yml', 'cordis.patch.yml', 'package.json'])
// `*.bak-*`、`*.next-*`、`*.imported` 等都不是生效层，绝不读写。
const IGNORED_CONFIG_FILE_PATTERN = /(?:^|[._-])(?:bak|next|imported|tmp|old|orig|swp)(?:[._-]|$)/i
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

/** 判断一个模型条目的 `input` 值（YAML 节点或普通数组）是否已声明 image。 */
function inputDeclaresImage(value) {
  return Array.isArray(value) && value.includes('image')
}

function plainYamlValue(value) {
  return typeof value?.toJSON === 'function' ? value.toJSON() : value
}

function cleanRecord(value, allowKey = () => true) {
  const plain = plainYamlValue(value)
  if (!plain || typeof plain !== 'object' || Array.isArray(plain)) return {}
  return Object.fromEntries(Object.entries(plain).filter(([key]) => !YAML_NODE_INTERNAL_KEYS.has(key) && allowKey(key)))
}

function scalarString(node) {
  if (node === undefined || node === null) return undefined
  const value = typeof node?.toJSON === 'function' ? node.toJSON() : node
  return typeof value === 'string' ? value : undefined
}

function modelIdOf(item) {
  return isMap(item) ? scalarString(item.get('id', true)) : undefined
}

function isIgnoredConfigurationFile(name) {
  return IGNORED_CONFIG_FILE_PATTERN.test(name)
}

// ---------------------------------------------------------------------------
// 文本级保真写入
//
// `document.toString()` 会重新序列化整个文档：行尾注释前的对齐空格会被折叠
// （`dark   # c` → `dark # c`）、flow 集合会被加 padding（`[text]` → `[ text ]`）。
// 因此“给模型条目追加键块”这类纯新增操作改为按行插入原始文本，只在确有需要时
// 才回退到整文档序列化（回退时用 flowCollectionPadding:false 减少改写）。
// 回退只会发生在“某个已存在的键需要就地修正”这种形态（例如 compat 已存在但要
// 合并 thinkingFormat，或 input 已声明 `[text]` 的 verified 模型需要升级）——
// 真实配置与冻结夹具都不会走到回退分支。
// ---------------------------------------------------------------------------

function lineStartOffset(text, offset) {
  return text.lastIndexOf('\n', offset - 1) + 1
}

function lineEndOffset(text, offset) {
  const index = text.indexOf('\n', offset)
  return index < 0 ? text.length : index
}

/**
 * 计算 YAML 节点所在条目的键块插入位置。
 * `contentIndent` 是条目键所在的列（`- ` 之后），`insertionOffset` 是条目最后
 * 一个内容行的行尾（不含换行）；新键块应插在该偏移之后。
 */
function blockInsertionPoint(text, item) {
  const range = item?.range
  // yaml 的 range 是 [start, valueEnd, nodeEnd]，但 valueEnd 会落在“下一行”
  // 的行首（条目后紧跟注释时尤其明显）。这里只用 range[0] 定位条目首行，然后
  // 逐行向下扫描整个条目块，取最后一个属于该条目的内容行行尾作为插入点。
  if (!Array.isArray(range) || range.length < 1) return undefined
  const start = range[0]
  const head = text.slice(lineStartOffset(text, start), start)
  if (/\t/.test(head)) return undefined
  let contentIndent
  if (/^ *- $/.test(head) || /^ *$/.test(head)) contentIndent = head.length
  else return undefined

  let insertionOffset = lineEndOffset(text, start)
  let cursor = insertionOffset >= text.length ? text.length : insertionOffset + 1
  while (cursor < text.length) {
    const lineEnd = lineEndOffset(text, cursor)
    const line = text.slice(cursor, lineEnd)
    if (/\t/.test(line)) return undefined
    const indent = (line.match(/^ */) ?? [''])[0].length
    if (line.trim() === '') {
      cursor = lineEnd + 1
      continue
    }
    if (indent < contentIndent) break
    if (indent <= contentIndent - 2 && /^ *- /.test(line)) break
    // 该行仍属于当前条目（键、续行、块集合内容或条目内注释）。
    insertionOffset = lineEnd
    cursor = lineEnd + 1
  }
  return { contentIndent, insertionOffset }
}

/** 按条目缩进生成要插入的键块文本（以换行开头，不加尾随换行）。 */
function buildKeyBlocks(contentIndent, blocks) {
  const indent = ' '.repeat(contentIndent)
  const lines = []
  for (const block of blocks) for (const line of block) lines.push(indent + line)
  return `\n${lines.join('\n')}`
}

/** 应用一组 { offset, text } 插入编辑；按偏移降序处理，互不影响。 */
function applyTextEdits(text, edits) {
  let next = text
  for (const edit of [...edits].sort((left, right) => right.offset - left.offset)) {
    next = next.slice(0, edit.offset) + edit.text + next.slice(edit.offset)
  }
  return next
}

/** 重新解析后确认目标模型都已声明 image（写入前的安全网）。 */
function declarationsPresent(text, targets) {
  const document = parseDocument(text, { uniqueKeys: false })
  if (Array.isArray(document.errors) && document.errors.length > 0) return false
  const index = new Map()
  for (const { provider, profileNode } of collectLlmPiAiProviders(document)) {
    const models = profileNode.get('models', true)
    if (!isSeq(models)) continue
    for (const item of models.items ?? []) {
      const model = modelIdOf(item)
      if (model === undefined) continue
      index.set(`${provider}\u0000${model}`, inputDeclaresImage(plainYamlValue(item.get('input'))))
    }
  }
  return targets.every(target => index.get(`${target.provider}\u0000${target.model}`) === true)
}

/** 重新解析后确认条目的 input / reasoningEfforts / compat 都已满足 compatibility。 */
function compatibilityPresent(text, provider, model, compatibility) {
  const document = parseDocument(text, { uniqueKeys: false })
  if (Array.isArray(document.errors) && document.errors.length > 0) return false
  for (const { provider: owner, profileNode } of collectLlmPiAiProviders(document)) {
    if (owner !== provider) continue
    const models = profileNode.get('models', true)
    if (!isSeq(models)) continue
    const item = (models.items ?? []).find(candidate => modelIdOf(candidate) === model)
    if (item === undefined) continue
    const plan = modelCompatibilityPlan(item, compatibility)
    return !plan.input && !plan.reasoningEfforts && !plan.compat
  }
  return false
}

/** 去重（同一模型可能同时出现在 settings.yaml 与 patch 层），保留最高优先级源的标签。 */
function dedupeModels(models) {
  const index = new Map()
  for (const model of models) {
    index.set(`${model.provider}\u0000${model.model}`, {
      provider: model.provider,
      model: model.model,
      source: model.source,
    })
  }
  return [...index.values()].sort((left, right) => `${left.provider}/${left.model}`.localeCompare(`${right.provider}/${right.model}`))
}

/**
 * 从一棵已解析的配置文档里收集 `llm-pi-ai` 插件条目下的 provider 节点。
 * 同时兼容三种形态：
 *   - patch 层顶层数组 `[{ id: 'llm-pi-ai', config: { providers } }]`
 *   - patch 层的 insert 列表 `[{ insert: [{ id: 'llm-pi-ai', ... }] }]`
 *   - settings.yaml 的 `llm-pi-ai: { providers }`
 * 同文件里出现多个 llm-pi-ai 条目时按文档顺序返回，调用方可自行决定覆盖顺序。
 */
function collectLlmPiAiProviders(document) {
  const entries = []
  // loader 会跳过 `disabled: true`（cordis-plugin-loader）或 `enabled: false` 的条目；
  // 给它们补声明没有运行收益，而且会产生无意义 diff。`disabled` 若是 `!!js`
  // 表达式（静态求值不了）则保守地按“未禁用”处理。
  const isDisabled = node => plainYamlValue(node.get('disabled', true)) === true
    || plainYamlValue(node.get('enabled', true)) === false
  const collectConfig = configNode => {
    if (!isMap(configNode)) return
    const providers = configNode.get('providers', true)
    if (!isMap(providers)) return
    for (const pair of providers.items ?? []) {
      const provider = scalarString(pair?.key)
      if (provider === undefined || !isMap(pair.value)) continue
      entries.push({ provider, profileNode: pair.value })
    }
  }
  const visitEntry = node => {
    if (!isMap(node)) return
    if (scalarString(node.get('id', true)) === LLM_PI_AI_PLUGIN_ID) {
      if (isDisabled(node)) return
      collectConfig(node.get('config', true))
      return
    }
    const insert = node.get('insert', true)
    if (isSeq(insert)) for (const child of insert.items ?? []) visitEntry(child)
  }

  const root = document?.contents
  if (isMap(root)) {
    const plugin = root.get(LLM_PI_AI_PLUGIN_ID, true)
    if (isMap(plugin)) {
      const config = plugin.get('config', true)
      const target = isMap(config) ? config : plugin
      if (!isDisabled(plugin) && !isDisabled(target)) collectConfig(target)
    }
  } else if (isSeq(root)) {
    for (const item of root.items ?? []) visitEntry(item)
  }
  return entries
}

/**
 * 判断一个模型条目需要哪些 compatibility 修正。
 * 返回 { input, reasoningEfforts, compat } 三个布尔标记；reasoningEfforts 为真时
 * 附带 reasoningEffortsBlock（declaredEfforts / hasThinkingEffort）供写入方复用。
 */
function modelCompatibilityPlan(item, compatibility = {}) {
  const plan = { input: false, reasoningEfforts: false, compat: false, reasoningEffortsBlock: undefined }
  const current = plainYamlValue(item.get('input'))
  if (!Array.isArray(current) || !current.includes('image')) plan.input = true
  if (compatibility.thinkingFormat === 'deepseek') {
    const currentEfforts = item.get('reasoningEfforts')
    const declaredEfforts = cleanRecord(currentEfforts, key => THINKING_LEVELS.has(key))
    const hasThinkingEffort = Object.keys(declaredEfforts).some(level => level !== 'off')
    const effortsWereSanitized = Object.keys(plainYamlValue(currentEfforts) ?? {}).length !== Object.keys(declaredEfforts).length
    if (!Object.hasOwn(declaredEfforts, 'off') || declaredEfforts.off !== null || !hasThinkingEffort || effortsWereSanitized) {
      plan.reasoningEfforts = true
      plan.reasoningEffortsBlock = { declaredEfforts, hasThinkingEffort }
    }
    const currentCompatNode = item.get('compat')
    const currentCompat = cleanRecord(currentCompatNode)
    const compatWasSanitized = Object.keys(plainYamlValue(currentCompatNode) ?? {}).length !== Object.keys(currentCompat).length
    if (currentCompat.thinkingFormat !== 'deepseek' || compatWasSanitized) plan.compat = true
  }
  return plan
}

/**
 * 对单个模型条目应用「声明可读图片」以及 thinkingFormat=deepseek 的修正。
 * 返回是否发生了修改。（整文档序列化回退路径使用。）
 */
function applyModelCompatibility(item, compatibility = {}) {
  const plan = modelCompatibilityPlan(item, compatibility)
  if (!plan.input && !plan.reasoningEfforts && !plan.compat) return false
  if (plan.input) item.set('input', ['text', 'image'])
  if (plan.reasoningEfforts) {
    // Harness rejects an effort map that offers only `off`. A valueless off
    // plus one real level resolves to reasoning=true while leaving `off`
    // absent from pi-ai's wire map, which makes the DeepSeek dialect send
    // the provider's explicit `thinking: { type: "disabled" }` request.
    const { declaredEfforts, hasThinkingEffort } = plan.reasoningEffortsBlock
    item.set('reasoningEfforts', {
      ...declaredEfforts,
      off: null,
      ...(hasThinkingEffort ? {} : { high: 'high' }),
    })
  }
  if (plan.compat) {
    const currentCompat = cleanRecord(item.get('compat'))
    item.set('compat', { ...currentCompat, thinkingFormat: 'deepseek' })
  }
  return true
}

/**
 * 把 compatibility 计划转成“追加缺失键块”的文本编辑。
 * 只要有一个待设置键在条目里已存在（需要就地修正），就返回 undefined 让调用方
 * 回退到整文档序列化，避免用行编辑处理复杂的合并语义。
 */
function planCompatibilityAppends(text, item, plan) {
  const blocks = []
  if (plan.input) {
    if (item.get('input', true) !== undefined) return undefined
    blocks.push(IMAGE_INPUT_BLOCK)
  }
  if (plan.reasoningEfforts) {
    if (item.get('reasoningEfforts', true) !== undefined) return undefined
    const { hasThinkingEffort } = plan.reasoningEffortsBlock
    // 键缺失时 declaredEfforts 必为空，此时需要 off:null + 一个真实 level。
    blocks.push(['reasoningEfforts:', '  off: null', ...(hasThinkingEffort ? [] : ['  high: high'])])
  }
  if (plan.compat) {
    if (item.get('compat', true) !== undefined) return undefined
    blocks.push(DEEPSEEK_COMPAT_BLOCK)
  }
  if (blocks.length === 0) return { changed: false, edits: [] }
  const point = blockInsertionPoint(text, item)
  if (point === undefined) return undefined
  return {
    changed: true,
    edits: [{ offset: point.insertionOffset, text: buildKeyBlocks(point.contentIndent, blocks) }],
  }
}

export function stripThinkingTags(value) {
  return String(value ?? '')
    .replace(/ thinking[\s\S]*?<\/think>/gi, '')
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
    this.watchedDirectories = new Set()
    this.initialReapplyTimer = undefined
    this.reapplyTimer = undefined
    // 最近一次扫描到的配置源与图片兼容覆盖视图，供 publicStatus() 展示。
    this.configurationSourceCache = []
    this.optimisticDeclarations = []
    this.optimisticApplied = []
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
    await this.applyOptimisticImageDeclarations()
    await this.reapplyVerifiedModels()
    await this.harmonizeImageReaderSkill()
    await this.harmonizeGlobalInstructions()
    // P5：等 watcher 挂载完成再返回，避免调用方紧接着改配置时丢事件。
    await this.startSettingsWatcher()
  }

  dispose() {
    this.watcherAbort?.abort()
    this.watcherAbort = undefined
    this.watchedDirectories = new Set()
    if (this.reapplyTimer !== undefined) clearTimeout(this.reapplyTimer)
    this.reapplyTimer = undefined
    if (this.initialReapplyTimer !== undefined) clearTimeout(this.initialReapplyTimer)
    this.initialReapplyTimer = undefined
  }

  // --- 配置源 ---------------------------------------------------------------

  async profileDirectories() {
    const profilesRoot = join(this.harnessHome, 'profiles')
    let entries
    try {
      entries = await readdir(profilesRoot, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return []
      throw error
    }
    const directories = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      if (PROFILE_IGNORED_DIRECTORIES.has(entry.name)) continue
      const directory = join(profilesRoot, entry.name)
      let files
      try {
        files = await readdir(directory)
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue
        throw error
      }
      // 真实 profile 至少带 cordis.yml / cordis.patch.yml / package.json；
      // 依赖目录即使含 patch 文件也不会被当成配置源。
      if (files.some(name => PROFILE_MARKER_FILES.has(name) || PATCH_FILE_PATTERN.test(name))) {
        directories.push(directory)
      }
    }
    return directories.sort()
  }

  async patchFilesIn(directory) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return []
      throw error
    }
    return entries
      .filter(entry => !entry.name.startsWith('.'))
      .filter(entry => entry.isFile() || entry.isSymbolicLink())
      .filter(entry => PATCH_FILE_PATTERN.test(entry.name) && !isIgnoredConfigurationFile(entry.name))
      .map(entry => join(directory, entry.name))
      .sort()
  }

  /**
   * 生效顺序（数组末尾优先级最高，与 Harness 的层叠顺序一致）：
   *   settings.yaml → profiles/<profile>/*.patch.yml → $DSH_HOME/cordis.patch.yml
   * 只返回真实存在的文件。
   */
  async configurationSources() {
    const candidates = []
    const add = (kind, path, profile) => {
      if (candidates.some(candidate => candidate.path === path)) return
      candidates.push({
        kind,
        path,
        label: relative(this.harnessHome, path) || path,
        // preload.cjs 用 `item.profile ?? item.kind ?? item.path` 展示来源，
        // profile 层给出 profile 名（web/headless），机器级层给出 machine。
        ...(profile === undefined ? {} : { profile }),
      })
    }

    add('settings', this.settingsPath)
    for (const directory of await this.profileDirectories()) {
      const profile = basename(directory)
      for (const file of await this.patchFilesIn(directory)) add('patch', file, profile)
    }
    add('patch', join(this.harnessHome, 'cordis.patch.yml'), 'machine')

    const sources = []
    for (const candidate of candidates) {
      try {
        const info = await stat(candidate.path)
        if (info.isFile()) sources.push(candidate)
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          this.logger.warn(`Unable to inspect Harness configuration source ${candidate.path}: ${safeMessage(error)}`)
        }
      }
    }
    this.configurationSourceCache = sources
    return sources
  }

  /** 读取并解析一个配置源；ENOENT 时返回 undefined。 */
  async documentFor(source) {
    let text
    try {
      text = await readFile(source.path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
    const document = parseDocument(text, { uniqueKeys: false })
    return { text, document }
  }

  /**
   * 原子写：`.next-<pid>-<uuid>` → rename，权限 0o600。
   *
   * 自写回环防护说明：这里不记录“刚写入的内容”，而是依赖 updateSource() 的
   * 幂等性——watcher 被自己的写入唤醒后重新解析文件，发现已无待补声明即不再
   * 写入，事件流随之收敛。记录内容哈希会让同一轮内的后续合法修改（例如补完
   * input 后 registry 重应用还要加 compat）被误判为“已处理”而跳过。
   */
  async writeSourceAtomically(path, content) {
    const next = `${path}.next-${process.pid}-${randomUUID()}`
    await mkdir(dirname(path), { recursive: true })
    await writeFile(next, content, { mode: 0o600 })
    await rename(next, path)
  }

  /**
   * 读源 → 交给 mutate 原地改 yaml 节点 → 只在确有变化时原子写回。
   * 保留注释、键顺序与其它插件配置；重复运行不产生写入（幂等）。
   */
  /**
   * 读源 → 交给 mutate 原地改 yaml 节点或返回文本级编辑结果 → 只在确有变化时
   * 原子写回。mutate 返回：
   *   - { changed: false }                         无变化
   *   - { changed: true, text }                    文本级保真写入（只插入必要行）
   *   - { changed: true, serialized: true }        回退：用 document.toString() 序列化
   * 可选 coverage 字段用于统计“图片兼容覆盖视图”。
   */
  async updateSource(source, mutate) {
    const loaded = await this.documentFor(source)
    if (loaded === undefined) return { status: 'missing', changed: false }
    const { text, document } = loaded
    if (Array.isArray(document.errors) && document.errors.length > 0) {
      this.logger.warn(`Unable to update Harness configuration source ${source.path}: ${document.errors[0]?.message ?? 'YAML parse error'}`)
      return { status: 'invalid', changed: false }
    }
    const outcome = mutate(document, source, text) ?? { changed: false }
    const coverage = outcome.coverage
    if (outcome.changed !== true) return { status: 'unchanged', changed: false, coverage }
    const next = typeof outcome.text === 'string'
      ? outcome.text
      // flowCollectionPadding:false 让 `[text]` 不被写成 `[ text ]`。
      : document.toString({ flowCollectionPadding: false })
    if (next === text) return { status: 'unchanged', changed: false, coverage }
    if (typeof outcome.text === 'string') {
      // 行编辑的安全网：写盘前重新解析，确保没有破坏 YAML 结构。
      const check = parseDocument(next, { uniqueKeys: false })
      if (Array.isArray(check.errors) && check.errors.length > 0) {
        this.logger.warn(`Refusing to write invalid YAML to ${source.path}: ${check.errors[0]?.message ?? 'parse error'}`)
        return { status: 'invalid-result', changed: false, coverage }
      }
    }
    await this.writeSourceAtomically(source.path, next)
    return { status: 'written', changed: true, records: outcome.records ?? [], coverage }
  }

  // --- watcher --------------------------------------------------------------

  async watchDirectories() {
    const directories = new Set([this.harnessHome, join(this.harnessHome, 'profiles')])
    for (const directory of await this.profileDirectories()) directories.add(directory)
    return [...directories]
  }

  async startSettingsWatcher() {
    this.watcherAbort?.abort()
    const abort = new AbortController()
    this.watcherAbort = abort
    this.watchedDirectories = new Set()
    try {
      // 等目录枚举与 fs.watch 注册完成再返回：initialize() 的调用方常常紧接着
      // 修改配置（GUI 设置页保存、脚本补写），fire-and-forget 会留下丢事件窗口。
      await this.refreshWatchers()
    } catch (error) {
      // watcher 挂载失败不能影响 initialize() 的既有语义。
      this.logger.warn(`Unable to enumerate Harness configuration sources: ${safeMessage(error)}`)
    }
    // 兜底：部分文件系统（macOS FSEvents）在 fs.watch 刚注册的极短窗口内可能
    // 合并/丢弃事件。启动后延迟重应用一次，确保 initialize() 返回后紧接着的
    // 配置改动一定会被处理；之后的事件由 watcher 正常驱动。
    if (this.initialReapplyTimer !== undefined) clearTimeout(this.initialReapplyTimer)
    this.initialReapplyTimer = setTimeout(() => {
      this.initialReapplyTimer = undefined
      void this.reapplyConfiguration()
    }, 250)
  }

  /**
   * 枚举并补挂所有配置源目录的 watcher。每次重应用前都会调用，因此启动后新建
   * 的 profile 目录（及其后续修改）也会被监听，而不只是首次枚举到的目录。
   * 返回时每个新目录的 fs.watch 都已注册完成（startWatcher 同步注册）。
   */
  async refreshWatchers() {
    const abort = this.watcherAbort
    if (abort === undefined || abort.signal.aborted) return
    const directories = await this.watchDirectories()
    const mounted = []
    for (const directory of directories) {
      if (this.watchedDirectories.has(directory)) continue
      this.watchedDirectories.add(directory)
      mounted.push(this.startWatcher(directory, abort))
    }
    await Promise.all(mounted)
  }

  /**
   * 启动一个目录的长驻 watcher。这里用 `node:fs` 的同步 `watch()`：它返回时
   * FSWatcher 已经注册，因此 `refreshWatchers()`/`initialize()` 返回后立刻修改
   * 配置也不会丢事件（fs/promises 的 async generator 要等下一次 next() 才注册）。
   */
  startWatcher(directory, abort) {
    let watcher
    try {
      watcher = watchCallback(directory, { persistent: false }, () => this.scheduleReapply())
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger.warn(`Unable to watch Harness configuration directory ${directory}: ${safeMessage(error)}`)
      }
      this.watchedDirectories.delete(directory)
      return Promise.resolve()
    }
    const close = () => {
      try {
        watcher.close()
      } catch {
        // watcher 已经关闭。
      }
    }
    if (abort.signal.aborted) close()
    else abort.signal.addEventListener('abort', close, { once: true })
    watcher.on('error', error => {
      if (error?.code !== 'ENOENT' && error?.name !== 'AbortError') {
        this.logger.warn(`Unable to watch Harness configuration directory ${directory}: ${safeMessage(error)}`)
      }
      this.watchedDirectories.delete(directory)
    })
    watcher.on('close', () => {
      abort.signal.removeEventListener('abort', close)
      this.watchedDirectories.delete(directory)
    })
    return Promise.resolve()
  }

  scheduleReapply() {
    if (this.reapplyTimer !== undefined) clearTimeout(this.reapplyTimer)
    this.reapplyTimer = setTimeout(() => {
      this.reapplyTimer = undefined
      void this.reapplyConfiguration()
    }, 350)
  }

  async reapplyConfiguration() {
    try {
      await this.refreshWatchers()
      await this.applyOptimisticImageDeclarations()
      await this.reapplyVerifiedModels()
    } catch (error) {
      this.logger.warn(`Unable to restore vision declarations: ${safeMessage(error)}`)
    }
    void this.harmonizeImageReaderSkill().catch(error => {
      this.logger.warn(`Unable to harmonize image-reader skill: ${safeMessage(error)}`)
    })
    void this.harmonizeGlobalInstructions().catch(error => {
      this.logger.warn(`Unable to harmonize global vision instructions: ${safeMessage(error)}`)
    })
  }

  // --- 状态 -----------------------------------------------------------------

  publicStatus() {
    const models = Object.values(this.registry.models)
      .filter(entry => entry?.verified === true)
      .map(({ provider, model, verifiedAt, source }) => ({ provider, model, verifiedAt, source }))
      .sort((left, right) => `${left.provider}/${left.model}`.localeCompare(`${right.provider}/${right.model}`))
    // optimisticModels 是“当前图片兼容覆盖视图”：白名单 provider 下所有声明含
    // image 的模型（含用户显式声明的），不随运行次数变化；本次运行新写入的数量
    // 放在 optimistic.applied 里，避免重启后卡片显示 0 造成误导。
    const optimisticModels = this.optimisticDeclarations.map(({ provider, model, source }) => ({ provider, model, source }))
    return {
      mode: 'optimistic-native-with-fallback',
      policy: 'Models without an explicit input declaration are allowed to try images; explicit text-only declarations remain unchanged.',
      models,
      // 以下字段是附加信息（preload 仍只读 models），用于展示图片兼容覆盖情况。
      sources: this.configurationSourceCache.map(({ kind, label, path, profile }) => ({
        kind,
        label,
        path,
        ...(profile === undefined ? {} : { profile }),
      })),
      optimisticModels,
      optimistic: {
        count: optimisticModels.length,
        models: optimisticModels,
        applied: (this.optimisticApplied ?? []).length,
      },
    }
  }

  isVerified(provider, model) {
    return this.registry.models[registryKey(provider, model)]?.verified === true
  }

  /**
   * 读取旧版单文件配置（settings.yaml）。仅用于兼容历史调用方；
   * 旧版层不存在时返回 undefined 而不是抛 ENOENT（2026-10 真机已无 settings.yaml，
   * 抛 ENOENT 曾让桥接回退整体失败）。路由解析请使用 resolveRoute()。
   */
  async readSettings() {
    let source
    try {
      source = await readFile(this.settingsPath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
    return { source, value: parse(source) }
  }

  // --- 路由解析 -------------------------------------------------------------

  /**
   * 从同一批配置源解析 route，保证「声明判断」与「视觉桥接」看到同一份配置。
   * 低优先级层（settings.yaml）先落，高优先级层（profile/machine patch）覆盖。
   */
  async resolveRoute(provider, model) {
    const sources = await this.configurationSources()
    const layers = []
    let entry
    for (const source of sources) {
      const loaded = await this.documentFor(source)
      if (loaded === undefined) continue
      const { document } = loaded
      for (const candidate of collectLlmPiAiProviders(document)) {
        if (candidate.provider !== provider) continue
        layers.push(cleanRecord(candidate.profileNode))
        const models = candidate.profileNode.get('models', true)
        if (!isSeq(models)) continue
        const item = (models.items ?? []).find(candidateItem => modelIdOf(candidateItem) === model)
        if (item !== undefined) entry = cleanRecord(item)
      }
    }
    if (layers.length === 0) return undefined
    return { provider, model, profile: Object.assign({}, ...layers), entry }
  }

  async routeDeclaresImage(provider, model) {
    const route = await this.resolveRoute(provider, model)
    return route !== undefined && modelInputHasImage(route.entry)
  }

  // --- 乐观声明 -------------------------------------------------------------

  /**
   * 对所有生效配置源里、api 命中白名单的 provider 下「没有 input 键」的模型补
   * `input: [text, image]`；显式写了 input 的条目（包括 `input: [text]`）一律不动。
   *
   * 写入走文本级保真路径（只在模型条目末尾插入 input 块），因此行尾注释对齐与
   * flow 集合写法不会被 yaml 序列化改写；只有遇到“某个键已存在但需要就地修正”
   * 的罕见形态才回退到整文档序列化。
   */
  async applyOptimisticImageDeclarations() {
    const sources = await this.configurationSources()
    const applied = []
    let changed = false
    for (const source of sources) {
      const result = await this.updateSource(source, (document, _source, text) => {
        const pending = []
        for (const { provider, profileNode } of collectLlmPiAiProviders(document)) {
          if (!OPTIMISTIC_IMAGE_APIS.has(scalarString(profileNode.get('api', true)))) continue
          const models = profileNode.get('models', true)
          if (!isSeq(models)) continue
          for (const item of models.items ?? []) {
            const model = modelIdOf(item)
            if (model === undefined) continue
            // Harness treats an omitted input declaration as text-only. For an
            // OpenAI-compatible gateway that produces false negatives because the
            // gateway, not its model catalogue, is the source of truth. Preserve
            // every explicit declaration and only make unknown entries permissive.
            if (item.get('input', true) !== undefined) continue
            pending.push({ provider, model, item })
          }
        }
        if (pending.length === 0) return { changed: false }
        const records = pending.map(({ provider, model }) => ({ provider, model, source: source.label }))
        const edits = []
        for (const target of pending) {
          const point = blockInsertionPoint(text, target.item)
          if (point === undefined) {
            edits.length = 0
            break
          }
          edits.push({ offset: point.insertionOffset, text: buildKeyBlocks(point.contentIndent, [IMAGE_INPUT_BLOCK]) })
        }
        if (edits.length === pending.length) {
          const next = applyTextEdits(text, edits)
          if (declarationsPresent(next, pending)) return { changed: true, text: next, records }
        }
        // 回退：节点级修改 + 整文档序列化（flowCollectionPadding:false）。
        for (const target of pending) target.item.set('input', ['text', 'image'])
        return { changed: true, serialized: true, records }
      })
      if (result.status === 'written') {
        changed = true
        applied.push(...(result.records ?? []))
      }
    }
    this.optimisticApplied = dedupeModels(applied)
    // optimisticModels 是稳定的“当前覆盖视图”，不随运行次数变化。
    await this.refreshOptimisticCoverage()
    return changed
  }

  /** 重新扫描当前配置，统计白名单 provider 下所有声明含 image 的模型。 */
  async refreshOptimisticCoverage() {
    const coverage = []
    for (const source of await this.configurationSources()) {
      const loaded = await this.documentFor(source)
      if (loaded === undefined) continue
      for (const { provider, profileNode } of collectLlmPiAiProviders(loaded.document)) {
        if (!OPTIMISTIC_IMAGE_APIS.has(scalarString(profileNode.get('api', true)))) continue
        const models = profileNode.get('models', true)
        if (!isSeq(models)) continue
        for (const item of models.items ?? []) {
          const model = modelIdOf(item)
          if (model === undefined) continue
          if (inputDeclaresImage(plainYamlValue(item.get('input')))) coverage.push({ provider, model, source: source.label })
        }
      }
    }
    this.optimisticDeclarations = dedupeModels(coverage)
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

  // --- verified registry 重应用 ---------------------------------------------

  /** 在其出现的每个配置源里补齐 image 声明与 thinkingFormat 修正。 */
  async applyModelDeclaration(provider, model, compatibility = this.registry.models[registryKey(provider, model)] ?? {}) {
    const sources = await this.configurationSources()
    let matched = 0
    let changed = false
    for (const source of sources) {
      const result = await this.updateSource(source, (document, _source, text) => {
        const targets = []
        for (const candidate of collectLlmPiAiProviders(document)) {
          if (candidate.provider !== provider) continue
          const models = candidate.profileNode.get('models', true)
          if (!isSeq(models)) continue
          const item = (models.items ?? []).find(candidateItem => modelIdOf(candidateItem) === model)
          if (item !== undefined) targets.push(item)
        }
        if (targets.length === 0) return { changed: false }
        matched += targets.length
        const plans = targets.map(item => modelCompatibilityPlan(item, compatibility))
        if (plans.every(plan => !plan.input && !plan.reasoningEfforts && !plan.compat)) return { changed: false }
        // 优先文本级保真：所有待设置键都缺失时按行追加键块。
        const edits = []
        let textPlanned = true
        for (let index = 0; index < targets.length; index += 1) {
          const planned = planCompatibilityAppends(text, targets[index], plans[index])
          if (planned === undefined) {
            textPlanned = false
            break
          }
          edits.push(...planned.edits)
        }
        if (textPlanned) {
          const next = applyTextEdits(text, edits)
          if (compatibilityPresent(next, provider, model, compatibility)) return { changed: true, text: next }
        }
        // 回退：已有键需要就地修正（合并 compat / 升级 input 等），整文档序列化。
        let fallbackChanged = false
        for (const item of targets) if (applyModelCompatibility(item, compatibility)) fallbackChanged = true
        return { changed: fallbackChanged, serialized: true }
      })
      if (result.status === 'written') changed = true
    }
    if (matched === 0) {
      const error = new Error(`未找到模型配置：${provider}/${model}`)
      // 与旧实现保持一致：一个配置源都不存在时按 ENOENT 处理，避免 watcher
      // 每次重应用都刷出无意义的告警。
      if (sources.length === 0) error.code = 'ENOENT'
      throw error
    }
    return changed
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