import type { Category, Subject, SubjectTag, SubjectMeta, SubjectComment, EntityDetail, EntityWorkItem, SubjectFullDetail, SubjectFullEpisode, EpisodeComment, EpisodeDetail, SubjectPerson, BgmTopic, BgmTopicReply, BgmTopicDetail } from '../../../../shared/types'
import { UA, getBangumiAccount, refreshAccessToken } from '../auth/oauth'
import { getArchiveSubjectDates } from '../archive/archive.service'
import { dbg } from '../debugLog'
import { tagError, codeForStatus } from '../errors'
import { cachedGet, ONE_DAY_MS } from './requestCache'
import { extractP1SubjectId } from './timeline'

const API_BASE = 'https://api.bgm.tv/v0'
const LEGACY_BASE = 'https://api.bgm.tv'
const P1_BASE = 'https://next.bgm.tv/p1'
// P1 角色接口顶层 type 字段 = 角色在作品中的关系类型，与 v0 的 relation 字符串对齐，
// 仅用于前端徽章展示；展示顺序直接采用 P1 数组下标（Bangumi 网页真实排序），不再二次排序。
const P1_RELATION_TYPE: Record<number, string> = {
  1: '主角',
  2: '配角',
  3: '客串',
  4: '旁白',
  5: '闲角'
}

/**
 * 反向映射：把 Bangumi 作品类型还原成本地 category（用于从 Bangumi 整库导入）。
 * Bangumi 只有 1=书籍 / 2=动画 / 3=音乐 / 4=游戏 / 6=三次元 这几种，而本应用把
 * 书籍拆成 轻小说+漫画、游戏拆成 Galgame+单机——属于「一对多」的天然歧义：
 *   - 书籍(type1) 默认归「漫画」(ACGN 的 C)；
 *   - 游戏(type4) 默认归「Galgame」(ACGN 的 G)。
 * 若你的库更偏轻小说/单机，告诉我一声即可把默认互换。
 * 音乐(type3)/三次元(type6) 本应用无对应分类，pull 时直接跳过。
 */
export const BGM_TYPE_TO_CATEGORY: Partial<Record<number, Category>> = {
  2: 'anime',
  1: 'manga',
  4: 'galgame'
  // 3 音乐 / 6 三次元：无对应分类，跳过
}

/** 本地收藏状态(1-5) 与 Bangumi collection type 完全一致，无需转换 */
export const COLLECTION_TYPE_BY_STATUS: Record<number, number> = {
  1: 1, // wish  想看
  2: 2, // done  看过
  3: 3, // doing  在看
  4: 4, // onHold 搁置
  5: 5 // dropped 抛弃
}

function authHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': UA
  }
  // 无令牌时省略 Authorization：v0 的作品/角色/关联接口匿名也可用（用于离线库兜底补图）
  if (token) h.Authorization = `Bearer ${token}`
  return h
}

/**
 * 带 Bearer 令牌的 fetch；遇到 401 自动用 refresh_token 静默刷新一次并重试，
 * 仍 401 则抛清晰「授权已失效」错误（而非裸 HTTP 401，避免用户困惑）。
 *
 * 背景：同步引擎在 pullAll 开头只取一次 token 复用全部分页；OAuth 令牌若已过期
 * （且 Bangumi 未返还 expires_in 导致 getValidToken 无法主动刷新），首次请求就会 401。
 * 这里在每次鉴权失败处自愈：刷新后重试用新令牌，跨分页也读最新库内令牌。
 */
