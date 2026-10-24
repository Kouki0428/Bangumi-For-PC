import { getDb } from '../services/db/connection'
import { getSetting, setSetting } from '../services/db/repositories/settings.repository'
import { getUserStats } from '../services/db/repositories/collections.repository'
import { getCollectionExistingBySubject } from '../services/db/repositories/collections.repository'
import { searchVndb, VNDB_UA } from '../services/api/vndb'
import { getSetting as getSettingRaw } from '../services/db/repositories/settings.repository'

const CJK_NUM: Record<string, number> = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 }
/** 中文数字（−十）转阿拉伯数字，无法识别返回 null */
function cjkNum(s: string): number | null {
  if (/^\d+$/.test(s)) return parseInt(s, 10)
  if (CJK_NUM[s]) return CJK_NUM[s]
  if (s.includes('十')) {
    const [a, b] = s.split('十')
    const ten = (a ? CJK_NUM[a] || parseInt(a, 10) || 1 : 1) * 10
    return ten + (b ? CJK_NUM[b] || parseInt(b, 10) || 0 : 0)
  }
  return null
}
const ROMAN: Record<string, number> = { 'II': 2, 'III': 3, 'IV': 4, 'V': 5, 'VI': 6, 'VII': 7 }
/** 从标题中提取季数（"Season 3" / "3rd Season" / "第3期" / "第三季" / "III"），无则 null */
function seasonOf(s: unknown): number | null {
  const text = String(s || '')
  let m = text.match(/season\s*(\d+)/i)
  if (m) return parseInt(m[1], 10)
  m = text.match(/(\d+)(?:st|nd|rd|th)?\s*season/i)
  if (m) return parseInt(m[1], 10)
  m = text.match(/第\s*([0-9一二三四五六七八九十]+)\s*[期季]/)
  if (m) return cjkNum(m[1])
  m = text.match(/\b(III|II|IV|V|VI|VII)\b/)
  if (m && ROMAN[m[1]]) return ROMAN[m[1]]
  return null
}

/**
 * Kitsu 内部搜索（无鉴权 anime/manga 库，作为 MAL/AniList 不可用时的回退源）。
 * siteLabel：回退时结果标出的站点（如 'mal'/'anilist'），使各任务卡片独立显示。
 */
