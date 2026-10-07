<template>
  <section class="page" data-module="baggage">
    <header class="page-head">
      <div>
        <h2>行李转运管理</h2>
        <p class="page-desc">维护行李转运，围绕转运编号、关联航班、行李件数、出发转盘做登记、筛选与状态流转，支持多选待卸机航班整组交接。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" :disabled="!selectedIds.length" @click="openHandover">
          整组交接<template v-if="selectedIds.length">（{{ selectedIds.length }}）</template>
        </button>
        <button class="btn" type="button" @click="openCreate">登记行李转运</button>
        <button class="btn" type="button" @click="exportRows">导出行李转运清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <section v-if="panelOpen" class="handover-panel">
      <h3 class="panel-title">整组交接单（{{ panelItems.length }} 条）</h3>
      <p class="hint-text">
        按转运编号、关联航班、行李件数、出发转盘、到达转盘逐条处理；未开始条目可批量调整。
        重复提交同一整组只保留首个版本，整组失败时从失败那一行继续。
      </p>
      <table class="data-table">
        <thead>
          <tr>
            <th>转运编号</th>
            <th>关联航班</th>
            <th>行李件数</th>
            <th>出发转盘</th>
            <th>到达转盘</th>
            <th>处理结果</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in panelItems" :key="item.entryId">
            <td>{{ item.转运编号 }}</td>
            <td>{{ item.关联航班 }}</td>
            <td>
              <input
                v-model="adjusts[item.entryId].行李件数"
                class="cell-input"
                :disabled="item.state === '已交接'"
              />
            </td>
            <td>
              <input
                v-model="adjusts[item.entryId].出发转盘"
                class="cell-input"
                :disabled="item.state === '已交接'"
              />
            </td>
            <td>
              <input
                v-model="adjusts[item.entryId].到达转盘"
                class="cell-input"
                :disabled="item.state === '已交接'"
              />
            </td>
            <td>
              <span v-if="item.state === '待处理'" class="hint-inline">待处理</span>
              <span v-else :class="item.state === '失败' ? 'error-text' : 'success-text'">
                {{ item.state }}{{ item.message ? `：${item.message}` : '' }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="panel-actions">
        <button class="btn primary" type="button" @click="submitHandover">提交整组交接</button>
        <button class="btn ghost" type="button" @click="closePanel">取消</button>
        <span v-if="handoverError" class="error-text">{{ handoverError }}</span>
        <span v-else-if="handoverMessage" class="success-text">{{ handoverMessage }}</span>
      </div>
    </section>

    <table class="data-table">
      <thead>
        <tr>
          <th>交接</th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td>
            <input
              type="checkbox"
              :checked="selectedIds.includes(Number(row.id))"
              :disabled="!isNotStarted(row)"
              :title="handoverBlockReason(row) || '勾选后可整组交接'"
              @change="toggleSelect(row)"
            />
          </td>
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无行李转运数据，可先登记行李转运</td>
        </tr>
      </tbody>
    </table>

    <section v-if="groups.length" class="group-section">
      <h3 class="panel-title">整组交接记录</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>版本</th>
            <th>转运编号</th>
            <th>状态</th>
            <th>失败行</th>
            <th>提交时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="group in groups" :key="group.key">
            <td>第 {{ group.version }} 版</td>
            <td>{{ group.items.map((item) => item.转运编号).join('、') }}</td>
            <td>{{ group.status }}</td>
            <td>{{ group.failedIndex === null ? '—' : group.items[group.failedIndex].转运编号 }}</td>
            <td>{{ formatTime(group.createdAt) }}</td>
            <td>
              <button v-if="group.status === '失败'" class="link" type="button" @click="resumeGroup(group)">
                继续交接
              </button>
              <span v-else>—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条行李转运记录</span>
      <span v-if="noticeMessage" class="success-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  baggageStatus,
  handoverBlockReason,
  isNotStarted,
  listHandoverGroups,
  submitGroupHandover,
} from '@/api/baggage-handover'
import type { HandoverAdjust, HandoverGroup, HandoverItem } from '@/api/baggage-handover'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('baggage')
const columns = ["转运编号", "关联航班", "行李件数", "出发转盘", "到达转盘", "装卸人员", "转运时长", "转运状态"]
const actions = ["开始卸机", "确认到达", "标记异常"]
const statuses = ["待卸机", "转运中", "已到达", "异常滞留"]
const stats = [{"label": "待卸机航班", "value": 0}, {"label": "转运中航班", "value": 0}, {"label": "异常滞留行李", "value": 0}]

