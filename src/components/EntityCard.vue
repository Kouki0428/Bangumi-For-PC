<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { EntityDetail, EntityWorkItem, SubjectCharacter } from '@shared/types'
import { proxyImg } from '@/utils/imgProxy'
import { subjectClient } from '@/services/subjectClient'
import { useEntityCard } from '@/composables/useEntityCard'
import { useSearchOverlay } from '@/composables/searchOverlay'
import { useImagePreview } from '@/composables/useImagePreview'
import { useSettingsStore } from '@/stores/settings'
import EntityCommentSection from '@/components/EntityCommentSection.vue'

// 注意：本组件现为「单一 overlay 容器」EntitySubjectCard 的内嵌 body（角色/CV），
// 外层遮罩、层级(z-index)、Esc/背景点击关闭均由宿主统一管理，这里只负责面板内容。
const { isOpen, state, push, close, back } = useEntityCard()
const searchOverlay = useSearchOverlay()
const { openImage: openEntityImg } = useImagePreview()
// 关闭按钮（X）：从搜索点进来的实体卡，点 X 应「连搜索一起关掉」回到主页，而非退回搜索。
// 直接调 searchOverlay.close()——若搜索此刻没开（从详情页打开的实体卡）则为无害空操作。
function closeAll() {
  close()
  searchOverlay.close()
}

// 头部箭头：返回上一级（卡片导航栈上一层的角色/CV/作品）。已在栈根（首个打开的实体）时
// back() 返回 false，则直接关闭卡片（回到背后的详情页），与详情页「返回」语义一致。
function goBack() {
  if (!back()) close()
}

const entity = ref<EntityDetail | null>(null)
const loading = ref(false)
const error = ref('')
const settings = useSettingsStore()

async function load() {
  const s = state.value
  // 作品卡（subject）由 SubjectCard 自行拉取；单集评论（episode）由 EpisodeCommentModal 处理；
  // 标签作品列表（tag）由 TagWorksCard 处理；讨论板（topic）由 TopicBoardModal 处理。
  // EntityCard 只负责角色 / CV 两类。
  if (!s || s.kind !== 'character' && s.kind !== 'person') return
  loading.value = true
  error.value = ''
  try {
    entity.value = await subjectClient.getEntity(s.kind, s.id)
  } catch (e) {
    error.value = '加载失败：' + (e instanceof Error ? e.message : String(e))
    entity.value = null
  } finally {
    loading.value = false
  }
}

// 角色卡的「关联角色」= 同作品其他角色（Bangumi 无关联角色端点，由详情页传入）
const relatedChars = computed<EntityWorkItem[]>(() => {
  const s = state.value
  if (!s || s.kind !== 'character') return []
  return s.siblings
    .filter((c: SubjectCharacter) => c.id !== s.id)
    .map((c) => ({
      id: c.id,
      name: c.name,
      nameCn: c.nameCn ?? '',
      image: c.image ?? '',
      relation: c.relation,
      // 角色卡「关联角色」每行右侧展示 CV（来自详情页角色列表的 actors），并保留 id 以便点击跳转
      cvs: (c.actors ?? [])
        .map((a) => ({ id: a.id, name: a.nameCn || a.name }))
        .filter((x) => x.name)
    }))
})

function isUrl(v: string): boolean {
  return /^https?:\/\//i.test(v)
}
function openExternal(url: string) {
  window.acgn.app.openExternal(url).catch(() => {})
}
// 在卡片内跳转到某角色：保留当前同作品上下文（去掉自身），便于继续在关联角色间穿梭
function openCharacterFromCard(c: EntityWorkItem) {
  const cur = state.value
  const sibs = cur?.kind === 'character' ? cur.siblings.filter((x) => x.id !== c.id) : []
  push('character', c.id, sibs)
}
// 在卡片内跳转到某 CV（人物卡）：从「关联角色」右侧的 CV 标签点入
function openCv(id: number) {
  push('person', id, [])
}
// 在卡片内跳转到某作品（角色卡的「出演作品」/ 人物卡的「参与作品」）→ 打开作品卡片
function openSubject(id: number) {
  push('subject', id)
}
// 作品条目职务展示：优先合并 relations（同一人在同一作品多职务，用「 / 」连接），无则回退 relation。
function relLabel(w: EntityWorkItem): string {
  const arr = (w.relations && w.relations.length ? w.relations : [w.relation]).filter(Boolean)
  return arr.join(' / ')
}
function hasRel(w: EntityWorkItem): boolean {
  return !!(w.relation || (w.relations && w.relations.length))
}

