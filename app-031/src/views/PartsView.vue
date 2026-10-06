<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  useStore,
  getJob,
  saveJob,
  runNest,
  newPart,
  allStockTemplates
} from '../lib/store'
import { uid, parsePartText, money } from '../lib/format'
import type { PartParseResult, ParsedPartRow, PartParseIssue } from '../lib/format'
import { toast } from '../lib/ui'
import type { Board, EdgeSide, Part } from '../types'

const route = useRoute()
const router = useRouter()
const { state } = useStore()
const job = computed(() => getJob(route.params.id as string))

const importOpen = ref(false)
const importText = ref('')
const importReplace = ref(false)
const preview = ref<PartParseResult | null>(null)
const running = ref(false)

const grainLabel: Record<Part['grain'], string> = {
  length: '竖纹',
  width: '横纹',
  none: '无要求'
}
const edgeSideLabel: Record<EdgeSide, string> = {
  top: '上',
  bottom: '下',
  left: '左',
  right: '右'
}
const edgeDefs: { key: EdgeSide; label: string }[] = [
  { key: 'top', label: '上' },
  { key: 'bottom', label: '下' },
  { key: 'left', label: '左' },
  { key: 'right', label: '右' }
]

function edgesLabel(sides: EdgeSide[]): string {
  return sides.length ? sides.map((s) => edgeSideLabel[s]).join('') : '无'
}
function rowGrainLabel(r: ParsedPartRow): string {
  return grainLabel[r.grain]
}
function sourceText(r: ParsedPartRow): string {
  const lines = r.sourceLines
  if (lines.length <= 1) return `第 ${lines[0]} 行`
  return `第 ${lines.join('、')} 行（合并）`
}
const previewQty = computed(() => preview.value?.rows.reduce((a, r) => a + r.qty, 0) ?? 0)
const previewIssues = computed<PartParseIssue[]>(() => preview.value?.issues ?? [])

const totalPieces = computed(() => job.value?.parts.reduce((a, p) => a + (p.qty || 0), 0) ?? 0)
const totalArea = computed(
  () => (job.value?.parts.reduce((a, p) => a + p.lenMm * p.widMm * p.qty, 0) ?? 0) / 1e6
)

const availableOffcuts = computed(() => state.offcuts.filter((o) => o.available))

function save(): void {
  if (job.value) saveJob(job.value)
}

function addBoard(): void {
  if (!job.value) return
  const t = allStockTemplates()[3] // 2745×1220
  job.value.boards.push({ ...t, id: uid('b') } as Board)
  save()
}
function onPickTemplate(e: Event): void {
  const sel = e.target as HTMLSelectElement
  const i = Number(sel.value)
  sel.selectedIndex = 0
  if (i >= 0) addSpecificBoard(allStockTemplates()[i])
}
function addSpecificBoard(t: ReturnType<typeof allStockTemplates>[number]): void {
  if (!job.value) return
  if (job.value.boards.some((b) => b.name === t.name)) {
    toast('该板材已在库中', 'bad')
    return
  }
  job.value.boards.push({ ...t, id: uid('b') } as Board)
  save()
}
function removeBoard(id: string): void {
  if (!job.value) return
  if (job.value.boards.length <= 1) {
    toast('至少保留一种板材', 'bad')
    return
  }
  job.value.boards = job.value.boards.filter((b) => b.id !== id)
  for (const p of job.value.parts) if (p.boardId === id) p.boardId = ''
  save()
}
function toggleOffcut(id: string): void {
  if (!job.value) return
  const arr = job.value.useOffcutIds
  const i = arr.indexOf(id)
  if (i >= 0) arr.splice(i, 1)
  else arr.push(id)
  save()
}

function addPart(): void {
  job.value?.parts.push(
    newPart({
      code: `P${(job.value.parts.length + 1).toString().padStart(2, '0')}`,
      name: '新零件'
    })
  )
  save()
}
function removePart(id: string): void {
  if (!job.value) return
  job.value.parts = job.value.parts.filter((p) => p.id !== id)
  save()
}
function duplicatePart(p: Part): void {
  const idx = job.value!.parts.findIndex((x) => x.id === p.id)
  job.value!.parts.splice(idx + 1, 0, { ...p, id: uid('p') })
  save()
}
function toggleEdge(p: Part, e: EdgeSide): void {
  const i = p.edgeBands.indexOf(e)
  if (i >= 0) p.edgeBands.splice(i, 1)
  else p.edgeBands.push(e)
  save()
}

