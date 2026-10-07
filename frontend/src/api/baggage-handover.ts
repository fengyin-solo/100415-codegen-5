import { listRows, saveRows } from '@/data/local-store'
import { moduleMeta, normalizeStatus } from '@/api/local-service'
import type { EntryRow } from '@/data/types'

// 行李转运整组交接：多选待卸机航班后一次提交，按转运编号、关联航班、行李件数、
// 出发转盘、到达转盘逐条处理。整组记录单独持久化，重复提交同一整组只保留首个版本，
// 失败时保留已交接条目，重新提交从失败那一行继续。

export type HandoverItemState = '待处理' | '已交接' | '失败'

export type HandoverItem = {
  entryId: number
  转运编号: string
  关联航班: string
  行李件数: string | number
  出发转盘: string
  到达转盘: string
  state: HandoverItemState
  message: string
}

export type HandoverGroup = {
  key: string
  version: number
  createdAt: string
  status: '处理中' | '已完成' | '失败'
  failedIndex: number | null
  items: HandoverItem[]
}

export type HandoverAdjust = {
  行李件数?: string
  出发转盘?: string
  到达转盘?: string
}

export type HandoverResult = {
  ok: boolean
  /** 同一整组重复提交，首个版本已完成，本次未重复处理 */
  duplicated: boolean
  /** 在首个版本上从失败行继续处理 */
  resumed: boolean
  message: string
  group: HandoverGroup | null
}

const GROUP_STORAGE_KEY = 'airport-ground-handling:baggage-handover-groups'
const NOT_STARTED = '待卸机'
const IN_TRANSIT = '转运中'
const ARRIVED = '已到达'

function meta() {
  return moduleMeta('baggage')
}

/** 归一旧转运状态后的当前状态。 */
export function baggageStatus(row: EntryRow): string {
  return normalizeStatus(meta(), String(row.status))
}

/** 未开始（待卸机）的条目才允许整组交接与批量调整。 */
export function isNotStarted(row: EntryRow): boolean {
  return baggageStatus(row) === NOT_STARTED
}

/** 不能参与整组交接的原因；可以参与时返回空串。 */
export function handoverBlockReason(row: EntryRow): string {
  const status = baggageStatus(row)
  if (status === NOT_STARTED) {
    return ''
  }
  if (status === ARRIVED) {
    return '已到达记录不得退回'
  }
  if (status === IN_TRANSIT) {
    return '已交接，转运中'
  }
  return `当前状态「${row.status}」不能整组交接`
}