async function authedFetch(
  url: string,
  token: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<Response> {
  const headers = { ...authHeaders(token), ...(init.headers ?? {}) }
  let res = await fetch(url, { method: init.method, headers, body: init.body } as RequestInit)
  if (res.status === 401) {
    const acct = await getBangumiAccount()
    if (acct?.refreshToken) {
      try {
        const newToken = await refreshAccessToken(acct.refreshToken)
        const headers2 = { ...authHeaders(newToken), ...(init.headers ?? {}) }
        res = await fetch(url, { method: init.method, headers: headers2, body: init.body } as RequestInit)
      } catch {
        // 刷新失败，保留 401 以便下方抛出清晰错误
      }
    }
    if (res.status === 401) {
      try {
        const body = await res.text()
        console.warn('[auth] Bangumi 返回 401，令牌失效。响应体前 200 字：', body.slice(0, 200))
      } catch {
        /* 忽略读取失败 */
      }
      throw new Error(tagError('AUTH', 'Bangumi 授权已失效，请重新登录'))
    }
  }
  return res
}

/**
 * 检索 Bangumi 作品（按 subject type 过滤）。
 * - 有令牌：优先走 v0 /search/subjects（字段最全：评分/集数/卷数）。
 * - 无令牌 / v0 失败：回退旧版 /search/subject/{keyword} 接口，该接口**匿名可用**，
 *   满足「不填令牌也能用 API 在本地统计」的需求。
 * type 为 undefined 时检索全部类型。旧版列表本身已含 name/name_cn/images/summary/date，
 * 不发逐条详情请求（逐条补全是早期搜索卡顿 80 请求的根源），集数/卷数在详情页联网补全。
 */
// 搜索分页：单次请求上限（Bangumi v0 各端点常见最大 50，但实测端点会忽略 limit、固定每页 N 条），
// 故 limit 仅作占位；翻页取全靠「实际返回条数」推进 offset。
// 硬上限避免极端关键词（total 巨大）导致无限请求。
const SEARCH_PAGE_LIMIT = 50
const SEARCH_HARD_CAP = 1000
// 并发翻页的并发度：先取首页（拿 total/页大小），其余页并发拉取，大幅缩短热门词（数十页）的耗时。
const SEARCH_CONCURRENCY = 6

/**
 * 从请求头里提取 Bearer 令牌并尝试用 refresh_token 静默刷新一次。
 * 仅当存在 refresh_token 时有效（个人令牌模式无 refresh_token，直接返回 null）。
 * 用于搜索端点（v0 subjects/characters/persons）的 401 自愈，避免「登录了但令牌过期
 * → 人物/条目搜索全部 401 失败、表现为搜不出」的静默故障。
 */
async function tryRefreshFromHeaders(
  headers?: Record<string, string>
): Promise<string | null> {
  const auth = headers?.Authorization
  if (!auth || !auth.startsWith('Bearer ')) return null
  try {
    const acct = await getBangumiAccount()
    if (!acct?.refreshToken) return null
    return await refreshAccessToken(acct.refreshToken)
  } catch {
    return null
  }
}

/** 翻一页（带一次重试，缓解偶发限流/网络抖动），返回 data 与 total。
 *  遇 401 且持有 refresh_token 时静默刷新并重试一次（与同步引擎 authedFetch 行为一致）。 */
async function fetchSearchPage(
  buildReq: (offset: number) => { url: string; init: RequestInit },
  offset: number,
  signal?: AbortSignal
): Promise<{ data: any[]; total: number }> {
  let { url, init } = buildReq(offset)
  if (signal) init = { ...init, signal }
  const isPerson = url.includes('/search/persons') || url.includes('/search/characters')
  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      const res = await fetch(url, init)
      // 401：尝试用 refresh_token 刷新后重试用新令牌（仅首轮尝试，避免死循环）
      if (res.status === 401 && attempt === 0) {
        const newToken = await tryRefreshFromHeaders(init.headers as Record<string, string>)
        if (newToken) {
          init = {
            ...init,
            headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${newToken}` }
          }
          continue
        }
      }
      if (isPerson) {
        const rawText = await res.text()
        let json: any = null
        try { json = JSON.parse(rawText) } catch {}
        const dataLen = Array.isArray(json?.data) ? json.data.length : -1
        dbg('fetchSearchPage', url.replace(API_BASE, ''), 'offset=', offset, 'attempt=', attempt, 'HTTP=', res.status, 'dataLen=', dataLen, 'bodyHead=', rawText.slice(0, 240))
        if (!res.ok) throw new Error(`Bangumi 检索失败 (HTTP ${res.status})`)
        return { data: json?.data ?? [], total: typeof json?.total === 'number' ? json.total : 0 }
      }
      if (!res.ok) throw new Error(`Bangumi 检索失败 (HTTP ${res.status})`)
      const json = (await res.json()) as { data?: any[]; total?: number }
      return { data: json.data ?? [], total: typeof json.total === 'number' ? json.total : 0 }
    } catch (e) {
      // 已被新搜索取消：立即上抛，不重试（上层按 aborted 静默丢弃）
      if (signal?.aborted || (e as Error)?.name === 'AbortError') throw e
      if (attempt === 1) throw e
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  throw new Error('unreachable')
}

export async function searchBangumiByType(
  keyword: string,
  type?: number,
  token?: string,
  signal?: AbortSignal
): Promise<any[]> {
  // 条目搜索仅覆盖 漫画/动画/游戏/小说（Bangumi type 1/2/4）；音乐(3)/三次元(6) 不在需求内，
  // 通过 v0 的 filter.type 在服务端过滤，既提速又避免拉取无关类型。
  // v0 条目搜索为 POST 且 OptionalHTTPBearer（匿名亦可）。
  const types = type !== undefined ? [type] : [1, 2, 4]
  try {
    const all = await searchBangumiV0ByType(keyword, token, types, signal)
    return all.filter((x) => types.includes(x.type)) // 客户端兜底（防极端情况下服务端未过滤）
  } catch (e) {
    if (signal?.aborted || (e as Error)?.name === 'AbortError') throw e
    // 仅在「无令牌」时回退 legacy（匿名可用，但每类仅 8 条、不支持翻页）；
    // 有令牌却失败（典型 401 令牌失效）→ 抛出明确错误，绝不再静默降级为少量结果。
    if (!token) {
      console.warn('[bgm] v0 检索失败，回退旧版匿名检索：', e)
      const legacy = await searchBangumiLegacyByType(keyword, type, signal)
      return type !== undefined ? legacy.filter((x) => x.type === type) : legacy
    }
    throw e
  }
}

/**
 * 通用翻页取全（并发）：Bangumi v0 搜索端点**忽略 limit、固定每页 N 条**（实测 subjects=20/页、
 * characters/persons=10~20/页），故不能用「data.length < limit」判末页（会第一页就误停）。
 * 改为：先取首页确定 total 与页大小，其余页按「实际返回量」并发拉取（限 SEARCH_CONCURRENCY），
 * 以空页或 all.length>=total 作为结束条件，对「limit 被忽略 / 被遵守」两种端点都稳健。
 * dedupById 为 true 时按 item.id 去重（角色/人物搜索可能跨页重复）。
 */
async function paginateSearch(
  buildReq: (offset: number) => { url: string; init: RequestInit },
  opts?: { dedupById?: boolean; concurrency?: number; maxPages?: number },
  signal?: AbortSignal
): Promise<any[]> {
  const concurrency = Math.max(1, opts?.concurrency ?? SEARCH_CONCURRENCY)
  const dedupById = opts?.dedupById ?? false
  // 搜索结果 UI 只展示前几十条，热门词（total 上千）无需翻全部页——封顶避免大量请求拖慢搜索、放大超时概率。
  const maxPages = opts?.maxPages ?? Number.MAX_SAFE_INTEGER
  const seen = new Set<number | string>()
  const accept = (arr: any[]): any[] => {
    if (!dedupById) return arr
    const out: any[] = []
    for (const x of arr) {
      const id = x?.id
      if (id != null && seen.has(id)) continue
      if (id != null) seen.add(id)
      out.push(x)
    }
    return out
  }

  const first = await fetchSearchPage(buildReq, 0, signal)
  const pageSize = first.data.length || 1 // 端点忽略 limit、固定每页条数；||1 防 0 除
  const all: any[] = accept(first.data)
  if (first.data.length === 0 || all.length >= SEARCH_HARD_CAP) return all

  // 翻页结束条件用「出现空页」而非依赖 total：
  // Bangumi v0 的 characters/persons 搜索在带令牌时 total 可能返回偏小/不准的值，
  // 若按 total 生成 offsets 会「少拉、看似不全」（表现为合并后只有几十个）。
  // 改为按真实返回量递进 offset、持续翻页直到整批为空（offset 超出真实总数后必为空），
  // 对 total 准确与否都稳健；SEARCH_HARD_CAP 兜底防极端词无限请求。
  let off = pageSize
  while (all.length < SEARCH_HARD_CAP) {
    if (signal?.aborted) break // 已被新搜索取代，停止继续翻页
    const batchOffsets: number[] = []
    for (let i = 0; i < concurrency; i++) batchOffsets.push(off + i * pageSize)
    const pages = await Promise.all(batchOffsets.map((o) => fetchSearchPage(buildReq, o, signal)))
    let anyNonEmpty = false
    let added = 0
    for (const p of pages) {
      if (p.data.length) anyNonEmpty = true
      const newItems = accept(p.data)
      added += newItems.length
      all.push(...newItems)
    }
    if (!anyNonEmpty) break // 整批为空 = 已到末尾
    // 防死循环保险：若整批原始页非空、却没新增任何条目（全部被 dedup 掉），
    // 说明 offset 未生效（服务端始终返回第一页）→ 继续只会无限重复，直接跳出。
    if (anyNonEmpty && added === 0) break
    off += concurrency * pageSize
    // 达到搜索封顶页数（如作品搜索 maxPages=3）即停止，避免热门词翻几十页
    if (Math.floor(off / pageSize) >= maxPages) break
  }
  return all
}

/**
 * v0 条目搜索：POST /v0/search/subjects，请求体 { keyword, filter:{type} }，limit/offset 走 query。
 * filter.type 必须为**数组**（Bangumi 要求数组；单值会 400）。OptionalHTTPBearer → 有/无令牌均可调用。
 */
async function searchBangumiV0ByType(keyword: string, token?: string, types?: number[], signal?: AbortSignal): Promise<any[]> {
  // 作品搜索封顶 3 页（≈60 条）：UI 只展示前几十条，热门词（total 上千）无需翻全。
  return paginateSearch((offset) => ({
    url: `${API_BASE}/search/subjects?${new URLSearchParams({
      limit: String(SEARCH_PAGE_LIMIT),
      offset: String(offset)
    }).toString()}`,
    init: {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(types && types.length ? { keyword, filter: { type: types } } : { keyword })
    }
  }), { maxPages: 3 }, signal)
}

/**
 * 旧版匿名检索（无需令牌）。
 * 注意：Bangumi 旧版搜索**不支持分页**（实测 page 参数被忽略，且每页固定仅返回 8 条），
 * 因此未登录时最多只能拿到前 8 条结果，无法翻页取全。要搜索全部内容并分页，
 * 必须先登录 Bangumi，由上层 searchBangumiByType 走 v0 翻页接口。这里直接单页返回，
 * 不使用循环翻页（否则会因 page 无效而重复同一页直至触达 HARD_CAP，产生大量重复数据）。
 */
async function searchBangumiLegacyByType(keyword: string, type?: number, signal?: AbortSignal): Promise<any[]> {
  let url = `${LEGACY_BASE}/search/subject/${encodeURIComponent(keyword)}?responseGroup=Medium`
  if (type !== undefined) url += `&type=${type}`
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA }, signal })
  if (!res.ok) throw new Error(`Bangumi 旧版检索失败 (HTTP ${res.status})`)
  const json = (await res.json()) as { list?: any[] }
  return json.list ?? []
}

/**
 * v0 角色/人物检索（**仅 POST**，非 GET）：
 * - 官方文档(dist.json)确认路径为 POST /v0/search/characters、/v0/search/persons。
 *   实测：keyword 放**请求体**；但 limit/offset 必须放 **query 参数**（放 body 会被忽略，
 *   导致永远返回第一页 → 翻页死循环）。早期用 GET 会 404（路由不存在）。
 * - 响应结构：{ total, data:[{id,name,type,images,...}] }；data 项**无 name_cn**
 *   （中文名在 infobox，需另取详情），故 toPersonItem 用 raw.name。
 */
export async function searchCharacters(keyword: string, token: string, signal?: AbortSignal): Promise<any[]> {
  dbg('searchCharacters ENTER keyword=', keyword, 'tokenLen=', token?.length)
  try {
    const r = await paginateSearch(
      (offset) => ({
        url: `${API_BASE}/search/characters?${new URLSearchParams({
          limit: String(SEARCH_PAGE_LIMIT),
          offset: String(offset)
        }).toString()}`,
        init: {
          method: 'POST',
          headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
          body: JSON.stringify({ keyword })
        }
      }),
      { dedupById: true },
      signal
    )
    dbg('searchCharacters OK len=', r.length)
    return r
  } catch (e) {
    dbg('searchCharacters ERR', e instanceof Error ? e.message : String(e))
    throw e
  }
}

export async function searchPersons(keyword: string, token: string, signal?: AbortSignal): Promise<any[]> {
  dbg('searchPersons ENTER keyword=', keyword, 'tokenLen=', token?.length)
  try {
    const r = await paginateSearch(
      (offset) => ({
        url: `${API_BASE}/search/persons?${new URLSearchParams({
          limit: String(SEARCH_PAGE_LIMIT),
          offset: String(offset)
        }).toString()}`,
        init: {
          method: 'POST',
          headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
          body: JSON.stringify({ keyword })
        }
      }),
      { dedupById: true },
      signal
    )
    dbg('searchPersons OK len=', r.length)
    return r
  } catch (e) {
    dbg('searchPersons ERR', e instanceof Error ? e.message : String(e))
    throw e
  }
}

/** p1 标签搜索参数（对应 /p1/search/subjects 的 filter 结构） */
export interface P1TagSearchOptions {
  /** 普通标签（多值取交集） */
  tags?: string[]
  /** 元标签（Bangumi 官方分类），支持 `-xxx` 排除 */
  metaTags?: string[]
  /** 作品类型过滤（Bangumi type 1/2/3/4/6），undefined=不限 */
  type?: number
  /** 排序：match 匹配度 / heat 热度 / rank 排名 / score 评分 */
  sort?: 'match' | 'heat' | 'rank' | 'score'
}

/**
 * 按标签检索 Bangumi 作品（p1：POST /p1/search/subjects）。
 * - filter.tags / metaTags 走服务端标签过滤（多标签交集、- 排除）。
 * - 复用现有 fetchSearchPage（401 自愈 + 重试）与翻页逻辑。
 * - 返回全部匹配作品（受 SEARCH_HARD_CAP 兜底）；sort 默认 heat（标签浏览按热度更自然）。
 */
export async function searchBangumiByTag(
  keyword: string,
  opts: P1TagSearchOptions = {},
  token?: string,
  signal?: AbortSignal
): Promise<any[]> {
  const sort = opts.sort ?? 'heat'
  const filter: Record<string, unknown> = {}
  if (opts.tags?.length) filter.tags = opts.tags
  if (opts.metaTags?.length) filter.metaTags = opts.metaTags
  if (opts.type !== undefined) filter.type = [opts.type]
  return paginateSearch(
    (offset) => ({
      url: `${P1_BASE}/search/subjects?${new URLSearchParams({
        limit: String(SEARCH_PAGE_LIMIT),
        offset: String(offset)
      }).toString()}`,
      init: {
        method: 'POST',
        headers: { ...authHeaders(token), 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ keyword, sort, filter })
      }
    }),
    { maxPages: 5, dedupById: true },
    signal
  )
}

/**
 * 取频道（某类型）热门标签列表（p1：GET /p1/channels/{type}/tags）。
 * 供标签搜索的联想/热门建议使用。返回 [{ name, count }]，按热度倒序。
 */
export async function getP1ChannelTags(
  type: number,
  token?: string,
  signal?: AbortSignal,
  offset = 0,
  limit = 50
): Promise<{ data: { name: string; count: number }[]; total: number }> {
  const headers = { ...authHeaders(token), Accept: 'application/json' }
  const url = `${P1_BASE}/channels/${type}/tags?${new URLSearchParams({
    limit: String(limit),
    offset: String(offset)
  }).toString()}`
  const res = await fetch(url, { headers, signal })
  if (!res.ok) throw new Error(`获取频道标签失败 (HTTP ${res.status})`)
  const json = (await res.json()) as { data?: { name: string; count: number }[]; total?: number }
  return { data: json.data ?? [], total: typeof json.total === 'number' ? json.total : 0 }
}

/**
 * 按关键词搜索标签（p1：拉取频道热门标签 + 客户端过滤 + 精确标签验证）。
 * p1 无独立标签搜索端点，但 /channels/{type}/tags 的热门标签列表按热度倒序，
 * 拉取前若干页后按关键词（子串、大小写不敏感）过滤，即可得到「搜索标签」的候选。
 * 支持多类型：传 types 数组（如全部类型 [1,2,4]）时遍历各类型合并去重后再过滤，
 * 避免「全部」栏只取某单一类型（如动画）的标签。
 * 补充「精确标签验证」：若关键词本身就是一个有效标签（用 /search/subjects 的
 * filter.tags 精确查询有作品），即使它不在热门 top-3000 里也加入候选（count=该标签作品数）。
 * 返回匹配的 [{ name, count }]，count 取该标签在已拉取范围内的最大热度，按热度倒序。
 * 无关键词时返回空（UI 展示热门标签由 getP1ChannelTags 单独驱动）。
 */
// 每类型的标签列表内存缓存（1 小时）：避免每次搜索都重复拉页，显著提速
const tagListCache = new Map<number, { at: number; list: { name: string; count: number }[] }>()
const TAG_CACHE_MS = 60 * 60 * 1000
async function getCachedTypeTags(type: number, token?: string, signal?: AbortSignal): Promise<{ name: string; count: number }[]> {
  const hit = tagListCache.get(type)
  if (hit && Date.now() - hit.at < TAG_CACHE_MS) return hit.list
  // 每类型拉前 15 页（每页 100 = 1500 个热门标签）：覆盖绝大多数常用标签，首次更快
  const pages = 15
  const jobs: number[] = []
  for (let p = 0; p < pages; p++) jobs.push(p * 100)
  const pagesData = await mapWithConcurrency(jobs, 8, async (offset) => {
    if (signal?.aborted) return []
    try {
      const page = await getP1ChannelTags(type, token, signal, offset, 100)
      return page.data ?? []
    } catch {
      return []
    }
  })
  const countBy = new Map<string, number>()
  for (const data of pagesData) {
    for (const t of data) {
      const prev = countBy.get(t.name) ?? 0
      if (t.count > prev) countBy.set(t.name, t.count)
    }
  }
  const list = [...countBy.entries()].map(([name, count]) => ({ name, count }))
  tagListCache.set(type, { at: Date.now(), list })
  return list
}
/** 后台预热标签缓存（进入标签模式时调用）：提前拉取各类型标签列表，使首次搜索秒回 */
export async function warmTagListCache(types: number[], token?: string): Promise<void> {
  await Promise.all(types.map((t) => getCachedTypeTags(t, token)))
}
// 精确标签验证结果缓存（键=关键词+类型范围）：避免每次击键都重复请求 /search/subjects
const exactTagCache = new Map<string, { at: number; count: number }>()
const EXACT_TAG_CACHE_MS = 30 * 60 * 1000
export async function searchP1Tags(
  keyword: string,
  types: number[],
  token?: string,
  signal?: AbortSignal
): Promise<{ data: { name: string; count: number }[]; total: number }> {
  const kw = keyword.trim()
  if (!kw || !types.length) return { data: [], total: 0 }
  const lower = kw.toLowerCase()
  // 每类型并发拉取缓存的热门标签列表（各类型独立缓存，首次各拉 30 页，之后秒回）
  const perType = await mapWithConcurrency(types, 6, async (type) => getCachedTypeTags(type, token, signal))
  const countBy = new Map<string, number>()
  for (const list of perType) {
    for (const t of list) {
      const prev = countBy.get(t.name) ?? 0
      if (t.count > prev) countBy.set(t.name, t.count)
    }
  }

  // 关键词已在热门标签中（精确名命中）：无需额外验证，直接走下方过滤
  const exactHit = countBy.has(kw)
  let exactTotal = 0
  if (!exactHit) {
    // 精确标签验证：关键词本身若是有效标签（filter.tags=[kw] 能查到作品），即使不在
    // 热门 top-3000 也加入候选。结果按「关键词+类型」缓存，避免每次击键重复请求。
    const ck = `${lower}|${types.join(',')}`
    const ch = exactTagCache.get(ck)
    if (ch && Date.now() - ch.at < EXACT_TAG_CACHE_MS) {
      exactTotal = ch.count
    } else {
      const exactCounts = await mapWithConcurrency(types, 3, async (type) => {
        if (signal?.aborted) return 0
        try {
          const page = await fetchSearchPage(
            (offset) => ({
              url: `${P1_BASE}/search/subjects?${new URLSearchParams({
                limit: '1',
                offset: String(offset)
              }).toString()}`,
              init: {
                method: 'POST',
                headers: { ...authHeaders(token), 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ keyword: kw, sort: 'heat', filter: { tags: [kw], type: [type] } })
              }
            }),
            0,
            signal
          )
          return typeof page.total === 'number' ? page.total : 0
        } catch {
          return 0
        }
      })
      exactTotal = exactCounts.reduce((a, b) => a + b, 0)
      exactTagCache.set(ck, { at: Date.now(), count: exactTotal })
    }
    if (exactTotal > 0 && !countBy.has(kw)) countBy.set(kw, exactTotal)
  }

  const matched: { name: string; count: number }[] = []
  for (const [name, count] of countBy) {
    if (name.toLowerCase().includes(lower)) matched.push({ name, count })
  }
  matched.sort((a, b) => b.count - a.count)
  return { data: matched.slice(0, 50), total: matched.length }
}

export async function getEpisodes(subjectId: string, token?: string): Promise<SubjectFullEpisode[]> {
  const headers = authHeaders(token)
  const base = `${API_BASE}/episodes?subject_id=${encodeURIComponent(subjectId)}`
  // 只纳入「正篇(type 0) + 特别篇(type 1)」——这二者是追番进度要逐集标记的集数；
  // OP/ED/预告/其他(type 2~6) 不进入进度网格。
  const allowed = (t: number) => t === 0 || t === 1
  const mapOne = (e: any): SubjectFullEpisode => ({
    id: Number(e.id),
    // Bangumi 网页显示的「真实集号」是 sort 字段（全系列全局连续编号，多季作品如第三季=25~36；
    // 第 0 话/特别先行篇的 sort 为 0）。优先用 sort——sort 是数字（含 0）即采用，仅当 sort 缺失时回退 ep。
    epNumber: typeof e.sort === 'number' && e.sort >= 0 ? e.sort : (typeof e.ep === 'number' ? e.ep : 0),
    // 单集标题优先中文名（name_cn），无则回退原名（name）
    title: e.name_cn || e.name || null,
    airDate: e.airdate || null,
    duration: typeof e.duration === 'string' ? e.duration : null,
    epType: typeof e.type === 'number' ? e.type : 0
  })
  const dedupe = (list: any[]): any[] => {
    const seen = new Set<number>()
    const out: any[] = []
    for (const e of list) {
      const id = Number(e.id)
      if (seen.has(id)) continue
      seen.add(id)
      out.push(e)
    }
    return out
  }
  // 最终排序：正片(type 0)按 sort 升序在前，特别篇(type 1)按 sort 升序全部排到最后。
  const sortEpisodes = (list: any[]): any[] =>
    list.sort((a, b) => {
      const aSp = Number(a.type) === 1 ? 1 : 0
      const bSp = Number(b.type) === 1 ? 1 : 0
      if (aSp !== bSp) return aSp - bSp
      return Number(a.sort) - Number(b.sort)
    })

  // 策略 1：Bangumi 的 type 参数只接受单值，故分别拉「正篇」与「特别篇」后合并去重。
  try {
    const merged: any[] = []
    for (const t of [0, 1]) {
      const url = `${base}&type=${t}&limit=100`
      const res = await fetch(url, { headers })
      if (!res.ok) {
        console.warn(`[getEpisodes] subject=${subjectId} type=${t} HTTP ${res.status}`)
        continue
      }
      const json = (await res.json()) as { data?: any[] }
      if (json.data) merged.push(...json.data)
    }
    const deduped = dedupe(merged).filter((e) => allowed(Number(e.type)))
    if (deduped.length) {
      console.log(`[getEpisodes] subject=${subjectId} 策略(type 0+1) 拿到 ${deduped.length} 集`)
      // 正片在前、特别篇统一排到最后，各自按 sort 升序。
      return sortEpisodes(deduped).map(mapOne)
    }
  } catch (e) {
    console.error(`[getEpisodes] subject=${subjectId} 策略(type 0+1) 请求异常:`, e)
  }

  // 策略 2：拉全量再客户端筛 type∈{0,1}（兼容个别条目服务端 type 过滤异常的兜底）
  try {
    const url = `${base}&limit=100`
    const res = await fetch(url, { headers })
    if (res.ok) {
      const json = (await res.json()) as { data?: any[] }
      const list = (json.data ?? []).filter((e) => allowed(Number(e.type)))
      if (list.length) {
        console.log(`[getEpisodes] subject=${subjectId} 策略(all) 拿到 ${list.length} 集`)
        return sortEpisodes(dedupe(list)).map(mapOne)
      }
      console.log(`[getEpisodes] subject=${subjectId} 策略(all) 返回 0 集`)
    }
  } catch (e) {
    console.error(`[getEpisodes] subject=${subjectId} 策略(all) 请求异常:`, e)
  }

  console.warn(`[getEpisodes] subject=${subjectId} 最终未取得任何剧集`)
  return []
}

/**
 * 取单集评论（Bangumi 单集评论区，next 站 p1 API）：
 * GET https://next.bgm.tv/p1/episodes/{id}/comments （匿名亦可访问）。
 * 与作品吐槽 getSubjectComments 同构，返回**裸数组** [{ id, createdAt, content, user:{username,nickname,avatar} }]。
 */
export async function getEpisodeComments(
  episodeId: number | string,
  offset = 0,
  limit = 20,
  token?: string
): Promise<{ comments: EpisodeComment[]; total: number }> {
  const url = `https://next.bgm.tv/p1/episodes/${encodeURIComponent(String(episodeId))}/comments?limit=${limit}&offset=${offset}`
  // 受限单集匿名访问会被挡成 404，需带登录令牌（Bearer）才返回 200，与 getSubjectComments 同构。
  const res = token
    ? await authedFetch(url, token, { headers: { Accept: 'application/json' } })
    : await fetch(url, { headers: authHeaders() })
  // 404/410 = 该单集在 Bangumi 不存在/已下线，或（未登录时）受限需登录：视为「无评论」而非报错。
  if (res.status === 404 || res.status === 410) {
    console.warn('[getEpisodeComments] 单集不存在/已合并/需登录，跳过评论拉取：', episodeId)
    return { comments: [], total: 0 }
  }
  if (!res.ok) throw new Error(`获取单集评论失败 (HTTP ${res.status})`)
  const json = (await res.json()) as any
  // p1 端点返回裸数组（非 {data,total} 包裹），与 getSubjectComments 一致做兼容
  const list: any[] = Array.isArray(json) ? json : (json?.data ?? json?.comments ?? [])
  // 单条评论 -> EpisodeComment：递归映射嵌套的 replies（Bangumi 评论回复）。
  const mapComment = (c: any): EpisodeComment => {
    const creator = c.user ?? c['@creator'] ?? c.creator ?? {}
    const avatar = creator.avatar
    const avatarUrl =
      (avatar && (avatar.large || avatar.medium || avatar.small)) ||
      (typeof avatar === 'string' ? avatar : null)
    const replies: any[] = c.replies ?? []
    return {
      id: c.id,
      content: c.content ?? c.comment ?? c.text ?? '',
      createdAt: c.createdAt ?? c.updatedAt ?? c.created_at ?? null,
      creator: {
        username: creator.username ?? '',
        nickname: creator.nickname ?? creator.username ?? '',
        avatar: avatarUrl
      },
      mine: false,
      // 远程/已真发评论的 provider id 即其自身 id，供发表子评论时作 relatedID
      providerId: c.id,
      replies: replies.length ? replies.map(mapComment) : undefined,
      // 表情回应（仅登录态返回；匿名请求时 c.reactions 为 undefined，映射后仍为 undefined）
      reactions: Array.isArray(c.reactions)
        ? c.reactions.map((r: any) => ({
            value: r.value,
            users: Array.isArray(r.users)
              ? r.users.map((u: any) => ({ id: u.id, username: u.username, nickname: u.nickname }))
              : [],
            total: Array.isArray(r.users)
              ? r.users.length
              : typeof r.total === 'number'
                ? r.total
                : 0
          }))
        : undefined
    }
  }
  const comments: EpisodeComment[] = list.map(mapComment)
  return { comments, total: json.total ?? comments.length }
}

/**
 * 取单集详情（v0 /episodes/{id}，匿名可访问）：标题/集号/首播/时长/简介。
 * 字段：airdate / name / name_cn / duration / desc / ep / sort / type。
 * 用于单集评论悬浮窗上半部分（ep.N 标题 + 时长 + 首播 + 简介），无需抓网页。
 */
export async function getEpisode(episodeId: number | string): Promise<EpisodeDetail> {
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': UA }
  const res = await fetch(`${API_BASE}/episodes/${encodeURIComponent(String(episodeId))}`, { headers })
  if (!res.ok) throw new Error(`获取单集详情失败 (HTTP ${res.status})`)
  const e = (await res.json()) as any
  const nameCn = e.name_cn || null
  const name = e.name || null
  return {
    id: Number(e.id),
    // 全局连续编号优先 sort，回退 ep（sort=0 是「第 0 话」合法值，必须用 >= 0 而非 > 0，否则回退 ep=1）
    epNumber: typeof e.sort === 'number' && e.sort >= 0 ? e.sort : (typeof e.ep === 'number' ? e.ep : null),
    ep: typeof e.ep === 'number' ? e.ep : null,
    title: nameCn || name,
    name,
    airDate: e.airdate || null,
    duration: typeof e.duration === 'string' ? e.duration : (e.duration != null ? String(e.duration) : null),
    desc: e.desc || null,
    episodeType: typeof e.type === 'number' ? e.type : 0,
    subjectId: typeof e.subject_id === 'number' ? e.subject_id : null
  }
}

/**
 * 发布单集评论到 Bangumi（p1 POST /p1/episodes/{id}/comments）。
 * 安全校验顺序实测为：① 先校验 turnstileToken（缺失→400 REQUEST_VALIDATION_ERROR）；② 再校验 Bearer（无效→401 TOKEN_INVALID）。
 * 故必须同时传入 turnstileToken 与有效 Bearer 令牌。响应 200：{ id: <新评论 id> }。
 * turnstileToken 由主进程隐藏窗口求解（best-effort），调用方在失败时应回退本地存储。
 */
export async function postEpisodeComment(
  episodeId: number | string,
  content: string,
  token: string,
  turnstileToken: string,
  relatedID?: number | null
): Promise<number> {
  const body: Record<string, unknown> = { content, turnstileToken }
  // 发子评论：带上父评论的 provider id（Bangumi 评论系统的 relatedID 字段）
  if (relatedID != null) body.relatedID = relatedID
  const res = await fetch(
    `https://next.bgm.tv/p1/episodes/${encodeURIComponent(String(episodeId))}/comments`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': UA
      },
      body: JSON.stringify(body)
    }
  )
  if (res.status === 401) throw new Error(tagError('AUTH', 'Bangumi 授权已失效，请重新登录'))
  if (!res.ok) {
    // 400 = turnstile 缺失/无效；其它 = 服务端错误
    let msg = `发布单集评论失败 (HTTP ${res.status})`
    try {
      const err = (await res.json()) as any
      if (err?.message) msg += `：${err.message}`
    } catch {
      /* 忽略解析失败 */
    }
    throw new Error(msg)
  }
  const json = (await res.json()) as { id?: number }
  if (typeof json.id !== 'number') throw new Error('发布单集评论失败：响应缺少评论 id')
  return json.id
}

/**
 * 给单集评论发表/取消「表情回应（贴贴）」到 Bangumi。
 * 真实端点（来自 bangumi/frontend PR #1052 的 mock 与 ozaClient 封装）：
 *   - 发表/切换：PUT  https://next.bgm.tv/p1/episodes/-/comments/{commentId}/like  body { value: <整数> }
 *   - 取消：     DELETE https://next.bgm.tv/p1/episodes/-/comments/{commentId}/like
 * 路径中的 `-` 是 Bangumi 路由通配（评论 id 全局唯一，无需 episode id）。
 * 语义为 toggle：已对该评论做过 value 表情再调用则 remove=true（DELETE 取消），否则 PUT 添加。
 * 评论 reactions 字段仅登录态返回，故需 Bearer 令牌；value 取 FACE_KEY_GIF_MAPPING 的 key（字符串数字），发送时转整数。
 */
export async function postCommentReaction(
  commentId: number | string,
  value: number | string,
  token: string,
  remove = false
): Promise<void> {
  const url = `https://next.bgm.tv/p1/episodes/-/comments/${encodeURIComponent(String(commentId))}/like`
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'User-Agent': UA
  }
  const options: RequestInit = { method: remove ? 'DELETE' : 'PUT', headers }
  if (!remove) {
    headers['Content-Type'] = 'application/json'
    options.body = JSON.stringify({ value: Number(value) })
  }
  const res = await fetch(url, options)
  if (res.status === 401) throw new Error(tagError('AUTH', 'Bangumi 授权已失效，请重新登录'))
  if (!res.ok) {
    let msg = `发表表情回应失败 (HTTP ${res.status})`
    try {
      const err = (await res.json()) as any
      if (err?.message) msg += `：${err.message}`
    } catch {
      /* 忽略解析失败 */
    }
    throw new Error(msg)
  }
}

/** 取 Bangumi 条目吐槽区中「其它用户」的吐槽。
 *  注意：公开 v0 没有条目吐槽接口，吐槽在 next 站的 p1 API：
 *  GET https://next.bgm.tv/p1/subjects/{id}/comments （匿名亦可访问）。
 *  返回 { data: [{ id, user:{username,nickname,avatar:{large}}, comment, updatedAt }] }。 */
export interface SubjectCommentsResult {
  comments: SubjectComment[]
  total: number
  /** 该 Bangumi 条目不存在/已删除/已合并（区别于「存在但无吐槽」），此时 comments 为空 */
  notFound?: boolean
}
export async function getSubjectComments(
  subjectId: string,
  offset = 0,
  limit = 20,
  token?: string
): Promise<SubjectCommentsResult> {
  const url = `https://next.bgm.tv/p1/subjects/${encodeURIComponent(subjectId)}/comments?limit=${limit}&offset=${offset}`
  // 受限条目（如 18+）匿名访问会被 Bangumi 挡成 404，必须带登录令牌（Bearer）才返回 200。
  // 故优先用 authedFetch 携带令牌（含 401 静默刷新）；无令牌时退化为匿名 fetch（受限条目会 404）。
  const res = token
    ? await authedFetch(url, token, { headers: { Accept: 'application/json' } })
    : await fetch(url, { headers: authHeaders() })
  // 404/410 = 该条目在 Bangumi 不存在/已下线/已合并，或（未登录时）受限需登录：视为「无吐槽」而非报错，
  // 否则本地已导入但 Bangumi 端丢失/重定向的条目一打开详情就抛「获取吐槽失败 (HTTP 404)」。
  if (res.status === 404 || res.status === 410) {
    console.warn('[getSubjectComments] 条目不存在/已合并/需登录，跳过吐槽拉取：', subjectId)
    return { comments: [], total: 0, notFound: true }
  }
  if (!res.ok) throw new Error(`获取吐槽失败 (HTTP ${res.status})`)
  const json = (await res.json()) as any
  const list: any[] = json.data ?? json.comments ?? []
  const comments: SubjectComment[] = list.map((c) => {
    const creator = c.user ?? c['@creator'] ?? c.creator ?? {}
    const avatar = creator.avatar
    const avatarUrl =
      (avatar && (avatar.large || avatar.medium || avatar.small)) ||
      (typeof avatar === 'string' ? avatar : null)
    return {
      id: c.id,
      content: c.comment ?? c.content ?? c.text ?? '',
      createdAt: c.updatedAt ?? c.created_at ?? c.createdAt ?? null,
      rate: typeof c.rate === 'number' ? c.rate : 0,
      collectionType: typeof c.type === 'number' ? c.type : 0,
      creator: {
        username: creator.username ?? '',
        nickname: creator.nickname ?? creator.username ?? '',
        avatar: avatarUrl
      }
    }
  })
  return { comments, total: json.total ?? comments.length, notFound: false }
}

/** 取 Bangumi 角色/人物详情页的评论（吐槽）。
 *  端点：GET https://next.bgm.tv/p1/{characters|persons}/{id}/comments （匿名可访问，返回裸数组）。
 *  字段与 subject 吐槽完全一致，仅包装格式为裸数组而非 {data,total}。 */
export async function getEntityComments(
  kind: 'characters' | 'persons',
  id: number,
  offset = 0,
  limit = 20,
  token?: string
): Promise<SubjectCommentsResult> {
  const url = `https://next.bgm.tv/p1/${kind}/${encodeURIComponent(id)}/comments?limit=${limit}&offset=${offset}`
  const res = token
    ? await authedFetch(url, token, { headers: { Accept: 'application/json' } })
    : await fetch(url, { headers: authHeaders() })
  if (res.status === 404 || res.status === 410) {
    return { comments: [], total: 0, notFound: true }
  }
  if (!res.ok) throw new Error(`获取${kind === 'characters' ? '角色' : '人物'}评论失败 (HTTP ${res.status})`)
  const json = (await res.json()) as any
  const list: any[] = Array.isArray(json) ? json : (json.data ?? json.comments ?? [])
  const mapComment = (c: any): SubjectComment => {
    const creator = c.user ?? c['@creator'] ?? c.creator ?? {}
    const avatar = creator.avatar
    const avatarUrl =
      (avatar && (avatar.large || avatar.medium || avatar.small)) ||
      (typeof avatar === 'string' ? avatar : null)
    const result: SubjectComment = {
      id: c.id,
      content: c.comment ?? c.content ?? c.text ?? '',
      createdAt: c.updatedAt ?? c.created_at ?? c.createdAt ?? null,
      rate: typeof c.rate === 'number' ? c.rate : 0,
      collectionType: typeof c.type === 'number' ? c.type : 0,
      creator: {
        username: creator.username ?? '',
        nickname: creator.nickname ?? creator.username ?? '',
        avatar: avatarUrl
      }
    }
    if (Array.isArray(c.replies) && c.replies.length) {
      result.replies = c.replies.map(mapComment)
    }
    return result
  }
  const comments: SubjectComment[] = list.map(mapComment)
  return { comments, total: json.total ?? comments.length, notFound: false }
}

/** 发布角色/人物评论到 Bangumi（p1 POST /p1/{characters|persons}/{id}/comments）。
 *  需有效 Bearer 令牌；turnstile 可能不需要（角色/人物评论无安全挑战）。 */
export async function postEntityComment(
  kind: 'characters' | 'persons',
  id: number,
  content: string,
  token: string,
  relatedID?: number | null
): Promise<number> {
  const body: Record<string, unknown> = { content }
  if (relatedID != null) body.relatedID = relatedID
  const res = await fetch(
    `https://next.bgm.tv/p1/${kind}/${encodeURIComponent(id)}/comments`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': UA
      },
      body: JSON.stringify(body)
    }
  )
  if (res.status === 401) throw new Error(tagError('AUTH', 'Bangumi 授权已失效，请重新登录'))
  if (!res.ok) throw new Error(`发表评论失败 (HTTP ${res.status})`)
  const json = (await res.json()) as any
  return json.id ?? 0
}

