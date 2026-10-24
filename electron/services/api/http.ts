import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { Readable } from 'node:stream'
import { createConnection } from 'node:net'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { execSync } from 'node:child_process'
import { app } from 'electron'

/**
 * 让主进程（Electron main / Node）的网络请求与浏览器行为对齐：
 * - 自动发现代理：先读 HTTP(S)_PROXY 环境变量；若在 Windows 上未设置则读取系统代理
 *   （注册表 Internet Settings），使 Clash/系统代理等场景无需手动配置。浏览器默认走
 *   系统/环境代理，而 Node 默认不走，这正是此前"浏览器能开授权页、主进程 fetch 失败"
 *   的根因。
 * - 可选 TLS 放行：设 BGM_INSECURE_TLS=1 时，对做 TLS 拦截的代理放宽证书校验。
 * - 不依赖 undici：undici v6/v8 在 Electron 30 内置的 Node 20 上因
 *   `webidl.util.markAsUncloneable` 缺失而「加载即崩」，故改用 Node 内置 https/http +
 *   https-proxy-agent（纯 JS、兼容 Node 18+）。
 * - 导出 safeFetch：兼容调用方使用的 { ok, status, json() } 子集，并在失败时暴露底层
 *   错误码（ENOTFOUND / ECONNREFUSED / UNABLE_TO_VERIFY_LEAF_SIGNATURE 等）。
 *
 * 本模块以「副作用」方式工作：在 main.ts 顶部 import 一次（必须在任何请求之前）。
 */

/** 读取 Windows 系统代理（注册表）。无代理、PAC 或读取失败则返回空串。
 *  同时探测 HKCU 与 HKLM 两处：Clash/v2ray 的「系统代理」通常写 HKCU，
 *  而部分 VPN / 组策略场景写在 HKLM；两处都查更稳。 */
function readWindowsSystemProxy(): string {
  if (process.platform !== 'win32') return ''
  const bases = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
  ]
  for (const base of bases) {
    try {
      const enableOut = execSync(`reg query "${base}" /v ProxyEnable`, {
        windowsHide: true,
        timeout: 2000
      }).toString()
      if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(enableOut)) continue

      const serverOut = execSync(`reg query "${base}" /v ProxyServer`, {
        windowsHide: true,
        timeout: 2000
      }).toString()
      const m = serverOut.match(/ProxyServer\s+REG_SZ\s+(.+)/i)
      if (!m) continue
      let server = m[1].trim()
      if (!server) continue

      // PAC 脚本（自动配置）无法作为直连代理使用，跳过
      if (/pac\b/i.test(server) || /\.pac($|\s)/i.test(server)) continue

      // 形如 http=127.0.0.1:7890;https=127.0.0.1:7890 时，优先取 https，其次 http
      if (/^(https?|socks[45]?)=/i.test(server)) {
        const https = server.match(/https=([^;]+)/i)
        const http = server.match(/http=([^;]+)/i)
        const socks = server.match(/socks[45]?=([^;]+)/i)
        server = (https || http || socks)?.[1]?.trim() || server
      }

      // 统一成 URL：Clash 等常以 host:port 形式给出
      if (!/^[a-z]+:\/\//i.test(server)) server = 'http://' + server
      return server
    } catch {
      // 该处读取失败，尝试下一处
    }
  }
  return ''
}

function resolveProxy(): string {
  const fromEnv =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    ''
  if (fromEnv) return fromEnv
  return readWindowsSystemProxy()
}

const proxy = resolveProxy()
const insecure = process.env.BGM_INSECURE_TLS === '1'
let agent: HttpsProxyAgent<string> | undefined
if (proxy) {
  try {
    // 第二个参数为 https.Agent 选项；rejectUnauthorized=false 用于放行做了 TLS 拦截的代理
    agent = new HttpsProxyAgent(proxy, (insecure ? { rejectUnauthorized: false } : {}) as never)
  } catch (e) {
    console.error('[http] 代理初始化失败，退回直连：', e)
    agent = undefined
  }
}