// Bangumi 人物 career 官方枚举仅 7 个：producer/mangaka/artist/seiyu/writer/illustrator/actor
const CAREER_LABELS: Record<string, string> = {
  seiyu: '声优',
  voice_actor: '声优',
  artist: '歌手',
  singer: '歌手',
  producer: '制作人',
  writer: '编剧',
  mangaka: '漫画家',
  illustrator: '画师',
  actor: '演员'
}
// Bangumi 人物 type（PersonType）：1=个人 2=公司 3=组合（注意：这是「组织类型」而非性别）。
// 仅「公司/组合」有展示价值，个人(type=1)不显示，避免噪音。
const TYPE_LABELS: Record<number, string> = { 2: '公司', 3: '组合' }

// 左侧信息栏：Bangumi infobox 条目（简体中文名/别名/性别/生日…）之上，
// 合成一行「职业」（人物卡专属：公司/组合 + 声优/歌手/制作人…）。角色卡无此行。
const leftInfoRows = computed<{ key: string; value: string }[]>(() => {
  const e = entity.value
  const rows: { key: string; value: string }[] = []
  if (e && e.kind === 'person') {
    const meta: string[] = []
    if (e.type != null && TYPE_LABELS[e.type]) meta.push(TYPE_LABELS[e.type])
    if (Array.isArray(e.career)) {
      for (const c of e.career) {
        const lbl = CAREER_LABELS[c] ?? c
        if (lbl && !meta.includes(lbl)) meta.push(lbl)
      }
    }
    if (meta.length) rows.push({ key: '职业', value: meta.join('、') })
  }
  for (const it of e?.infobox ?? []) rows.push(it)
  return rows
})

// 声优（career 含 seiyu）：人物卡隐藏「参与作品」，否则会刷出大量主题曲专辑/角色歌
const isSeiyu = computed<boolean>(() => !!entity.value?.career?.includes('seiyu'))

// 人物卡「出演角色 / 参与作品」排序：点进卡片默认倒序（最新出演/参与在最上），点击标题右侧按钮切换为顺序
const charSort = ref<'asc' | 'desc'>('desc')
const workSort = ref<'asc' | 'desc'>('desc')
const charSortLabel = computed(() => (charSort.value === 'asc' ? '顺序' : '倒序'))
const workSortLabel = computed(() => (workSort.value === 'asc' ? '顺序' : '倒序'))
function toggleCharSort() {
  charSort.value = charSort.value === 'asc' ? 'desc' : 'asc'
}
function toggleWorkSort() {
  workSort.value = workSort.value === 'asc' ? 'desc' : 'asc'
}
// 通用：按 key 排序，缺 key（undefined）恒排最后，与方向无关；双方都有 key 才按方向反转。
// 缺日期哨兵 '9999-99-99' 为最大 → 缺 key 方在两种方向都沉底，避免倒序时把哨兵翻到最前。
const MISSING = '9999-99-99'
function sortByKey<T>(
  items: T[] | undefined,
  dir: 'asc' | 'desc',
  getKey: (x: T) => string | undefined
): T[] {
  if (!items) return []
  return [...items].sort((a, b) => {
    const da = getKey(a) || MISSING
    const db = getKey(b) || MISSING
    const aMiss = da === MISSING
    const bMiss = db === MISSING
    if (aMiss && bMiss) return 0
    if (aMiss) return 1
    if (bMiss) return -1
    const cmp = da < db ? -1 : da > db ? 1 : 0
    return dir === 'asc' ? cmp : -cmp
  })
}
// 出演角色的排序键（来自其关联作品 c.works 的 date）：
//  - 仅 1 部关联作品 → 用该部时间；
//  - 多部关联作品 → 倒序用「最新作品」时间，正序用「最早作品」时间；
//  - 无任何时间（单部无时间 / 全部无时间 / 无关联作品）→ undefined（绝沉底）。
function charSortKey(c: EntityWorkItem, dir: 'asc' | 'desc'): string | undefined {
  const works = c.works
  if (!works || !works.length) return undefined
  const dates = works.map((w) => w.date).filter((d): d is string => !!d)
  if (!dates.length) return undefined
  if (works.length === 1) return dates[0]
  let best = dates[0]
  for (const d of dates) {
    if (dir === 'desc' ? d > best : d < best) best = d
  }
  return best
}
// 默认倒序（最新出演/参与在最上）。
const displayCharacters = computed<EntityWorkItem[]>(() =>
  sortByKey(entity.value?.characters, charSort.value, (c) => charSortKey(c, charSort.value))
)
const displayWorks = computed<EntityWorkItem[]>(() =>
  sortByKey(entity.value?.works, workSort.value, (w) => w.date)
)

