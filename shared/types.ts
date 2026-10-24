// 主进程 / 渲染进程共享的纯类型定义（不依赖 node / electron，可被两端安全 import）

export type Provider = 'bangumi' | 'tmdb' | 'vndb'

export type Category = 'anime' | 'light_novel' | 'manga' | 'galgame'

/** 作品标签（来自 Bangumi tags，含被标记次数） */
export interface SubjectTag {
  name: string
  count: number
}

/** 制作信息条目（来自 Bangumi infobox，如 制作公司 / 出版社 / 平台 / 声优 等） */
export interface SubjectMeta {
  key: string
  value: string
}

/** 角色（来自 Bangumi 角色列表：名字 / 关系(主角·配角·客串) / 头像 / CV 声优） */
export interface SubjectCharacter {
  id: number
  name: string
  /** 真正取到的中文译名（来自 infobox 简体中文名）；空串表示未取到。用于合并时优先中文、避免被原名覆盖 */
  nameCn?: string
  image?: string
  /** 角色关系：主角 / 配角 / 客串（Bangumi relation 字段，或 P1 的 type 映射） */
  relation: string
  /** 角色收藏数（Bangumi 的 +N，来自 P1 comment 字段；v0 路径无此值） */
  comment?: number
  /** 展示顺序（Bangumi 网页的「作品内真实排序」，来自 P1 数组下标）。缓存层据此排序；
   *  缺省（undefined，过渡期旧缓存）时回退按缓存 id 顺序。 */
  displayOrder?: number
  /** 配音演员（CV），可能为空；id 用于跳转 Bangumi person 页 */
  actors: { id?: number; name: string; nameCn?: string; image?: string }[]
}

/** 关联作品（来自 Bangumi 关联条目：前传 / 续集 / 外传 等，含封面与类型） */
export interface SubjectRelation {
  id: number
  name: string
  /** 真正取到的中文译名（来自条目顶层 name_cn）；空串表示未取到 */
  nameCn?: string
  image?: string
  /** Bangumi 作品类型（1=书籍 2=动画 4=游戏 6=三次元 …） */
  type: number
  /** 关联类型：续集 / 前传 / 外传 / 同名作品 … */
  relation: string
}

/** 制作/创作人员（来自 Bangumi 作品 staff：作者 / 导演 / 原画 / 制作公司 等，对应 /subjects/{id}/persons）。
 *  用于把「制作信息」里的人名/公司名渲染成可点击项，跳转对应的人物悬浮窗（kind='person'）。 */
export interface SubjectPerson {
  id: number
  /** 显示名（优先中文名 name_cn，其次原名 name） */
  name: string
  /** 中文名（Bangumi persons 列表返回 name_cn 则取之；否则空串） */
  nameCn?: string
  /** 职位/关系（Bangumi relation，如 导演 / 原作 / 动画制作 / 角色设计 / 出版社 …） */
  relation: string
  image?: string
}

/** 统一作品模型：所有数据源归一化后的标准结构。
 *  数据以 Bangumi 为主（provider='bangumi' 为权威记录），
 *  其它源（tmdb/vndb/dlsite/steam）仅作为辅助外链存在。 */
export interface Subject {
  provider: Provider
  providerSubjectId: string
  category: Category
  title: string
  titleCn?: string
  summary?: string
  imageUrl?: string
  airDate?: string
  totalEpisodes?: number
  totalVolumes?: number
  /** 是否系列作品（Bangumi series 标志位；true=系列，false=单行本/单卷，null=未获取）。仅书籍类有意义 */
  series?: boolean | null
  rating?: number
  /** Bangumi 评分分布：长度 10 的数组，索引 i 对应 (i+1) 星的票数（1–10 星），仅 Bangumi 作品联网详情时填充 */
  ratingCount?: number[]
  /** 评分总人数（= ratingCount 之和，或直接取 Bangumi rating.total），仅联网详情时填充 */
  ratingTotal?: number
  /** 标签（来自 Bangumi tags），仅在详情/同步补全时填充 */
  tags?: SubjectTag[]
  /** 制作信息（来自 Bangumi infobox，已扁平化），仅在详情/同步补全时填充 */
  meta?: SubjectMeta[]
  /** 官方/系统标签（来自 Bangumi meta_tags 顶层字符串数组，如 ["机战","TV","日本","原创","战斗"]），与用户自由标注的 tags 区分 */
  metaTags?: string[]
  /** 辅助源外链 id，如 { vndb: 'v17', tmdb: '123' }（搜索时按标题匹配写入） */
  externalLinks?: Record<string, string>
  /** 是否 R18（来自 subjects.nsfw，由离线 Archive 回填）；用于封面模糊/隐藏 */
  nsfw?: boolean
}

/** 单条「其它用户的吐槽」（来自 Bangumi 条目吐槽区 next.bgm.tv/p1/subjects/{id}/comments） */
export interface SubjectComment {
  id: number
  content: string
  /** 评论更新时间戳（秒，来自 Bangumi updatedAt） */
  createdAt: number | string | null
  /** 该用户给条目的评分（1-10，0 表示未评分） */
  rate: number
  /** 该用户的收藏状态（Bangumi collection type）：1 想看 / 2 看过 / 3 在看 / 4 搁置 / 5 抛弃；0 表示未知 */
  collectionType: number
  creator: {
    username: string
    nickname: string
    avatar: string | null
  }
  /** 子评论（回复） */
  replies?: SubjectComment[]
}

/** Bangumi 讨论串（next.bgm.tv/p1 条目讨论版，结构化 JSON）。
 *  单条目列表（/p1/subjects/{id}/topics）不含 subject；每条含作者与回复数。 */
export interface BgmTopic {
  id: number
  title: string
  /** 回复数 */
  replyCount: number
  /** 发布时间戳（秒） */
  createdAt: number
  /** 最后回复时间戳（秒） */
  updatedAt: number
  creator?: {
    username?: string
    nickname?: string
    avatar?: { small?: string; medium?: string; large?: string } | null
  }
}

/** 讨论串内一条楼层（/p1/subjects/-/topics/{id} 的 replies 元素；楼中楼嵌套在 replies 里） */
export interface BgmTopicReply {
  id: number
  content: string
  /** 时间戳（秒） */
  createdAt: number
  creator: {
    username: string
    nickname: string
    avatar: string | null
  }
  /** 楼中楼（Bangumi 两层模型：子楼层再回复仍归并到所属顶层楼层的 replies） */
  replies: BgmTopicReply[]
  /** 表情回应（登录态返回） */
  reactions?: CommentReaction[]
}

/** 讨论串详情：元信息 + 所属条目 + 全部楼层（replies[0] 为楼主帖） */
export interface BgmTopicDetail extends BgmTopic {
  subject?: {
    id: number
    name: string
    nameCN?: string
    images?: { medium?: string; common?: string }
    rating?: { score?: number }
  } | null
  replies: BgmTopicReply[]
}

/** Bangumi 讨论串（next.bgm.tv/p1 全站热门条目讨论，结构化 JSON） */
export interface BgmTopic {
  id: number
  title: string
  /** 回复数 */
  replyCount: number
  /** 发布时间戳（秒） */
  createdAt: number
  /** 最后回复时间戳（秒） */
  updatedAt: number
  creator?: {
    username?: string
    nickname?: string
    avatar?: { small?: string; medium?: string; large?: string } | null
  }
  /** 所属条目 */
  subject?: {
    id: number
    name: string
    nameCN?: string
    images?: { small?: string; medium?: string; common?: string; large?: string }
    rating?: { score?: number }
  } | null
}

/** 评论表情回应（Bangumi 单集评论的 reactions 字段，仅登录态返回）。
 *  value=表情标识（数字，对应 Bangumi 一组固定表情之一）；users=回应者列表；total=人数（缺省取 users.length）。 */
export interface CommentReaction {
  value: string | number
  users: Array<{ id: number; username?: string; nickname?: string }>
  total?: number
  /** 当前登录用户是否也回应过该表情（需登录态；主进程暂未填，UI 可忽略） */
  selected?: boolean
}