/**
 * 手动代理（设置项 `proxy`，最高优先级，覆盖下面的自动探测）：
 * - 支持 http(s)://（走 HttpsProxyAgent）与 socks[45]://（走 SocksProxyAgent），让用户显式指定
 *   自己的 Clash / v2ray 等代理地址。
 * - 为什么需要它：自动探测（系统/环境代理 + 本机常见端口）常漏掉「TUN 模式」「关掉系统代理的
 *   Clash」「非标准端口」等场景，导致主进程只能直连 api.bgm.tv —— 而该域名在部分网络下直连超时，
 *   表现为「浏览器能开授权页、主进程同步超时 / 失败 1 部」。手动代理即兜底此场景。
 * - 与自动探测不同，手动代理可在设置页保存后即时生效（经 IPC `app:setProxy` 调用 setManualProxy），
 *   无需重启。
 */
type AnyProxyAgent = HttpsProxyAgent<string> | SocksProxyAgent
let manualProxyUrl: string | null = null
let manualAgent: AnyProxyAgent | undefined = undefined
let manualProxyLoaded = false
let strategyCache: { agent: AnyProxyAgent | undefined; label: string }[] | null = null

function buildProxyAgent(raw: string): AnyProxyAgent | undefined {
  const url = raw.trim()
  if (!url) return undefined
  const opts = (insecure ? { rejectUnauthorized: false } : {}) as never
  try {
    if (/^socks[45]?:\/\//i.test(url)) return new SocksProxyAgent(url, opts)
    return new HttpsProxyAgent(url, opts)
  } catch (e) {
    console.error('[http] 手动代理初始化失败，跳过：', url, e)
    return undefined
  }
}

/** 运行时设置 / 清除手动代理（设置页保存后由 IPC 调用，免重启生效）。 */
export function setManualProxy(url: string | null): void {
  manualProxyUrl = url ? url.trim() : null
  manualProxyLoaded = true
  manualAgent = manualProxyUrl ? buildProxyAgent(manualProxyUrl) : undefined
  strategyCache = null // 失效，下次请求重建策略
}

/** 启动期异步读取设置项中的手动代理（best-effort，失败静默忽略）。 */
async function loadManualProxy(): Promise<void> {
  try {
    const { getSetting } = await import('../db/repositories/settings.repository')
    const u = await getSetting('proxy')
    setManualProxy(u)
  } catch {
    manualProxyLoaded = true
  }
}
void loadManualProxy()

/**
 * 兜底代理探测：部分用户使用 Clash / v2rayN 等，但并未在系统代理注册表写入
 * （如 TUN 模式、或忘了开启「系统代理」），导致 readWindowsSystemProxy 读不到，
 * 主进程只能直连——而直连在某些网络下会被墙/不通，表现为「浏览器能开授权页、
 * 主进程 fetch 超时」。这里并行探测本机常见代理端口，命中即用，作为回退路径。
 */
const COMMON_PROXY_PORTS = [
  7890, 7891, 7892, 7893, 7897, // Clash / Clash Verge 常见（含用户确认的实际端口 7897，即 Clash Verge mixed-port 默认）
  1080, 10808, 10809, // SOCKS5 常见
  8080, 8081, 8082, // 通用 HTTP 代理
  8787, 8888, 8899, // 其他常见
  8118, // Privoxy
  12759, 15732 // v2rayN 部分默认
]
function probeProxies(): Promise<string[]> {
  return Promise.all(
    COMMON_PROXY_PORTS.map(
      (port) =>
        new Promise<string | null>((resolve) => {
          const sock = createConnection({ host: '127.0.0.1', port, timeout: 800 })
          let settled = false
          const done = (v: string | null) => {
            if (settled) return
            settled = true
            sock.destroy()
            resolve(v)
          }
          sock.once('connect', () => done(`http://127.0.0.1:${port}`))
          sock.once('error', () => done(null))
          sock.once('timeout', () => done(null))
        })
    )
  ).then((arr) => arr.filter((x): x is string => x !== null))
}

let candidateAgents: HttpsProxyAgent<string>[] = []
probeProxies()
  .then((proxies) => {
    candidateAgents = proxies
      .map((p) => {
        try {
          return new HttpsProxyAgent(p, (insecure ? { rejectUnauthorized: false } : {}) as never)
        } catch {
          return undefined
        }
      })
      .filter((a): a is HttpsProxyAgent<string> => !!a)
    if (proxies.length) {
      console.log('[http] 探测到本机候选代理：', proxies.join(', '))
    }
    // 探针完成后再重建一次策略，确保首请求若在探针结束前发生也能用上候选代理
    strategyCache = null
  })
  .catch(() => {
    strategyCache = null
  })

console.log(
  `[http] 网络模块已加载（请求策略在首次请求时按「手动代理 > 系统/环境代理 > 本机候选代理 > 直连」确定）` +
    `${insecure ? ' [TLS放行=开]' : ''}`
)

/**
 * 关键副作用：覆盖主进程全局 fetch，使所有直接调用 `fetch()` 的代码
 * （bangumi 适配层 searchBangumi / getMyCollections / updateCollection，以及同步引擎
 * syncEngine）也自动走上面的代理 / TLS 配置。否则这些请求会走 Node 原生 fetch
 * （默认不读代理），导致「能登录（oauth 显式用 safeFetch）却搜不出 / 同步不了
 * （全局 fetch 不带代理）」。safeFetch 已实现 { ok, status, json(), text() } 子集，
 * 与调用方用法完全兼容。
 */
;(globalThis as unknown as { fetch: typeof safeFetch }).fetch = safeFetch

/** 调用方使用的 fetch Response 子集。
 *  headers 提供 .get（与原生 fetch 对齐）；body 为可流式读取的 web ReadableStream，
 *  使 downloadDump 的 getReader 与 cg.ts 的 body.cancel 都能工作（无需把整响应缓冲进内存）。
 */
export interface MinimalResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  body?: ReadableStream<Uint8Array>
  json: () => Promise<unknown>
  text: () => Promise<string>
}