function loadGroups(): HandoverGroup[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  const raw = window.localStorage.getItem(GROUP_STORAGE_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as HandoverGroup[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveGroups(groups: HandoverGroup[]): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(GROUP_STORAGE_KEY, JSON.stringify(groups))
  }
}

export function listHandoverGroups(): HandoverGroup[] {
  return [...loadGroups()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** 整组键：由组内转运编号排序拼接，同一批转运编号视为同一整组。 */
function groupKeyOf(codes: string[]): string {
  return [...codes].sort().join('|')
}

/** 转运中的记录锁定其出发/到达转盘，冲突时以这些已锁定转盘为准。 */
function lockedCarousels(rows: EntryRow[], excludeId: number): Map<string, string> {
  const locked = new Map<string, string>()
  for (const row of rows) {
    if (Number(row.id) === excludeId || baggageStatus(row) !== IN_TRANSIT) {
      continue
    }
    for (const field of ['出发转盘', '到达转盘']) {
      const name = String(row[field] ?? '').trim()
      if (name && !locked.has(name)) {
        locked.set(name, String(row['转运编号'] ?? ''))
      }
    }
  }
  return locked
}

function nextTurnaroundCode(rows: EntryRow[]): string {
  let max = 0
  for (const row of rows) {
    const match = /^TURN-(\d+)$/.exec(String(row['过站编号'] ?? ''))
    if (match) {
      max = Math.max(max, Number(match[1]))
    }
  }
  return `TURN-${String(max + 1).padStart(4, '0')}`
}

/** 过站监控台账的到达待办：同一转运编号只生成一条。 */
function buildArrivalTodo(item: HandoverItem, turnaroundRows: EntryRow[]): EntryRow {
  const nextId = turnaroundRows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  return {
    id: nextId,
    status: '待监测',
    pending: true,
    abnormal: false,
    过站编号: nextTurnaroundCode(turnaroundRows),
    关联航班: item.关联航班,
    计划到港: '',
    实际到港: '',
    过站时长: '',
    保障进度: `行李 ${item.转运编号} 整组交接，待到达 ${item.到达转盘}`,
    异常事项: '',
    过站状态: '到达待办',
    转运编号: item.转运编号,
  }
}

/** 行李件数从记录里读出时归一为 string | number（布尔值按字符串处理，校验时会拦下）。 */
function asCount(value: string | number | boolean | undefined): string | number {
  return typeof value === 'number' ? value : String(value ?? '')
}

function applyAdjust(item: HandoverItem, adjust?: HandoverAdjust): void {  if (!adjust) {
    return
  }
  if (adjust.行李件数 !== undefined) {
    item.行李件数 = adjust.行李件数.trim()
  }
  if (adjust.出发转盘 !== undefined) {
    item.出发转盘 = adjust.出发转盘.trim()
  }
  if (adjust.到达转盘 !== undefined) {
    item.到达转盘 = adjust.到达转盘.trim()
  }
}

function validateItem(item: HandoverItem): string {
  if (!item.转运编号.trim()) {
    return '转运编号不能为空'
  }
  if (!item.关联航班.trim()) {
    return '关联航班不能为空'
  }
  const count = Number(item.行李件数)
  if (!Number.isInteger(count) || count <= 0) {
    return '行李件数必须为正整数'
  }
  if (!item.出发转盘.trim()) {
    return '出发转盘不能为空'
  }
  if (!item.到达转盘.trim()) {
    return '到达转盘不能为空'
  }
  return ''
}

function failItem(group: HandoverGroup, item: HandoverItem, index: number, message: string): void {
  item.state = '失败'
  item.message = message
  group.failedIndex = index
}

/** 逐条处理整组：跳过已交接条目，从失败那一行继续；返回新生成的到达待办数。 */
function processGroup(group: HandoverGroup, baggageRows: EntryRow[]): number {
  const turnaroundRows = listRows('turnaround').map((row) => ({ ...row }))
  let synced = 0
  for (let i = 0; i < group.items.length; i += 1) {
    const item = group.items[i]
    if (item.state === '已交接') {
      continue
    }
    const row = baggageRows.find((entry) => Number(entry.id) === item.entryId)
    if (!row) {
      failItem(group, item, i, '行李转运记录不存在')
      break
    }
    const status = baggageStatus(row)
    if (status === ARRIVED) {
      failItem(group, item, i, '已到达记录不得退回')
      break
    }
    if (status !== NOT_STARTED) {
      failItem(group, item, i, `当前状态「${row.status}」不是待卸机，不能整组交接`)
      break
    }
    // 批量调整未开始条目：把调整后的值写回转运记录
    row['行李件数'] = item.行李件数
    row['出发转盘'] = item.出发转盘
    row['到达转盘'] = item.到达转盘
    const problem = validateItem(item)
    if (problem) {
      failItem(group, item, i, problem)
      break
    }
    // 转盘冲突：以转运中记录已锁定的转盘为准
    const locked = lockedCarousels(baggageRows, item.entryId)
    const fromLockedBy = locked.get(item.出发转盘)
    if (fromLockedBy) {
      failItem(group, item, i, `出发转盘 ${item.出发转盘} 已被 ${fromLockedBy} 锁定，以已锁定转盘为准`)
      break
    }
    const toLockedBy = locked.get(item.到达转盘)
    if (toLockedBy) {
      failItem(group, item, i, `到达转盘 ${item.到达转盘} 已被 ${toLockedBy} 锁定，以已锁定转盘为准`)
      break
    }
    // 交接成功：进入转运中并锁定转盘
    row.status = IN_TRANSIT
    row.pending = true
    row.abnormal = false
    item.行李件数 = Number(item.行李件数)
    item.state = '已交接'
    item.message = '已交接，转运中'
    // 过站监控台账同步生成到达待办
    if (!turnaroundRows.some((entry) => String(entry['转运编号'] ?? '') === item.转运编号)) {
      turnaroundRows.push(buildArrivalTodo(item, turnaroundRows))
      synced += 1
    }
  }
  const done = group.items.every((item) => item.state === '已交接')
  group.status = done ? '已完成' : '失败'
  group.failedIndex = done ? null : group.items.findIndex((item) => item.state === '失败')
  saveRows('baggage', baggageRows)
  saveRows('turnaround', turnaroundRows)
  return synced
}

/**
 * 提交整组交接：多选待卸机航班一次提交。
 * 重复提交同一整组只保留首个版本；首个版本失败时在原版本上从失败行继续。
 */
export function submitGroupHandover(
  entryIds: number[],
  adjusts: Record<number, HandoverAdjust> = {},
): HandoverResult {
  const uniqueIds = [...new Set(entryIds.map(Number))]
  if (uniqueIds.length === 0) {
    return { ok: false, duplicated: false, resumed: false, message: '请先多选待卸机航班再提交整组交接', group: null }
  }
  const rows = listRows('baggage').map((row) => ({ ...row }))
  const byId = new Map(rows.map((row) => [Number(row.id), row]))
  const codes: string[] = []
  for (const id of uniqueIds) {
    const row = byId.get(id)
    if (!row) {
      return { ok: false, duplicated: false, resumed: false, message: `没有找到编号为 ${id} 的行李转运`, group: null }
    }
    codes.push(String(row['转运编号'] ?? ''))
  }
  const key = groupKeyOf(codes)
  const groups = loadGroups()
  const existing = groups.find((group) => group.key === key) ?? null

  // 重复提交同一整组：首个版本已完成时不再处理，只保留首个版本
  if (existing && existing.status === '已完成') {
    return {
      ok: true,
      duplicated: true,
      resumed: false,
      message: '同一整组重复提交，只保留首个版本，本次未重复处理',
      group: existing,
    }
  }

  let group = existing
  const resumed = group !== null
  if (group) {
    // 从失败那一行继续：已交接条目保留，未开始条目应用本次批量调整
    for (const item of group.items) {
      if (item.state !== '已交接') {
        applyAdjust(item, adjusts[item.entryId])
      }
    }
  } else {
    // 首个版本：所选航班必须都未开始
    for (const id of uniqueIds) {
      const row = byId.get(id) as EntryRow
      const reason = handoverBlockReason(row)
      if (reason) {
        return { ok: false, duplicated: false, resumed: false, message: `${row['转运编号']}：${reason}`, group: null }
      }
    }
    group = {
      key,
      version: 1,
      createdAt: new Date().toISOString(),
      status: '处理中',
      failedIndex: null,
      items: uniqueIds.map((id) => {
        const row = byId.get(id) as EntryRow
        const item: HandoverItem = {
          entryId: id,
          转运编号: String(row['转运编号'] ?? ''),
          关联航班: String(row['关联航班'] ?? ''),
          行李件数: asCount(row['行李件数']),
          出发转盘: String(row['出发转盘'] ?? ''),
          到达转盘: String(row['到达转盘'] ?? ''),
          state: '待处理',
          message: '',
        }
        applyAdjust(item, adjusts[id])
        return item
      }),
    }
    groups.push(group)
  }

  const synced = processGroup(group, rows)
  saveGroups(groups)

  const total = group.items.length
  const doneCount = group.items.filter((item) => item.state === '已交接').length
  if (group.status === '已完成') {
    return {
      ok: true,
      duplicated: false,
      resumed,
      message: `${resumed ? '从失败行继续，' : ''}整组交接完成：${doneCount}/${total} 条已交接，过站监控同步生成 ${synced} 条到达待办`,
      group,
    }
  }
  const failed = group.failedIndex === null ? null : group.items[group.failedIndex]
  return {
    ok: false,
    duplicated: false,
    resumed,
    message: `第 ${(group.failedIndex ?? 0) + 1} 行（${failed?.转运编号 ?? '—'}）交接失败：${failed?.message ?? ''}。已交接 ${doneCount} 条保留不变，可批量调整未开始条目后重新提交，将从失败行继续`,
    group,
  }
}