const warnings = computed<string[]>(() => {
  const out: string[] = []
  const j = job.value
  if (!j) return out
  const maxW = Math.max(...j.boards.map((b) => b.wMm - 2 * j.trimMm))
  const maxH = Math.max(...j.boards.map((b) => b.hMm - 2 * j.trimMm))
  for (const p of j.parts) {
    const long = Math.max(p.lenMm, p.widMm)
    const short = Math.min(p.lenMm, p.widMm)
    if (p.grain === 'length' && (p.lenMm > maxW || p.widMm > maxH))
      out.push(`「${p.code}」竖纹件 ${p.lenMm}×${p.widMm} 超过可用板幅 ${maxW}×${maxH}`)
    if (p.grain === 'width' && (p.widMm > maxW || p.lenMm > maxH))
      out.push(`「${p.code}」横纹件 ${p.lenMm}×${p.widMm} 超过可用板幅 ${maxW}×${maxH}`)
    if (p.grain === 'none' && long > maxW)
      out.push(`「${p.code}」长边 ${long} 超过板长 ${maxW}`)
    void short
  }
  if (j.trimMm < 5 || j.trimMm > 10) out.push('修边量通常取 5~10mm')
  return out
})

function runParse(): void {
  if (!importText.value.trim()) {
    toast('请先粘贴清单内容', 'bad')
    return
  }
  preview.value = parsePartText(importText.value)
  if (preview.value.rows.length === 0 && preview.value.issues.length === 0) {
    toast('没有可导入的行', 'bad')
  }
}

function backToEdit(): void {
  preview.value = null
}

/** 整批退回：丢弃本次解析与粘贴内容 */
function rejectImport(): void {
  preview.value = null
  importText.value = ''
  importOpen.value = false
}

function closeImport(): void {
  importOpen.value = false
  preview.value = null
}

function confirmImport(): void {
  if (!job.value || !preview.value) return
  if (preview.value.issues.length > 0) {
    toast('还有解析问题，请先退回修改', 'bad')
    return
  }
  const boardId = job.value.boards[0]?.id ?? ''
  const built = preview.value.rows.map((r) =>
    newPart({
      code: r.code || `P${Math.floor(Math.random() * 9000 + 1000)}`,
      name: r.name,
      lenMm: r.lenMm,
      widMm: r.widMm,
      qty: r.qty,
      grain: r.grain,
      edgeBands: r.edges,
      cabinet: r.cabinet,
      exposed: r.exposed,
      boardId
    })
  )
  if (importReplace.value) job.value.parts = built
  else job.value.parts.push(...built)
  save()
  const mergedQty = preview.value.mergedGroups.reduce(
    (a, g) => a + g.lines.length - 1,
    0
  )
  const mergeTxt = mergedQty > 0 ? `，合并重复件号 ${mergedQty} 行` : ''
  const skipTxt =
    preview.value.skippedBlankName.length > 0
      ? `，跳过空名称行 ${preview.value.skippedBlankName.length} 行`
      : ''
  toast(`已导入 ${built.length} 种 / ${previewQty.value} 件${mergeTxt}${skipTxt}`, 'good')
  rejectImport()
}

async function doNest(): Promise<void> {
  const j = job.value
  if (!j) return
  if (j.parts.length === 0) {
    toast('请先添加零件', 'bad')
    return
  }
  running.value = true
  try {
    const r = runNest(j)
    if (r.unplaced.length > 0) {
      toast(`${r.unplaced.length} 种零件未排下，请看排样页提示`, 'bad', 4200)
    } else {
      toast(`排样完成：${r.boardsUsed} 张板，${r.elapsedMs}ms`, 'good')
    }
    router.push(`/nest/${j.id}`)
  } finally {
    running.value = false
  }
}

const sampleTsv = `卧室衣柜开料清单
名称\t件号\t长度(cm)\t宽度(cm)\t数量\t纹理\t封边\t柜体\t见光
\t\t厘米\t厘米\t件\t\t\t\t
门板\tM01\t220\t45\t2\t竖纹\t上下左右\t衣柜\t是
侧板\tC02\t216\t58\t2\t顺纹\t上左下右\t衣柜\t否
侧板\tC02\t216\t58\t1\t顺纹\t134\t衣柜\t否
层板\tB03\t55\t56\t4\t无\t左右\t衣柜\t否`
</script>

