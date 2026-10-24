import electron from 'electron'
const { ipcMain } = electron
import {
  getSubjectComments,
  getEntityComments,
  postEntityComment,
  getSubjectTopics,
  getTopicDetail,
  getTrendingSubjectTopics,
  postTopicReply,
  toggleTopicPostReaction,
  getEntityDetail,
  getSubjectFull,
  getSubjectCharacters,
  getSubjectStaff,
  getMyCollection,
  getMe,
  getEpisodeProgress,
  getEpisodes,
  BGM_TYPE_TO_CATEGORY,
  classifyBookCategory
} from '../services/api/bangumi'
import { getValidToken, getBangumiAccount } from '../services/auth/oauth'
import { getDb } from '../services/db/connection'
import { cachedGet, ONE_DAY_MS, TEN_MIN_MS } from '../services/api/requestCache'
import {
  listProgressFull,
  applyRemoteEpisodeProgress,
  reconcileRemoteEpisodeProgress,
  clearAllEpisodeProgress
} from '../services/db/repositories/episode_progress.repository'
import { getOrCreateCollection, ensureLocalAccount } from '../services/db/repositories/collections.repository'
import { getSubjectNsfwByIds } from '../services/db/repositories/subjects.repository'
import { importSubject, saveSubjectRatingDistribution } from '../services/db/repositories/subjects.repository'
import { getCachedEpisodes, upsertEpisodes } from '../services/db/repositories/episodesCache.repository'
import { cacheCharacters, cacheRelations } from '../services/db/repositories/subjectExtra.repository'
import { getSubjectDetailLocal } from '../services/subjectDetailLocal'
import { shouldRefreshProgress, markProgressPulled, getLastPullAt, getRecentActivitySubjects } from '../services/progressGuard'
import { saveArchiveScore } from '../services/archive/archive.service'
import { resolveScore } from '../services/subjectScore'
import type { EpisodeProgressState, Subject, SubjectFullEpisode } from '../../shared/types'

