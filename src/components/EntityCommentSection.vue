<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { subjectClient } from '@/services/subjectClient'
import { useSettingsStore } from '@/stores/settings'
import BgmBbcode from '@/components/BgmBbcode.vue'
import { SMILEYS } from '@/constants/bgmSmileys'
import type { SubjectComment } from '@shared/types'

const props = defineProps<{
  entityKind: 'characters' | 'persons'
  entityId: number
  /** 悬浮窗整体沉浸光感（由 EntityCard 透传） */
  glow?: boolean
  glowK?: number
}>()

const settings = useSettingsStore()
const me = ref<{ username?: string; nickname?: string; avatar?: string | null }>({})

const allComments = ref<SubjectComment[]>([])
const page = ref(0)
const loading = ref(false)
const error = ref('')
const notFound = ref(false)
const PAGE_SIZE = 20

// 客户端分页：API 返回裸数组无 total 字段，一次加载全部评论后切片
const total = computed(() => allComments.value.length)
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
const hasPrev = computed(() => page.value > 0)
const hasMore = computed(() => page.value < totalPages.value - 1)

// 排序：默认倒序（最新在前）
const sortOrder = ref<'asc' | 'desc'>('desc')
const sortLabel = computed(() => (sortOrder.value === 'asc' ? '倒序' : '顺序'))
function toggleSort() {
  sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc'
  // 切排序时回到第一页
  page.value = 0
}
const displayComments = computed(() => {
  const sorted = sortOrder.value === 'asc' ? allComments.value : [...allComments.value].reverse()
  const start = page.value * PAGE_SIZE
  return sorted.slice(start, start + PAGE_SIZE)
})

// 楼层号：按时间升序分配（基于全部评论）
const floorMap = computed<Record<string, number>>(() => {
  const sorted = [...allComments.value].sort((a, b) => {
    const ta = typeof a.createdAt === 'number' ? a.createdAt : parseInt(String(a.createdAt), 10) || 0
    const tb = typeof b.createdAt === 'number' ? b.createdAt : parseInt(String(b.createdAt), 10) || 0
    return ta - tb
  })
  const map: Record<string, number> = {}
  sorted.forEach((c, i) => { map[String(c.id)] = i + 1 })
  return map
})