/** 归一化 p1 讨论串（兼容 camelCase 字段名） */
function normalizeP1Topic(t: any): BgmTopic {
  const creator = t.creator ?? {}
  const avatar = creator.avatar
  // 所属条目（热门/最新列表返回；单作品列表无此字段）
  const sub = t.subject ?? null
  return {
    id: t.id,
    title: t.title ?? '',
    replyCount: typeof t.replyCount === 'number' ? t.replyCount : t.replies ?? 0,
    createdAt:
      typeof t.createdAt === 'number' ? t.createdAt : Math.floor(new Date(t.date ?? 0).getTime() / 1000),
    updatedAt:
      typeof t.updatedAt === 'number' ? t.updatedAt : Math.floor(new Date(t.lastpost ?? 0).getTime() / 1000),
    creator: {
      username: creator.username ?? '',
      nickname: creator.nickname ?? creator.username ?? '',
      avatar:
        avatar && typeof avatar === 'object'
          ? { small: avatar.small, medium: avatar.medium, large: avatar.large }
          : null
    },
    subject: sub
      ? {
          id: typeof sub.id === 'number' ? sub.id : 0,
          name: sub.name ?? '',
          nameCN: sub.nameCN ?? sub.name_cn,
          images: sub.images,
          rating:
            sub.rating && typeof sub.rating.score !== 'undefined'
              ? { score: sub.rating.score }
              : undefined
        }
      : null
  }
}