type FetchInit = {
  method?: string
  headers?: Record<string, string> | [string, string][] | { [k: string]: string } | undefined
  body?: string | URLSearchParams | null | undefined
  /** AbortSignal：取消在途请求（搜索被新请求取代时掐掉旧分页拉取，省配额） */
  signal?: AbortSignal | null | undefined
}

const MAX_REDIRECTS = 10
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
// 单次请求总超时：避免代理 CONNECT / DNS 卡死导致详情页永久转圈（表现为「点不进去 / 加载不出」）
const REQUEST_TIMEOUT_MS = 20000

/** 把 Node 原生响应头转为带 .get 的对象，与原生 fetch / 浏览器对齐。 */
function adaptHeaders(raw: Record<string, string | string[] | undefined>) {
  const lower: Record<string, string | string[] | undefined> = {}
  for (const k of Object.keys(raw)) lower[k.toLowerCase()] = raw[k]
  return {
    get(name: string): string | null {
      const v = lower[name.toLowerCase()]
      if (v == null) return null
      return Array.isArray(v) ? v[0] : v
    }
  }
}

/** 跨主机重定向时去掉 Authorization，避免凭据泄漏到其他主机。 */
function stripAuth(h: FetchInit['headers']): FetchInit['headers'] {
  if (!h) return h
  if (Array.isArray(h)) return h.filter(([k]) => !/^authorization$/i.test(k)) as [string, string][]
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(h)) if (v != null && !/^authorization$/i.test(k)) out[k] = String(v)
  return out
}

