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
import type { ParseIssue, ParsedPartRow } from '../lib/format'
import { toast } from '../lib/ui'
import type { Board, EdgeSide, Part } from '../types'

const route = useRoute()
const router = useRouter()
const { state } = useStore()
const job = computed(() => getJob(route.params.id as string))

const importOpen = ref(false)
const importText = ref('')
const importReplace = ref(false)
const importPreview = ref<{
  rows: ParsedPartRow[]
  errors: ParseIssue[]
  notices: ParseIssue[]
} | null>(null)
const running = ref(false)

const grainLabel: Record<Part['grain'], string> = {
  length: '竖纹',
  width: '横纹',
  none: '无要求'
}
const edgeLabel: Record<EdgeSide, string> = {
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
  const r = parsePartText(importText.value)
  importPreview.value = { rows: r.rows, errors: r.errors, notices: r.notices }
}

function edgeText(sides: EdgeSide[]): string {
  return ['top', 'bottom', 'left', 'right']
    .filter((s) => sides.includes(s as EdgeSide))
    .map((s) => edgeLabel[s as EdgeSide])
    .join('') || '—'
}

const previewCount = computed(() => importPreview.value?.rows.length ?? 0)
const previewQty = computed(() =>
  (importPreview.value?.rows ?? []).reduce((a, r) => a + r.qty, 0)
)
const previewMerged = computed(
  () => (importPreview.value?.rows ?? []).filter((r) => r.mergedQty > 1).length
)

function backToEdit(): void {
  importPreview.value = null
}

/** 整批退回：放弃本次解析结果，回到空粘贴框重新来过。 */
function rejectImport(): void {
  importPreview.value = null
  importText.value = ''
  toast('已整批退回，未写入清单', 'info')
}

function closeImport(): void {
  importOpen.value = false
  importPreview.value = null
  importText.value = ''
}