/**
 * 全站热门条目讨论（next.bgm.tv/p1/trending/subjects/topics，匿名可访问）。
 * 即 bgm.tv 首页右侧「热门条目讨论」模块同款数据，每条附带所属条目信息。
 */
export async function getTrendingSubjectTopics(token?: string): Promise<BgmTopic[]> {
  // 追加缓存破坏参数，确保每次（抽屉展开）都拿到最新网络响应，绕过 CDN/HTTP 缓存
  const url = `${P1_BASE}/trending/subjects/topics?_=${Date.now()}`
  const res = token
    ? await authedFetch(url, token, { headers: { Accept: 'application/json' } })
    : await fetch(url, { headers: authHeaders() })
  if (!res.ok) throw new Error(`获取热门讨论失败 (HTTP ${res.status})`)
  const json = (await res.json()) as any
  const list: any[] = Array.isArray(json) ? json : json.data ?? []
  return list.map(normalizeP1Topic)
}

/** 归一化楼层（递归楼中楼）；表情回应结构与单集评论 reactions 一致，直接透传 */
function normalizeP1Reply(r: any): BgmTopicReply {
  const c = r.creator ?? {}
  const avatar = c.avatar
  return {
    id: r.id,
    content: r.content ?? '',
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
    creator: {
      username: c.username ?? '',
      nickname: c.nickname ?? c.username ?? '',
      avatar:
        avatar && typeof avatar === 'object'
          ? avatar.large || avatar.medium || avatar.small || null
          : typeof avatar === 'string'
            ? avatar
            : null
    },
    replies: Array.isArray(r.replies) ? r.replies.map(normalizeP1Reply) : [],
    reactions: Array.isArray(r.reactions) ? r.reactions : undefined
  }
}

export interface BgmTopicsResult {
  topics: BgmTopic[]
  total: number
  /** 条目不存在/已合并/受限需登录 */
  notFound?: boolean
}

/**
 * 取某条目的讨论串列表（next.bgm.tv/p1/subjects/{id}/topics，匿名可访问）。
 * 返回按最后回复排序；受限条目匿名 404 → notFound=true（与吐槽箱同策略）。
 */
export async function getSubjectTopics(subjectId: string, token?: string): Promise<BgmTopicsResult> {
  const url = `${P1_BASE}/subjects/${encodeURIComponent(subjectId)}/topics`
  const res = token
    ? await authedFetch(url, token, { headers: { Accept: 'application/json' } })
    : await fetch(url, { headers: authHeaders() })
  if (res.status === 404 || res.status === 410) {
    console.warn('[getSubjectTopics] 条目不存在/已合并/需登录：', subjectId)
    return { topics: [], total: 0, notFound: true }
  }
  if (!res.ok) throw new Error(`获取条目讨论失败 (HTTP ${res.status})`)
  const json = (await res.json()) as any
  // p1 返回 { data: [...], total }；防御性兼容裸数组
  const list: any[] = Array.isArray(json) ? json : json.data ?? []
  const topics = list.map(normalizeP1Topic)
  return { topics, total: json.total ?? topics.length, notFound: false }
}

/**
 * 取讨论串详情（next.bgm.tv/p1/subjects/-/topics/{id}，匿名可访问）。
 * 返回全部楼层（replies[0] 为楼主帖）+ 楼中楼嵌套 + 表情回应；受限内容匿名 404 → null。
 */