function buildHeaders(init?: FetchInit): Record<string, string> {
  const headers: Record<string, string> = {}
  const h = init?.headers
  if (h) {
    if (Array.isArray(h)) {
      for (const [k, v] of h) headers[k.toLowerCase()] = v
    } else {
      for (const [k, v] of Object.entries(h)) if (v != null) headers[k.toLowerCase()] = String(v)
    }
  }
  return headers
}

/** 应用级 User-Agent：便于 Bangumi 识别客户端（部分官方/私有接口要求或建议携带）。
 *  采用 `Name/Version (+url)` 约定，其中 url 为联系/主页链接（可带链接）。 */
let cachedUserAgent: string | null = null
function userAgent(): string {
  if (cachedUserAgent) return cachedUserAgent
  let v = '0.0.0'
  try {
    v = app.getVersion()
  } catch {
    /* app 未就绪时退回占位版本 */
  }
  cachedUserAgent = `Bangumi-For-PC/${v} (+https://github.com/Kouki0428/Bangumi-For-PC)`
  return cachedUserAgent
}

/**
 * 带可读错误的最小 fetch 封装：基于 Node https/http + https-proxy-agent。
 * - 自动跟随重定向（Node 原生 https 不跟随 302，而 GitHub release 下载地址会 302 到 CDN）。
 * - 返回 web ReadableStream 作为 body，支持流式下载 409MB dump 而不爆内存；
 *   json()/text() 按需读取该流（调用方不会在同一次响应上既读 body 又读 json）。
 * 网络层异常（DNS/连接/TLS）时把底层 cause 的错误码拼进 message，并主进程终端打印，
 * 便于定位（ENOTFOUND、ECONNREFUSED、UNABLE_TO_VERIFY_LEAF_SIGNATURE 等）。
 */
async function doRequest(
  url: string,
  init: FetchInit,
  redirectsLeft: number,
  options?: { agent?: AnyProxyAgent | undefined; timeoutMs?: number }
): Promise<MinimalResponse> {
  const u = new URL(url)
  const lib = u.protocol === 'https:' ? httpsRequest : httpRequest
  const method = (init.method || 'GET').toUpperCase()
  const headers = buildHeaders(init)
  // 统一注入 User-Agent（调用方未显式指定时），覆盖所有经 safeFetch 的请求（v0/p1 等）
  if (!headers['user-agent']) headers['user-agent'] = userAgent()
  const rawBody = init.body
  const body = typeof rawBody === 'string' ? rawBody : rawBody ? rawBody.toString() : undefined
  // 注意：不能写 `options?.agent ?? agent`，否则显式传入 { agent: undefined }（强制直连重试）
  // 会被 ?? 回退成全局 agent（代理），导致「直连重试」实际仍走代理。用 options 是否存在区分。
  const useAgent = options ? options.agent : agent
  const timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS

  return new Promise<MinimalResponse>((resolve, reject) => {
    const req = lib(
      u,
      // family:4 强制 IPv4：Node 默认双栈会先尝试 IPv6，许多网络下 IPv6 不通却卡到超时
      // （curl/浏览器 happy-eyeballs 更聪明，故「浏览器能通、主进程超时」）。Bangumi 有 IPv4。
      // signal：AbortController 取消在途请求（搜索被新请求取代时掐掉旧分页拉取）
      { method, headers, agent: useAgent ?? undefined, family: 4, signal: init.signal } as never,
      (res) => {
        const status = res.statusCode || 0
        const location = res.headers['location']
        // 跟随重定向：GitHub release 下载地址会 302 到 CDN；原生 https 不自动跟随
        if (REDIRECT_STATUS.has(status) && location && redirectsLeft > 0) {
          res.resume() // 丢弃响应体，释放 socket
          const nextUrl = new URL(location, u).toString()
          const nextHost = new URL(nextUrl).host
          // 复用已注入 UA 的 headers；跨主机时去除 Authorization 避免凭据泄漏（UA 非机密，保留）
          const nextHeaders = nextHost === u.host ? headers : stripAuth(headers)
          const nextInit: FetchInit = { ...init, headers: nextHeaders }
          // 301/302/303 按惯例改回 GET（307/308 保留原方法与请求体）
          if (status === 301 || status === 302 || status === 303) {
            nextInit.method = 'GET'
            nextInit.body = undefined
          }
          doRequest(nextUrl, nextInit, redirectsLeft - 1, options).then(resolve, reject)
          return
        }
        const webStream = Readable.toWeb(res) as ReadableStream<Uint8Array>
        const readAll = async (): Promise<Buffer> => {
          const reader = webStream.getReader()
          const parts: Uint8Array[] = []
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (value) parts.push(value)
          }
          return Buffer.concat(parts)
        }
        resolve({
          ok: status >= 200 && status < 300,
          status,
          headers: adaptHeaders(res.headers),
          body: webStream,
          text: async () => (await readAll()).toString('utf8'),
          json: async () => {
            try {
              return JSON.parse(await (await readAll()).toString('utf8'))
            } catch (e) {
              throw new Error('响应不是合法 JSON：' + (e as Error).message)
            }
          }
        })
      }
    )
    // 超时：超过阈值仍无响应则主动断开并 reject（带可读错误码），不让调用方永久挂起
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`请求超时（>${timeoutMs}ms）`))
    })
    req.on('error', (e: NodeJS.ErrnoException) => {
      const code = e.code || e.name || ''
      const detail = e.message || String(e)
      console.error('[http] fetch 失败：', { url, code, detail, cause: e })
      reject(new Error(`网络请求失败${code ? `（${code}）` : ''}：${detail}`))
    })
    if (body) req.write(body)
    req.end()
  })
}

