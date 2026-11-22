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
  var OUTPUT_MEDIA_ROOT = BASE_PATH + '/media/output';

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

  var OUTPUT_KIND_LABELS = { image: '图片', audio: '语音', video: '视频' };
  var OUTPUT_KIND_ICONS = { image: '▧', audio: '♫', video: '▶' };
  var OUTPUT_KIND_PROMPTS = {
    image: '一只在窗台上晒太阳的橘猫，水彩风格，细节丰富',
    audio: '你好呀，今天也要开心。',
    video: '海边日落，镜头缓慢向前推进，暖色调'
  };

  // Top-level navigation is task-oriented. Configuration lives with the feature
  // it belongs to (no global "all config" page and no duplicated parent/child
  // config items). Pages that need multiple facets expose local sub-tabs, and
  // every sub-tab is addressable through the hash route (#/page/subtab).
  var NAV_GROUPS = [
    {
      title: '运行',
      items: [{ id: 'overview', label: '概览', desc: '状态、警告与快捷入口', icon: '◎' }]
    },
    {
      title: '智能与内容',
      items: [
        { id: 'dialog', label: '对话', desc: '人设 / 模型 / 记忆 / 命令权限', icon: '☺' },
        { id: 'multimodal', label: '多模态', desc: '识别（输入）与生成（输出）', icon: '✦' },
        { id: 'stickers', label: '表情包', desc: '图库打标与行为设置', icon: '❏' }
      ]
    },
    {
      title: '运营',
      items: [
        { id: 'budget', label: '预算', desc: '用量明细与限额设置', icon: '¥' },
        { id: 'chats', label: '会话', desc: '历史、摘要与长期事实', icon: '▣' },
        { id: 'people', label: '人员', desc: '用户画像与长期事实', icon: '☷' }
      ]
    },
    {
      title: '系统',
      items: [
        { id: 'system', label: '系统设置', desc: 'QQ 接入、管理后台、日志与调试', icon: '⚙' },
        { id: 'logs', label: '运行日志', desc: '最近运行日志与排查', icon: '≡' }
      ]
    }
  ];

  var PAGE_META = {
    overview: { group: '运行', title: '概览', desc: '运行状态与快捷入口' },
    dialog: { group: '智能与内容', title: '对话', desc: '人设、模型、记忆与命令权限' },
    multimodal: { group: '智能与内容', title: '多模态', desc: '识别输入与生成输出' },
    stickers: { group: '智能与内容', title: '表情包', desc: '图库打标与行为设置' },
    budget: { group: '运营', title: '预算', desc: '用量与限额' },
    chats: { group: '运营', title: '会话', desc: '历史、摘要与记忆' },
    people: { group: '运营', title: '人员', desc: '用户画像与事实' },
    system: { group: '系统', title: '系统设置', desc: 'QQ 接入、管理后台与日志' },
    logs: { group: '系统', title: '运行日志', desc: '最近运行日志' }
  };

  var DEFAULT_SUBTAB = {
    dialog: 'persona',
    multimodal: 'input',
    stickers: 'library',
    budget: 'usage',
    system: 'qq'
  };

  var PAGE_TABS = {
    dialog: [
      { key: 'persona', label: '人设', sections: ['persona'] },
      { key: 'model', label: '模型与回复', sections: ['llm'] },
      { key: 'memory', label: '记忆与压缩', sections: ['memory'] },
      { key: 'commands', label: '命令与权限', sections: ['commands'] }
    ],
    multimodal: [
      { key: 'input', label: '识别（输入）', sections: ['multimodal'] },
      { key: 'output', label: '输出（图片 / 语音 / 视频）' }
    ],
    stickers: [
      { key: 'library', label: '图库与打标' },
      { key: 'settings', label: '行为设置', sections: ['stickers'] }
    ],
    budget: [
      { key: 'usage', label: '用量明细' },
      { key: 'settings', label: '限额与设置', sections: ['budget'] }
    ],
    system: [
      { key: 'qq', label: 'QQ 接入', sections: ['qq'] },
      { key: 'admin', label: '管理后台', sections: ['admin'] },
      { key: 'logging', label: '日志与调试', sections: ['logging'] }
    ]
  };

  var SETTINGS_FORMS = [
    { container: 'settings-dialog-persona', sections: ['persona'] },
    { container: 'settings-dialog-model', sections: ['llm'] },
    { container: 'settings-dialog-memory', sections: ['memory'] },
    { container: 'settings-dialog-commands', sections: ['commands'] },
    { container: 'settings-multimodal-input', sections: ['multimodal'] },
    { container: 'settings-stickers-settings', sections: ['stickers'] },
    { container: 'settings-budget-settings', sections: ['budget'] },
    { container: 'settings-system-qq', sections: ['qq'] },
    { container: 'settings-system-admin', sections: ['admin'] },
    { container: 'settings-system-logging', sections: ['logging'] }
  ];

  var QUICK_LINKS = [
    { nav: 'multimodal', section: 'output', label: '多模态输出', desc: '配置图片 / 语音 / 视频接口并试跑', icon: '✦' },
    { nav: 'stickers', section: 'library', label: '表情包打标', desc: '导入图片、打标签、转入正式库', icon: '❏' },
    { nav: 'budget', section: 'usage', label: '预算与用量', desc: '查看限额、消耗与最近调用', icon: '¥' },
    { nav: 'chats', label: '会话记忆', desc: '历史、摘要、长期事实与人设覆盖', icon: '▣' },
    { nav: 'people', label: '人员画像', desc: '查看群成员与用户的长期事实', icon: '☷' },
    { nav: 'multimodal', section: 'input', label: '多模态识别', desc: '让机器人看懂图片 / 听懂语音', icon: '◉' },
    { nav: 'dialog', section: 'model', label: '模型与 API', desc: 'DSH 提供方或直连 OpenAI 兼容接口', icon: '◈' },
    { nav: 'dialog', section: 'persona', label: '对话设置', desc: '人设、记忆与命令权限', icon: '☺' },
    { nav: 'system', section: 'qq', label: '系统设置', desc: 'QQ 接入、管理后台与日志', icon: '⚙' },
    { nav: 'logs', label: '运行日志', desc: '排查连接、生成与发送问题', icon: '≡' }
  ];

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
    subtab: '',
    navQuery: '',
    pollTimer: 0,
    snapshot: null,
    config: null,
    configLoaded: false,
    configWarnings: [],
    output: {
      status: null,
      store: null,
      history: [],
      total: 0,
      kind: 'image',
      lastRecords: [],
      references: [],
      referenceActive: '',
      loading: false,
      error: '',
      seq: 0
    },
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
        dataDirEl.textContent = '数据目录：' + (snapshot.dataDir || '未知');
        dataDirEl.title = snapshot.dataDir || '';
      } else {
        dataDirEl.textContent = '数据目录加载中…';
      }
    }
    var versionEl = $('#sideVersion');
    if (versionEl) versionEl.textContent = snapshot && snapshot.version ? 'v' + snapshot.version : '';
    var badge = $('#connBadge');
    if (!badge) return;
    var status = snapshot && snapshot.status ? snapshot.status : null;
    var info = statusInfo(status);
    var bot = botNameOf(status && status.bot);
    var label = info.cls === 'badge-ok' && bot ? info.label + ' · ' + bot : info.label;
    badge.className = 'badge ' + info.cls;
    badge.innerHTML = '<span class="dot"></span><span>' + esc(label) + '</span>';
  }

  var TAB_NAMES = ['overview', 'dialog', 'multimodal', 'stickers', 'budget', 'chats', 'people', 'system', 'logs'];

  // ---------------------------------------------------------------------------
  // Top-level navigation + page-local sub-tab routing / hash routing
  // ---------------------------------------------------------------------------
  var LEGACY_ROUTES = {
    config: {
      '': ['system', 'qq'],
      qq: ['system', 'qq'],
      llm: ['dialog', 'model'],
      persona: ['dialog', 'persona'],
      multimodal: ['multimodal', 'input'],
      memory: ['dialog', 'memory'],
      budget: ['budget', 'settings'],
      stickers: ['stickers', 'settings'],
      commands: ['dialog', 'commands'],
      logging: ['system', 'logging'],
      output: ['multimodal', 'output']
    },
    output: { '': ['multimodal', 'output'] }
  };

  function normalizeSubtab(tab, subtab) {
    var tabs = PAGE_TABS[tab];
    if (!tabs || tabs.length === 0) return '';
    var wanted = typeof subtab === 'string' ? subtab : '';
    for (var i = 0; i < tabs.length; i += 1) {
      if (tabs[i].key === wanted) return wanted;
    }
    return DEFAULT_SUBTAB[tab] || tabs[0].key;
  }

  function sectionSearchText(section) {
    if (!section) return '';
    return String(section.title + ' ' + (section.hint || '') + ' ' + section.fields.map(function (field) {
      return field.label + ' ' + field.path;
    }).join(' '));
  }

  function pageSettingsSearchText(page) {
    var terms = [];
    (PAGE_TABS[page] || []).forEach(function (tab) {
      (tab.sections || []).forEach(function (key) {
        terms.push(sectionSearchText(findConfigSection(key)));
      });
    });
    if (page === 'multimodal') {
      configSections('output').forEach(function (section) {
        terms.push(sectionSearchText(section));
      });
    }
    if (page === 'stickers') terms.push('导入 上传 扫描 import 打标 图层 回收站');
    return terms.join(' ');
  }

  function navItemSearchText(item, group) {
    var tabs = PAGE_TABS[item.id] || [];
    var tabText = tabs.map(function (tab) { return item.label + tab.label + ' ' + tab.label; }).join(' ');
    return String(
      (group ? group.title + ' ' : '') + item.label + ' ' + item.desc + ' ' + item.id + ' ' + tabText + ' ' + pageSettingsSearchText(item.id)
    ).toLowerCase();
  }

  function renderSideNav() {
    var nav = $('#sideNav');
    if (!nav) return;
    nav.innerHTML = NAV_GROUPS.map(function (group) {
      var items = group.items.map(function (item) {
        return (
          '<button type="button" class="nav-item" data-nav="' + esc(item.id) + '"' +
          ' data-search="' + esc(navItemSearchText(item, group)) + '" title="' + esc(item.label + '：' + item.desc) + '">' +
          '<span class="nav-ico" aria-hidden="true">' + esc(item.icon || '·') + '</span>' +
          '<span class="nav-text"><span class="nav-label">' + esc(item.label) + '</span>' +
          '<span class="nav-desc">' + esc(item.desc) + '</span></span>' +
          '</button>'
        );
      }).join('');
      return (
        '<div class="nav-group" data-nav-group="' + esc(group.title) + '" data-search="' + esc(group.title.toLowerCase()) + '">' +
        '<div class="nav-group-title">' + esc(group.title) + '</div>' + items + '</div>'
      );
    }).join('');
    updateNavActive();
    filterSideNav(state.navQuery);
  }

  function updateNavActive() {
    $$('#sideNav .nav-item').forEach(function (button) {
      var active = button.dataset.nav === state.tab;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    });
  }

  function filterSideNav(query) {
    var nav = $('#sideNav');
    if (!nav) return;
    var needle = String(query || '').trim().toLowerCase();
    state.navQuery = needle;
    var visible = 0;
    $$('.nav-group', nav).forEach(function (group) {
      var groupVisible = 0;
      $$('.nav-item', group).forEach(function (item) {
        var match = needle === '' || String(item.dataset.search || '').indexOf(needle) >= 0;
        item.hidden = !match;
        if (match) groupVisible += 1;
      });
      group.hidden = groupVisible === 0;
      visible += groupVisible;
    });
    var empty = $('#navEmpty');
    if (empty) empty.hidden = visible !== 0;
  }

  function parseHash() {
    var raw = String(window.location.hash || '').replace(/^#\/?/, '');
    if (raw === '') return { tab: 'overview', section: '' };
    var parts = raw.split('/');
    var tab = '';
    var section = '';
    try {
      tab = decodeURIComponent(parts[0] || '');
      section = parts.length > 1 ? decodeURIComponent(parts[1] || '') : '';
    } catch (err) {
      tab = 'overview';
    }
    var legacy = LEGACY_ROUTES[tab];
    if (legacy) {
      var mapped = legacy[section] || legacy[''];
      tab = mapped[0];
      section = mapped[1];
    }
    if (!PAGE_META[tab]) tab = 'overview';
    section = normalizeSubtab(tab, section);
    return { tab: tab, section: section };
  }

  function navigate(tab, options) {
    var opts = options || {};
    var targetTab = PAGE_META[tab] ? tab : 'overview';
    var section = normalizeSubtab(targetTab, typeof opts.section === 'string' ? opts.section : '');
    var hash = '#/' + targetTab + (section ? '/' + encodeURIComponent(section) : '');
    if (window.location.hash !== hash) {
      window.location.hash = hash;
      return;
    }
    activateTab(targetTab, { section: section });
  }

  function applyLocation() {
    var route = parseHash();
    activateTab(route.tab, { section: route.section });
  }

  function pageTabLabel(tab, subtab) {
    var tabs = PAGE_TABS[tab];
    if (!tabs) return '';
    for (var i = 0; i < tabs.length; i += 1) {
      if (tabs[i].key === subtab) return tabs[i].label;
    }
    return '';
  }

  function renderPageTabs(tab) {
    var container = document.getElementById('tabs-' + tab);
    var tabs = PAGE_TABS[tab];
    if (!container || !tabs) return;
    container.innerHTML = tabs.map(function (entry) {
      var active = entry.key === state.subtab;
      return (
        '<button type="button" class="page-tab' + (active ? ' is-active' : '') + '" role="tab" aria-selected="' + active +
        '" data-subtab="' + esc(entry.key) + '">' + esc(entry.label) + '</button>'
      );
    }).join('');
  }

  function updateSubPanels(tab, subtab) {
    var panel = document.getElementById('panel-' + tab);
    if (!panel) return;
    $$('.sub-panel[data-subtab]', panel).forEach(function (node) {
      node.classList.toggle('is-active', node.dataset.subtab === subtab);
    });
  }

  function renderCrumb() {
    var meta = PAGE_META[state.tab] || PAGE_META.overview;
    var label = pageTabLabel(state.tab, state.subtab);
    var title = label === '' ? meta.title : meta.title + ' / ' + label;
    var groupEl = $('#crumbGroup');
    var pageEl = $('#crumbPage');
    if (groupEl) groupEl.textContent = meta.group;
    if (pageEl) pageEl.textContent = title;
    try {
      document.title = title + ' · QQ Bot 控制台';
    } catch (err) {
      // ignore document.title failures in exotic embeds
    }
  }

  function setSidebarOpen(open) {
    var sidebar = $('#appSidebar');
    var backdrop = $('#sideBackdrop');
    if (sidebar) sidebar.classList.toggle('is-open', open);
    if (backdrop) backdrop.hidden = !open;
  }

  function activateTab(tab, options) {
    if (TAB_NAMES.indexOf(tab) < 0) tab = 'overview';
    var opts = options || {};
    var subtab = normalizeSubtab(tab, typeof opts.section === 'string' ? opts.section : '');
    state.tab = tab;
    state.subtab = subtab;
    $$('.panel').forEach(function (panel) {
      panel.classList.toggle('is-active', panel.id === 'panel-' + tab);
    });
    renderPageTabs(tab);
    updateSubPanels(tab, subtab);
    updateNavActive();
    renderCrumb();
    if (window.innerWidth <= 900) setSidebarOpen(false);
    handle(function () {
      return loadTabNow(tab, { force: opts.force === true, subtab: subtab });
    });
  }

  function ensureConfigLoaded(force) {
    if (state.configLoaded && force !== true) return Promise.resolve(state.config);
    return loadConfig({ force: force === true });
  }

  function loadTabNow(tab, options) {
    var opts = options || {};
    var subtab = opts.subtab || state.subtab;
    switch (tab) {
      case 'overview':
        return refreshSnapshot();
      case 'dialog':
      case 'system':
        return ensureConfigLoaded(opts.force === true);
      case 'multimodal':
        if (subtab === 'output') return loadOutputPage({ force: opts.force === true });
        return ensureConfigLoaded(opts.force === true);
      case 'stickers':
        if (subtab === 'settings') return ensureConfigLoaded(opts.force === true);
        return refreshStickerData();
      case 'budget':
        if (subtab === 'settings') return ensureConfigLoaded(opts.force === true);
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

  function renderQuickNav() {
    var el = $('#quickNav');
    if (!el || el.dataset.rendered === '1') return;
    el.dataset.rendered = '1';
    el.innerHTML = QUICK_LINKS.map(function (item) {
      var sectionAttr = item.section ? ' data-config-section="' + esc(item.section) + '"' : '';
      return (
        '<button type="button" class="quick-link" data-nav-link="' + esc(item.nav) + '"' + sectionAttr + '>' +
        '<span class="quick-ico" aria-hidden="true">' + esc(item.icon || '·') + '</span>' +
        '<span class="quick-text"><span class="quick-title">' + esc(item.label) + '</span>' +
        '<span class="quick-desc">' + esc(item.desc) + '</span></span></button>'
      );
    }).join('');
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
    renderQuickNav();
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

    var output = snapshot.output || null;
    var outputStore = snapshot.outputs || {};
    if (output) {
      var outputKinds = ['image', 'audio', 'video'].map(function (kind) {
        var section = output[kind] || {};
        var ready = output.enabled === true && section.enabled === true && section.configured === true;
        var label = OUTPUT_KIND_LABELS[kind];
        var tone = ready ? 'is-ok' : section.enabled ? 'is-warn' : 'is-off';
        var text = ready ? '已就绪' : section.enabled ? '待补全' : '未启用';
        return '<span class="status-pill ' + tone + '">' + esc(label) + ' ' + esc(text) + '</span>';
      }).join(' ');
      var outputTotal = Number(outputStore.total) || 0;
      cards.push(
        cardHtml({
          title: '多模态输出',
          badgeHtml: '<span class="badge ' + (output.enabled ? 'badge-ok' : 'badge-muted') + '"><span class="dot"></span>' + (output.enabled ? '已启用' : '未启用') + '</span>',
          valueHtml: outputTotal + ' <span class="stat-unit">件作品</span>',
          sub: output.enabled ? '图片 / 语音 / 视频生成接口' : '在「多模态输出」页配置第三方 API',
          rows: [
            '<div class="chip-row" style="margin:2px 0 4px">' + outputKinds + '</div>',
            kvHtml('命令权限', esc(output.commandAccess === 'all' ? '所有用户' : '仅管理员')),
            kvHtml('发送到 QQ', output.sendToQQ ? '是' : '否'),
            kvHtml('最近生成', outputStore.latestAt ? fmtAgo(outputStore.latestAt) : '—')
          ]
        })
      );
    }

    var multimodal = snapshot.multimodal || null;
    if (multimodal) {
      var mmReady = multimodal.enabled === true && multimodal.configured === true;
      cards.push(
        cardHtml({
          title: '多模态识别',
          badgeHtml: '<span class="badge ' + (mmReady ? 'badge-ok' : 'badge-muted') + '"><span class="dot"></span>' + (mmReady ? '已就绪' : '未启用') + '</span>',
          valueHtml: mmReady ? '可理解入站媒体' : '仅文字占位',
          sub: '图片 / 语音 / 视频 → 文字描述',
          rows: [
            kvHtml('图片', multimodal.image && multimodal.image.enabled ? (multimodal.image.configured ? '已就绪' : '待配置') : '关闭'),
            kvHtml('语音', multimodal.audio && multimodal.audio.enabled ? (multimodal.audio.configured ? '已就绪' : '待配置') : '关闭'),
            kvHtml('视频', multimodal.video && multimodal.video.enabled ? (multimodal.video.configured ? '已就绪' : '待配置') : '关闭')
          ]
        })
      );
    }

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
      key: 'qq',
      group: '接入',
      page: 'config',
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
      key: 'llm',
      group: '对话',
      page: 'config',
      title: 'LLM 模型',
      hint: '默认使用 DSH 已配置的模型提供方；填写 API Base URL 后改为直连 OpenAI 兼容 /chat/completions（本地服务可不填 API Key）。',
      fields: [
        { path: 'llm.baseUrl', label: 'API Base URL（可选）', type: 'text', wide: true, placeholder: 'https://api.openai.com/v1', hint: '留空 = 使用 DSH 的模型提供方；填写后直连该地址的 /chat/completions' },
        { path: 'llm.apiKey', label: 'API Key（可选）', type: 'secret', secretOf: 'llm' },
        { path: 'llm.provider', label: 'Provider / 来源标签', type: 'text', placeholder: 'deepseek-official' },
        { path: 'llm.model', label: '模型', type: 'text', placeholder: 'deepseek-flash' },
        { path: 'llm.temperature', label: '温度', type: 'number', min: 0, max: 2, step: 0.05 },
        { path: 'llm.maxTokens', label: '最大输出 tokens', type: 'number', min: 64, max: 32768 },
        { path: 'llm.timeoutMs', label: '超时 (ms)', type: 'number', min: 5000, max: 600000 }
      ]
    },
    {
      key: 'persona',
      group: '对话',
      page: 'config',
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
      key: 'multimodal',
      group: '多模态',
      page: 'config',
      title: '多模态识别（输入）',
      hint: '使用 OpenAI 兼容接口把入站图片、语音、视频转成文字描述，再注入对话上下文。启用总开关并填写 baseUrl、apiKey 与对应模态的模型名后才会调用；各模态可单独开关。',
      fields: [
        { path: 'multimodal.enabled', label: '启用多模态识别', type: 'bool', hint: '总开关；baseUrl、apiKey 与对应模态 model 完整时才会调用，否则跳过识别' },
        { path: 'multimodal.baseUrl', label: 'API Base URL', type: 'text', placeholder: 'https://api.siliconflow.cn/v1', hint: 'OpenAI 兼容 base，例如 https://api.siliconflow.cn/v1 或 https://openrouter.ai/api/v1' },
        { path: 'multimodal.apiKey', label: 'API Key', type: 'secret', secretOf: 'multimodal' },
        { path: 'multimodal.image.enabled', label: '识别图片', type: 'bool', hint: '入站图片与表情包会先转成文字描述' },
        { path: 'multimodal.image.model', label: '图片模型', type: 'text', placeholder: '例如 Qwen/Qwen2.5-VL-7B-Instruct' },
        { path: 'multimodal.audio.enabled', label: '识别语音', type: 'bool', hint: 'QQ 语音消息（voice_wav_url）转文字或直接理解' },
        { path: 'multimodal.audio.model', label: '语音模型', type: 'text', placeholder: '例如 FunAudioLLM/SenseVoiceSmall' },
        {
          path: 'multimodal.audio.mode',
          label: '语音模式',
          type: 'select',
          options: [
            { value: 'transcribe', label: 'transcribe：转写为文字' },
            { value: 'chat', label: 'chat：直接交给音频理解模型' }
          ],
          hint: 'transcribe 调用 /audio/transcriptions；chat 把音频直接发给支持 input_audio 的模型'
        },
        { path: 'multimodal.video.enabled', label: '识别视频', type: 'bool', hint: '视频按 mode 选择抽帧识别或直接传 URL' },
        { path: 'multimodal.video.model', label: '视频模型', type: 'text', placeholder: '例如 Qwen/Qwen2.5-VL-7B-Instruct' },
        {
          path: 'multimodal.video.mode',
          label: '视频模式',
          type: 'select',
          options: [
            { value: 'frames', label: 'frames：ffmpeg 抽帧后逐帧识别' },
            { value: 'url', label: 'url：直接传视频地址给服务商' }
          ],
          hint: 'frames 需要系统已安装 ffmpeg；url 要求服务商支持 video_url 输入'
        },
        { path: 'multimodal.video.frameCount', label: '抽帧数量', type: 'number', min: 1, max: 16, hint: 'frames 模式最多抽取的帧数' },
        { path: 'multimodal.video.frameIntervalSec', label: '抽帧间隔（秒）', type: 'number', min: 0.1, max: 30, step: 0.1, hint: 'frames 模式每隔多少秒取一帧' },
        { path: 'multimodal.prompt', label: '识别提示词', type: 'textarea', wide: true, rows: 3 },
        { path: 'multimodal.timeoutMs', label: '超时 (ms)', type: 'number', min: 5000, max: 600000 },
        { path: 'multimodal.maxBytes', label: '单文件最大字节', type: 'number', min: 65536, max: 104857600, hint: '超过该大小的媒体会跳过识别（默认 16777216，即 16 MiB）' },
        { path: 'multimodal.ffmpegPath', label: 'ffmpeg 路径', type: 'text', placeholder: 'ffmpeg', hint: '视频 frames 模式需要系统安装 ffmpeg；可填可执行文件绝对路径，找不到时视频识别会失败' }
      ]
    },
    {
      key: 'memory',
      group: '对话',
      page: 'config',
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
      key: 'budget',
      group: '对话',
      page: 'config',
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
      key: 'stickers',
      group: '内容',
      page: 'config',
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
      key: 'commands',
      group: '对话',
      page: 'config',
      title: '命令与权限',
      hint: '命令前缀默认 #，同时兼容 /；管理员可使用管理命令。管理员身份支持 user_openid / member_openid / union_openid。',
      fields: [
        { path: 'commands.enabled', label: '启用聊天命令', type: 'bool' },
        { path: 'commands.prefix', label: '命令前缀', type: 'text' },
        { path: 'commands.adminOpenids', label: '管理员 openid', type: 'list', wide: true, rows: 3, hint: '每行一个；user_openid / member_openid / union_openid 均可，QQ 里发 #我的id 可查看当前账号标识' },
        { path: 'commands.allowGroupOwner', label: '允许群主 / 管理员使用管理命令', type: 'bool' }
      ]
    },
    {
      key: 'admin',
      group: '系统',
      page: 'config',
      title: '管理后台',
      fields: [
        { path: 'admin.enabled', label: '启用管理后台', type: 'bool', hint: '关闭后本页面接口将不可用' },
        { path: 'admin.path', label: '管理页路径', type: 'text', hint: '站内路径，例如 /qqbot；修改后需重新加载插件才会生效' },
        { path: 'admin.pageSize', label: '管理页每页数量', type: 'number', min: 10, max: 500 }
      ]
    },
    {
      key: 'logging',
      group: '系统',
      page: 'config',
      title: '日志与调试',
      fields: [
        { path: 'logging.maxLines', label: '日志保留行数', type: 'number', min: 50, max: 5000 },
        { path: 'logging.debug', label: '调试日志', type: 'bool' }
      ]
    },

    /* ---- multimodal output (rendered on the dedicated output page) ---- */
    {
      key: 'output-general',
      group: '输出',
      page: 'output',
      title: '输出总开关',
      hint: '控制多模态输出是否启用、谁能用聊天命令生成、生成后是否直接发到 QQ。',
      fields: [
        { path: 'output.enabled', label: '启用多模态输出', type: 'bool', hint: '总开关；关闭后聊天命令与模型指令都不会生成内容' },
        {
          path: 'output.commandAccess',
          label: '聊天命令权限',
          type: 'select',
          options: [
            { value: 'admin', label: '仅管理员（推荐）' },
            { value: 'all', label: '所有用户' }
          ],
          hint: '生成会调用第三方接口并产生费用；开放给所有用户前请确认预算与风控'
        },
        { path: 'output.sendToQQ', label: '生成后发送到 QQ', type: 'bool', hint: '关闭时只保存到作品库，不占用 QQ 富媒体上传额度' },
        { path: 'output.allowModelDirectives', label: '允许模型主动生成', type: 'bool', hint: '关闭时模型回复里的 [[image: ...]] / [[voice: ...]] / [[video: ...]] 标签会被剥离，只保留文字；开启后仍受聊天命令权限约束，每次最多一个' },
        { path: 'output.promptPrefix', label: '统一提示词前缀', type: 'textarea', wide: true, rows: 2, hint: '附加在图片/视频提示词前面；语音输出不追加' },
        { path: 'output.timeoutMs', label: '单次请求超时 (ms)', type: 'number', min: 5000, max: 600000 },
        { path: 'output.maxBytes', label: '单个结果最大字节', type: 'number', min: 65536, max: 209715200, hint: '默认 33554432（32 MiB）；超过的结果不会保存' },
        { path: 'output.maxItems', label: '作品库最多保留数量', type: 'number', min: 0, max: 2000, hint: '0 表示不按数量清理' },
        { path: 'output.retentionDays', label: '作品保留天数', type: 'number', min: 0, max: 3650, hint: '0 表示不按时间清理' }
      ]
    },
    {
      key: 'output-image',
      group: '输出',
      page: 'output',
      testKind: 'image',
      title: '图片输出',
      hint: 'OpenAI 兼容 /images/generations。硅基流动等聚合服务可把参数名改为 image_size / batch_size。',
      fields: [
        { path: 'output.image.enabled', label: '启用图片输出', type: 'bool' },
        { path: 'output.image.baseUrl', label: 'API Base URL', type: 'text', placeholder: 'https://api.siliconflow.cn/v1', hint: '填到 /v1 层级，例如 https://api.example.com/v1；只填域名时会自动补 /v1 并显示实际请求地址' },
        { path: 'output.image.apiKey', label: 'API Key', type: 'secret', secretOf: 'output.image' },
        { path: 'output.image.model', label: '模型', type: 'text', placeholder: '例如 Kwai-Kolors/Kolors / gpt-image-1' },
        { path: 'output.image.path', label: '接口路径', type: 'text', placeholder: '/images/generations' },
        { path: 'output.image.size', label: '图片尺寸', type: 'text', placeholder: '1024x1024', hint: '按服务商支持的尺寸填写，例如 1024x1024 / 768x1024' },
        {
          path: 'output.image.sizeField',
          label: '尺寸参数名',
          type: 'select',
          options: [
            { value: 'size', label: 'size（OpenAI）' },
            { value: 'image_size', label: 'image_size（硅基流动等）' },
            { value: 'none', label: '不发送尺寸' }
          ]
        },
        { path: 'output.image.count', label: '每次生成张数', type: 'number', min: 1, max: 4, hint: '为 1 时不会发送 n / batch_size 参数，避免部分服务商把未知参数当作错误' },
        {
          path: 'output.image.countField',
          label: '数量参数名',
          type: 'select',
          options: [
            { value: 'n', label: 'n（OpenAI）' },
            { value: 'batch_size', label: 'batch_size（硅基流动等）' },
            { value: 'none', label: '不发送数量' }
          ]
        },
        {
          path: 'output.image.responseFormat',
          label: '返回格式',
          type: 'select',
          options: [
            { value: 'b64_json', label: 'b64_json（直接返回图片数据）' },
            { value: 'url', label: 'url（返回临时下载地址）' },
            { value: '', label: '不指定（自动解析）' }
          ],
          hint: '不指定时只依赖服务商默认值；两种返回都能自动解析'
        },
        { path: 'output.image.quality', label: '质量参数（可选）', type: 'text', placeholder: '例如 high / standard' },
        { path: 'output.image.style', label: '风格参数（可选）', type: 'text', placeholder: '例如 vivid / natural' },
        { path: 'output.image.extraBody', label: '附加请求体 JSON', type: 'textarea', wide: true, rows: 3, hint: '会合并进请求体，例如 {"negative_prompt":"lowres","num_inference_steps":25}' }
      ]
    },
    {
      key: 'output-image-reference',
      group: '输出',
      page: 'output',
      referencePanel: true,
      title: '角色形象参考',
      hint: '上传一张蓝色鲸鱼娘形象图并设为当前；当提示词提到角色名 / 触发关键词时，这张图会作为参考图（输入 tokens）发给图片模型。',
      fields: [
        { path: 'output.image.reference.enabled', label: '启用角色形象参考', type: 'bool', hint: '启用后仍需选择一张「当前参考图」才会真正带入图片请求' },
        {
          path: 'output.image.reference.trigger',
          label: '触发方式',
          type: 'select',
          options: [
            { value: 'auto', label: '自动：提示词命中角色名 / 关键词时使用' },
            { value: 'always', label: '始终：每次生成图片都使用参考图' }
          ]
        },
        { path: 'output.image.reference.keywords', label: '触发关键词', type: 'text', wide: true, hint: '逗号分隔；机器人名字会自动加入，例如：鲸鱼娘,小蓝,蓝色鲸鱼娘,你自己,qq机器人' },
        {
          path: 'output.image.reference.requestMode',
          label: '参考图请求方式',
          type: 'select',
          options: [
            { value: 'edits', label: 'OpenAI /images/edits（multipart 上传图片）' },
            { value: 'generations', label: '在 /images/generations 请求体里带图片字段' }
          ],
          hint: '服务商支持 image-to-image / 图片编辑时选 edits；只接受 JSON 图片字段时选 generations'
        },
        { path: 'output.image.reference.path', label: '参考图接口路径', type: 'text', placeholder: '/images/edits', showIf: { path: 'output.image.reference.requestMode', values: ['edits'] }, hint: 'OpenAI 兼容默认 /images/edits；Base URL 无路径时会自动补 /v1' },
        { path: 'output.image.reference.field', label: '图片字段名', type: 'text', placeholder: 'image', hint: 'edits 模式为 multipart 文件字段名；generations 模式为 JSON 字段名' },
        {
          path: 'output.image.reference.format',
          label: '图片编码',
          type: 'select',
          options: [
            { value: 'data_url', label: 'data URL（data:image/...;base64,...）' },
            { value: 'base64', label: '纯 base64' }
          ],
          showIf: { path: 'output.image.reference.requestMode', values: ['generations'] }
        },
        { path: 'output.image.reference.promptPrefix', label: '参考图提示词前缀', type: 'textarea', wide: true, rows: 3, hint: '使用参考图时自动加在提示词前，用于强调保持角色形象一致' },
        { path: 'output.image.reference.fallbackToText', label: '参考图请求失败时回退纯文生图', type: 'bool', hint: '关闭后参考图调用失败会直接报错，便于发现接口不支持' },
        { path: 'output.image.reference.maxBytes', label: '参考图最大字节', type: 'number', min: 65536, max: 52428800 },
        { path: 'output.image.reference.maxItems', label: '最多保留参考图数量', type: 'number', min: 1, max: 100 }
      ]
    },
    {
      key: 'output-audio',
      group: '输出',
      page: 'output',
      testKind: 'audio',
      title: '语音输出',
      hint: 'OpenAI 兼容 /audio/speech，返回二进制音频；也兼容返回 base64/URL 的 JSON 响应。',
      fields: [
        { path: 'output.audio.enabled', label: '启用语音输出', type: 'bool' },
        { path: 'output.audio.baseUrl', label: 'API Base URL', type: 'text', placeholder: 'https://api.siliconflow.cn/v1', hint: '填到 /v1 层级；只填域名时会自动补 /v1' },
        { path: 'output.audio.apiKey', label: 'API Key', type: 'secret', secretOf: 'output.audio' },
        { path: 'output.audio.model', label: '模型', type: 'text', placeholder: '例如 FunAudioLLM/CosyVoice2-0.5B' },
        { path: 'output.audio.path', label: '接口路径', type: 'text', placeholder: '/audio/speech' },
        { path: 'output.audio.voice', label: '音色', type: 'text', placeholder: 'alloy' },
        {
          path: 'output.audio.format',
          label: '音频格式',
          type: 'select',
          options: [
            { value: 'mp3', label: 'mp3' },
            { value: 'wav', label: 'wav' },
            { value: 'ogg', label: 'ogg' },
            { value: 'opus', label: 'opus' }
          ],
          hint: 'QQ 语音条支持 mp3 / wav / ogg；其他格式会保存到作品库但不会直接发送'
        },
        { path: 'output.audio.speed', label: '语速', type: 'number', min: 0.25, max: 4, step: 0.05 },
        { path: 'output.audio.extraBody', label: '附加请求体 JSON', type: 'textarea', wide: true, rows: 3, hint: '会合并进请求体，例如 {"language":"zh"}' }
      ]
    },
    {
      key: 'output-video',
      group: '输出',
      page: 'output',
      testKind: 'video',
      title: '视频输出',
      hint: '视频接口都是异步任务：先提交，再轮询状态，最后下载结果。支持硅基流动、OpenAI Videos 与自定义异步协议。',
      fields: [
        { path: 'output.video.enabled', label: '启用视频输出', type: 'bool' },
        {
          path: 'output.video.preset',
          label: '接口协议',
          type: 'select',
          options: [
            { value: 'siliconflow', label: '硅基流动 /video/submit + /video/status' },
            { value: 'openai', label: 'OpenAI Videos /videos + /videos/{id}' },
            { value: 'custom', label: '自定义异步任务接口' }
          ]
        },
        { path: 'output.video.baseUrl', label: 'API Base URL', type: 'text', placeholder: 'https://api.siliconflow.cn/v1', hint: '填到 /v1 层级；只填域名时会自动补 /v1' },
        { path: 'output.video.apiKey', label: 'API Key', type: 'secret', secretOf: 'output.video' },
        { path: 'output.video.model', label: '模型', type: 'text', placeholder: '例如 Wan-AI/Wan2.2-T2V-A14B' },
        { path: 'output.video.size', label: '视频尺寸', type: 'text', placeholder: '1280x720' },
        {
          path: 'output.video.sizeField',
          label: '尺寸参数名',
          type: 'select',
          options: [
            { value: 'image_size', label: 'image_size（硅基流动 / 自定义）' },
            { value: 'size', label: 'size（OpenAI）' }
          ],
          showIf: { path: 'output.video.preset', values: ['siliconflow', 'custom'] }
        },
        { path: 'output.video.duration', label: '时长（秒）', type: 'number', min: 1, max: 60, hint: 'OpenAI Videos 会作为 seconds 发送；其他服务商可用附加 JSON 指定' },
        { path: 'output.video.negativePrompt', label: '负向提示词', type: 'textarea', rows: 2, hint: '硅基流动会作为 negative_prompt 发送' },
        { path: 'output.video.createPath', label: '提交任务路径', type: 'text', placeholder: '/video/submit', showIf: { path: 'output.video.preset', values: ['custom'] } },
        { path: 'output.video.queryPath', label: '查询任务路径', type: 'text', placeholder: '/video/status 或 /tasks/{id}', showIf: { path: 'output.video.preset', values: ['custom'] }, hint: '支持 {id} 占位符；留空则原样请求' },
        {
          path: 'output.video.queryMethod',
          label: '查询方法',
          type: 'select',
          options: [
            { value: 'POST', label: 'POST' },
            { value: 'GET', label: 'GET' }
          ],
          showIf: { path: 'output.video.preset', values: ['custom'] }
        },
        {
          path: 'output.video.requestFormat',
          label: '提交格式',
          type: 'select',
          options: [
            { value: 'json', label: 'JSON' },
            { value: 'multipart', label: 'multipart/form-data' }
          ],
          showIf: { path: 'output.video.preset', values: ['openai', 'custom'] }
        },
        { path: 'output.video.idField', label: '任务 ID 字段', type: 'text', placeholder: 'requestId', showIf: { path: 'output.video.preset', values: ['custom'] } },
        { path: 'output.video.statusField', label: '状态字段', type: 'text', placeholder: 'status', showIf: { path: 'output.video.preset', values: ['custom'] } },
        { path: 'output.video.resultField', label: '结果 URL 字段', type: 'text', placeholder: 'results.videos.0.url', showIf: { path: 'output.video.preset', values: ['custom'] }, hint: '支持点路径与 [0] 下标' },
        { path: 'output.video.successValues', label: '成功状态值', type: 'text', showIf: { path: 'output.video.preset', values: ['custom'] }, hint: '逗号分隔，不区分大小写' },
        { path: 'output.video.failureValues', label: '失败状态值', type: 'text', showIf: { path: 'output.video.preset', values: ['custom'] }, hint: '逗号分隔，不区分大小写' },
        { path: 'output.video.pollIntervalMs', label: '轮询间隔 (ms)', type: 'number', min: 500, max: 60000 },
        { path: 'output.video.maxWaitMs', label: '最长等待 (ms)', type: 'number', min: 10000, max: 1800000 },
        { path: 'output.video.extraBody', label: '附加请求体 JSON', type: 'textarea', wide: true, rows: 3, hint: '会合并进提交请求体，例如 {"seed":42}' }
      ]
    }
  ];

  function findConfigSection(key) {
    for (var i = 0; i < CONFIG_SCHEMA.length; i += 1) {
      if (CONFIG_SCHEMA[i].key === key) return CONFIG_SCHEMA[i];
    }
    return null;
  }

  function configSections(page) {
    return CONFIG_SCHEMA.filter(function (section) {
      return (section.page || 'config') === page;
    });
  }

  function renderConfigWarnings(target, warnings, emptyText) {
    if (!target) return;
    var list = Array.isArray(warnings) ? warnings : [];
    target.innerHTML = list.length
      ? list.map(function (warning) { return '<li class="warning-item">' + esc(warning) + '</li>'; }).join('')
      : '<li class="muted">' + esc(emptyText || '无配置警告') + '</li>';
  }

  function fieldSearchText(field) {
    return String(field.path + ' ' + field.label + ' ' + (field.hint || '') + ' ' + (field.placeholder || '')).toLowerCase();
  }

  function fieldShowIfAttributes(field, config) {
    if (!field.showIf || typeof field.showIf.path !== 'string') return { attrs: '', hidden: false };
    var values = Array.isArray(field.showIf.values) ? field.showIf.values : [];
    var current = getPath(config, field.showIf.path);
    var visible = values.indexOf(String(current === undefined || current === null ? '' : current)) >= 0;
    return {
      attrs:
        ' data-show-if-path="' + esc(field.showIf.path) + '" data-show-if-values="' + esc(JSON.stringify(values)) + '"',
      hidden: !visible
    };
  }

  function renderConfigField(field, config) {
    var value = getPath(config, field.path);
    var path = esc(field.path);
    var label = esc(field.label);
    var conditional = fieldShowIfAttributes(field, config);
    var search = ' data-search="' + esc(fieldSearchText(field)) + '"';
    var hiddenAttr = conditional.hidden ? ' hidden' : '';
    if (field.type === 'bool') {
      return (
        '<label class="check-field"' + search + conditional.attrs + hiddenAttr + '>' +
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
      var secretConfig = field.secretOf ? getPath(config, field.secretOf) : config && config.qq;
      if (secretConfig === null || typeof secretConfig !== 'object') secretConfig = {};
      var masked = secretConfig.appSecretMasked || secretConfig.apiKeyMasked || '';
      var hasSecret = !!(secretConfig.hasSecret || secretConfig.hasApiKey);
      var placeholder = hasSecret ? '已保存（' + masked + '），留空不修改' : '尚未设置';
      control = '<input type="password" autocomplete="new-password" data-path="' + path + '" data-type="secret" value="" placeholder="' + esc(placeholder) + '" />';
    } else if (field.type === 'select') {
      var options = Array.isArray(field.options) ? field.options : [];
      var current = value === null || value === undefined ? '' : String(value);
      var found = options.some(function (option) { return String(option.value) === current; });
      var optionHtml = options.map(function (option) {
        var optionValue = String(option.value);
        return '<option value="' + esc(optionValue) + '"' + (optionValue === current ? ' selected' : '') + '>' + esc(option.label || option.value) + '</option>';
      }).join('');
      if (!found && current !== '') optionHtml += '<option value="' + esc(current) + '" selected>当前值：' + esc(current) + '</option>';
      control = '<select data-path="' + path + '" data-type="text">' + optionHtml + '</select>';
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
      '<label class="field' + (field.wide ? ' field-wide' : '') + '"' + search + conditional.attrs + hiddenAttr + '>' +
      '<span class="field-label">' + label + '</span>' + control + hintHtml +
      '</label>'
    );
  }

  function renderConfigSections(sections, config) {
    return sections.map(function (section) {
      var fields = section.fields.map(function (field) {
        return renderConfigField(field, config);
      }).join('');
      return (
        '<fieldset class="form-section" id="cfg-' + esc(section.key) + '" data-section="' + esc(section.key) + '">' +
        '<legend class="form-section-title">' + esc(section.title) + '</legend>' +
        (section.hint ? '<p class="section-hint">' + esc(section.hint) + '</p>' : '') +
        '<div class="form-grid">' + fields + '</div></fieldset>'
      );
    }).join('');
  }

  function sectionsByKeys(keys) {
    return (Array.isArray(keys) ? keys : []).map(function (key) {
      return findConfigSection(key);
    }).filter(Boolean);
  }

  function renderSettingsWarningsFor(root) {
    if (!root) return;
    var target = $('[data-config-warnings]', root);
    renderConfigWarnings(target, state.configWarnings);
  }

  function renderSettingsForm(containerId, sectionKeys) {
    var container = document.getElementById(containerId);
    if (!container) return;
    var sections = sectionsByKeys(sectionKeys);
    if (sections.length === 0) {
      container.innerHTML = '';
      return;
    }
    container.innerHTML =
      '<div class="settings-toolbar">' +
        '<input class="input input-sm config-search" type="search" autocomplete="off" data-config-search="' + esc(containerId) + '" placeholder="搜索本页设置项 / 键名" />' +
        '<span class="muted small" data-config-count="' + esc(containerId) + '"></span>' +
        '<button type="button" class="btn btn-primary btn-sm" data-save-config="' + esc(containerId) + '">保存设置</button>' +
      '</div>' +
      '<ul class="warning-list" data-config-warnings="' + esc(containerId) + '"></ul>' +
      '<div data-config-root="' + esc(containerId) + '">' + renderConfigSections(sections, state.config || {}) + '</div>';
    refreshConditionalFields(container);
    renderSettingsWarningsFor(container);
  }

  function renderAllSettingsForms() {
    SETTINGS_FORMS.forEach(function (form) {
      renderSettingsForm(form.container, form.sections);
    });
  }

  function renderOutputConfig() {
    var root = $('#outputConfig');
    if (!root) return;
    var config = state.config || {};
    root.innerHTML = configSections('output').map(function (section) {
      var fields = section.fields.map(function (field) {
        return renderConfigField(field, config);
      }).join('');
      var actions = '';
      if (section.testKind) {
        actions =
          '<div class="output-config-actions">' +
          '<button type="button" class="btn btn-sm" data-output-test="' + esc(section.testKind) + '">检测接口</button>' +
          '<span class="output-test-result" data-output-test-result="' + esc(section.testKind) + '"></span>' +
          '</div>';
      }
      return (
        '<section class="output-config-card" id="out-' + esc(section.key) + '" data-output-section="' + esc(section.key) + '">' +
        '<header class="output-config-head"><div><h4>' + esc(section.title) + '</h4>' +
        (section.hint ? '<p>' + esc(section.hint) + '</p>' : '') + '</div>' + actions + '</header>' +
        (section.referencePanel ? '<div id="outputReferencePanel" class="reference-panel"></div>' : '') +
        '<div class="form-grid">' + fields + '</div></section>'
      );
    }).join('');
    refreshConditionalFields(root);
    renderOutputReferencePanel();
  }

  function isConditionVisible(node, scope) {
    if (!node.hasAttribute('data-show-if-path')) return true;
    var sourcePath = node.dataset.showIfPath;
    var candidates = $$('[data-path]', scope);
    var source = null;
    for (var i = 0; i < candidates.length; i += 1) {
      if (candidates[i].dataset.path === sourcePath) {
        source = candidates[i];
        break;
      }
    }
    if (source === null) return true;
    var allowed = [];
    try {
      allowed = JSON.parse(node.dataset.showIfValues || '[]');
    } catch (err) {
      allowed = [];
    }
    var current = source.type === 'checkbox' ? (source.checked ? 'true' : 'false') : String(source.value || '');
    return allowed.indexOf(current) >= 0;
  }

  function refreshConditionalFields(root) {
    var scope = root || document;
    $$('[data-show-if-path]', scope).forEach(function (node) {
      var search = String(node.dataset.search || '');
      var hiddenBySearch = node.dataset.searchHidden === '1';
      node.hidden = !isConditionVisible(node, scope) || (hiddenBySearch && search !== '');
    });
  }

  function filterSettingsFields(containerId, query) {
    var container = document.getElementById(containerId);
    if (!container) return { fields: 0, sections: 0 };
    var root = $('[data-config-root]', container);
    if (!root) return { fields: 0, sections: 0 };
    var needle = String(query || '').trim().toLowerCase();
    var visibleFields = 0;
    var visibleSections = 0;
    $$('.form-section', root).forEach(function (section) {
      var sectionVisible = 0;
      $$('.field, .check-field', section).forEach(function (field) {
        var conditionOk = isConditionVisible(field, root);
        var match = conditionOk && (needle === '' || String(field.dataset.search || '').indexOf(needle) >= 0);
        field.dataset.searchHidden = !match ? '1' : '0';
        field.hidden = !match;
        if (match) sectionVisible += 1;
      });
      section.hidden = sectionVisible === 0;
      if (sectionVisible > 0) {
        visibleSections += 1;
        visibleFields += sectionVisible;
      }
    });
    var countEl = $('[data-config-count="' + containerId + '"]', container);
    if (countEl) countEl.textContent = needle === '' ? '' : '匹配 ' + visibleFields + ' 项';
    return { fields: visibleFields, sections: visibleSections };
  }

  async function loadConfig(options) {
    var opts = options || {};
    if (state.configLoaded && opts.force !== true) {
      renderAllSettingsForms();
      renderOutputConfig();
      renderOutputWarnings();
      return state.config;
    }
    var result = await api('config.get');
    var config = result && result.config && typeof result.config === 'object' ? result.config : {};
    state.config = config;
    state.configWarnings = result && Array.isArray(result.warnings) ? result.warnings : [];
    state.configLoaded = true;
    renderAllSettingsForms();
    renderOutputConfig();
    renderOutputWarnings();
    return config;
  }

  function collectConfigPatchFrom(root) {
    if (!root) return {};
    var patch = {};
    var inputs = $$('[data-path]', root);
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

  function renderOutputWarnings() {
    var target = $('#outputWarnings');
    if (!target) return;
    var warnings = (Array.isArray(state.configWarnings) ? state.configWarnings : []).filter(function (warning) {
      return String(warning).indexOf('output') >= 0 || String(warning).indexOf('多模态输出') >= 0;
    });
    renderConfigWarnings(target, warnings, '多模态输出没有配置警告');
  }

  function saveSettingsFrom(containerId) {
    var button = $('[data-save-config="' + containerId + '"]');
    return withLoading(button, async function () {
      var root = $('[data-config-root="' + containerId + '"]');
      if (!root) throw new Error('设置表单尚未加载');
      var patch = collectConfigPatchFrom(root);
      var result = await api('config.save', { patch: patch });
      if (result && result.config && typeof result.config === 'object') state.config = result.config;
      state.configLoaded = true;
      state.configWarnings = result && Array.isArray(result.warnings) ? result.warnings : [];
      renderAllSettingsForms();
      renderOutputConfig();
      renderOutputWarnings();
      toast('设置已保存，QQ 连接将按新配置重启', 'success');
      window.setTimeout(function () {
        refreshSnapshot({ silent: true }).catch(function () {});
      }, 1200);
    }, '保存中…');
  }

  // ---------------------------------------------------------------------------
  // 多模态输出
  // ---------------------------------------------------------------------------
  function outputMediaUrl(id) {
    return OUTPUT_MEDIA_ROOT + '/' + encodeURIComponent(String(id === null || id === undefined ? '' : id));
  }

  function referenceMediaUrl(id) {
    return BASE_PATH + '/media/reference/' + encodeURIComponent(String(id === null || id === undefined ? '' : id));
  }

  function activeReference() {
    var items = Array.isArray(state.output.references) ? state.output.references : [];
    for (var i = 0; i < items.length; i += 1) {
      if (items[i].id === state.output.referenceActive) return items[i];
    }
    return null;
  }

  function renderOutputReferencePanel() {
    var panel = $('#outputReferencePanel');
    if (!panel) return;
    var items = Array.isArray(state.output.references) ? state.output.references : [];
    var active = activeReference();
    var current = active
      ? '<div class="reference-current">' +
          '<img src="' + esc(referenceMediaUrl(active.id)) + '" alt="' + esc(active.originalName || '角色参考图') + '" />' +
          '<div class="reference-current-body">' +
            '<div class="reference-current-name">' + esc(active.originalName || '参考图') + '</div>' +
            '<div class="muted small">' + fmtBytes(active.size) + ' · ' + fmtTime(active.createdAt) + '</div>' +
            '<div class="muted small mono">' + esc(active.id) + '</div>' +
            '<div class="row-actions"><span class="status-pill is-ok">当前参考图</span>' +
            '<button type="button" class="btn btn-sm" data-reference-clear="1">取消当前参考</button></div>' +
          '</div>' +
        '</div>'
      : '<div class="empty reference-empty">还没有选择参考图。上传一张蓝色鲸鱼娘形象图后，点击「设为当前」。</div>';
    var list = items.length
      ? '<div class="reference-gallery">' +
          items.map(function (item) {
            var isActive = item.id === state.output.referenceActive;
            return (
              '<figure class="reference-card' + (isActive ? ' is-active' : '') + '">' +
              '<img src="' + esc(referenceMediaUrl(item.id)) + '" alt="' + esc(item.originalName || item.id) + '" loading="lazy" />' +
              '<figcaption>' +
              '<span class="reference-name">' + esc(item.originalName || item.id) + '</span>' +
              '<span class="muted small">' + fmtBytes(item.size) + ' · ' + fmtAgo(item.createdAt) + '</span>' +
              '</figcaption>' +
              '<div class="reference-actions">' +
              (isActive
                ? '<span class="status-pill is-ok">当前</span>'
                : '<button type="button" class="btn btn-sm" data-reference-use="' + esc(item.id) + '">设为当前</button>') +
              '<button type="button" class="btn btn-sm btn-danger-ghost" data-reference-delete="' + esc(item.id) + '">删除</button>' +
              '</div>' +
              '</figure>'
            );
          }).join('') +
        '</div>'
      : '';
    panel.innerHTML =
      '<div class="reference-head">' +
        '<div><strong>角色参考图</strong><p class="muted small">上传后作为图片生成输入；只有提示词命中角色名 / 关键词（或触发方式为「始终」）时才会使用。</p></div>' +
        '<div class="reference-actions">' +
          '<button type="button" class="btn btn-sm" data-reference-upload="1">上传参考图</button>' +
          '<input id="referenceFileInput" class="hidden-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" />' +
        '</div>' +
      '</div>' +
      current + list;
  }

  async function loadOutputReferences() {
    var result = await api('output.reference.list');
    state.output.references = result && Array.isArray(result.items) ? result.items : [];
    state.output.referenceActive = result && typeof result.active === 'string' ? result.active : '';
    renderOutputReferencePanel();
  }

  async function uploadOutputReference(file) {
    if (!file) return;
    var data = await fileToBase64(file);
    if (!data) throw new Error('读取参考图片失败');
    var result = await api('output.reference.upload', {
      name: file.name,
      mime: file.type || '',
      dataBase64: data
    });
    var item = result && result.item;
    if (item && item.id) {
      await activateOutputReference(item.id, true);
      toast('参考图已上传并设为当前', 'success');
    }
    await loadOutputReferences();
    await loadOutputLibrary();
  }

  async function activateOutputReference(id, enable) {
    var args = { id: id };
    if (enable === true) args.enabled = true;
    var result = await api('output.reference.activate', args);
    if (result && result.config) state.config = result.config;
    state.output.referenceActive = id;
    state.configWarnings = result && Array.isArray(result.warnings) ? result.warnings : state.configWarnings;
    var enabledInput = $('[data-path="output.image.reference.enabled"]');
    if (enable === true && enabledInput) enabledInput.checked = true;
    renderOutputWarnings();
    await loadOutputReferences();
    await loadOutputLibrary();
  }

  async function clearOutputReference() {
    var result = await api('config.save', { patch: { output: { image: { reference: { id: '' } } } } });
    if (result && result.config) state.config = result.config;
    state.output.referenceActive = '';
    if (result && Array.isArray(result.warnings)) state.configWarnings = result.warnings;
    renderOutputWarnings();
    await loadOutputReferences();
    await loadOutputLibrary();
    toast('已取消当前参考图', 'success');
  }

  async function deleteOutputReference(id) {
    var confirmed = await confirmModal({
      title: '删除参考图',
      message: '确定删除这张角色参考图吗？删除后不可恢复。',
      confirmLabel: '删除',
      danger: true
    });
    if (!confirmed) return;
    var result = await api('output.reference.delete', { id: id });
    state.output.referenceActive = result && typeof result.active === 'string' ? result.active : '';
    await loadOutputReferences();
    await loadOutputLibrary();
    toast('参考图已删除', 'success');
  }

  function outputRecordById(id) {
    var records = state.output.history || [];
    for (var i = 0; i < records.length; i += 1) {
      if (records[i].id === id) return records[i];
    }
    var last = state.output.lastRecords || [];
    for (var j = 0; j < last.length; j += 1) {
      if (last[j].id === id) return last[j];
    }
    return null;
  }

  function outputKindBadge(kind) {
    var key = OUTPUT_KIND_LABELS[kind] ? kind : 'image';
    return '<span class="output-kind-badge">' + esc(OUTPUT_KIND_ICONS[key] || '') + ' ' + esc(OUTPUT_KIND_LABELS[key]) + '</span>';
  }

  function outputRecordHtml(record) {
    if (!record || !record.id) return '';
    var kind = record.kind || 'image';
    var url = outputMediaUrl(record.id);
    var media = '';
    if (kind === 'image') {
      media = '<button type="button" class="output-item-media" data-preview-output="' + esc(record.id) + '" title="点击查看大图"><img src="' + esc(url) + '" alt="' + esc(record.prompt || '生成图片') + '" loading="lazy" /></button>';
    } else if (kind === 'audio') {
      media = '<div class="output-item-media"><audio controls preload="none" src="' + esc(url) + '"></audio></div>';
    } else {
      media = '<div class="output-item-media"><video controls preload="metadata" src="' + esc(url) + '"></video></div>';
    }
    var sourceLabel = record.source && record.source.kind === 'command' ? '聊天命令' : record.source && record.source.kind === 'model' ? '模型指令' : '控制台';
    return (
      '<article class="output-item">' + media +
      '<div class="output-item-body">' +
      '<div class="output-item-top">' + outputKindBadge(kind) + '<span class="muted small">' + esc(sourceLabel) + '</span>' +
      (record.referenceId ? '<span class="status-pill is-ok">参考图</span>' : '') + '</div>' +
      '<p class="output-item-prompt">' + esc(record.prompt || '（无提示词）') + '</p>' +
      '<div class="output-item-meta">' +
      '<span>' + esc(record.model || '未知模型') + '</span>' +
      (record.provider ? '<span>· ' + esc(record.provider) + '</span>' : '') +
      '<span>· ' + fmtTime(record.createdAt) + '</span>' +
      '<span>· ' + fmtBytes(record.size) + '</span>' +
      '</div>' +
      '<div class="output-item-actions"><button type="button" class="btn btn-sm btn-danger-ghost" data-delete-output="' + esc(record.id) + '">删除</button></div>' +
      '</div></article>'
    );
  }

  function renderOutputStatus() {
    var cardsEl = $('#outputCards');
    if (!cardsEl) return;
    var data = state.output || {};
    var status = data.status;
    var store = data.store || {};
    var history = Array.isArray(data.history) ? data.history : [];
    if (!status) {
      cardsEl.innerHTML = emptyHtml(data.error ? '读取输出状态失败：' + data.error : '正在读取输出配置…');
      return;
    }
    var cards = [];
    var total = Number(store.total) || 0;
    cards.push(
      cardHtml({
        title: '作品库',
        badgeHtml: '<span class="badge ' + (status.enabled ? 'badge-ok' : 'badge-muted') + '"><span class="dot"></span>' + (status.enabled ? '已启用' : '未启用') + '</span>',
        valueHtml: fmtNum(total) + ' <span class="stat-unit">件</span>',
        sub: '生成结果保存在本地 data/outputs/',
        rows: [
          kvHtml('图片', fmtNum(store.byKind && store.byKind.image)),
          kvHtml('语音', fmtNum(store.byKind && store.byKind.audio)),
          kvHtml('视频', fmtNum(store.byKind && store.byKind.video)),
          kvHtml('占用空间', fmtBytes(store.bytes)),
          kvHtml('最近生成', store.latestAt ? fmtAgo(store.latestAt) : '—')
        ]
      })
    );
    var lastByKind = {};
    for (var i = 0; i < history.length; i += 1) {
      var kind = history[i].kind;
      if (!lastByKind[kind]) lastByKind[kind] = history[i].createdAt;
    }
    ['image', 'audio', 'video'].forEach(function (kindKey) {
      var section = status[kindKey] || {};
      var ready = status.enabled === true && section.enabled === true && section.configured === true;
      var badge = section.enabled
        ? '<span class="badge ' + (ready ? 'badge-ok' : 'badge-warn') + '"><span class="dot"></span>' + (ready ? '已就绪' : '待补全') + '</span>'
        : '<span class="badge badge-muted"><span class="dot"></span>未启用</span>';
      var rows = [];
      if (kindKey === 'image') {
        rows.push(kvHtml('模型', esc(section.model || '—')));
        rows.push(kvHtml('尺寸', esc(section.size || '—')));
        rows.push(kvHtml('每次张数', fmtNum(section.count)));
        var referenceStatus = section.reference || {};
        var referenceText = referenceStatus.enabled
          ? referenceStatus.configured
            ? (referenceStatus.trigger === 'always' ? '始终使用' : '关键词触发') + ' · ' + (referenceStatus.requestMode === 'edits' ? 'edits' : 'generations')
            : '已启用，待选择参考图'
          : '关闭';
        rows.push(kvHtml('角色参考', esc(referenceText)));
      } else if (kindKey === 'audio') {
        rows.push(kvHtml('模型', esc(section.model || '—')));
        rows.push(kvHtml('格式 / 音色', esc((section.format || '—') + ' / ' + (section.voice || '—'))));
      } else {
        rows.push(kvHtml('协议', esc(section.preset || '—')));
        rows.push(kvHtml('模型', esc(section.model || '—')));
        rows.push(kvHtml('轮询 / 超时', section.configured ? '已配置' : '—'));
      }
      rows.push(kvHtml('请求地址', '<span class="mono">' + esc(section.requestUrl || '—') + '</span>'));
      rows.push(kvHtml('最近生成', lastByKind[kindKey] ? fmtAgo(lastByKind[kindKey]) : '—'));
      cards.push(
        cardHtml({
          title: OUTPUT_KIND_LABELS[kindKey] + '输出',
          badgeHtml: badge,
          valueHtml: esc(section.model || '未配置模型'),
          sub: section.baseUrl || '尚未填写 Base URL',
          rows: rows
        })
      );
    });
    cardsEl.innerHTML = cards.join('');
  }

  function renderOutputKindTabs() {
    var container = $('#outputKindTabs');
    if (!container) return;
    container.innerHTML = ['image', 'audio', 'video'].map(function (kind) {
      var active = state.output.kind === kind;
      return (
        '<button type="button" class="seg-btn' + (active ? ' is-active' : '') + '" data-output-kind="' + kind + '" role="tab" aria-selected="' + active + '">' +
        esc(OUTPUT_KIND_ICONS[kind] + ' ' + OUTPUT_KIND_LABELS[kind]) + '</button>'
      );
    }).join('');
    var prompt = $('#outputPrompt');
    if (prompt) prompt.placeholder = '例如：' + OUTPUT_KIND_PROMPTS[state.output.kind];
  }

  function renderOutputResult(records) {
    var el = $('#outputResult');
    if (!el) return;
    var list = Array.isArray(records) ? records : [];
    if (!list.length) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML =
      '<div class="output-result-grid">' +
      list.map(function (record) {
        var url = outputMediaUrl(record.id);
        var preview = '';
        if (record.kind === 'image') {
          preview = '<img src="' + esc(url) + '" alt="' + esc(record.prompt || '生成图片') + '" />';
        } else if (record.kind === 'audio') {
          preview = '<audio controls src="' + esc(url) + '"></audio>';
        } else {
          preview = '<video controls src="' + esc(url) + '"></video>';
        }
        return (
          '<div class="output-result-preview">' + preview +
          '<div class="output-result-meta">' + outputKindBadge(record.kind) + ' ' + esc(record.model || '') +
          ' · ' + fmtBytes(record.size) + ' · ' + fmtTime(record.createdAt) + '</div>' +
          '<p class="output-item-prompt">' + esc(record.prompt || '') + '</p></div>'
        );
      }).join('') +
      '</div>';
  }

  function renderOutputHistory() {
    var el = $('#outputHistory');
    if (!el) return;
    var records = Array.isArray(state.output.history) ? state.output.history : [];
    if (!records.length) {
      el.innerHTML = emptyHtml('还没有生成记录。配置好接口后，可以在右侧试跑或直接在 QQ 里用 #画 / #语音 / #视频。');
    } else {
      el.innerHTML = records.map(outputRecordHtml).join('');
    }
    var more = $('#btnOutputMore');
    if (more) more.hidden = records.length >= (Number(state.output.total) || 0);
  }

  async function loadOutputLibrary() {
    var seq = ++state.output.seq;
    var results = await Promise.allSettled([
      api('output.status'),
      api('output.history', { limit: 30, offset: 0 }),
      api('output.reference.list')
    ]);
    if (seq !== state.output.seq) return;
    if (results[0].status === 'fulfilled') {
      var statusResult = results[0].value || {};
      state.output.status = statusResult.status || null;
      state.output.store = statusResult.store || null;
    }
    if (results[1].status === 'fulfilled') {
      var history = results[1].value || {};
      state.output.history = Array.isArray(history.items) ? history.items : [];
      state.output.total = Number(history.total) || state.output.history.length;
    }
    if (results[2].status === 'fulfilled') {
      var refs = results[2].value || {};
      state.output.references = Array.isArray(refs.items) ? refs.items : [];
      state.output.referenceActive = typeof refs.active === 'string' ? refs.active : '';
    }
    renderOutputStatus();
    renderOutputHistory();
    renderOutputReferencePanel();
  }

  async function loadOutputPage(options) {
    var opts = options || {};
    state.output.loading = true;
    try {
      await ensureConfigLoaded(opts.force === true);
      var results = await Promise.allSettled([
        api('output.status'),
        api('output.history', { limit: 30, offset: 0 }),
        api('output.reference.list')
      ]);
      if (results[0].status === 'fulfilled') {
        var statusResult = results[0].value || {};
        state.output.status = statusResult.status || null;
        state.output.store = statusResult.store || null;
      } else {
        state.output.status = null;
        state.output.error = errMessage(results[0].reason);
      }
      if (results[0].status === 'fulfilled') state.output.error = '';
      if (results[1].status === 'fulfilled') {
        var history = results[1].value || {};
        state.output.history = Array.isArray(history.items) ? history.items : [];
        state.output.total = Number(history.total) || state.output.history.length;
      } else {
        state.output.history = [];
        state.output.total = 0;
      }
      if (results[2].status === 'fulfilled') {
        var refs = results[2].value || {};
        state.output.references = Array.isArray(refs.items) ? refs.items : [];
        state.output.referenceActive = typeof refs.active === 'string' ? refs.active : '';
      }
      renderOutputStatus();
      renderOutputConfig();
      renderOutputWarnings();
      renderOutputKindTabs();
      renderOutputHistory();
      renderOutputReferencePanel();
    } finally {
      state.output.loading = false;
    }
  }

  async function loadMoreOutput() {
    var offset = (state.output.history || []).length;
    var result = await api('output.history', { limit: 30, offset: offset });
    var items = result && Array.isArray(result.items) ? result.items : [];
    state.output.history = (state.output.history || []).concat(items);
    state.output.total = result && Number.isFinite(Number(result.total)) ? Number(result.total) : state.output.history.length;
    renderOutputHistory();
  }

  function saveOutputConfig() {
    return withLoading($('#btnOutputSave'), async function () {
      var patch = collectConfigPatchFrom($('#outputConfig'));
      var result = await api('config.save', { patch: patch });
      if (result && result.config && typeof result.config === 'object') state.config = result.config;
      state.configLoaded = true;
      state.configWarnings = result && Array.isArray(result.warnings) ? result.warnings : [];
      renderOutputConfig();
      renderOutputWarnings();
      renderAllSettingsForms();
      toast('多模态输出接口配置已保存', 'success');
      await loadOutputLibrary();
      refreshSnapshot({ silent: true }).catch(function () {});
    }, '保存中…');
  }

  async function testOutputInterface(kind, button) {
    var resultEl = $('[data-output-test-result="' + kind + '"]');
    if (resultEl) {
      resultEl.className = 'output-test-result';
      resultEl.textContent = '检测中…';
    }
    try {
      var result = await withLoading(button, function () { return api('output.test', { kind: kind }); }, '检测中…');
      var ok = result && result.ok !== false;
      var warning = result && result.warning ? String(result.warning) : '';
      var suggestion = result && result.suggestedBaseUrl
        ? '当前 Base URL 未包含 /v1，已自动按 ' + String(result.url) + ' 请求；建议把 Base URL 改为 ' + String(result.suggestedBaseUrl)
        : '';
      if (resultEl) {
        if (!ok) {
          resultEl.className = 'output-test-result result-err';
          resultEl.textContent = '检测失败：' + String((result && result.error) || '未知错误');
        } else if (warning) {
          resultEl.className = 'output-test-result result-ok';
          resultEl.textContent = '配置已通过：' + warning;
        } else {
          var parts = ['接口可达'];
          if (result.mode === 'models') {
            parts.push('模型列表 ' + fmtNum(result.modelCount) + ' 个');
            if (result.modelFound === true) parts.push('已找到配置模型');
            else if (result.modelFound === false) parts.push('未在模型列表中匹配到「' + String((state.config && getPath(state.config, 'output.' + kind + '.model')) || '') + '」');
          }
          if (result.url) parts.push('实际请求 ' + String(result.url));
          if (result.ms !== undefined) parts.push('耗时 ' + fmtNum(result.ms) + 'ms');
          if (suggestion) parts.push(suggestion);
          resultEl.className = result.modelFound === false ? 'output-test-result' : 'output-test-result result-ok';
          resultEl.textContent = parts.join(' · ');
        }
      }
      if (!ok) toast('接口检测失败：' + String((result && result.error) || '未知错误'), 'error');
      else if (warning) toast(warning, 'warn');
      else if (suggestion) toast(suggestion, 'warn');
      else if (result.modelFound === false) toast('接口可达，但模型名未在模型列表中找到，请确认模型可用', 'warn');
      else toast(OUTPUT_KIND_LABELS[kind] + '接口检测通过', 'success');
      return result;
    } catch (err) {
      if (resultEl) {
        resultEl.className = 'output-test-result result-err';
        resultEl.textContent = '检测失败：' + errMessage(err);
      }
      throw err;
    }
  }

  function runOutputGenerate() {
    var kind = state.output.kind;
    var promptEl = $('#outputPrompt');
    var prompt = promptEl ? String(promptEl.value || '').trim() : '';
    if (prompt === '') {
      toast('请先填写提示词', 'warn');
      return Promise.resolve();
    }
    var statusEl = $('#outputGenerateStatus');
    var started = Date.now();
    var timer = 0;
    if (statusEl) {
      statusEl.textContent = OUTPUT_KIND_LABELS[kind] + '生成中…';
      timer = window.setInterval(function () {
        var seconds = Math.round((Date.now() - started) / 1000);
        statusEl.textContent = OUTPUT_KIND_LABELS[kind] + '生成中… 已等待 ' + seconds + ' 秒' + (kind === 'video' ? '（视频可能需要几分钟）' : '');
      }, 1000);
    }
    return withLoading($('#btnOutputGenerate'), async function () {
      try {
        var result = await api('output.generate', { kind: kind, prompt: prompt }, { timeoutMs: 660000 });
        state.output.lastRecords = result && Array.isArray(result.records) ? result.records : [];
        renderOutputResult(state.output.lastRecords);
        var elapsed = Math.round((Date.now() - started) / 1000);
        if (statusEl) statusEl.textContent = '生成完成，用时 ' + elapsed + ' 秒';
        toast(OUTPUT_KIND_LABELS[kind] + '生成完成', 'success');
        await loadOutputLibrary();
        refreshSnapshot({ silent: true }).catch(function () {});
        return result;
      } catch (err) {
        if (statusEl) statusEl.textContent = '生成失败';
        throw err;
      } finally {
        if (timer) window.clearInterval(timer);
      }
    }, '生成中…');
  }

  function openOutputPreview(id) {
    var record = outputRecordById(id);
    if (!record) return;
    var url = outputMediaUrl(id);
    openModal({
      title: OUTPUT_KIND_LABELS[record.kind] + '作品预览',
      wide: true,
      bodyHtml:
        '<div class="output-result-preview"><img src="' + esc(url) + '" alt="' + esc(record.prompt || '') + '" /></div>' +
        '<div class="output-result-meta">' + outputKindBadge(record.kind) + ' ' + esc(record.model || '') + ' · ' + fmtBytes(record.size) + ' · ' + fmtTime(record.createdAt) + '</div>' +
        '<p class="output-item-prompt" style="margin-top:8px">' + esc(record.prompt || '') + '</p>',
      actions: [{ label: '关闭', onClick: function (ctx) { ctx.close(); } }]
    });
  }

  async function deleteOutputRecord(id) {
    var confirmed = await confirmModal({
      title: '删除生成结果',
      message: '确定删除这条生成记录及本地文件吗？删除后无法恢复。',
      confirmLabel: '删除',
      danger: true
    });
    if (!confirmed) return;
    await api('output.delete', { id: id });
    state.output.history = (state.output.history || []).filter(function (record) { return record.id !== id; });
    state.output.total = Math.max(0, (Number(state.output.total) || 0) - 1);
    renderOutputHistory();
    toast('已删除生成结果', 'success');
    await loadOutputLibrary();
  }

  async function clearOutputLibrary() {
    var confirmed = await confirmModal({
      title: '清空作品库',
      message: '将删除所有生成的图片 / 语音 / 视频文件，无法恢复。确定继续吗？',
      confirmLabel: '全部清空',
      danger: true
    });
    if (!confirmed) return;
    await api('output.clear');
    state.output.history = [];
    state.output.total = 0;
    state.output.lastRecords = [];
    renderOutputResult([]);
    renderOutputHistory();
    toast('作品库已清空', 'success');
    await loadOutputLibrary();
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

  // ---------------------------------------------------------------------------
  // 群成员长期事实（按 ID）：chats.get 可能返回 members 数组
  // [{ id, name, facts: [{ id, text, createdAt }], messageCount, updatedAt }]
  // ---------------------------------------------------------------------------
  function memberFactTexts(member) {
    var facts = member && Array.isArray(member.facts) ? member.facts : [];
    return facts.map(function (fact) {
      return typeof fact === 'string' ? fact : (fact && (fact.text || fact.fact)) || '';
    }).filter(Boolean);
  }

  function renderMemberFacts(member) {
    var facts = memberFactTexts(member);
    if (!facts.length) return '<p class="muted small member-empty">暂无长期事实</p>';
    return '<ul class="fact-list member-facts">' + facts.map(function (fact) {
      return '<li>' + esc(fact) + '</li>';
    }).join('') + '</ul>';
  }

  function renderChatMembers(members) {
    var list = (Array.isArray(members) ? members : []).filter(function (member) {
      return member !== null && typeof member === 'object';
    });
    var intro = '<p class="muted small member-intro">群聊中每个发言者的长期事实按用户 ID 分开记录，该成员下次发言时会注入其个人记忆。</p>';
    if (!list.length) {
      return intro + emptyHtml('暂无群成员长期事实');
    }
    var items = list.map(function (member) {
      var id = String(member.id || member.userId || '');
      var name = String(member.name || '').trim();
      var messageCount = Number.isFinite(Number(member.messageCount)) ? Number(member.messageCount) : 0;
      var factCount = memberFactTexts(member).length;
      return (
        '<div class="member-item">' +
        '<div class="member-head">' +
        '<span class="member-name">' + esc(name || '未命名成员') + '</span>' +
        (id ? '<code class="mono member-id">' + esc(id) + '</code>' : '<span class="muted small member-id">未知 ID</span>') +
        '<span class="muted small member-meta">事实 ' + factCount + ' · 消息 ' + fmtNum(messageCount) + ' · 更新 ' + fmtAgo(member.updatedAt) + '</span>' +
        '</div>' +
        renderMemberFacts(member) +
        '</div>'
      );
    }).join('');
    return intro + '<div class="member-list">' + items + '</div>';
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
    var members = Array.isArray(result.members) ? result.members : (Array.isArray(chat.members) ? chat.members : []);
    var counters = chat.counters || {};
    var chatId = String(chat.id || state.chats.current || '');
    var isGroupChat = chat.kind === 'group' || chatId.indexOf('group_') === 0;
    var personaFields = persona || {};
    var membersBlock = '';
    if (isGroupChat || members.length) {
      membersBlock =
        '<details class="detail-block" open><summary>群成员长期事实（按 ID）' +
        (members.length ? '（' + fmtNum(members.length) + '）' : '') +
        '</summary>' + renderChatMembers(members) + '</details>';
    }
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
      membersBlock +
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
          await loadTabNow(state.tab, { force: true });
          toast('已刷新', 'success');
        }, '刷新中…');
      });
    });
    on('#sideToggle', 'click', function () {
      var sidebar = $('#appSidebar');
      setSidebarOpen(!(sidebar && sidebar.classList.contains('is-open')));
    });
    on('#sideBackdrop', 'click', function () {
      setSidebarOpen(false);
    });
    document.addEventListener('keydown', function (event) {
      if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 'k') {
        event.preventDefault();
        var search = $('#navSearch');
        if (search) {
          search.focus();
          search.select();
        }
        return;
      }
      if (event.key !== 'Escape') return;
      if (modalState) return;
      if (event.defaultPrevented) return;
      var sidebar = $('#appSidebar');
      if (sidebar && sidebar.classList.contains('is-open')) {
        setSidebarOpen(false);
        return;
      }
      var active = document.activeElement;
      if (active && (active.id === 'navSearch' || active.dataset.configSearch)) {
        active.value = '';
        if (active.id === 'navSearch') filterSideNav('');
        else {
          var containerId = active.dataset.configSearch;
          filterSettingsFields(containerId, '');
          var count = $('[data-config-count="' + containerId + '"]');
          if (count) count.textContent = '';
        }
        active.blur();
        return;
      }
      exitConsole();
    });
  }

  function bindNavigation() {
    var nav = $('#sideNav');
    if (nav) {
      nav.addEventListener('click', function (event) {
        var target = event.target;
        if (!(target instanceof Element)) return;
        var button = target.closest('.nav-item');
        if (!button) return;
        navigate(button.dataset.nav, {});
      });
    }
    on(
      '#navSearch',
      'input',
      debounce(function () {
        var input = $('#navSearch');
        filterSideNav(input ? input.value : '');
      }, 120)
    );
    document.addEventListener('click', function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      var pageTab = target.closest('.page-tab[data-subtab]');
      if (pageTab) {
        navigate(state.tab, { section: pageTab.dataset.subtab });
        return;
      }
      var saveButton = target.closest('[data-save-config]');
      if (saveButton) {
        handle(function () {
          return saveSettingsFrom(saveButton.dataset.saveConfig);
        });
        return;
      }
      var link = target.closest('[data-nav-link]');
      if (!link) return;
      event.preventDefault();
      navigate(link.dataset.navLink, { section: link.dataset.configSection || '' });
    });
    window.addEventListener('hashchange', applyLocation);
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

  function bindOutput() {
    on('#btnOutputSave', 'click', function () {
      handle(saveOutputConfig);
    });
    on('#btnOutputRefresh', 'click', function () {
      var button = $('#btnOutputRefresh');
      handle(function () {
        return withLoading(button, function () { return loadOutputPage({ force: true }); }, '刷新中…');
      });
    });
    on('#btnOutputHistoryRefresh', 'click', function () {
      var button = $('#btnOutputHistoryRefresh');
      handle(function () {
        return withLoading(button, loadOutputLibrary, '刷新中…');
      });
    });
    on('#btnOutputMore', 'click', function () {
      var button = $('#btnOutputMore');
      handle(function () {
        return withLoading(button, loadMoreOutput, '加载中…');
      });
    });
    on('#btnOutputGenerate', 'click', function () {
      handle(runOutputGenerate);
    });
    on('#btnOutputClear', 'click', function () {
      var button = $('#btnOutputClear');
      handle(function () {
        return withLoading(button, clearOutputLibrary, '清理中…');
      });
    });
    on('#outputKindTabs', 'click', function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      var button = target.closest('[data-output-kind]');
      if (!button) return;
      state.output.kind = button.dataset.outputKind || 'image';
      renderOutputKindTabs();
    });
    var configRoot = $('#outputConfig');
    if (configRoot) {
      configRoot.addEventListener('click', function (event) {
        var target = event.target;
        if (!(target instanceof Element)) return;
        var testButton = target.closest('[data-output-test]');
        if (testButton) {
          handle(function () {
            return testOutputInterface(testButton.dataset.outputTest, testButton);
          });
          return;
        }
        if (target.closest('[data-reference-upload]')) {
          var input = $('#referenceFileInput');
          if (input) input.click();
          return;
        }
        var useButton = target.closest('[data-reference-use]');
        if (useButton) {
          handle(function () {
            return withLoading(useButton, function () {
              return activateOutputReference(useButton.dataset.referenceUse, false);
            }, '设置中…');
          });
          return;
        }
        if (target.closest('[data-reference-clear]')) {
          handle(function () {
            return withLoading(target.closest('[data-reference-clear]'), clearOutputReference, '处理中…');
          });
          return;
        }
        var deleteButton = target.closest('[data-reference-delete]');
        if (deleteButton) {
          handle(function () {
            return deleteOutputReference(deleteButton.dataset.referenceDelete);
          });
        }
      });
      configRoot.addEventListener('change', function (event) {
        var target = event.target;
        if (!(target instanceof Element)) return;
        if (target.id === 'referenceFileInput') {
          var file = target.files && target.files[0] ? target.files[0] : null;
          target.value = '';
          if (file) {
            handle(function () {
              return uploadOutputReference(file);
            });
          }
          return;
        }
        refreshConditionalFields(configRoot);
      });
      configRoot.addEventListener('input', function () {
        refreshConditionalFields(configRoot);
      });
    }
    var historyRoot = $('#outputHistory');
    if (historyRoot) {
      historyRoot.addEventListener('click', function (event) {
        var target = event.target;
        if (!(target instanceof Element)) return;
        var preview = target.closest('[data-preview-output]');
        if (preview) {
          openOutputPreview(preview.dataset.previewOutput);
          return;
        }
        var remove = target.closest('[data-delete-output]');
        if (remove) {
          handle(function () {
            return deleteOutputRecord(remove.dataset.deleteOutput);
          });
        }
      });
    }
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

  function bindSettings() {
    var searchTimer = 0;
    document.addEventListener('input', function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      if (target.matches('[data-config-search]')) {
        var containerId = target.dataset.configSearch;
        var value = target.value;
        window.clearTimeout(searchTimer);
        searchTimer = window.setTimeout(function () {
          filterSettingsFields(containerId, value);
        }, 120);
      }
      var container = target.closest('.settings-form');
      if (container) refreshConditionalFields(container);
    });
    document.addEventListener('change', function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      var container = target.closest('.settings-form');
      if (container) refreshConditionalFields(container);
    });
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
    renderSideNav();
    bindNavigation();
    bindOverview();
    bindSettings();
    bindOutput();
    bindStickers();
    bindBudget();
    bindChats();
    bindPeople();
    bindLogs();
    renderOverview();
    // Hydrate the sidebar status/data-dir even when the first route is not the
    // overview (e.g. a bookmarked #/dialog/persona deep link).
    refreshSnapshot({ silent: true }).catch(function () {});
    applyLocation();
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