function fmtTime(ts: number | string | null): string {
  if (ts == null || ts === '') return ''
  let sec = typeof ts === 'number' ? ts : parseInt(String(ts), 10)
  if (!isFinite(sec) || sec <= 0) return ''
  // 毫秒级时间戳（>1e12）转秒
  if (sec > 1e12) sec = Math.floor(sec / 1000)
  const dt = new Date(sec * 1000)
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`
}

// 自己发评论
const draft = ref('')
const posting = ref(false)
const taRef = ref<HTMLTextAreaElement | null>(null)
const showSmiley = ref(false)

const loggedIn = computed(() => !!(me.value.username || me.value.nickname))

// 子评论（回复）
const replyingTo = ref<number | null>(null)
const replyDraft = ref('')
const replyPosting = ref(false)

function startReply(targetId: number) {
  replyingTo.value = replyingTo.value === targetId ? null : targetId
  replyDraft.value = ''
}
function cancelReply() {
  replyingTo.value = null
  replyDraft.value = ''
}
async function onSendReply(target: SubjectComment) {
  const content = replyDraft.value.trim()
  if (!content || replyPosting.value || !loggedIn.value) return
  replyPosting.value = true
  error.value = ''
  try {
    await subjectClient.postEntityComment({
      kind: props.entityKind,
      id: props.entityId,
      content,
      relatedID: target.id
    })
    replyDraft.value = ''
    replyingTo.value = null
    await refreshComments()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '回复失败'
    setTimeout(() => { if (error.value) error.value = '' }, 8000)
  } finally {
    replyPosting.value = false
  }
}

function insertSmiley(code: string) {
  const ta = taRef.value
  if (!ta) { draft.value += code; return }
  const s = ta.selectionStart, e = ta.selectionEnd
  draft.value = draft.value.slice(0, s) + code + draft.value.slice(e)
  nextTick(() => { ta.focus(); ta.setSelectionRange(s + code.length, s + code.length) })
}
function surround(before: string, after: string, placeholder = '文字') {
  const ta = taRef.value
  if (!ta) { draft.value = before + (draft.value || placeholder) + after; return }
  const s = ta.selectionStart, e = ta.selectionEnd
  const sel = draft.value.slice(s, e) || placeholder
  draft.value = draft.value.slice(0, s) + before + sel + after + draft.value.slice(e)
  nextTick(() => { ta.focus(); const p = s + before.length; ta.setSelectionRange(p, p + sel.length) })
}
function wrap(tag: string) { surround(`[${tag}]`, `[/${tag}]`) }
function insertColor() { surround('[color=red]', '[/color]', '彩色文字') }
function insertUrl() {
  const ta = taRef.value; const s = ta?.selectionStart ?? 0, e = ta?.selectionEnd ?? 0
  const sel = draft.value.slice(s, e)
  if (sel && /^https?:\/\//i.test(sel)) surround(`[url=${sel}]`, '[/url]')
  else surround('[url=http://]', '[/url]')
}
function insertImg() { surround('[img]', '[/img]', 'http://') }
function onTaKey(e: KeyboardEvent) {
  const map: Record<string, () => void> = {
    b: () => wrap('b'), i: () => wrap('i'), u: () => wrap('u'), d: () => wrap('s'),
    l: () => insertUrl(), p: () => insertImg()
  }
  const fn = map[e.key.toLowerCase()]
  if ((e.ctrlKey || e.metaKey) && fn) { e.preventDefault(); fn() }
}

async function load() {
  if (!props.entityKind || !props.entityId) return
  loading.value = true
  error.value = ''
  notFound.value = false
  allComments.value = []
  page.value = 0
  try {
    const [c, m] = await Promise.all([
      subjectClient.getEntityComments(props.entityKind, props.entityId, 0, 200).catch(() => ({ comments: [] as SubjectComment[], total: 0, notFound: false })),
      fetchMe().catch(() => ({} as typeof me.value))
    ])
    allComments.value = c.comments
    notFound.value = c.notFound ?? false
    me.value = m
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

function prevPage() { if (hasPrev.value) page.value-- }
function nextPage() { if (hasMore.value) page.value++ }

async function fetchMe() {
  try {
    const res = await window.acgn.auth.getMe?.()
    if (res) return { username: res.username, nickname: res.nickname, avatar: res.avatar }
  } catch { /* 未登录 */ }
  return {}
}

async function refreshComments() {
  if (!props.entityKind || !props.entityId) return
  const c = await subjectClient.getEntityComments(props.entityKind, props.entityId, 0, 200).catch(() => ({ comments: [] as SubjectComment[], total: 0, notFound: false }))
  allComments.value = c.comments
}

async function onSend() {
  const content = draft.value.trim()
  if (!content || posting.value || !loggedIn.value) return
  posting.value = true
  error.value = ''
  try {
    await subjectClient.postEntityComment({
      kind: props.entityKind,
      id: props.entityId,
      content
    })
    draft.value = ''
    await refreshComments()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '发表评论失败'
    setTimeout(() => { if (error.value) error.value = '' }, 8000)
  } finally {
    posting.value = false
  }
}

watch(() => [props.entityKind, props.entityId], () => load(), { immediate: true })
</script>

<template>
  <div class="ec-sec" :class="{ 'glow-card': glow }" @click.stop>
    <h4 class="ec-sec-title">吐槽箱</h4>

    <!-- 自己的评论输入卡 -->
    <div v-if="loggedIn" class="ec-mine" :class="{ 'glow-card': glow }">
      <img v-if="me.avatar" :src="me.avatar" class="ec-avatar" alt="" />
      <div v-else class="ec-avatar ec-avatar-ph"></div>
      <div class="ec-mine-body">
        <div class="ec-mine-name">{{ me.nickname || me.username || '我' }}</div>
        <div class="ec-bb-bar">
          <button type="button" class="ec-bb-btn" title="粗体 (Ctrl+B)" @click="wrap('b')"><b>B</b></button>
          <button type="button" class="ec-bb-btn" title="斜体 (Ctrl+I)" @click="wrap('i')"><i>I</i></button>
          <button type="button" class="ec-bb-btn" title="下划线 (Ctrl+U)" @click="wrap('u')"><u>U</u></button>
          <button type="button" class="ec-bb-btn" title="删除线 (Ctrl+D)" @click="wrap('s')"><s>S</s></button>
          <button type="button" class="ec-bb-btn" title="颜色" @click="insertColor()">色</button>
          <button type="button" class="ec-bb-btn" title="链接 (Ctrl+L)" @click="insertUrl()">链</button>
          <button type="button" class="ec-bb-btn" title="图片 (Ctrl+P)" @click="insertImg()">图</button>
          <span class="ec-smiley-wrap">
            <button type="button" class="ec-bb-btn" title="表情" @click="showSmiley = !showSmiley">表</button>
            <div v-if="showSmiley" class="ec-smiley-panel">
              <img v-for="s in SMILEYS" :key="s.code" :src="s.src" :alt="s.code" :title="s.code" class="ec-smiley-item" @click="insertSmiley(s.code); showSmiley = false" />
            </div>
          </span>
        </div>
        <textarea ref="taRef" v-model="draft" class="ec-textarea" rows="2" maxlength="2000" placeholder="写下你的评论…（支持 BBCode）" @keydown="onTaKey"></textarea>
        <div v-if="draft.trim()" class="ec-preview">
          <span class="ec-preview-label">预览</span>
          <BgmBbcode :text="draft" as="div" class="ec-preview-body" />
        </div>
        <div class="ec-mine-foot">
          <span v-if="posting" class="ec-hint">发送中…</span>
          <span v-else class="ec-hint"></span>
          <button class="ec-send" type="button" :disabled="!draft.trim() || posting" @click="onSend">{{ posting ? '发送中…' : '加上去' }}</button>
        </div>
      </div>
    </div>

    <!-- 评论列表 -->
    <div class="ec-list-head">
      <span>评论 ({{ total }})</span>
      <button class="ec-sort-btn" type="button" :title="sortOrder === 'asc' ? '当前：倒序（点击切换为顺序）' : '当前：顺序（点击切换为倒序）'" @click="toggleSort">{{ sortLabel }}</button>
    </div>

    <div v-if="error" class="ec-rx-error">{{ error }}</div>
    <div v-if="loading" class="ec-loading">加载中…</div>
    <div v-else-if="notFound" class="ec-empty">该角色/人物在 Bangumi 上可能已不存在。</div>
    <div v-else-if="displayComments.length === 0" class="ec-empty">还没有评论，来抢沙发～</div>
    <div v-else class="ec-list">
      <div v-for="c in displayComments" :key="c.id" class="ec-comment">
        <img v-if="c.creator.avatar" :src="c.creator.avatar" class="ec-c-avatar" alt="" />
        <div v-else class="ec-c-avatar ec-avatar-ph"></div>
        <div class="ec-c-body">
          <div class="ec-c-head">
            <span class="ec-c-name">{{ c.creator.nickname || c.creator.username || '匿名' }}</span>
            <span class="ec-c-floor-meta">
              <span class="ec-c-floor">#{{ floorMap[String(c.id)] }}</span>
              <span class="ec-c-time">{{ fmtTime(c.createdAt) }}</span>
            </span>
            <button class="ec-reply-btn" type="button" title="回复" @click="startReply(c.id)">
              <svg class="ec-reply-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
            </button>
          </div>
          <BgmBbcode :text="c.content" as="span" class="ec-c-content" />
          <!-- 子评论 -->
          <div v-if="c.replies && c.replies.length" class="ec-replies">
            <div v-for="(r, ri) in c.replies" :key="r.id" class="ec-reply">
              <img v-if="r.creator.avatar" :src="r.creator.avatar" class="ec-r-avatar" alt="" />
              <div v-else class="ec-r-avatar ec-avatar-ph"></div>
              <div class="ec-r-body">
                <div class="ec-r-head">
                  <span class="ec-r-name">{{ r.creator.nickname || r.creator.username || '匿名' }}</span>
                  <span class="ec-c-floor-meta">
                    <span class="ec-c-floor">#{{ floorMap[String(c.id)] }}-{{ ri + 1 }}</span>
                    <span class="ec-c-time">{{ fmtTime(r.createdAt) }}</span>
                  </span>
                  <button class="ec-reply-btn" type="button" title="回复" @click="startReply(r.id)">
                    <svg class="ec-reply-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                  </button>
                </div>
                <BgmBbcode :text="r.content" as="span" class="ec-c-content" />
                <!-- 子评论的回复输入框 -->
                <div v-if="replyingTo === r.id" class="ec-reply-box">
                  <textarea v-model="replyDraft" class="ec-textarea ec-reply-ta" rows="2" maxlength="2000" :placeholder="'回复 @' + (r.creator.nickname || r.creator.username || '匿名')"></textarea>
                  <div class="ec-mine-foot">
                    <span v-if="replyPosting" class="ec-hint">发送中…</span>
                    <div class="ec-reply-actions">
                      <button class="ec-reply-cancel" type="button" :disabled="replyPosting" @click="cancelReply">取消</button>
                      <button class="ec-send" type="button" :disabled="!replyDraft.trim() || replyPosting" @click="onSendReply(r)">{{ replyPosting ? '发送中…' : '回复' }}</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <!-- 回复输入框 -->
          <div v-if="replyingTo === c.id" class="ec-reply-box">
            <textarea v-model="replyDraft" class="ec-textarea ec-reply-ta" rows="2" maxlength="2000" :placeholder="'回复 @' + (c.creator.nickname || c.creator.username || '匿名')"></textarea>
            <div class="ec-mine-foot">
              <span v-if="replyPosting" class="ec-hint">发送中…</span>
              <div class="ec-reply-actions">
                <button class="ec-reply-cancel" type="button" :disabled="replyPosting" @click="cancelReply">取消</button>
                <button class="ec-send" type="button" :disabled="!replyDraft.trim() || replyPosting" @click="onSendReply(c)">{{ replyPosting ? '发送中…' : '回复' }}</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 分页 -->
    <div v-if="!loading && !notFound && totalPages > 1" class="ec-pager">
      <button class="ec-page-btn" :disabled="!hasPrev" @click="prevPage">上一页</button>
      <span class="ec-page-info">第 {{ page + 1 }} / {{ totalPages }} 页 · 共 {{ total }} 条</span>
      <button class="ec-page-btn" :disabled="!hasMore" @click="nextPage">下一页</button>
    </div>
    <p v-else-if="!loading && !notFound && total > 0" class="ec-more">共 {{ total }} 条</p>
  </div>
</template>

<style scoped>
.ec-sec {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border-soft);
}
.ec-sec-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  margin: 0 0 10px;
}

/* 评论输入卡 */
.ec-mine {
  display: flex;
  gap: 10px;
  padding: 12px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 12px;
}
.ec-mine.glow-card {
  background: color-mix(in srgb, var(--bg-elev) calc(70% * var(--glass-k, 1)), transparent);
}
.ec-mine.glow-card .ec-textarea,
.ec-mine.glow-card .ec-bb-btn,
.ec-mine.glow-card .ec-preview {
  background: color-mix(in srgb, var(--bg-panel) calc(70% * var(--glass-k, 1)), transparent);
}
.ec-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  flex-shrink: 0;
  object-fit: cover;
  background: var(--bg-panel);
}
.ec-avatar-ph {
  background: var(--border);
}
.ec-mine-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ec-mine-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.ec-bb-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.ec-bb-btn {
  min-width: 28px;
  height: 26px;
  padding: 0 8px;
  font-size: 13px;
  line-height: 1;
  color: var(--text);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.15s;
}
.ec-bb-btn:hover {
  border-color: var(--accent-aux);
  color: var(--accent-aux);
}
.ec-smiley-wrap {
  position: relative;
  display: inline-flex;
}
.ec-smiley-panel {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 30;
  width: min(336px, 100%);
  max-height: 200px;
  overflow-y: auto;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 4px;
  padding: 8px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow);
}
.ec-smiley-item {
  width: 26px;
  height: 26px;
  object-fit: contain;
  cursor: pointer;
  justify-self: center;
}
.ec-smiley-item:hover {
  background: var(--bg-elev);
}
.ec-textarea {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  padding: 8px 10px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  outline: none;
  font-family: inherit;
}
.ec-textarea:focus {
  border-color: var(--accent-aux);
}
.ec-preview {
  margin-top: 4px;
  padding: 8px 10px;
  background: var(--bg-panel);
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
}
.ec-preview-label {
  display: block;
  font-size: 11px;
  color: var(--text-dim);
  margin-bottom: 4px;
}
.ec-preview-body {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text);
}
.ec-mine-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.ec-hint {
  font-size: 12px;
  color: var(--text-dim);
}
.ec-send {
  padding: 6px 18px;
  font-size: 13px;
  font-weight: 600;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--accent-aux);
  color: #fff;
  cursor: pointer;
  transition: opacity 0.15s;
}
.ec-send:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* 评论列表 */
.ec-list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 8px;
}
.ec-sort-btn {
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  color: var(--text);
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 4px 10px;
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;
}
.ec-sort-btn:hover {
  border-color: var(--accent-aux);
  color: var(--accent-aux);
}
.ec-rx-error {
  margin: 0 0 8px;
  padding: 8px 10px;
  font-size: 12px;
  color: #fff;
  background: #d9534f;
  border-radius: var(--radius-sm);
  word-break: break-all;
  overflow-wrap: anywhere;
}
.ec-loading,
.ec-empty {
  color: var(--text-dim);
  font-size: 13px;
  padding: 12px 0;
  text-align: center;
}
.ec-list {
  display: flex;
  flex-direction: column;
}
.ec-comment {
  display: flex;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border-soft);
}
.ec-comment:last-child {
  border-bottom: none;
}
.ec-c-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  flex-shrink: 0;
  object-fit: cover;
  background: var(--bg-panel);
}
.ec-c-body {
  flex: 1;
  min-width: 0;
}
.ec-c-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 3px;
}
.ec-c-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.ec-c-floor-meta {
  margin-left: auto;
  display: inline-flex;
  align-items: baseline;
}
.ec-c-floor {
  font-size: 11px;
  line-height: 16px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.ec-c-floor::after {
  content: ' -';
  color: var(--text-dim);
}
.ec-c-time {
  font-size: 11px;
  color: var(--text-dim);
}
.ec-c-content {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text);
  word-break: break-all;
  overflow-wrap: anywhere;
}
.ec-reply-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--text-dim);
  background: transparent;
  border: none;
  padding: 4px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.15s;
}
.ec-reply-ico {
  width: 15px;
  height: 15px;
  display: block;
}
.ec-reply-btn:hover {
  color: var(--accent-aux);
  background: var(--bg-elev);
}
.ec-replies {
  margin-top: 8px;
  padding-left: 12px;
  border-left: 2px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ec-reply {
  display: flex;
  gap: 8px;
}
.ec-r-avatar {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  flex-shrink: 0;
  object-fit: cover;
  background: var(--bg-panel);
}
.ec-r-body {
  flex: 1;
  min-width: 0;
}
.ec-r-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 2px;
}
.ec-r-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}
.ec-reply-box {
  margin-top: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elev);
}
.ec-sec.glow-card .ec-reply-box,
.ec-sec.glow-card .ec-reply-box .ec-textarea {
  background: color-mix(in srgb, var(--bg-elev) calc(70% * var(--glass-k, 1)), transparent);
}
.ec-reply-ta {
  resize: vertical;
  min-height: 40px;
}
.ec-reply-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ec-reply-cancel {
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 600;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elev);
  color: var(--text-dim);
  cursor: pointer;
  transition: all 0.15s;
}
.ec-reply-cancel:hover {
  border-color: var(--accent-aux);
  color: var(--accent-aux);
}

/* 分页 */
.ec-pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 10px;
}
.ec-page-btn {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text);
  cursor: pointer;
  transition: all 0.15s;
}
.ec-page-btn:hover:not(:disabled) {
  border-color: var(--accent-aux);
  color: var(--accent-aux);
}
.ec-page-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.ec-page-info {
  font-size: 12px;
  color: var(--text-dim);
}
.ec-more {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--text-dim);
  text-align: center;
}
</style>