/**
 * 带多策略自动回退的 fetch：
 * - 按顺序尝试：①系统/环境代理（若有）→ ②本机候选代理（探测到的 Clash/v2ray 等）→ ③直连。
 * - 任一策略网络层失败（连接错/超时）即跳下一个，直到成功或全部失败。
 *   覆盖两类常见「浏览器能通、主进程超时」场景：
 *   (a) Node 默认双栈 IPv6 卡住 → family:4 已强制 IPv4 兜底；
 *   (b) 主进程没用上用户的代理 → 这里自动探测并用上本机代理，最后才直连。
 * - 仅网络层异常（req 'error'/超时）才重试；HTTP 4xx/5xx 不抛错，故不重试。
 * - 全部失败时报错附带「已尝试路径」，便于定位到底是代理还是直连不通。
 */
/**
 * 按优先级构建请求策略（带缓存）：
 * ①手动代理（设置项 `proxy`）→ ②系统/环境代理 → ③本机候选代理（探测到的 Clash/v2ray 等）→ ④直连。
 * 手动代理在启动期异步从 DB 读取一次；若设置页后续经 IPC 改动，setManualProxy 会使缓存失效并重建。
 */
async function resolveStrategies(): Promise<{ agent: AnyProxyAgent | undefined; label: string }[]> {
  if (strategyCache) return strategyCache
  if (!manualProxyLoaded) {
    try {
      const { getSetting } = await import('../db/repositories/settings.repository')
      const u = await getSetting('proxy')
      setManualProxy(u)
    } catch {
      manualProxyLoaded = true
    }
  }
  const strategies: { agent: AnyProxyAgent | undefined; label: string }[] = []
  if (manualAgent) strategies.push({ agent: manualAgent, label: `手动代理(${manualProxyUrl})` })
  if (proxy) strategies.push({ agent, label: `系统代理(${proxy})` })
  for (const a of candidateAgents) {
    strategies.push({ agent: a, label: `本机代理(${a.proxy?.href ?? '?'})` })
  }
  strategies.push({ agent: undefined, label: '直连' })
  console.log(`[http] 请求策略：${strategies.map((s) => s.label).join(' / ')}`)
  strategyCache = strategies
  return strategies
}

