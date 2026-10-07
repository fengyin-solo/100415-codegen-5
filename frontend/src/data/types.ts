/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  /** 终态状态：进入后不得退回或再变更（如行李转运的「已到达」）。 */
  finalStatuses?: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 整组交接里一条转运指令的处理进度。 */
export type HandoverRowState = '待处理' | '已处理' | '失败'

/** 整组交接的一行：按转运编号逐条处理，五要素随批次快照保存。 */
export type HandoverRow = {
  转运编号: string
  关联航班: string
  行李件数: string
  出发转盘: string
  到达转盘: string
  state: HandoverRowState
  message: string
}

/** 一次整组交接批次：重复提交只保留首个版本，失败可从失败那一行继续。 */
export type HandoverGroup = {
  id: string
  /** 幂等键：排序后的转运编号列表，同一整组重复提交时靠它识别。 */
  key: string
  createdAt: string
  status: '处理中' | '已完成' | '部分失败' | '失败'
  rows: HandoverRow[]
}

export type HandoverResult = {
  ok: boolean
  message: string
  group: HandoverGroup | null
  /** 重复提交同一整组时为 true，返回的是首个版本。 */
  duplicated: boolean
}