export async function getTopicDetail(topicId: number, token?: string): Promise<BgmTopicDetail | null> {
  const url = `${P1_BASE}/subjects/-/topics/${encodeURIComponent(String(topicId))}`
  const res = token
    ? await authedFetch(url, token, { headers: { Accept: 'application/json' } })
    : await fetch(url, { headers: authHeaders() })
  if (res.status === 404 || res.status === 410) return null
  if (!res.ok) throw new Error(`获取讨论详情失败 (HTTP ${res.status})`)
  const json = (await res.json()) as any
  const s = json.subject ?? null
  return {
    ...normalizeP1Topic(json),
    subject: s
      ? {
          id: s.id,
          name: s.name ?? '',
          nameCN: s.nameCN ?? s.name_cn,
          images: s.images,
          rating: s.rating && typeof s.rating.score !== 'undefined' ? { score: s.rating.score } : undefined
        }
      : null,
    replies: Array.isArray(json.replies) ? json.replies.map(normalizeP1Reply) : []
  }
}

/**
 * 在讨论串下发表回复（POST /p1/subjects/-/topics/{topicId}/replies，需 Bearer 令牌）。
 * replyTo：0 或缺省 = 顶层回复；传某楼层 id = 楼中楼回复（Bangumi 两层模型）。
 * 返回新楼层 id。
 */
export async function postTopicReply(
  topicId: number,
  content: string,
  token: string,
  replyTo?: number | null
): Promise<number> {
  const url = `${P1_BASE}/subjects/-/topics/${encodeURIComponent(String(topicId))}/replies`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': UA
    },
    body: JSON.stringify({ content, replyTo: replyTo ?? 0 })
  })
  if (res.status === 401) throw new Error(tagError('AUTH', 'Bangumi 授权已失效，请重新登录'))
  if (!res.ok) {
    let msg = `回复失败 (HTTP ${res.status})`
    try {
      const err = (await res.json()) as any
      if (err?.message) msg += `：${err.message}`
    } catch {
      /* 忽略解析失败 */
    }
    throw new Error(msg)
  }
  const json = (await res.json().catch(() => ({}))) as any
  return typeof json?.id === 'number' ? json.id : 0
}

/**
 * 讨论楼层表情回应 toggle（PUT/DELETE /p1/subjects/-/posts/{postId}/like，需 Bearer 令牌）。
 * 注意与单集评论的 like 端点不同：讨论楼层走 subjects/-/posts/{postId}。
 */
export async function toggleTopicPostReaction(
  postId: number | string,
  value: number | string,
  token: string,
  remove = false
): Promise<void> {
  const url = `${P1_BASE}/subjects/-/posts/${encodeURIComponent(String(postId))}/like`
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'User-Agent': UA
  }
  const options: RequestInit = { method: remove ? 'DELETE' : 'PUT', headers }
  if (!remove) {
    headers['Content-Type'] = 'application/json'
    options.body = JSON.stringify({ value: Number(value) })
  }
  const res = await fetch(url, options)
  if (res.status === 401) throw new Error(tagError('AUTH', 'Bangumi 授权已失效，请重新登录'))
  if (!res.ok) {
    let msg = `发表表情回应失败 (HTTP ${res.status})`
    try {
      const err = (await res.json()) as any
      if (err?.message) msg += `：${err.message}`
    } catch {
      /* 忽略解析失败 */
    }
    throw new Error(msg)
  }
}

export interface CollectionUpdatePayload {
  type?: number
  /** 用户星级评分（Bangumi 字段名为 `rate`，整数 1-10；0 表示删除评分） */
  rate?: number
  ep_status?: number
  vol_status?: number
  comment?: string
  private?: boolean
  tags?: string[]
}

export async function updateCollection(
  subjectId: string,
  payload: CollectionUpdatePayload,
  token: string
): Promise<void> {
  const post = (p: CollectionUpdatePayload) =>
    authedFetch(`${API_BASE}/users/-/collections/${encodeURIComponent(subjectId)}`, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(p)
    })

  let res = await post(payload)
  // 200/201 成功；204 也视为成功
  if (res.ok || res.status === 204) return

  // 读取响应体（Bangumi 的 400 常在 body 里指明哪个字段非法）
  let body = ''
  try {
    body = (await res.text()).slice(0, 500)
  } catch {
    /* 读取失败忽略 */
  }

  // 特例：某些作品在 Bangumi 实际类型不接受进度字段（如本地分类与 Bangumi 类型不符的动画/游戏），
  // 会被拒 `can't set 'vol_status' or 'ep_status' on non-book subject`。去掉进度字段重试一次，
  // 保底把收藏本身（类型/评分/评语/隐私）同步上去——这些作品本来就不该传进度。
  const isProgressRejected =
    res.status === 400 &&
    /(ep_status|vol_status)/i.test(body) &&
    /(non-book|can't set)/i.test(body)
  if (isProgressRejected) {
    const retryPayload: CollectionUpdatePayload = { ...payload }
    delete retryPayload.ep_status
    delete retryPayload.vol_status
    res = await post(retryPayload)
    if (res.ok || res.status === 204) return
    try {
      body = (await res.text()).slice(0, 500)
    } catch {
      /* 读取失败忽略 */
    }
  }

    throw new Error(tagError(codeForStatus(res.status) ?? 'SERVER', `更新收藏失败 (HTTP ${res.status})${body ? ' - ' + body : ''}`))
}

/**
 * 删除 Bangumi 收藏：DELETE /v0/users/-/collections/{subject_id}。
 * 需要 Bearer 令牌；201/200/204 视为成功；401 自动刷新重试，仍失败抛「授权已失效」。
 */
export async function deleteCollectionOnBgm(
  subjectId: string,
  token: string
): Promise<void> {
  const res = await authedFetch(
    `${API_BASE}/users/-/collections/${encodeURIComponent(subjectId)}`,
    token,
    { method: 'DELETE' }
  )
  if (!res.ok && res.status !== 204) {
    throw new Error(tagError(codeForStatus(res.status) ?? 'SERVER', `删除收藏失败 (HTTP ${res.status})`))
  }
}

/**
 * 同步单集观看状态到 Bangumi（PUT /v0/users/-/collections/-/episodes/{episodeId}）。
 * type 枚举：0=撤销(remove) / 1=想看(wish) / 2=看过(watched) / 3=在看(watching) / 4=抛弃(dropped)。
 * 需要 Bearer 令牌；best-effort：由调用方决定是否吞掉错误（本地已保存时忽略）。
 * 401 自动刷新重试，仍失败抛「授权已失效」。
 */
export async function setEpisodeStatusOnBgm(
  episodeId: number,
  type: number,
  token: string
): Promise<void> {
  const res = await authedFetch(
    `${API_BASE}/users/-/collections/-/episodes/${encodeURIComponent(episodeId)}`,
    token,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type }) }
  )
  if (!res.ok && res.status !== 204) {
    throw new Error(tagError(codeForStatus(res.status) ?? 'SERVER', `同步单集状态失败 (HTTP ${res.status})`))
  }
}

export async function getMyCollection(
  subjectId: string,
  token: string,
  username: string
): Promise<any | null> {
  const res = await authedFetch(
    `${API_BASE}/users/${encodeURIComponent(username)}/collections/${encodeURIComponent(subjectId)}`,
    token
  )
  if (res.status === 404) return null
  if (!res.ok) throw new Error(tagError(codeForStatus(res.status) ?? 'SERVER', `获取收藏失败 (HTTP ${res.status})`))
  return await res.json()
}

/**
 * 把 Bangumi 逐集进度列表解析为本应用的逐集标记映射。
 *
 * 专用端点 GET /v0/users/-/collections/{subject_id}/episodes 返回的是
 * Paged[UserEpisodeCollection]，每条形如：
 *   { episode: { id: <剧集id>, ... }, type: <EpisodeCollectionType 整数 0-3>, updated_at }
 * 其中 type 是**整数**（0=未收藏 / 1=想看 / 2=看过 / 3=抛弃），不是对象、也没有 status 字段。
 * 注意：早期把 type 误当成 {id} 对象、把剧集 id 误当成 ep.id 会导致解析全空 → 单集状态永远拉不到。
 *
 * 映射：2→看过(watched)，1→想看(want)，3→抛弃(dropped)；0/其它跳过（不清本地标记）。
 */
export function parseBgmEps(eps: any): Record<number, { watched: boolean; want: boolean; dropped?: boolean }> {
  const map: Record<number, { watched: boolean; want: boolean; dropped?: boolean }> = {}
  if (!Array.isArray(eps)) return map
  for (const ep of eps) {
    // 剧集 id 在嵌套的 episode 对象里；同时兼容裸 {id} 形态（保险）
    const id = ep?.episode?.id ?? ep?.id ?? ep?.episode_id
    if (!id) continue
    // type 是 EpisodeCollectionType 的整数（也可能包成 {id} 对象，做兼容）
    const st = Number(ep?.type?.id ?? ep?.type ?? ep?.status?.id ?? ep?.status)
    if (st === 2) map[Number(id)] = { watched: true, want: false }
    else if (st === 1) map[Number(id)] = { watched: false, want: true }
    else if (st === 3) map[Number(id)] = { watched: false, want: false, dropped: true }
  }
  return map
}

/**
 * 拉取用户在 Bangumi 上对某作品的逐集观看标记（专用端点，无需用户名）。
 * GET /v0/users/-/collections/{subjectId}/episodes，分页拉全；404→{}（作品不在收藏）。
 */
export async function getEpisodeProgress(
  subjectId: string,
  token: string
): Promise<Record<number, { watched: boolean; want: boolean; dropped?: boolean }>> {
  const all: any[] = []
  const LIMIT = 100
  let offset = 0
  for (;;) {
    const url = `${API_BASE}/users/-/collections/${encodeURIComponent(
      subjectId
    )}/episodes?limit=${LIMIT}&offset=${offset}`
    const res = await fetch(url, { headers: authHeaders(token) })
    if (res.status === 404) return {}
    if (!res.ok) {
      console.warn(`[getEpisodeProgress] subject=${subjectId} HTTP ${res.status}`)
      break
    }
    const json = (await res.json()) as any
    const list = Array.isArray(json) ? json : json?.data ?? []
    all.push(...list)
    if (list.length < LIMIT) break
    offset += LIMIT
  }
  return parseBgmEps(all)
}

export async function getP1UserTimeline(
  username: string,
  token: string,
  limit = 1
): Promise<number | null> {
  try {
    const url = `${P1_BASE}/users/${encodeURIComponent(username)}/timeline?limit=${limit}`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    })
    if (!res.ok) return null
    const json = (await res.json()) as any
    const list = Array.isArray(json) ? json : json?.data ?? []
    if (!Array.isArray(list) || list.length === 0) return null
    return parseActivityTime(list[0])
  } catch {
    return null
  }
}

/** C' 定向刷新：取最近若干条动态，解析出「哪部作品」有活动（subjectId + 秒级时间）。失败返回 []。 */
export async function getP1UserRecentActivity(
  username: string,
  token: string,
  limit = 20
): Promise<Array<{ subjectId: number; ts: number }>> {
  try {
    const url = `${P1_BASE}/users/${encodeURIComponent(username)}/timeline?limit=${limit}`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    })
    if (!res.ok) return []
    const json = (await res.json()) as any
    const list: any[] = Array.isArray(json) ? json : json?.data ?? []
    const out: Array<{ subjectId: number; ts: number }> = []
    for (const raw of list) {
      const sid = extractP1SubjectId(raw)
      if (!sid) continue
      out.push({ subjectId: sid, ts: parseActivityTime(raw) ?? 0 })
    }
    return out
  } catch {
    return []
  }
}

function parseActivityTime(item: any): number | null {
  const raw = item?.time ?? item?.created_at ?? item?.datetime ?? item?.date ?? item?.timestamp
  if (raw == null) return null
  if (typeof raw === 'number') return raw < 1e12 ? raw : Math.floor(raw / 1000)
  const t = Date.parse(String(raw))
  return Number.isFinite(t) ? Math.floor(t / 1000) : null
}

export async function getMyCollections(
  token: string,
  opts: { limit?: number; offset?: number },
  username: string
): Promise<{ data: any[]; total: number }> {
  const limit = opts.limit ?? 30
  const offset = opts.offset ?? 0
  const res = await authedFetch(
    `${API_BASE}/users/${encodeURIComponent(username)}/collections?limit=${limit}&offset=${offset}`,
    token
  )
  // 404 通常意味着端点/用户名无效（v0 列表接口必须用真实用户名，不支持 "-")
  if (res.status === 404)
    throw new Error(tagError('NOT_FOUND', '获取收藏列表失败：账号或收藏接口无效（请确认已登录且用户名有效）'))
  if (!res.ok) throw new Error(tagError(codeForStatus(res.status) ?? 'SERVER', `获取收藏列表失败 (HTTP ${res.status})`))
  const json = (await res.json()) as { data?: any[]; total?: number }
  return { data: json.data ?? [], total: json.total ?? 0 }
}

