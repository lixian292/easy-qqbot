/** Lead-owned test for the client half: loads client.js in a VM with a fake module loader. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

function makeFakeReact() {
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect() {},
    useRef(value) {
      return { current: value }
    },
    useCallback(fn) {
      return fn
    }
  }
  return React
}

function loadClientHalfFactory() {
  const captured = { id: null, factory: null }
  const window = {
    __ModuleLoader__: {
      load(definition) {
        captured.id = definition.id
        captured.factory = definition.factory
      }
    }
  }
  const code = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  vm.runInNewContext(code, { window, console, location: { origin: 'http://127.0.0.1:1' }, setInterval, clearInterval })
  assert.equal(captured.id, 'easy-qqbot', 'client module id must equal the package name')
  assert.equal(typeof captured.factory, 'function')
  const React = makeFakeReact()
  const require = (name) => {
    if (name === 'react') return React
    throw new Error(`unexpected import: ${name}`)
  }
  return { plugin: captured.factory(require), React }
}

test('client half registers sidebar entry, main page and locale dictionaries', () => {
  const { plugin } = loadClientHalfFactory()
  assert.deepEqual([...plugin.inject], ['slots', 'layout', 'locale'])

  const registrations = []
  const effects = []
  const localeDictionaries = []
  const localeBindings = []
  const dict = {
    zh: { 'entry.title': 'QQ 机器人', 'page.title': 'QQ 机器人' },
    en: { 'entry.title': 'QQ Bot', 'page.title': 'QQ Bot' }
  }
  const layout = { selectPanel: () => {} }
  const ctx = {
    get(name) {
      return name === 'layout' ? layout : undefined
    },
    effect(fn, label) {
      effects.push({ label, dispose: fn() })
      return () => {}
    },
    locale: {
      register(ns, dictionaries) {
        localeDictionaries.push({ ns, dictionaries })
        return () => {}
      },
      bind(ns) {
        localeBindings.push(ns)
        return (key) => dict.zh[key] ?? key
      }
    },
    slots: {
      inject(name, callback) {
        registrations.push({ injected: name, registered: callback() })
      },
      register(options, component) {
        return { options, component }
      }
    }
  }

  plugin.apply(ctx)

  const sidebar = registrations.find((entry) => entry.injected === 'sidebar.panellist')
  assert.ok(sidebar, 'sidebar.panellist must be injected')
  assert.equal(sidebar.registered.options.id, 'qqbot')
  assert.equal(sidebar.registered.options.locale, 'easy-qqbot')
  assert.equal(sidebar.registered.options.label(), 'QQ 机器人')
  const icon = sidebar.registered.component({ size: 20 })
  assert.equal(typeof icon.type, 'function', 'sidebar component wraps the icon component')
  const iconElement = icon.type({ size: 20 })
  assert.equal(iconElement.type, 'svg')

  const mainRegistrations = registrations.filter((entry) => entry.injected === 'main')
  assert.equal(mainRegistrations.length, 2, 'dashboard + in-app console panels must both register')
  const dashboard = mainRegistrations.find((entry) => entry.registered.options.key === 'qqbot')
  assert.ok(dashboard, 'dashboard panel must be registered under the sidebar id')
  const dashboardElement = dashboard.registered.component({})
  assert.equal(dashboardElement.type.name, 'QqbotPage')
  assert.equal(typeof dashboardElement.props.t, 'function')
  assert.equal(typeof dashboardElement.props.onBack, 'function')
  assert.equal(typeof dashboardElement.props.openConsole, 'function')

  const consolePanel = mainRegistrations.find((entry) => entry.registered.options.key === 'qqbot-console')
  assert.ok(consolePanel, 'in-app console panel must be registered')
  const consoleElement = consolePanel.registered.component({})
  assert.equal(consoleElement.type.name, 'ConsolePage')
  assert.equal(typeof consoleElement.props.onExit, 'function')
  assert.equal(typeof consoleElement.props.onDashboard, 'function')

  assert.equal(localeDictionaries.length, 1)
  assert.equal(localeDictionaries[0].ns, 'easy-qqbot')
  assert.deepEqual(Object.keys(localeDictionaries[0].dictionaries).sort(), ['en', 'zh'])
  assert.deepEqual(localeBindings, ['easy-qqbot'])
  assert.ok(effects.length >= 1)
})

test('client half opens the console inside the app and can return without reload', () => {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(source.includes("const API_PATH = '/qqbot/api'"))
  assert.ok(source.includes("const CONSOLE_PATH = '/qqbot/'"))
  assert.ok(source.includes("const CONSOLE_PANEL_ID = 'qqbot-console'"))
  assert.ok(source.includes('selectPanel'), 'panel switching must use the layout service')
  assert.ok(source.includes('layout.selectPanel(null)') || source.includes('selectPanel(null)'))
  assert.ok(source.includes("h('iframe'"), 'console panel must mount the console in an iframe')
  assert.ok(source.includes("addEventListener('message'"), 'console panel must listen for the embedded exit message')
  assert.ok(source.includes("'qqbot-console-exit'"), 'exit message type must be shared with the console page')
  assert.ok(source.includes('getBoundingClientRect'), 'console panel must measure available height')
  assert.ok(source.includes('innerHeight'), 'console panel must fill the viewport below its top edge')
  assert.ok(!source.includes('popup=yes'), 'console must not open as a popup child window')
  assert.ok(source.includes('fetch('))
  assert.ok(!source.includes('eval('), 'client half must not use eval')
  assert.ok(!/https?:\/\//.test(source.replace(/http:\/\/127\.0\.0\.1:1/g, '')), 'client half must not hardcode remote URLs')
})

test('admin console page provides an exit affordance', () => {
  const html = fs.readFileSync(new URL('../host/admin/ui/index.html', import.meta.url), 'utf8')
  const app = fs.readFileSync(new URL('../host/admin/ui/app.js', import.meta.url), 'utf8')
  assert.ok(html.includes('id="exitBtn"'))
  assert.ok(html.includes('退出工作台'))
  assert.ok(app.includes('function exitConsole'))
  assert.ok(app.includes('window.close()'))
  assert.ok(app.includes('window.location.assign(\'/\')'))
  assert.ok(app.includes('qqbot-console-exit'), 'embedded console must notify its parent when exiting')
})
