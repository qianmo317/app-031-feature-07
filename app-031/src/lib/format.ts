// 通用工具：ID、金额、面积格式化、文件下载、CSV 解析
import type { EdgeSide, GrainDemand } from '../types'

export function uid(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function money(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`
}

export function mm(v: number): string {
  return `${Math.round(v)}`
}

export function areaM2(mm2: number): string {
  return `${(mm2 / 1_000_000).toFixed(2)}m²`
}

export function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

export function downloadText(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ===== 批量粘贴解析 =====
// 兼容店里从 Excel 拷出的常见格式：
// 开头允许有合并的大标题行与单位行（mm / cm 等），表头靠关键词识别；
// 长宽按「列单位」（单位行或表头括号里写的）换算成毫米，也可逐格带单位；
// 封边认中文（上/顶/下/底/左/右）、英文（top/bottom/left/right 及缩写 t/b/l/r）
// 和数字（1上 2下 3左 4右，中文一二三四同义）；
// 纹理认 顺纹/竖纹→length、横纹→width、无/无要求→none；
// 同一件号多行自动合并、数量相加；名称为空的行跳过。

export interface ParsedPartRow {
  code: string
  name: string
  lenMm: number
  widMm: number
  qty: number
  grain: GrainDemand
  edges: EdgeSide[]
  cabinet: string
  exposed: boolean
  sourceLines: number[] // 组成这条记录的原始行号（含被合并的重复件号行）
}

export interface PartParseIssue {
  row: number
  column: string
  message: string
  raw: string // 出错那一行的原样内容
}

export interface PartParseResult {
  rows: ParsedPartRow[]
  issues: PartParseIssue[]
  skippedBlankName: { row: number; raw: string }[]
  mergedGroups: { code: string; qty: number; lines: number[] }[]
  skippedPreamble: number // 跳过的开头标题/单位行行数
  dataLineCount: number // 参与解析的数据行数（不含空行、前导标题/单位行）
}

type ColKey =
  | 'code'
  | 'name'
  | 'lenMm'
  | 'widMm'
  | 'qty'
  | 'grain'
  | 'edges'
  | 'cabinet'
  | 'exposed'

const FIXED_ORDER: ColKey[] = [
  'name',
  'lenMm',
  'widMm',
  'qty',
  'grain',
  'edges',
  'cabinet',
  'exposed'
]

// 多字别名用包含匹配；单字别名（l/w/n 等）必须整格相等，避免误伤
const HEADER_HINTS: { key: ColKey; multi: string[]; exact: string[] }[] = [
  { key: 'code', multi: ['编号', '编码', '件号', '零件号', '代号', '代码', 'code', 'sku'], exact: [] },
  { key: 'name', multi: ['名称', '零件', '品名', '部件', 'name'], exact: [] },
  {
    key: 'lenMm',
    multi: ['长度', '长(mm)', '长（mm）', 'len', 'length'],
    exact: ['长', 'l', '长mm']
  },
  {
    key: 'widMm',
    multi: ['宽度', '宽(mm)', '宽（mm）', 'wid', 'width'],
    exact: ['宽', 'w', '宽mm']
  },
  { key: 'qty', multi: ['数量', '件数', '个数', 'qty', 'count'], exact: ['数', 'n'] },
  { key: 'grain', multi: ['纹理', '纹路', '木纹', 'grain'], exact: [] },
  {
    key: 'edges',
    multi: ['封边', '包边', '边封', 'edge', 'edges', 'banding'],
    exact: []
  },
  { key: 'cabinet', multi: ['柜体', '房间', '所在柜', 'cabinet'], exact: ['柜'] },
  { key: 'exposed', multi: ['见光', '外露', 'exposed', 'visible'], exact: [] }
]

const COL_CN: Record<ColKey, string> = {
  code: '件号',
  name: '名称',
  lenMm: '长',
  widMm: '宽',
  qty: '数量',
  grain: '纹理',
  edges: '封边',
  cabinet: '柜体',
  exposed: '见光'
}

/** 全角字符与常见空白归一化（不改变原始行内容，仅用于取值）。 */
function normCell(s: string): string {
  return s
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[Ａ-Ｚａ-ｚ]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[．]/g, '.')
    .replace(/[－]/g, '-')
    .replace(/[　\s]/g, '')
}

function detectSeparator(line: string): RegExp {
  if (line.includes('\t')) return /\t/
  if (line.includes(',')) return /,/
  if (/[;；]/.test(line)) return /[;；]/
  if (/[|｜]/.test(line)) return /[|｜]/
  return /\t/ // 单格内容按整格处理
}

function splitCells(line: string): string[] {
  const sep = detectSeparator(line)
  return line
    .split(sep)
    .map((c) => c.trim().replace(/^["']|["']$/g, ''))
}

function headerMatch(text: string): ColKey | undefined {
  // 去掉「(mm)」「（厘米）」之类括号单位，便于命中 长/宽 等短表头
  const t = text
    .toLowerCase()
    .replace(/[(（【【\[][^()（）【】\[\]]*[)）】】\]]/g, '')
    .trim()
  for (const h of HEADER_HINTS) {
    if (h.exact.some((e) => t === e)) return h.key
    if (h.multi.some((m) => t.includes(m))) return h.key
  }
  return undefined
}

const DIM_UNIT_TOKENS = /^(mm|cm|m|毫米?|厘米?|公分?|米)(\/(mm|cm|m|毫米?|厘米?|公分?))*$/
const UNITISH_TOKENS = /^(mm|cm|m|毫米?|厘米?|公分?|米|件|个|条|片|块|张|pcs?|unit|units?)$/

/** 识别单位行：多数非空格是单位字样，且至少一个长度单位（毫米/厘米/米）。 */
function matchUnitRow(cells: string[]): Record<number, string> | null {
  const nonEmpty = cells.filter((c) => normCell(c) !== '')
  if (nonEmpty.length === 0) return null
  const units: Record<number, string> = {}
  let hits = 0
  cells.forEach((raw, i) => {
    const c = normCell(raw)
      .replace(/[()（）【】\[\]{}]/g, '')
      .toLowerCase()
    if (!c) return
    if (UNITISH_TOKENS.test(c)) {
      hits++
      units[i] = c
    }
  })
  const hasDimUnit = Object.values(units).some((u) => DIM_UNIT_TOKENS.test(u))
  if (hasDimUnit && hits / nonEmpty.length >= 0.6) return units
  return null
}

/** 从表头括号或单位行单元格里取出长宽列单位：mm / cm / m。 */
function dimUnitOf(text: string): 'mm' | 'cm' | 'm' | null {
  const t = normCell(text).toLowerCase()
  // 顺序敏感：毫米/厘米 都含「米」，mm/cm 要先于 m
  if (/毫米|mm/.test(t)) return 'mm'
  if (/厘米|公分|cm/.test(t)) return 'cm'
  if (/米|(?:^|[^a-z])m(?:[^a-z]|$)/.test(t)) return 'm'
  return null
}

/** 解析一个长宽单元格：数字后缀单位优先，否则用列单位；结果按整数取整成毫米。 */
function parseDimension(raw: string, colUnit: 'mm' | 'cm' | 'm' | null): number | null {
  const t = normCell(raw).toLowerCase()
  if (!t) return null
  let num: number
  let unit = colUnit
  // 注意单位备选顺序：mm/cm 在 m 前、毫米/厘米/公分 在 米 前
  const m = t.match(/^([0-9]+(?:\.[0-9]+)?)(mm|cm|m|毫米|厘米|公分|米)?$/)
  if (!m) return null
  num = Number(m[1])
  if (m[2]) {
    const u = m[2]
    unit = /mm|毫米/.test(u) ? 'mm' : /cm|厘米|公分/.test(u) ? 'cm' : 'm'
  }
  if (!Number.isFinite(num) || num <= 0) return null
  const factor = unit === 'cm' ? 10 : unit === 'm' ? 1000 : 1
  // 毫米与厘米（及米）的换算按整数取整
  return Math.round(num * factor)
}

/** 纹理归一：顺纹/竖纹 → length，横纹 → width，无 → none。空值按无要求。 */
export function parseGrain(text: string): GrainDemand | null {
  const t = normCell(text)
  if (!t) return 'none'
  if (/顺|竖|纵|直纹|长纹/.test(t) || /^(length|long|l|纵向|顺向)$/.test(t.toLowerCase()))
    return 'length'
  if (/横|宽纹/.test(t) || /^(width|wide|w|横向)$/.test(t.toLowerCase())) return 'width'
  if (/^(无|无要求|不挑|随意|none|no|n|-)$/i.test(t)) return 'none'
  return null
}

/**
 * 把封边文本转成边集合。
 * 中文：上/顶、下/底、左、右；英文：top/bottom/left/right 及 t/b/l/r；
 * 数字：1=上 2=下 3=左 4=右，中文数字 一二三四 同义；四边/无 为整体写法。
 * 返回 unknown 片段（去掉可识别内容后仍有残留即视为写法有误）。
 */
export function parseEdges(text: string): { sides: EdgeSide[]; unknown: string } {
  const t0 = normCell(text)
  if (!t0 || /^(无|无封边|不封|none|no|0|-+)$/i.test(t0))
    return { sides: [], unknown: '' }
  const sides = new Set<EdgeSide>()
  let unknown = ''
  // 按可识别词切分：长词（top/四边…）优先于单字，剩余片段即无法识别内容
  const TOKEN =
    /(?:top|bottom|left|right|四边|四周|全封|封四边|all|full|[tblr1-4一二三四上下左右顶底])/gi
  let last = 0
  let m: RegExpExecArray | null
  const add = (tok: string): void => {
    const x = tok.toLowerCase()
    if (/top|^t$|^1$|^一$|上|顶/.test(x)) sides.add('top')
    if (/bottom|^b$|^2$|^二$|下|底/.test(x)) sides.add('bottom')
    if (/left|^l$|^3$|^三$|左/.test(x)) sides.add('left')
    if (/right|^r$|^4$|^四$|右/.test(x)) sides.add('right')
    if (/四边|四周|全封|all|full/.test(x))
      ['top', 'bottom', 'left', 'right'].forEach((s) => sides.add(s as EdgeSide))
  }
  while ((m = TOKEN.exec(t0))) {
    const gap = t0.slice(last, m.index)
    if (/[^，,、。.//\\;；:：()（）\s]/.test(gap)) unknown += gap.replace(/[\s，,、。.//\\;；:：()（）]/g, '')
    add(m[0])
    last = m.index + m[0].length
  }
  const tail = t0.slice(last)
  if (/[^，,、。.//\\;；:：()（）\s]/.test(tail))
    unknown += tail.replace(/[\s，,、。.//\\;；:：()（）]/g, '')
  return { sides: [...sides], unknown }
}

/** 解析粘贴的 TSV/CSV 零件清单（标题行/单位行/多种单位与写法均兼容）。 */
export function parsePartText(text: string): PartParseResult {
  const result: PartParseResult = {
    rows: [],
    issues: [],
    skippedBlankName: [],
    mergedGroups: [],
    skippedPreamble: 0,
    dataLineCount: 0
  }
  // 保留整行原样用于报错；仅去掉行尾回车
  const rawLines = text.replace(/\r\n?/g, '\n').split('\n')
  const nonBlankIdx: number[] = []
  rawLines.forEach((l, i) => {
    if (l.trim() !== '') nonBlankIdx.push(i)
  })
  if (nonBlankIdx.length === 0) {
    result.issues.push({ row: 0, column: '', message: '没有可解析的内容', raw: '' })
    return result
  }

  // 在前若干个非空行里找表头
  let headerLineNo = -1
  let headerMap: Partial<Record<ColKey, number>> = {}
  const scan = nonBlankIdx.slice(0, 6)
  for (const lineNo of scan) {
    const cells = splitCells(rawLines[lineNo]).map((c) => normCell(c).toLowerCase())
    const seenCol = new Set<number>()
    const matched = new Set<ColKey>()
    cells.forEach((c, i) => {
      const k = headerMatch(c)
      if (k && !seenCol.has(i)) {
        seenCol.add(i)
        matched.add(k)
        headerMap[k] = i
      }
    })
    const distinct = Object.keys(headerMap).length
    // 至少命中两列、且包含长或宽，才算表头（大标题行一般只命中名称一列）
    if (distinct >= 2 && matched.size >= 2 && (matched.has('lenMm') || matched.has('widMm'))) {
      headerLineNo = lineNo
      break
    }
    headerMap = {}
  }

  let dataStart: number
  let colUnits: Partial<Record<ColKey, 'mm' | 'cm' | 'm'>> = {}
  let headerCells: string[] = []
  let colLabels: string[] = []
  if (headerLineNo >= 0) {
    headerCells = splitCells(rawLines[headerLineNo])
    colLabels = headerCells.map((c) => c.trim())
    dataStart = headerLineNo + 1
    result.skippedPreamble = nonBlankIdx.filter((i) => i < headerLineNo).length
    // 表头括号里写的单位，如「长度(cm)」
    for (const k of ['lenMm', 'widMm'] as ColKey[]) {
      const ci = headerMap[k]
      if (ci !== undefined) {
        const u = dimUnitOf(headerCells[ci] ?? '')
        if (u) colUnits[k] = u
      }
    }
    // 紧跟表头的单位行（可能 1~2 行），单位行的列单位覆盖表头括号
    for (let n = 0; n < 2 && dataStart < rawLines.length; n++) {
      while (dataStart < rawLines.length && rawLines[dataStart].trim() === '') dataStart++
      if (dataStart >= rawLines.length) break
      const cells = splitCells(rawLines[dataStart])
      const urow = matchUnitRow(cells)
      if (!urow) break
      result.skippedPreamble++
      dataStart++
      for (const [ciStr, utext] of Object.entries(urow)) {
        const ci = Number(ciStr)
        const u = dimUnitOf(utext)
        if (!u) continue
        if (headerMap.lenMm === ci) colUnits.lenMm = u
        else if (headerMap.widMm === ci) colUnits.widMm = u
      }
    }
  } else {
    // 无表头：按「名称,长,宽,数量,纹理,封边,柜体,见光」固定列序
    FIXED_ORDER.forEach((k, i) => (headerMap[k] = i))
    colLabels = FIXED_ORDER.map((k) => COL_CN[k])
    dataStart = 0
  }

  const colLabel = (k: ColKey): string => {
    const i = headerMap[k]
    return i !== undefined && colLabels[i] ? colLabels[i] : COL_CN[k]
  }
  const getCell = (cells: string[], k: ColKey): string => {
    const i = headerMap[k]
    return i === undefined || i >= cells.length ? '' : cells[i]
  }

  const pushIssue = (
    lineNo: number,
    key: ColKey | '',
    message: string
  ): void => {
    result.issues.push({
      row: lineNo + 1,
      column: key === '' ? '' : colLabel(key),
      message,
      raw: rawLines[lineNo]
    })
  }

  const byCode = new Map<
    string,
    { row: ParsedPartRow; firstLine: number; len: number; wid: number; grain: GrainDemand; edges: string }
  >()

  for (let lineNo = dataStart; lineNo < rawLines.length; lineNo++) {
    if (rawLines[lineNo].trim() === '') continue // 完全空行静默跳过
    result.dataLineCount++
    const cells = splitCells(rawLines[lineNo])
    const name = getCell(cells, 'name').trim()
    if (!name) {
      // 名称列为空的行跳过
      result.skippedBlankName.push({ row: lineNo + 1, raw: rawLines[lineNo] })
      continue
    }

    // 长
    let lenMm: number | null = null
    const lenRaw = getCell(cells, 'lenMm')
    if (normCell(lenRaw) === '') {
      pushIssue(lineNo, 'lenMm', '长未填写，需为正数（可带 mm/cm 单位）')
    } else {
      lenMm = parseDimension(lenRaw, colUnits.lenMm ?? null)
      if (lenMm === null || lenMm <= 0)
        pushIssue(lineNo, 'lenMm', '长无效，需为正数（如 2200、220cm、2.2m）')
    }

    // 宽
    let widMm: number | null = null
    const widRaw = getCell(cells, 'widMm')
    if (normCell(widRaw) === '') {
      pushIssue(lineNo, 'widMm', '宽未填写，需为正数（可带 mm/cm 单位）')
    } else {
      widMm = parseDimension(widRaw, colUnits.widMm ?? null)
      if (widMm === null || widMm <= 0)
        pushIssue(lineNo, 'widMm', '宽无效，需为正数（如 450、45cm、0.45m）')
    }

    // 数量：只认正整数（空值默认 1）
    let qty = 1
    const qtyRaw = normCell(getCell(cells, 'qty'))
    if (qtyRaw !== '') {
      if (!/^[0-9]+$/.test(qtyRaw) || Number(qtyRaw) <= 0) {
        pushIssue(lineNo, 'qty', '数量无效，只认正整数')
        qty = NaN
      } else {
        qty = Number(qtyRaw)
      }
    }

    // 纹理
    let grain: GrainDemand = 'none'
    const grainRaw = getCell(cells, 'grain')
    const g = parseGrain(grainRaw)
    if (g === null) {
      pushIssue(lineNo, 'grain', '纹理无法识别（认 顺纹/竖纹、横纹、无）')
    } else {
      grain = g
    }

    // 封边
    let edges: EdgeSide[] = []
    const edgeRes = parseEdges(getCell(cells, 'edges'))
    if (edgeRes.unknown) {
      pushIssue(
        lineNo,
        'edges',
        `封边写法无法识别：「${edgeRes.unknown}」（认 上/下/左/右、T/B/L/R、1/2/3/4 或一二三四）`
      )
    }
    edges = edgeRes.sides

    // 见光
    const expRaw = normCell(getCell(cells, 'exposed')).toLowerCase()
    const exposed = /^(是|见光|有|true|t|yes|y|1)$/.test(expRaw)

    // 任一列有硬错误，本行不入结果
    if (lenMm === null || widMm === null || Number.isNaN(qty) || g === null) continue

    const code = getCell(cells, 'code').trim()
    const row: ParsedPartRow = {
      code,
      name,
      lenMm,
      widMm,
      qty,
      grain,
      edges,
      cabinet: getCell(cells, 'cabinet').trim() || '未分组',
      exposed,
      sourceLines: [lineNo + 1]
    }

    // 同一件号重复：按规矩并成一条，数量相加
    if (code && byCode.has(code)) {
      const prev = byCode.get(code)!
      if (
        prev.len === lenMm &&
        prev.wid === widMm &&
        prev.grain === grain &&
        prev.edges === edges.slice().sort().join(',')
      ) {
        prev.row.qty += qty
        prev.row.sourceLines.push(lineNo + 1)
      } else {
        pushIssue(
          lineNo,
          'code',
          `件号「${code}」与第 ${prev.firstLine + 1} 行规格不一致（${prev.len}×${prev.wid} vs ${lenMm}×${widMm}），不能合并，请改用不同件号`
        )
      }
      continue
    }
    byCode.set(code || `__nocode_${result.rows.length}`, {
      row,
      firstLine: lineNo,
      len: lenMm,
      wid: widMm,
      grain,
      edges: edges.slice().sort().join(',')
    })
    result.rows.push(row)
  }

  // 汇总合并情况
  result.mergedGroups = []
  for (const { row } of byCode.values()) {
    if (row.sourceLines.length > 1)
      result.mergedGroups.push({ code: row.code, qty: row.qty, lines: row.sourceLines })
  }

  return result
}