export interface BangumiUser {
  id?: number
  username?: string
  nickname?: string
  avatar?: string | null
}

/** 取当前令牌对应的 Bangumi 用户（用于缓存用户名；头像供单集评论「自己」卡显示） */
export async function getMe(token: string): Promise<BangumiUser | null> {
  const res = await fetch(`${API_BASE}/me`, { headers: authHeaders(token) })
  if (!res.ok) return null
  const d = (await res.json()) as any
  const avatar = d.avatar
  const avatarUrl =
    (avatar && (avatar.large || avatar.medium || avatar.small)) ||
    (typeof avatar === 'string' ? avatar : null)
  return {
    id: d.id,
    username: d.username,
    nickname: d.nickname,
    avatar: avatarUrl
  }
}

export function toSubject(raw: any, category: Category): Subject {
  const rating = typeof raw.rating === 'number' ? raw.rating : raw.rating?.score
  const images = raw.images || {}
  return {
    provider: 'bangumi',
    providerSubjectId: String(raw.id),
    category,
    title: raw.name ?? raw.name_cn ?? '',
    titleCn: raw.name_cn,
    summary: raw.summary,
    imageUrl: images.common ?? images.large ?? images.medium ?? images.small ?? raw.image,
    airDate: raw.air_date ?? raw.date,
    rating,
    totalEpisodes: raw.eps ?? raw.total_episodes,
    totalVolumes: raw.volumes ?? raw.total_volumes,
    series: typeof raw.series === 'boolean' ? raw.series : undefined,
    nsfw: !!raw.nsfw
  }
}

/** 取作品详情（含 tags 与 platform），用于书籍细分归类。带 20s 超时，避免逐本重分类时单请求挂死。 */
export async function getSubjectDetail(id: string, token?: string): Promise<any> {
  // 底层磁盘缓存：同一作品主信息 1 天内只真正拉取 1 次（含在途去重）。
  // 这样同步引擎 / 分析服务 / 浏览详情（getSubjectFull 内部）无论谁调用都复用同一份，
  // 避免跨模块重复拉取，降低瞬时速率。token 维度区分匿名/登录（受限内容可能不同）。
  return cachedGet(
    `subjectDetail:${token ? 'a' : 'n'}:${id}`,
    ONE_DAY_MS,
    async () => {
      const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': UA }
      if (token) headers.Authorization = `Bearer ${token}`
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 20000)
      try {
        const res = await fetch(`${API_BASE}/subjects/${encodeURIComponent(id)}`, { headers, signal: ctrl.signal })
        if (!res.ok) throw new Error(`获取作品详情失败 (HTTP ${res.status})`)
        return await res.json()
      } finally {
        clearTimeout(timer)
      }
    }
  )
}

/**
 * 从 Bangumi 作品详情里解析出「标签」与「制作信息」。
 * - tags：原始数组 [{name, count}]，直接扁平化。
 * - infobox：原始数组 [{key, value}]，value 可能是字符串 / {v} / [{v}]，
 *   这里统一 flatten 成「键 → 可读字符串」（制作公司、出版社、平台、声优 等）。
 */
export function parseSubjectMeta(raw: any): { tags: SubjectTag[]; meta: SubjectMeta[]; metaTags: string[] } {
  const tags: SubjectTag[] = (raw?.tags ?? [])
    .map((t: any) => ({ name: String(t?.name ?? ''), count: Number(t?.count) || 0 }))
    .filter((t: SubjectTag) => t.name)

  const meta: SubjectMeta[] = []
  for (const box of raw?.infobox ?? []) {
    const key = box?.key
    if (!key) continue
    meta.push({ key: String(key), value: flattenInfoboxValue(box?.value) })
  }
  // meta_tags：Bangumi 顶层字符串数组（官方/系统标签，如 ["机战","TV","日本","原创","战斗"]），
  // 与用户自由标注的 tags 分开。
  const metaTags: string[] = (raw?.meta_tags ?? []).map(String).filter(Boolean)
  return { tags, meta, metaTags }
}

function flattenInfoboxValue(v: any): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) {
    return v.map((x) => (typeof x === 'string' ? x : flattenObjectValue(x))).filter(Boolean).join('、')
  }
  if (typeof v === 'object') return flattenObjectValue(v)
  return String(v)
}

/** infobox 对象的 value 常为 { v, k }（一个显示名、一个链接）。保留「更像 URL」的那个，
 *  避免外链（如 vndb.org/v60663）因藏在 k 字段而被丢弃。 */
function flattenObjectValue(o: any): string {
  const vv = o?.v
  const kk = o?.k
  const both = [vv, kk].filter((x): x is string => typeof x === 'string' && !!x)
  if (!both.length) return ''
  const url = both.find((x) => /^https?:\/\//i.test(x) || /(?:\.org|\.com|\.jp)\//i.test(x))
  return url ?? both[0]
}

export interface BookAnalysis {
  category: Category
  tags: SubjectTag[]
  meta: SubjectMeta[]
}

function firstImage(images: any): string | undefined {
  if (!images) return undefined
  return images.medium ?? images.large ?? images.common ?? images.small ?? images.grid
}

/**
 * 匿名取单个作品的封面 URL（用于离线 Archive 库封面色块缺失时的「联网补图」）。
 * - v0 /subjects/{id} 匿名（无令牌）即可 200，返回 images 对象。
 * - 仅取封面 URL、不解析全量字段，轻量。失败（网络/限流/404）返回 null，由调用方降级。
 * - 复用 firstImage 的优先级（medium > large > common > small > grid），与详情页一致。
 */
export async function getSubjectCover(id: number, token?: string): Promise<string | null> {
  if (!id || id <= 0) return null
  const headers = { ...authHeaders(token), Accept: 'application/json' }
  // 匿名详情接口限 30/min、授权 90/min：按是否带令牌选配额（登录后不再被 24/min 卡死）
  await throttle(!!token)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const res = await fetch(`${API_BASE}/subjects/${encodeURIComponent(id)}`, { headers, signal: ctrl.signal })
    if (res.status === 429) return null // 限流：交由上层跳过（已记入令牌桶，下次再试）
    if (!res.ok) return null
    const raw = await res.json()
    return firstImage(raw?.images) ?? null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 从 Bangumi 的 infobox 数组里提取「简体中文名」。
 * 角色/CV 的中文译名并不在顶层 name_cn 字段（v0 的 Character/Person schema 根本没有
 * name_cn），而是藏在 infobox 的 key="简体中文名" 里——这也正是 Bangumi 网页与第三方
 * 站能显示中文角色名的原因。需逐个调详情接口 /v0/characters/{id}、/v0/persons/{id} 才能拿到 infobox。
 */
function cnNameFromInfobox(infobox: any): string | undefined {
  if (!Array.isArray(infobox)) return undefined
  // 标准 key 是「简体中文名」；部分条目写作「简体中文 / 中文名 / 中文」，一并兼容。
  // 优先返回标准 key，其余作为兜底，避免「有中文名却取不到」。
  let fallback: string | undefined
  for (const it of infobox) {
    if (!it || typeof it.key !== 'string') continue
    const v = typeof it.value === 'string' ? it.value.trim() : ''
    if (!v) continue
    if (it.key === '简体中文名') return v
    if (!fallback && (it.key === '简体中文' || it.key === '中文名' || it.key === '中文')) {
      fallback = v
    }
  }
  return fallback
}

/** 同一会话内缓存「角色/CV 中文名」，按 id 去重，避免同一作品反复调详情接口。 */
const cnNameCache = new Map<string, string | null>()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 全局令牌桶限速：Bangumi 授权约 90/min、匿名约 30/min。手游几十角色+CV 一次要发上百个
 *  详情请求，若不限速会被 429 整批打光（这正是「登录了仍有大量角色显示原名」的根因）。
 *  这里严格限速（留余量），配合 loadSubjectExtra 的【异步补全+推送】：首次返回快、后台
 *  按此速率陆续补齐中文名，既不卡 UI 也不触发限流。 */
const _reqLog: number[] = []
export async function throttle(isAuthed: boolean) {
  const cap = isAuthed ? 80 : 24
  for (;;) {
    const now = Date.now()
    const cutoff = now - 60000
    while (_reqLog.length && _reqLog[0] <= cutoff) _reqLog.shift()
    if (_reqLog.length < cap) break
    await sleep(Math.min(1000, 60000 - (now - _reqLog[0]) + 1))
  }
  _reqLog.push(Date.now())
}
async function fetchCnName(
  kind: 'characters' | 'persons',
  id: number,
  token?: string,
  attempt = 0
): Promise<string | undefined> {
  const key = `${kind}:${id}`
  if (cnNameCache.has(key)) {
    const v = cnNameCache.get(key)
    return v === null ? undefined : v
  }
  await throttle(!!token)
  try {
    const res = await fetch(`${API_BASE}/${kind}/${encodeURIComponent(id)}`, {
      headers: authHeaders(token)
    })
    if (res.status === 429) {
      // Bangumi 限流：退避重试（最多 3 次，间隔递增）。带 token 配额高、退避可短；
      // 匿名限流严，退避更长，避免热门作品（如手游几十个角色+CV）批量请求被直接打光。
      if (attempt < 3) {
        const base = token ? 300 : 700
        await sleep(base * (attempt + 1))
        return fetchCnName(kind, id, token, attempt + 1)
      }
      // 仍失败：本次回退原名，且不缓存（下次打开再试），绝不拿原名覆盖已缓存中文
      return undefined
    }
    if (!res.ok) {
      // 404（无此条目）可永久缓存为空；429 已在上面处理
      if (res.status === 404) cnNameCache.set(key, null)
      return undefined
    }
    const d = (await res.json()) as any
    const cn = cnNameFromInfobox(d.infobox)
    cnNameCache.set(key, cn ?? null)
    return cn
  } catch {
    // 离线 / 网络错误：回退原名，不阻塞展示
    return undefined
  }
}

/** 简单并发池：把大量详情请求限制为同时 N 个，避免触发 Bangumi 限流。 */
export async function mapWithConcurrency<T, U>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<U>
): Promise<U[]> {
  const results: U[] = new Array(items.length)
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++
      results[i] = await fn(items[i])
    }
  }
  const n = Math.min(limit, items.length)
  await Promise.all(Array.from({ length: n }, worker))
  return results
}

/**
 * 取作品角色列表。
 * 主路径用 Bangumi 新网站 P1 接口（/p1/subjects/{id}/characters?limit=100）：
 *   - 直接给出「作品内真实排序」（数组顺序 = 网页展示顺序，主角置顶），无需再按 id 重排；
 *   - 角色中文名(nameCN)、关系(type→主角/配角/客串/旁白/闲角)、收藏数(comment)、CV(casts) 一次拿全；
 *   - 不再需要逐个调 /v0/characters/{id} 挖 infobox，省去大量限流风险请求。
 * 若 P1 失败（网络/限流/返回空），回退到 v0 实现（getSubjectCharactersV0），
 * 后者带 infobox 中文名补全 —— 即「v0 备份」。
 */
export async function getSubjectCharacters(
  id: string,
  token?: string,
  opts: { withCn?: boolean } = {}
): Promise<any[]> {
  const { withCn = true } = opts
  // 主路径：P1（一次拿全，含中文名）
  try {
    const p1 = await fetchP1Characters(id)
    if (p1.length) return p1
  } catch (e) {
    console.warn(`[getSubjectCharacters] P1 主路径失败，回退 v0：`, e)
  }
  // 兜底：v0（带 infobox 中文名补全）
  return getSubjectCharactersV0(id, token, { withCn })
}

/**
 * P1 主路径：取作品角色列表（next.bgm.tv 私有 API，匿名可用）。
 * 返回已归一化的 SubjectCharacter[]，顺序即 Bangumi 网页展示顺序。
 */
