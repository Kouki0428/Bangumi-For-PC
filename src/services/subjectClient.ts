import type {
  SubjectComment,
  EntityDetail,
  SubjectFullDetail,
  SubjectCharacter,
  SubjectPerson,
  EpisodeProgressState,
  SubjectFullEpisode,
  BgmTopic,
  BgmTopicDetail
} from '@shared/types'

/** 条目维度客户端：当前用于拉取 Bangumi 条目吐槽区中其它用户的吐槽，以及角色/人物/作品详情 */
export const subjectClient = {
  getComments: (subjectId: string, offset = 0) =>
    window.acgn.subject.getComments(subjectId, offset) as Promise<{
      comments: SubjectComment[]
      total: number
      notFound?: boolean
    }>,
  getEntityComments: (kind: 'characters' | 'persons', id: number, offset = 0, limit = 200) =>
    window.acgn.subject.getEntityComments(kind, id, offset, limit) as Promise<{
      comments: SubjectComment[]
      total: number
      notFound?: boolean
    }>,
  postEntityComment: (payload: { kind: 'characters' | 'persons'; id: number; content: string; relatedID?: number | null }) =>
    window.acgn.subject.postEntityComment(payload) as Promise<number>,
  /** 某条目的讨论串列表（p1，匿名可访问；按最后回复排序） */
  getTopics: (subjectId: string): Promise<{ topics: BgmTopic[]; total: number; notFound?: boolean }> =>
    window.acgn.subject.getTopics(subjectId),
  /** 讨论串详情（全部楼层+楼中楼，匿名可访问） */
  getTopicDetail: (topicId: number): Promise<BgmTopicDetail | null> =>
    window.acgn.subject.getTopicDetail(topicId),
  /** 全站热门条目讨论（bgm 首页右侧同款）。force=true 时绕过缓存强制刷新（「刷新」按钮） */
  getTrendingTopics: (force?: boolean): Promise<BgmTopic[]> => window.acgn.subject.getTrendingTopics(force),
  /** 在讨论串下发表回复（需登录；replyTo=楼层 id 为楼中楼） */
  postTopicReply: (payload: { topicId: number; content: string; replyTo?: number | null }) =>
    window.acgn.subject.postTopicReply(payload) as Promise<{ id: number }>,
  /** 讨论楼层表情回应 toggle（需登录） */
  toggleTopicReaction: (payload: { postId: number; value: number; remove?: boolean }) =>
    window.acgn.subject.toggleTopicReaction(payload) as Promise<{ synced: boolean }>,
  /** 取角色/人物详情（替代跳转 bgm 网页） */
  getEntity: (kind: 'character' | 'person', id: number): Promise<EntityDetail> =>
    window.acgn.subject.getEntity(kind, id),
  /** 取作品完整详情（点击角色卡「出演作品」打开的卡片）；withCn=false 首屏快开，中文名再用 getCharacters 补 */
  detailFull: (id: number, opts?: { withCn?: boolean }): Promise<SubjectFullDetail> =>
    window.acgn.subject.detailFull(id, opts),
  /** 本地优先：先返回离线/缓存详情（含 Archive 站点均分、角色、关联），不联网、瞬时。悬浮窗打开即调用，再 detailFull 静默替换 */
  detailLocal: (id: number): Promise<SubjectFullDetail | null> =>
    window.acgn.subject.detailLocal(id),
  /** 首屏后异步补全角色/CV 中文名（结构与 detailFull.characters 一致，前端按 id 合并） */
  getCharacters: (id: number): Promise<SubjectCharacter[]> =>
    window.acgn.subject.characters(id),
  /** 取作品制作人员（staff：作者/导演/原画/制作公司 等），供制作信息按名匹配后跳转人物卡 */
  getPersons: (id: number): Promise<SubjectPerson[]> =>
    window.acgn.subject.persons(id),
  /** 取某作品本地收藏与逐集进度（悬浮窗剧集着色用） */
  getProgress: (providerSubjectId: string) =>
    window.acgn.subject.getProgress(providerSubjectId) as Promise<{
      collectionId: number | null
      progress: Record<number, EpisodeProgressState>
    }>,
  /** 从 Bangumi 拉取单集标记并合并/对比进本地（详情页 force+reconcile；悬浮窗缓存模式）。
   *  force 模式会同时返回真实剧集骨架 episodes，使首次打开即可即时显色。 */
  pullEpisodeProgress: (providerSubjectId: string, opts?: { force?: boolean; reconcile?: boolean; skeleton?: boolean }) =>
    window.acgn.subject.pullEpisodeProgress(providerSubjectId, opts) as Promise<{
      collectionId: number | null
      progress: Record<number, EpisodeProgressState>
      episodes: SubjectFullEpisode[]
    }>,
  shouldRefreshProgress: () => window.acgn.subject.shouldRefreshProgress() as Promise<boolean>,
  markProgressPulled: () => window.acgn.subject.markProgressPulled() as Promise<void>,
  getLastPullAt: () => window.acgn.subject.getLastPullAt() as Promise<number>,
  getRecentActivitySubjects: (sinceSec: number, limit?: number) =>
    window.acgn.subject.getRecentActivitySubjects(sinceSec, limit) as Promise<number[] | null>,
  /** 取某作品本地缓存的剧集（瞬时，不联网），悬浮窗打开时优先用于瞬时显示真实集号/标题 */
  getEpisodes: (providerSubjectId: string): Promise<SubjectFullEpisode[]> =>
    window.acgn.subject.getEpisodes(providerSubjectId),
  /** 批量查 NSFW 标记（存档优先/主库兜底），搜索结果与最近打开封面模糊用 */
  nsfwBatch: (ids: number[]): Promise<Record<string, boolean>> =>
    window.acgn.subject.nsfwBatch(ids)
}