/** 单集评论（来自 Bangumi 单集评论区 next.bgm.tv/p1/episodes/{id}/comments，匿名可访问，结构化 JSON）。
 *  字段与 SubjectComment 对齐（去掉 rate/collectionType：单集评论无作品级评分/收藏状态）。 */
export interface EpisodeComment {
  id: number
  content: string
  /** 评论时间戳（秒，来自 Bangumi createdAt） */
  createdAt: number | string | null
  creator: {
    username: string
    nickname: string
    avatar: string | null
  }
  /** 是否为本地用户自己发的（本应用发出的，已真发或仅本地草稿）。p1 取回的他人评论恒为 false */
  mine?: boolean
  /** 是否已同步到 Bangumi（仅本地草稿未成功发布时为 false；p1 取回的他人评论恒为 undefined） */
  synced?: boolean
  /** 嵌套子评论（Bangumi 评论回复，来自 p1 评论的 replies 字段）。仅顶层评论可能非空 */
  replies?: EpisodeComment[]
  /** 表情回应（reactions，仅登录态返回；别人给这条评论发的表情包）。顶层与子评论均可能非空 */
  reactions?: CommentReaction[]
  /** 本地草稿子评论的父评论 id（顶层评论为 undefined；发表子评论时填父评论的 id，用于本地归并显示） */
  parentId?: number | null
  /** 该评论在 Bangumi 的真实 id（远程/已真发评论=provider id；本地已同步=provider_comment_id；未同步本地草稿=undefined） */
  providerId?: number | null
}

/** 单集详情（来自 Bangumi v0 /episodes/{id}，匿名可访问）：标题/集号/首播/时长/简介。
 *  悬浮窗上半部分（ep.N 标题 + [修改] + 时长 + 首播 + 简介）由此驱动，无需抓网页。 */
export interface EpisodeDetail {
  id: number
  /** 全系列全局连续编号（Bangumi sort 字段，多季作品如第三季=25~36）；用于「ep.N」显示 */
  epNumber: number | null
  /** 季内编号（Bangumi ep 字段，从 1 起） */
  ep: number | null
  /** 显示标题：优先中文名（name_cn），无则回退原名（name） */
  title: string | null
  /** 原名（name） */
  name?: string | null
  /** 首播日期（airdate，YYYY-MM-DD） */
  airDate: string | null
  /** 时长（duration，HH:MM:SS 或秒数） */
  duration: string | null
  /** 简介（desc） */
  desc: string | null
  /** 单集类型（Bangumi ep type：0 正片 / 1 特别篇 / 2 OP / 3 ED …） */
  episodeType: number
  /** 所属作品 id（Bangumi v0 /episodes/{id} 返回的 subject_id；用于从单集链接反查作品） */
  subjectId?: number | null
}

/** CG / 截图示例图（Galgame 详情画廊），仅存远程 URL */
export interface GalleryItem {
  /** 来源：vndb | dlsite | steam */
  source: string
  url: string
  thumb?: string
  caption?: string
  /** 是否 R18（VNDB 截图按 sexual/violence 分级判定），用于模糊遮罩 */
  nsfw?: boolean
}

/** 单张画廊图（已结构化，供 GameGallery 使用） */
export interface GameGalleryImage {
  url: string
  thumb?: string
  caption?: string
  /** 是否 R18（仅 VNDB 截图带分级；DLsite/Steam 默认 false） */
  nsfw?: boolean
}

/** 游戏画廊（复刻 Bangumi「游戏画廊」超合金组件）：按来源分组的 CG / 截图 */
export interface GameGallery {
  vndb: GameGalleryImage[]
  dlsite: GameGalleryImage[]
  steam: GameGalleryImage[]
  /** 默认展示的来源（按 dlsite → vndb → steam 优先级，取第一个有图源的） */
  defaultSource: 'vndb' | 'dlsite' | 'steam'
  /** VNDB 评分（0-10，带 2 位小数），仅 Galgame 区展示；无则缺省 */
  vndbRating?: number
  /** VNDB 评分人数 */
  vndbRatingCount?: number
}

// ===== 统一搜索（条目 / 人物）=====
/** 搜索域：条目（Bangumi subject）/ 人物（角色 + 现实人物） */
export type SearchDomain = 'subject' | 'person'
/** 条目子分类（对应 Bangumi subject type：动画=2 / 书籍=1 / 游戏=4） */
export type SubjectFilter = 'all' | 'anime' | 'book' | 'game'
/** 人物子分类：虚拟=角色(character) / 现实=人物(person) */
export type PersonFilter = 'all' | 'virtual' | 'real'

/** 统一搜索请求：keyword + 域 + 对应子分类过滤 */
export interface SearchQuery {
  keyword: string
  domain: SearchDomain
  /** 条目子类型（domain==='subject' 时有效） */
  subjectType?: SubjectFilter
  /** 人物子类型（domain==='person' 时有效） */
  personType?: PersonFilter
}

/** 标签搜索请求（p1 /search/subjects）：按标签/元标签/类型检索作品 */
export interface TagSearchQuery {
  keyword: string
  /** 普通标签（多值取交集） */
  tags?: string[]
  /** 元标签（Bangumi 官方分类标签），支持 `-` 排除 */
  metaTags?: string[]
  /** Bangumi 作品类型（1 书籍 / 2 动画 / 3 音乐 / 4 游戏 / 6 三次元） */
  type?: number
  /** 排序：match 匹配度 / heat 热度 / rank 排名 / score 评分 */
  sort?: 'match' | 'heat' | 'rank' | 'score'
}

/** 频道热门标签项（p1 /channels/{type}/tags） */
export interface ChannelTag {
  name: string
  count: number
}

export interface SearchSubjectItem {
  kind: 'subject'
  subject: Subject
}
export interface SearchPersonItem {
  kind: 'person'
  /** Bangumi 角色 / 人物 id */
  id: string
  /** 显示名（优先中文名） */
  name: string
  nameCn?: string
  imageUrl?: string
  /** 虚拟=角色 / 现实=人物 */
  personKind: 'character' | 'person'
}
export type SearchResultItem = SearchSubjectItem | SearchPersonItem

export interface AppInfo {
  name: string
  version: string
}

/** 角色/人物详情卡（点击详情页角色或 CV 打开，替代跳转 bgm 网页）的 infobox 项 */
export interface EntityInfoboxItem {
  key: string
  value: string
}

/** 详情卡里的「出演作品 / 出演角色 / 关联角色」条目 */
export interface EntityWorkItem {
  id: number
  name: string
  /** 中文名（优先），无则空串 */
  nameCn: string
  image: string
  /** 关系（出演作品里是「主角/配角…」，出演角色里是角色名对应的关系，关联角色为空） */
  relation: string
  /**
   * 同一人在同一作品中担任的多个职务（如既原作又脚本）。仅「参与作品」可能为多值；
   * 来自 Bangumi /persons/{id}/subjects 对同一 subject 的多次返回（每次一个 relation）合并而成。
   * 渲染层优先展示 relations（用「 / 」连接），无则回退 relation。角色卡的单角色/单作品恒为单值，不会写入此字段。
   */
  relations?: string[]
  /** 配音演员（CV）列表，含 id（用于点击跳转人物卡）与显示名；仅「关联角色」条目附带（来自详情页角色列表的 actors） */
  cvs?: { id?: number; name: string }[]
  /** 该角色（在人物卡「出演角色」里）出演的作品列表；仅人物卡附带，用于角色小栏右侧展示 */
  works?: EntityWorkItem[]
  /**
   * 排序用日期（来自本地 Archive 库 arc_subjects.date，YYYY-MM-DD）。
   * 出演角色条目取的是其「最晚出演作品」的日期；无日期（Archive 库缺失该作品 / 角色无任何作品）为 undefined。
   * 渲染层据此排序：asc=旧→新、desc=新→旧；**缺失日期恒排最后，与正序/倒序无关**。
   */
  date?: string
}