watch(
  () => [isOpen.value, state.value?.id, state.value?.kind],
  () => {
    if (isOpen.value && state.value) {
      entity.value = null
      // 每次进入人物卡，排序复位为默认「倒序」（最新出演/参与在最上）
      charSort.value = 'desc'
      workSort.value = 'desc'
      load()
    }
  },
  { immediate: true }
)
</script>

<template>
    <div class="entity-card" :class="{ 'glow-card': settings.immersiveGlow && settings.subjectCardGlow }" @click.stop>
      <div
        v-if="settings.characterBanner && entity?.image"
        class="detail-banner entity-banner"
        :style="{ backgroundImage: `url(${proxyImg(entity.image)})` }"
      ></div>
      <div class="entity-head">
      <button class="entity-back back-btn" type="button" title="返回上级" aria-label="返回上级" @click="goBack">
        <svg class="back-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" y1="12" x2="4" y2="12" /><polyline points="10,5 4,12 10,19" /></svg>
      </button>
      <span class="title">{{ entity?.name || (loading ? '加载中…' : '详情') }}</span>
      <button class="close" type="button" title="关闭" aria-label="关闭" @click="closeAll">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round">
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="18" y1="6" x2="6" y2="18" />
        </svg>
      </button>
    </div>

    <div v-if="loading" class="entity-body">
      <div class="ph">加载中…</div>
    </div>
    <div v-else-if="error" class="entity-body">
      <div class="ph err">{{ error }}</div>
    </div>

    <div v-else-if="entity" class="entity-body">
      <!-- 左侧：立绘（原比例，宽适配列宽、高不裁剪）+ 信息 -->
      <div class="entity-left">
        <img v-if="entity.image" :src="proxyImg(entity.image)" class="entity-img" :alt="entity.name" @click.stop="openEntityImg(proxyImg(entity.image), entity.name)" style="cursor: pointer" />
        <div v-else class="entity-img entity-img--empty">无立绘</div>
        <div class="entity-info">
          <div v-for="it in leftInfoRows" :key="it.key" class="info-row">
            <template v-if="isUrl(it.value)">
              <span class="k">{{ it.key }}：</span><a class="v link" @click="openExternal(it.value)">{{ it.value }}</a>
            </template>
            <template v-else-if="it.value">
              <span class="k">{{ it.key }}：</span><span class="v">{{ it.value }}</span>
            </template>
            <template v-else>
              <span class="v">{{ it.key }}</span>
            </template>
          </div>
        </div>
      </div>

      <!-- 右侧：介绍 + 出演作品/角色 + 关联角色（可滚动） -->
      <div class="entity-right">
        <div class="sec" v-if="entity.summary">
          <h4>{{ entity.kind === 'character' ? '角色介绍' : '人物介绍' }}</h4>
          <p class="entity-summary">{{ entity.summary }}</p>
        </div>

        <!-- 角色卡：出演作品 → 关联角色（无数据整块隐藏） -->
        <template v-if="entity.kind === 'character'">
          <div class="sec" v-if="entity.works && entity.works.length">
            <h4>出演作品</h4>
            <div class="works">
              <button
                v-for="w in entity.works"
                :key="'w' + w.id"
                class="work-item work-btn"
                type="button"
                @click="openSubject(w.id)"
              >
                <img v-if="w.image" :src="proxyImg(w.image)" class="work-img work-cover" :alt="w.name" />
                <span v-else class="work-img work-img--empty">无封面</span>
                <div class="work-meta">
                  <div class="wn">{{ w.nameCn || w.name }}</div>
                  <div v-if="hasRel(w)" class="wr">{{ relLabel(w) }}</div>
                </div>
              </button>
            </div>
          </div>
          <div class="sec" v-if="relatedChars.length">
            <h4>关联角色</h4>
            <div class="works">
              <button
                v-for="c in relatedChars"
                :key="'r' + c.id"
                class="work-item work-btn rel-row"
                type="button"
                @click="openCharacterFromCard(c)"
              >
                <img v-if="c.image" :src="proxyImg(c.image)" class="work-img work-avatar" :alt="c.name" />
                <span v-else class="work-img work-img--empty">无立绘</span>
                  <div class="work-meta">
                    <div class="wn">{{ c.nameCn || c.name }}</div>
                    <div v-if="hasRel(c)" class="wr">{{ relLabel(c) }}</div>
                  </div>
                <div class="rel-cv" v-if="c.cvs && c.cvs.length">
                  <span class="rel-cv-tag">CV：</span>
                  <span
                    v-for="(cv, i) in c.cvs"
                    :key="'cv' + i"
                    :class="['rel-cv-name', { link: cv.id }]"
                    @click.stop="cv.id ? openCv(cv.id) : null"
                  >{{ cv.name }}<template v-if="i < c.cvs.length - 1">、</template></span>
                </div>
              </button>
            </div>
          </div>
        </template>

        <!-- 人物卡：出演角色 → 参与作品（无数据整块隐藏；声优隐藏参与作品避免主题曲/角色歌刷屏） -->
        <template v-else>
          <div class="sec" v-if="entity.characters && entity.characters.length">
            <div class="sec-head">
              <h4>出演角色</h4>
              <button
                class="sec-sort-btn"
                type="button"
                :title="charSort === 'asc' ? '当前：顺序（点击切换为倒序）' : '当前：倒序（点击切换为顺序）'"
                @click="toggleCharSort"
              >{{ charSortLabel }}</button>
            </div>
            <div class="works">
              <button
                v-for="c in displayCharacters"
                :key="'c' + c.id"
                class="work-item work-btn char-row"
                type="button"
                @click="openCharacterFromCard(c)"
              >
                <div class="char-left">
                  <img v-if="c.image" :src="proxyImg(c.image)" class="work-img work-avatar" :alt="c.name" />
                  <span v-else class="work-img work-img--empty">无立绘</span>
                  <div class="char-main">
                    <div class="wn">{{ c.nameCn || c.name }}</div>
                    <div v-if="hasRel(c)" class="wr">{{ relLabel(c) }}</div>
                  </div>
                </div>
                <div class="char-works" v-if="c.works && c.works.length">
                  <div
                    v-for="w in c.works"
                    :key="'cw' + w.id"
                    class="cwork link"
                    @click.stop="openSubject(w.id)"
                  >
                    <span class="cw-name">{{ w.nameCn || w.name }}</span>
                    <span v-if="hasRel(w)" class="cw-rel">{{ relLabel(w) }}</span>
                  </div>
                </div>
              </button>
            </div>
          </div>
          <div class="sec" v-if="entity.works && entity.works.length && !isSeiyu">
            <div class="sec-head">
              <h4>参与作品</h4>
              <button
                class="sec-sort-btn"
                type="button"
                :title="workSort === 'asc' ? '当前：顺序（点击切换为倒序）' : '当前：倒序（点击切换为顺序）'"
                @click="toggleWorkSort"
              >{{ workSortLabel }}</button>
            </div>
            <div class="works">
              <button
                v-for="w in displayWorks"
                :key="'pw' + w.id"
                class="work-item work-btn"
                type="button"
                @click="openSubject(w.id)"
              >
                <img v-if="w.image" :src="proxyImg(w.image)" class="work-img work-cover" :alt="w.name" />
                <span v-else class="work-img work-img--empty">无封面</span>
                <div class="work-meta">
                  <div class="wn">{{ w.nameCn || w.name }}</div>
                  <div v-if="hasRel(w)" class="wr">{{ relLabel(w) }}</div>
                </div>
              </button>
            </div>
          </div>
        </template>

        <!-- 角色/人物评论（吐槽）：复用单集评论风格 -->
        <EntityCommentSection
          :entity-kind="entity.kind === 'character' ? 'characters' : 'persons'"
          :entity-id="entity.id"
          :glow="settings.immersiveGlow && settings.subjectCardGlow"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.entity-card {
  width: 100%;
  max-width: none;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow);
  overflow: hidden;
  /* 横幅的定位上下文 + 独立层叠上下文：让 .entity-banner(z-index:-1) 只垫在本卡内容之下、不溢出到悬浮窗外 */
  position: relative;
  isolation: isolate;
}
/* 悬浮窗本体沉浸光感（设置 subjectCardGlow 独立控制）：整卡背景半透明让立绘横幅透出 */
.entity-card.glow-card {
  background: color-mix(in srgb, var(--bg-panel) calc(70% * var(--glass-k)), transparent);
}
/* 人物/角色横幅：复用 .detail-banner 的模糊/饱和/遮罩，但改为「内含」于圆角卡片（不溢出），
   顶部不透明以便标题栏浮于光晕之上，向下渐隐 */
