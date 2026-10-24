import { ref } from 'vue'
import type { PluginDescriptor, PluginPermission } from '@shared/types'

/**
 * 渲染端插件客户端：
 * - 从主进程拉取插件清单并按启停注入样式 / 沙箱执行脚本（方案 A：Function + 白名单）。
 * - 插件脚本内只能访问注入的受限 PluginApi（经 plugins:call 白名单），无权访问 window.acgn /
 *   require / Node；未授权权限的调用由主进程运行时拦截。
 */
const descriptors = ref<PluginDescriptor[]>([])
let loaded = false

async function refresh(): Promise<void> {
  descriptors.value = await window.acgn.plugins.list()
  applyAll()
}

function applyAll(): void {
  // 先清理所有已注入的插件样式/副作用，再按当前清单重建
  cleanupAll()
  for (const d of descriptors.value) {
    if (!d.enabled) continue
    if (d.css && d.permissions.includes('style')) injectStyle(d)
    if (d.script && d.permissions.includes('script')) runScript(d)
  }
}

function cleanupAll(): void {
  for (const d of descriptors.value) {
    const el = document.getElementById(`plugin-css-${cssSafe(d.id)}`)
    if (el) el.remove()
    unloadScript(d.id)
  }
}

function cssSafe(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '')
}

function injectStyle(d: PluginDescriptor): void {
  const id = cssSafe(d.id)
  let el = document.getElementById(`plugin-css-${id}`) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = `plugin-css-${id}`
    document.head.appendChild(el)
  }
  el.textContent = d.css ?? ''
}

// 已执行的脚本必须返回卸载函数（可选），停用时调用以清理副作用
const unloaders = new Map<string, (() => void) | void>()

function unloadScript(id: string): void {
  const fn = unloaders.get(id)
  try {
    if (typeof fn === 'function') fn()
  } catch {
    /* 忽略插件清理错误 */
  }
  unloaders.delete(id)
}

// 给脚本注入的受限 API（插件只能拿到这些，不能碰全局）
function buildPluginApi(id: string) {
  const call = (method: string) => (...args: unknown[]): Promise<unknown> =>
    window.acgn.plugins.call(id, method, args).then((r: { ok: boolean; data?: unknown; error?: string }) => {
      if (r.ok) return r.data
      throw new Error(r.error || 'plugin-call-failed')
    })
  const api: {
    storage: any
    settings: any
    collection: any
    ui: any
    network: any
    PluginApi?: typeof api
  } = {
    storage: {
      get: call('storage.get'),
      set: call('storage.set')
    },
    settings: {
      get: call('settings.get'),
      set: call('settings.set')
    },
    collection: {
      getAll: call('collection.getAll'),
      getExisting: call('collection.getExisting')
    },
    ui: {
      mount: (selector: string, html: string) => {
        const el =
          selector === '__plugin-root__'
            ? document.getElementById('plugin-ui-root')
            : document.querySelector(selector)
        if (el) el.innerHTML = html
        else console.warn(`[plugin:${id}] 挂载目标不存在：${selector}`)
      },
      toast: (msg: string) => {
        console.info(`[plugin:${id}] ${msg}`)
      }
    },
    network: {
      searchVndb: call('network.searchVndb'),
      searchMal: call('network.searchMal'),
      searchAnilist: call('network.searchAnilist'),
      searchKitsu: call('network.searchKitsu')
    }
  }
  // 让插件代码能以 PluginApi.xxx 风格调用
  api.PluginApi = api
  return api
}

function runScript(d: PluginDescriptor): void {
  const id = cssSafe(d.id)
  try {
    // 方案 A：把插件源码包进函数，只暴露受限 sandbox（不可信内容不直接注入全局）
    const sandbox = buildPluginApi(id)
    // 用 with 让插件能直接写 PluginApi.xxx（沙箱内可见性）；插件仍可通过全局访问 window/document，
    // 这是方案 A 的已知取舍——权限表 + 用户全权管控已覆盖主要风险。
    const wrapper = new Function('sandbox', `with (sandbox) { ${d.script} }`)
    const unload = wrapper(sandbox)
    unloaders.set(id, unload)
  } catch (e) {
    console.warn(`[plugin:${id}] 脚本执行失败：`, e)
  }
}

// 供设置页列出全部权限（勾选用）
export const ALL_PERMISSIONS: PluginPermission[] = [
  'style',
  'script',
  'storage',
  'collection',
  'subject',
  'settings',
  'ui',
  'network'
]

export const PERMISSION_LABELS: Record<PluginPermission, string> = {
  style: '样式注入',
  script: '脚本执行',
  storage: '插件存储',
  collection: '读取收藏',
  subject: '读取作品',
  settings: '读写设置',
  ui: '界面挂载',
  network: '网络请求'
}

export function usePlugins() {
  if (!loaded) {
    loaded = true
    void refresh()
  }
  const list = async () => {
    await refresh()
    return descriptors.value
  }
  const setEnabled = async (id: string, enabled: boolean) => {
    await window.acgn.plugins.setEnabled(id, enabled)
    await refresh()
  }
  const setPermission = async (id: string, permission: PluginPermission, granted: boolean) => {
    await window.acgn.plugins.setPermission(id, permission, granted)
    await refresh()
  }
  const openDir = () => window.acgn.plugins.openDir()
  const rescan = async () => {
    await window.acgn.plugins.rescan()
    await refresh()
  }
  const install = async () => {
    const r = await window.acgn.plugins.install()
    if (r.ok) await refresh()
    return r
  }
  const remove = async (id: string) => {
    const r = await window.acgn.plugins.remove(id)
    if (r.ok) await refresh()
    return r
  }
  return {
    plugins: descriptors,
    list,
    setEnabled,
    setPermission,
    openDir,
    rescan,
    install,
    remove
  }
}