export async function safeFetch(url: string, init?: FetchInit): Promise<MinimalResponse> {
  const strategies = await resolveStrategies()
  let lastErr: unknown
  // 统计：一次逻辑请求 = 1 次计数；上行字节（URL+头+体）同步计入。
  const sentBytes = computeSentBytes(url, init || {})
  pendingSent += sentBytes
  pendingRequests += 1
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    /* ignore */
  }
  if (isBgmHost(host)) pendingBgmRequests += 1
  else pendingOtherRequests += 1
  scheduleFlush()
  for (let i = 0; i < strategies.length; i++) {
    const s = strategies[i]
    // 首个策略给足 30s；后续回退 10s，避免叠加超时导致等待过久。
    // 直连 api.bgm.tv 在部分网络下首包较慢，15s 易被误判超时，故放宽首策略。
    const timeoutMs = i === 0 ? 30000 : 10000
    try {
      const resp = await doRequest(url, init || {}, MAX_REDIRECTS, { agent: s.agent, timeoutMs })
      // HTTP 5xx：很可能是当前策略（坏代理/被墙节点）导致的服务端或网关错误，
      // 直连可能反而可用。5xx 不直接返回，尝试下一个策略；仅 4xx（鉴权/不存在等）
      // 属于服务端明确判定，不触发回退。所有策略都 5xx 时最后返回最后一个响应。
      if (resp.status >= 500 && i < strategies.length - 1) {
        await resp.text().catch(() => '')
        lastErr = new Error(`HTTP ${resp.status}`)
        console.warn(`[http] 策略「${s.label}」返回 HTTP ${resp.status}，尝试下一个`)
        continue
      }
      // 下行字节经包裹流异步累加（text()/json()/body 读取均计数）。
      return wrapWithByteCounting(resp, (n) => {
        pendingReceived += n
      })
    } catch (e) {
      lastErr = e
      console.warn(`[http] 策略「${s.label}」失败，尝试下一个：`, (e as Error)?.message)
    }
  }
  const tried = strategies.map((s) => s.label).join(' / ')
  const base = lastErr instanceof Error ? lastErr.message : String(lastErr)
  throw new Error(`[NETWORK] ${base}（已尝试：${tried}）`)
}

/**
 * ===== 应用网络使用量统计（埋点）=====
 * 本模块的 safeFetch 是主进程全部网络请求（bangumi 适配层、同步引擎、cg、tmdb、vndb、
 * archive dump 下载，以及被覆盖的全局 fetch）的唯一出口，故在此一处埋点即可覆盖全量流量。
 *
 * 口径：
 * - requests：一次 safeFetch 逻辑调用计 1 次（重试跨策略不重复计数）。
 * - sent：URL + 序列化请求头 + 请求体字节（每次请求同步计入）。
 * - received：实际响应体流式字节（经包裹流异步累加；text()/json()/body 直接读取均计数）。
 * 落库策略：攒批 debounce（5s）刷库，避免高频写盘；退出前调 flushNetworkNow() 强制落库。
 * 失败保护：落库异常时把增量退回 pending，下次重试，避免数据丢失。
 */
let pendingSent = 0
let pendingReceived = 0
let pendingRequests = 0
let pendingBgmRequests = 0
let pendingOtherRequests = 0
let flushTimer: NodeJS.Timeout | null = null

/** bgm 相关域名（主进程请求的 bgm 域）：api.bgm.tv / bgm.tv / bangumi.tv / next.bgm.tv 及其子域 */
function isBgmHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return (
    h === 'api.bgm.tv' ||
    h === 'bgm.tv' ||
    h === 'bangumi.tv' ||
    h === 'next.bgm.tv' ||
    h.endsWith('.bgm.tv') ||
    h.endsWith('.bangumi.tv') ||
    h.endsWith('.next.bgm.tv')
  )
}

