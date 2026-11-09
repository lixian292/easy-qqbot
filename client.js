/**
 * qqbot client half: adds a "QQ 机器人" entry to the Harness sidebar, an in-app
 * dashboard, and an in-app console panel that occupies the conversation area.
 * The console itself is the Host-served page mounted in an same-origin iframe;
 * its "退出工作台" button posts a message back to this panel, which returns to
 * the conversation without reloading the app.
 */
window.__ModuleLoader__.load({
  id: 'easy-qqbot',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'easy-qqbot'
    const PANEL_ID = 'qqbot'
    const CONSOLE_PANEL_ID = 'qqbot-console'
    const API_PATH = '/qqbot/api'
    const CONSOLE_PATH = '/qqbot/'
    const POLL_MS = 10000
    const EXIT_MESSAGE = 'qqbot-console-exit'

    const DICT = {
      zh: {
        'entry.title': 'QQ 机器人',
        'page.title': 'QQ 机器人',
        'page.subtitle': '预算 · 记忆 · 个性化 · 表情包',
        'page.back': '回到对话',
        'page.refresh': '刷新',
        'page.openConsole': '打开完整控制台',
        'page.loading': '正在读取 QQ 机器人状态…',
        'page.error': '读取失败',
        'page.retry': '重试',
        'page.offlineHint': '机器人尚未连接。请到完整控制台的「配置」页填写 AppID / AppSecret，或点击下方按钮重连。',
        'status.title': '运行状态',
        'status.qq': 'QQ 连接',
        'status.bot': '机器人',
        'status.llm': '对话模型',
        'status.budgetToday': '今日预算',
        'status.stickers': '表情包',
        'status.chats': '会话 / 人员',
        'status.dataDir': '数据目录',
        'status.online': '在线',
        'status.offline': '离线',
        'status.standby': '待配置',
        'status.connecting': '连接中',
        'action.start': '启动',
        'action.stop': '停止',
        'action.reconnect': '重连',
        'action.testQQ': '测试 QQ 凭证',
        'action.testLLM': '测试 LLM',
        'action.openConsole': '打开完整控制台',
        'action.testing': '测试中…',
        'result.qqOk': 'QQ 凭证有效',
        'result.llmOk': 'LLM 正常',
        'result.failed': '失败',
        'warnings.title': '配置提醒',
        'sticker.library': '正式库',
        'sticker.candidate': '候选',
        'tokens': 'tokens',
        'budgetUnlimited': '不限',
        'footer.version': '版本',
        'footer.hint': '完整控制台包含表情包打标、预算明细、会话记忆与日志。',
        'console.title': 'QQ 机器人控制台',
        'console.overview': '概览',
        'console.reload': '刷新页面',
        'console.external': '新窗口打开',
        'console.back': '← 返回会话'
      },
      en: {
        'entry.title': 'QQ Bot',
        'page.title': 'QQ Bot',
        'page.subtitle': 'Budget · Memory · Persona · Stickers',
        'page.back': 'Back to chat',
        'page.refresh': 'Refresh',
        'page.openConsole': 'Open full console',
        'page.loading': 'Reading QQ bot status…',
        'page.error': 'Failed to load',
        'page.retry': 'Retry',
        'page.offlineHint': 'The bot is not connected yet. Set AppID / AppSecret in the full console (Config), or reconnect below.',
        'status.title': 'Status',
        'status.qq': 'QQ connection',
        'status.bot': 'Bot',
        'status.llm': 'Chat model',
        'status.budgetToday': 'Budget today',
        'status.stickers': 'Stickers',
        'status.chats': 'Chats / people',
        'status.dataDir': 'Data directory',
        'status.online': 'online',
        'status.offline': 'offline',
        'status.standby': 'not configured',
        'status.connecting': 'connecting',
        'action.start': 'Start',
        'action.stop': 'Stop',
        'action.reconnect': 'Reconnect',
        'action.testQQ': 'Test QQ credentials',
        'action.testLLM': 'Test LLM',
        'action.openConsole': 'Open full console',
        'action.testing': 'Testing…',
        'result.qqOk': 'QQ credentials OK',
        'result.llmOk': 'LLM OK',
        'result.failed': 'failed',
        'warnings.title': 'Configuration notes',
        'sticker.library': 'library',
        'sticker.candidate': 'candidate',
        'tokens': 'tokens',
        'budgetUnlimited': 'unlimited',
        'footer.version': 'Version',
        'footer.hint': 'The full console manages sticker tagging, budgets, chat memory and logs.',
        'console.title': 'QQ bot console',
        'console.overview': 'Overview',
        'console.reload': 'Reload page',
        'console.external': 'Open in new window',
        'console.back': '← Back to chat'
      }
    }

    const CSS = `
      .qb-page { height: 100%; overflow-y: auto; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-family: inherit; }
      .qb-inner { max-width: 960px; margin: 0 auto; padding: 28px 28px 48px; display: flex; flex-direction: column; gap: 18px; }
      .qb-head { display: flex; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
      .qb-title-wrap { flex: 1 1 auto; min-width: 220px; }
      .qb-title { margin: 0; font-size: 21px; line-height: 30px; font-weight: 600; letter-spacing: .2px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .qb-subtitle { margin: 4px 0 0; font-size: 12.5px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }
      .qb-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .qb-badge { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 9px; border-radius: 999px; font-size: 11.5px; font-weight: 500; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); }
      .qb-badge .qb-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-label-tertiary); }
      .qb-badge.tone-ok { color: #0f7b3d; border-color: rgba(15,123,61,.32); background: rgba(15,123,61,.08); }
      .qb-badge.tone-ok .qb-dot { background: #18a058; }
      .qb-badge.tone-warn { color: #8a5a00; border-color: rgba(180,120,0,.32); background: rgba(180,120,0,.08); }
      .qb-badge.tone-warn .qb-dot { background: #d9a300; }
      .qb-badge.tone-err { color: #b3261e; border-color: rgba(179,38,30,.3); background: rgba(179,38,30,.07); }
      .qb-badge.tone-err .qb-dot { background: #d93025; }
      @media (prefers-color-scheme: dark) {
        .qb-badge.tone-ok { color: #5fd394; border-color: rgba(95,211,148,.32); background: rgba(95,211,148,.1); }
        .qb-badge.tone-warn { color: #f0c060; border-color: rgba(240,192,96,.3); background: rgba(240,192,96,.1); }
        .qb-badge.tone-err { color: #ff8a80; border-color: rgba(255,138,128,.3); background: rgba(255,138,128,.1); }
      }
      .qb-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 30px; padding: 0 12px; border-radius: 8px; font-size: 12.5px; font-family: inherit; cursor: pointer; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); transition: background .15s ease, border-color .15s ease, opacity .15s ease; }
      .qb-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2)); border-color: var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); }
      .qb-btn:disabled { opacity: .55; cursor: default; }
      .qb-btn.primary { color: #fff; background: #3f6cf0; border-color: #3f6cf0; font-weight: 500; }
      .qb-btn.primary:hover:not(:disabled) { background: #335ed8; border-color: #335ed8; }
      .qb-btn.danger { color: #b3261e; border-color: rgba(179,38,30,.32); }
      .qb-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
      .qb-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-2); padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
      .qb-card-head { display: flex; align-items: center; gap: 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
      .qb-card-value { font-size: 15px; line-height: 22px; font-weight: 600; overflow-wrap: anywhere; }
      .qb-card-value.big { font-size: 20px; line-height: 26px; }
      .qb-card-meta { font-size: 11.5px; line-height: 17px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
      .qb-progress { height: 6px; border-radius: 999px; background: var(--dsw-alias-border-l1); overflow: hidden; }
      .qb-progress > span { display: block; height: 100%; border-radius: 999px; background: #3f6cf0; transition: width .3s ease; }
      .qb-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .qb-section-title { margin: 4px 0 -4px; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
      .qb-warn-list { margin: 0; padding: 12px 14px 12px 30px; border-radius: 10px; border: 1px solid rgba(180,120,0,.3); background: rgba(180,120,0,.07); font-size: 12px; line-height: 19px; color: var(--dsw-alias-label-secondary); display: flex; flex-direction: column; gap: 4px; }
      .qb-note { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-2); padding: 14px 16px; font-size: 12.5px; line-height: 20px; color: var(--dsw-alias-label-secondary); display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
      .qb-result { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
      .qb-result.tone-ok { color: #0f7b3d; }
      .qb-result.tone-err { color: #b3261e; }
      @media (prefers-color-scheme: dark) {
        .qb-result.tone-ok { color: #5fd394; }
        .qb-result.tone-err { color: #ff8a80; }
      }
      .qb-foot { margin-top: 8px; padding-top: 12px; border-top: 1px solid var(--dsw-alias-border-l1); font-size: 11.5px; line-height: 18px; color: var(--dsw-alias-label-tertiary); display: flex; flex-wrap: wrap; gap: 6px 16px; }
      .qb-mono { font-family: var(--dsw-font-family-mono, ui-monospace, Menlo, monospace); font-size: 10.5px; overflow-wrap: anywhere; }
      .qb-skeleton { height: 84px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); opacity: .6; }

      .qb-console-page { height: 100%; min-height: 0; display: flex; flex-direction: column; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-family: inherit; }
      .qb-console-bar { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 8px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
      .qb-console-title { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); margin-right: auto; }
      .qb-console-frame { flex: 1 1 auto; width: 100%; min-height: 0; border: 0; display: block; background: var(--dsw-alias-bg-base); }

      @media (max-width: 720px) { .qb-inner { padding: 18px 14px 36px; } .qb-title { font-size: 18px; } .qb-console-bar { padding: 6px 10px; } }
    `

    function QqbotIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 18
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true
        },
        h('path', { d: 'M4 9.2A4.2 4.2 0 0 1 8.2 5h7.6A4.2 4.2 0 0 1 20 9.2v3.6a4.2 4.2 0 0 1-4.2 4.2H11l-4.6 3v-3.5A4.2 4.2 0 0 1 4 12.8Z' }),
        h('circle', { cx: 9.2, cy: 11, r: 1, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 12, cy: 11, r: 1, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 14.8, cy: 11, r: 1, fill: 'currentColor', stroke: 'none' }),
        h('path', { d: 'm17.6 3.3 1.1 1.7 1.9.6-1.2 1.5.2 2-1.9-.6-1.7 1 .3-2-1.3-1.5 1.9-.7Z', fill: 'currentColor', stroke: 'none' })
      )
    }

    function RefreshIcon() {
      return h(
        'svg',
        { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M21 12a9 9 0 1 1-2.64-6.36' }),
        h('path', { d: 'M21 3v6h-6' })
      )
    }

    function statusTone(state) {
      if (state === 'online') return 'ok'
      if (state === 'connecting' || state === 'reconnecting') return 'warn'
      if (state === 'standby') return 'warn'
      return 'err'
    }

    function statusText(t, state) {
      if (state === 'online') return t('status.online')
      if (state === 'connecting' || state === 'reconnecting') return t('status.connecting')
      if (state === 'standby') return t('status.standby')
      return t('status.offline')
    }

    function formatNumber(value) {
      const num = Number(value)
      if (!Number.isFinite(num)) return '0'
      return num >= 10000 ? `${Math.round((num / 1000) * 10) / 10}k` : String(Math.round(num))
    }

    function useSnapshot() {
      const [snapshot, setSnapshot] = React.useState({ loading: true, error: null, data: null, busy: null, result: null })
      const alive = React.useRef(true)

      const load = React.useCallback(async (quiet) => {
        if (!quiet) setSnapshot((current) => ({ ...current, loading: true, error: null }))
        try {
          const response = await fetch(`${location.origin}${API_PATH}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ method: 'snapshot', args: {} })
          })
          const payload = await response.json()
          if (!payload || payload.ok !== true) throw new Error(payload?.error ?? 'request failed')
          if (alive.current) setSnapshot((current) => ({ ...current, loading: false, error: null, data: payload.result }))
        } catch (error) {
          if (alive.current) setSnapshot((current) => ({ ...current, loading: false, error: String(error?.message ?? error) }))
        }
      }, [])

      React.useEffect(() => {
        alive.current = true
        load(true)
        const timer = setInterval(() => load(true), POLL_MS)
        return () => {
          alive.current = false
          clearInterval(timer)
        }
      }, [load])

      const call = React.useCallback(async (method, args, label) => {
        setSnapshot((current) => ({ ...current, busy: label, result: null }))
        try {
          const response = await fetch(`${location.origin}${API_PATH}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ method, args: args ?? {} })
          })
          const payload = await response.json()
          if (!payload || payload.ok !== true) throw new Error(payload?.error ?? 'request failed')
          setSnapshot((current) => ({ ...current, busy: null, result: { tone: 'ok', text: payload.result } }))
          await load(true)
          return payload.result
        } catch (error) {
          setSnapshot((current) => ({ ...current, busy: null, result: { tone: 'err', text: String(error?.message ?? error) } }))
          return undefined
        }
      }, [load])

      return { snapshot, load, call }
    }

    function StatCard({ label, value, meta, children, big }) {
      return h(
        'div',
        { className: 'qb-card' },
        h('div', { className: 'qb-card-head' }, label),
        h('div', { className: 'qb-card-value' + (big ? ' big' : '') }, value),
        meta ? h('div', { className: 'qb-card-meta' }, meta) : null,
        children ?? null
      )
    }

    /** Full console rendered inside the Harness main area (occupies the session view). */
    function ConsolePage(props) {
      const { t, onExit, onDashboard } = props
      const frameRef = React.useRef(null)
      const pageRef = React.useRef(null)
      const [frameHeight, setFrameHeight] = React.useState(640)

      const backToConversation = React.useCallback(() => {
        if (typeof onExit === 'function') onExit()
      }, [onExit])

      // The Harness main slot does not always give its child a definite height,
      // so size the console from the viewport below its own top edge. Without
      // this the iframe falls back to its intrinsic 300x150 box (top-left corner).
      React.useEffect(() => {
        let timer = 0
        const measure = () => {
          const page = pageRef.current
          if (!page) return
          const rect = page.getBoundingClientRect()
          const viewport = window.innerHeight || document.documentElement.clientHeight || 800
          const available = Math.floor(viewport - rect.top - 12)
          setFrameHeight(Math.max(360, available))
        }
        const schedule = () => {
          clearTimeout(timer)
          timer = setTimeout(measure, 30)
        }
        measure()
        const first = setTimeout(measure, 120)
        window.addEventListener('resize', schedule)
        let observer = null
        try {
          if (typeof ResizeObserver === 'function') {
            observer = new ResizeObserver(schedule)
            if (pageRef.current) observer.observe(pageRef.current.parentElement || pageRef.current)
          }
        } catch {
          observer = null
        }
        return () => {
          clearTimeout(timer)
          clearTimeout(first)
          window.removeEventListener('resize', schedule)
          try {
            observer?.disconnect()
          } catch {
            // ignore
          }
        }
      }, [])

      React.useEffect(() => {
        const onMessage = (event) => {
          if (event.origin !== location.origin) return
          const data = event.data
          if (data !== null && typeof data === 'object' && data.type === EXIT_MESSAGE) backToConversation()
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, [backToConversation])

      React.useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') backToConversation()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [backToConversation])

      const reloadFrame = () => {
        const frame = frameRef.current
        if (!frame) return
        try {
          frame.contentWindow.location.reload()
        } catch {
          frame.src = `${location.origin}${CONSOLE_PATH}`
        }
      }

      const openExternal = () => {
        const url = `${location.origin}${CONSOLE_PATH}`
        const opened = window.open(url, '_blank', 'noopener')
        if (!opened) location.assign(url)
      }

      return h(
        'div',
        { ref: pageRef, className: 'qb-console-page', style: { height: frameHeight + 'px', width: '100%' } },
        h(
          'div',
          { className: 'qb-console-bar' },
          h('div', { className: 'qb-console-title' }, h(QqbotIcon, { size: 17 }), t('console.title')),
          h('button', { type: 'button', className: 'qb-btn', onClick: onDashboard }, t('console.overview')),
          h('button', { type: 'button', className: 'qb-btn', onClick: reloadFrame }, h(RefreshIcon), t('console.reload')),
          h('button', { type: 'button', className: 'qb-btn', onClick: openExternal }, t('console.external')),
          h('button', { type: 'button', className: 'qb-btn primary', onClick: backToConversation }, t('console.back'))
        ),
        h('iframe', {
          ref: frameRef,
          className: 'qb-console-frame',
          src: `${location.origin}${CONSOLE_PATH}`,
          title: t('console.title'),
          allow: 'clipboard-read; clipboard-write',
          style: { width: '100%', height: '100%', minHeight: 0, border: 0, display: 'block' }
        })
      )
    }

    function QqbotPage(props) {
      const { t } = props
      const { snapshot, load, call } = useSnapshot()
      const data = snapshot.data
      const status = data?.status ?? {}
      const budget = data?.budget ?? {}
      const stickers = data?.stickers ?? {}
      const limits = budget?.limits ?? {}
      const today = budget?.today ?? {}
      const dailyLimit = Number(limits.dailyTokens)
      const todayTokens = Number(today.totalTokens)
      const ratio = Number.isFinite(dailyLimit) && dailyLimit > 0 ? Math.min(1, (Number.isFinite(todayTokens) ? todayTokens : 0) / dailyLimit) : 0
      const online = status.state === 'online'
      const busy = snapshot.busy

      const openConsole = () => {
        if (typeof props.openConsole === 'function') {
          if (props.openConsole() !== false) return
        }
        // Layout unavailable (unusual): fall back to a new tab, never a popup
        // child window — the in-app panel is the normal path.
        const url = `${location.origin}${CONSOLE_PATH}`
        const opened = window.open(url, '_blank', 'noopener')
        if (!opened) location.assign(url)
      }

      const resultText = snapshot.result === null ? '' : typeof snapshot.result.text === 'string' ? snapshot.result.text : JSON.stringify(snapshot.result.text)

      return h(
        'div',
        { className: 'qb-page' },
        h('style', { key: 'qb-style' }, CSS),
        h(
          'div',
          { className: 'qb-inner' },
          h(
            'header',
            { className: 'qb-head' },
            h(
              'div',
              { className: 'qb-title-wrap' },
              h(
                'h1',
                { className: 'qb-title' },
                h(QqbotIcon, { size: 22 }),
                t('page.title'),
                h('span', { className: 'qb-badge tone-' + statusTone(status.state) }, h('span', { className: 'qb-dot' }), statusText(t, status.state))
              ),
              h('p', { className: 'qb-subtitle' }, t('page.subtitle'))
            ),
            h(
              'div',
              { className: 'qb-actions' },
              h('button', { type: 'button', className: 'qb-btn', onClick: () => load(false), disabled: snapshot.loading }, h(RefreshIcon), t('page.refresh')),
              h('button', { type: 'button', className: 'qb-btn primary', onClick: openConsole }, t('page.openConsole')),
              props.onBack ? h('button', { type: 'button', className: 'qb-btn', onClick: props.onBack }, t('page.back')) : null
            )
          ),
          snapshot.error !== null
            ? h(
                'div',
                { className: 'qb-note' },
                h('span', { className: 'qb-result tone-err' }, `${t('page.error')}: ${snapshot.error}`),
                h('button', { type: 'button', className: 'qb-btn', onClick: () => load(false) }, t('page.retry'))
              )
            : null,
          snapshot.loading && data === null
            ? h('div', { className: 'qb-cards' }, h('div', { className: 'qb-skeleton' }), h('div', { className: 'qb-skeleton' }), h('div', { className: 'qb-skeleton' }))
            : null,
          data !== null
            ? h(
                'div',
                { className: 'qb-cards' },
                h(
                  StatCard,
                  { label: t('status.qq'), value: `${statusText(t, status.state)}` },
                  h('div', { className: 'qb-card-meta' }, status.lastError ? String(status.lastError) : status.sessionId ? `session ${String(status.sessionId).slice(0, 8)}` : t('page.subtitle'))
                ),
                h(StatCard, { label: t('status.bot'), value: status.bot?.username ?? '—', meta: status.bot?.id ? `id ${status.bot.id}` : null }),
                h(StatCard, { label: t('status.llm'), value: data.llm?.model ?? '—', meta: data.llm?.provider ?? null }),
                h(
                  StatCard,
                  { label: t('status.budgetToday'), value: `${formatNumber(today.totalTokens)} ${t('tokens')}`, meta: dailyLimit > 0 ? `${formatNumber(today.totalTokens)} / ${formatNumber(dailyLimit)}` : t('budgetUnlimited') },
                  dailyLimit > 0 ? h('div', { className: 'qb-progress' }, h('span', { style: { width: `${Math.round(ratio * 100)}%` } })) : null
                ),
                h(StatCard, { label: t('status.stickers'), value: formatNumber(stickers.total), meta: `${t('sticker.library')} ${formatNumber(stickers.byLayer?.library)} · ${t('sticker.candidate')} ${formatNumber(stickers.byLayer?.candidate)}` }),
                h(StatCard, { label: t('status.chats'), value: `${formatNumber(data.chats)} / ${formatNumber(data.people)}`, meta: data.dataDir ?? null })
              )
            : null,
          data !== null && Array.isArray(data.configWarnings) && data.configWarnings.length > 0
            ? h(
                'section',
                { className: 'qb-section' },
                h('h2', { className: 'qb-section-title' }, t('warnings.title')),
                h('ul', { className: 'qb-warn-list' }, data.configWarnings.map((warning, index) => h('li', { key: 'w' + index }, warning)))
              )
            : null,
          data !== null
            ? h(
                'section',
                { className: 'qb-section' },
                h('h2', { className: 'qb-section-title' }, t('status.title')),
                h(
                  'div',
                  { className: 'qb-note', style: { marginTop: '8px' } },
                  h(
                    'div',
                    { className: 'qb-row' },
                    h('button', { type: 'button', className: 'qb-btn', onClick: () => call('gateway.start', {}, 'start'), disabled: busy !== null || online }, t('action.start')),
                    h('button', { type: 'button', className: 'qb-btn', onClick: () => call('gateway.stop', {}, 'stop'), disabled: busy !== null || !online }, t('action.stop')),
                    h('button', { type: 'button', className: 'qb-btn', onClick: () => call('gateway.reconnect', {}, 'reconnect'), disabled: busy !== null }, t('action.reconnect')),
                    h('button', { type: 'button', className: 'qb-btn', onClick: () => call('gateway.test', {}, 'qq'), disabled: busy !== null }, busy === 'qq' ? t('action.testing') : t('action.testQQ')),
                    h('button', { type: 'button', className: 'qb-btn', onClick: () => call('llm.test', { prompt: '用一句话确认 QQ 机器人插件正常工作。' }, 'llm'), disabled: busy !== null }, busy === 'llm' ? t('action.testing') : t('action.testLLM'))
                  ),
                  h('div', { className: 'qb-result tone-ok' }, resultText)
                ),
                !online && status.state !== 'connecting' ? h('p', { className: 'qb-result' }, t('page.offlineHint')) : null
              )
            : null,
          data !== null
            ? h(
                'footer',
                { className: 'qb-foot' },
                h('span', {}, `easy-qqbot v${data.version ?? '0.1.0'}`),
                h('span', { className: 'qb-mono' }, data.dataDir ?? ''),
                h('span', { className: 'qb-spacer', style: { flex: '1 1 auto' } }),
                h('span', {}, t('footer.hint'))
              )
            : null
        )
      )
    }

    return {
      inject: ['slots', 'layout', 'locale'],
      apply(ctx) {
        const layout = ctx.get('layout')
        ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'qqbot: locale dictionaries')
        const t = ctx.locale.bind(NS)

        const selectPanel = (id) => {
          if (layout === undefined || layout === null || typeof layout.selectPanel !== 'function') return false
          try {
            layout.selectPanel(id)
            return true
          } catch (error) {
            return false
          }
        }

        const openConsolePanel = () => {
          if (selectPanel(CONSOLE_PANEL_ID)) return true
          // The in-app panel is normally available; if the layout/registration
          // is unavailable we must not open a popup child window (closing one
          // could take the whole Harness window down). Let the caller fall back.
          return false
        }

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 16,
              locale: NS,
              label: () => t('entry.title')
            },
            (props) => h(QqbotIcon, props)
          )
        )

        // Dashboard panel: landing page reached from the sidebar icon.
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              locale: NS
            },
            (props) =>
              h(QqbotPage, {
                ...props,
                t,
                openConsole: openConsolePanel,
                onBack: () => selectPanel(null)
              })
          )
        )

        // Full console panel: occupies the conversation area, no new browser window.
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: CONSOLE_PANEL_ID,
              locale: NS
            },
            (props) =>
              h(ConsolePage, {
                ...props,
                t,
                onExit: () => selectPanel(null),
                onDashboard: () => selectPanel(PANEL_ID)
              })
          )
        )
      }
    }
  }
})