/** 角色/人物详情卡完整数据（由主进程 /v0/characters|persons/{id} 及其子端点聚合） */
export interface EntityDetail {
  kind: 'character' | 'person'
  id: number
  /** 显示名（优先中文名，其次原名） */
  name: string
  /** 立绘/头像 URL（large 优先，其次 medium） */
  image: string
  /** 原始 infobox（key/value 数组），用于左侧信息区 */
  infobox: EntityInfoboxItem[]
  /** 介绍（summary） */
  summary: string
  /** 出演作品（角色：/characters/{id}/subjects；人物：/persons/{id}/subjects） */
  works: EntityWorkItem[]
  /** 出演角色（仅人物：/persons/{id}/characters） */
  characters?: EntityWorkItem[]
  /**
   * 职业（仅人物：/v0/persons/{id} 的 career，官方枚举 7 值：producer/mangaka/artist/seiyu/writer/illustrator/actor）。
   * 用于在人物简介区展示职业标签；含 seiyu 时人物卡隐藏「参与作品」（避免主题曲专辑/角色歌刷屏）。
   */
  career?: string[]
  /** 组织类型（仅人物：PersonType 1=个人 2=公司 3=组合，非性别），用于人物简介区展示（仅公司/组合有展示价值） */
  type?: number
}

/**
 * 作品完整详情（点击角色卡的「出演作品」打开的卡片用）。
 * 复用详情页的四个共享组件（SubjectMetaPanel / SubjectCharacters / SubjectRelations / TucaoBox），
 * 因此 subject 字段需覆盖这些组件所需的全部可读字段（category / tags / meta / rating / 排名 / provider）。
 */
export interface SubjectFullSubject {
  id: number
  provider: 'bangumi'
  providerSubjectId: string
  category: Category
  title: string
  title_cn: string
  image_url: string
  summary: string
  rating?: number
  /** Bangumi 评分分布（1–10 星票数） */
  ratingCount?: number[]
  /** 评分总人数 */
  ratingTotal?: number
  /** 站点排名文案，如 "#885" */
  rank?: string
  tags: SubjectTag[]
  meta: SubjectMeta[]
  /** 官方/系统标签（来自 Bangumi meta_tags 顶层字符串数组） */
  metaTags?: string[]
  total_episodes?: number | null
  total_volumes?: number | null
  air_date?: string | null
  /** 是否系列作品（Bangumi series 标志位：true=系列，false=单行本/单卷，null=未获取） */
  series?: boolean | null
  /** 是否 R18（来自 subjects.nsfw，由离线 Archive 回填）；用于封面模糊/隐藏 */
  nsfw?: boolean
}
/** 单集（来自 Bangumi /episodes，正片 type=0）。epNumber 为 Bangumi 真实集号（可能非从 1 开始）。 */
export interface SubjectFullEpisode {
  id: number
  epNumber: number
  title: string | null
  airDate: string | null
  duration: string | null
  epType: number
}

/** 单集进度状态（已看 / 想看，二者互斥）。progress 映射的 value 类型。 */
export interface EpisodeProgressState {
  watched: boolean
  want: boolean
  /** 抛弃单集（Bangumi episode type=3） */
  dropped?: boolean
}

/** 悬浮窗/详情页标记单集状态的请求载荷。
 * - action='watched'：切换单集已看（点格子或「看过」按钮）
 * - action='want'：切换单集想看（「想看」按钮）
 * - action='drop'：清除单集状态（「撤销」按钮）
 * - upToIds：仅在「看到」场景传入，为「当前集及之前所有集」的 episode id 有序列表，
 *   此时 action 固定为 'watched'，表示把这些集全部标记为已看。 */
export interface EpisodeMarkPayload {
  action: 'watched' | 'want' | 'drop' | 'undo'
  episodeId: number
  upToIds?: number[]
}
export interface SubjectFullDetail {
  kind: 'subject'
  subject: SubjectFullSubject
  /** 角色列表（含 CV 声优） */
  characters: SubjectCharacter[]
  /** 关联作品（前传 / 续集 / 外传 等） */
  relations: SubjectRelation[]
  /** 剧集（正片）。悬浮窗用其真实集号/标题/首播/时长渲染格子；缺失时格子按 total 兜底 */
  episodes?: SubjectFullEpisode[]
}

/** Bangumi 离线数据库（Archive）元信息 */
export interface ArchiveMeta {
  /** dump 文件名，如 dump-2026-08-04.210502Z.zip */
  version: string | null
  /** 最新 dump 的 sha256（用于判断是否已是最新） */
  sha256: string | null
  /** dump 体积（字节） */
  size: number | null
  /** 导出日期 YYYY-MM-DD */
  date: string | null
  /** 上次成功更新时间戳（ms） */
  lastSuccessAt: number | null
  /** 上次失败信息 */
  lastError: string | null
  /** 状态：ok / error / null（未初始化） */
  status: string | null
  /** 离线库 schema 版本（变更入库字段时 +1，用于触发旧库重新入库） */
  schemaVersion: number | null
}

/** 更新进度回调载荷 */
export interface ArchiveProgress {
  stage: 'start' | 'download' | 'extract' | 'ingest' | 'done' | 'error'
  /** 下载阶段：已下载字节 / 总字节 */
  downloaded?: number
  total?: number
  /** 入库阶段：当前表中文名 / 已处理行数 */
  table?: string
  count?: number
  message?: string
}

/** 更新结果 */
export interface ArchiveUpdateResult {
  status: 'updated' | 'up-to-date' | 'error'
  version?: string
  size?: number
  date?: string
  error?: string
}

/** 本机缓存统计（设置页「缓存管理」展示用）。 */
export interface CacheStats {
  /** 主数据库文件总大小（含 -wal / -shm 附属文件），字节 */
  dbSize: number
  /** 本地剧集缓存条数（subject_episodes，按 provider_subject_id+episode_id 计） */
  episodes: number
  /** 角色 / 声优缓存条数（subject_characters） */
  characters: number
  /** 关联作品缓存条数（subject_relations） */
  relations: number
  /** 画廊缓存条数（subject_gallery） */
  galleries: number
  /** Bangumi 离线数据库体积（字节，仅展示、不随清理删除） */
  archiveSize: number
  /** Chromium HTTP 磁盘缓存体积（封面/头像图片字节，字节；清理缓存会一并清掉） */
  imageCacheSize: number
}

/** 单月应用网络使用量统计（字节 / 请求次数）。month 形如 'YYYY-MM'。 */
export interface NetworkMonthStat {
  month: string
  /** 上行字节（请求头 + URL + 请求体） */
  sent: number
  /** 下行字节（响应体） */
  received: number
  /** 请求次数（safeFetch 逻辑调用次数） */
  requests: number
  /** 当月 bgm 相关域名（api.bgm.tv / bgm.tv / bangumi.tv / next.bgm.tv）请求次数 */
  bgmRequests: number
  /** 当月其它域名（vndb / dlsite / steam / tmdb / 离线库下载等）请求次数 */
  otherRequests: number
}

/** 单日应用网络使用量统计（字节 / 请求次数）。day 形如 'YYYY-MM-DD'。 */
export interface NetworkDayStat {
  day: string
  /** 上行字节（请求头 + URL + 请求体） */
  sent: number
  /** 下行字节（响应体） */
  received: number
  /** 请求次数（safeFetch 逻辑调用次数） */
  requests: number
  bgmRequests: number
  otherRequests: number
}

/** 设置页「网络使用量」一次性拉取结果（当天 + 当月 + 近 6 月历史）。 */
export interface NetworkStatsResult {
  current: NetworkMonthStat | null
  history: NetworkMonthStat[]
  today: NetworkDayStat | null
}

/** Bangumi 可用性监测（来自 bgm-status.ry.mk /api/status，社区探针）单条组件状态 */
export interface BgmStatusComponent {
  domain: string
  kind: 'guest' | 'auth'
  label: string
  /** ok / degrade / down */
  status: string
  /** 30 天可用率（0-100） */
  uptime: number
}

/** Bangumi 服务状态（全局 + 各域名 × guest/auth 探针） */
export interface BgmStatus {
  /** ok / degrade / down */
  status: string
  message: string
  updated_at: number
  components: BgmStatusComponent[]
}

/** 离线搜索结果条目 */
export interface ArchiveSubjectSearch {
  id: number
  /** Bangumi subject type（1=书籍 2=动画 4=游戏 6=三次元 …） */
  type: number
  name: string
  name_cn: string
  score: number | null
  summary: string
}