async function fetchP1Characters(id: string): Promise<any[]> {
  const res = await fetch(
    `${P1_BASE}/subjects/${encodeURIComponent(id)}/characters?limit=100`,
    { headers: { Accept: 'application/json', 'User-Agent': UA } }
  )
  if (!res.ok) throw new Error(`P1 获取角色失败 (HTTP ${res.status})`)
  const json = (await res.json()) as any
  // P1 返回 { data: [...], total }，兼容裸数组
  const rows: any[] = Array.isArray(json) ? json : (json?.data ?? [])
  if (!rows.length) return []
  return rows.map((r: any) => {
    const c = r.character ?? {}
    const type = typeof r.type === 'number' ? r.type : 0
    const relation = P1_RELATION_TYPE[type] ?? ''
    const nameCn = (c.nameCN && String(c.nameCN).trim()) || ''
    const actors = (r.casts ?? []).map((a: any) => {
      // P1 的 cast 元素是嵌套结构：声优真实信息在 cast.person.*（无顶层 id/name/nameCN/images），
      // 声优 id 也在 person.id。早期把 cast 当扁平结构直接取 a.name/a.nameCN 导致 CV 名字全空。
      // 这里优先取 a.person.*，并兼容扁平结构（直接 a.*）以防文档变更。
      const person = a.person ?? a
      const aid = typeof person.id === 'number' ? person.id : undefined
      const acn = (person.nameCN && String(person.nameCN).trim()) || ''
      return {
        id: aid,
        nameCn: acn,
        name: acn || person.name || '',
        image: firstImage(person.images)
      }
    })
    return {
      id: c.id,
      nameCn,
      // 优先中文名（P1 直接给），无则原名
      name: nameCn || c.name || '',
      image: firstImage(c.images),
      relation,
      // 收藏数（+N），P1 直接给；前端可选展示
      comment: typeof c.comment === 'number' ? c.comment : undefined,
      actors
    }
  })
}

/**
 * 取作品角色列表（Bangumi v0：/subjects/{id}/characters）—— 作为 P1 的兜底备份。
 * 含角色名、角色关系(主角/配角/客串)、头像、以及配音演员(CV)。
 * 返回已归一化的 SubjectCharacter[]，且角色名/CV 名优先使用中文译名：
 * 列表接口本身只返回原名（无 name_cn、无 infobox），故这里会并发调
 * /v0/characters/{id} 与 /v0/persons/{id} 详情接口，从 infobox 的「简体中文名」
 * 提取中文名（这两个详情接口匿名也可用）。失败 / 离线时优雅回退原名。
 */
async function getSubjectCharactersV0(
  id: string,
  token?: string,
  opts: { withCn?: boolean } = {}
): Promise<any[]> {
  const { withCn = true } = opts
  const res = await fetch(`${API_BASE}/subjects/${encodeURIComponent(id)}/characters`, {
    headers: authHeaders(token)
  })
  if (!res.ok) throw new Error(`获取角色失败 (HTTP ${res.status})`)
  const json = (await res.json()) as any
  // v0 的 /subjects/{id}/characters 与 /subjects/{id}/subjects 直接返回裸数组 [{...}]，
  // 而非 { data: [...] }（后者是 search 接口的包裹格式）。两种都兼容，否则会拿到空数组
  // 导致「角色/关联作品列表有、但头像/封面全空」（匿名补图映射表为空）。
  const list: any[] = Array.isArray(json) ? json : (json?.data ?? [])

  // 快速路径（withCn=false）：仅返回列表（角色名/关系/头像），中文名留待后台异步补全
  // （loadSubjectExtra 的 step 4 通过 onCnUpdated 推送）。避免同步等待上百个
  // 「角色/CV 详情」请求导致详情页卡死（表现为点不进去 / 角色加载不出来）。
  if (!withCn) {
    return list.map((c: any) => ({
      id: c.id,
      nameCn: '',
      name: c.name_cn || c.name || '',
      image: firstImage(c.images),
      relation: c.relation ?? '',
      actors: (c.actors ?? []).map((a: any) => ({
        id: typeof a.id === 'number' ? a.id : undefined,
        nameCn: '',
        name: a.name_cn || a.name || '',
        image: firstImage(a.images)
      }))
    }))
  }

  // 收集角色 id 与 CV id，批量并发取中文译名
  const charIds: number[] = []
  const actorSet = new Set<number>()
  for (const c of list) {
    if (typeof c.id === 'number') charIds.push(c.id)
    for (const a of c.actors ?? []) {
      // 同一声优常配多个角色，按 id 去重，少打几十个请求，显著降低限流概率
      if (typeof a.id === 'number') actorSet.add(a.id)
    }
  }
  const actorIds = [...actorSet]
  // 带 token 配额更高，并发可大些；匿名限流严，降到 3 减少 429。
  // 注意：Bangumi 限流按分钟计（授权约 90/min），手游几十角色+CV 仍需分多批/多次打开渐进补全。
  const concurrency = token ? 5 : 3
  const [charCnArr, actorCnArr] = await Promise.all([
    mapWithConcurrency(charIds, concurrency, (cid) => fetchCnName('characters', cid, token)),
    mapWithConcurrency(actorIds, concurrency, (pid) => fetchCnName('persons', pid, token))
  ])
  const charCn = new Map<number, string | undefined>(charIds.map((cid, i) => [cid, charCnArr[i]]))
  const actorCn = new Map<number, string | undefined>(actorIds.map((pid, i) => [pid, actorCnArr[i]]))

  return list.map((c: any) => {
    const cid = typeof c.id === 'number' ? c.id : -1
    const cn = cid >= 0 ? charCn.get(cid) : undefined
    const cnStr = (cn && cn.trim()) || ''
    return {
      id: c.id,
      // 真正取到的中文译名（供合并判断用）；空串表示本次未取到
      nameCn: cnStr,
      // 优先中文译名：infobox 简体中文名 > 列表 name_cn（通常为空）> 原名
      name: cnStr || c.name_cn || c.name || '',
      image: firstImage(c.images),
      relation: c.relation ?? '',
      actors: (c.actors ?? []).map((a: any) => {
        const aid = typeof a.id === 'number' ? a.id : -1
        const acn = aid >= 0 ? actorCn.get(aid) : undefined
        const acnStr = (acn && acn.trim()) || ''
        return {
          id: typeof a.id === 'number' ? a.id : undefined,
          nameCn: acnStr,
          // CV 名同样优先中文译名
          name: acnStr || a.name_cn || a.name || '',
          image: firstImage(a.images)
        }
      })
    }
  })
}

/**
 * 取作品关联条目（Bangumi v0：/subjects/{id}/subjects）。
 * 含关联作品名、作品类型、封面、以及关联类型(续集/前传/外传…)。
 * 需令牌；返回已归一化的 SubjectRelation[]。
 */
export async function getSubjectRelations(id: string, token?: string): Promise<any[]> {
  const res = await fetch(`${API_BASE}/subjects/${encodeURIComponent(id)}/subjects`, {
    headers: authHeaders(token)
  })
  if (!res.ok) throw new Error(`获取关联作品失败 (HTTP ${res.status})`)
  const json = (await res.json()) as any
  // 同 characters：v0 /subjects/{id}/subjects 返回裸数组，而非 { data: [...] }
  const list: any[] = Array.isArray(json) ? json : (json?.data ?? [])
  return list.map((s: any) => ({
    id: s.id,
    // 真正取到的中文译名（供合并判断用）
    nameCn: (s.name_cn && String(s.name_cn).trim()) || '',
    // 优先中文译名（name_cn），无则回退原名
    name: s.name_cn || s.name || '',
    image: firstImage(s.images),
    type: s.type ?? 0,
    relation: s.relation ?? ''
  }))
}

/**
 * 取作品制作人员（staff）：作者 / 导演 / 原画 / 制作公司 等（Bangumi v0：/subjects/{id}/persons）。
 * 匿名亦可访问。返回归一化的 SubjectPerson[]（含 id，供渲染端把「制作信息」里的人名/公司名
 * 渲染成可点击项、跳转到对应人物悬浮窗）。
 * 注意：不做额外中文名详情请求（省限流），name 直接用列表返回名（多为常用名）。
 * v0 的 /subjects/{id}/persons 同样返回裸数组 [{...}]，故兼容两种包裹格式。
 */
export async function getSubjectStaff(id: string, token?: string): Promise<SubjectPerson[]> {
  const res = await fetch(`${API_BASE}/subjects/${encodeURIComponent(id)}/persons`, {
    headers: authHeaders(token)
  })
  if (!res.ok) throw new Error(`获取制作人员失败 (HTTP ${res.status})`)
  const json = (await res.json()) as any
  const list: any[] = Array.isArray(json) ? json : (json?.data ?? [])
  return list.map((p: any) => ({
    id: p.id,
    nameCn: p.name_cn || '',
    // 优先中文名（name_cn），无则回退原名
    name: p.name_cn || p.name || '',
    relation: p.relation ?? '',
    image: firstImage(p.images)
  }))
}

/**
 * 取作品完整详情（点击角色卡「出演作品」打开的卡片用）：直接按 Bangumi 作品 id 联网拉取
 * subject + 角色 + 关联作品，匿名亦可访问。归一化为 SubjectFullDetail，供详情页共享组件渲染。
 */
export async function getSubjectFull(
  id: string,
  token?: string,
  opts: { withCn?: boolean } = {}
): Promise<SubjectFullDetail> {
  const withCn = opts.withCn ?? true
  // 三项数据互不依赖，并行拉取以缩短悬浮窗打开耗时（原实现先 await 作品详情、再并发角色+关联，
  // 多等一个 RTT）：
  // - getSubjectDetail：作品主信息（含评分分布）
  // - getSubjectCharacters：角色与 CV（withCn=false 时跳过中文名详情请求，首屏快开）
  // - getSubjectRelations：关联作品
  const [raw, characters, relations] = await Promise.all([
    getSubjectDetail(id, token),
    getSubjectCharacters(id, token, { withCn }),
    getSubjectRelations(id, token)
  ])
  // 剧集（正片）：失败不影响主卡片（悬浮窗是浏览态、详情页有本地占位剧集兜底）
  let episodes: SubjectFullEpisode[] = []
  try {
    episodes = await getEpisodes(id, token)
  } catch {
    episodes = []
  }
  console.log(`[getSubjectFull] subject=${id} 剧集数=${episodes.length}`)

  const { tags, meta, metaTags } = parseSubjectMeta(raw)
  // 书类(type=1)必须按 platform/tags 细分（小说/漫画），不能沿用 BGM_TYPE_TO_CATEGORY 的
  // 'manga' 兜底——否则 getSubjectFull 返回的 subject.category 恒为 'manga'，经 subject:detailFull
  // 的 importSubject 会把本地书籍（含已正确判定为小说的）反复写回 'manga'，造成「小说被分进漫画」
  // 反复出现。详情接口 raw 已含 platform 字段，可直接判定。
  const category: Category =
    raw.type === 1
      ? classifyBookCategory(raw, raw)
      : (BGM_TYPE_TO_CATEGORY[raw.type as number] ?? 'manga')
  const images = raw.images ?? {}
  const firstImg =
    images.medium ?? images.large ?? images.common ?? images.small ?? images.grid ?? ''
  const rating = raw.rating ?? {}
  const score = typeof rating.score === 'number' ? rating.score : undefined
  // v0 的 rating.count 是对象 {"1":n, ..., "10":n}（早年曾是数组）；统一归一化为长度 10 的数组，
  // 否则 SubjectMetaPanel 的评分分布图不会渲染（其 ratingCount 要求 Array.length===10）。
  let count: number[] | undefined
  if (rating.count && typeof rating.count === 'object' && !Array.isArray(rating.count)) {
    count = Array.from({ length: 10 }, (_, i) => Number((rating.count as any)[String(i + 1)]) || 0)
  } else if (Array.isArray(rating.count)) {
    count = rating.count.map((x: any) => Number(x) || 0)
  }
  const total = typeof rating.total === 'number' ? rating.total : undefined
  const rank = rating.rank != null ? '#' + String(rating.rank) : undefined

  const subject: SubjectFullDetail['subject'] = {
    id: Number(raw.id),
    provider: 'bangumi',
    providerSubjectId: String(raw.id),
    category,
    title: raw.name || '',
    title_cn: raw.name_cn || '',
    image_url: firstImg,
    summary: raw.summary || '',
    rating: score,
    ratingCount: count,
    ratingTotal: total,
    rank,
    tags,
    meta,
    metaTags,
    total_episodes: typeof raw.eps === 'number' ? raw.eps : raw.total_episodes ?? null,
    total_volumes: typeof raw.volumes === 'number' ? raw.volumes : raw.total_volumes ?? null,
    air_date: raw.air_date ?? null,
    series: typeof raw.series === 'boolean' ? raw.series : null,
    nsfw: !!raw.nsfw
  }

  return { kind: 'subject', subject, characters, relations, episodes }
}

