import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listGroups, listRows, resetRows, saveGroups, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  HandoverGroup,
  HandoverResult,
  HandoverRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const BAGGAGE_KEY = 'baggage'
const TURNAROUND_KEY = 'turnaround'

// 旧版数据里的转运状态叫法：读进来先归一到现行状态，老数据不用手工清洗。
const LEGACY_BAGGAGE_STATUS: Record<string, string> = {
  待转运: '待卸机',
  待交接: '待卸机',
  待装运: '待卸机',
  运输中: '转运中',
  配送中: '转运中',
  已完成: '已到达',
  已送达: '已到达',
  已签收: '已到达',
  异常: '异常滞留',
  滞留: '异常滞留',
}

function normalizeBaggageStatuses(): void {
  const rows = listRows(BAGGAGE_KEY)
  let changed = false
  const next = rows.map((row) => {
    const mapped = LEGACY_BAGGAGE_STATUS[String(row.status)]
    if (!mapped) {
      return row
    }
    changed = true
    return { ...row, status: mapped, pending: mapped !== '已到达', abnormal: mapped === '异常滞留' }
  })
  if (changed) {
    saveRows(BAGGAGE_KEY, next)
  }
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  if (key === BAGGAGE_KEY) {
    normalizeBaggageStatuses()
  }
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  if (key === BAGGAGE_KEY) {
    normalizeBaggageStatuses()
  }
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (meta.finalStatuses?.includes(current)) {
    return { ok: false, message: `${meta.entity}已到终态「${current}」，不得退回或变更` }
  }
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

// ---- 行李转运：整组交接 ----

export function listHandoverGroups(): HandoverGroup[] {
  return listGroups()
}

function nextGroupId(groups: HandoverGroup[]): string {
  let max = 0
  for (const group of groups) {
    const match = /GRP-(\d+)/.exec(group.id)
    if (match) {
      max = Math.max(max, Number(match[1]))
    }
  }
  return `GRP-${String(max + 1).padStart(4, '0')}`
}

// 转运中的记录会锁定自己占用的出发/到达转盘；新交接撞上了，以已锁定的为准。
function lockedCarousels(excludeNo?: string): Map<string, string> {
  const locks = new Map<string, string>()
  for (const row of listRows(BAGGAGE_KEY)) {
    if (String(row.status) !== '转运中') {
      continue
    }
    const no = String(row['转运编号'] ?? '')
    if (no === excludeNo) {
      continue
    }
    for (const field of ['出发转盘', '到达转盘']) {
      const carousel = String(row[field] ?? '').trim()
      if (carousel && carousel !== '—' && !locks.has(carousel)) {
        locks.set(carousel, no)
      }
    }
  }
  return locks
}

function nextTurnoverNo(rows: EntryRow[]): string {
  let max = 0
  for (const row of rows) {
    const match = /TURN-(\d+)/.exec(String(row['过站编号'] ?? ''))
    if (match) {
      max = Math.max(max, Number(match[1]))
    }
  }
  return `TURN-${String(max + 1).padStart(4, '0')}`
}

// 每处理好一行，就往过站监控台账同步一条到达待办；同批次同转运编号只生成一次。
function syncTurnaroundTodo(group: HandoverGroup, row: HandoverRow): void {
  const rows = listRows(TURNAROUND_KEY)
  const exists = rows.some(
    (item) =>
      String(item['来源批次'] ?? '') === group.id &&
      String(item['来源转运编号'] ?? '') === row.转运编号,
  )
  if (exists) {
    return
  }
  const id = rows.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
  const todo: EntryRow = {
    id,
    status: '待监测',
    pending: true,
    abnormal: false,
    过站编号: nextTurnoverNo(rows),
    关联航班: row.关联航班,
    计划到港: new Date().toISOString().slice(0, 10),
    实际到港: '待更新',
    过站时长: '—',
    保障进度: `到达待办（行李整组交接 ${group.id}）`,
    异常事项: '无',
    过站状态: '待监测',
    来源批次: group.id,
    来源转运编号: row.转运编号,
  }
  saveRows(TURNAROUND_KEY, [...rows, todo])
}

function processHandoverRow(group: HandoverGroup, row: HandoverRow): boolean {
  const entries = listRows(BAGGAGE_KEY)
  const index = entries.findIndex((item) => String(item['转运编号']) === row.转运编号)
  if (index < 0) {
    row.state = '失败'
    row.message = `转运编号 ${row.转运编号} 不存在`
    return false
  }
  const entry = entries[index]
  const status = String(entry.status)
  if (status === '已到达') {
    row.state = '失败'
    row.message = '已到达记录不得退回，不能再次交接'
    return false
  }
  if (status === '异常滞留') {
    row.state = '失败'
    row.message = '异常滞留中，需先处理异常再交接'
    return false
  }
  if (status === '转运中') {
    // 上次处理到一半中断：这条已经在转运，直接记为已处理并补齐台账。
    row.state = '已处理'
    row.message = '已在转运中，直接确认'
    syncTurnaroundTodo(group, row)
    return true
  }
  // 待卸机 → 转运中：先查转盘冲突，撞了以已锁定转盘为准，本行失败。
  const locks = lockedCarousels(row.转运编号)
  for (const carousel of [row.出发转盘, row.到达转盘]) {
    const value = carousel.trim()
    if (value && locks.has(value)) {
      row.state = '失败'
      row.message = `转盘 ${value} 已被 ${locks.get(value)} 锁定`
      return false
    }
  }
  const updated: EntryRow = {
    ...entry,
    status: '转运中',
    pending: true,
    abnormal: false,
    出发转盘: row.出发转盘 || entry['出发转盘'],
    到达转盘: row.到达转盘 || entry['到达转盘'],
  }
  const next = [...entries]
  next[index] = updated
  saveRows(BAGGAGE_KEY, next)
  row.state = '已处理'
  row.message = '已卸机转运'
  syncTurnaroundTodo(group, row)
  return true
}

// 逐条处理：已处理的行跳过，失败即停，下次从失败那一行继续。
function processHandoverGroup(group: HandoverGroup): void {
  for (const row of group.rows) {
    if (row.state === '已处理') {
      continue
    }
    if (!processHandoverRow(group, row)) {
      break
    }
  }
  const done = group.rows.filter((row) => row.state === '已处理').length
  if (done === group.rows.length) {
    group.status = '已完成'
  } else {
    group.status = done > 0 ? '部分失败' : '失败'
  }
}

function handoverSummary(group: HandoverGroup): string {
  const done = group.rows.filter((row) => row.state === '已处理').length
  if (group.status === '已完成') {
    return `整组 ${group.id} 交接完成，共 ${done} 条，过站监控已同步到达待办`
  }
  const failed = group.rows.find((row) => row.state === '失败')
  return `整组 ${group.id} 处理到 ${done}/${group.rows.length} 条时中断：${failed?.message ?? '未知原因'}，可从失败行继续`
}

export function submitHandoverGroup(transferNos: string[]): HandoverResult {
  normalizeBaggageStatuses()
  const uniqueNos = [...new Set(transferNos.map((no) => no.trim()).filter(Boolean))]
  if (uniqueNos.length === 0) {
    return { ok: false, message: '请先勾选要整组交接的待卸机记录', group: null, duplicated: false }
  }
  const key = [...uniqueNos].sort().join('|')
  const groups = listGroups()
  const existing = groups.find((item) => item.key === key)
  if (existing) {
    return {
      ok: false,
      message: `整组 ${existing.id} 已提交过，重复提交只保留首个版本`,
      group: existing,
      duplicated: true,
    }
  }
  const entries = listRows(BAGGAGE_KEY)
  const rows: HandoverRow[] = uniqueNos.map((no) => {
    const entry = entries.find((item) => String(item['转运编号']) === no)
    return {
      转运编号: no,
      关联航班: String(entry?.['关联航班'] ?? ''),
      行李件数: String(entry?.['行李件数'] ?? ''),
      出发转盘: String(entry?.['出发转盘'] ?? '').trim(),
      到达转盘: String(entry?.['到达转盘'] ?? '').trim(),
      state: '待处理',
      message: '',
    }
  })
  const group: HandoverGroup = {
    id: nextGroupId(groups),
    key,
    createdAt: new Date().toISOString(),
    status: '处理中',
    rows,
  }
  processHandoverGroup(group)
  saveGroups([...groups, group])
  return { ok: group.status === '已完成', message: handoverSummary(group), group, duplicated: false }
}

export function resumeHandoverGroup(groupId: string): HandoverResult {
  normalizeBaggageStatuses()
  const groups = listGroups()
  const group = groups.find((item) => item.id === groupId)
  if (!group) {
    return { ok: false, message: `没有找到批次 ${groupId}`, group: null, duplicated: false }
  }
  if (group.status === '已完成') {
    return { ok: true, message: `整组 ${group.id} 已完成，无需继续`, group, duplicated: false }
  }
  processHandoverGroup(group)
  saveGroups([...groups])
  const completed = group.rows.every((row) => row.state === '已处理')
  return { ok: completed, message: handoverSummary(group), group, duplicated: false }
}

// 批量调整只动未开始（待卸机）的条目；已到达记录不得退回，转运冲突以已锁定转盘为准。
export function batchAdjustBaggage(
  transferNos: string[],
  patch: { 出发转盘?: string; 到达转盘?: string; 行李件数?: string },
): ActionResult {
  normalizeBaggageStatuses()
  const cleaned = {
    出发转盘: patch.出发转盘?.trim() ?? '',
    到达转盘: patch.到达转盘?.trim() ?? '',
    行李件数: patch.行李件数?.trim() ?? '',
  }
  if (!cleaned.出发转盘 && !cleaned.到达转盘 && !cleaned.行李件数) {
    return { ok: false, message: '批量调整至少要填写一个字段' }
  }
  const entries = listRows(BAGGAGE_KEY)
  const locks = lockedCarousels()
  const skipped: string[] = []
  let adjusted = 0
  const next = entries.map((entry) => {
    const no = String(entry['转运编号'] ?? '')
    if (!transferNos.includes(no)) {
      return entry
    }
    if (String(entry.status) !== '待卸机') {
      skipped.push(`${no}（${String(entry.status)}，只允许调整未开始条目）`)
      return entry
    }
    const targetFrom = cleaned.出发转盘 || String(entry['出发转盘'] ?? '')
    const targetTo = cleaned.到达转盘 || String(entry['到达转盘'] ?? '')
    const hit = [targetFrom, targetTo].find((carousel) => carousel && locks.has(carousel))
    if (hit) {
      skipped.push(`${no}（转盘 ${hit} 已被 ${locks.get(hit)} 锁定）`)
      return entry
    }
    adjusted += 1
    return {
      ...entry,
      出发转盘: targetFrom,
      到达转盘: targetTo,
      行李件数: cleaned.行李件数 || entry['行李件数'],
    }
  })
  if (adjusted > 0) {
    saveRows(BAGGAGE_KEY, next)
  }
  if (adjusted === 0) {
    return { ok: false, message: `没有可调整的未开始条目${skipped.length ? `：${skipped.join('、')}` : ''}` }
  }
  const suffix = skipped.length ? `，跳过 ${skipped.length} 条：${skipped.join('、')}` : ''
  return { ok: true, message: `已批量调整 ${adjusted} 条未开始条目${suffix}` }
}
