import electron from 'electron'
const { ipcMain, shell, dialog, BrowserWindow } = electron
import {
  scanPlugins,
  setPluginEnabled,
  setPluginPermission,
  hasPermission,
  openPluginDirPath,
  installPlugin,
  removePlugin,
  readPluginManifest,
  PLUGIN_PERMISSIONS
} from '../services/pluginManager'
import { existsSync, mkdirSync } from 'node:fs'
import type { PluginPermission } from '../../shared/types'
import { callPluginApi } from './pluginApi'

/**
 * 插件 IPC：
 * - list / setEnabled / setPermission / openDir / rescan：清单与权限管理（用户全权）。
 * - call：插件经白名单调用应用 API；每次调用在运行时按该插件授权集合拦截（未授权 → 拒绝）。
 */
export function registerPluginIpc(): void {
  ipcMain.handle('plugins:list', async () => scanPlugins(true))

  ipcMain.handle('plugins:setEnabled', async (_e, id: string, enabled: boolean) => {
    if (typeof id !== 'string' || typeof enabled !== 'boolean') return scanPlugins(true)
    return setPluginEnabled(id, enabled)
  })

  ipcMain.handle('plugins:setPermission', async (_e, id: string, permission: PluginPermission, granted: boolean) => {
    if (typeof id !== 'string' || !PLUGIN_PERMISSIONS.includes(permission)) return scanPlugins(true)
    return setPluginPermission(id, permission, typeof granted === 'boolean' ? granted : false)
  })

  ipcMain.handle('plugins:call', async (_e, id: string, method: string, args: unknown[]) => {
    if (typeof id !== 'string' || typeof method !== 'string') return { ok: false, error: 'invalid-call' }
    // 运行时权限拦截：按方法对应的权限检查
    const permission = methodToPermission(method)
    if (permission && !(await hasPermission(id, permission))) {
      return { ok: false, error: 'permission-denied' }
    }
    return callPluginApi(method, Array.isArray(args) ? args : [], id)
  })

  ipcMain.handle('plugins:openDir', async () => {
    const dir = openPluginDirPath()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    shell.openPath(dir)
    return true
  })

  ipcMain.handle('plugins:rescan', async () => scanPlugins(true))

  // 安装插件：选择插件文件夹 → 校验 manifest → 复制到插件目录
  ipcMain.handle('plugins:install', async () => {
    const sel = await dialog.showOpenDialog({
      title: '选择插件文件夹（需含 manifest.json）',
      properties: ['openDirectory']
    })
    if (sel.canceled || !sel.filePaths?.length) return { ok: false, canceled: true }
    const src = sel.filePaths[0]
    const manifest = readPluginManifest(src)
    if (!manifest?.id) return { ok: false, error: '所选文件夹缺少合法的 manifest.json（需包含 id 字段）' }
    const r = await installPlugin(src)
    if (r.ok) return { ok: true, name: manifest.name ?? manifest.id, version: manifest.version ?? '0.0.0' }
    return r
  })

  // 删除插件：渲染端二次确认后调用，移除目录 + 清理状态
  ipcMain.handle('plugins:remove', async (_e, id: string) => {
    if (typeof id !== 'string') return { ok: false, error: 'invalid-id' }
    const r = await removePlugin(id)
    if (r.ok) return { ok: true }
    return r
  })
}

// 方法名 → 所需权限的映射（未列出的方法视为内置 util，仅需 plugin 存在）
function methodToPermission(method: string): PluginPermission | null {
  if (method.startsWith('storage.')) return 'storage'
  if (method.startsWith('collection.')) return 'collection'
  if (method.startsWith('subject.')) return 'subject'
  if (method.startsWith('settings.')) return 'settings'
  if (method.startsWith('ui.')) return 'ui'
  if (method.startsWith('network.')) return 'network'
  return null // style/script 是注入能力，不走 call
}