/** 离线库按标签过滤返回的作品条目（含封面 url，用于标签作品悬浮窗） */
export interface ArchiveTagSubject {
  id: number
  /** Bangumi subject type（1=书籍 2=动画 4=游戏 6=三次元 …） */
  type: number
  /** 细分类目：anime / light_novel / manga / galgame / other（书籍按 Bangumi platform/tags 细分） */
  category: string
  name: string
  name_cn: string
  score: number | null
  /** Bangumi 榜单名次（越小越靠前，null=未上榜）；离线库直接可取 */
  rank: number | null
  /** 放送/出版日期 YYYY-MM-DD（离线库直接可取） */
  date: string | null
  summary: string
  image_url: string
}

export interface AuthStatus {
  loggedIn: boolean
  username?: string
  userId?: number
  /** 令牌来源：oauth（应用授权登录）/ token（手动粘贴个人令牌） */
  method?: 'oauth' | 'token'
}

/** 同步结果（推送 / 拉取 / 双向） */
export interface SyncResult {
  pushed: number
  pulled: number
  failed: number
  /** 因“云端已取消收藏”而被删除的本地收藏条数（Q1 差集删除） */
  deleted?: number
  error?: string
}

/** 同步引擎实时状态（侧栏同步指示灯订阅） */
export type SyncPhase = 'idle' | 'running' | 'ok' | 'error'
export type SyncKind = 'push' | 'pull' | 'full' | 'both'
export interface SyncEngineState {
  phase: SyncPhase
  kind: SyncKind | null
  finishedAt: number | null
  /** phase==='error' 时的失败摘要 */
  error: string | null
}

/** 动画详情（getDetail 返回）：作品 + 收藏 + 剧集 + 逐集进度 */
export interface AnimeDetail {
  subject: {
    id: number
    provider_subject_id?: string
    title: string
    title_cn?: string
    image_url?: string
    total_episodes?: number | null
    air_date?: string | null
    rating?: number
    /** 作品简介（Bangumi summary；本地缺失时联网/离线 Archive 兜底补取） */
    summary?: string
    tags?: SubjectTag[]
    meta?: SubjectMeta[]
    /** 官方/系统标签（来自 Bangumi meta_tags 顶层字符串数组） */
    metaTags?: string[]
    /** 是否 R18（来自 subjects.nsfw，由离线 Archive 回填）；用于封面模糊/隐藏 */
    nsfw?: boolean
  }
  collection: {
    id: number
    status: number
    ep_status: number
  } | null
  episodes: {
    id: number
    ep_number: number
    ep_type: number
    title?: string | null
  }[]
  /** 真实剧集（Bangumi /episodes，正片）。仅用于显示增强：真实集号/标题/首播/时长。
   *  与上面的 episodes（本地库，含进度 id）按位置对应；获取失败时为空数组。 */
  bangumiEpisodes?: SubjectFullEpisode[]
  /** 逐集进度：episodeId -> { watched, want }。
   *  episodeId 对 Bangumi 作品为 Bangumi 剧集 id（与 bangumiEpisodes[].id 一致），
   *  无 Bangumi 数据时为本库 episodes 表的 id。 */
  progress: Record<number, EpisodeProgressState>
  /** 角色列表（Bangumi 角色，含 CV 声优） */
  characters: SubjectCharacter[]
  /** 关联作品（前传 / 续集 / 外传 等） */
  relations: SubjectRelation[]
}

/** 在看列表项 */
export interface AnimeWatchingItem {
  collectionId: number
  subjectId: number
  /** Bangumi 条目 id（字符串形式；右键菜单「在 Bangumi 打开」/删除收藏用） */
  providerSubjectId?: string
  title: string
  titleCn?: string
  imageUrl?: string
  epStatus: number
  totalEpisodes?: number | null
  /** 收藏状态（Bangumi type：1 想看 / 2 看过 / 3 在看 / 4 搁置 / 5 抛弃） */
  status?: number
  /** 我的评分（1-10，Bangumi 评分制；未评分则为 null） */
  rating?: number | null
  /** Bangumi 站方评分（10 分制 1 位小数，来自 subjects.rating；用户未评分时回退显示） */
  siteRating?: number | null
  /** 本地最后标记/更新时间（unix 秒，来自 collections.local_updated_at） */
  markedAt?: number | null
  /** 是否 R18（来自 subjects.nsfw，由离线 Archive 回填）；用于封面模糊/隐藏 */
  nsfw?: boolean
}

/** 动画统计 */
export interface AnimeStats {
  watching: number
  watched: number
}

/** 通用收藏详情（轻小说/漫画/Galgame 复用同一套 collections 仓储） */
export interface CollectionDetail {
  subject: {
    id: number
    provider_subject_id?: string
    title: string
    title_cn?: string
    image_url?: string
    total_episodes?: number | null
    total_volumes?: number | null
    air_date?: string | null
    series?: boolean | null
    rating?: number
    summary?: string
    tags?: SubjectTag[]
    meta?: SubjectMeta[]
    /** 官方/系统标签（来自 Bangumi meta_tags 顶层字符串数组） */
    metaTags?: string[]
    /** 是否 R18（来自 subjects.nsfw，由离线 Archive 回填）；用于封面模糊/隐藏 */
    nsfw?: boolean
  }
  collection: {
    id: number
    status: number
    ep_status: number
    /** 已读卷数（漫画/轻小说用；动画/游戏为 0） */
    vol_status: number
  } | null
  /** 角色列表（Bangumi 角色，含 CV 声优） */
  characters: SubjectCharacter[]
  /** 关联作品（前传 / 续集 / 外传 等） */
  relations: SubjectRelation[]
}

/** 收藏列表项（含当前进度 ep_status / vol_status 与总量） */
export interface CollectionItem {
  collectionId: number
  subjectId: number
  /** Bangumi 条目 id（字符串形式；右键菜单「在 Bangumi 打开」/删除收藏用） */
  providerSubjectId?: string
  title: string
  titleCn?: string
  imageUrl?: string
  epStatus: number
  /** 收藏状态（Bangumi type：1 想看 / 2 看过 / 3 在看 / 4 搁置 / 5 抛弃） */
  status?: number
  /** 已读卷数（漫画/轻小说用；动画/游戏为 0） */
  volStatus: number
  totalVolumes?: number | null
  totalEpisodes?: number | null
  /** 是否系列作品（Bangumi series 标志位：true=系列，false=单行本/单卷，null=未获取）。非系列不显示已读卷 */
  series?: boolean | null
  /** 我的评分（1-10，Bangumi 评分制；未评分则为 null） */
  rating?: number | null
  /** Bangumi 站方评分（10 分制 1 位小数，来自 subjects.rating；用户未评分时回退显示） */
  siteRating?: number | null
  /** 本地最后标记/更新时间（unix 秒，来自 collections.local_updated_at） */
  markedAt?: number | null
  /** 是否 R18（来自 subjects.nsfw，由离线 Archive 回填）；用于封面模糊/隐藏 */
  nsfw?: boolean
}

/** 收藏统计（某分类下的在看部数 + 累计进度） */
export interface CollectionStats {
  watching: number
  totalProgress: number
}

/** 统计悬浮窗：单个分组（全部 / 书籍 / 动画 / 游戏）的聚合数据 */
export interface GroupStat {
  /** 收藏总数 */
  total: number
  /** 完成数（status=2，即「x过」） */
  done: number
  /** 完成率 = done / total（0~1，total=0 时为 0） */
  completionRate: number
  /** 平均分（评分 1-10 的均值）；无评分时为 null */
  avgRating: number | null
  /** 标准差（总体标准差）；无评分时为 null */
  stdRating: number | null
  /** 评分数（rating>0 的作品数） */
  ratedCount: number
  /** 评分分布直方图：长度 11，index 1~10 对应评分为 k 的作品数 */
  histogram: number[]
  /** 该分类累计花费（来自 purchases 表，单位元）；无购买记录为 0 */
  totalSpent: number
}