/** 注册条目相关 IPC（当前为「其它用户吐槽」拉取 + 角色/人物详情卡 + 作品完整详情卡） */
export function registerSubjectIpc(): void {
  ipcMain.handle('subject:comments', async (_e, subjectId: string, offset = 0) => {
    if (!subjectId) return { comments: [], total: 0 }
    return cachedGet(
      `comments:${subjectId}:${offset}`,
      TEN_MIN_MS,
      async () => {
        const token = await getValidToken()
        return getSubjectComments(subjectId, offset, 20, token ?? undefined)
      }
    )
  })
  // 角色/人物详情页评论（吐槽），端点 /p1/characters|persons/{id}/comments
  ipcMain.handle('subject:entityComments', async (_e, kind: 'characters' | 'persons', id: number, offset = 0, limit = 200) => {
    if (!id) return { comments: [], total: 0 }
    return cachedGet(
      `entityComments:${kind}:${id}:${offset}:${limit}`,
      TEN_MIN_MS,
      async () => {
        const token = await getValidToken()
        return getEntityComments(kind, id, offset, limit, token ?? undefined)
      }
    )
  })
  // 发布角色/人物评论（需登录）
  ipcMain.handle('subject:postEntityComment', async (_e, payload: { kind: 'characters' | 'persons'; id: number; content: string; relatedID?: number | null }) => {
    const token = await getValidToken()
    if (!token) throw new Error('未登录：请先在「个人」页登录 Bangumi 账号')
    return postEntityComment(payload.kind, payload.id, payload.content, token, payload.relatedID)
  })
  // 某条目的讨论串列表（next p1，匿名可访问；受限条目带令牌）
  ipcMain.handle('subject:topics', async (_e, subjectId: string) => {
    if (!subjectId) return { topics: [], total: 0 }
    return cachedGet(
      `topics:${subjectId}`,
      TEN_MIN_MS,
      async () => {
        const token = await getValidToken()
        return getSubjectTopics(subjectId, token ?? undefined)
      }
    )
  })
  // 讨论串详情（全部楼层+楼中楼；受限内容匿名 404 → null）
  ipcMain.handle('subject:topicDetail', async (_e, topicId: number) => {
    if (!topicId) return null
    return cachedGet(
      `topic:${topicId}`,
      TEN_MIN_MS,
      async () => {
        const token = await getValidToken()
        return getTopicDetail(topicId, token ?? undefined)
      }
    )
  })
  // 全站热门条目讨论（bgm 首页右侧模块同款；匿名可访问）。
  // force=true 时绕过 1 分钟缓存强制刷新（「刷新」按钮触发）；打开抽屉默认走缓存。
  ipcMain.handle('subject:trendingTopics', async (_e, force?: boolean) => {
    return cachedGet(
      'trending',
      TEN_MIN_MS,
      async () => {
        const token = await getValidToken()
        return getTrendingSubjectTopics(token ?? undefined)
      },
      { force }
    )
  })
  // 在讨论串下发表回复（需登录；replyTo 指向楼层 id = 楼中楼）
  ipcMain.handle('subject:postTopicReply', async (_e, payload: { topicId: number; content: string; replyTo?: number | null }) => {
    const token = await getValidToken()
    if (!token) throw new Error('未登录：请先在「个人」页登录 Bangumi 账号')
    return postTopicReply(payload.topicId, payload.content, token, payload.replyTo)
  })
  // 讨论楼层表情回应 toggle（需登录）
  ipcMain.handle('subject:toggleTopicReaction', async (_e, payload: { postId: number; value: number; remove?: boolean }) => {
    const token = await getValidToken()
    if (!token) throw new Error('未登录：请先在「个人」页登录 Bangumi 账号')
    await toggleTopicPostReaction(payload.postId, payload.value, token, payload.remove)
    return { synced: true }
  })
  // 角色/人物详情（点击详情页角色或 CV 打开卡片，替代跳转 bgm 网页）
  ipcMain.handle('subject:entity', async (_e, kind: 'character' | 'person', id: number) => {
    if (!id) throw new Error('缺少实体 id')
    return cachedGet(`entity:${kind}:${id}`, ONE_DAY_MS, async () =>
      getEntityDetail(kind === 'character' ? 'characters' : 'persons', id)
    )
  })
  // 作品完整详情（点击角色卡「出演作品」打开的卡片；匿名亦可访问）。
  // withCn=false 时跳过角色/CV 中文名请求（首屏快开），中文名由 subject:characters 异步补。
  // 传入当前有效 token：已登录时中文名解析走更高并发(5)+更高配额(80/min)。
  // 默认缓存 1 天：重复打开同一作品不再重复拉取网络详情（详情页/悬浮窗秒显）。
  // opts.force=true（详情页手动刷新）时绕过缓存强制重新联网。
  ipcMain.handle('subject:detailFull', async (_e, id: number, opts?: { withCn?: boolean; force?: boolean }) => {
    if (!id) throw new Error('缺少作品 id')
    const withCn = opts?.withCn ?? true
    return cachedGet(
      `detailFull:${id}:${withCn}`,
      ONE_DAY_MS,
      async () => {
        const token = await getValidToken()
        const detail = await getSubjectFull(String(id), token ?? undefined, { withCn })
        // 真实剧集写回本地缓存（供悬浮窗瞬时读取，下次打开不必再联网）
    try {
      if (detail.episodes?.length) await upsertEpisodes(String(id), detail.episodes)
    } catch (e) {
      console.warn('[subject:detailFull] 剧集缓存写回失败（忽略）：', e)
    }
    // 站点均分联网已拿到（detail.subject.rating），写回 Archive 离线库，供下次本地优先秒显
    // （与详情页 collection:detail 的 updateScoreOnline 对称；此处 detail 已含最新 score，直接落库省一次请求）
    try {
      const r = detail.subject?.rating
      if (typeof r === 'number' && isFinite(r)) await saveArchiveScore(String(id), r)
    } catch (e) {
      console.warn('[subject:detailFull] 评分写回离线库失败（忽略）：', e)
    }
    // API 偶发不返回 rating（匿名/接口形态差异）时，用 Archive 离线均分兜底，
    // 避免「本地秒显的评分被联网结果整体替换掉」→ 显示「暂无评分」。
    if (detail.subject && typeof detail.subject.rating !== 'number') {
      try {
        await resolveScore(detail.subject)
      } catch (e) {
        console.warn('[subject:detailFull] Archive 评分兜底失败（忽略）：', e)
      }
    }
    // 把悬浮窗打开的「未在本地库的作品」收编进本地库：封面 URL / 角色头像 / 关联封面 /
    // 评分分布 全部持久化。这样之后重复打开同一作品时，subject:detailLocal 即可离线命中，
    // 封面与角色/关联图秒供（字节已在 Chromium 磁盘缓存），无需再等这次联网取元数据——
    // 与详情页（只开已入本库作品）一致的秒显体验。importSubject 幂等（已存在走 UPDATE，
    // 含 category 归一化），不会写乱；不建 collections，故不会污染「我的收藏」列表。
    try {
      const s = detail.subject
      if (s && s.id) {
        const subj: Subject = {
          provider: 'bangumi',
          providerSubjectId: String(s.id),
          category: s.category,
          title: s.title || '',
          titleCn: s.title_cn || undefined,
          summary: s.summary || undefined,
          imageUrl: s.image_url || undefined,
          airDate: s.air_date ?? undefined,
          totalEpisodes: s.total_episodes ?? undefined,
          totalVolumes: s.total_volumes ?? undefined,
          series: s.series,
          rating: typeof s.rating === 'number' ? s.rating : undefined
        }
        const localId = await importSubject(subj)
        if (detail.characters?.length) await cacheCharacters(localId, detail.characters)
        if (detail.relations?.length) await cacheRelations(localId, detail.relations)
        if (Array.isArray(s.ratingCount) && s.ratingCount.length === 10) {
          await saveSubjectRatingDistribution(localId, s.ratingCount, s.ratingTotal ?? 0)
        }
      }
    } catch (e) {
      console.warn('[subject:detailFull] 收编本地库失败（忽略，不影响本次展示）：', e)
    }
    return detail
    }
  )
})
  // 本地优先：先返回离线/缓存详情（含 Archive 站点均分、角色、关联），不联网、瞬时。
  // 悬浮窗打开即调用，立即渲染，后续再 subject:detailFull 联网静默替换。
  ipcMain.handle('subject:detailLocal', async (_e, id: number) => {
    return getSubjectDetailLocal(id, true)
  })
  // 读某作品本地缓存的剧集（瞬时，不联网），悬浮窗打开时优先用，避免每次都等在线抓取。
  ipcMain.handle('subject:getEpisodes', async (_e, providerSubjectId: string) => {
    if (!providerSubjectId) return []
    return getCachedEpisodes(providerSubjectId)
  })
  // 单独补全角色列表中文名（悬浮窗首屏 withCn=false 后调用），结构与 detailFull.characters 一致。
  // 缓存 1 天：同一作品角色中文名短期内不变，避免重复高并发查询。
  ipcMain.handle('subject:characters', async (_e, id: number) => {
    if (!id) throw new Error('缺少作品 id')
    return cachedGet(`characters:${id}`, ONE_DAY_MS, async () => {
      const token = await getValidToken()
      return getSubjectCharacters(String(id), token ?? undefined, { withCn: true })
    })
  })
  // 取作品制作人员（staff：作者/导演/原画/制作公司 等），供制作信息按名匹配后跳转人物卡。
  // 缓存 1 天：制作人员列表基本不变。
  ipcMain.handle('subject:persons', async (_e, id: number) => {
    if (!id) throw new Error('缺少作品 id')
    return cachedGet(`persons:${id}`, ONE_DAY_MS, async () => {
      const token = await getValidToken()
      return getSubjectStaff(String(id), token ?? undefined)
    })
  })
  /** 读某作品本地收藏与逐集进度（供着色 / 拉取回退）。查看不自动建收藏。 */
  async function readLocalProgress(
    providerSubjectId: string
  ): Promise<{
    collectionId: number | null
    progress: Record<number, EpisodeProgressState>
    status: number | null
  }> {
    if (!providerSubjectId) return { collectionId: null, progress: {}, status: null }
    const db = await getDb()
    const subj = db
      .prepare("SELECT id FROM subjects WHERE provider = 'bangumi' AND provider_subject_id = ?")
      .get(String(providerSubjectId)) as { id: number } | undefined
    if (!subj) return { collectionId: null, progress: {}, status: null }
    const col = db
      .prepare('SELECT id, status FROM collections WHERE subject_id = ? ORDER BY id DESC LIMIT 1')
      .get(subj.id) as { id: number; status: number } | undefined
    if (!col) return { collectionId: null, progress: {}, status: null }
    return { collectionId: col.id, progress: await listProgressFull(col.id), status: col.status }
  }

  // 取某作品（按 Bangumi 作品 id）的本地收藏与逐集进度，供悬浮窗剧集着色。
  ipcMain.handle('subject:getProgress', async (_e, providerSubjectId: string) => {
    return readLocalProgress(providerSubjectId)
  })

  // 抓取真实剧集骨架（best-effort，失败返回空），并写回本地缓存供后续瞬时读取。
  async function fetchEpisodesSafe(providerSubjectId: string): Promise<SubjectFullEpisode[]> {
    try {
      const eps = await getEpisodes(providerSubjectId)
      if (eps.length) await upsertEpisodes(providerSubjectId, eps)
      return eps
    } catch (e) {
      console.warn('[subject:pullEpisodeProgress] 剧集骨架抓取失败（忽略）：', e)
      return []
    }
  }

  // 从 Bangumi 拉取该用户的单集标记并合并/对比进本地（悬浮窗载入时背景拉取 / 详情页强制刷新 / 同步时对比）。
  // opts.force：true 时绕过「本地已有标记即走缓存」的短路，强制重新联网（详情页/同步用）。
  //   详情页 force 模式还会一并抓取真实剧集骨架（与进度一起返回），使首次打开（本地剧集缓存为空）也能即时显色。
  // opts.reconcile：true 时与本地做对比写入（远端有则覆盖、远端无则清本地，Bangumi 权威）；
  //   详情页(soft reconcile)在远端完全无标记时不强制清空，避免误删离线本地标记；全量同步走 reconcile 会清空。
  ipcMain.handle(
    'subject:pullEpisodeProgress',
    async (_e, providerSubjectId: string, opts?: { force?: boolean; reconcile?: boolean }) => {
      const local = await readLocalProgress(providerSubjectId)
      const token = await getValidToken()
      if (!token) return { ...local, episodes: [] as SubjectFullEpisode[] }
      // 缓存：force=false 且本地已有标记则不重复联网（防限流）；详情页/同步传 force=true 强制刷新。
      if (!opts?.force && Object.keys(local.progress).length > 0) {
        return { ...local, episodes: [] as SubjectFullEpisode[] }
      }
      try {
        const marks = await getEpisodeProgress(providerSubjectId, token)
        // 本地收藏优先（详情页/已加入收藏时直接写，无需再调 getMyCollection）；
        // 仅当无任何本地收藏时才取远端收藏信息建行。
        let colId = local.collectionId
        if (!colId) {
          const acct = await getBangumiAccount()
          const username = acct?.username ?? (await getMe(token))?.username
          if (!username) return { ...local, episodes: [] as SubjectFullEpisode[] }
          const remote = await getMyCollection(providerSubjectId, token, username)
          if (!remote) return { ...local, episodes: [] as SubjectFullEpisode[] }
          const localId = await ensureLocalAccount()
          const rawSubject = remote.subject ?? {}
          // 书类(type=1)按 platform/tags 细分（小说/漫画），不要硬编码 'manga'（否则会把小说写进漫画）。
          const bookCat =
            rawSubject.type === 1 ? classifyBookCategory(rawSubject, rawSubject) : undefined
          const subject: Subject = {
            provider: 'bangumi',
            providerSubjectId: String(providerSubjectId),
            category: bookCat ?? (BGM_TYPE_TO_CATEGORY[rawSubject.type as number] ?? 'anime'),
            title: rawSubject.name ?? `Bangumi ${providerSubjectId}`
          }
          const localSubjectId = await importSubject(subject)
          colId = await getOrCreateCollection(localId, localSubjectId, remote.type ?? 3)
        }
        if (!colId) return { ...local, episodes: [] as SubjectFullEpisode[] }
        if (Object.keys(marks).length === 0) {
          // 远端无任何单集标记：全量同步(reconcile)时清空本地以对齐 Bangumi；
          // 详情页(soft reconcile)不强制清空，避免抹掉离线本地标记。
          if (opts?.reconcile) await clearAllEpisodeProgress(colId)
          // force 模式仍抓取真实剧集骨架（即便无单集标记），保证首次打开能显示真实集号；
          // skeleton=false（主页增量刷新）跳过，省 2 请求/卡
          const episodes =
            opts?.force && opts?.skeleton !== false ? await fetchEpisodesSafe(providerSubjectId) : []
          return { collectionId: colId, progress: await listProgressFull(colId), episodes }
        }
        if (opts?.reconcile) await reconcileRemoteEpisodeProgress(colId, marks)
        else await applyRemoteEpisodeProgress(colId, marks)
        // force 模式抓取真实剧集骨架，与进度一起返回（首次打开本地缓存为空时也能即时显色）；
        // skeleton=false（主页增量刷新）跳过骨架抓取（每卡 2 请求），只拉单集标记
        const episodes =
          opts?.force && opts?.skeleton !== false ? await fetchEpisodesSafe(providerSubjectId) : []
        return { collectionId: colId, progress: await listProgressFull(colId), episodes }
      } catch (e) {
        console.warn('[subject:pullEpisodeProgress] 拉取失败（回退本地）：', e)
        return { ...local, episodes: [] as SubjectFullEpisode[] }
      }
    }
  )

  // C' 全局短路：切栏前问一次「是否需拉进度」，以及拉完后记录时钟。
  ipcMain.handle('subject:shouldRefreshProgress', async () => shouldRefreshProgress())
  ipcMain.handle('subject:markProgressPulled', async () => {
    markProgressPulled()
  })
  // C' 定向刷新：本地上次拉取时钟 + 最近动态里「哪几部」有新活动（memo 共享，不多发请求）。
  ipcMain.handle('subject:getLastPullAt', async () => getLastPullAt())
  ipcMain.handle(
    'subject:getRecentActivitySubjects',
    async (_e, sinceSec: number, limit?: number) =>
      getRecentActivitySubjects(Number(sinceSec) || 0, limit ? Number(limit) : 20)
  )
  // 批量查 NSFW 标记（存档优先/主库兜底）：搜索结果与「最近打开」封面的模糊用。
  ipcMain.handle('subject:nsfwBatch', (_e, ids: number[]) => getSubjectNsfwByIds(ids))
}