/** 估算一次请求的上行字节：URL + 请求头（含 ": " 分隔）+ 请求体。 */
function computeSentBytes(url: string, init: FetchInit): number {
  let n = url.length
  const h = init.headers
  if (h) {
    if (Array.isArray(h)) {
      for (const [k, v] of h) n += k.length + String(v).length + 2
    } else {
      for (const [k, v] of Object.entries(h)) if (v != null) n += k.length + String(v).length + 2
    }
  }
  const rb = init.body
  if (typeof rb === 'string') n += rb.length
  else if (rb) n += rb.toString().length
  return n
}

/**
 * 包裹 MinimalResponse，使响应体被读取时累加字节数到 onBytes。
 * 优先用 TransformStream 包裹 body，使 body.getReader()/body.cancel 直接读取也计数；
 * 若运行环境无 TransformStream（极旧 Node），则仅在 text()/json() 读取时计数作为兜底。
 */
function wrapWithByteCounting(
  resp: MinimalResponse,
  onBytes: (n: number) => void
): MinimalResponse {
  const original = resp.body
  if (!original) return resp
  const TS = (globalThis as unknown as { TransformStream?: typeof TransformStream }).TransformStream
  if (TS) {
    const wrapped = original.pipeThrough(
      new TS<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (chunk && chunk.byteLength) onBytes(chunk.byteLength)
          controller.enqueue(chunk)
        }
      })
    )
    const readAllWrapped = async (): Promise<Buffer> => {
      const reader = wrapped.getReader()
      const parts: Uint8Array[] = []
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) parts.push(value)
      }
      return Buffer.concat(parts)
    }
    return {
      ...resp,
      body: wrapped,
      text: async () => (await readAllWrapped()).toString('utf8'),
      json: async () => {
        try {
          return JSON.parse((await readAllWrapped()).toString('utf8'))
        } catch (e) {
          throw new Error('响应不是合法 JSON：' + (e as Error).message)
        }
      }
    }
  }
  // 兜底：仅 text()/json() 读取时计数（覆盖绝大多数 API 调用）。
  const readAllOrig = async (): Promise<Buffer> => {
    const reader = original.getReader()
    const parts: Uint8Array[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        onBytes(value.byteLength)
        parts.push(value)
      }
    }
    return Buffer.concat(parts)
  }
  return {
    ...resp,
    text: async () => (await readAllOrig()).toString('utf8'),
    json: async () => {
      try {
        return JSON.parse((await readAllOrig()).toString('utf8'))
      } catch (e) {
        throw new Error('响应不是合法 JSON：' + (e as Error).message)
      }
    }
  }
}

/** 安排一次 debounce 落库（5s 内攒批）。定时器 unref，不阻止进程退出。 */
function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushNetworkNow()
  }, 5000)
  if (typeof (flushTimer as unknown as { unref?: () => void }).unref === 'function') {
    ;(flushTimer as unknown as { unref: () => void }).unref()
  }
}

/** 立即把累计增量写入 network_stats（退出前调用）。无增量则跳过。落库失败退回 pending。 */
export async function flushNetworkNow(): Promise<void> {
  if (
    pendingSent === 0 &&
    pendingReceived === 0 &&
    pendingRequests === 0 &&
    pendingBgmRequests === 0 &&
    pendingOtherRequests === 0
  )
    return
  const s = pendingSent
  const r = pendingReceived
  const qb = pendingBgmRequests
  const qo = pendingOtherRequests
  pendingSent = 0
  pendingReceived = 0
  pendingRequests = 0
  pendingBgmRequests = 0
  pendingOtherRequests = 0
  try {
    const { addNetworkUsage, addDailyUsage } = await import('../db/repositories/networkStats.repository')
    await addNetworkUsage(s, r, qb, qo)
    await addDailyUsage(s, r, qb, qo)
  } catch {
    // 落库失败：退回 pending，下次重试（避免数据丢失）
    pendingSent += s
    pendingReceived += r
    pendingRequests += qb + qo
    pendingBgmRequests += qb
    pendingOtherRequests += qo
  }
}