type PanelAdjust = { 行李件数: string; 出发转盘: string; 到达转盘: string }

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const selectedIds = ref<number[]>([])
const panelOpen = ref(false)
const panelItems = ref<HandoverItem[]>([])
const adjusts = ref<Record<number, PanelAdjust>>({})
const handoverMessage = ref('')
const handoverError = ref('')
const groups = ref<HandoverGroup[]>([])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => baggageStatus(row) === status).length,
  })),
)

function toggleSelect(row: EntryRow) {
  if (!isNotStarted(row)) {
    return
  }
  const id = Number(row.id)
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter((item) => item !== id)
    : [...selectedIds.value, id]
}

function syncAdjusts() {
  const next: Record<number, PanelAdjust> = {}
  for (const item of panelItems.value) {
    next[item.entryId] = {
      行李件数: String(item.行李件数 ?? ''),
      出发转盘: item.出发转盘,
      到达转盘: item.到达转盘,
    }
  }
  adjusts.value = next
}

function openHandover() {
  noticeMessage.value = ''
  handoverMessage.value = ''
  handoverError.value = ''
  panelItems.value = rows.value
    .filter((row) => selectedIds.value.includes(Number(row.id)))
    .map((row) => ({
      entryId: Number(row.id),
      转运编号: String(row['转运编号'] ?? ''),
      关联航班: String(row['关联航班'] ?? ''),
      行李件数: typeof row['行李件数'] === 'number' ? row['行李件数'] : String(row['行李件数'] ?? ''),
      出发转盘: String(row['出发转盘'] ?? ''),
      到达转盘: String(row['到达转盘'] ?? ''),
      state: '待处理',
      message: '',
    }))
  if (!panelItems.value.length) {
    errorMessage.value = '请先勾选待卸机航班再整组交接'
    return
  }
  syncAdjusts()
  panelOpen.value = true
}

function closePanel() {
  panelOpen.value = false
  handoverMessage.value = ''
  handoverError.value = ''
}

function submitHandover() {
  handoverMessage.value = ''
  handoverError.value = ''
  const payload: Record<number, HandoverAdjust> = {}
  for (const item of panelItems.value) {
    payload[item.entryId] = adjusts.value[item.entryId]
  }
  const result = submitGroupHandover(panelItems.value.map((item) => item.entryId), payload)
  if (result.group) {
    panelItems.value = result.group.items
    syncAdjusts()
  }
  groups.value = listHandoverGroups()
  reload()
  if (result.ok) {
    if (result.group?.status === '已完成') {
      noticeMessage.value = result.message
      selectedIds.value = []
      closePanel()
      return
    }
    handoverMessage.value = result.message
    return
  }
  handoverError.value = result.message
}

function resumeGroup(group: HandoverGroup) {
  noticeMessage.value = ''
  handoverMessage.value = ''
  handoverError.value = ''
  panelItems.value = group.items.map((item) => ({ ...item }))
  syncAdjusts()
  panelOpen.value = true
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false })
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '行李转运登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    const selectable = new Set(payload.items.filter(isNotStarted).map((row) => Number(row.id)))
    selectedIds.value = selectedIds.value.filter((id) => selectable.has(id))
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '行李转运列表读取失败'
  }
}

onMounted(() => {
  reload()
  groups.value = listHandoverGroups()
})
</script>