async function kitsuSearch(
  keywords: unknown[],
  type: unknown,
  siteLabel = 'kitsu'
): Promise<{ ok: boolean; items?: any[]; error?: string }> {
  if (!Array.isArray(keywords) || !keywords.length) return { ok: false, error: 'invalid-arg' }
  const t = type === 'manga' ? 'manga' : 'anime'
  const headers = {
    Accept: 'application/vnd.api+json, application/json',
    'User-Agent': VNDB_UA
  }
  let lastError = ''
  for (const kw of keywords) {
    if (typeof kw !== 'string' || !kw.trim()) continue
    const key = kw.trim()
    const url = `https://kitsu.io/api/edge/${t}?filter[text]=${encodeURIComponent(key)}&page[limit]=5`
    for (let i = 0; i < 3; i++) {
      try {
        const res = await fetch(url, { headers })
        console.log('[pluginApi] Kitsu HTTP', res.status, 'for:', key, t, `attempt ${i + 1}`)
        if (res.status === 429) {
          lastError = '请求过于频繁'
          await new Promise(r => setTimeout(r, 2000))
          continue
        }
        if (!res.ok) {
          lastError = `Kitsu 检索失败 (HTTP ${res.status})`
          break
        }
        const json = (await res.json()) as { data?: any[] }
        const items = (json.data ?? []).map((d) => {
          const a = d.attributes ?? {}
          const slug = a.slug || String(d.id)
          const score = typeof a.averageRating === 'string' && a.averageRating
            ? Math.round(parseFloat(a.averageRating)) / 10
            : null
          return {
            site: siteLabel,
            id: d.id ?? null,
            title: a.canonicalTitle || a.titles?.en || '',
            titleAlt: a.titles?.ja_jp || a.titles?.en_jp || null,
            cover: a.posterImage?.original ?? a.posterImage?.medium ?? null,
            date: a.startDate ?? null,
            rating: score,
            ratingCount: typeof a.userCount === 'number' ? a.userCount : null,
            url: `https://kitsu.io/${t}/${slug}`
          }
        })
        if (items.length) {
          // 季数感知排序：搜索词含季数时，季数一致的条目置顶（避免"搜第三季显示第二季"）
          const qs = seasonOf(key)
          if (qs) {
            items.sort((a: any, b: any) => {
              const as = seasonOf((a.titleAlt || '') + ' ' + (a.title || ''))
              const bs = seasonOf((b.titleAlt || '') + ' ' + (b.title || ''))
              const sc = (x: number | null) => (x === qs ? 2 : x == null ? 1 : 0)
              return sc(bs as any) - sc(as as any)
            })
          }
          const top = items.slice(0, 3)
          // 通过 Kitsu mappings 查该作品在 MAL/AniList 的真实 ID，使回退卡片能跳转到对应站点
          if (siteLabel === 'mal' || siteLabel === 'anilist') {
            await Promise.all(top.map(async (it: any) => {
              try {
                const mres = await fetch(`https://kitsu.io/api/edge/${t}/${it.id}/mappings`, { headers })
                if (!mres.ok) return
                const mj = (await mres.json()) as { data?: any[] }
                let malId: string | null = null
                let anilistId: string | null = null
                for (const d of mj.data ?? []) {
                  const es = d.attributes?.externalSite
                  const eid = d.attributes?.externalId
                  if (es === `myanimelist/${t}`) malId = eid
                  else if (es === `anilist/${t}`) anilistId = eid
                }
                if (siteLabel === 'mal' && malId) it.url = `https://myanimelist.net/${t}/${malId}`
                else if (siteLabel === 'anilist' && anilistId) it.url = `https://anilist.co/${t}/${anilistId}`
              } catch {
                // mappings 失败时保留默认 url（Kitsu 页）
              }
            }))
          }
          return { ok: true, items: top }
        }
        break // 该关键词 0 条，尝试下一关键词
      } catch (e) {
        console.warn('[pluginApi] Kitsu fetch failed, retrying:', (e as Error).message, `attempt ${i + 1}`)
        lastError = 'Kitsu 网络不可用'
        if (i === 2) break
        await new Promise(r => setTimeout(r, 1000))
      }
    }
  }
  if (lastError) return { ok: false, error: lastError }
  return { ok: true, items: [] }
}

/**
 * 插件白名单 API：方法名经过硬编码注册表，未注册的一律拒绝。
 * 每个方法在调用前已由插件 IPC 层按「权限」校验过（见 plugin.ipc.ts methodToPermission）。
 * 返回值约定统一为 { ok: true, data } / { ok: false, error }。
 */
