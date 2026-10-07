<template>
  <section class="page" data-module="baggage">
    <header class="page-head">
      <div>
        <h2>行李转运管理</h2>
        <p class="page-desc">维护行李转运，围绕转运编号、关联航班、行李件数、出发转盘做登记、筛选与状态流转，支持多选待卸机航班一次提交整组交接。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记行李转运</button>
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

    <div class="handover-bar">
      <button class="btn primary" type="button" :disabled="!selected.length" @click="submitGroup">
        整组交接（已选 {{ selected.length }} 条待卸机）
      </button>
      <div class="adjust-group">
        <input v-model="adjustForm.出发转盘" placeholder="新出发转盘" />
        <input v-model="adjustForm.到达转盘" placeholder="新到达转盘" />
        <input v-model="adjustForm.行李件数" placeholder="新行李件数" />
        <button class="btn" type="button" :disabled="!selected.length" @click="batchAdjust">
          批量调整未开始条目
        </button>
      </div>
      <span v-if="handoverMessage" class="handover-message">{{ handoverMessage }}</span>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th>选择</th>
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
              :checked="selected.includes(String(row['转运编号']))"
              :disabled="!selectable(row)"
              :title="selectable(row) ? '勾选后加入整组交接' : '仅待卸机（未开始）条目可交接或调整'"
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

    <section class="group-panel">
      <h3 class="group-title">整组交接批次</h3>
      <p v-if="!groups.length" class="empty-state">暂无交接批次，勾选待卸机记录后点击「整组交接」一次提交</p>
      <article v-for="group in groups" :key="group.id" class="group-card">
        <header class="group-head">
          <strong>{{ group.id }}</strong>
          <span>提交时间：{{ formatTime(group.createdAt) }}</span>
          <span class="group-status" :data-status="group.status">{{ group.status }}</span>
          <button
            v-if="group.status !== '已完成'"
            class="btn"
            type="button"
            @click="resumeGroup(group)"
          >
            从失败行继续
          </button>
        </header>
        <table class="data-table">
          <thead>
            <tr>
              <th>转运编号</th>
              <th>关联航班</th>
              <th>行李件数</th>
              <th>出发转盘</th>
              <th>到达转盘</th>
              <th>处理结果</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in group.rows" :key="row.转运编号">
              <td>{{ row.转运编号 }}</td>
              <td>{{ row.关联航班 || '—' }}</td>
              <td>{{ row.行李件数 || '—' }}</td>
              <td>{{ row.出发转盘 || '—' }}</td>
              <td>{{ row.到达转盘 || '—' }}</td>
              <td>{{ row.state }}</td>
              <td>{{ row.message || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </article>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条行李转运记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  batchAdjustBaggage,
  downloadEntries,
  listEntries,
  listHandoverGroups,
  moduleMeta,
  resumeHandoverGroup,
  runAction as applyAction,
  submitHandoverGroup,
} from '@/api/local-service'
import type { EntryRow, HandoverGroup } from '@/data/types'

const meta = moduleMeta('baggage')
const columns = ["转运编号", "关联航班", "行李件数", "出发转盘", "到达转盘", "装卸人员", "转运时长", "转运状态"]
const actions = ["开始卸机", "确认到达", "标记异常"]
const statuses = ["待卸机", "转运中", "已到达", "异常滞留"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const handoverMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const selected = ref<string[]>([])
const adjustForm = ref({ 出发转盘: '', 到达转盘: '', 行李件数: '' })
const groups = ref<HandoverGroup[]>([])

const stats = computed(() => [
  { label: '待卸机航班', value: rows.value.filter((row) => row.status === '待卸机').length },
  { label: '转运中航班', value: rows.value.filter((row) => row.status === '转运中').length },
  { label: '异常滞留行李', value: rows.value.filter((row) => row.status === '异常滞留').length },
])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function selectable(row: EntryRow): boolean {
  return String(row.status) === '待卸机'
}

function toggleSelect(row: EntryRow) {
  const no = String(row['转运编号'])
  selected.value = selected.value.includes(no)
    ? selected.value.filter((item) => item !== no)
    : [...selected.value, no]
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
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function submitGroup() {
  handoverMessage.value = ''
  errorMessage.value = ''
  const result = submitHandoverGroup(selected.value)
  handoverMessage.value = result.message
  if (!result.duplicated) {
    selected.value = []
  }
  refreshGroups()
  reload()
}

function resumeGroup(group: HandoverGroup) {
  handoverMessage.value = ''
  errorMessage.value = ''
  const result = resumeHandoverGroup(group.id)
  handoverMessage.value = result.message
  refreshGroups()
  reload()
}

function batchAdjust() {
  handoverMessage.value = ''
  errorMessage.value = ''
  const result = batchAdjustBaggage(selected.value, adjustForm.value)
  handoverMessage.value = result.message
  if (result.ok) {
    adjustForm.value = { 出发转盘: '', 到达转盘: '', 行李件数: '' }
  }
  reload()
}

function refreshGroups() {
  groups.value = [...listHandoverGroups()]
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    // 已不在待卸机的记录自动退出选择，避免把已开始的条目带进整组
    const selectableNos = new Set(
      listEntries(meta.key)
        .items.filter(selectable)
        .map((row) => String(row['转运编号'])),
    )
    selected.value = selected.value.filter((no) => selectableNos.has(no))
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '行李转运列表读取失败'
  }
}

onMounted(() => {
  reload()
  refreshGroups()
})
</script>
