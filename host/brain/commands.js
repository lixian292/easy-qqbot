/**
 * Chat command handler.
 *
 * Recognized commands are handled locally (no LLM call); unknown `#...` text is
 * passed through to the model so groups do not get false positives. Commands
 * accept the configured prefix plus the common `/` and `／` variants and are
 * case insensitive for Latin aliases.
 */
import { parseCommand } from '../util/text.js'
import { canSendToQQ } from '../output/media.js'
import { shortMessage } from '../output/errors.js'
import { canUseOutput, identityIdsOf, isAdmin } from './access.js'

const DEFAULT_PREFIX = '#'
const MAX_MEMORY_LINES = 10
const OUTPUT_LABELS = Object.freeze({ image: '图片', audio: '语音', video: '视频' })
const OUTPUT_USAGE = Object.freeze({
  image: '一只在窗台上晒太阳的橘猫，水彩风格',
  audio: '你好呀，今天也要开心。',
  video: '海边日落，镜头缓慢推进'
})

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * @param {{
 *   configStore: { get(): object },
 *   budgetStore?: object,
 *   memoryStore?: object,
 *   stickerStore?: object,
 *   stickerSelector?: object,
 *   logger?: object
 * }} deps
 */
export function createCommandHandler({ configStore, budgetStore, memoryStore, stickerStore, stickerSelector, outputClient, logger } = {}) {
  function readConfig() {
    try {
      const config = configStore?.get?.() ?? {}
      return isPlainObject(config) ? config : {}
    } catch (error) {
      logger?.warn?.('读取命令配置失败，使用默认值', { error: error?.message })
      return {}
    }
  }

  function prefixesOf(config) {
    const configured = typeof config.commands?.prefix === 'string' && config.commands.prefix !== '' ? config.commands.prefix : DEFAULT_PREFIX
    return [...new Set([configured, DEFAULT_PREFIX, '/', '／'])]
  }

  function primaryPrefix(config) {
    return typeof config.commands?.prefix === 'string' && config.commands.prefix !== '' ? config.commands.prefix : DEFAULT_PREFIX
  }

  function formatTokens(value) {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < 0) return '0'
    return Math.round(parsed).toLocaleString('en-US')
  }

  function formatCost(value, currency) {
    const parsed = Number(value)
    const amount = Number.isFinite(parsed) && parsed > 0 ? parsed : 0
    const text = amount >= 1 ? amount.toFixed(2) : amount.toFixed(4)
    return `${text} ${currency || 'CNY'}`
  }

  function helpText(prefix, config) {
    const lines = [
      '可用命令：',
      `${prefix}帮助 — 查看命令列表`,
      `${prefix}预算 — 查看今日 / 本月 / 本会话的用量和费用`,
      `${prefix}表情 <标签…> — 随机发一张标签匹配的表情包`,
      `${prefix}记忆 — 查看本会话记住的长期事实`,
      `${prefix}清空上下文 — 清空本会话的聊天上下文（长期记忆保留）`,
      `${prefix}我的id — 查看当前账号的 openid / union_openid（用于管理员配置）`
    ]
    const output = isPlainObject(config?.output) ? config.output : {}
    if (output.enabled === true) {
      const suffix = output.commandAccess === 'admin' ? '（管理员）' : ''
      lines.push(`${prefix}画 <描述> — 生成一张图片${suffix}`)
      lines.push(`${prefix}语音 <文本> — 生成一段语音${suffix}`)
      lines.push(`${prefix}视频 <描述> — 生成一段视频${suffix}`)
    }
    lines.push(
      '管理员命令：',
      `${prefix}状态 — 查看预算、会话与表情包概况`,
      `${prefix}表情包统计 — 查看各图层的表情包数量与热门标签`
    )
    return lines.join('\n')
  }

  async function budgetText(inbound, config) {
    if (typeof budgetStore?.snapshot !== 'function') return '预算功能暂时不可用。'
    let snapshot
    try {
      snapshot = await budgetStore.snapshot()
    } catch (error) {
      logger?.warn?.('#预算 读取失败', { error: error?.message })
      return '读取预算失败了，稍后再试试。'
    }
    const currency = snapshot?.currency ?? config.budget?.currency ?? 'CNY'
    const chatId = String(inbound?.chatId ?? '')
    const chatUsage = (Array.isArray(snapshot?.chats) ? snapshot.chats : []).find((item) => item.chatId === chatId) ?? {
      calls: 0,
      totalTokens: 0,
      cost: 0
    }
    const today = snapshot?.today ?? {}
    const month = snapshot?.month ?? {}
    return [
      `今日：${formatTokens(today.totalTokens)} tokens，${Number(today.calls) || 0} 次调用，费用 ${formatCost(today.cost, currency)}`,
      `本月：${formatTokens(month.totalTokens)} tokens，${Number(month.calls) || 0} 次调用，费用 ${formatCost(month.cost, currency)}`,
      `本会话：${formatTokens(chatUsage.totalTokens)} tokens，${Number(chatUsage.calls) || 0} 次调用，费用 ${formatCost(chatUsage.cost, currency)}`
    ].join('\n')
  }

  async function stickerCommand(command, config) {
    const prefix = primaryPrefix(config)
    const tags = String(command.args ?? '')
      .split(/[,，、;；|/\s]+/)
      .map((tag) => tag.trim())
      .filter((tag) => tag !== '')
      .slice(0, 8)
    if (tags.length === 0) {
      return { handled: true, text: `用法：${prefix}表情 标签1 标签2（标签来自表情包库）` }
    }
    let sticker = null
    try {
      if (typeof stickerSelector?.pickForReply === 'function') sticker = await stickerSelector.pickForReply(tags)
      if (!sticker && typeof stickerStore?.pick === 'function') sticker = await stickerStore.pick({ tags })
    } catch (error) {
      logger?.warn?.('#表情 挑选失败', { tags, error: error?.message })
      sticker = null
    }
    if (!sticker) {
      return { handled: true, text: `没有找到和「${tags.join('、')}」匹配的表情包，先让我攒一些吧～` }
    }
    return { handled: true, sticker }
  }

  async function clearCommand(inbound) {
    if (typeof memoryStore?.clearChat !== 'function') return { handled: true, text: '上下文功能暂时不可用。' }
    const chatId = String(inbound?.chatId ?? '')
    if (chatId === '') return { handled: true, text: '没找到这个会话的信息。' }
    try {
      await memoryStore.clearChat(chatId, { keepFacts: true })
      return { handled: true, text: '已经把本会话的聊天上下文清空啦，长期记忆还保留着。' }
    } catch (error) {
      logger?.warn?.('#清空上下文 失败', { chatId, error: error?.message })
      return { handled: true, text: '清空上下文失败了，稍后再试试。' }
    }
  }

  async function memoryCommand(inbound) {
    if (typeof memoryStore?.getChat !== 'function') return { handled: true, text: '记忆功能暂时不可用。' }
    const chatId = String(inbound?.chatId ?? '')
    if (chatId === '') return { handled: true, text: '没找到这个会话的信息。' }
    let chat
    try {
      chat = await memoryStore.getChat(chatId)
    } catch (error) {
      logger?.warn?.('#记忆 读取失败', { chatId, error: error?.message })
      return { handled: true, text: '读取记忆失败了，稍后再试试。' }
    }
    const facts = (Array.isArray(chat?.facts) ? chat.facts : [])
      .map((fact) => (typeof fact === 'string' ? fact : String(fact?.text ?? '')))
      .map((fact) => fact.trim())
      .filter((fact) => fact !== '')
      .slice(-MAX_MEMORY_LINES)
    if (facts.length === 0) return { handled: true, text: '这个会话还没有记住什么长期信息。' }
    return { handled: true, text: `这个会话记住的长期信息：\n${facts.map((fact, index) => `${index + 1}. ${fact}`).join('\n')}` }
  }

  async function stickerStatsCommand(inbound, config) {
    if (!isAdmin(inbound, config)) return { handled: true, text: '这个命令只有管理员可以使用。' }
    if (typeof stickerStore?.stats !== 'function') return { handled: true, text: '表情包统计暂时不可用。' }
    let stats
    try {
      stats = await stickerStore.stats()
    } catch (error) {
      logger?.warn?.('#表情包统计 失败', { error: error?.message })
      return { handled: true, text: '读取表情包统计失败了，稍后再试试。' }
    }
    let catalog = null
    try {
      if (typeof stickerStore.catalog === 'function') catalog = await stickerStore.catalog({ maxTags: 10 })
    } catch (error) {
      logger?.warn?.('#表情包统计 标签读取失败', { error: error?.message })
    }
    const byLayer = isPlainObject(stats?.byLayer) ? stats.byLayer : {}
    const lines = [`表情包共 ${Number(stats?.total) || 0} 张：`]
    for (const layer of ['library', 'candidate', 'negative', 'trash']) {
      lines.push(`- ${layer}：${Number(byLayer[layer]) || 0} 张`)
    }
    const topTags = Array.isArray(catalog?.tags) ? catalog.tags.slice(0, 10) : []
    if (topTags.length === 0) lines.push('还没有标签数据。')
    else lines.push(`热门标签：${topTags.map((item) => `${item.tag}(${item.count})`).join('、')}`)
    return { handled: true, text: lines.join('\n') }
  }

  async function statusCommand(inbound, config) {
    if (!isAdmin(inbound, config)) return { handled: true, text: '这个命令只有管理员可以使用。' }
    const currency = config.budget?.currency ?? 'CNY'
    const lines = ['运行状态：']

    if (typeof budgetStore?.snapshot === 'function') {
      try {
        const snapshot = await budgetStore.snapshot()
        const today = snapshot?.today ?? {}
        const month = snapshot?.month ?? {}
        lines.push(`今日：${formatTokens(today.totalTokens)} tokens / ${Number(today.calls) || 0} 次，费用 ${formatCost(today.cost, currency)}`)
        lines.push(`本月：${formatTokens(month.totalTokens)} tokens / ${Number(month.calls) || 0} 次，费用 ${formatCost(month.cost, currency)}`)
        const limits = snapshot?.limits ?? {}
        lines.push(
          `限额：日 ${formatTokens(limits.dailyTokens)} / 月 ${formatTokens(limits.monthlyTokens)} / 单会话 ${formatTokens(limits.perChatDailyTokens)} tokens`
        )
      } catch (error) {
        logger?.warn?.('#状态 预算读取失败', { error: error?.message })
        lines.push('预算：读取失败')
      }
    }

    if (typeof memoryStore?.listChats === 'function') {
      try {
        const chats = await memoryStore.listChats()
        lines.push(`会话数：${Array.isArray(chats) ? chats.length : 0}`)
      } catch (error) {
        logger?.warn?.('#状态 会话读取失败', { error: error?.message })
      }
    }

    if (typeof stickerStore?.stats === 'function') {
      try {
        const stats = await stickerStore.stats()
        lines.push(`表情包：${Number(stats?.total) || 0} 张`)
      } catch (error) {
        logger?.warn?.('#状态 表情包读取失败', { error: error?.message })
      }
    }

    return { handled: true, text: lines.join('\n') }
  }

  function identityCommand(inbound, config) {
    const ids = identityIdsOf(inbound)
    const lines = ['当前账号标识：']
    if (inbound?.userId) lines.push(`user_openid / member_openid：${inbound.userId}`)
    if (inbound?.unionOpenId) lines.push(`union_openid：${inbound.unionOpenId}`)
    if (inbound?.memberOpenId && inbound.memberOpenId !== inbound.userId) lines.push(`member_openid：${inbound.memberOpenId}`)
    if (inbound?.authorId && inbound.authorId !== inbound.userId) lines.push(`author.id：${inbound.authorId}`)
    if (ids.length > 1) lines.push(`全部别名：${ids.join('、')}`)
    if (inbound?.memberRole) lines.push(`群角色：${inbound.memberRole}`)
    lines.push(`当前管理员判定：${isAdmin(inbound, config) ? '是' : '否'}`)
    lines.push('把以上任一 ID 填入控制台「配置 → 命令与管理员 → 管理员 openid」即可。')
    return { handled: true, text: lines.join('\n') }
  }

  function outputCommand(kind, args, inbound, config) {
    const label = OUTPUT_LABELS[kind]
    const output = isPlainObject(config.output) ? config.output : {}
    const section = isPlainObject(output[kind]) ? output[kind] : {}
    if (output.enabled !== true) {
      return { handled: true, text: '多模态输出还没有启用。管理员可以在控制台「多模态输出」页配置 API 后开启。' }
    }
    if (section.enabled !== true) {
      return { handled: true, text: `${label}输出还没有启用，请联系管理员在控制台「多模态输出」页开启。` }
    }
    if (!canUseOutput(inbound, config)) {
      return { handled: true, text: `这个命令目前仅管理员可用（生成${label}会调用第三方接口并产生费用）。` }
    }
    const prompt = String(args ?? '')
      .replace(/\s+/g, ' ')
      .trim()
    if (prompt === '') {
      return { handled: true, text: `用法：${primaryPrefix(config)}${kind === 'image' ? '画' : kind === 'audio' ? '语音' : '视频'} ${OUTPUT_USAGE[kind]}` }
    }
    if (section.baseUrl === '' || section.apiKey === '' || section.model === '') {
      return { handled: true, text: `${label}输出的接口配置还不完整（需要 baseUrl / apiKey / model），请管理员补全后再试。` }
    }
    if (typeof outputClient?.generate !== 'function') {
      return { handled: true, text: `${label}输出服务暂时不可用，请稍后再试。` }
    }
    const ack =
      kind === 'image'
        ? '收到，正在生成图片，稍等…'
        : kind === 'audio'
          ? '收到，正在生成语音，稍等…'
          : '收到，正在生成视频，可能需要几分钟…'
    const source = {
      kind: 'command',
      chatId: typeof inbound?.chatId === 'string' ? inbound.chatId : '',
      userId: typeof inbound?.userId === 'string' ? inbound.userId : '',
      userName: typeof inbound?.userName === 'string' ? inbound.userName : ''
    }
    return {
      handled: true,
      text: ack,
      followUp: async () => {
        try {
          const result = await outputClient.generate({ kind, prompt, source })
          const record = result?.record
          if (!record) return { text: `${label}生成失败：接口没有返回结果。` }
          const latest = readConfig()
          const latestOutput = isPlainObject(latest.output) ? latest.output : {}
          if (latestOutput.sendToQQ === false) {
            return { text: `${label}已生成，保存在控制台「多模态输出」作品库。` }
          }
          if (!canSendToQQ(kind, record.mime)) {
            return { text: `${label}已生成（${record.mime || '未知格式'}），该格式暂不支持直接发到 QQ，已保存到控制台作品库。` }
          }
          return { media: record }
        } catch (error) {
          logger?.warn?.(`#${kind} 生成失败`, { error: error?.message, code: error?.code })
          return { text: `${label}生成失败：${shortMessage(error?.message ?? String(error), 160)}` }
        }
      }
    }
  }

  async function handle(inbound) {
    const config = readConfig()
    if (config.commands?.enabled === false) return { handled: false }
    const text = String(inbound?.text ?? '').trim()
    if (text === '') return { handled: false }

    const prefixes = prefixesOf(config)
    const command = parseCommand(text, { prefixes })
    if (command === undefined) return { handled: false }

    switch (command.name) {
      case '帮助':
      case 'help':
        return { handled: true, text: helpText(primaryPrefix(config), config) }
      case '预算':
      case 'budget':
        return { handled: true, text: await budgetText(inbound, config) }
      case '表情':
      case 'sticker':
        return stickerCommand(command, config)
      case '清空上下文':
        return clearCommand(inbound)
      case '记忆':
        return memoryCommand(inbound)
      case '我的id':
      case '我的ID':
      case 'whoami':
      case 'id':
        return identityCommand(inbound, config)
      case '状态':
      case 'status':
        return statusCommand(inbound, config)
      case '表情包统计':
        return stickerStatsCommand(inbound, config)
      case '画':
      case '画画':
      case '画图':
      case '绘图':
      case 'image':
      case 'draw':
        return outputCommand('image', command.args, inbound, config)
      case '语音':
      case '说话':
      case 'tts':
      case 'voice':
        return outputCommand('audio', command.args, inbound, config)
      case '视频':
      case 'video':
        return outputCommand('video', command.args, inbound, config)
      default:
        // Unknown #commands are left for the model to answer (avoids eating
        // normal group chatter that happens to start with a prefix).
        return { handled: false }
    }
  }

  /** Recognize and execute one command; never throws. */
  async function tryHandle(inbound) {
    try {
      return await handle(inbound)
    } catch (error) {
      logger?.warn?.('命令处理失败', { text: inbound?.text, error: error?.message })
      return { handled: true, text: '命令执行出错了，稍后再试试。' }
    }
  }

  return { tryHandle }
}