function confirmImport(): void {
  if (!job.value || !importPreview.value) return
  const boardId = job.value.boards[0]?.id ?? ''
  // 件号为空的行自动编号，避开清单里已有的编号
  const used = new Set(job.value.parts.map((p) => p.code))
  let seq = job.value.parts.length + 1
  const nextCode = (): string => {
    let code = `P${seq.toString().padStart(2, '0')}`
    while (used.has(code)) {
      seq++
      code = `P${seq.toString().padStart(2, '0')}`
    }
    used.add(code)
    seq++
    return code
  }
  const built = importPreview.value.rows.map((r) =>
    newPart({
      code: r.code || nextCode(),
      name: r.name,
      lenMm: r.lenMm,
      widMm: r.widMm,
      qty: r.qty,
      grain: r.grain,
      edgeBands: [...r.edgeBands],
      cabinet: r.cabinet,
      exposed: r.exposed,
      boardId
    })
  )
  if (importReplace.value) job.value.parts = built
  else job.value.parts.push(...built)
  save()
  toast(
    `已导入 ${built.length} 条共 ${built.reduce((a, p) => a + p.qty, 0)} 件` +
      (previewMerged.value ? `（含 ${previewMerged.value} 条件号合并）` : ''),
    'good'
  )
  closeImport()
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

const sampleTsv = `万科3-1802 主卧衣柜 BOM（单位：毫米）
件号\t名称\t长\t宽\t数量\t纹理\t封边\t柜体\t见光
\t\tcm\tcm\t件\t\t\t\t
A01\t门板\t220\t45\t2\t顺纹\t上左下右\t衣柜\t是
A02\t层板\t55\t56\t4\t无\t1,3\t衣柜\t否
A03\t侧板\t2100mm\t580mm\t1\t竖纹\tTBL\t衣柜\t是
A03\t侧板\t2100mm\t580mm\t1\t顺纹\t一二三\t衣柜\t是
\t（此行无名称，应跳过）\t100\t100\t1\t无\t无\t衣柜\t否`
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
        <button class="sm" @click="importOpen = !importOpen; importPreview = null">
          {{ importOpen ? '收起导入' : '批量粘贴导入' }}
        </button>
        <button class="sm primary" @click="addPart">＋ 添加零件</button>
      </div>

      <div v-if="importOpen" class="import-box">
        <!-- 阶段一：粘贴并解析 -->
        <template v-if="!importPreview">
          <p class="small muted">
            支持 Excel/WPS 直接粘贴（制表符分隔）。自动跳过开头的合并标题行与单位行；
            长宽可按列或在单元格内写 <b>mm/毫米</b> 或 <b>cm/厘米/公分</b>（统一换算成毫米，四舍五入取整）；
            封边认 <b>上左下右 / TBLR / 1234（一二三四）</b>，0 或「无」为不封，四边/四周为全封；
            纹理认 <b>顺纹/竖纹/长向</b>、<b>横纹/宽向</b>、<b>无</b>；数量只认正整数（空=1）；
            同件号多行自动合并、数量相加；名称为空的行会跳过。
            无表头时按「名称,长,宽,数量,纹理,封边,柜体,见光」顺序解析。
          </p>
          <textarea v-model="importText" rows="7" :placeholder="sampleTsv"></textarea>
          <div class="row" style="margin-top: 6px">
            <label class="row small"><input type="checkbox" v-model="importReplace" /> 导入后替换当前清单（默认追加）</label>
            <div class="spacer" />
            <button class="sm" @click="closeImport">取消</button>
            <button class="sm primary" @click="runParse">解析并预览</button>
          </div>
        </template>

        <!-- 阶段二：预览确认 -->
        <template v-else>
          <div class="row wrap" style="margin-bottom: 6px">
            <strong>解析预览</strong>
            <span class="tag">{{ previewCount }} 种 / {{ previewQty }} 件</span>
            <span v-if="previewMerged" class="tag good">{{ previewMerged }} 条由同件号合并</span>
            <div class="spacer" />
            <button class="sm" @click="backToEdit">← 返回修改</button>
            <button class="sm ghost-danger" @click="rejectImport">整批退回</button>
            <button
              class="sm primary"
              :disabled="importPreview.errors.length > 0 || importPreview.rows.length === 0"
              @click="confirmImport"
            >
              确认写入清单（{{ importReplace ? '替换' : '追加' }}）
            </button>
          </div>

          <p
            v-if="importPreview.errors.length > 0"
            class="small"
            style="color: var(--c-bad); margin: 4px 0"
          >
            有 {{ importPreview.errors.length }} 处错误，确认前请「返回修改」改正：
          </p>
          <div
            v-for="(e, i) in importPreview.errors"
            :key="'e' + i"
            class="issue-line bad"
          >
            <div>✗ {{ e.message }}<span v-if="e.col">（第 {{ e.col }} 列）</span></div>
            <code v-if="e.raw" class="issue-raw">{{ e.raw }}</code>
          </div>

          <details v-if="importPreview.notices.length > 0" class="notice-list" open>
            <summary class="small muted">处理说明（{{ importPreview.notices.length }}）</summary>
            <div v-for="(n, i) in importPreview.notices" :key="'n' + i" class="issue-line">
              <div class="small">· {{ n.message }}</div>
              <code v-if="n.raw && n.line" class="issue-raw">{{ n.raw }}</code>
            </div>
          </details>

          <div v-if="importPreview.rows.length > 0" class="table-scroll" style="margin-top: 6px">
            <table class="grid preview-table">
              <thead>
                <tr>
                  <th>件号</th><th>名称</th><th>长(mm)</th><th>宽(mm)</th><th>数量</th>
                  <th>纹理</th><th>封边</th><th>柜体</th><th>见光</th><th>来源行</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(r, i) in importPreview.rows" :key="i" :class="{ merged: r.mergedQty > 1 }">
                  <td>{{ r.code || '（自动编号）' }}</td>
                  <td>{{ r.name }}</td>
                  <td>{{ r.lenMm }}</td>
                  <td>{{ r.widMm }}</td>
                  <td>{{ r.qty }}</td>
                  <td>{{ grainLabel[r.grain] }}</td>
                  <td>{{ edgeText(r.edgeBands) }}</td>
                  <td>{{ r.cabinet }}</td>
                  <td>{{ r.exposed ? '是' : '否' }}</td>
                  <td class="muted small">
                    {{ r.sourceLines.join('+') }}
                    <span v-if="r.mergedQty > 1" class="tag good">合{{ r.mergedQty }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="small" style="color: var(--c-bad)">没有可导入的行。</p>
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
.issue-line {
  border-left: 3px solid var(--c-line);
  padding: 2px 8px;
  margin: 3px 0;
  font-size: 12px;
}
.issue-line.bad {
  border-left-color: var(--c-bad);
  background: #fdf3f2;
}
.issue-raw {
  display: block;
  margin-top: 2px;
  padding: 2px 6px;
  background: #f1f1ee;
  border-radius: 3px;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--c-ink-2);
}
.notice-list summary {
  cursor: pointer;
  user-select: none;
}
.preview-table th,
.preview-table td {
  padding: 3px 8px;
  font-size: 12px;
}
.preview-table tr.merged td {
  background: #f0faf8;
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