/** 统计悬浮窗：全部 + 四个分类（小说=轻小说 / 漫画 / 动画 / 游戏=Galgame+游戏）的聚合数据 */
export interface UserStats {
  all: GroupStat
  light_novel: GroupStat
  manga: GroupStat
  anime: GroupStat
  game: GroupStat
}

/** 收藏悬浮窗：保存收藏的请求载荷（我的 tag 由后端从作品前 10 个 Bangumi tag 自动取） */
export interface SaveCollectionPayload {
  /** Bangumi 作品 id（字符串形式） */
  providerSubjectId: string
  /** 收藏状态：1=想X / 2=读X过 / 3=在X / 4=搁置 / 5=抛弃 */
  status: number
  /** 我的吐槽（收藏评论） */
  comment?: string | null
  /** 是否仅自己可见 */
  private?: boolean
  /** 「我的评价」评分（1-10）；null/不传表示不改动（沿用已有评分） */
  rating?: number | null
}

/** 保存收藏的返回结果 */
export interface SaveCollectionResult {
  collectionId: number
  subjectId: number
}

/** 查询某作品是否已收藏（供详情页 / 悬浮窗决定展示标签还是「我想X这Y」文字） */
export interface CollectionExisting {
  /** 本地收藏 id（未收藏为 null）。详情页 / 悬浮窗可用它直接改进度。 */
  id: number | null
  /** 收藏状态（1-5）；未收藏为 null */
  status: number | null
  /** 我的吐槽；未收藏为 null */
  comment: string | null
  /** 是否仅自己可见；未收藏为 null */
  private: boolean | null
  /** 「我的评价」评分（1-10）；未收藏为 null */
  rating: number | null
  /** 已读话（章）数（漫画=话、轻小说=章）；未收藏为 null */
  ep_status: number | null
  /** 已读卷数（漫画/轻小说用）；未收藏为 null */
  vol_status: number | null
}

/** 购买信息（Galgame 模块的购买平台与价格，仅本地存储） */
export interface Purchase {
  id?: number
  collectionId: number
  platform: string | null
  price: number | null
  currency: string
  note?: string | null
}

/** 单条通关路线（Galgame）：路线名依附于本地收藏，路线条数即「已通关路线数」 */
export interface RouteItem {
  id: number
  name: string
}

