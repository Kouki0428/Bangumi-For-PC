<script setup lang="ts">
import { ref, watch, onMounted, computed } from 'vue'
import { subjectClient } from '@/services/subjectClient'
import type { SubjectComment } from '@shared/types'

const props = defineProps<{
  subjectId?: string | null
  /** 角色/人物评论：设置后优先于 subjectId */
  entityKind?: 'characters' | 'persons'
  entityId?: number
  /** 媒体类型，用于决定收藏状态中文词：anime/manga 用「看」系，book 用「读」系，game 用「玩」系 */
  mediaType?: 'anime' | 'book' | 'manga' | 'game'
}>()
const PAGE_SIZE = 20

const comments = ref<SubjectComment[]>([])
const total = ref(0)
const page = ref(0)
const loading = ref(false)
const error = ref('')
/** 该 Bangumi 条目已不存在/已删除/已合并（区别于「存在但无吐槽」） */
const notFound = ref(false)

function collectionLabel(t: number): string {
  const words: Record<string, [string, string, string, string, string]> = {
    anime: ['想看', '看过', '在看', '搁置', '抛弃'],
    manga: ['想看', '看过', '在看', '搁置', '抛弃'],
    book: ['想读', '读过', '在读', '搁置', '抛弃'],
    game: ['想玩', '玩过', '在玩', '搁置', '抛弃']
  }
  const list = words[props.mediaType ?? 'anime'] ?? words.anime
  return t >= 1 && t <= 5 ? list[t - 1] : ''
}

function formatTime(ts: number | string | null): string {
  if (ts === null || ts === undefined || ts === '') return ''
  const sec = typeof ts === 'number' ? ts : parseInt(String(ts), 10)
  if (!isFinite(sec) || sec <= 0) return ''
  const now = Math.floor(Date.now() / 1000)
  let diff = now - sec
  if (diff < 0) diff = 0
  const DAY = 86400
  if (diff < DAY * 3) {
    const d = Math.floor(diff / DAY)
    const h = Math.floor((diff % DAY) / 3600)
    const m = Math.floor((diff % 3600) / 60)
    if (d > 0) return `${d}d ${h}h ago`
    if (h > 0) return `${h}h ${m}m ago`
    if (m > 0) return `${m}m ago`
    return 'just now'
  }
  const dt = new Date(sec * 1000)
  const y = dt.getFullYear()
  const mo = dt.getMonth() + 1
  const da = dt.getDate()
  const hh = String(dt.getHours()).padStart(2, '0')
  const mm = String(dt.getMinutes()).padStart(2, '0')
  return `${y}-${mo}-${da} ${hh}:${mm}`
}

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
const hasPrev = computed(() => page.value > 0)
const hasMore = computed(() => page.value < totalPages.value - 1)

async function load(p = 0) {
  comments.value = []
  total.value = 0
  error.value = ''
  notFound.value = false
  page.value = p
  if (props.entityKind && props.entityId) {
    loading.value = true
    try {
      const r = await subjectClient.getEntityComments(props.entityKind, props.entityId, p * PAGE_SIZE)
      comments.value = r.comments
      total.value = r.total
      notFound.value = r.notFound ?? false
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
    }
    return
  }
  if (!props.subjectId) return
  loading.value = true
  try {
    const r = await subjectClient.getComments(props.subjectId, p * PAGE_SIZE)
    comments.value = r.comments
    total.value = r.total
    notFound.value = r.notFound ?? false
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

function prevPage() {
  if (hasPrev.value) load(page.value - 1)
}
function nextPage() {
  if (hasMore.value) load(page.value + 1)
}

onMounted(load)
watch(() => [props.subjectId, props.entityKind, props.entityId], () => load(0))
</script>

<template>
  <div class="panel tucao-box">
    <h3>吐槽箱</h3>
    <p v-if="!subjectId && !entityKind" class="placeholder">无 Bangumi 条目，无法加载吐槽。</p>
    <p v-else-if="loading" class="placeholder">加载中…</p>
    <p v-else-if="error" class="placeholder err">{{ error }}</p>
    <p v-else-if="notFound" class="placeholder warn">
      该作品在 Bangumi 上可能已不存在，或需登录后才能查看，无法获取吐槽。
    </p>
    <p v-else-if="comments.length === 0" class="placeholder">暂无其它用户的吐槽。</p>
    <template v-else>
      <ul class="tucao-list">
        <li v-for="c in comments" :key="c.id" class="tucao-item">
          <div class="tucao-head">
            <div class="tucao-left">
              <img v-if="c.creator.avatar" :src="c.creator.avatar" class="tucao-avatar" alt="" />
              <span class="tucao-name">{{ c.creator.nickname || c.creator.username || '匿名' }}</span>
              <span v-if="c.rate > 0" class="tucao-rate">
                <span class="stars" aria-hidden="true">
                  <span class="stars-bg">★★★★★</span>
                  <span class="stars-fg" :style="{ width: c.rate * 10 + '%' }">★★★★★</span>
                </span>
              </span>
            </div>
            <div v-if="collectionLabel(c.collectionType)" class="tucao-meta">
              <span class="tucao-status">{{ collectionLabel(c.collectionType) }}</span>
              <span class="tucao-time">@ {{ formatTime(c.createdAt) }}</span>
            </div>
          </div>
          <p class="tucao-text">{{ c.content }}</p>
        </li>
      </ul>
      <div v-if="totalPages > 1" class="tucao-pager">
        <button class="tucao-page-btn" :disabled="!hasPrev" @click="prevPage">上一页</button>
        <span class="tucao-page-info">第 {{ page + 1 }} / {{ totalPages }} 页 · 共 {{ total }} 条</span>
        <button class="tucao-page-btn" :disabled="!hasMore" @click="nextPage">下一页</button>
      </div>
      <p v-else class="tucao-more">共 {{ total }} 条</p>
    </template>
  </div>
</template>

<style scoped>

.tucao-box h3 {
  margin: 0 0 10px;
  font-size: 15px;
  color: var(--text);
}
.tucao-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.tucao-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.tucao-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.tucao-avatar {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  object-fit: cover;
  background: var(--bg-panel);
}
.tucao-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.tucao-rate {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
  flex-shrink: 0;
}
.stars {
  position: relative;
  display: inline-block;
  font-size: calc(12px * 1.2);
  line-height: 1;
}
.stars-bg {
  color: rgba(128, 128, 128, 0.4);
}
.stars-fg {
  position: absolute;
  top: 0;
  left: 0;
  overflow: hidden;
  white-space: nowrap;
  color: #e6a23c;
}
.tucao-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-dim);
  white-space: nowrap;
  flex-shrink: 0;
  margin-left: 8px;
}
.tucao-status {
  color: var(--text-dim);
}
.tucao-time {
  color: var(--text-dim);
}
.tucao-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-dim);
  white-space: pre-wrap;
  word-break: break-word;
}
.tucao-more {
  list-style: none;
  font-size: 12px;
  color: var(--text-dim);
  text-align: center;
}
.tucao-pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 10px;
}
.tucao-page-btn {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text);
  cursor: pointer;
}
.tucao-page-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.tucao-page-info {
  font-size: 12px;
  color: var(--text-dim);
}
.placeholder {
  font-size: 13px;
  color: var(--text-dim);
  margin: 4px 0;
}
.placeholder.err {
  color: var(--err);
}
.placeholder.warn {
  color: #e6a23c;
}
</style>