<template>
  <div v-if="job">
    <div class="row wrap" style="margin-bottom: 14px">
      <input v-model="job.name" @change="save" style="width: 320px; font-weight: 650; font-size: 16px" />
      <span class="tag">创建于 {{ new Date(job.createdAt).toLocaleDateString('zh-CN') }}</span>
      <div class="spacer" />
      <button class="primary" :disabled="running" @click="doNest">
        {{ running ? '排样计算中…' : '开始排样 →' }}
      </button>
    </div>

    <!-- 参数与余料 -->
    <section class="panel" style="margin-bottom: 14px">
      <div class="row wrap" style="align-items: flex-end">
        <label class="field" style="width: 130px">
          <span>锯路 kerf (mm)</span>
          <input v-model.number="job.kerfMm" type="number" step="0.1" min="1" max="8" @change="save" />
        </label>
        <label class="field" style="width: 130px">
          <span>四周修边 (mm)</span>
          <input v-model.number="job.trimMm" type="number" step="1" min="0" max="20" @change="save" />
        </label>
        <label class="field row" style="margin-bottom: 10px">
          <input type="checkbox" v-model="job.batchByCabinet" @change="save" />
          <span style="margin: 0 0 0 6px">按柜体批次分组开料（同柜零件尽量连续排）</span>
        </label>
      </div>
      <div v-if="availableOffcuts.length > 0">
        <h4 style="margin: 8px 0 6px; font-size: 13px">余料优先：勾选已登记余料作为小板材参与本单排样</h4>
        <div class="row wrap">
          <label
            v-for="o in availableOffcuts"
            :key="o.id"
            class="offcut-chip"
            :class="{ on: job.useOffcutIds.includes(o.id) }"
          >
            <input type="checkbox" :checked="job.useOffcutIds.includes(o.id)" @change="toggleOffcut(o.id)" />
            {{ o.wMm }}×{{ o.hMm}}×{{ o.thicknessMm }} {{ o.material }}（{{ o.jobName }}）
          </label>
        </div>
      </div>
    </section>

    <!-- 板材库 -->
    <section class="panel" style="margin-bottom: 14px">
      <div class="row" style="margin-bottom: 8px">
        <h3 style="font-size: 14px">板材库</h3>
        <div class="spacer" />
        <select style="width: 260px" @change="onPickTemplate">
          <option value="-1">＋ 从常用规格添加…</option>
          <option v-for="(t, i) in allStockTemplates()" :key="i" :value="i">{{ t.name }} {{ money(t.priceCents) }}</option>
        </select>
        <button class="sm" @click="addBoard">添加自定义板</button>
      </div>
      <table class="grid board-table">
        <thead>
          <tr>
            <th>名称/材质</th><th>长(mm)</th><th>宽(mm)</th><th>厚(mm)</th>
            <th>单价</th><th>库存张数(0=不限)</th><th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="b in job.boards" :key="b.id">
            <td>
              <input v-model="b.name" @change="save" />
              <input v-model="b.material" @change="save" class="sub-input" placeholder="材质" />
            </td>
            <td style="width: 96px"><input v-model.number="b.wMm" type="number" @change="save" /></td>
            <td style="width: 96px"><input v-model.number="b.hMm" type="number" @change="save" /></td>
            <td style="width: 84px"><input v-model.number="b.thicknessMm" type="number" @change="save" /></td>
            <td style="width: 110px"><input v-model.number="b.priceCents" type="number" @change="save" /></td>
            <td style="width: 130px"><input v-model.number="b.quantity" type="number" min="0" @change="save" /></td>
            <td style="width: 46px"><button class="sm ghost-danger" @click="removeBoard(b.id)">删</button></td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 零件清单 -->
    <section class="panel">
      <div class="row" style="margin-bottom: 8px">
        <h3 style="font-size: 14px">零件清单</h3>
        <span class="tag">{{ job.parts.length }} 种 / {{ totalPieces }} 件 / {{ totalArea.toFixed(2) }}m²</span>
        <div class="spacer" />
        <button class="sm" @click="importOpen = !importOpen">批量粘贴导入</button>
        <button class="sm primary" @click="addPart">＋ 添加零件</button>
      </div>

      <div v-if="importOpen" class="import-box">
        <!-- 第一步：粘贴并解析 -->
        <template v-if="!preview">
          <p class="small muted">
            支持 Excel 直接粘贴（制表符分隔，逗号/分号也行）。开头的合并标题行、单位行会自动跳过；
            长宽按列单位（mm/厘米/cm/米）换算成毫米并按整数取整，单元格也可单独带单位；
            封边认「上左下右」、T/B/L/R、1-4 及「一二三四」；纹理认 顺纹/竖纹、横纹、无（无要求）；
            同一件号多行自动合并、数量相加；名称为空的行会跳过。解析后先出预览，确认无误才写入清单。
          </p>
          <textarea v-model="importText" rows="8" :placeholder="sampleTsv"></textarea>
          <div class="row" style="margin-top: 6px">
            <label class="row small"><input type="checkbox" v-model="importReplace" /> 替换当前清单（否则追加）</label>
            <div class="spacer" />
            <button class="sm" @click="closeImport">取消</button>
            <button class="sm primary" @click="runParse">解析生成预览</button>
          </div>
        </template>

        <!-- 第二步：预览确认 -->
        <template v-else>
          <div class="row wrap" style="gap: 8px; margin-bottom: 6px">
            <strong style="font-size: 13px">导入预览</strong>
            <span class="tag">{{ preview.rows.length }} 种 / {{ previewQty }} 件</span>
            <span class="tag">解析数据行 {{ preview.dataLineCount }} 行</span>
            <span v-if="preview.mergedGroups.length" class="tag">
              合并重复件号 {{ preview.mergedGroups.length }} 组
            </span>
            <span v-if="preview.skippedPreamble" class="tag">
              跳过开头标题/单位行 {{ preview.skippedPreamble }} 行
            </span>
            <span v-if="preview.skippedBlankName.length" class="tag" style="border-color: #d8a04c; color: #92600a">
              跳过名称为空的行 {{ preview.skippedBlankName.length }} 行（第
              {{ preview.skippedBlankName.map((s) => s.row).join('、') }} 行）
            </span>
            <div class="spacer" />
            <label class="row small"><input type="checkbox" v-model="importReplace" /> 替换当前清单（否则追加）</label>
          </div>

          <div v-if="preview.mergedGroups.length" class="small muted" style="margin-bottom: 4px">
            <template v-for="g in preview.mergedGroups" :key="g.code">
              件号「{{ g.code }}」合并第 {{ g.lines.join('、') }} 行，数量合计 {{ g.qty }}；
            </template>
          </div>

          <div v-if="previewIssues.length" class="import-issues">
            <div v-for="(e, i) in previewIssues" :key="i" class="issue-item">
              <div>
                <strong>第 {{ e.row }} 行<template v-if="e.column"> · {{ e.column }}列</template>：</strong>{{ e.message }}
              </div>
              <div class="issue-raw">原样：{{ e.raw || '（空行）' }}</div>
            </div>
          </div>
          <div v-else class="small" style="color: var(--c-good, #2a7d5f); margin-bottom: 4px">
            ✓ 校验通过，无解析问题
          </div>

          <div v-if="preview.rows.length" class="table-scroll" style="max-height: 260px; margin-bottom: 6px">
            <table class="grid parts-table">
              <thead>
                <tr>
                  <th>来源</th><th>件号</th><th>名称</th><th>长(mm)</th><th>宽(mm)</th>
                  <th>数量</th><th>纹理</th><th>封边</th><th>柜体</th><th>见光</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in preview.rows" :key="(r.code || 'x') + r.sourceLines[0]">
                  <td class="small muted">{{ sourceText(r) }}</td>
                  <td>{{ r.code || '—' }}</td>
                  <td>{{ r.name }}</td>
                  <td>{{ r.lenMm }}</td>
                  <td>{{ r.widMm }}</td>
                  <td>{{ r.qty }}</td>
                  <td>{{ rowGrainLabel(r) }}</td>
                  <td>{{ edgesLabel(r.edges) }}</td>
                  <td>{{ r.cabinet }}</td>
                  <td style="text-align: center">{{ r.exposed ? '是' : '否' }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="row" style="margin-top: 6px">
            <span class="small muted" v-if="previewIssues.length">
              存在 {{ previewIssues.length }} 个问题，无法写入；可退回修改粘贴内容后重新解析。
            </span>
            <div class="spacer" />
            <button class="sm" @click="backToEdit">← 退回修改</button>
            <button class="sm ghost-danger" @click="rejectImport">整批退回（清空）</button>
            <button class="sm primary" :disabled="previewIssues.length > 0 || preview.rows.length === 0" @click="confirmImport">
              确认写入清单
            </button>
          </div>
        </template>
      </div>

      <div v-if="warnings.length > 0" class="warn-box">
        <div v-for="(w, i) in warnings" :key="i">⚠️ {{ w }}</div>
      </div>

      <div class="table-scroll">
        <table class="grid parts-table">
          <thead>
            <tr>
              <th style="width: 80px">编号</th>
              <th style="width: 130px">名称</th>
              <th style="width: 80px">长(mm)</th>
              <th style="width: 80px">宽(mm)</th>
              <th style="width: 64px">数量</th>
              <th style="width: 92px">纹理</th>
              <th style="width: 132px">封边</th>
              <th style="width: 110px">柜体/房间</th>
              <th style="width: 70px">见光</th>
              <th style="width: 130px">指定板材</th>
              <th style="width: 78px"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in job.parts" :key="p.id">
              <td><input v-model="p.code" @change="save" /></td>
              <td><input v-model="p.name" @change="save" /></td>
              <td><input v-model.number="p.lenMm" type="number" min="1" @change="save" /></td>
              <td><input v-model.number="p.widMm" type="number" min="1" @change="save" /></td>
              <td><input v-model.number="p.qty" type="number" min="1" @change="save" /></td>
              <td>
                <select v-model="p.grain" @change="save">
                  <option v-for="(lab, g) in grainLabel" :key="g" :value="g">{{ lab }}</option>
                </select>
              </td>
              <td>
                <div class="edge-group">
                  <label v-for="ed in edgeDefs" :key="ed.key" class="edge-cb" :class="{ on: p.edgeBands.includes(ed.key) }">
                    <input type="checkbox" :checked="p.edgeBands.includes(ed.key)" @change="toggleEdge(p, ed.key)" />
                    {{ ed.label }}
                  </label>
                </div>
              </td>
              <td><input v-model="p.cabinet" @change="save" /></td>
              <td style="text-align: center"><input type="checkbox" v-model="p.exposed" @change="save" /></td>
              <td>
                <select v-model="p.boardId" @change="save">
                  <option value="">自动</option>
                  <option v-for="b in job.boards" :key="b.id" :value="b.id">{{ b.name }}</option>
                </select>
              </td>
              <td>
                <button class="sm" title="复制一行" @click="duplicatePart(p)">复</button>
                <button class="sm ghost-danger" title="删除" @click="removePart(p.id)">×</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <div class="sticky-bar no-print">
      <span>{{ job.parts.length }} 种 / {{ totalPieces }} 件 · 总面积 {{ totalArea.toFixed(2) }}m²</span>
      <div class="spacer" />
      <router-link :to="`/`">返回列表</router-link>
      <button class="primary" :disabled="running" @click="doNest">
        {{ running ? '排样计算中…' : '开始排样 →' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.offcut-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--c-line);
  border-radius: 999px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
  background: #fff;
}
.offcut-chip.on {
  border-color: var(--c-accent);
  background: #f0faf8;
  color: var(--c-accent);
  font-weight: 600;
}
.sub-input {
  margin-top: 3px;
  font-size: 11px;
  color: var(--c-ink-2);
}
.import-box {
  border: 1px dashed var(--c-line);
  border-radius: 6px;
  padding: 10px;
  margin-bottom: 10px;
  background: #fafcf9;
}
.import-issues {
  border: 1px solid #f3c9c9;
  background: var(--c-bad-bg);
  color: var(--c-bad);
  border-radius: 6px;
  padding: 6px 10px;
  margin-bottom: 8px;
  max-height: 220px;
  overflow-y: auto;
}
.issue-item {
  padding: 4px 0;
  border-bottom: 1px dashed #eac5c5;
  font-size: 12px;
}
.issue-item:last-child {
  border-bottom: none;
}
.issue-raw {
  color: var(--c-ink-2);
  margin-top: 2px;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  word-break: break-all;
}
.warn-box {
  border: 1px solid #f0d9b5;
  background: #fffbeb;
  color: #92600a;
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 12px;
  margin-bottom: 10px;
}
.table-scroll {
  overflow-x: auto;
}
.parts-table th,
.parts-table td {
  padding: 4px 6px;
}
.parts-table input,
.parts-table select {
  padding: 4px 6px;
  min-width: 0;
}
.edge-group {
  display: flex;
  gap: 2px;
}
.edge-cb {
  font-size: 11px;
  border: 1px solid var(--c-line);
  border-radius: 4px;
  padding: 2px 5px;
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  gap: 2px;
  white-space: nowrap;
}
.edge-cb.on {
  background: #1f2a26;
  color: #fff;
  border-color: #1f2a26;
}
.edge-cb input {
  display: none;
}
.sticky-bar {
  position: sticky;
  bottom: 12px;
  margin-top: 16px;
  background: #1f2a26;
  color: #eef2ee;
  border-radius: 10px;
  padding: 10px 16px;
  display: flex;
  gap: 14px;
  align-items: center;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.25);
}
.sticky-bar a {
  color: #9fb0a7;
}
</style>