export async function callPluginApi(method: string, args: unknown[], pluginId: string): Promise<unknown> {
  const registry: Record<string, (args: unknown[], pid: string) => Promise<unknown>> = {
    // —— 插件独立存储（key 带插件前缀，互相隔离）——
    async 'storage.get'([key]) {
      if (typeof key !== 'string') return err('invalid-arg')
      const db = await getDb()
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(`plugin:${pluginId}:${key}`) as
        | { value: string }
        | undefined
      return ok(row?.value ?? null)
    },
    async 'storage.set'([key, value]) {
      if (typeof key !== 'string' || typeof value !== 'string') return err('invalid-arg')
      const db = await getDb()
      db.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(`plugin:${pluginId}:${key}`, value)
      return ok(true)
    },
    // —— 设置（读取/修改应用设置）——
    async 'settings.get'([key]) {
      if (typeof key !== 'string') return err('invalid-arg')
      return ok(await getSetting(key))
    },
    async 'settings.set'([key, value]) {
      if (typeof key !== 'string' || typeof value !== 'string') return err('invalid-arg')
      await setSetting(key, value)
      return ok(true)
    },
    // —— 收藏数据（只读聚合 + 单作品收藏状态）——
    async 'collection.getAll'() {
      return ok(await getUserStats())
    },
    async 'collection.getExisting'([pid]) {
      if (typeof pid !== 'string') return err('invalid-arg')
      return ok(await getCollectionExistingBySubject(pid))
    },
    // —— 网络代理：跨站搜索条目（主进程执行，渲染端沙箱无网络能力）——
    // VNDB：复用项目已有 Kana API（带可选 token）
    async 'network.searchVndb'([keyword]) {
      if (typeof keyword !== 'string' || !keyword) return err('invalid-arg')
      const vndbToken = (await getSettingRaw('vndb_token')) ?? undefined
      const results = await searchVndb(keyword, vndbToken)
      // 归一化为统一的卡片数据结构
      return ok(results.map((r: any) => ({
        site: 'vndb',
        id: r.id ?? null,
        title: r.title ?? '',
        titleAlt: r.alttitle ?? null,
        cover: r.image?.url ?? null,
        date: r.released ?? null,
        rating: typeof r.rating === 'number' ? r.rating : null,
        ratingCount: typeof r.votecount === 'number' ? r.votecount : null,
        url: r.id ? `https://vndb.org/${r.id}` : `https://vndb.org/v?sq=${encodeURIComponent(keyword)}`
      })))
    },
    // Kitsu：无鉴权的 anime/manga 数据库，作为 MAL/AniList 的替代搜索源
    // （Jikan 连不上 MAL、AniList 官方禁用时仍可用；日文标题可直接命中）
    async 'network.searchKitsu'([keywords, type]) {
      const r = await kitsuSearch(keywords, type)
      if (!r.ok) return err(r.error || 'Kitsu 搜索失败')
      return ok(r.items ?? [])
    },
    // MyAnimeList：用官方 jikan API（v4，无需鉴权）搜索动画/漫画。
    // keywords 为依次尝试的标题候选（如 原始日文名 → 中文显示名），命中即返回；
    // Jikan 对无缓存的冷门查询会实时抓取 MAL，遇 MAL 拒绝/不稳定会返回 504
    // （"Jikan failed to connect to MyAnimeList"），此时返回真实错误而非空数组。
    async 'network.searchMal'([keywords, type]) {
      if (!Array.isArray(keywords) || !keywords.length) return err('invalid-arg')
      const t = type === 'manga' ? 'manga' : 'anime'
      let lastStatus = 0
      let lastError = ''
      for (const kw of keywords) {
        if (typeof kw !== 'string' || !kw.trim()) continue
        const key = kw.trim()
        const url = `https://api.jikan.moe/v4/${t}?q=${encodeURIComponent(key)}&limit=5&sfw=true`
        for (let i = 0; i < 3; i++) {
          try {
            const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': VNDB_UA } })
            console.log('[pluginApi] MAL HTTP', res.status, 'for:', key, t, `attempt ${i + 1}`)
            if (res.status === 429) {
              lastStatus = 429
              lastError = '请求过于频繁'
              await new Promise(r => setTimeout(r, 1500))
              continue
            }
            if (res.status === 504) {
              // Jikan 服务端无法连接 MAL（冷门查询需实时抓取），换下一个关键词
              lastStatus = 504
              lastError = 'Jikan 无法连接 MyAnimeList（服务端问题）'
              console.warn('[pluginApi] MAL 504 (Jikan failed to connect to MAL) for:', key)
              break
            }
            if (!res.ok) return err(`MAL 检索失败 (HTTP ${res.status})`)
            const json = (await res.json()) as { data?: any[] }
            const items = (json.data ?? []).map((d) => ({
              site: 'mal',
              id: d.mal_id ?? null,
              title: d.title_english ?? d.title ?? '',
              titleAlt: d.title_japanese ?? null,
              cover: d.images?.webp?.image_url ?? d.images?.jpg?.image_url ?? null,
              date: d.aired?.from ?? d.published?.from ?? d.year ?? null,
              rating: typeof d.score === 'number' && d.score > 0 ? d.score : null,
              ratingCount: typeof d.scored_by === 'number' ? d.scored_by : null,
              url: d.url ?? `https://myanimelist.net/${t}.php?q=${encodeURIComponent(key)}`
            }))
            if (items.length) return ok(items)
            break // 该关键词 0 条，尝试下一关键词
          } catch (e) {
            console.warn('[pluginApi] MAL fetch failed, retrying:', (e as Error).message, `attempt ${i + 1}`)
            lastError = 'MAL 网络不可用'
            if (i === 2) break
            await new Promise(r => setTimeout(r, 1000))
          }
        }
      }
      if (lastStatus === 504 || lastStatus === 429) {
        // Jikan 服务端连不上 MAL / 限流：回退 Kitsu 出结果（site 标 mal，卡片独立显示）
        const fb = await kitsuSearch(keywords, t, 'mal')
        if (fb.ok && fb.items && fb.items.length) return ok(fb.items)
        if (lastStatus === 504) return err('MAL 服务暂时不可用（Jikan 无法连接 MyAnimeList）')
        return err('MAL 请求过于频繁，请稍后重试')
      }
      if (lastError) return err(lastError)
      return ok([])
    },
    // AniList：用 GraphQL 搜索动画/漫画（无需鉴权）。keywords 为标题候选，依次尝试。
    async 'network.searchAnilist'([keywords, type]) {
      if (!Array.isArray(keywords) || !keywords.length) return err('invalid-arg')
      const t = type === 'manga' ? 'MANGA' : 'ANIME'
      const query =
        'query ($s: String, $t: MediaType) { ' +
        'Page(perPage: 5) { ' +
        'media(search: $s, type: $t) { ' +
        'id title { romaji english native } ' +
        'coverImage { large } averageScore meanScore popularity ' +
        'startDate { year month day } siteUrl ' +
        '}' +
        '}' +
        '}'
      let lastStatus = 0
      let lastError = ''
      for (const kw of keywords) {
        if (typeof kw !== 'string' || !kw.trim()) continue
        const key = kw.trim()
        const gql = { query, variables: { s: key, t } }
        for (let i = 0; i < 3; i++) {
          try {
            const res = await fetch('https://graphql.anilist.co', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'User-Agent': 'BangumiForPC/2.0'
              },
              body: JSON.stringify(gql)
            })
            console.log('[pluginApi] AniList HTTP', res.status, 'for:', key, t, `attempt ${i + 1}`)
            // 429 限流时等待后重试
            if (res.status === 429) {
              lastStatus = 429
              lastError = '请求过于频繁'
              console.warn('[pluginApi] AniList rate limited, waiting before retry')
              await new Promise(r => setTimeout(r, 3000))
              continue
            }
            if (!res.ok) {
              const text = await res.text().catch(() => '')
              console.log('[pluginApi] AniList error body:', text.slice(0, 200))
              if (res.status === 403) {
                // 官方禁用（"The AniList API has been temporarily disabled..."），无法修复
                lastStatus = 403
                lastError = 'AniList 官方临时禁用（HTTP 403）'
                break
              }
              return err(`AniList 检索失败 (HTTP ${res.status})`)
            }
            const json = (await res.json()) as { data?: { Page?: { media?: any[] } } }
            const items = (json.data?.Page?.media ?? []).map((m) => {
              const sd = m.startDate ?? {}
              const date = sd.year ? `${sd.year}${sd.month ? '-' + String(sd.month).padStart(2, '0') : ''}${sd.day ? '-' + String(sd.day).padStart(2, '0') : ''}` : null
              return {
                site: 'anilist',
                id: m.id ?? null,
                title: m.title?.english ?? m.title?.romaji ?? '',
                titleAlt: m.title?.native ?? null,
                cover: m.coverImage?.large ?? null,
                date,
                rating: typeof m.averageScore === 'number' ? Math.round(m.averageScore) / 10 : null,
                ratingCount: typeof m.popularity === 'number' ? m.popularity : null,
                url: m.siteUrl ?? `https://anilist.co/search/${type === 'manga' ? 'manga' : 'anime'}?search=${encodeURIComponent(key)}`
              }
            })
            if (items.length) return ok(items)
            break // 该关键词 0 条，尝试下一关键词
          } catch (e) {
            console.warn('[pluginApi] AniList fetch failed, retrying:', (e as Error).message, `attempt ${i + 1}`)
            lastError = 'AniList 网络不可用'
            if (i === 2) break
            await new Promise(r => setTimeout(r, 1000))
          }
        }
      }
      if (lastStatus === 403) {
        // AniList 官方禁用：回退 Kitsu 出结果（site 标 anilist，卡片独立显示）
        const fb = await kitsuSearch(keywords, t, 'anilist')
        if (fb.ok && fb.items && fb.items.length) return ok(fb.items)
        return err('AniList 官方临时禁用（HTTP 403），请稍后再试')
      }
      if (lastStatus === 429) return err('AniList 请求过于频繁，请稍后重试')
      if (lastError) return err(lastError)
      return ok([])
    }
  }

  const fn = registry[method]
  if (!fn) return err('unknown-method')
  try {
    return await fn(args, pluginId)
  } catch (e) {
    return err(String(e))
  }
}

function ok(data: unknown) {
  return { ok: true as const, data }
}
function err(error: string) {
  return { ok: false as const, error }
}