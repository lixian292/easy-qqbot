/*
 * qqbot admin console - vanilla ES2022, zero dependencies.
 *
 * The page is served by the plugin on <basePath>/ (default /qqbot) and talks to
 * the plugin over <basePath>/api with POST {method, args}. Sticker images are
 * served from <basePath>/media/sticker/<id>.
 *
 * Loaded defensively: the HTML may include both a relative <script> tag and a
 * dynamically resolved one, so the guard below makes a second load a no-op.
 */
(function () {
  'use strict';

  if (window.__QQBOT_ADMIN_UI_LOADED__) return;
  window.__QQBOT_ADMIN_UI_LOADED__ = true;

  // ---------------------------------------------------------------------------
  // Base URLs (works for /qqbot, /qqbot/ and custom admin paths)
  // ---------------------------------------------------------------------------
  var BASE_PATH = window.location.pathname.replace(/\/+$/, '');
  var API_URL = BASE_PATH + '/api';
  var MEDIA_ROOT = BASE_PATH + '/media/sticker';

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function $$(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function on(selector, event, handler, options) {
    var node = $(selector);
    if (node) node.addEventListener(event, handler, options);
    return node;
  }

  function esc(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (ch) {
      switch (ch) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        default: return '&#39;';
      }
    });
  }

  function errMessage(err) {
    if (err && typeof err.message === 'string' && err.message) return err.message;
    return String(err === null || err === undefined ? '未知错误' : err);
  }

  function emptyHtml(text) {
    return '<div class="empty">' + esc(text) + '</div>';
  }

  function debounce(fn, wait) {
    var timer = 0;
    return function debounced() {
      var args = arguments;
      var self = this;
      window.clearTimeout(timer);
      timer = window.setTimeout(function () {
        fn.apply(self, args);
      }, wait);
    };
  }

  function parseTags(text) {
    var seen = Object.create(null);
    var out = [];
    var parts = String(text === null || text === undefined ? '' : text).split(/[,，;；、\n\r\t]+/);
    for (var i = 0; i < parts.length; i += 1) {
      var tag = parts[i].trim();
      if (!tag) continue;
      var key = tag.toLowerCase();
      if (seen[key]) continue;
      seen[key] = true;
      out.push(tag);
      if (out.length >= 50) break;
    }
    return out;
  }

  function getPath(obj, path) {
    var node = obj;
    var keys = String(path).split('.');
    for (var i = 0; i < keys.length; i += 1) {
      if (node === null || typeof node !== 'object') return undefined;
      node = node[keys[i]];
    }
    return node;
  }

  function setPath(target, path, value) {
    var keys = String(path).split('.');
    var node = target;
    for (var i = 0; i < keys.length - 1; i += 1) {
      var key = keys[i];
      if (node[key] === null || typeof node[key] !== 'object' || Array.isArray(node[key])) node[key] = {};
      node = node[key];
    }
    node[keys[keys.length - 1]] = value;
  }

  function fmtNum(value) {
    var num = Number(value);
    if (!Number.isFinite(num)) return '0';
    try {
      return num.toLocaleString('zh-CN');
    } catch (err) {
      return String(num);
    }
  }

  function fmtBytes(value) {
    var num = Number(value);
    if (!Number.isFinite(num) || num < 0) return '—';
    if (num < 1024) return num + ' B';
    if (num < 1024 * 1024) return (num / 1024).toFixed(1) + ' KB';
    return (num / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function pad2(num) {
    return String(num).padStart(2, '0');
  }

  function fmtTime(ts) {
    var num = Number(ts);
    if (!Number.isFinite(num) || num <= 0) return '—';
    var date = new Date(num);
    return (
      date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) +
      ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds())
    );
  }

  function fmtAgo(ts) {
    var num = Number(ts);
    if (!Number.isFinite(num) || num <= 0) return '—';
    var diff = Date.now() - num;
    if (diff < 0) return fmtTime(num);
    var seconds = Math.floor(diff / 1000);
    if (seconds < 45) return '刚刚';
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + ' 分钟前';
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + ' 小时前';
    var days = Math.floor(hours / 24);
    if (days < 30) return days + ' 天前';
    return fmtTime(num);
  }

  function fmtCost(value, currency) {
    var num = Number(value);
    var unit = currency || 'CNY';
    if (!Number.isFinite(num) || num <= 0) return '0 ' + unit;
    if (num < 0.000001) return '<0.000001 ' + unit;
    if (num < 0.01) return num.toFixed(6) + ' ' + unit;
    return num.toFixed(4) + ' ' + unit;
  }

  function progressPercent(used, limit) {
    var usedNum = Number(used) || 0;
    var limitNum = Number(limit) || 0;
    if (limitNum <= 0) return 0;
    return Math.min(100, Math.max(0, (usedNum / limitNum) * 100));
  }

  function progressHtml(used, limit, label) {
    var limitNum = Number(limit) || 0;
    var percent = progressPercent(used, limit);
    var cls = percent >= 100 ? 'progress-err' : percent >= 80 ? 'progress-warn' : 'progress-ok';
    return (
      '<div class="progress-block"><div class="progress-head"><span>' + esc(label) + '</span>' +
      '<span class="muted">' + fmtNum(used) + ' / ' + (limitNum > 0 ? fmtNum(limitNum) : '不限') + '</span></div>' +
      '<div class="progress"><div class="progress-bar ' + cls + '" style="width:' + percent.toFixed(1) + '%"></div></div></div>'
    );
  }

  function kvHtml(label, valueHtml) {
    return '<div class="kv"><span class="kv-k">' + esc(label) + '</span><span class="kv-v">' + valueHtml + '</span></div>';
  }

  function safeJson(value) {
    try {
      return JSON.stringify(value);
    } catch (err) {
      return String(value);
    }
  }

  function mediaUrl(id) {
    return MEDIA_ROOT + '/' + encodeURIComponent(String(id === null || id === undefined ? '' : id));
  }

  // ---------------------------------------------------------------------------
  // Layers / states
  // ---------------------------------------------------------------------------
  var LAYERS = ['library', 'candidate', 'negative', 'trash'];
  var LAYER_LABELS = {
    library: '正式库',
    candidate: '候选',
    negative: '负面',
    trash: '回收站'
  };

  var STATE_LABELS = {
    idle: '空闲',
    connecting: '连接中',
    online: '在线',
    reconnecting: '重连中',
    offline: '离线',
    standby: '待机'
  };

  var LOG_LEVEL_LABELS = {
    debug: '调试',
    info: '信息',
    warn: '警告',
    error: '错误'
  };

  function layerLabel(layer) {
    return LAYER_LABELS[layer] || String(layer || '未知');
  }

  function layerBadgeHtml(layer, inline) {
    var key = LAYER_LABELS[layer] ? layer : 'candidate';
    return '<span class="layer-badge layer-' + key + (inline ? ' layer-badge-inline' : '') + '">' + esc(layerLabel(key)) + '</span>';
  }

  function layerOptions(selected) {
    return LAYERS.map(function (layer) {
      return '<option value="' + layer + '"' + (layer === selected ? ' selected' : '') + '>' + esc(LAYER_LABELS[layer]) + '</option>';
    }).join('');
  }

  function stateLabel(state) {
    return STATE_LABELS[state] || String(state || '未知');
  }

  function botNameOf(bot) {
    if (!bot) return '';
    if (typeof bot === 'string') return bot;
    if (typeof bot !== 'object') return '';
    return String(bot.username || bot.name || bot.nick || bot.id || '');
  }

  function statusInfo(status) {
    if (!status || status.enabled === false) return { label: '已禁用', cls: 'badge-muted' };
    if (!status.hasCredentials) return { label: '待配置', cls: 'badge-warn' };
    if (status.state === 'online') return { label: '在线', cls: 'badge-ok' };
    if (status.state === 'connecting' || status.state === 'reconnecting') return { label: stateLabel(status.state), cls: 'badge-warn' };
    if (status.lastError) return { label: '异常', cls: 'badge-err' };
    return { label: stateLabel(status.state || 'offline'), cls: 'badge-muted' };
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  var state = {
    booted: false,
    tab: 'overview',
    pollTimer: 0,
    snapshot: null,
    config: null,
    configLoaded: false,
    configWarnings: [],
    stickers: {
      layer: '',
      query: '',
      tags: [],
      items: [],
      total: 0,
      limit: 60,
      stats: null,
      selected: new Set(),
      loading: false,
      seq: 0
    },
    budget: { snapshot: null, events: null, error: '' },
    chats: { items: [], current: '', detail: null },
    people: { items: [] },
    logs: { entries: [] }
  };

  // ---------------------------------------------------------------------------
  // API layer
  // ---------------------------------------------------------------------------
  async function api(method, args, options) {
    var opts = options || {};
    var controller = null;
    var timer = 0;
    var fetchOptions = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: method, args: args || {} })
    };
    if (opts.timeoutMs && typeof AbortController === 'function') {
      controller = new AbortController();
      fetchOptions.signal = controller.signal;
      timer = window.setTimeout(function () {
        controller.abort();
      }, opts.timeoutMs);
    }
    var response;
    try {
      response = await fetch(API_URL, fetchOptions);
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
        throw new Error('请求超时（' + method + '）');
      }
      throw new Error('网络请求失败：' + errMessage(err));
    } finally {
      if (timer) window.clearTimeout(timer);
    }
    var payload = null;
    try {
      payload = await response.json();
    } catch (err) {
      payload = null;
    }
    if (!response.ok) {
      throw new Error((payload && payload.error) || ('请求失败（HTTP ' + response.status + '）'));
    }
    if (!payload || payload.ok !== true) {
      throw new Error((payload && payload.error) || ('接口返回错误：' + method));
    }
    return payload.result;
  }

  // ---------------------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------------------
  function toast(message, type, duration) {
    var root = $('#toastRoot');
    if (!root) return;
    var node = document.createElement('div');
    node.className = 'toast toast-' + (type || 'info');
    node.textContent = String(message === null || message === undefined ? '' : message);
    root.appendChild(node);
    while (root.children.length > 6) root.removeChild(root.firstElementChild);
    var remove = function () {
      node.classList.add('is-out');
      window.setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 220);
    };
    node.addEventListener('click', remove);
    window.setTimeout(remove, Number(duration) > 0 ? Number(duration) : 4200);
  }

  function toastError(err) {
    toast(errMessage(err), 'error', 5400);
  }

  function handle(fn) {
    Promise.resolve().then(fn).catch(function (err) {
      toastError(err);
    });
  }

  async function withLoading(button, fn, busyLabel) {
    if (!button) return fn();
    if (button.dataset.busy === '1') return undefined;
    var previousText = button.textContent;
    button.dataset.busy = '1';
    button.disabled = true;
    button.classList.add('is-busy');
    button.textContent = busyLabel || '处理中…';
    try {
      return await fn();
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.classList.remove('is-busy');
        button.textContent = previousText;
      }
      button.dataset.busy = '0';
    }
  }

  // ---------------------------------------------------------------------------
  // Modal
  // ---------------------------------------------------------------------------
  var modalState = null;

  function closeModal() {
    if (modalState && typeof modalState.close === 'function') modalState.close();
  }

  function openModal(options) {
    var opts = options || {};
    closeModal();
    var root = $('#modalRoot');
    if (!root) return null;
    root.hidden = false;
    root.innerHTML =
      '<div class="modal-backdrop" data-modal-close="1"></div>' +
      '<div class="modal' + (opts.wide ? ' modal-wide' : '') + '" role="dialog" aria-modal="true">' +
      '<header class="modal-head"><h3 class="modal-title">' + esc(opts.title || '') + '</h3>' +
      '<button type="button" class="icon-btn" data-modal-close="1" aria-label="关闭">×</button></header>' +
      '<div class="modal-body"></div><footer class="modal-foot"></footer></div>';
    var modalEl = root.querySelector('.modal');
    var body = root.querySelector('.modal-body');
    var footer = root.querySelector('.modal-foot');
    body.innerHTML = opts.bodyHtml || '';
    var closed = false;
    var onKeydown = null;
    var close = function () {
      if (closed) return;
      closed = true;
      if (onKeydown) document.removeEventListener('keydown', onKeydown);
      root.hidden = true;
      root.innerHTML = '';
      root.onclick = null;
      if (modalState && modalState.close === close) modalState = null;
      if (typeof opts.onClose === 'function') {
        try {
          opts.onClose();
        } catch (err) {
          console.error(err);
        }
      }
    };
    var actions = Array.isArray(opts.actions) ? opts.actions : [];
    actions.forEach(function (action) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = action.className || 'btn';
      button.textContent = action.label || '确定';
      button.addEventListener('click', function () {
        if (button.dataset.busy === '1') return;
        var run = async function () {
          var previousText = button.textContent;
          button.dataset.busy = '1';
          button.disabled = true;
          button.classList.add('is-busy');
          if (action.busyLabel) button.textContent = action.busyLabel;
          try {
            if (typeof action.onClick === 'function') {
              await action.onClick({ body: body, footer: footer, close: close, button: button, modal: modalEl });
            }
          } catch (err) {
            toastError(err);
          } finally {
            if (button.isConnected) {
              button.disabled = false;
              button.classList.remove('is-busy');
              button.textContent = previousText;
            }
            button.dataset.busy = '0';
          }
        };
        run();
      });
      footer.appendChild(button);
    });
    root.onclick = function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      var closer = target.closest('[data-modal-close]');
      if (!closer) return;
      if (closer.classList.contains('modal-backdrop') && opts.closeOnBackdrop === false) return;
      close();
    };
    onKeydown = function (event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', onKeydown);
    modalState = { close: close };
    if (typeof opts.onMount === 'function') {
      try {
        opts.onMount({ body: body, footer: footer, close: close, modal: modalEl });
      } catch (err) {
        console.error(err);
      }
    }
    return { body: body, footer: footer, close: close, modal: modalEl };
  }

  function confirmModal(options) {
    var opts = options || {};
    return new Promise(function (resolve) {
      var settled = false;
      var modal = null;
      var finish = function (value) {
        if (settled) return;
        settled = true;
        resolve(value);
        if (modal) modal.close();
      };
      modal = openModal({
        title: opts.title || '请确认',
        bodyHtml: opts.bodyHtml || '<p class="confirm-text">' + esc(opts.message || '') + '</p>',
        closeOnBackdrop: opts.closeOnBackdrop !== false,
        actions: [
          {
            label: opts.cancelLabel || '取消',
            className: 'btn',
            onClick: function () {
              finish(false);
            }
          },
          {
            label: opts.confirmLabel || '确定',
            className: opts.danger ? 'btn btn-danger' : 'btn btn-primary',
            onClick: function () {
              var value = typeof opts.readValue === 'function' ? opts.readValue(modal.body) : true;
              finish(value);
            }
          }
        ],
        onClose: function () {
          if (!settled) {
            settled = true;
            resolve(false);
          }
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Snapshot / header / tab switching
  // ---------------------------------------------------------------------------
  async function refreshSnapshot(options) {
    var opts = options || {};
    try {
      var snapshot = await api('snapshot');
      state.snapshot = snapshot && typeof snapshot === 'object' ? snapshot : {};
      renderHeader();
      if (state.tab === 'overview') renderOverview();
      return state.snapshot;
    } catch (err) {
      if (opts.silent) return null;
      throw err;
    }
  }

  function renderHeader() {
    var dataDirEl = $('#dataDir');
    var snapshot = state.snapshot;
    if (dataDirEl) {
      if (snapshot) {
        var version = snapshot.version ? ' · v' + snapshot.version : '';
        dataDirEl.textContent = '数据目录：' + (snapshot.dataDir || '未知') + version;
        dataDirEl.title = snapshot.dataDir || '';
      } else {
        dataDirEl.textContent = '数据目录加载中…';
      }
    }
    var badge = $('#connBadge');
    if (!badge) return;
    var status = snapshot && snapshot.status ? snapshot.status : null;
    var info = statusInfo(status);
    var bot = botNameOf(status && status.bot);
    var label = info.cls === 'badge-ok' && bot ? info.label + ' · ' + bot : info.label;
    badge.className = 'badge ' + info.cls;
    badge.innerHTML = '<span class="dot"></span><span>' + esc(label) + '</span>';
  }

  var TAB_NAMES = ['overview', 'config', 'stickers', 'budget', 'chats', 'people', 'logs'];

  function activateTab(tab) {
    if (TAB_NAMES.indexOf(tab) < 0) tab = 'overview';
    state.tab = tab;
    $$('.tab').forEach(function (button) {
      var active = button.dataset.tab === tab;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    $$('.panel').forEach(function (panel) {
      panel.classList.toggle('is-active', panel.id === 'panel-' + tab);
    });
    handle(function () {
      return loadTabNow(tab);
    });
  }

  function loadTabNow(tab, options) {
    var opts = options || {};
    switch (tab) {
      case 'overview':
        return refreshSnapshot();
      case 'config':
        if (state.configLoaded && !opts.force) return Promise.resolve();
        return loadConfig();
      case 'stickers':
        return refreshStickerData();
      case 'budget':
        return loadBudget();
      case 'chats':
        return loadChats().then(function () {
          return state.chats.current ? selectChat(state.chats.current) : undefined;
        });
      case 'people':
        return loadPeople();
      case 'logs':
        return loadLogs();
      default:
        return Promise.resolve();
    }
  }

  // ---------------------------------------------------------------------------
  // 概览
  // ---------------------------------------------------------------------------
  function cardHtml(options) {
    var opts = options || {};
    var rows = Array.isArray(opts.rows) ? opts.rows.filter(Boolean) : [];
    return (
      '<article class="card stat-card">' +
      '<div class="stat-top"><span class="stat-title">' + esc(opts.title || '') + '</span>' + (opts.badgeHtml || '') + '</div>' +
      '<div class="stat-value">' + (opts.valueHtml || '') + '</div>' +
      (opts.sub ? '<div class="stat-sub">' + esc(opts.sub) + '</div>' : '') +
      (opts.extraHtml || '') +
      (rows.length ? '<div class="stat-rows">' + rows.join('') + '</div>' : '') +
      '</article>'
    );
  }

  function renderOverview() {
    var cardsEl = $('#overviewCards');
    var warningsEl = $('#overviewWarnings');
    if (!cardsEl) return;
    var snapshot = state.snapshot;
    if (!snapshot) {
      cardsEl.innerHTML = emptyHtml('正在加载…');
      return;
    }
    var status = snapshot.status || {};
    var llm = snapshot.llm || {};
    var budget = snapshot.budget || {};
    var today = budget.today || {};
    var month = budget.month || {};
    var limits = budget.limits || {};
    var stickers = snapshot.stickers || {};
    var byLayer = stickers.byLayer || {};
    var info = statusInfo(status);
    var bot = botNameOf(status.bot);
    var cards = [];

    cards.push(
      cardHtml({
        title: 'QQ 连接',
        badgeHtml: '<span class="badge ' + info.cls + '"><span class="dot"></span>' + esc(info.label) + '</span>',
        valueHtml: esc(status.state ? stateLabel(status.state) : status.enabled === false ? '已禁用' : '未知'),
        sub: status.enabled === false ? '插件已禁用' : status.hasCredentials ? '凭据已配置' : '缺少 AppID / AppSecret',
        rows: [
          kvHtml('机器人', esc(bot || '—')),
          kvHtml('已连接', fmtTime(status.connectedAt)),
          kvHtml('最近心跳', fmtAgo(status.lastHeartbeatAt)),
          kvHtml('最近消息', fmtAgo(status.lastInboundAt)),
          kvHtml('收发消息', fmtNum(status.sent) + ' / ' + fmtNum(status.received)),
          kvHtml('重连次数', fmtNum(status.reconnects !== undefined ? status.reconnects : status.attempts)),
          status.lastError ? kvHtml('最近错误', '<span class="error-text">' + esc(String(status.lastError)) + '</span>') : ''
        ]
      })
    );

    cards.push(
      cardHtml({
        title: '当前模型',
        valueHtml: esc(llm.provider || '未配置') + ' <span class="stat-sep">/</span> ' + esc(llm.model || '—'),
        sub: '来自 data/config.json 的 llm 配置',
        rows: [kvHtml('Provider', esc(llm.provider || '—')), kvHtml('模型', esc(llm.model || '—'))]
      })
    );

    var todayLimit = Number(limits.dailyTokens) || 0;
    cards.push(
      cardHtml({
        title: '今日预算',
        valueHtml: fmtNum(today.totalTokens) + ' <span class="stat-unit">tokens</span>',
        sub: todayLimit > 0 ? '日限额 ' + fmtNum(todayLimit) + ' tokens' : '未设置日限额',
        extraHtml: progressHtml(today.totalTokens, todayLimit, '日用量'),
        rows: [
          kvHtml('调用次数', fmtNum(today.calls)),
          kvHtml('本月 tokens', fmtNum(month.totalTokens)),
          kvHtml('今日费用', fmtCost(today.cost, budget.currency || 'CNY'))
        ]
      })
    );

    cards.push(
      cardHtml({
        title: '表情包',
        valueHtml: fmtNum(stickers.total) + ' <span class="stat-unit">张</span>',
        sub: '正式库会用于聊天回复',
        rows: [
          kvHtml('正式库', fmtNum(byLayer.library)),
          kvHtml('候选', fmtNum(byLayer.candidate)),
          kvHtml('负面', fmtNum(byLayer.negative)),
          kvHtml('回收站', fmtNum(byLayer.trash)),
          kvHtml('标签数', fmtNum(stickers.tags))
        ]
      })
    );

    cards.push(
      cardHtml({
        title: '会话与人员',
        valueHtml: fmtNum(snapshot.chats) + ' <span class="stat-unit">会话</span>',
        sub: '人员画像 ' + fmtNum(snapshot.people) + ' 人',
        rows: [kvHtml('服务器时间', fmtTime(snapshot.serverTime)), kvHtml('版本', esc(snapshot.version || '—'))]
      })
    );

    cardsEl.innerHTML = cards.join('');

    if (warningsEl) {
      var warnings = Array.isArray(snapshot.configWarnings) ? snapshot.configWarnings : [];
      warningsEl.innerHTML = warnings.length
        ? warnings.map(function (warning) {
            return '<li class="warning-item">' + esc(warning) + '</li>';
          }).join('')
        : '<li class="muted">无配置警告</li>';
    }
  }

  function renderTestQQResult(result) {
    var el = $('#testQQResult');
    if (!el) return;
    if (!result || result.ok === false) {
      el.className = 'result result-err';
      el.textContent = '测试失败：' + String((result && result.error) || '未知错误');
      return;
    }
    var parts = ['凭证有效'];
    var bot = botNameOf(result.bot);
    if (bot) parts.push('机器人：' + bot);
    var expires = Number(result.tokenExpiresIn);
    if (Number.isFinite(expires)) parts.push('token 有效期 ' + fmtNum(expires) + ' 秒');
    el.className = 'result result-ok';
    el.textContent = parts.join(' · ') + (result.gatewayUrl ? '\n网关：' + result.gatewayUrl : '');
  }

  async function testQQCredentials() {
    var el = $('#testQQResult');
    if (el) {
      el.className = 'result muted';
      el.textContent = '测试中…';
    }
    var result = await api('gateway.test');
    renderTestQQResult(result);
    if (result && result.ok !== false) toast('QQ 凭证测试通过', 'success');
    else toast('QQ 凭证测试失败：' + String((result && result.error) || '未知错误'), 'error');
  }

  async function testLlm() {
    var el = $('#testLLMResult');
    if (el) {
      el.className = 'result muted';
      el.textContent = '调用中，请稍候…';
    }
    var now = function () {
      return window.performance && typeof window.performance.now === 'function' ? window.performance.now() : Date.now();
    };
    var started = now();
    try {
      var result = await api('llm.test', { prompt: '你好，请用一句话回复我。' }, { timeoutMs: 180000 });
      var clientElapsed = Math.round(now() - started);
      var serverMs = Number(result.ms);
      var elapsed = Number.isFinite(serverMs) && serverMs >= 0 ? Math.round(serverMs) : clientElapsed;
      if (!result || result.ok === false) {
        var reason = String((result && result.error) || '未知错误');
        if (el) {
          el.className = 'result result-err';
          el.textContent = '调用失败：' + reason;
        }
        toast('LLM 测试失败：' + reason, 'error');
        return;
      }
      var usage = result.usage || {};
      var text = String(result.text === null || result.text === undefined ? '' : result.text).trim();
      if (el) {
        el.className = 'result result-ok';
        el.textContent =
          '回复：' + (text || '（空响应）') +
          '\n模型：' + (result.provider || '—') + ' / ' + (result.model || '—') +
          ' · 耗时 ' + elapsed + 'ms' +
          (usage.totalTokens !== undefined ? ' · tokens ' + fmtNum(usage.totalTokens) : '');
      }
      toast('LLM 测试成功（' + elapsed + 'ms）', 'success');
    } catch (err) {
      if (el) {
        el.className = 'result result-err';
        el.textContent = '调用失败：' + errMessage(err);
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // 配置
  // ---------------------------------------------------------------------------
  var CONFIG_SCHEMA = [
    {
      title: 'QQ 接入',
      hint: '凭据来自 QQ 开放平台机器人。保存后插件会自动重启 QQ 连接。',
      fields: [
        { path: 'enabled', label: '启用插件', type: 'bool', hint: '关闭后不连接 QQ，也不处理消息' },
        { path: 'qq.appId', label: 'AppID', type: 'text', placeholder: 'QQ 机器人 AppID' },
        { path: 'qq.appSecret', label: 'AppSecret', type: 'secret' },
        { path: 'qq.apiBase', label: 'API 基地址', type: 'text', placeholder: 'https://api.bot.qq.com' },
        { path: 'qq.tokenPath', label: 'Token 路径', type: 'text' },
        { path: 'qq.gatewayPath', label: '网关路径', type: 'text' },
        { path: 'qq.intents', label: 'Intents', type: 'number', min: 0 },
        { path: 'qq.shard', label: 'Shard', type: 'shard', hint: '两个数字，例如 0,1（分片序号,分片总数）' },
        { path: 'qq.textChunkSize', label: '文本分片长度', type: 'number', min: 100, max: 4000 },
        { path: 'qq.reconnect.baseDelayMs', label: '重连基础延迟 (ms)', type: 'number', min: 200, max: 60000 },
        { path: 'qq.reconnect.maxDelayMs', label: '重连最大延迟 (ms)', type: 'number', min: 1000, max: 600000 },
        { path: 'qq.reconnect.maxAttempts', label: '最大重连次数', type: 'number', min: 0, hint: '0 表示无限重连' },
        { path: 'qq.reply.c2cWindowMs', label: '单聊被动回复窗口 (ms)', type: 'number', min: 1000 },
        { path: 'qq.reply.groupWindowMs', label: '群聊被动回复窗口 (ms)', type: 'number', min: 1000 },
        { path: 'qq.reply.c2cMaxReplies', label: '单聊同消息最大回复数', type: 'number', min: 1 },
        { path: 'qq.reply.groupMaxReplies', label: '群聊同消息最大回复数', type: 'number', min: 1 }
      ]
    },
    {
      title: 'LLM',
      hint: '使用 DSH 已配置的模型提供方；模型名需与提供方一致。',
      fields: [
        { path: 'llm.provider', label: 'Provider', type: 'text' },
        { path: 'llm.model', label: '模型', type: 'text' },
        { path: 'llm.temperature', label: '温度', type: 'number', min: 0, max: 2, step: 0.05 },
        { path: 'llm.maxTokens', label: '最大输出 tokens', type: 'number', min: 64, max: 32768 },
        { path: 'llm.timeoutMs', label: '超时 (ms)', type: 'number', min: 5000, max: 600000 }
      ]
    },
    {
      title: '视觉模型（可选）',
      hint: '使用 OpenAI 兼容的视觉接口把入站图片转成文字描述，再注入对话上下文。baseUrl 示例：https://api.siliconflow.cn/v1 或 https://openrouter.ai/api/v1；启用后需同时填写 Base URL、API Key 与模型名。',
      fields: [
        { path: 'vision.enabled', label: '启用图片理解', type: 'bool' },
        { path: 'vision.baseUrl', label: 'API Base URL', type: 'text', placeholder: 'https://api.siliconflow.cn/v1' },
        { path: 'vision.apiKey', label: 'API Key', type: 'secret', secretOf: 'vision' },
        { path: 'vision.model', label: '视觉模型', type: 'text', placeholder: '例如 Qwen/Qwen2.5-VL-7B-Instruct' },
        { path: 'vision.prompt', label: '描述提示词', type: 'textarea', wide: true, rows: 3 },
        { path: 'vision.maxTokens', label: '最大输出 tokens', type: 'number', min: 32, max: 4096 },
        { path: 'vision.timeoutMs', label: '超时 (ms)', type: 'number', min: 5000, max: 300000 },
        { path: 'vision.maxImageBytes', label: '单张图片最大字节', type: 'number', min: 65536, max: 20971520 }
      ]
    },
    {
      title: '人设',
      hint: '全局默认人设；会话级 / 用户级覆盖在「会话」页配置。',
      fields: [
        { path: 'persona.name', label: '名字', type: 'text' },
        { path: 'persona.systemPrompt', label: '系统提示', type: 'textarea', wide: true, rows: 4 },
        { path: 'persona.style', label: '风格', type: 'textarea', wide: true, rows: 3 },
        { path: 'persona.replyMaxChars', label: '回复最大字数', type: 'number', min: 100, max: 4000 },
        { path: 'persona.stickerChance', label: '表情包发送概率', type: 'number', min: 0, max: 1, step: 0.05 },
        { path: 'persona.maxHistoryMessages', label: '最大历史消息数', type: 'number', min: 2, max: 200 },
        { path: 'persona.memoryEnabled', label: '启用长期记忆', type: 'bool' },
        { path: 'persona.compressEnabled', label: '启用上下文压缩', type: 'bool' }
      ]
    },
    {
      title: '预算',
      hint: '限额为 0 表示不限制；单价用于估算费用。',
      fields: [
        { path: 'budget.enabled', label: '启用预算控制', type: 'bool' },
        { path: 'budget.dailyTokens', label: '每日 tokens 限额', type: 'number', min: 0 },
        { path: 'budget.monthlyTokens', label: '每月 tokens 限额', type: 'number', min: 0 },
        { path: 'budget.perChatDailyTokens', label: '单会话每日 tokens 限额', type: 'number', min: 0 },
        { path: 'budget.dailyCalls', label: '每日调用次数限额', type: 'number', min: 0 },
        { path: 'budget.priceInPerMillion', label: '输入价格 / 百万 tokens', type: 'number', min: 0, step: 0.01 },
        { path: 'budget.priceOutPerMillion', label: '输出价格 / 百万 tokens', type: 'number', min: 0, step: 0.01 },
        { path: 'budget.currency', label: '币种', type: 'text' },
        { path: 'budget.blockCooldownMs', label: '超限提示冷却 (ms)', type: 'number', min: 1000 },
        { path: 'budget.blockMessage', label: '超限提示文案', type: 'textarea', wide: true, rows: 2 }
      ]
    },
    {
      title: '记忆与压缩',
      hint: '达到阈值后自动压缩上下文并抽取长期事实。',
      fields: [
        { path: 'memory.maxFacts', label: '每会话最大事实数', type: 'number', min: 0, max: 200 },
        { path: 'memory.extractEveryUserMessages', label: '每 N 条用户消息抽取事实', type: 'number', min: 1 },
        { path: 'memory.historyLimit', label: '历史消息保留条数', type: 'number', min: 2, max: 500 },
        { path: 'memory.compressTriggerTokens', label: '压缩触发 tokens', type: 'number', min: 500 },
        { path: 'memory.keepRecentMessages', label: '压缩后保留最近消息数', type: 'number', min: 2 },
        { path: 'memory.summaryMaxChars', label: '摘要最大字数', type: 'number', min: 200 }
      ]
    },
    {
      title: '表情包',
      hint: '正式库用于聊天挑选；候选库可手动升级。',
      fields: [
        { path: 'stickers.enabled', label: '启用表情包', type: 'bool' },
        { path: 'stickers.libraryOnly', label: '只从正式库挑选', type: 'bool' },
        { path: 'stickers.captureIncoming', label: '自动收集入站图片', type: 'bool' },
        { path: 'stickers.maxImageBytes', label: '单张图片最大字节', type: 'number', min: 65536, max: 20971520 },
        { path: 'stickers.replyChance', label: '文本命中标签时发表情概率', type: 'number', min: 0, max: 1, step: 0.05 },
        { path: 'stickers.maxCatalogTags', label: '提示词最多标签数', type: 'number', min: 4, max: 200 }
      ]
    },
    {
      title: '命令与管理员',
      hint: '命令前缀默认 #，同时兼容 /；管理员可使用管理命令。',
      fields: [
        { path: 'commands.enabled', label: '启用聊天命令', type: 'bool' },
        { path: 'commands.prefix', label: '命令前缀', type: 'text' },
        { path: 'commands.adminOpenids', label: '管理员 openid', type: 'list', wide: true, rows: 3, hint: '每行一个 openid' },
        { path: 'commands.allowGroupOwner', label: '允许群主 / 管理员使用管理命令', type: 'bool' },
        { path: 'admin.enabled', label: '启用管理后台', type: 'bool', hint: '关闭后本页面接口将不可用' },
        { path: 'admin.path', label: '管理页路径', type: 'text', hint: '站内路径，例如 /qqbot；修改后需重新加载插件才会生效' },
        { path: 'admin.pageSize', label: '管理页每页数量', type: 'number', min: 10, max: 500 }
      ]
    },
    {
      title: '日志',
      fields: [
        { path: 'logging.maxLines', label: '日志保留行数', type: 'number', min: 50, max: 5000 },
        { path: 'logging.debug', label: '调试日志', type: 'bool' }
      ]
    }
  ];

  function renderConfigWarnings(target, warnings, emptyText) {
    if (!target) return;
    var list = Array.isArray(warnings) ? warnings : [];
    target.innerHTML = list.length
      ? list.map(function (warning) { return '<li class="warning-item">' + esc(warning) + '</li>'; }).join('')
      : '<li class="muted">' + esc(emptyText || '无配置警告') + '</li>';
  }

  function renderConfigField(field, config) {
    var value = getPath(config, field.path);
    var path = esc(field.path);
    var label = esc(field.label);
    if (field.type === 'bool') {
      return (
        '<label class="check-field">' +
        '<input type="checkbox" data-path="' + path + '" data-type="bool"' + (value ? ' checked' : '') + ' />' +
        '<span class="check-text">' + label + '</span>' +
        (field.hint ? '<span class="field-hint">' + esc(field.hint) + '</span>' : '') +
        '</label>'
      );
    }
    var control = '';
    if (field.type === 'number') {
      var raw = typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
      var attrs = [];
      if (field.min !== undefined) attrs.push('min="' + Number(field.min) + '"');
      if (field.max !== undefined) attrs.push('max="' + Number(field.max) + '"');
      attrs.push('step="' + (field.step !== undefined ? Number(field.step) : 1) + '"');
      control = '<input type="number" inputmode="decimal" data-path="' + path + '" data-type="number" value="' + esc(raw) + '" ' + attrs.join(' ') + ' />';
    } else if (field.type === 'textarea') {
      control = '<textarea data-path="' + path + '" data-type="text" rows="' + (Number(field.rows) || 3) + '">' + esc(value === null || value === undefined ? '' : value) + '</textarea>';
    } else if (field.type === 'list') {
      var items = Array.isArray(value) ? value : [];
      control = '<textarea data-path="' + path + '" data-type="list" rows="' + (Number(field.rows) || 3) + '">' + esc(items.join('\n')) + '</textarea>';
    } else if (field.type === 'shard') {
      var shardText = Array.isArray(value) ? value.join(',') : '';
      control = '<input type="text" data-path="' + path + '" data-type="shard" value="' + esc(shardText) + '" placeholder="0,1" />';
    } else if (field.type === 'secret') {
      var secretRoot = field.secretOf || 'qq';
      var secretConfig = config && config[secretRoot] && typeof config[secretRoot] === 'object' ? config[secretRoot] : {};
      var masked = secretConfig.appSecretMasked || secretConfig.apiKeyMasked || '';
      var hasSecret = !!(secretConfig.hasSecret || secretConfig.hasApiKey);
      var placeholder = hasSecret ? '已保存（' + masked + '），留空不修改' : '尚未设置';
      control = '<input type="password" autocomplete="new-password" data-path="' + path + '" data-type="secret" value="" placeholder="' + esc(placeholder) + '" />';
    } else {
      control = '<input type="text" data-path="' + path + '" data-type="text" value="' + esc(value === null || value === undefined ? '' : value) + '" placeholder="' + esc(field.placeholder || '') + '" />';
    }
    var hints = [];
    if (field.hint) hints.push(field.hint);
    if (field.type === 'secret') hints.push('密钥不会回显；留空表示保持不变');
    var hintHtml = hints.map(function (hint) {
      return '<span class="field-hint">' + esc(hint) + '</span>';
    }).join('');
    return (
      '<label class="field' + (field.wide ? ' field-wide' : '') + '">' +
      '<span class="field-label">' + label + '</span>' + control + hintHtml +
      '</label>'
    );
  }

  function renderConfigForm() {
    var form = $('#configForm');
    if (!form) return;
    var config = state.config || {};
    form.innerHTML = CONFIG_SCHEMA.map(function (section) {
      var fields = section.fields.map(function (field) {
        return renderConfigField(field, config);
      }).join('');
      return (
        '<fieldset class="form-section"><legend class="form-section-title">' + esc(section.title) + '</legend>' +
        (section.hint ? '<p class="section-hint">' + esc(section.hint) + '</p>' : '') +
        '<div class="form-grid">' + fields + '</div></fieldset>'
      );
    }).join('');
  }

  async function loadConfig() {
    var result = await api('config.get');
    var config = result && result.config && typeof result.config === 'object' ? result.config : {};
    state.config = config;
    state.configWarnings = result && Array.isArray(result.warnings) ? result.warnings : [];
    state.configLoaded = true;
    renderConfigForm();
    renderConfigWarnings($('#configWarnings'), state.configWarnings);
  }

  function collectConfigPatch() {
    var form = $('#configForm');
    if (!form) return {};
    var patch = {};
    var inputs = $$('[data-path]', form);
    for (var i = 0; i < inputs.length; i += 1) {
      var input = inputs[i];
      var path = input.dataset.path;
      var type = input.dataset.type || 'text';
      if (type === 'bool') {
        setPath(patch, path, !!input.checked);
        continue;
      }
      var raw = String(input.value === undefined ? '' : input.value);
      if (type === 'number') {
        var trimmed = raw.trim();
        if (trimmed === '') continue;
        var num = Number(trimmed);
        if (!Number.isFinite(num)) {
          var labelNode = input.closest('.field') ? input.closest('.field').querySelector('.field-label') : null;
          throw new Error('「' + (labelNode ? labelNode.textContent : path) + '」需要填写有效数字');
        }
        setPath(patch, path, num);
      } else if (type === 'shard') {
        var shardParts = raw.split(/[,，\s]+/).map(Number).filter(function (item) { return Number.isFinite(item); });
        if (shardParts.length !== 2) throw new Error('Shard 需要两个数字，例如 0,1');
        setPath(patch, path, shardParts);
      } else if (type === 'list') {
        var listItems = raw.split(/[\n,，]/).map(function (item) { return item.trim(); }).filter(Boolean);
        setPath(patch, path, listItems);
      } else if (type === 'secret') {
        if (raw.trim() === '') continue;
        setPath(patch, path, raw.trim());
      } else {
        setPath(patch, path, raw);
      }
    }
    return patch;
  }

  function saveConfig() {
    return withLoading($('#btnConfigSave'), async function () {
      var patch = collectConfigPatch();
      var result = await api('config.save', { patch: patch });
      if (result && result.config && typeof result.config === 'object') state.config = result.config;
      state.configLoaded = true;
      renderConfigForm();
      state.configWarnings = result && Array.isArray(result.warnings) ? result.warnings : [];
      renderConfigWarnings($('#configWarnings'), state.configWarnings);
      toast('配置已保存，QQ 连接将按新配置重启', 'success');
      window.setTimeout(function () {
        refreshSnapshot({ silent: true }).catch(function () {});
      }, 1200);
    }, '保存中…');
  }

  // ---------------------------------------------------------------------------
  // 表情包
  // ---------------------------------------------------------------------------
  function resetStickerSelection() {
    state.stickers.selected.clear();
    updateStickerBulkBar();
    updateStickerSelectAll();
  }

  function renderStickerLayerTabs() {
    var container = $('#stickerLayerTabs');
    if (!container) return;
    var stats = state.stickers.stats || {};
    var byLayer = stats.byLayer || {};
    var tabs = [
      { value: '', label: '全部', count: Number(stats.total) || 0 },
      { value: 'library', label: '正式库', count: Number(byLayer.library) || 0 },
      { value: 'candidate', label: '候选', count: Number(byLayer.candidate) || 0 },
      { value: 'negative', label: '负面', count: Number(byLayer.negative) || 0 },
      { value: 'trash', label: '回收站', count: Number(byLayer.trash) || 0 }
    ];
    container.innerHTML = tabs.map(function (tab) {
      var active = state.stickers.layer === tab.value;
      return (
        '<button type="button" class="seg-btn' + (active ? ' is-active' : '') + '" data-layer="' + tab.value + '" role="tab" aria-selected="' + active + '">' +
        esc(tab.label) + '<span class="seg-count">' + tab.count + '</span></button>'
      );
    }).join('');
  }

  function normalizeTagStats(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map(function (item) {
      if (typeof item === 'string') return { tag: item, count: 0 };
      return { tag: String((item && item.tag) || ''), count: Number(item && item.count) || 0 };
    }).filter(function (item) {
      return item.tag !== '';
    });
  }

  function renderStickerTagChips() {
    var container = $('#stickerTagChips');
    if (!container) return;
    var tags = normalizeTagStats(state.stickers.stats ? state.stickers.stats.tags : []);
    var selected = state.stickers.tags;
    var chips = tags.slice(0, 80).map(function (item) {
      var active = selected.indexOf(item.tag) >= 0;
      return (
        '<button type="button" class="chip tag-chip' + (active ? ' is-active' : '') + '" data-tag="' + esc(item.tag) + '">' +
        '#' + esc(item.tag) + '<span class="chip-count">' + item.count + '</span></button>'
      );
    });
    if (!chips.length) chips.push('<span class="muted">暂无标签</span>');
    if (selected.length) {
      chips.push('<button type="button" class="chip chip-clear" data-clear-tags="1">清空标签筛选 ×</button>');
    }
    container.innerHTML = chips.join('');
  }

  function stickerCardHtml(item) {
    var id = String(item && item.id !== undefined && item.id !== null ? item.id : '');
    var tags = Array.isArray(item && item.tags) ? item.tags : [];
    var layer = String((item && item.layer) || 'candidate');
    var checked = state.stickers.selected.has(id);
    var tagChips = tags.length
      ? tags.slice(0, 6).map(function (tag) {
          return '<span class="chip chip-static">#' + esc(tag) + '</span>';
        }).join('') + (tags.length > 6 ? '<span class="chip chip-static">+' + (tags.length - 6) + '</span>' : '')
      : '<span class="muted small">无标签</span>';
    return (
      '<article class="sticker-card' + (checked ? ' is-selected' : '') + '" data-id="' + esc(id) + '" tabindex="0">' +
      '<label class="sticker-check"><input type="checkbox" class="sticker-check-input" data-id="' + esc(id) + '"' + (checked ? ' checked' : '') + ' /><span class="sr-only">选择</span></label>' +
      '<div class="sticker-thumb">' +
      '<img src="' + esc(mediaUrl(id)) + '" alt="' + esc(tags[0] || id) + '" loading="lazy" />' +
      layerBadgeHtml(layer) +
      '</div>' +
      '<div class="sticker-body">' +
      '<div class="sticker-meta"><code class="mono">' + esc(id) + '</code><span class="muted">使用 ' + (Number(item && item.useCount) || 0) + '</span></div>' +
      '<div class="chip-row">' + tagChips + '</div>' +
      (item && item.desc ? '<div class="sticker-desc">' + esc(item.desc) + '</div>' : '') +
      '</div>' +
      '</article>'
    );
  }

  function updateStickerCount() {
    var el = $('#stickerCount');
    if (!el) return;
    var st = state.stickers;
    var filters = [];
    if (st.layer) filters.push('图层：' + layerLabel(st.layer));
    if (st.query) filters.push('搜索：' + st.query);
    if (st.tags.length) filters.push('标签：' + st.tags.join(', '));
    el.textContent = '共 ' + st.total + ' 张 · 已加载 ' + st.items.length + ' 张' + (filters.length ? ' · ' + filters.join(' · ') : '');
  }

  function updateStickerBulkBar() {
    var bar = $('#stickerBulkBar');
    var countEl = $('#bulkCount');
    var count = state.stickers.selected.size;
    if (bar) bar.hidden = count === 0;
    if (countEl) countEl.textContent = '已选 ' + count + ' 项';
  }

  function updateStickerSelectAll() {
    var all = $('#stickerSelectAll');
    if (!all) return;
    var items = state.stickers.items;
    var selectedCount = items.filter(function (item) {
      return state.stickers.selected.has(item.id);
    }).length;
    all.checked = items.length > 0 && selectedCount === items.length;
    all.indeterminate = selectedCount > 0 && selectedCount < items.length;
  }

  function renderStickerGrid() {
    var grid = $('#stickerGrid');
    if (!grid) return;
    var st = state.stickers;
    if (!st.items.length) {
      var emptyText = st.query || st.tags.length || st.layer ? '没有符合条件的表情包' : '表情包库还是空的，扫描 import 目录或上传图片吧';
      grid.innerHTML = emptyHtml(emptyText);
    } else {
      grid.innerHTML = st.items.map(stickerCardHtml).join('');
    }
    updateStickerCount();
    updateStickerBulkBar();
    updateStickerSelectAll();
    var moreButton = $('#btnStickerMore');
    if (moreButton) moreButton.hidden = st.items.length >= st.total;
  }

  async function loadStickerStats() {
    var stats = await api('stickers.stats');
    state.stickers.stats = stats && typeof stats === 'object' ? stats : null;
    renderStickerLayerTabs();
    renderStickerTagChips();
  }

  async function loadStickers(options) {
    var opts = options || {};
    var st = state.stickers;
    if (st.loading) return;
    st.loading = true;
    var seq = ++st.seq;
    try {
      var args = { limit: st.limit, offset: opts.append ? st.items.length : 0 };
      if (st.layer) args.layer = st.layer;
      if (st.query) args.query = st.query;
      if (st.tags.length) args.tags = st.tags.slice();
      var result = await api('stickers.list', args);
      if (seq !== st.seq) return;
      var items = result && Array.isArray(result.items) ? result.items.filter(function (item) { return item && item.id; }) : [];
      st.total = result && Number.isFinite(Number(result.total)) ? Number(result.total) : items.length;
      st.items = opts.append ? st.items.concat(items) : items;
      if (!opts.append) {
        var visible = Object.create(null);
        st.items.forEach(function (item) { visible[item.id] = true; });
        Array.from(st.selected).forEach(function (id) {
          if (!visible[id]) st.selected.delete(id);
        });
      }
      renderStickerGrid();
    } finally {
      st.loading = false;
    }
  }

  async function refreshStickerData() {
    await loadStickerStats();
    await loadStickers();
  }

  function stickerById(id) {
    for (var i = 0; i < state.stickers.items.length; i += 1) {
      if (state.stickers.items[i].id === id) return state.stickers.items[i];
    }
    return null;
  }

  function tagSuggestionHtml(selectedTags) {
    var tags = normalizeTagStats(state.stickers.stats ? state.stickers.stats.tags : []);
    var used = Object.create(null);
    (selectedTags || []).forEach(function (tag) { used[String(tag).toLowerCase()] = true; });
    var chips = tags.filter(function (item) { return !used[item.tag.toLowerCase()]; }).slice(0, 40).map(function (item) {
      return '<button type="button" class="chip tag-chip" data-suggest-tag="' + esc(item.tag) + '">#' + esc(item.tag) + '</button>';
    });
    return chips.length ? '<span class="muted small">快速添加：</span>' + chips.join('') : '<span class="muted small">暂无其它已有标签</span>';
  }

  function openStickerEditor(id) {
    var item = stickerById(id);
    if (!item) {
      toast('找不到该表情包，请刷新后重试', 'warn');
      return;
    }
    var tags = Array.isArray(item.tags) ? item.tags : [];
    var modal = openModal({
      title: '编辑表情包',
      wide: true,
      bodyHtml:
        '<div class="editor">' +
        '<div class="editor-preview"><img src="' + esc(mediaUrl(id)) + '" alt="' + esc(id) + '" /></div>' +
        '<div class="editor-form">' +
        '<div class="editor-info">' +
        kvHtml('ID', '<code class="mono">' + esc(id) + '</code>') +
        kvHtml('图层', layerBadgeHtml(item.layer, true)) +
        kvHtml('使用次数', String(Number(item.useCount) || 0)) +
        kvHtml('大小', fmtBytes(item.size)) +
        kvHtml('格式', esc(String(item.ext || '').toUpperCase() || '—')) +
        kvHtml('创建时间', fmtTime(item.createdAt)) +
        kvHtml('更新时间', fmtTime(item.updatedAt)) +
        (item.lastUsedAt ? kvHtml('最近使用', fmtTime(item.lastUsedAt)) : '') +
        '</div>' +
        '<label class="field"><span class="field-label">标签（逗号分隔）</span>' +
        '<input type="text" data-field="tags" value="' + esc(tags.join(', ')) + '" placeholder="例如：开心, 猫, 表情" /></label>' +
        '<div class="tag-suggest">' + tagSuggestionHtml(tags) + '</div>' +
        '<label class="field"><span class="field-label">描述</span>' +
        '<textarea data-field="desc" rows="3" placeholder="选填，帮助以后挑选表情包">' + esc(item.desc || '') + '</textarea></label>' +
        '<label class="field"><span class="field-label">图层</span>' +
        '<select data-field="layer">' + layerOptions(item.layer || 'candidate') + '</select></label>' +
        '</div></div>',
      onMount: function (ctx) {
        $$('[data-suggest-tag]', ctx.body).forEach(function (button) {
          button.addEventListener('click', function () {
            var input = ctx.body.querySelector('[data-field="tags"]');
            if (!input) return;
            var current = parseTags(input.value);
            var tag = button.dataset.suggestTag || '';
            if (tag && current.indexOf(tag) < 0) current.push(tag);
            input.value = current.join(', ');
            input.focus();
          });
        });
      },
      actions: [
        {
          label: '保存',
          className: 'btn btn-primary',
          onClick: async function (ctx) {
            var tagsInput = ctx.body.querySelector('[data-field="tags"]');
            var descInput = ctx.body.querySelector('[data-field="desc"]');
            var layerSelect = ctx.body.querySelector('[data-field="layer"]');
            var result = await api('stickers.update', {
              id: id,
              tags: parseTags(tagsInput ? tagsInput.value : ''),
              desc: String((descInput && descInput.value) || '').trim(),
              layer: (layerSelect && layerSelect.value) || 'candidate'
            });
            toast('表情包已保存' + (result && result.item && result.item.layer ? '（图层：' + layerLabel(result.item.layer) + '）' : ''), 'success');
            ctx.close();
            await refreshStickerData();
          }
        },
        item.layer === 'trash'
          ? {
              label: '从回收站还原',
              className: 'btn',
              onClick: async function (ctx) {
                await api('stickers.restore', { id: id });
                toast('已从回收站还原到候选库', 'success');
                ctx.close();
                await refreshStickerData();
              }
            }
          : {
              label: '移入回收站',
              className: 'btn',
              onClick: async function (ctx) {
                await api('stickers.remove', { id: id });
                toast('已移入回收站', 'success');
                ctx.close();
                await refreshStickerData();
              }
            },
        {
          label: '彻底删除',
          className: 'btn btn-danger',
          onClick: async function (ctx) {
            var confirmed = await confirmModal({
              title: '彻底删除表情包',
              message: '确定彻底删除表情包 ' + id + ' 吗？文件与索引都会被移除，无法恢复。',
              confirmLabel: '删除',
              danger: true
            });
            if (!confirmed) return;
            await api('stickers.purge', { id: id });
            toast('已彻底删除', 'success');
            ctx.close();
            state.stickers.selected.delete(id);
            await refreshStickerData();
          }
        },
        { label: '关闭', onClick: function (ctx) { ctx.close(); } }
      ]
    });
    return modal;
  }

  // ---- import dir / upload ---------------------------------------------------
  function importCounts(result) {
    var count = function (value) {
      if (Array.isArray(value)) return value.length;
      if (Number.isFinite(Number(value))) return Number(value);
      return 0;
    };
    return {
      added: count(result && result.added),
      duplicates: count(result && result.duplicates),
      skipped: count(result && result.skipped),
      errors: count(result && result.errors),
      skippedList: result && Array.isArray(result.skipped) ? result.skipped : [],
      errorList: result && Array.isArray(result.errors) ? result.errors : []
    };
  }

  function reportImportResult(result, prefix) {
    var counts = importCounts(result);
    var title = prefix || '导入';
    toast(
      title + '完成：新增 ' + counts.added + '，重复 ' + counts.duplicates + '，跳过 ' + counts.skipped + '，失败 ' + counts.errors,
      counts.errors > 0 ? 'warn' : 'success',
      6000
    );
    if (!counts.skippedList.length && !counts.errorList.length) return;
    var skippedHtml = counts.skippedList.slice(0, 100).map(function (item) {
      var name = (item && (item.path || item.name)) || '';
      var reason = (item && (item.reason || item.message)) || '跳过';
      return '<li><code class="mono">' + esc(name) + '</code>：' + esc(reason) + '</li>';
    }).join('');
    var errorHtml = counts.errorList.slice(0, 100).map(function (item) {
      var text = typeof item === 'string' ? item : (item && (item.message || item.error)) || safeJson(item);
      return '<li>' + esc(text) + '</li>';
    }).join('');
    openModal({
      title: title + '详情',
      wide: true,
      bodyHtml:
        '<div class="detail-block"><h4>跳过 ' + counts.skipped + ' 个</h4><ul class="plain-list">' + (skippedHtml || '<li class="muted">无</li>') + '</ul></div>' +
        '<div class="detail-block"><h4>失败 ' + counts.errors + ' 个</h4><ul class="plain-list">' + (errorHtml || '<li class="muted">无</li>') + '</ul></div>',
      actions: [{ label: '关闭', onClick: function (ctx) { ctx.close(); } }]
    });
  }

  async function scanImportDir() {
    var result = await api('stickers.scanDir');
    var files = result && Array.isArray(result.files) ? result.files.filter(function (file) { return file && file.path; }) : [];
    var bodyHtml;
    if (!files.length) {
      bodyHtml = '<p class="muted">import 目录没有可导入的图片文件。</p><p class="muted small">把图片放进 qqbot/import/ 目录后重新扫描即可。</p>';
    } else {
      var rows = files.slice(0, 200).map(function (file) {
        return '<tr><td>' + esc(file.name || '') + '</td><td>' + fmtBytes(file.size) + '</td><td class="mono muted">' + esc(file.path || '') + '</td></tr>';
      }).join('');
      bodyHtml =
        '<p>在 import 目录找到 <strong>' + files.length + '</strong> 个图片文件，可选择标签与图层后导入。</p>' +
        '<div class="form-grid">' +
        '<label class="field"><span class="field-label">导入标签（逗号分隔）</span><input type="text" data-field="tags" placeholder="例如：搞笑, 表情" /></label>' +
        '<label class="field"><span class="field-label">导入图层</span><select data-field="layer">' + layerOptions('candidate') + '</select></label>' +
        '</div>' +
        '<div class="table-wrap scan-list"><table class="data-table"><thead><tr><th>文件名</th><th>大小</th><th>路径</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        (files.length > 200 ? '<p class="muted small">仅显示前 200 个文件</p>' : '');
    }
    openModal({
      title: '扫描 import 目录',
      wide: true,
      bodyHtml: bodyHtml,
      actions: files.length
        ? [
            { label: '取消', onClick: function (ctx) { ctx.close(); } },
            {
              label: '导入全部',
              className: 'btn btn-primary',
              busyLabel: '导入中…',
              onClick: async function (ctx) {
                var tagsInput = ctx.body.querySelector('[data-field="tags"]');
                var layerSelect = ctx.body.querySelector('[data-field="layer"]');
                var result = await api('stickers.importDir', {
                  tags: parseTags(tagsInput ? tagsInput.value : ''),
                  layer: (layerSelect && layerSelect.value) || 'candidate'
                });
                ctx.close();
                await refreshStickerData();
                reportImportResult(result, '导入');
              }
            }
          ]
        : [{ label: '关闭', onClick: function (ctx) { ctx.close(); } }]
    });
  }

  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var result = typeof reader.result === 'string' ? reader.result : '';
        var comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : '');
      };
      reader.onerror = function () {
        reject(new Error('读取文件失败：' + (file && file.name ? file.name : '')));
      };
      reader.readAsDataURL(file);
    });
  }

  async function uploadStickerFiles(files, options, onProgress) {
    var opts = options || {};
    var batches = [];
    var current = [];
    var currentSize = 0;
    for (var i = 0; i < files.length; i += 1) {
      var file = files[i];
      var text = '';
      try {
        text = await fileToBase64(file);
      } catch (err) {
        batches.push([{ name: file.name, error: errMessage(err) }]);
        continue;
      }
      if (!text) continue;
      if (text.length > 24 * 1024 * 1024) {
        batches.push([{ name: file.name, error: '文件过大' }]);
        continue;
      }
      current.push({ name: file.name, dataBase64: text });
      currentSize += text.length;
      if (current.length >= 10 || currentSize >= 12 * 1024 * 1024) {
        batches.push(current);
        current = [];
        currentSize = 0;
      }
      if (typeof onProgress === 'function') onProgress(i + 1, files.length);
    }
    if (current.length) batches.push(current);

    var aggregate = { added: [], duplicates: [], skipped: [], errors: [] };
    for (var b = 0; b < batches.length; b += 1) {
      var apiFiles = [];
      for (var j = 0; j < batches[b].length; j += 1) {
        var entry = batches[b][j];
        if (entry.error) aggregate.errors.push({ name: entry.name, error: entry.error });
        else apiFiles.push({ name: entry.name, dataBase64: entry.dataBase64 });
      }
      if (!apiFiles.length) continue;
      var result = await api('stickers.upload', {
        files: apiFiles,
        tags: opts.tags || [],
        desc: opts.desc || '',
        layer: opts.layer || 'candidate'
      });
      if (result && Array.isArray(result.added)) aggregate.added.push.apply(aggregate.added, result.added);
      if (result && Array.isArray(result.duplicates)) aggregate.duplicates.push.apply(aggregate.duplicates, result.duplicates);
      if (result && Array.isArray(result.skipped)) aggregate.skipped.push.apply(aggregate.skipped, result.skipped);
      if (result && Array.isArray(result.errors)) aggregate.errors.push.apply(aggregate.errors, result.errors);
    }
    return aggregate;
  }

  function openUploadModal(files) {
    var totalSize = files.reduce(function (sum, file) { return sum + (Number(file.size) || 0); }, 0);
    var fileList = files.slice(0, 100).map(function (file) {
      return '<li>' + esc(file.name) + '<span class="muted">' + fmtBytes(file.size) + '</span></li>';
    }).join('');
    openModal({
      title: '上传表情包',
      wide: true,
      bodyHtml:
        '<p>已选择 <strong>' + files.length + '</strong> 个文件（共 ' + fmtBytes(totalSize) + '），将转换为 base64 提交到表情包库。</p>' +
        '<div class="form-grid">' +
        '<label class="field"><span class="field-label">标签（逗号分隔）</span><input type="text" data-field="tags" placeholder="例如：可爱, 猫" /></label>' +
        '<label class="field"><span class="field-label">描述（可选）</span><input type="text" data-field="desc" /></label>' +
        '<label class="field"><span class="field-label">图层</span><select data-field="layer">' + layerOptions('candidate') + '</select></label>' +
        '</div>' +
        '<div class="file-list-wrap"><div class="field-label">待上传文件</div><ul class="file-list">' + fileList + '</ul>' +
        (files.length > 100 ? '<p class="muted small">仅显示前 100 个文件</p>' : '') + '</div>',
      actions: [
        { label: '取消', onClick: function (ctx) { ctx.close(); } },
        {
          label: '开始上传',
          className: 'btn btn-primary',
          busyLabel: '读取文件中…',
          onClick: async function (ctx) {
            var tagsInput = ctx.body.querySelector('[data-field="tags"]');
            var descInput = ctx.body.querySelector('[data-field="desc"]');
            var layerSelect = ctx.body.querySelector('[data-field="layer"]');
            var result = await uploadStickerFiles(
              files,
              {
                tags: parseTags(tagsInput ? tagsInput.value : ''),
                desc: String((descInput && descInput.value) || '').trim(),
                layer: (layerSelect && layerSelect.value) || 'candidate'
              },
              function (done, total) {
                if (ctx.button && ctx.button.isConnected) ctx.button.textContent = '上传中 ' + done + '/' + total + '…';
              }
            );
            ctx.close();
            await refreshStickerData();
            reportImportResult(result, '上传');
          }
        }
      ]
    });
  }

  async function batchStickerTagUpdate(addTags, removeTags) {
    var ids = Array.from(state.stickers.selected);
    if (!ids.length) {
      toast('请先选择表情包', 'warn');
      return;
    }
    var args = { ids: ids };
    if (addTags && addTags.length) args.addTags = addTags;
    if (removeTags && removeTags.length) args.removeTags = removeTags;
    var result = await api('stickers.batchUpdate', args);
    var updated = result && Number.isFinite(Number(result.updated)) ? Number(result.updated) : ids.length;
    toast('已更新 ' + updated + ' 张表情包', 'success');
    await loadStickerStats();
    await loadStickers();
  }

  async function batchStickerLayer(layerValue) {
    var ids = Array.from(state.stickers.selected);
    if (!ids.length) {
      toast('请先选择表情包', 'warn');
      return;
    }
    var result = await api('stickers.batchUpdate', { ids: ids, layer: layerValue });
    var updated = result && Number.isFinite(Number(result.updated)) ? Number(result.updated) : ids.length;
    toast('已将 ' + updated + ' 张表情包移动到「' + layerLabel(layerValue) + '」', 'success');
    state.stickers.selected.clear();
    await loadStickerStats();
    await loadStickers();
  }

  async function batchStickerPerItem(method, ids, successText) {
    var ok = 0;
    var failed = 0;
    for (var i = 0; i < ids.length; i += 1) {
      try {
        await api(method, { id: ids[i] });
        ok += 1;
      } catch (err) {
        failed += 1;
      }
    }
    ids.forEach(function (id) {
      state.stickers.selected.delete(id);
    });
    toast(successText + '：成功 ' + ok + (failed ? '，失败 ' + failed : ''), failed ? 'warn' : 'success');
    await loadStickerStats();
    await loadStickers();
  }

  async function batchTrashStickers() {
    var ids = Array.from(state.stickers.selected);
    if (!ids.length) {
      toast('请先选择表情包', 'warn');
      return;
    }
    await batchStickerPerItem('stickers.remove', ids, '移入回收站');
  }

  async function batchPurgeStickers() {
    var ids = Array.from(state.stickers.selected);
    if (!ids.length) {
      toast('请先选择表情包', 'warn');
      return;
    }
    var confirmed = await confirmModal({
      title: '批量彻底删除',
      message: '确定彻底删除选中的 ' + ids.length + ' 张表情包吗？文件与索引都会被移除，无法恢复。',
      confirmLabel: '删除',
      danger: true
    });
    if (!confirmed) return;
    await batchStickerPerItem('stickers.purge', ids, '彻底删除');
  }

  // ---------------------------------------------------------------------------
  // 预算
  // ---------------------------------------------------------------------------
  function renderBudgetTableChats(rows, currency) {
    if (!rows.length) return emptyHtml('暂无按会话数据');
    var body = rows.map(function (row) {
      return (
        '<tr><td class="mono">' + esc(row.chatId || '—') + '</td>' +
        '<td class="num">' + fmtNum(row.calls) + '</td>' +
        '<td class="num">' + fmtNum(row.totalTokens) + '</td>' +
        '<td class="num">' + fmtCost(row.cost, currency) + '</td>' +
        '<td>' + fmtAgo(row.lastAt) + '</td></tr>'
      );
    }).join('');
    return (
      '<div class="table-wrap"><table class="data-table"><thead><tr><th>会话</th><th>调用</th><th>tokens</th><th>费用</th><th>最近调用</th></tr></thead><tbody>' +
      body + '</tbody></table></div>'
    );
  }

  function renderBudgetTableEvents(events, currency) {
    if (!events.length) return emptyHtml('暂无调用记录');
    var body = events.slice(0, 100).map(function (event) {
      return (
        '<tr><td>' + fmtTime(event.ts) + '</td>' +
        '<td class="mono">' + esc(event.chatId || '—') + '</td>' +
        '<td>' + esc((event.provider || '') + (event.model ? ' / ' + event.model : '')) + '</td>' +
        '<td class="num">' + fmtNum(event.totalTokens) + '</td>' +
        '<td class="num">' + fmtCost(event.cost, currency) + '</td></tr>'
      );
    }).join('');
    return (
      '<div class="table-wrap"><table class="data-table"><thead><tr><th>时间</th><th>会话</th><th>模型</th><th>tokens</th><th>费用</th></tr></thead><tbody>' +
      body + '</tbody></table></div>'
    );
  }

  function renderBudget() {
    var cardsEl = $('#budgetCards');
    var limitsEl = $('#budgetLimits');
    var chatsEl = $('#budgetChats');
    var eventsEl = $('#budgetEvents');
    if (!cardsEl) return;
    var data = state.budget || {};
    var snapshot = data.snapshot;
    if (!snapshot) {
      cardsEl.innerHTML = emptyHtml(data.error ? '预算数据加载失败：' + data.error : '正在加载…');
      if (limitsEl) limitsEl.innerHTML = '';
      if (chatsEl) chatsEl.innerHTML = '';
      if (eventsEl) eventsEl.innerHTML = '';
      return;
    }
    var today = snapshot.today || {};
    var month = snapshot.month && typeof snapshot.month === 'object' ? snapshot.month : {};
    var monthLabel = snapshot.monthKey || (typeof snapshot.month === 'string' ? snapshot.month : '—');
    var limits = snapshot.limits || {};
    var currency = snapshot.currency || 'CNY';
    var cards = [
      cardHtml({
        title: '今日用量',
        valueHtml: fmtNum(today.totalTokens) + ' <span class="stat-unit">tokens</span>',
        sub: '日期 ' + String(snapshot.date || '—'),
        extraHtml: progressHtml(today.totalTokens, limits.dailyTokens, '日 tokens 限额'),
        rows: [
          kvHtml('调用次数', fmtNum(today.calls)),
          kvHtml('输入 tokens', fmtNum(today.inputTokens)),
          kvHtml('输出 tokens', fmtNum(today.outputTokens)),
          kvHtml('费用', fmtCost(today.cost, currency))
        ]
      }),
      cardHtml({
        title: '本月用量',
        valueHtml: fmtNum(month.totalTokens) + ' <span class="stat-unit">tokens</span>',
        sub: '月份 ' + String(monthLabel || '—'),
        extraHtml: progressHtml(month.totalTokens, limits.monthlyTokens, '月 tokens 限额'),
        rows: [
          kvHtml('调用次数', fmtNum(month.calls)),
          kvHtml('输入 tokens', fmtNum(month.inputTokens)),
          kvHtml('输出 tokens', fmtNum(month.outputTokens)),
          kvHtml('费用', fmtCost(month.cost, currency))
        ]
      }),
      cardHtml({
        title: '限额与币种',
        valueHtml: esc(currency),
        sub: '限额为 0 表示不限制',
        rows: [
          kvHtml('每日 tokens', limitText(limits.dailyTokens)),
          kvHtml('每月 tokens', limitText(limits.monthlyTokens)),
          kvHtml('单会话每日', limitText(limits.perChatDailyTokens)),
          kvHtml('每日调用次数', limitText(limits.dailyCalls))
        ]
      })
    ];
    cardsEl.innerHTML = cards.join('');

    if (limitsEl) {
      limitsEl.innerHTML = [
        progressHtml(today.totalTokens, limits.dailyTokens, '今日 tokens'),
        progressHtml(today.calls, limits.dailyCalls, '今日调用次数'),
        progressHtml(month.totalTokens, limits.monthlyTokens, '本月 tokens')
      ].join('');
    }

    var chats = Array.isArray(snapshot.chats) ? snapshot.chats : [];
    chats = chats.filter(function (row) { return row && row.chatId; });
    if (chatsEl) chatsEl.innerHTML = renderBudgetTableChats(chats, currency);

    var eventsResult = data.events;
    var events = eventsResult && Array.isArray(eventsResult.events) ? eventsResult.events : [];
    if (eventsEl) eventsEl.innerHTML = renderBudgetTableEvents(events, currency);
  }

  function limitText(value) {
    var num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return '不限';
    return fmtNum(num);
  }

  async function loadBudget() {
    var results = await Promise.allSettled([api('budget.snapshot'), api('budget.events', { limit: 100 })]);
    var snapshotResult = results[0];
    var eventsResult = results[1];
    if (snapshotResult.status === 'rejected') {
      state.budget = { snapshot: null, events: null, error: errMessage(snapshotResult.reason) };
      renderBudget();
      throw snapshotResult.reason;
    }
    state.budget = {
      snapshot: snapshotResult.value && typeof snapshotResult.value === 'object' ? snapshotResult.value : {},
      events: eventsResult.status === 'fulfilled' ? eventsResult.value : null,
      error: ''
    };
    renderBudget();
  }

  function resetBudget(scope) {
    var labels = { today: '今日用量', month: '本月用量', all: '全部用量' };
    return confirmModal({
      title: '重置' + (labels[scope] || ''),
      message: '确定重置' + (labels[scope] || '') + '吗？重置后统计数据不可恢复。',
      confirmLabel: '重置',
      danger: true
    }).then(async function (confirmed) {
      if (!confirmed) return;
      await api('budget.reset', { scope: scope });
      toast('已重置' + (labels[scope] || ''), 'success');
      await loadBudget();
      refreshSnapshot({ silent: true }).catch(function () {});
    });
  }

  // ---------------------------------------------------------------------------
  // 会话
  // ---------------------------------------------------------------------------
  function renderChatList() {
    var listEl = $('#chatList');
    if (!listEl) return;
    var chats = Array.isArray(state.chats.items) ? state.chats.items : [];
    if (!chats.length) {
      listEl.innerHTML = emptyHtml('暂无会话');
      return;
    }
    listEl.innerHTML = chats.map(function (chat) {
      var active = chat.chatId === state.chats.current;
      var kind = chat.kind === 'group' ? '群聊' : '单聊';
      return (
        '<button type="button" class="list-item' + (active ? ' is-active' : '') + '" data-chat-id="' + esc(chat.chatId) + '">' +
        '<span class="list-item-title">' + esc(chat.title || chat.chatId) + '</span>' +
        '<span class="list-item-sub"><span class="kind-badge">' + kind + '</span>' +
        '<span class="muted">' + fmtNum(chat.messageCount) + ' 条</span>' +
        '<span class="muted">' + fmtAgo(chat.lastAt) + '</span>' +
        (Number(chat.factsCount) > 0 ? '<span class="muted">事实 ' + fmtNum(chat.factsCount) + '</span>' : '') +
        '</span>' +
        '<span class="list-item-id mono">' + esc(chat.chatId) + '</span>' +
        '</button>'
      );
    }).join('');
  }

  function renderHistory(history) {
    var messages = Array.isArray(history) ? history : [];
    if (!messages.length) return emptyHtml('暂无历史消息');
    var omitted = Math.max(0, messages.length - 200);
    var shown = messages.slice(-200);
    var html = shown.map(function (message) {
      var role = message && message.role === 'assistant' ? 'assistant' : 'user';
      var roleLabel = role === 'assistant' ? '机器人' : '用户';
      var meta = [];
      if (message && message.userName) meta.push(esc(message.userName));
      else if (message && message.userId) meta.push(esc(message.userId));
      if (message && message.stickerTags && message.stickerTags.length) {
        meta.push('表情：' + message.stickerTags.map(function (tag) { return '#' + esc(tag); }).join(' '));
      }
      return (
        '<div class="msg msg-' + role + '">' +
        '<div class="msg-head"><span class="msg-role">' + roleLabel + '</span>' +
        meta.map(function (item) { return '<span class="muted small">' + item + '</span>'; }).join('') +
        '<span class="msg-time muted">' + fmtTime(message && message.ts) + '</span></div>' +
        '<div class="msg-content">' + esc((message && message.content) || '') + '</div>' +
        '</div>'
      );
    }).join('');
    return '<div class="msg-list">' + html + '</div>' + (omitted > 0 ? '<p class="muted small">仅显示最近 200 条，另有 ' + omitted + ' 条更早消息</p>' : '');
  }

  function renderFacts(facts) {
    var list = (Array.isArray(facts) ? facts : []).map(function (fact) {
      return typeof fact === 'string' ? fact : (fact && (fact.text || fact.fact)) || safeJson(fact);
    }).filter(Boolean);
    if (!list.length) return emptyHtml('暂无长期事实');
    return '<ul class="fact-list">' + list.map(function (fact) {
      return '<li>' + esc(fact) + '</li>';
    }).join('') + '</ul>';
  }

  function renderSummary(summary) {
    if (!summary) return emptyHtml('暂无摘要');
    var text = typeof summary === 'string' ? summary : summary.text || '';
    var covered = typeof summary === 'object' && summary.coveredCount !== undefined ? ' · 覆盖 ' + fmtNum(summary.coveredCount) + ' 条' : '';
    var updated = typeof summary === 'object' && summary.updatedAt ? ' · 更新于 ' + fmtTime(summary.updatedAt) : '';
    if (!text) return emptyHtml('暂无摘要') + (covered || updated ? '<p class="muted small">' + esc(covered + updated) + '</p>' : '');
    return '<div class="summary-box">' + esc(text) + '</div><p class="muted small">' + esc((covered + updated).replace(/^ · /, '')) + '</p>';
  }

  function renderChatDetail() {
    var detailEl = $('#chatDetail');
    if (!detailEl) return;
    var result = state.chats.detail;
    if (!result || !result.chat) {
      detailEl.innerHTML = emptyHtml('从左侧选择一个会话查看详情');
      return;
    }
    var chat = result.chat;
    var persona = result.persona || null;
    var history = Array.isArray(chat.history) ? chat.history : [];
    var facts = Array.isArray(chat.facts) ? chat.facts : [];
    var counters = chat.counters || {};
    var chatId = String(chat.id || state.chats.current || '');
    var personaFields = persona || {};
    var inputValue = function (value) {
      return esc(value === null || value === undefined ? '' : value);
    };
    detailEl.innerHTML =
      '<div class="detail-head">' +
      '<div><h3 class="detail-title">' + esc(chat.title || chatId) + '</h3>' +
      '<div class="muted mono small">' + esc(chatId) + '</div>' +
      '<div class="detail-meta muted small">消息 ' + fmtNum(history.length) +
      ' · 用户消息 ' + fmtNum(counters.userMessages) +
      ' · 长期事实 ' + fmtNum(facts.length) +
      '</div></div>' +
      '<div class="detail-actions">' +
      '<button type="button" class="btn btn-sm" data-act="compress">压缩上下文</button>' +
      '<button type="button" class="btn btn-sm" data-act="extract">抽取记忆</button>' +
      '<button type="button" class="btn btn-sm btn-danger-ghost" data-act="clear">清空上下文</button>' +
      '</div></div>' +
      '<details class="detail-block" open><summary>人设覆盖</summary>' +
      (persona ? '<p class="muted small">该会话已有个性化覆盖；留空表示删除对应字段。</p>' : '<p class="muted small">该会话暂无个性化覆盖，填写后会创建覆盖。</p>') +
      '<div class="form-grid persona-form">' +
      '<label class="field"><span class="field-label">名字</span><input type="text" data-field="name" value="' + inputValue(personaFields.name) + '" placeholder="留空使用全局人设" /></label>' +
      '<label class="field"><span class="field-label">模型</span><input type="text" data-field="model" value="' + inputValue(personaFields.model) + '" placeholder="留空使用默认模型" /></label>' +
      '<label class="field"><span class="field-label">风格</span><input type="text" data-field="style" value="' + inputValue(personaFields.style) + '" /></label>' +
      '<label class="field"><span class="field-label">表情频率 (0-1)</span><input type="number" min="0" max="1" step="0.05" data-field="stickerChance" value="' + inputValue(personaFields.stickerChance) + '" /></label>' +
      '<label class="field"><span class="field-label">回复最大字数</span><input type="number" min="100" max="4000" data-field="replyMaxChars" value="' + inputValue(personaFields.replyMaxChars) + '" /></label>' +
      '<label class="field field-wide"><span class="field-label">系统提示</span><textarea rows="2" data-field="systemPrompt">' + inputValue(personaFields.systemPrompt) + '</textarea></label>' +
      '</div>' +
      '<div class="row-actions"><button type="button" class="btn btn-primary btn-sm" data-act="persona-save">保存覆盖</button>' +
      '<button type="button" class="btn btn-sm" data-act="persona-delete">删除覆盖</button></div>' +
      '</details>' +
      '<details class="detail-block"><summary>上下文摘要</summary>' + renderSummary(chat.summary) + '</details>' +
      '<details class="detail-block"><summary>长期事实</summary>' + renderFacts(facts) + '</details>' +
      '<details class="detail-block" open><summary>历史消息（' + fmtNum(history.length) + '）</summary>' + renderHistory(history) + '</details>';
  }

  async function loadChats() {
    var search = $('#chatSearch');
    var query = search ? String(search.value || '').trim() : '';
    var args = {};
    if (query) args.query = query;
    var result = await api('chats.list', args);
    var chats = result && Array.isArray(result.chats) ? result.chats.filter(function (chat) { return chat && chat.chatId; }) : [];
    state.chats.items = chats;
    if (state.chats.current && !chats.some(function (chat) { return chat.chatId === state.chats.current; })) {
      state.chats.current = '';
      state.chats.detail = null;
      var detailEl = $('#chatDetail');
      if (detailEl) detailEl.innerHTML = emptyHtml('从左侧选择一个会话查看详情');
    }
    renderChatList();
  }

  async function selectChat(chatId) {
    var detailEl = $('#chatDetail');
    if (!detailEl || !chatId) return;
    state.chats.current = chatId;
    renderChatList();
    detailEl.innerHTML = emptyHtml('加载中…');
    var result = await api('chats.get', { chatId: chatId });
    state.chats.detail = result || null;
    renderChatDetail();
  }

  function readChatPersonaPatch() {
    var detailEl = $('#chatDetail');
    if (!detailEl) return {};
    var readText = function (name) {
      var node = detailEl.querySelector('[data-field="' + name + '"]');
      if (!node) return null;
      var value = String(node.value === undefined ? '' : node.value).trim();
      return value === '' ? null : value;
    };
    var readNumber = function (name) {
      var raw = readText(name);
      if (raw === null) return null;
      var num = Number(raw);
      return Number.isFinite(num) ? num : null;
    };
    return {
      name: readText('name'),
      model: readText('model'),
      style: readText('style'),
      systemPrompt: readText('systemPrompt'),
      stickerChance: readNumber('stickerChance'),
      replyMaxChars: readNumber('replyMaxChars')
    };
  }

  async function runChatAction(action, button) {
    var chatId = state.chats.current;
    if (!chatId) {
      toast('请先选择一个会话', 'warn');
      return;
    }
    if (action === 'compress') {
      var result = await api('chats.compress', { chatId: chatId });
      if (result && result.compressed) toast('已压缩上下文，移除 ' + fmtNum(result.removed) + ' 条消息', 'success');
      else if (result && result.error) toast('压缩失败：' + result.error, 'error');
      else toast('当前无需压缩', 'info');
      await loadChats();
      await selectChat(chatId);
      return;
    }
    if (action === 'extract') {
      var extracted = await api('chats.extract', { chatId: chatId });
      var facts = extracted && Array.isArray(extracted.facts) ? extracted.facts : [];
      toast(facts.length ? '抽取到 ' + facts.length + ' 条长期事实' : '没有抽取到新的长期事实', facts.length ? 'success' : 'info');
      await loadChats();
      await selectChat(chatId);
      return;
    }
    if (action === 'clear') {
      var keep = await confirmModal({
        title: '清空上下文',
        bodyHtml:
          '<p class="confirm-text">将清空会话 <code class="mono">' + esc(chatId) + '</code> 的历史消息与摘要，此操作不可恢复。</p>' +
          '<label class="check-field"><input type="checkbox" data-role="keep-facts" checked /><span class="check-text">保留长期事实</span></label>',
        confirmLabel: '清空',
        danger: true,
        readValue: function (body) {
          var checkbox = body.querySelector('[data-role="keep-facts"]');
          return { keepFacts: !!(checkbox && checkbox.checked) };
        }
      });
      if (!keep) return;
      await api('chats.clear', { chatId: chatId, keepFacts: keep.keepFacts });
      toast('上下文已清空', 'success');
      await loadChats();
      await selectChat(chatId);
      return;
    }
    if (action === 'persona-save') {
      var patch = readChatPersonaPatch();
      var saved = await api('chats.persona.set', { chatId: chatId, patch: patch });
      toast(saved && saved.persona ? '会话人设覆盖已保存' : '已清除该会话的人设覆盖', 'success');
      await loadChats();
      await selectChat(chatId);
      return;
    }
    if (action === 'persona-delete') {
      var confirmed = await confirmModal({
        title: '删除会话人设覆盖',
        message: '确定删除该会话的所有个性化覆盖吗？删除后将使用全局人设。',
        confirmLabel: '删除',
        danger: true
      });
      if (!confirmed) return;
      await api('chats.persona.delete', { chatId: chatId });
      toast('会话人设覆盖已删除', 'success');
      await loadChats();
      await selectChat(chatId);
    }
  }

  // ---------------------------------------------------------------------------
  // 人员
  // ---------------------------------------------------------------------------
  function personFactsList(person) {
    var raw = person && Array.isArray(person.facts) ? person.facts : [];
    return raw.map(function (fact) {
      return typeof fact === 'string' ? fact : (fact && (fact.text || fact.fact)) || safeJson(fact);
    }).filter(Boolean);
  }

  function renderPeople() {
    var tableEl = $('#peopleTable');
    var countEl = $('#peopleCount');
    var people = Array.isArray(state.people.items) ? state.people.items : [];
    if (countEl) countEl.textContent = '共 ' + people.length + ' 人';
    if (!tableEl) return;
    if (!people.length) {
      tableEl.innerHTML = emptyHtml('还没有记录到人员信息，聊天后会自动出现');
      return;
    }
    var rows = people.map(function (person) {
      var id = String(person.id || '');
      var facts = personFactsList(person);
      return (
        '<tr data-openid="' + esc(id) + '">' +
        '<td class="mono">' + esc(id) + '</td>' +
        '<td>' + (person.name ? esc(person.name) : '<span class="muted">—</span>') + '</td>' +
        '<td class="num">' + fmtNum(person.messageCount) + '</td>' +
        '<td>' + fmtAgo(person.lastSeen) + '</td>' +
        '<td class="num">' + facts.length + '</td>' +
        '<td class="num"><button type="button" class="btn btn-sm" data-edit-person="' + esc(id) + '">编辑</button></td>' +
        '</tr>'
      );
    }).join('');
    tableEl.innerHTML =
      '<div class="table-wrap"><table class="data-table"><thead><tr><th>openid</th><th>昵称</th><th>消息数</th><th>最近出现</th><th>事实数</th><th></th></tr></thead><tbody>' +
      rows + '</tbody></table></div>';
  }

  function openPersonEditor(openid) {
    var person = null;
    for (var i = 0; i < state.people.items.length; i += 1) {
      if (String(state.people.items[i].id || '') === String(openid)) {
        person = state.people.items[i];
        break;
      }
    }
    if (!person) {
      toast('找不到该用户，请刷新后重试', 'warn');
      return;
    }
    var facts = personFactsList(person);
    openModal({
      title: '编辑人员',
      bodyHtml:
        '<div class="form-grid">' +
        '<label class="field"><span class="field-label">openid</span><input type="text" value="' + esc(openid) + '" disabled /></label>' +
        '<label class="field"><span class="field-label">昵称</span><input type="text" data-field="name" value="' + esc(person.name || '') + '" placeholder="留空保持不变" /></label>' +
        '<label class="field field-wide"><span class="field-label">追加事实（每行一条，可留空）</span>' +
        '<textarea rows="3" data-field="facts" placeholder="例如：喜欢猫&#10;在杭州工作"></textarea></label>' +
        '</div>' +
        '<div class="detail-block"><h4>已有事实（' + facts.length + '）</h4>' +
        (facts.length ? '<ul class="fact-list">' + facts.map(function (fact) { return '<li>' + esc(fact) + '</li>'; }).join('') + '</ul>' : '<p class="muted">暂无</p>') +
        '</div>',
      actions: [
        { label: '取消', onClick: function (ctx) { ctx.close(); } },
        {
          label: '保存',
          className: 'btn btn-primary',
          onClick: async function (ctx) {
            var nameInput = ctx.body.querySelector('[data-field="name"]');
            var factsInput = ctx.body.querySelector('[data-field="facts"]');
            var name = String((nameInput && nameInput.value) || '').trim();
            var lines = String((factsInput && factsInput.value) || '').split(/\n+/).map(function (line) { return line.trim(); }).filter(Boolean);
            var patch = {};
            if (name) patch.name = name;
            if (lines.length) patch.addFacts = lines;
            if (!Object.keys(patch).length) {
              toast('没有需要保存的修改', 'warn');
              return;
            }
            await api('people.set', { openid: openid, patch: patch });
            toast('人员信息已保存', 'success');
            ctx.close();
            await loadPeople();
          }
        }
      ]
    });
  }

  async function loadPeople() {
    var result = await api('people.list');
    state.people.items = result && Array.isArray(result.people) ? result.people.filter(function (person) { return person && person.id; }) : [];
    renderPeople();
  }

  // ---------------------------------------------------------------------------
  // 日志
  // ---------------------------------------------------------------------------
  function renderLogs() {
    var listEl = $('#logList');
    var countEl = $('#logCount');
    if (!listEl) return;
    var entries = Array.isArray(state.logs.entries) ? state.logs.entries : [];
    if (countEl) countEl.textContent = '共 ' + entries.length + ' 条';
    if (!entries.length) {
      listEl.innerHTML = emptyHtml('暂无日志');
      return;
    }
    listEl.innerHTML = entries.map(function (entry) {
      var level = String((entry && entry.level) || 'info').toLowerCase();
      var levelKey = LOG_LEVEL_LABELS[level] ? level : 'info';
      var detail = entry && entry.detail !== undefined && entry.detail !== null
        ? (typeof entry.detail === 'string' ? entry.detail : safeJson(entry.detail))
        : '';
      return (
        '<div class="log-item log-' + levelKey + '">' +
        '<span class="log-time mono">' + fmtTime(entry && entry.ts) + '</span>' +
        '<span class="log-level">' + esc(LOG_LEVEL_LABELS[levelKey]) + '</span>' +
        '<span class="log-msg">' + esc((entry && entry.msg) || '') + '</span>' +
        (detail ? '<span class="log-detail mono">' + esc(detail) + '</span>' : '') +
        '</div>'
      );
    }).join('');
    var auto = $('#logAutoScroll');
    if (auto && auto.checked) listEl.scrollTop = listEl.scrollHeight;
  }

  async function loadLogs() {
    var levelSelect = $('#logLevel');
    var level = levelSelect ? String(levelSelect.value || '') : '';
    var args = { limit: 300 };
    if (level) args.level = level;
    var result = await api('logs.recent', args);
    var entries = result && Array.isArray(result.entries) ? result.entries.slice() : [];
    entries.sort(function (a, b) {
      return (Number(a && a.ts) || 0) - (Number(b && b.ts) || 0);
    });
    state.logs.entries = entries;
    renderLogs();
  }

  // ---------------------------------------------------------------------------
  // Bindings
  // ---------------------------------------------------------------------------
  function bindGlobal() {
    document.addEventListener(
      'error',
      function (event) {
        var target = event.target;
        if (target instanceof HTMLImageElement && target.dataset.fallback !== '1') {
          target.dataset.fallback = '1';
          target.classList.add('img-error');
          target.removeAttribute('src');
          target.alt = '图片加载失败';
        }
      },
      true
    );
  }

  function bindHeader() {
    on('#exitBtn', 'click', exitConsole);
    on('#refreshBtn', 'click', function () {
      var button = $('#refreshBtn');
      handle(function () {
        return withLoading(button, async function () {
          await refreshSnapshot();
          await loadTabNow(state.tab, { force: state.tab !== 'config' });
          toast('已刷新', 'success');
        }, '刷新中…');
      });
    });
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      if (modalState) return;
      if (event.defaultPrevented) return;
      exitConsole();
    });
  }

  /**
   * Leave the console in whatever container it was opened in:
   * 0. embedded in the DSH app (qqbot console panel) → ask the parent page to
   *    switch back to the conversation without reloading the app;
   * 1. child window opened by the in-app dashboard → close it;
   * 2. same-tab navigation → go back;
   * 3. direct open in a fresh tab → navigate to the DSH app root.
   */
  function exitConsole() {
    // 0) Embedded (iframe) inside the Harness main area: hand control to the parent.
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'qqbot-console-exit' }, window.location.origin);
        return;
      }
    } catch (err) {
      // fall through to the standalone paths
    }

    var closed = false;
    try {
      var isChild = (typeof window.name === 'string' && window.name === 'qqbot-console') || (window.opener && !window.opener.closed);
      if (isChild) {
        window.close();
        closed = true;
      }
    } catch (err) {
      closed = false;
    }
    // If window.close() was refused, the page is still alive: fall back to navigation.
    setTimeout(function () {
      try {
        if (window.closed) return;
      } catch (err) {
        return;
      }
      try {
        if (window.history.length > 1) {
          window.history.back();
          return;
        }
      } catch (err) {
        // ignore and use the root fallback
      }
      try {
        window.location.assign('/');
      } catch (err) {
        toast('当前浏览器不允许关闭窗口，请手动关闭标签页或按 Alt+← 返回', 'error');
      }
    }, closed ? 150 : 0);
  }

  function bindTabs() {
    $$('.tab').forEach(function (button) {
      button.addEventListener('click', function () {
        activateTab(button.dataset.tab);
      });
    });
  }

  function bindOverview() {
    on('#btnStart', 'click', function () {
      var button = $('#btnStart');
      handle(function () {
        return withLoading(button, async function () {
          await api('gateway.start');
          toast('已启动 QQ 连接', 'success');
          await refreshSnapshot();
        }, '启动中…');
      });
    });
    on('#btnStop', 'click', function () {
      var button = $('#btnStop');
      handle(function () {
        return withLoading(button, async function () {
          await api('gateway.stop');
          toast('已停止 QQ 连接', 'success');
          await refreshSnapshot();
        }, '停止中…');
      });
    });
    on('#btnReconnect', 'click', function () {
      var button = $('#btnReconnect');
      handle(function () {
        return withLoading(button, async function () {
          await api('gateway.reconnect');
          toast('正在重连 QQ 网关', 'success');
          await refreshSnapshot();
        }, '重连中…');
      });
    });
    on('#btnTestQQ', 'click', function () {
      var button = $('#btnTestQQ');
      handle(function () {
        return withLoading(button, testQQCredentials, '测试中…');
      });
    });
    on('#btnTestLLM', 'click', function () {
      var button = $('#btnTestLLM');
      handle(function () {
        return withLoading(button, testLlm, '测试中…');
      });
    });
  }

  function bindConfig() {
    on('#btnConfigSave', 'click', function () {
      handle(saveConfig);
    });
    on('#btnConfigRefresh', 'click', function () {
      var button = $('#btnConfigRefresh');
      handle(function () {
        return withLoading(button, async function () {
          await loadConfig();
          toast('已重新读取配置', 'success');
        }, '读取中…');
      });
    });
    var form = $('#configForm');
    if (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        handle(saveConfig);
      });
    }
  }

  function bindStickers() {
    on('#btnStickerRefresh', 'click', function () {
      var button = $('#btnStickerRefresh');
      handle(function () {
        return withLoading(button, refreshStickerData, '刷新中…');
      });
    });
    on('#btnStickerUpload', 'click', function () {
      var input = $('#stickerFileInput');
      if (input) input.click();
    });
    on('#stickerFileInput', 'change', function () {
      var input = $('#stickerFileInput');
      var files = input && input.files ? Array.prototype.slice.call(input.files) : [];
      if (input) input.value = '';
      if (!files.length) return;
      openUploadModal(files);
    });
    on('#btnStickerScan', 'click', function () {
      var button = $('#btnStickerScan');
      handle(function () {
        return withLoading(button, scanImportDir, '扫描中…');
      });
    });
    on('#stickerLayerTabs', 'click', function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      var button = target.closest('[data-layer]');
      if (!button) return;
      var layer = button.dataset.layer || '';
      if (layer === state.stickers.layer) return;
      state.stickers.layer = layer;
      resetStickerSelection();
      renderStickerLayerTabs();
      handle(function () {
        return loadStickers();
      });
    });
    on('#stickerTagChips', 'click', function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('[data-clear-tags]')) {
        state.stickers.tags = [];
        resetStickerSelection();
        renderStickerTagChips();
        handle(function () {
          return loadStickers();
        });
        return;
      }
      var chip = target.closest('[data-tag]');
      if (!chip) return;
      var tag = chip.dataset.tag || '';
      var index = state.stickers.tags.indexOf(tag);
      if (index >= 0) state.stickers.tags.splice(index, 1);
      else state.stickers.tags.push(tag);
      resetStickerSelection();
      renderStickerTagChips();
      handle(function () {
        return loadStickers();
      });
    });
    var search = $('#stickerSearch');
    if (search) {
      var runSearch = debounce(function () {
        var value = String(search.value || '').trim();
        if (value === state.stickers.query) return;
        state.stickers.query = value;
        resetStickerSelection();
        handle(function () {
          return loadStickers();
        });
      }, 350);
      search.addEventListener('input', runSearch);
      search.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          state.stickers.query = String(search.value || '').trim();
          resetStickerSelection();
          handle(function () {
            return loadStickers();
          });
        }
      });
    }
    on('#stickerSelectAll', 'change', function () {
      var all = $('#stickerSelectAll');
      var checked = !!(all && all.checked);
      var st = state.stickers;
      st.items.forEach(function (item) {
        if (checked) st.selected.add(item.id);
        else st.selected.delete(item.id);
      });
      renderStickerGrid();
    });
    var grid = $('#stickerGrid');
    if (grid) {
      grid.addEventListener('click', function (event) {
        var target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest('.sticker-check')) return;
        var card = target.closest('.sticker-card');
        if (!card) return;
        openStickerEditor(card.dataset.id);
      });
      grid.addEventListener('change', function (event) {
        var target = event.target;
        if (!(target instanceof Element)) return;
        var checkbox = target.closest('.sticker-check-input');
        if (!checkbox) return;
        var id = checkbox.dataset.id;
        if (checkbox.checked) state.stickers.selected.add(id);
        else state.stickers.selected.delete(id);
        var card = checkbox.closest('.sticker-card');
        if (card) card.classList.toggle('is-selected', checkbox.checked);
        updateStickerBulkBar();
        updateStickerSelectAll();
      });
      grid.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter') return;
        var target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest('.sticker-check')) return;
        var card = target.closest('.sticker-card');
        if (card) openStickerEditor(card.dataset.id);
      });
    }
    on('#btnStickerMore', 'click', function () {
      var button = $('#btnStickerMore');
      handle(function () {
        return withLoading(button, function () {
          return loadStickers({ append: true });
        }, '加载中…');
      });
    });
    on('#btnBulkAddTags', 'click', function () {
      var button = $('#btnBulkAddTags');
      handle(function () {
        return withLoading(button, async function () {
          var input = $('#bulkAddTags');
          var tags = parseTags(input ? input.value : '');
          if (!tags.length) {
            toast('请填写要添加的标签（逗号分隔）', 'warn');
            return;
          }
          await batchStickerTagUpdate(tags, null);
          if (input) input.value = '';
        }, '处理中…');
      });
    });
    on('#btnBulkRemoveTags', 'click', function () {
      var button = $('#btnBulkRemoveTags');
      handle(function () {
        return withLoading(button, async function () {
          var input = $('#bulkRemoveTags');
          var tags = parseTags(input ? input.value : '');
          if (!tags.length) {
            toast('请填写要移除的标签（逗号分隔）', 'warn');
            return;
          }
          await batchStickerTagUpdate(null, tags);
          if (input) input.value = '';
        }, '处理中…');
      });
    });
    on('#btnBulkLayerApply', 'click', function () {
      var button = $('#btnBulkLayerApply');
      handle(function () {
        return withLoading(button, async function () {
          var select = $('#bulkLayer');
          var layer = select ? String(select.value || '') : '';
          if (!layer) {
            toast('请选择要切换到的图层', 'warn');
            return;
          }
          await batchStickerLayer(layer);
          if (select) select.value = '';
        }, '处理中…');
      });
    });
    on('#btnBulkTrash', 'click', function () {
      var button = $('#btnBulkTrash');
      handle(function () {
        return withLoading(button, batchTrashStickers, '处理中…');
      });
    });
    on('#btnBulkPurge', 'click', function () {
      var button = $('#btnBulkPurge');
      handle(function () {
        return withLoading(button, batchPurgeStickers, '处理中…');
      });
    });
    on('#btnBulkClear', 'click', function () {
      resetStickerSelection();
      renderStickerGrid();
    });
    renderStickerLayerTabs();
    renderStickerTagChips();
    renderStickerGrid();
  }

  function bindBudget() {
    on('#btnBudgetRefresh', 'click', function () {
      var button = $('#btnBudgetRefresh');
      handle(function () {
        return withLoading(button, loadBudget, '刷新中…');
      });
    });
    on('#btnBudgetResetToday', 'click', function () {
      var button = $('#btnBudgetResetToday');
      handle(function () {
        return withLoading(button, function () { return resetBudget('today'); }, '重置中…');
      });
    });
    on('#btnBudgetResetMonth', 'click', function () {
      var button = $('#btnBudgetResetMonth');
      handle(function () {
        return withLoading(button, function () { return resetBudget('month'); }, '重置中…');
      });
    });
    on('#btnBudgetResetAll', 'click', function () {
      var button = $('#btnBudgetResetAll');
      handle(function () {
        return withLoading(button, function () { return resetBudget('all'); }, '重置中…');
      });
    });
  }

  function bindChats() {
    on('#btnChatsRefresh', 'click', function () {
      var button = $('#btnChatsRefresh');
      handle(function () {
        return withLoading(button, async function () {
          await loadChats();
          if (state.chats.current) await selectChat(state.chats.current);
        }, '刷新中…');
      });
    });
    var search = $('#chatSearch');
    if (search) {
      search.addEventListener(
        'input',
        debounce(function () {
          handle(loadChats);
        }, 350)
      );
    }
    var list = $('#chatList');
    if (list) {
      list.addEventListener('click', function (event) {
        var target = event.target;
        if (!(target instanceof Element)) return;
        var item = target.closest('[data-chat-id]');
        if (item) handle(function () { return selectChat(item.dataset.chatId); });
      });
    }
    var detail = $('#chatDetail');
    if (detail) {
      detail.addEventListener('click', function (event) {
        var target = event.target;
        if (!(target instanceof Element)) return;
        var button = target.closest('[data-act]');
        if (!button) return;
        var action = button.dataset.act;
        handle(function () {
          return withLoading(button, function () { return runChatAction(action, button); }, '处理中…');
        });
      });
    }
  }

  function bindPeople() {
    on('#btnPeopleRefresh', 'click', function () {
      var button = $('#btnPeopleRefresh');
      handle(function () {
        return withLoading(button, loadPeople, '刷新中…');
      });
    });
    var table = $('#peopleTable');
    if (table) {
      table.addEventListener('click', function (event) {
        var target = event.target;
        if (!(target instanceof Element)) return;
        var trigger = target.closest('[data-edit-person]');
        if (trigger) {
          openPersonEditor(trigger.dataset.editPerson);
          return;
        }
        var row = target.closest('[data-openid]');
        if (row) openPersonEditor(row.dataset.openid);
      });
    }
  }

  function bindLogs() {
    on('#btnLogsRefresh', 'click', function () {
      var button = $('#btnLogsRefresh');
      handle(function () {
        return withLoading(button, loadLogs, '刷新中…');
      });
    });
    on('#logLevel', 'change', function () {
      handle(loadLogs);
    });
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  function boot() {
    if (state.booted) return;
    state.booted = true;
    bindGlobal();
    bindHeader();
    bindTabs();
    bindOverview();
    bindConfig();
    bindStickers();
    bindBudget();
    bindChats();
    bindPeople();
    bindLogs();
    renderOverview();
    activateTab('overview');
    state.pollTimer = window.setInterval(function () {
      if (document.hidden) return;
      refreshSnapshot({ silent: true }).catch(function () {});
    }, 25000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
