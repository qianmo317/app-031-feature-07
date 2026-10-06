// 通用工具：ID、金额、面积格式化、文件下载、清单粘贴解析
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

export interface ParsedPartRow {
  code: string
  name: string
  lenMm: number
  widMm: number
  qty: number
  grain: GrainDemand
  edgeBands: EdgeSide[]
  cabinet: string
  exposed: boolean
  sourceLines: number[] // 合并前行号（原始行号，1 起）
  mergedQty: number // 合并的行数（>1 表示由重复件号合并而来）
}

export interface ParseIssue {
  kind: 'error' | 'notice'
  line: number // 原始行号（1 起），0 表示不针对单行
  col: number // 列号（1 起），0 表示不针对单列
  colName: string
  message: string
  raw: string // 该行原样内容
}

export interface PartParseResult {
  rows: ParsedPartRow[]
  errors: ParseIssue[]
  notices: ParseIssue[]
  headerLine: number
  unitLine: number
}

type ColKey = 'code' | 'name' | 'lenMm' | 'widMm' | 'qty' | 'grain' | 'edges' | 'cabinet' | 'exposed'

const COL_LABEL: Record<ColKey, string> = {
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

const HEADER_HINTS: Record<ColKey, string[]> = {
  code: ['件号', '编号', '编码', '零件号', '板件号', '图号', '料号', '代码', 'code', 'no', 'id'],
  name: ['名称', '零件名称', '品名', '部件', '零件', 'name', 'part'],
  lenMm: ['长', '长度', '长(mm)', 'len', 'length', 'l'],
  widMm: ['宽', '宽度', '宽(mm)', 'wid', 'width', 'w'],
  qty: ['数量', '件数', '数', 'qty', 'qty.', 'count', 'num', 'n'],
  grain: ['纹理', '纹路', '木纹', '纹理方向', 'grain'],
  edges: ['封边', '封边边', '包边', '封边条', 'edge', 'edges'],
  cabinet: ['柜体', '房间', '柜', '分组', 'cabinet'],
  exposed: ['见光', '见光面', '外露', 'exposed']
}

const HEADERLESS_ORDER: ColKey[] = [
  'name',
  'lenMm',
  'widMm',
  'qty',
  'grain',
  'edges',
  'cabinet',
  'exposed'
]

/** 识别为表头所需的最少命中列数。 */
const MIN_HEADER_HITS = 3

/** 长度单位 token → 毫米倍数。 */
const UNIT_FACTOR: Record<string, number> = {
  mm: 1,
  mms: 1,
  millimetre: 1,
  millimeter: 1,
  毫米: 1,
  cm: 10,
  cms: 10,
  centimetre: 10,
  centimeter: 10,
  厘米: 10,
  公分: 10
}

export function splitCells(line: string): string[] {
  // 一行里制表符优先，其次英文逗号，再其次分号；都没有时整行作为一个单元格
  let sep: string | RegExp = '\t'
  if (!line.includes('\t')) {
    if (line.includes(',')) sep = ','
    else if (/[;；]/.test(line)) sep = /[;；]/
  }
  return line.split(sep).map((c) => c.trim().replace(/^["']|["']$/g, ''))
}

function headerHitScore(cell: string, key: ColKey): boolean {
  const c = cell.toLowerCase().replace(/\s+/g, '')
  if (!c) return false
  return HEADER_HINTS[key].some((h) => {
    const hh = h.toLowerCase()
    return hh.length === 1 ? c === hh : c.includes(hh)
  })
}

/** 在开头若干行里定位表头行；找不到时返回 -1（按无表头处理）。 */
function locateHeader(
  rawLines: string[]
): { line: number; map: Partial<Record<ColKey, number>>; cells: string[] } {
  let best: { line: number; map: Partial<Record<ColKey, number>>; cells: string[]; hits: number } = {
    line: -1,
    map: {},
    cells: [],
    hits: 0
  }
  const scan = Math.min(rawLines.length, 8)
  for (let i = 0; i < scan; i++) {
    const cells = splitCells(rawLines[i])
    const map: Partial<Record<ColKey, number>> = {}
    for (const key of Object.keys(HEADER_HINTS) as ColKey[]) {
      const idx = cells.findIndex((cell) => headerHitScore(cell, key))
      if (idx >= 0) map[key] = idx
    }
    const hits = Object.keys(map).length
    const lenCol = map.lenMm
    const widCol = map.widMm
    // 长、宽必须都有且不在同一列，且整体命中数达标，防止「规格：长×宽」合并标题行误判
    if (
      hits >= MIN_HEADER_HITS &&
      lenCol !== undefined &&
      widCol !== undefined &&
      lenCol !== widCol &&
      hits > best.hits
    ) {
      best = { line: i, map, cells, hits }
    }
  }
  return { line: best.line, map: best.map, cells: best.cells }
}

/** 判断表头下一行是否为单位行（如 mm / 厘米 / cm），返回各列的毫米倍数。 */
function detectUnitRow(
  line: string | undefined,
  map: Partial<Record<ColKey, number>>
): Record<number, number> | null {
  if (!line) return null
  const cells = splitCells(line)
  if (cells.length < 2) return null
  if (/\d/.test(line)) return null // 单位行不含数字
  const factors: Record<number, number> = {}
  let unitHit = 0
  cells.forEach((cell, i) => {
    const u = cell.toLowerCase().replace(/[\s()（）.。]/g, '')
    if (!u) return
    const f = UNIT_FACTOR[u]
    if (f) {
      factors[i] = f
      unitHit++
    }
  })
  if (unitHit === 0) return null
  // 至少有一个长度单位落在长/宽列上才算数
  const onDim =
    (map.lenMm !== undefined && factors[map.lenMm]) ||
    (map.widMm !== undefined && factors[map.widMm])
  if (!onDim) return null
  return factors
}

const DIM_RE = /^([+-]?\d+(?:\.\d+)?)\s*(毫米|厘米|公分|mm|cm)?$/i

/**
 * 解析长宽单元格。单元格内写了单位时以单元格为准，否则用该列单位（默认 mm）。
 * 毫米/厘米一律 Math.round 取整。
 */
function parseDimension(raw: string, colFactor: number): { value: number } | { error: string } {
  const t = raw.trim()
  if (!t) return { error: '为空' }
  const m = t.match(DIM_RE)
  if (!m) return { error: `「${raw}」不是合法尺寸` }
  const num = Number(m[1])
  if (!Number.isFinite(num) || num <= 0) return { error: `「${raw}」不是正数` }
  const factor = m[2] ? UNIT_FACTOR[m[2].toLowerCase()] ?? 1 : colFactor
  const value = Math.round(num * factor)
  if (value < 1) return { error: `「${raw}」换算后不足 1mm` }
  return { value }
}

const QTY_RE = /^(\d+)\s*(件|块|片|张|个|pcs?|pcs\.?)?$/i

/** 数量只认正整数；空单元格默认 1（沿用原导入习惯）。 */
function parseQty(raw: string): { value: number } | { error: string } {
  const t = raw.trim()
  if (!t) return { value: 1 }
  const m = t.match(QTY_RE)
  if (!m) return { error: `「${raw}」不是正整数` }
  const value = Number(m[1])
  if (value < 1) return { error: `数量 ${value} 不是正整数` }
  return { value }
}

/** 纹理：顺纹/竖纹→length，横纹→width，无→none；空默认无要求；其余报错。 */
function decodeGrain(raw: string): { value: GrainDemand } | { error: string } {
  const t = raw.trim().toLowerCase().replace(/\s+/g, '')
  if (!t || /^(无.*|不限|随意|none.*|n\/a|na|-+)$/.test(t)) return { value: 'none' }
  if (/顺|竖|长|length|long|l/.test(t)) return { value: 'length' }
  if (/横|宽|width|w/.test(t)) return { value: 'width' }
  return { error: `「${raw}」无法识别（支持：顺纹/竖纹、横纹、无）` }
}

const EDGE_TOKENS: { re: RegExp; side: EdgeSide }[] = [
  { re: /^(上|顶|上边|顶部|top|t|1|一|①)$/, side: 'top' },
  { re: /^(下|底|下边|底部|bottom|b|2|二|②)$/, side: 'bottom' },
  { re: /^(左|左边|左侧|left|l|3|三|③)$/, side: 'left' },
  { re: /^(右|右边|右侧|right|r|4|四|④)$/, side: 'right' }
]

/**
 * 封边严格解码，支持三种写法：
 *  - 中文：上下左右（含 顶/底、紧凑连写 上左下右、一二三四、四边/四周/全封）
 *  - 英文：top/bottom/left/right 及缩写 t/b/l/r（含紧凑连写 tblr）
 *  - 数字：1=上 2=下 3=左 4=右，0=无
 * 返回 sides 与无法识别的片段（用于精确报错）。
 */
export function decodeEdges(raw: string): { sides: EdgeSide[]; invalid: string[] } {
  let t = raw
    .trim()
    .toLowerCase()
    .replace(/[()（）\[\]【】\s.]/g, '')
  const invalid: string[] = []
  if (!t || /^(无|无封边|不封|none|0|-+)$/.test(t)) return { sides: [], invalid }
  // 全封类说法
  if (/^(四边|四周|四面|全封|封四边|all|4sides?|four)$/.test(t)) {
    return { sides: ['top', 'bottom', 'left', 'right'], invalid }
  }
  // 分隔符统一：顿号/逗号/斜杠/加号/顿号/和与等 → 顿号
  t = t.replace(/[,，、/／|和及与]+/g, '、')
  const sides = new Set<EdgeSide>()
  const sideOf = (tok: string): EdgeSide | null => {
    for (let i = 0; i < EDGE_TOKENS.length; i++) {
      if (EDGE_TOKENS[i].re.test(tok)) return EDGE_TOKENS[i].side
    }
    return null
  }
  for (const group of t.split('、').filter(Boolean)) {
    // 已知多字符词
    let rest = group
    const knownWords = [
      'top',
      'bottom',
      'left',
      'right',
      '上边',
      '顶部',
      '下边',
      '底部',
      '左边',
      '左侧',
      '右边',
      '右侧'
    ]
    for (const w of knownWords) {
      let idx: number
      while ((idx = rest.indexOf(w)) >= 0) {
        const s = sideOf(w)
        if (s) sides.add(s)
        rest = rest.slice(0, idx) + rest.slice(idx + w.length)
      }
    }
    if (!rest) continue
    // 逐字符：t/b/l/r、上下左右顶底、一二三四、1234、0 跳过；其余聚成非法片段
    let bad = ''
    const flush = (): void => {
      if (bad) {
        invalid.push(bad)
        bad = ''
      }
    }
    for (const ch of rest) {
      if (ch === '0') {
        flush()
        continue
      }
      const s = sideOf(ch)
      if (s) {
        flush()
        sides.add(s)
      } else {
        bad += ch
      }
    }
    flush()
  }
  return { sides: [...sides], invalid }
}

/** 把封边文本转成边集合（宽松封装，供单格编辑等场景复用）。 */
export function parseEdges(text: string): EdgeSide[] {
  return decodeEdges(text).sides
}

/** 解析粘贴的 TSV/CSV 零件清单（支持标题行/单位行/单位换算/封边多写法/件号合并）。 */
export function parsePartText(text: string): PartParseResult {
  const errors: ParseIssue[] = []
  const notices: ParseIssue[] = []
  // 保留原始行号（1 起）；纯空白行直接丢弃且不占语义
  const rawLines = text
    .split(/\r?\n/)
    .map((l, i) => ({ raw: l, no: i + 1 }))
    .filter((x) => x.raw.trim() !== '')
  if (rawLines.length === 0) {
    errors.push({
      kind: 'error',
      line: 0,
      col: 0,
      colName: '',
      message: '没有可解析的内容',
      raw: ''
    })
    return { rows: [], errors, notices, headerLine: 0, unitLine: 0 }
  }

  const { line: hIdx, map: headerMap } = locateHeader(rawLines.map((x) => x.raw))
  let colMap: Partial<Record<ColKey, number>>
  let dataStart: number
  let headerLine = 0
  if (hIdx >= 0) {
    colMap = headerMap
    headerLine = rawLines[hIdx].no
    dataStart = hIdx + 1
    if (hIdx > 0) {
      notices.push({
        kind: 'notice',
        line: 0,
        col: 0,
        colName: '',
        message: `已跳过开头 ${hIdx} 行标题行（第 ${rawLines[0].no}–${rawLines[hIdx - 1].no} 行）`,
        raw: rawLines
          .slice(0, hIdx)
          .map((x) => x.raw)
          .join('\n')
      })
    }
  } else {
    // 无表头：按「名称,长,宽,数量,纹理,封边,柜体,见光」固定列序
    colMap = {}
    HEADERLESS_ORDER.forEach((k, i) => (colMap[k] = i))
    dataStart = 0
  }

  // 单位行（紧跟表头）
  let unitLine = 0
  let colFactors: Record<number, number> = {}
  if (hIdx >= 0 && dataStart < rawLines.length) {
    const unit = detectUnitRow(rawLines[dataStart].raw, colMap)
    if (unit) {
      colFactors = unit
      unitLine = rawLines[dataStart].no
      dataStart++
      notices.push({
        kind: 'notice',
        line: unitLine,
        col: 0,
        colName: '',
        message: `已识别第 ${unitLine} 行为单位行（${Object.entries(colFactors)
          .map(([c, f]) => `第${Number(c) + 1}列${f === 10 ? '厘米' : '毫米'}`)
          .join('、')}）`,
        raw: rawLines[dataStart - 1].raw
      })
    }
  }

  const colName = (key: ColKey): string => {
    const i = colMap[key]
    return i === undefined ? COL_LABEL[key] : `${COL_LABEL[key]}(第${i + 1}列)`
  }
  const cellNo = (key: ColKey): number => (colMap[key] ?? -1) + 1

  const valid: ParsedPartRow[] = []
  let skippedEmptyName = 0

  for (let i = dataStart; i < rawLines.length; i++) {
    const { raw, no } = rawLines[i]
    const cells = splitCells(raw)
    const get = (key: ColKey): string => {
      const idx = colMap[key]
      return idx === undefined || idx >= cells.length ? '' : cells[idx]
    }

    // 名称为空：整行跳过并计数（先于其他列校验，避免连锁报错）
    if (!get('name').trim()) {
      skippedEmptyName++
      notices.push({
        kind: 'notice',
        line: no,
        col: cellNo('name'),
        colName: COL_LABEL.name,
        message: `第 ${no} 行名称列为空，已跳过`,
        raw
      })
      continue
    }

    let rowOk = true
    const fail = (key: ColKey, message: string): void => {
      rowOk = false
      errors.push({
        kind: 'error',
        line: no,
        col: cellNo(key),
        colName: COL_LABEL[key],
        message: `第 ${no} 行${colName(key)}：${message}`,
        raw
      })
    }

    const lenR = parseDimension(get('lenMm'), colFactors[colMap.lenMm ?? -1] ?? 1)
    const widR = parseDimension(get('widMm'), colFactors[colMap.widMm ?? -1] ?? 1)
    if ('error' in lenR) fail('lenMm', lenR.error)
    if ('error' in widR) fail('widMm', widR.error)
    const qtyR = parseQty(get('qty'))
    if ('error' in qtyR) fail('qty', qtyR.error)
    const grainR = decodeGrain(get('grain'))
    if ('error' in grainR) fail('grain', grainR.error)
    const edgeR = decodeEdges(get('edges'))
    if (edgeR.invalid.length > 0) {
      fail('edges', `封边写法无法识别「${edgeR.invalid.join('、')}」（支持 上下左右 / TBLR / 1234）`)
    }

    if (!rowOk) continue

    valid.push({
      code: get('code').trim(),
      name: get('name').trim(),
      lenMm: (lenR as { value: number }).value,
      widMm: (widR as { value: number }).value,
      qty: (qtyR as { value: number }).value,
      grain: (grainR as { value: GrainDemand }).value,
      edgeBands: edgeR.sides,
      cabinet: get('cabinet').trim() || '未分组',
      exposed: /是|true|1|y|见|外/.test(get('exposed').trim().toLowerCase()),
      sourceLines: [no],
      mergedQty: 1
    })
  }

  if (skippedEmptyName > 0) {
    const tip: ParseIssue = {
      kind: 'notice',
      line: 0,
      col: 0,
      colName: '',
      message: `名称为空共跳过 ${skippedEmptyName} 行`,
      raw: ''
    }
    // 汇总提示放在 notices 最前，便于一眼看到
    notices.unshift(tip)
  }

  // 件号合并：同件号（非空）行并成一条，数量相加；属性冲突报行列错
  const rows: ParsedPartRow[] = []
  const byCode = new Map<string, ParsedPartRow>()
  for (const r of valid) {
    const prev = r.code ? byCode.get(r.code) : undefined
    if (!prev) {
      byCode.set(r.code, r)
      rows.push(r)
      continue
    }
    const grainText: Record<GrainDemand, string> = { length: '竖纹', width: '横纹', none: '无要求' }
    const conflict = (key: ColKey, a: unknown, b: unknown): void => {
      errors.push({
        kind: 'error',
        line: r.sourceLines[0],
        col: cellNo(key),
        colName: COL_LABEL[key],
        message:
          `第 ${r.sourceLines[0]} 行${colName(key)}与第 ${prev.sourceLines[0]} 行件号「${r.code}」` +
          `重复但${COL_LABEL[key]}不一致（${String(a)} ≠ ${String(b)}），无法合并`,
        raw: rawLines.find((x) => x.no === r.sourceLines[0])?.raw ?? ''
      })
    }
    let bad = false
    if (prev.name !== r.name) {
      conflict('name', prev.name, r.name)
      bad = true
    }
    if (prev.lenMm !== r.lenMm || prev.widMm !== r.widMm) {
      conflict('lenMm', `${prev.lenMm}×${prev.widMm}mm`, `${r.lenMm}×${r.widMm}mm`)
      bad = true
    }
    if (prev.grain !== r.grain) {
      conflict('grain', grainText[prev.grain], grainText[r.grain])
      bad = true
    }
    if (
      ['top', 'bottom', 'left', 'right'].some(
        (s) => prev.edgeBands.includes(s as EdgeSide) !== r.edgeBands.includes(s as EdgeSide)
      )
    ) {
      conflict('edges', prev.edgeBands.join('') || '无', r.edgeBands.join('') || '无')
      bad = true
    }
    if (prev.cabinet !== r.cabinet) {
      conflict('cabinet', prev.cabinet, r.cabinet)
      bad = true
    }
    if (prev.exposed !== r.exposed) {
      conflict('exposed', prev.exposed ? '是' : '否', r.exposed ? '是' : '否')
      bad = true
    }
    if (bad) {
      // 冲突行不参与合并，独立保留；后续同件号行改与本行比较
      byCode.set(r.code, r)
      rows.push(r)
      continue
    }
    prev.qty += r.qty
    prev.sourceLines.push(...r.sourceLines)
    prev.mergedQty += 1
    notices.push({
      kind: 'notice',
      line: r.sourceLines[0],
      col: cellNo('code') > 0 ? cellNo('code') : 0,
      colName: COL_LABEL.code,
      message:
        `第 ${r.sourceLines[0]} 行件号「${r.code}」与第 ${prev.sourceLines.join('、')} 行` +
        `为同一件，已并入：数量 ${prev.qty - r.qty}+${r.qty}=${prev.qty}（共 ${prev.mergedQty} 行）`,
      raw: rawLines.find((x) => x.no === r.sourceLines[0])?.raw ?? ''
    })
  }

  return { rows, errors, notices, headerLine, unitLine }
}