/** 通过 contextBridge 暴露给渲染进程的安全 API 形状 */
export interface AcgnApi {
  app: {
    getInfo: () => Promise<AppInfo>
    /** 拉取指定 tag（如 v0.3.1）的 GitHub Release 正文（更新说明）；无/失败返回 null */
    getReleaseNotes: (tag: string) => Promise<string | null>
    openExternal: (url: string) => Promise<void>
    relaunch: () => Promise<void>
    /** 运行时设置 / 清除手动代理（设置项 `proxy`）。传 null/空串即清除，免重启生效。 */
    setProxy: (url: string | null) => Promise<void>
    /** 拉取应用网络使用量统计（当月 + 近 6 月历史）。 */
    getNetworkStats: () => Promise<NetworkStatsResult>
    /** 拉取 Bangumi 可用性监测状态（bgm-status 探针，社区数据）。失败返回 null。 */
    getBgmStatus: () => Promise<BgmStatus | null>
    /** 设置窗口关闭行为：minimize=点 X 缩到托盘（默认）；exit=点 X 直接退出。 */
    setCloseBehavior: (v: 'minimize' | 'exit') => Promise<void>
    /** 当前实际生效的数据目录；custom=true 表示用户自定义过（非默认解析链） */
    getDataDir: () => Promise<{ dir: string; custom: boolean }>
    /** 在系统文件管理器中打开数据目录 */
    openDataDir: () => Promise<void>
    /** 原生目录选择器选新位置 → 校验/迁移/重启（取消返回 canceled） */
    pickDataDir: () => Promise<{ ok: boolean; canceled?: boolean; error?: string; path?: string }>
    /** 恢复默认数据位置（null）：迁移后自动重启应用；sameTarget=已在默认位置无需迁移 */
    setDataDir: (dir: null) => Promise<{ ok: boolean; sameTarget?: boolean; error?: string; path?: string }>
    /** 手动检查更新：updateAvailable=有新版本；ok=false 时附 error */
    checkUpdate: () => Promise<{ ok: boolean; updateAvailable?: boolean; version?: string; error?: string }>
    /** 在设置弹窗点「确定更新」：已下载完立即重启安装，否则标记下载完自动安装 */
    installUpdate: () => Promise<{ ok: boolean; error?: string }>
    /** 首次关闭时主进程会触发此事件（渲染层应弹出选择窗） */
    onCloseBehaviorAsk: (cb: () => void) => () => void
    /** 渲染层回复用户的选择；remember=true 时持久化（下次不再弹） */
    answerCloseBehavior: (pick: 'minimize' | 'exit', remember: boolean) => void
  }
  db: {
    query: (sql: string, params?: unknown[]) => Promise<unknown[]>
    run: (sql: string, params?: unknown[]) => Promise<{ lastInsertRowid: number; changes: number }>
  }
  api: {
    /** 统一搜索：条目（动画/书籍/游戏）或人物（角色/现实），返回联合结果 SearchResultItem[] */
    search: (query: SearchQuery) => Promise<SearchResultItem[]>
    /** 标签搜索（p1 /search/subjects）：按 tags/metaTags/type 检索作品，返回 SearchResultItem[] */
    searchByTag: (query: TagSearchQuery) => Promise<SearchResultItem[]>
    /** 按关键词搜索标签（p1 频道标签 + 过滤）：返回匹配的标签候选 [{name,count}] */
    searchTags: (payload: { keyword: string; type?: number }) => Promise<{ data: ChannelTag[]; total: number }>
    /** 频道热门标签（p1 /channels/{type}/tags）：标签搜索的联想 / 热门标签 */
    channelTags: (type: number) => Promise<{ data: ChannelTag[]; total: number }>
    /** 后台预热标签搜索缓存（进入标签模式时调用，使首次搜索秒回） */
    warmTagCache: (types: number[]) => Promise<boolean>
    /** 取 Galgame 的游戏画廊（复刻「游戏画廊」组件：VNDB 截图 / DLsite 样例 / Steam 截图，按来源分组） */
    gallery: (subjectId: number | string, force?: boolean) => Promise<GameGallery>
  }
  anime: {
    addToWatching: (subject: Subject) => Promise<{ collectionId: number; subjectId: number }>
    getDetailLocal: (subjectId: number) => Promise<AnimeDetail>
    /** 批量取本地详情（主页卡片一次 IPC 拿全部）；返回顺序与入参一一对应，失败项 subject 为 null */
    getDetailsLocal: (subjectIds: number[]) => Promise<AnimeDetail[]>
    getDetail: (subjectId: number) => Promise<AnimeDetail>
    toggleEpisode: (collectionId: number, episodeId: number) => Promise<{ watched: boolean; epStatus: number }>
    /** 标记单集状态（看过/看到/想看/抛弃）。返回更新后的完整进度映射与已看集数。 */
    setEpisodeStatus: (
      collectionId: number,
      payload: EpisodeMarkPayload
    ) => Promise<{ progress: Record<number, EpisodeProgressState>; epStatus: number }>
    listWatching: (status?: number) => Promise<AnimeWatchingItem[]>
    getStats: () => Promise<AnimeStats>
  }
  collection: {
    add: (subject: Subject, status?: number) => Promise<{ collectionId: number; subjectId: number }>
    detailLocal: (subjectId: number) => Promise<CollectionDetail>
    detail: (subjectId: number) => Promise<CollectionDetail>
    setProgress: (
      collectionId: number,
      value: number,
      kind?: 'ep' | 'vol',
      localOnly?: boolean
    ) => Promise<{ epStatus: number; volStatus: number }>
    setStatus: (collectionId: number, status: number) => Promise<{ status: number }>
    /** 设置「我的评价」评分（1-10）并同步到 Bangumi；返回同步结果 */
    setRating: (
      providerSubjectId: string,
      rating: number
    ) => Promise<{ ok: boolean; synced: boolean; error?: string; collectionId: number }>
    list: (category: Category, status: number) => Promise<CollectionItem[]>
    stats: (category: Category) => Promise<CollectionStats>
    reclassifyBooks: () => Promise<{
      total: number
      changed: number
      lightNovel: number
      manga: number
      failed: number
    }>
    /** 新建 / 更新收藏（收藏悬浮窗「保存」）：写本地库（含吐槽 / 仅自己可见 / 我的前 10 tag），
     *  已登录则同步到 Bangumi（含 tags + private），返回本地收藏 id。 */
    saveCollection: (payload: SaveCollectionPayload) => Promise<SaveCollectionResult>
    /** 删除收藏（收藏悬浮窗「删除」）：删本地收藏行 + 联结 tag，已登录则同步删除 Bangumi 收藏。 */
    deleteCollection: (providerSubjectId: string) => Promise<{ ok: true }>
    /** 查询某作品是否已收藏（返回 status + 吐槽），供详情页 / 悬浮窗渲染标签或「我想X这Y」文字。 */
    getExisting: (providerSubjectId: string) => Promise<CollectionExisting>
    /** 个人页统计悬浮窗：从本地收藏聚合的收藏数 / 完成率 / 平均分 / 标准差 / 评分数 / 评分分布 */
    userStats: () => Promise<UserStats>
    /** 取某收藏的通关路线列表（Galgame）。无收藏或空返回 [] */
    routes: (collectionId: number) => Promise<RouteItem[]>
    /** 新增一条通关路线，返回新行 id */
    routeAdd: (collectionId: number, name: string) => Promise<{ id: number }>
    /** 修改路线名称 */
    routeUpdate: (id: number, name: string) => Promise<{ ok: true }>
    /** 删除一条路线 */
    routeDelete: (id: number) => Promise<{ ok: true }>
  }
  subjectExtra: {
    /** 后台异步补全角色/CV/关联条目中文名时，主进程推送更新。payload 含 characters 与 relations */
    onCnUpdated: (
      cb: (payload: { subjectId: number; characters: any[]; relations: any[] }) => void
    ) => () => void
    /** 简介优先补全时，主进程流式推送。payload 含 subjectId 与 summary */
    onSummaryUpdated: (
      cb: (payload: { subjectId: number; summary: string }) => void
    ) => () => void
    /** 标签/制作信息离线填充后联网补全，主进程推送权威数据置换。payload 含 subjectId / tags / meta / rating / metaTags */
    onMetaUpdated: (
      cb: (payload: {
        subjectId: number
        tags: SubjectTag[]
        meta: SubjectMeta[]
        rating: number | null
        metaTags: string[]
      }) => void
    ) => () => void
  }
  purchases: {
    get: (collectionId: number) => Promise<Purchase | null>
    save: (
      collectionId: number,
      data: { platform?: string; price?: number; currency?: string; note?: string }
    ) => Promise<Purchase>
    totalSpent: (category: Category) => Promise<number>
  }
  auth: {
    getStatus: () => Promise<AuthStatus>
    saveToken: (token: string) => Promise<void>
    login: () => Promise<AuthStatus>
    getAppCredentials: () => Promise<{ appId: string; appSecret: string }>
    saveAppCredentials: (appId: string, secret: string) => Promise<void>
    logout: () => Promise<void>
    /** 取当前登录用户的头像/昵称（用于单集评论卡「自己」头像昵称显示）。未登录返回空对象 */
    getMe: () => Promise<{ username?: string; nickname?: string; avatar?: string | null }>
  }
  sync: {
    pushAll: (opts?: { episodeMarks?: boolean }) => Promise<SyncResult>
    pullAll: () => Promise<SyncResult>
    pullAllFull: () => Promise<SyncResult>
    syncAll: () => Promise<SyncResult>
    /**
     * 巡检：拉「最近有活动」的第 1 页远端收藏（1 个请求），供主页比对
     * status/rate/ep_status/vol_status 是否与远端一致（抓取取消标记等 timeline 看不见的变化）。
     */
    listRecentCollections: (limit?: number) => Promise<
      Array<{
        providerSubjectId: string
        status: number
        rate: number | null
        epStatus: number
        volStatus: number
        updatedAt: number
      }>
    >
    /** 订阅同步引擎状态变化（侧栏同步指示灯）；返回取消订阅函数 */
    onStateChanged: (cb: (s: SyncEngineState) => void) => () => void
  }
  subject: {
    /** 取 Bangumi 条目吐槽区中其它用户的吐槽（next p1 /subjects/{id}/comments，匿名可访问） */
    getComments: (subjectId: string, offset?: number) => Promise<{ comments: SubjectComment[]; total: number; notFound?: boolean }>
    /** 取角色/人物详情页评论（吐槽）：next p1 /characters|persons/{id}/comments，匿名可访问 */
    getEntityComments: (kind: 'characters' | 'persons', id: number, offset?: number, limit?: number) => Promise<{ comments: SubjectComment[]; total: number; notFound?: boolean }>
    /** 发布角色/人物评论（需登录）：POST /p1/{characters|persons}/{id}/comments */
    postEntityComment: (payload: { kind: 'characters' | 'persons'; id: number; content: string; relatedID?: number | null }) => Promise<number>
    /** 取某条目的讨论串列表（next p1 /subjects/{id}/topics，匿名可访问；按最后回复排序） */
    getTopics: (subjectId: string) => Promise<{ topics: BgmTopic[]; total: number; notFound?: boolean }>
    /** 取讨论串详情（next p1 /subjects/-/topics/{id}，含全部楼层与楼中楼，匿名可访问） */
    getTopicDetail: (topicId: number) => Promise<BgmTopicDetail | null>
    /** 全站热门条目讨论（next p1 /trending/subjects/topics，bgm 首页右侧同款，匿名可访问） */
    getTrendingTopics: (force?: boolean) => Promise<BgmTopic[]>
    /** 在讨论串下发表回复（需登录；replyTo 指向楼层 id = 楼中楼回复），返回新楼层 id */
    postTopicReply: (payload: { topicId: number; content: string; replyTo?: number | null }) => Promise<{ id: number }>
    /** 讨论楼层表情回应 toggle（需登录；端点为 subjects/-/posts/{postId}/like） */
    toggleTopicReaction: (payload: { postId: number; value: number; remove?: boolean }) => Promise<{ synced: boolean }>
    /** 取角色/人物详情（替代跳转 bgm 网页）：kind='character'|'person'，匿名亦可访问 */
    getEntity: (kind: 'character' | 'person', id: number) => Promise<EntityDetail>
    /**
     * 取作品完整详情（点击角色卡「出演作品」打开的卡片）：直接按 Bangumi 作品 id 联网拉取
     * subject + 角色 + 关联作品，匿名亦可访问。返回归一化的 SubjectFullDetail。
     * opts.withCn=false 时跳过角色/CV 中文名详情请求（首屏快开，中文名由 characters() 异步补）。
     */
    detailFull: (id: number, opts?: { withCn?: boolean; force?: boolean }) => Promise<SubjectFullDetail>
    /** 本地优先：先返回离线/缓存详情（含 Archive 站点均分、角色、关联），不联网、瞬时。悬浮窗打开即调用，再 detailFull 静默替换。 */
    detailLocal: (id: number) => Promise<SubjectFullDetail | null>
    /**
     * 单独取角色列表（含中文名，用于悬浮窗首屏后异步补全，避免阻塞打开）。
     * 结构与 SubjectFullDetail.characters 一致（SubjectCharacter[]），供前端按 id 合并。
     */
    characters: (id: number) => Promise<SubjectCharacter[]>
    /**
     * 取作品制作人员（staff）：作者 / 导演 / 原画 / 制作公司 等（Bangumi /subjects/{id}/persons，匿名可访问）。
     * 返回归一化的 SubjectPerson[]（含 id，供制作信息按名匹配后跳转人物卡）。
     * 不做额外中文名详情请求（省限流），name 直接用列表返回名。
     */
    persons: (id: number) => Promise<SubjectPerson[]>
    /**
     * 取某作品（按 Bangumi 作品 id）的本地收藏与逐集进度，供悬浮窗着色。
     * 若作品尚未加入本地收藏，返回 { collectionId: null, progress: {} }。
     */
    getProgress: (
      providerSubjectId: string
    ) => Promise<{
      collectionId: number | null
      progress: Record<number, EpisodeProgressState>
      /** 本地收藏状态（1-5）；未收藏为 null */
      status: number | null
    }>
    /**
     * 从 Bangumi 拉取该用户的单集标记并合并/对比进本地。
     * 未登录或拉取失败均回退本地进度；force=false 且本地已有标记时直接走缓存不联网（防限流）。
     * opts.force=true 强制重新联网（详情页/同步用）；opts.reconcile=true 与本地对比写入（Bangumi 权威）。
     * opts.skeleton=false 时 force 拉取跳过「真实剧集骨架」抓取（主页增量刷新用，省 2N 请求）。
     */
    pullEpisodeProgress: (
      providerSubjectId: string,
      opts?: { force?: boolean; reconcile?: boolean; skeleton?: boolean }
    ) => Promise<{
      collectionId: number | null
      progress: Record<number, EpisodeProgressState>
      episodes: SubjectFullEpisode[]
    }>
    /**
     * C' 全局短路：切栏前判断是否需实际拉取单集进度。
     * 基于 p1 timeline 第一条动态时间 vs 本地上次拉取时钟；取不到时返回 true（降级）。
     */
    shouldRefreshProgress: () => Promise<boolean>
    /** 标记一次进度拉取完成，刷新本地 lastPullAt 时钟（C' 用）。 */
    markProgressPulled: () => Promise<void>
    /** 本地上次进度拉取时钟（C'），供定向刷新计算 since。 */
    getLastPullAt: () => Promise<number>
    /**
     * 定向刷新：最近动态里晚于 sinceSec 的作品 id（memo 共享 timeline，不多发请求）。
     * null = 无法定向（异常/未登录/解析失败，调用方退化为整批）；[] = 确认无相关变化。
     */
    getRecentActivitySubjects: (sinceSec: number, limit?: number) => Promise<number[] | null>
    /** 读某作品本地缓存的剧集（瞬时，不联网），悬浮窗打开时优先用于瞬时显示真实集号/标题 */
    getEpisodes: (providerSubjectId: string) => Promise<SubjectFullEpisode[]>
    /**
     * 批量查 NSFW 标记：存档优先/主库兜底，返回 { providerSubjectId: boolean }。
     * 用于搜索卡片 / 「最近打开」封面在「显示 NSFW」关闭时的模糊。
     */
    nsfwBatch: (ids: number[]) => Promise<Record<string, boolean>>
  }
  episode: {
    /** 单集详情（v0 /episodes/{id}，匿名可访问）：标题/集号/首播/时长/简介，驱动悬浮窗上半部分 */
    getDetail: (episodeId: number) => Promise<EpisodeDetail>
    /** 单集评论（p1 /episodes/{id}/comments，匿名可访问，裸数组）。与作品吐槽同构 */
    getComments: (
      episodeId: number,
      offset?: number
    ) => Promise<{ comments: EpisodeComment[]; total: number }>
    /** 发自己的单集评论：先存本地，已登录则 best-effort 真发 Bangumi（p1 POST，需 Turnstile 验证码）。
     *  返回新评论 id 与同步状态；未登录或 Turnstile/网络失败均仅本地存储（synced=false）。 */
    addComment: (payload: {
      providerSubjectId: string
      episodeId: number
      content: string
      /** 父评论 id（发表子评论时填；顶层评论省略）。为父评论当前的 id：远程评论=provider id，本地草稿=本地 id，用于本地归并显示 */
      parentId?: number | null
      /** 父评论在 Bangumi 的真实 id（发表子评论真发时作 relatedID；父是未同步本地草稿则为 undefined） */
      relatedId?: number | null
    }) => Promise<{ id: number; synced: boolean }>
    /** 读本地单集评论（含未成功同步的草稿，mine=true） */
    listLocal: (episodeId: number) => Promise<EpisodeComment[]>
    /** 给某条评论发表/取消表情回应（贴贴）：需登录，真发 Bangumi。
     *  commentId 为 Bangumi 评论 id（远程评论=provider id；本地已同步评论=providerId）；
     *  value 为表情类别整数；remove=true 表示取消（已做过该表情再次点击）。 */
    toggleReaction: (payload: { commentId: number; value: number; remove?: boolean }) => Promise<{ synced: boolean; error?: string }>
  }
  archive: {
    /** 读取离线库元信息（版本 / 日期 / 大小 / 上次更新时间 / 状态） */
    getMeta: () => Promise<ArchiveMeta | null>
    /** 触发下载 + 校验 + 解压 + 入库（返回最终结果；进度经 onProgress 推送） */
    update: () => Promise<ArchiveUpdateResult>
    /** 离线搜索全 Bangumi 条目（按名称） */
    search: (query: string, type?: number, limit?: number) => Promise<ArchiveSubjectSearch[]>
    /** 离线库按标签过滤作品（秒显、无需联网） */
    searchByTag: (tag: string, limit?: number) => Promise<ArchiveTagSubject[]>
    /** 离线标签搜索：按关键词在离线库 tags/meta_tags 中模糊匹配标签（本地查询，快且全） */
    searchTags: (keyword: string, limit?: number) => Promise<{ data: ChannelTag[]; total: number }>
    /** 离线热门标签：本地聚合最热标签（无关键词时展示） */
    hotTags: (limit?: number) => Promise<ChannelTag[]>
    /** 离线 Archive 缺封面：匿名从 Bangumi v0 联网补图并回写 Archive 缓存；返回 { [id]: url } */
    ensureCovers: (ids: number[]) => Promise<Record<number, string>>
    /** 批量取离线库作品开播日期（YYYY-MM-DD；主页周历对 air_date 缺失的兜底）。键为 Bangumi 数字 id */
    subjectDates: (ids: number[]) => Promise<Record<number, string | null>>
    /** 订阅更新进度；返回取消订阅函数 */
    onProgress: (cb: (p: ArchiveProgress) => void) => () => void
    /** 删除整个离线数据库目录（db / wal / shm / dump.zip / extract），返回是否成功 */
    delete: () => Promise<boolean>
  }
  /** 视图层操作（渲染进程内直接执行，不经主进程 IPC）：当前仅页面缩放 */
  view: {
    /** 设置页面缩放系数（浏览器式 zoom，1 = 100%）。作用于整个渲染进程窗口，实时生效、无需重启 */
    setZoomFactor: (factor: number) => void
  }
  theme: {
    /** 截取当前窗口完整画面（旧主题真实外观，含卡片/边栏/文字），返回 PNG dataURL；
     *  供主题切换过渡遮罩使用；失败或无主窗口时返回 null */
    capture: () => Promise<string | null>
    /** 同步原生窗口背景色（缩放窗口时露出的“窗口底色”需与内容背景一致，消除黑边/色差层） */
    setNativeBg: (color: string) => Promise<void>
  }
  /** 个人中心：时间胶囊（操作历史）。数据来自 bgm.tv/user/{username}/timeline 只读 HTML 解析，
   *  因 Bangumi v0 无对应官方 API 端点，故为抓取解析，结构可能随网页改版变动。 */
  personal: {
    /** 拉取指定用户的时间胶囊动态（动作/封面/标题/时间/评论），支持分页。
     *  page 仅用于前端展示页码；实际翻页走 until 游标（p1 接口忽略 offset）。 */
    timeline: (username: string, page?: number, until?: string | null) => Promise<TimelinePage>
  }
  /** 缓存管理：统计并清理可重新抓取的本地辅助缓存（剧集/角色/关联作品/画廊）。
   *  不触碰用户数据（收藏/进度/评论）与离线数据库。 */
  cache: {
    /** 统计本机缓存体积与各类缓存条目数 */
    stats: () => Promise<CacheStats>
    /** 清除可重新抓取的本地缓存（剧集/角色/关联作品/画廊 + 图片字节缓存），返回清理后统计 */
    clear: () => Promise<CacheStats>
    /** 手动裁剪「半年前」缓存，返回清理后统计 */
    prune: () => Promise<CacheStats>
  }
  /** 备份与恢复：导出为在线一致性 SQLite 备份；恢复前自动留存当前库应急副本（userData/backups） */
  backup: {
    exportBackup: () => Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>
    importBackup: () => Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>
    /** 收藏数据轻量导出（CSV/JSON，单向，不可导回应用） */
    exportCollections: (format: 'csv' | 'json') => Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>
  }
  /** 自定义窗口控制（替代原生标题栏）：最小化 / 最大化切换 / 关闭 / 查询与订阅最大化状态 / 拖拽缩放 */
  win: {
    /** 最小化窗口 */
    minimize: () => Promise<void>
    /** 切换最大化 / 还原 */
    toggleMaximize: () => Promise<void>
    /** 关闭窗口（受主进程「关闭行为」逻辑约束：缩到托盘或直接退出） */
    close: () => Promise<void>
    /** 当前是否处于最大化状态 */
    isMaximized: () => Promise<boolean>
    /** 订阅最大化状态变化（最大化/还原时主进程推送） */
    onMaximizedChange: (cb: (maximized: boolean) => void) => () => void
    /** 窗口聚焦/失焦通知（失焦时标题栏整体变暗） */
    onActiveChange: (cb: (active: boolean) => void) => () => void
    /** 取当前窗口位置与尺寸 */
    getBounds: () => Promise<{ x: number; y: number; width: number; height: number }>
    /** 设置窗口位置与尺寸（用于边缘拖拽缩放） */
    setBounds: (bounds: { x: number; y: number; width: number; height: number }) => Promise<void>
    /** 自定义贴靠：把窗口吸附到当前显示器的半屏 / 四象限 / 最大化 */
    snap: (zone: 'left' | 'right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'maximize') => Promise<void>
  }
  /** 插件系统：用户全权决策权限 + 轻量运行时拦截。插件本地手动安装于 userData/plugins/<id>/ */
  plugins: {
    /** 插件清单（含启停状态、已授权权限、样式/脚本内容） */
    list: () => Promise<PluginDescriptor[]>
    /** 设置插件启停（enabled=true 启用）。返回更新后的清单 */
    setEnabled: (id: string, enabled: boolean) => Promise<PluginDescriptor[]>
    /** 设置插件某权限授予/撤销。返回更新后的清单 */
    setPermission: (id: string, permission: PluginPermission, granted: boolean) => Promise<PluginDescriptor[]>
/** 插件经白名单调用应用 API（权限过滤在主进程）；返回 { ok: true, data } / { ok: false, error } */
  call: (id: string, method: string, args: unknown[]) => Promise<{ ok: boolean; data?: unknown; error?: string }>
    /** 在系统文件管理器中打开插件目录 */
    openDir: () => Promise<void>
    /** 重新扫描插件目录（新增/删除插件后刷新清单） */
    rescan: () => Promise<PluginDescriptor[]>
    /** 打开目录选择器安装插件（复制到插件目录）；canceled=用户取消 */
    install: () => Promise<{ ok: boolean; canceled?: boolean; error?: string; name?: string; version?: string }>
    /** 删除插件（移除目录 + 清理状态）；canceled=用户取消 */
    remove: (id: string) => Promise<{ ok: boolean; canceled?: boolean; error?: string }>
  }
}

/** 插件可用权限（用户全权勾选授予；未授予的调用在运行时被拦截） */
export type PluginPermission =
  | 'style'         // 注入样式
  | 'script'        // 执行插件脚本
  | 'storage'       // 插件独立存储（读写）
  | 'collection'    // 读取收藏数据
  | 'subject'       // 读取作品数据
  | 'settings'      // 读取/修改应用设置
  | 'ui'            // 挂载 UI 组件 / 弹提示
  | 'network'       // 跨站网络请求（VNDB/MAL/AniList 等代理搜索）

/** 插件描述（渲染端清单条目） */
export interface PluginDescriptor {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  /** 是否启用 */
  enabled: boolean
  /** 已授予的权限集合 */
  permissions: PluginPermission[]
  /** manifest 声明的全部权限 */
  requestedPermissions: PluginPermission[]
  /** 样式内容（未启用时为空） */
  css?: string
  /** 脚本内容（未启用时为空） */
  script?: string
}

/** 插件 manifest（用户手写于 userData/plugins/<id>/manifest.json） */
export interface PluginManifest {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  /** 入口文件（相对插件目录） */
  entry?: {
    style?: string
    render?: string
  }
  /** 申请的全部权限 */
  permissions: PluginPermission[]
}

/** 时间胶囊里涉及的作品引用（单条目 1 个，多条目如「想读 X、Y 2 本书」为多个） */
export interface TimelineSubjectRef {
  /** 条目 ID */
  subjectId: number
  /** 封面 URL（https://lain.bgm.tv/...） */
  cover?: string
  /** 显示名（中文名优先） */
  title?: string
  /** 原名 */
  subtitle?: string
}

/** 时间胶囊单条动态（解析自 bgm.tv/user/{username}/timeline 的只读 HTML） */
export interface TimelineItem {
  /** 动态 id（tml_{id}） */
  id: string
  /** 分组标题（时间线页面按日期分组的 h4.Header，如「今天」「昨天」「2026-8-9」） */
  group: string
  /** 动作动词：在玩 / 看过 / 想看 / 完成了 / 在听 / 想听 / 读过 / 想读 / 在看 / 想玩 … */
  action: string
  /** 首行完整文本：动作词 +（ep 标题 | 条目原名 | 多个条目名）。与 Bangumi 网页显示一致，
   *  如「看过 ep.4 燃灯与灰火」「读过 涼宮ハルヒ シリーズ」「想读 X、Y 2 本书」 */
  actionLine: string
  /** 涉及的作品（单条目 1 个；多条目如「想读 X、Y 2 本书」为多个）。封面左右排列用此数组 */
  subjects: TimelineSubjectRef[]
  /** 主作品 ID（= subjects[0].subjectId），向后兼容 */
  subjectId: number
  /** 主标题（= subjects[0].title），向后兼容 */
  title?: string
  /** 原名（= subjects[0].subtitle），向后兼容 */
  subtitle?: string
  /** 封面 URL（= subjects[0].cover），向后兼容 */
  cover?: string
  /** 看过/在读某集时的单集信息：ep 链接文本，如「ep.4 燃灯与灰火」「第8话 …」 */
  episode?: string
  /** 单集 ID（subject/ep/{id}），仅看/读单集时有 */
  episodeId?: number
  /** 元信息行：话数 / 发售日 / 平台 / 制作等（来自 p.info.tip） */
  info?: string
  /** 用户本人对该作品的评分（0-10，来自 rateInfo 的 starlight starsN）。
   *  仅「看过/读过/玩过/完成/在看/在玩…」等已收藏动作才有；「想看/想玩/想读」未评分无此值。
   *  渲染用金色。单集 / 多条目动态不显示评分，故为 undefined。 */
  myRating?: number
  /** Bangumi 站点总评分（来自 rateInfo 的 fade，如 5.1）。渲染用灰色。 */
  siteRating?: number
  /** 站点评分人数（来自 rate_total，如 199） */
  siteRatingCount?: number
  /** 站点排名（来自 rank，如 #1） */
  rank?: string
  /** 是否显示评分区：单集(episodeId)或多条目(subjects>1)为 false，其余为 true */
  showRating: boolean
  /** 用户评论（可能为空） */
  comment?: string
  /** 相对时间，如「2小时37分钟前」「13小时59分钟前」 */
  time: string
  /** 绝对时间（title 属性），如「2026-8-10 16:01」 */
  timeAbs?: string
  /** 来源角标：如 web / mobile / API（本应用经私有接口产生归为 API） */
  source?: string
}

/** 时间胶囊单页数据（解析自 bgm.tv/user/{username}/timeline 的只读 HTML） */
export interface TimelinePage {
  /** 本页动态列表 */
  items: TimelineItem[]
  /** 当前页码（从 1 开始） */
  page: number
  /** 是否有上一页 */
  hasPrev: boolean
  /** 是否有下一页 */
  hasNext: boolean
  /** 下一页游标：传给下次请求的 until 参数（p1 按动态 id 游标翻页）；无更多时为 null */
  nextUntil?: string | null
}