.entity-banner {
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  height: 100%;
  z-index: -1;
  /* 复位页面横幅的 aspect-ratio，否则宽会被算成高度×2/3、左右铺不满 */
  aspect-ratio: auto;
  /* 覆盖整个悬浮窗：图片上缘对齐顶部、按原比例放大铺满、不变形；底部不渐隐 */
  background-position: center top;
  background-size: cover;
  -webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 100%);
  mask-image: linear-gradient(to bottom, #000 0%, #000 100%);
}
.entity-head {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-soft);
}
.entity-head .title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 关闭按钮：与搜索卡片的叉一致（34px 圆形、hover 高亮） */
.entity-head .close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  margin-left: auto;
  border: none;
  background: var(--bg-elev);
  color: var(--text-dim);
  cursor: pointer;
  border-radius: 50%;
  transition: background 0.15s ease, color 0.15s ease;
}
.entity-head .close svg {
  width: 16px;
  height: 16px;
  display: block;
}
.entity-head .close:hover {
  background: var(--accent);
  color: #fff;
}
.entity-head .close:active {
  background: #ff3d77;
  color: #fff;
  transform: scale(0.94);
}
.entity-body {
  display: flex;
  gap: 16px;
  padding: 16px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
.entity-left {
  flex: 0 0 190px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}
.entity-img {
  width: 100%;
  height: auto;
  object-fit: contain;
  background: var(--bg-deep);
  border-radius: var(--radius-sm);
  display: block;
}
.entity-img--empty {
  aspect-ratio: 3 / 4;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--text-dim);
}
.entity-info {
  font-size: 12px;
  line-height: 1.5;
}
.info-row {
  display: flex;
  gap: 4px;
  padding: 1px 0;
}
.info-row .k {
  color: var(--text-dim);
  flex: 0 0 auto;
}
.info-row .v {
  color: var(--text);
  word-break: break-all;
}
.info-row .v.link {
  color: var(--accent-2);
  cursor: pointer;
  text-decoration: underline dotted;
}
.entity-right {
  flex: 1;
  min-width: 0;
}
.sec {
  margin-bottom: 16px;
}
.sec h4 {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
/* 区块标题行：标题在左、排序切换按钮在右 */
.sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.sec-head h4 {
  margin: 0;
}
.sec-sort-btn {
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  color: var(--text);
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 4px 10px;
  cursor: pointer;
  transition: all 0.15s ease;
  flex-shrink: 0;
}
.sec-sort-btn:hover {
  border-color: var(--accent-2);
  color: var(--accent-2);
}
.entity-summary {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text);
  white-space: pre-wrap;
}
.works {
  display: flex;
  flex-direction: column;
  gap: 0;
}
/* 出演作品 / 关联角色 / 出演角色 各条目之间用横线分割 */
.works .work-item + .work-item {
  border-top: 1px solid var(--border-soft);
}
.work-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 4px;
  border-radius: var(--radius-sm);
  text-align: left;
}
.work-btn {
  border: none;
  background: transparent;
  cursor: pointer;
  transition: background 0.15s ease;
}
/* 激活态用半透明底，让人物横幅透过来融为一体，而非用不透明实色块盖住横幅 */
.work-btn:hover {
  background: color-mix(in srgb, var(--bg-elev) 45%, transparent);
}
.work-btn:active {
  background: color-mix(in srgb, var(--bg-elev) 65%, transparent);
}
/* 关联角色：角色名在左，CV 推到右侧 */
.rel-row {
  align-items: center;
}
.rel-cv {
  margin-left: auto;
  flex-shrink: 0;
  max-width: 48%;
  padding-left: 10px;
  text-align: right;
  font-size: 11px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rel-cv-tag {
  color: var(--text-dim);
}
.rel-cv-name {
  color: var(--text-dim);
}
.rel-cv-name.link {
  cursor: pointer;
  color: var(--accent-2);
  text-decoration: underline dotted;
}
.rel-cv-name.link:hover {
  color: var(--text);
}
/* 人物卡「出演角色」：左侧角色头像+名，右侧该角色的出演作品（竖排、仅作品间小横线） */
.char-row {
  /* 整行贴顶对齐：照片位置保持原样（贴顶），不被居中到整栏。 */
  align-items: flex-start;
}
/* 左侧「照片 + 名/位」作为一个整体：高度由照片决定（贴顶占满），
   名+位在其中垂直居中 → 与照片上下居中对齐，且不改变照片自身位置/尺寸/裁切。 */
.char-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}
.char-main {
  flex: 0 0 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.char-works {
  margin-left: auto;
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding-left: 10px;
  text-align: right;
}
.cwork {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  padding: 0;
  min-width: 0;
  text-align: right;
}
/* 出演作品可点击：跳转至该作品的悬浮窗（@click.stop 防止冒泡触发角色行点击） */
.cwork.link {
  cursor: pointer;
}
.cwork.link:hover .cw-name {
  color: var(--accent-2);
}
/* 多个出演作品之间用小横线分割，横线位于相邻作品正中（仅横跨作品列） */
.cwork:not(:last-child) {
  border-bottom: 1px solid var(--border-soft);
}
.cw-name {
  font-size: 12px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.cw-rel {
  font-size: 11px;
  color: var(--text-dim);
  flex-shrink: 0;
}
.work-img {
  width: 48px;
  height: 66px;
  border-radius: var(--radius-sm);
  background: var(--bg-deep);
  flex-shrink: 0;
  display: block;
}
/* 出演作品：条目封面（本身即脸部/主视觉居中，cover 即可完整显示） */
.work-cover {
  object-fit: cover;
}
/* 角色/声优头像：立绘为全身像，从顶部裁切才能看到脸，居中裁切只会看到腰 */
.work-avatar {
  object-fit: cover;
  object-position: top;
}
.work-img--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  color: var(--text-dim);
  text-align: center;
  line-height: 1.1;
}
.work-meta {
  min-width: 0;
}
.work-meta .wn {
  font-size: 12px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.work-meta .wr {
  font-size: 11px;
  color: var(--text-dim);
}
.ph {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: var(--text-dim);
  padding: 28px 0;
  font-size: 14px;
}
.ph.err {
  color: #ff6b6b;
}
</style>
