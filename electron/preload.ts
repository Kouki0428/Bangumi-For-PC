import electron from 'electron'
const { contextBridge, ipcRenderer, webFrame } = electron
import type { AcgnApi, EntityDetail, SubjectFullDetail, SubjectCharacter, SubjectPerson, SubjectComment, EpisodeProgressState, SubjectFullEpisode, EpisodeComment, EpisodeDetail, CacheStats, NetworkStatsResult, BgmTopic, BgmTopicDetail, BgmStatus } from '../shared/types'

// 仅暴露白名单方法，绝不直接暴露 require / fs / ipcRenderer 本身
const api: AcgnApi = {
  app: {
    getInfo: () => ipcRenderer.invoke('app:getInfo'),
    getReleaseNotes: (tag: string) =>
      ipcRenderer.invoke('app:getReleaseNotes', tag) as Promise<string | null>,
    openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
    relaunch: () => ipcRenderer.invoke('app:relaunch'),
    setProxy: (url: string | null) => ipcRenderer.invoke('app:setProxy', url),
    setCloseBehavior: (v: 'minimize' | 'exit') => ipcRenderer.invoke('app:setCloseBehavior', v),
    getDataDir: () =>
      ipcRenderer.invoke('app:getDataDir') as Promise<{ dir: string; custom: boolean }>,
    openDataDir: () => ipcRenderer.invoke('app:openDataDir') as Promise<void>,
    setDataDir: (dir: string | null) =>
      ipcRenderer.invoke('app:setDataDirResult', dir) as Promise<{
        ok: boolean
        error?: string
        path?: string
        sameTarget?: boolean
      }>,
    pickDataDir: () =>
      ipcRenderer.invoke('app:pickDataDir') as Promise<{
        ok: boolean
        canceled?: boolean
        error?: string
        path?: string
      }>,
    checkUpdate: () =>
      ipcRenderer.invoke('app:checkUpdate') as Promise<{
        ok: boolean
        updateAvailable?: boolean
        version?: string
        error?: string
      }>,
    installUpdate: () =>
      ipcRenderer.invoke('app:installUpdate') as Promise<{ ok: boolean; error?: string }>,
    /** 首次关闭：主进程询问用户选择行为 */
    onCloseBehaviorAsk: (cb: () => void) => {
      const listener = () => cb()
      ipcRenderer.on('closeBehavior:ask', listener)
      return () => ipcRenderer.removeListener('closeBehavior:ask', listener)
    },
    answerCloseBehavior: (pick: 'minimize' | 'exit', remember: boolean) =>
      ipcRenderer.send('app:answerCloseBehavior', pick, remember),
    getNetworkStats: () => ipcRenderer.invoke('app:getNetworkStats') as Promise<NetworkStatsResult>,
    /** Bangumi 可用性监测（bgm-status 探针，社区数据）；失败返回 null */
    getBgmStatus: () => ipcRenderer.invoke('app:getBgmStatus') as Promise<BgmStatus | null>
  },
  db: {
    query: (sql: string, params?: unknown[]) => ipcRenderer.invoke('db:query', sql, params),
    run: (sql: string, params?: unknown[]) => ipcRenderer.invoke('db:run', sql, params)
  },
  api: {
    // 统一搜索：条目 / 人物，query 由调用方构造
    search: (query) => ipcRenderer.invoke('api:search', query),
    // 标签搜索（p1 /search/subjects）：按 tags/metaTags/type 检索作品
    searchByTag: (query) => ipcRenderer.invoke('api:searchByTag', query),
    // 按关键词搜索标签（p1 频道标签 + 过滤）：返回标签候选 [{name,count}]
    searchTags: (payload: { keyword: string; type?: number }) =>
      ipcRenderer.invoke('api:searchTags', payload),
    // 频道热门标签（p1 /channels/{type}/tags）：标签搜索的联想 / 热门标签
    channelTags: (type: number) => ipcRenderer.invoke('api:channelTags', type),
    // 后台预热标签搜索缓存（进入标签模式时调用）
    warmTagCache: (types: number[]) => ipcRenderer.invoke('api:warmTagCache', types),
    gallery: (subjectId: number | string, force?: boolean) =>
      ipcRenderer.invoke('api:gallery', subjectId, force)
  },
  anime: {
    addToWatching: (subject) => ipcRenderer.invoke('anime:addToWatching', subject),
    getDetailLocal: (subjectId) => ipcRenderer.invoke('anime:getDetailLocal', subjectId),
    getDetailsLocal: (subjectIds) => ipcRenderer.invoke('anime:getDetailsLocal', subjectIds),
    getDetail: (subjectId) => ipcRenderer.invoke('anime:getDetail', subjectId),
    toggleEpisode: (collectionId, episodeId) =>
      ipcRenderer.invoke('anime:toggleEpisode', collectionId, episodeId),
    setEpisodeStatus: (collectionId, payload) =>
      ipcRenderer.invoke('anime:setEpisodeStatus', collectionId, payload),
    listWatching: (status = 3) => ipcRenderer.invoke('anime:listWatching', status),
    getStats: () => ipcRenderer.invoke('anime:getStats')
  },
  collection: {
    add: (subject, status) => ipcRenderer.invoke('collection:add', subject, status),
    detailLocal: (subjectId) => ipcRenderer.invoke('collection:detailLocal', subjectId),
    detail: (subjectId) => ipcRenderer.invoke('collection:detail', subjectId),
    setProgress: (collectionId, value, kind, localOnly) =>
      ipcRenderer.invoke('collection:setProgress', collectionId, value, kind, localOnly),
    setStatus: (collectionId, status) =>
      ipcRenderer.invoke('collection:setStatus', collectionId, status),
    setRating: (providerSubjectId, rating) =>
      ipcRenderer.invoke('collection:setRating', providerSubjectId, rating),
    list: (category, status) => ipcRenderer.invoke('collection:list', category, status),
    stats: (category) => ipcRenderer.invoke('collection:stats', category),
    reclassifyBooks: () => ipcRenderer.invoke('collection:reclassifyBooks'),
    saveCollection: (payload) => ipcRenderer.invoke('collection:saveCollection', payload),
    deleteCollection: (providerSubjectId) =>
      ipcRenderer.invoke('collection:deleteCollection', providerSubjectId),
    getExisting: (providerSubjectId) =>
      ipcRenderer.invoke('collection:getExisting', providerSubjectId) as Promise<{
        status: number | null
        comment: string | null
        private: boolean | null
      }>,
    userStats: () => ipcRenderer.invoke('collection:userStats') as Promise<import('../../shared/types').UserStats>,
    routes: (collectionId) => ipcRenderer.invoke('collection:routes', collectionId),
    routeAdd: (collectionId, name) => ipcRenderer.invoke('collection:routeAdd', collectionId, name),
    routeUpdate: (id, name) => ipcRenderer.invoke('collection:routeUpdate', id, name),
    routeDelete: (id) => ipcRenderer.invoke('collection:routeDelete', id)
  },
  purchases: {
    get: (collectionId) => ipcRenderer.invoke('purchases:get', collectionId),
    save: (collectionId, data) => ipcRenderer.invoke('purchases:save', collectionId, data),
    totalSpent: (category) => ipcRenderer.invoke('purchases:totalSpent', category)
  },
  subjectExtra: {
    onCnUpdated: (cb) => {
      const listener = (_event: unknown, p: unknown) => cb(p as any)
      ipcRenderer.on('subjectExtra:cnUpdated', listener)
      return () => ipcRenderer.removeListener('subjectExtra:cnUpdated', listener)
    },
    onSummaryUpdated: (cb) => {
      const listener = (_event: unknown, p: unknown) => cb(p as any)
      ipcRenderer.on('subjectExtra:summaryUpdated', listener)
      return () => ipcRenderer.removeListener('subjectExtra:summaryUpdated', listener)
    },
    onMetaUpdated: (cb) => {
      const listener = (_event: unknown, p: unknown) => cb(p as any)
      ipcRenderer.on('subjectExtra:metaUpdated', listener)
      return () => ipcRenderer.removeListener('subjectExtra:metaUpdated', listener)
    }
  },
  auth: {
    getStatus: () => ipcRenderer.invoke('auth:getStatus'),
    saveToken: (token) => ipcRenderer.invoke('auth:saveToken', token),
    login: () => ipcRenderer.invoke('auth:login'),
    getAppCredentials: () => ipcRenderer.invoke('auth:getAppCredentials'),
    saveAppCredentials: (appId, secret) =>
      ipcRenderer.invoke('auth:saveAppCredentials', appId, secret),
    logout: () => ipcRenderer.invoke('auth:clearToken'),
    getMe: () => ipcRenderer.invoke('auth:getMe') as Promise<{ username?: string; nickname?: string; avatar?: string | null }>
  },
  sync: {
    pushAll: (opts?: { episodeMarks?: boolean }) => ipcRenderer.invoke('sync:pushAll', opts),
    pullAll: () => ipcRenderer.invoke('sync:pullAll'),
    pullAllFull: () => ipcRenderer.invoke('sync:pullAllFull'),
    syncAll: () => ipcRenderer.invoke('sync:syncAll'),
    listRecentCollections: (limit?: number) =>
      ipcRenderer.invoke('sync:listRecentCollections', limit) as Promise<
        Array<{
          providerSubjectId: string
          status: number
          rate: number | null
          epStatus: number
          volStatus: number
          updatedAt: number
        }>
      >,
    onStateChanged: (cb: (s: unknown) => void) => {
      const h = (_e: unknown, s: unknown) => cb(s)
      ipcRenderer.on('sync:stateChanged', h)
      return () => ipcRenderer.removeListener('sync:stateChanged' as never, h as never)
    }
  },
  subject: {
    getComments: (subjectId: string, offset = 0) => ipcRenderer.invoke('subject:comments', subjectId, offset),
    getEntityComments: (kind: 'characters' | 'persons', id: number, offset = 0, limit = 200) =>
      ipcRenderer.invoke('subject:entityComments', kind, id, offset, limit) as Promise<{
        comments: SubjectComment[]
        total: number
        notFound?: boolean
      }>,
    postEntityComment: (payload: { kind: 'characters' | 'persons'; id: number; content: string; relatedID?: number | null }) =>
      ipcRenderer.invoke('subject:postEntityComment', payload) as Promise<number>,
    getTopics: (subjectId: string) =>
      ipcRenderer.invoke('subject:topics', subjectId) as Promise<{
        topics: BgmTopic[]
        total: number
        notFound?: boolean
      }>,
    getTopicDetail: (topicId: number) =>
      ipcRenderer.invoke('subject:topicDetail', topicId) as Promise<BgmTopicDetail | null>,
    getTrendingTopics: (force?: boolean) =>
      ipcRenderer.invoke('subject:trendingTopics', force) as Promise<BgmTopic[]>,
    postTopicReply: (payload: { topicId: number; content: string; replyTo?: number | null }) =>
      ipcRenderer.invoke('subject:postTopicReply', payload) as Promise<{ id: number }>,
    toggleTopicReaction: (payload: { postId: number; value: number; remove?: boolean }) =>
      ipcRenderer.invoke('subject:toggleTopicReaction', payload) as Promise<{ synced: boolean }>,
    getEntity: (kind: 'character' | 'person', id: number) =>
      ipcRenderer.invoke('subject:entity', kind, id) as Promise<EntityDetail>,
    detailFull: (id: number, opts?: { withCn?: boolean }) =>
      ipcRenderer.invoke('subject:detailFull', id, opts) as Promise<SubjectFullDetail>,
    detailLocal: (id: number) =>
      ipcRenderer.invoke('subject:detailLocal', id) as Promise<SubjectFullDetail | null>,
    characters: (id: number) =>
      ipcRenderer.invoke('subject:characters', id) as Promise<SubjectCharacter[]>,
    persons: (id: number) =>
      ipcRenderer.invoke('subject:persons', id) as Promise<SubjectPerson[]>,
    getProgress: (providerSubjectId: string) =>
      ipcRenderer.invoke('subject:getProgress', providerSubjectId) as Promise<{
        collectionId: number | null
        progress: Record<number, EpisodeProgressState>
      }>,
  pullEpisodeProgress: (providerSubjectId: string, opts?: { force?: boolean; reconcile?: boolean; skeleton?: boolean }) =>
    ipcRenderer.invoke('subject:pullEpisodeProgress', providerSubjectId, opts) as Promise<{
      collectionId: number | null
      progress: Record<number, EpisodeProgressState>
      episodes: SubjectFullEpisode[]
    }>,
  shouldRefreshProgress: () =>
    ipcRenderer.invoke('subject:shouldRefreshProgress') as Promise<boolean>,
  markProgressPulled: () =>
    ipcRenderer.invoke('subject:markProgressPulled') as Promise<void>,
  getLastPullAt: () => ipcRenderer.invoke('subject:getLastPullAt') as Promise<number>,
  getRecentActivitySubjects: (sinceSec: number, limit?: number) =>
    ipcRenderer.invoke('subject:getRecentActivitySubjects', sinceSec, limit) as Promise<
      number[] | null
    >,
  nsfwBatch: (ids: number[]) =>
    ipcRenderer.invoke('subject:nsfwBatch', ids) as Promise<Record<string, boolean>>,
  getEpisodes: (providerSubjectId: string) =>
    ipcRenderer.invoke('subject:getEpisodes', providerSubjectId) as Promise<SubjectFullEpisode[]>
  },
  episode: {
    getDetail: (episodeId: number) =>
      ipcRenderer.invoke('episode:getDetail', episodeId) as Promise<EpisodeDetail>,
    getComments: (episodeId: number, offset = 0) =>
      ipcRenderer.invoke('episode:getComments', episodeId, offset) as Promise<{
        comments: EpisodeComment[]
        total: number
      }>,
    addComment: (payload: { providerSubjectId: string; episodeId: number; content: string }) =>
      ipcRenderer.invoke('episode:addComment', payload) as Promise<{ id: number; synced: boolean }>,
    listLocal: (episodeId: number) =>
      ipcRenderer.invoke('episode:listLocal', episodeId) as Promise<EpisodeComment[]>,
    toggleReaction: (payload: { commentId: number; value: number; remove?: boolean }) =>
      ipcRenderer.invoke('episode:addReaction', payload) as Promise<{ synced: boolean; error?: string }>
  },
  archive: {
    getMeta: () => ipcRenderer.invoke('archive:getMeta'),
    update: () => ipcRenderer.invoke('archive:update'),
    search: (query, type, limit) => ipcRenderer.invoke('archive:search', query, type, limit),
    searchByTag: (tag, limit) => ipcRenderer.invoke('archive:searchByTag', tag, limit),
    searchTags: (keyword, limit) => ipcRenderer.invoke('archive:searchTags', keyword, limit),
    hotTags: (limit) => ipcRenderer.invoke('archive:hotTags', limit),
    ensureCovers: (ids: number[]) => ipcRenderer.invoke('archive:ensureCovers', ids) as Promise<Record<number, string>>,
    subjectDates: (ids: number[]) =>
      ipcRenderer.invoke('archive:subjectDates', ids) as Promise<Record<number, string | null>>,
    onProgress: (cb) => {
      const listener = (_event: unknown, p: unknown) => cb(p as any)
      ipcRenderer.on('archive:progress', listener)
      return () => ipcRenderer.removeListener('archive:progress', listener)
    },
    delete: () => ipcRenderer.invoke('archive:delete')
  },
  theme: {
    capture: () => ipcRenderer.invoke('theme:capture'),
    setNativeBg: (color: string) => ipcRenderer.invoke('theme:setNativeBg', color)
  },
  // 视图层（渲染进程内直接执行，不经主进程 IPC）：当前仅页面缩放。
  // webFrame 在 preload 隔离世界可直接访问，调用即作用于当前页面顶层 frame。
  view: {
    setZoomFactor: (factor: number) => webFrame.setZoomFactor(factor)
  },
  personal: {
    timeline: (username: string, page?: number, until?: string | null) =>
      ipcRenderer.invoke('personal:timeline', username, page, until)
  },
  cache: {
    stats: () => ipcRenderer.invoke('cache:stats') as Promise<CacheStats>,
    clear: () => ipcRenderer.invoke('cache:clear') as Promise<CacheStats>,
    prune: () => ipcRenderer.invoke('cache:prune') as Promise<CacheStats>
  },
  backup: {
    exportBackup: () =>
      ipcRenderer.invoke('backup:export') as Promise<{
        ok: boolean
        canceled?: boolean
        path?: string
        error?: string
      }>,
    importBackup: () =>
      ipcRenderer.invoke('backup:import') as Promise<{
        ok: boolean
        canceled?: boolean
        path?: string
        error?: string
      }>,
    exportCollections: (format: 'csv' | 'json') =>
      ipcRenderer.invoke('backup:exportCollections', format) as Promise<{
        ok: boolean
        canceled?: boolean
        path?: string
        error?: string
      }>
  },
  win: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized') as Promise<boolean>,
    snap: (zone: 'left' | 'right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'maximize') =>
      ipcRenderer.invoke('window:snap', zone),
    onMaximizedChange: (cb: (maximized: boolean) => void) => {
      const listener = (_e: unknown, v: unknown) => cb(v as boolean)
      ipcRenderer.on('window:maximized-change', listener)
      return () => ipcRenderer.removeListener('window:maximized-change', listener)
    },
    onActiveChange: (cb: (active: boolean) => void) => {
      const listener = (_e: unknown, v: unknown) => cb(v as boolean)
      ipcRenderer.on('window:active-change', listener)
      return () => ipcRenderer.removeListener('window:active-change', listener)
    },
    getBounds: () =>
      ipcRenderer.invoke('window:get-bounds') as Promise<{ x: number; y: number; width: number; height: number }>,
    setBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke('window:set-bounds', bounds)
  },
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list') as Promise<import('../../shared/types').PluginDescriptor[]>,
    setEnabled: (id: string, enabled: boolean) =>
      ipcRenderer.invoke('plugins:setEnabled', id, enabled) as Promise<import('../../shared/types').PluginDescriptor[]>,
    setPermission: (id: string, permission: import('../../shared/types').PluginPermission, granted: boolean) =>
      ipcRenderer.invoke('plugins:setPermission', id, permission, granted) as Promise<import('../../shared/types').PluginDescriptor[]>,
    call: (id: string, method: string, args: unknown[]) =>
      ipcRenderer.invoke('plugins:call', id, method, args) as Promise<{ ok: boolean; data?: unknown; error?: string }>,
    openDir: () => ipcRenderer.invoke('plugins:openDir') as Promise<void>,
    rescan: () => ipcRenderer.invoke('plugins:rescan') as Promise<import('../../shared/types').PluginDescriptor[]>,
    install: () =>
      ipcRenderer.invoke('plugins:install') as Promise<{ ok: boolean; canceled?: boolean; error?: string; name?: string; version?: string }>,
    remove: (id: string) =>
      ipcRenderer.invoke('plugins:remove', id) as Promise<{ ok: boolean; canceled?: boolean; error?: string }>
  }
}

contextBridge.exposeInMainWorld('acgn', api)