// 轻小说 / 漫画 关键词（用于按 tag 计数判定书籍细分类别）
const LN_KEYWORDS = [
  '轻小说', 'ライトノベル', 'light novel', '小说', 'ラノベ', 'ln', 'web novel', 'ウェブ小説', 'ノベル', '小説'
]
const MANGA_KEYWORDS = [
  '漫画', 'マンガ', 'コミック', 'comic', '少年漫画', '少女漫画', '青年漫画',
  '少年マンガ', '少女マンガ', '青年マンガ'
]

/** 对一组 tag 按关键词命中计数（轻小说分 vs 漫画分，按 tag 人气 count 加权） */
function scoreBookTags(tags: SubjectTag[]): { ln: number; mg: number } {
  let ln = 0
  let mg = 0
  for (const t of tags) {
    const name = (t.name || '').toLowerCase()
    const count = (t as any).count || 1
    if (LN_KEYWORDS.some((k) => name.includes(k.toLowerCase()))) ln += count
    if (MANGA_KEYWORDS.some((k) => name.includes(k.toLowerCase()))) mg += count
  }
  return { ln, mg }
}

/**
 * 书籍细分归类（Bangumi type=1），返回本地分类：
 *  1) 优先用 API 的 platform 字段（实测对书类 100% 准确，最可靠）：'小说'→light_novel，'漫画'→manga；
 *  2) platform 缺失或为其它（如 '文学'、'画集'）时，按 tag 计数判定：
 *     轻小说关键词命中 count 之和 > 漫画关键词 → 轻小说，反之漫画；
 *  3) 完全无线索 → 保持原分类（不强行改动，避免误判）。
 * 备注：Bangumi v0 的 book_category 对真实书库基本恒为 null，已弃用，统一以 platform + tags 判定。
 */
export function classifyBookCategory(raw: any, detail?: any): Category {
  const src = detail ?? raw ?? {}
  const platform = src?.platform
  if (platform === '小说') return 'light_novel'
  if (platform === '漫画') return 'manga'
  const parsed = parseSubjectMeta(src)
  const { ln, mg } = scoreBookTags(parsed.tags)
  if (ln > mg) return 'light_novel'
  if (mg > ln) return 'manga'
  return (raw?.category as Category) || 'manga'
}

/**
 * 把 Bangumi 书籍(type1) 细分为「轻小说」或「漫画」，并顺带返回标签与制作信息。
 * 判定依据：classifyBookCategory（platform 字段优先，缺失时按 tag 计数）。
 * 收藏列表里的 subject 通常不含 platform，会再拉一次详情获取（preDetail 可避免重复抓取）。
 *
 * 返回的分类会被同步流程**强制写回**数据库（覆盖旧分类），以修正早期把所有
 * 书籍都归为「漫画」的历史数据；Bangumi 是权威来源。
 */
export async function analyzeBook(
  raw: any,
  token?: string,
  preDetail?: any
): Promise<BookAnalysis> {
  let detail = preDetail
  if (!detail) {
    try {
      detail = await getSubjectDetail(String(raw?.id), token)
    } catch (e) {
      console.warn('[bgm] 书籍细分详情获取失败，回退原分类：', e)
    }
  }
  const category = classifyBookCategory(raw, detail)
  const parsed = parseSubjectMeta(detail ?? raw ?? {})
  return { category, tags: parsed.tags, meta: parsed.meta }
}

/**
 * 取角色 / 人物详情（替代跳转 bgm 网页）。
 * - kind='characters' → 角色：/v0/characters/{id} + /v0/characters/{id}/subjects（出演作品）。
 *   【注意】Bangumi v0 没有 /characters/{id}/characters（关联角色）端点，关联角色由
 *   调用方（详情页同作品的其他角色）传入，不在此处聚合。
 * - kind='persons' → 人物：/v0/persons/{id} + /v0/persons/{id}/subjects（出演作品）
 *   + /v0/persons/{id}/characters（出演角色）。
 * 这些端点匿名亦可访问，故 token 可选（带令牌仅提高限流配额）。
 * 返回归一化的 EntityDetail，供渲染端 EntityCard 直接渲染。
 */
export async function getEntityDetail(
  kind: 'characters' | 'persons',
  id: number,
  token?: string
): Promise<EntityDetail> {
  const base = `${API_BASE}/${kind}/${encodeURIComponent(id)}`
  const [detailRes, worksRes, charsRes] = await Promise.all([
    fetch(base, { headers: authHeaders(token) }),
    fetch(`${base}/subjects`, { headers: authHeaders(token) }),
    kind === 'persons'
      ? fetch(`${base}/characters`, { headers: authHeaders(token) })
      : Promise.resolve(null)
  ])
  if (!detailRes.ok) {
    throw new Error(`获取${kind === 'characters' ? '角色' : '人物'}详情失败 (HTTP ${detailRes.status})`)
  }
  const d = (await detailRes.json()) as any
  const worksJson = worksRes.ok ? await worksRes.json() : []
  const worksList: any[] = Array.isArray(worksJson) ? worksJson : (worksJson?.data ?? [])
  const charsJson = charsRes && charsRes.ok ? await charsRes.json() : []
  const charsList: any[] = Array.isArray(charsJson) ? charsJson : (charsJson?.data ?? [])

  const infobox: { key: string; value: string }[] = (d.infobox ?? []).map((it: any) => ({
    key: String(it?.key ?? ''),
    value: flattenInfoboxValue(it?.value)
  }))

  const mapWork = (x: any): EntityWorkItem => ({
    id: x.id,
    name: x.name || '',
    nameCn: x.name_cn || '',
    // /characters|persons/{id}/subjects 返回的是平铺的 `image`(字符串)，
    // 而 /persons/{id}/characters 返回的是 `images`(对象)——两种都兼容
    image: x.image || firstImage(x.images) || '',
    // 出演作品的角色字段叫 staff（主角/配角/客串…），关联角色才叫 relation
    relation: x.relation || x.staff || ''
  })

  // 人物卡「出演角色」：/persons/{id}/characters 每个元素是一条
  // 「角色 X 在作品 S 中由该人物配音」记录，同一角色可能跨多部作品（多条记录）。
  // 按角色 id 聚合，把每部作品挂到该角色的 works 上，供角色小栏右侧展示。
  const mapPersonCharacters = (list: any[]): EntityWorkItem[] => {
    const byChar = new Map<number, any[]>()
    for (const x of list) {
      const cid = x.id as number
      if (!byChar.has(cid)) byChar.set(cid, [])
      byChar.get(cid)!.push(x)
    }
    const out: EntityWorkItem[] = []
    for (const entries of byChar.values()) {
      const first = entries[0]
      const works: EntityWorkItem[] = entries.map((e) => ({
        id: e.subject_id,
        name: e.subject_name || '',
        nameCn: e.subject_name_cn || '',
        image: '',
        relation: e.staff || ''
      }))
      out.push({
        id: first.id,
        name: first.name || '',
        nameCn: first.name_cn || '',
        image: firstImage(first.images),
        relation: first.staff || '',
        works
      })
    }
    return out
  }

  // 参与作品合并职务：Bangumi /persons/{id}/subjects 会因同一人以多种 staff 身份参与同一作品
  // （如既原作又脚本）而重复返回同一 subject（每次一个 relation）。按 subject id 分组，
  // 把多个职务收集进 relations[]，渲染层用「 / 」连接展示；既消除重复条目，又不丢任何职务。
  const worksMapped = mergePersonWorks(worksList.map(mapWork))

  // 出演角色（按角色聚合，见 mapPersonCharacters）。
  const charactersMapped =
    kind === 'persons' ? mapPersonCharacters(charsList) : []

  // 按作品播出日期排序（参与作品 / 出演角色），使「顺序=旧→新、倒序=新→旧」。
  // 日期来自本地 Archive 库（arc_subjects.date）；无日期的作品排到末尾（保持原相对顺序）。
  // Bangumi 的人物作品端点本身不是时间序（实测高松信司返回为乱序），故必须按日期重排。
  const allSubjectIds = [
    ...worksMapped.map((w) => w.id),
    ...charsList.map((x) => x.subject_id as number)
  ]
  const dateMap = await getArchiveSubjectDates(allSubjectIds)
  // 缺日期用哨兵 '9999-99-99' → 排到最末；有日期按 YYYY-MM-DD 字符串比较即可（字典序=时间序）。
  const dateOf = (id?: number): string =>
    id != null && dateMap.has(id) ? dateMap.get(id)! : '9999-99-99'
  // 真实日期（缺失返回 undefined），用于回填到条目上、供渲染层判断「是否缺日期」。
  const realDate = (id?: number): string | undefined =>
    id != null && dateMap.has(id) ? dateMap.get(id)! : undefined
  const stableByDateAsc = <T extends { id?: number }>(arr: T[]): T[] =>
    [...arr].sort((a, b) => {
      const da = dateOf(a.id)
      const db = dateOf(b.id)
      return da < db ? -1 : da > db ? 1 : 0
    })
  const worksSorted = stableByDateAsc(worksMapped).map((w) => ({ ...w, date: realDate(w.id) }))
  // 出演角色：整体按「最晚出演作品日期」升序兜底（渲染层会按方向用 min/max 重排，见 EntityCard）。角色内作品按日期升序。
  const maxDateOf = (works?: { id?: number }[]): string => {
    if (!works || !works.length) return '0000-00-00'
    let mx = '0000-00-00'
    for (const w of works) {
      const d = dateOf(w.id)
      if (d > mx) mx = d
    }
    return mx
  }
  const charactersSorted = [...charactersMapped].sort((a, b) => {
    const da = maxDateOf(a.works)
    const db = maxDateOf(b.works)
    return da < db ? -1 : da > db ? 1 : 0
  })
  for (const c of charactersSorted) {
    if (c.works && c.works.length > 1) c.works = stableByDateAsc(c.works)
    if (c.works) for (const w of c.works) (w as EntityWorkItem).date = realDate(w.id)
  }

  // 参与作品按 subject id 合并：同一 subject 出现多次（多重 staff 身份）时，把各次的 relation
  // 收集进 relations[]（去重、保首次出现顺序）；首条保持 relation 单值（= relations[0]）供回退。
  function mergePersonWorks(list: EntityWorkItem[]): EntityWorkItem[] {
    const byId = new Map<number, EntityWorkItem>()
    for (const w of list) {
      if (w.id == null) continue
      const existing = byId.get(w.id)
      if (!existing) {
        const relations = w.relation ? [w.relation] : []
        byId.set(w.id, { ...w, relations })
        continue
      }
      if (w.relation && !existing.relations!.includes(w.relation)) {
        existing.relations!.push(w.relation)
      }
    }
    return [...byId.values()]
  }

  return {
    kind: kind === 'characters' ? 'character' : 'person',
    id,
    // 顶部标题用「原名」（Bangumi 规范：原名在标题、中文名在 infobox），避免与简体中文名重复
    name: d.name || cnNameFromInfobox(d.infobox) || '',
    image: d.images?.large || d.images?.medium || d.images?.common || d.images?.small || d.images?.grid || '',
    infobox,
    summary: d.summary || '',
    // 参与作品：已按播出日期升序（旧→新）重排；渲染层 顺序=原序、倒序=反转。
    works: worksSorted,
    // 出演角色：按角色聚合 + 按「最晚出演作品日期」升序重排；角色内作品也已按日期升序。
    characters: kind === 'persons' ? charactersSorted : undefined,
    // 职业/类型仅人物有；角色实体无 career/type，留空。
    // career 英文代码（seiyu/artist/producer/...）供渲染端映射中文标签；含 seiyu 时人物卡隐藏「参与作品」。
    career: kind === 'persons' ? (Array.isArray(d.career) ? d.career : []) : undefined,
    type: kind === 'persons' ? d.type : undefined
  }
}
