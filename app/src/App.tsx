import { useEffect, useMemo, useRef, useState, type ChangeEvent as ReactChangeEvent, type MouseEvent as ReactMouseEvent } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  CloudDownload,
  Database,
  Download,
  FileDown,
  FileCheck2,
  FileSpreadsheet,
  History,
  Layers,
  LayoutDashboard,
  Moon,
  PanelRightClose,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings,
  Tags,
  UserRound,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react'
import './App.css'
import {
  fetchA1ServerNotices,
  fetchA3Normalization,
  fetchA3Parser,
  fetchBidFiles,
  fetchHealth,
  fetchLocalServerNotices,
  fetchQualification,
  fetchServerColumnProfiles,
  fetchSettingsRows,
  fetchStandardColumnRules,
  runParsermanRuleTest,
  runParsermanTest,
  saveSettingsRows,
  saveStandardColumnRules,
} from './api'
import { preprocessRows, reprocessHumanRow, type PipelineStats, type PreprocessSettings } from './pipeline'
import type { NoticeRow, ParserNormalizationResult, ParserResult, ServerColumnProfile, StandardColumnRule } from './types'

type Stage = 'flow' | 'collect' | 'preprocess' | 'human' | 'output' | 'rules'

type PreprocessProgress = {
  running: boolean
  done: number
  total: number
  failed: number
  current: string
}

const settingsLoadKeys = [
  'workflowMap',
  'settingTabs',
  'apiConfig',
  'deleteKeywords',
  'biddingFormula',
  'bracketRules',
  'autoValidateRules',
  'matcherRules',
  'fieldRules',
  'keywordRules',
  'evaluationCriteria',
  'secondaryCriteria',
  'orgMap',
  'noticeTags',
  'specialRecords',
  'specialCommon',
  'jongmokMap',
  'jongmokBundleRules',
  'agencyCode',
  'regionDb',
  'wideRegion',
  'adjacencyRegion',
  'regionMine',
  'kepcoOffice',
  'transmissionOffice',
  'powerPlantRegion',
  'regionHint',
  'parserRules',
  'parserTypeGuide',
  'sectionRules',
  'bidMethodSkip',
  'reviewQueue',
  'profileInfo',
  'excludedItems',
  'changelog',
]

const stageItems: Array<{ id: Stage; label: string; icon: typeof Database }> = [
  { id: 'flow', label: '작업 흐름', icon: ClipboardCheck },
  { id: 'collect', label: '입찰공고 원본', icon: Database },
  { id: 'preprocess', label: '입찰공고 전처리', icon: Layers },
  { id: 'human', label: '공고관리', icon: UserRound },
  { id: 'output', label: '2차분류 완료', icon: FileSpreadsheet },
  { id: 'rules', label: '룰관리', icon: Settings },
]

const priorityColumns = [
  '검증상태',
  '검증메모',
  '공고번호',
  '공사명',
  '발주처',
  '입력일',
  '지역제한',
  '종목',
  '전문건설_주력분야',
  '단독평가종목',
  '종목세부JSON',
  '추정가격',
  '기초금액',
  '입찰방식',
  '공고확인',
  '특수실적',
  '특수실적_공통',
  '특수조건',
  '적격발주처',
  '원발주처',
  '적격평가기준_세부',
  '적격_1차상태',
  '적격_1차사유',
  '적격_2차상태',
  '적격_처치방법',
]

const hiddenMainColumns = new Set(['공고본문', '공고본문_HTML', '문서곡괭이근거'])
const conservativeKeepApiColumns = new Set(['공고번호', '공사명', '발주처', '입력일', '지역제한', '종목', '추정가격', '기초금액', '추정금액'])

const humanEditFields = [
  '공고확인',
  '특수조건',
  '특수실적',
  '특수실적_공통',
  '특수실적_내용',
  '지역제한',
  '공사현장',
  '종목',
  '전문건설_주력분야',
  '단독평가종목',
  '참가자격',
  '원발주처',
  '적격평가기준_세부',
]

function valueToText(value: unknown) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function joinMemo(existing: unknown, memo: string) {
  const current = valueToText(existing).trim()
  if (!current) return memo
  if (current.includes(memo)) return current
  return `${current} / ${memo}`
}

function mergeParserFields(row: NoticeRow, result: ParserResult, rules: StandardColumnRule[]) {
  const next: NoticeRow = { ...row }
  const filled: string[] = []
  const conflicts: string[] = []
  const evidenceRows: string[] = []

  for (const [field, value] of Object.entries(result.fields ?? {})) {
    const candidate = valueToText(value).trim()
    if (!candidate) continue

    const current = valueToText(next[field]).trim()
    const priority = rules.find((rule) => rule.항목 === field)?.우선순위 ?? ''
    const parserFirst = priority.includes('문서곡괭이') || priority.includes('파서')

    if (!current || current === '0' || (parserFirst && !conservativeKeepApiColumns.has(field))) {
      next[field] = candidate
      filled.push(field)
    } else if (normalizeCompare(current) !== normalizeCompare(candidate)) {
      conflicts.push(field)
    }

    const evidence = result.evidence?.[field]
    if (evidence) evidenceRows.push(`${field}: ${evidence}`)
  }

  if (result.textPreview && !valueToText(next['공고본문'])) {
    next['공고본문'] = result.textPreview
  }
  if (result.html && !valueToText(next['공고본문_HTML'])) {
    next['공고본문_HTML'] = result.html
  }
  if (evidenceRows.length) {
    next['문서곡괭이근거'] = evidenceRows.join('\n\n')
  }
  if (filled.length) {
    next['문서곡괭이컬럼'] = filled.join(',')
  }
  if (conflicts.length) {
    next['검증메모'] = joinMemo(next['검증메모'], `API/문서곡괭이 값 충돌: ${conflicts.join(',')}`)
  }

  return { row: next, filled, conflicts }
}

function normalizeCompare(value: string) {
  return value.replace(/[\s,]/g, '').toLowerCase()
}

function getColumns(rows: NoticeRow[], profiles: ServerColumnProfile[]) {
  const profileColumns = profiles.map((row) => row.항목).filter(Boolean)
  const rowColumns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))))
    .filter((col) => !col.startsWith('_') && !hiddenMainColumns.has(col))
  const known = Array.from(new Set([...profileColumns, ...rowColumns]))
  const rest = known.filter((col) => !priorityColumns.includes(col))
  const front = priorityColumns.filter((col) => known.includes(col))
  return [...front, ...rest]
}

function escapeHtml(value: unknown) {
  return valueToText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function exportWorkbook(rows: NoticeRow[], columns: string[], suffix: string) {
  const header = columns.map((col) => `<th>${escapeHtml(col)}</th>`).join('')
  const body = rows
    .map((row) => {
      const cells = columns
        .map((col) => `<td style="mso-number-format:'\\@';">${escapeHtml(row[col] ?? '')}</td>`)
        .join('')
      return `<tr>${cells}</tr>`
    })
    .join('')
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></body></html>`
  const blob = new Blob(['\ufeff', html], { type: 'application/vnd.ms-excel;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  const today = new Date().toISOString().slice(0, 10)
  anchor.href = url
  anchor.download = `${today}_입찰공고_${suffix}.xls`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

function exportCsv(rows: NoticeRow[], columns: string[], filename: string) {
  const header = columns.map(escapeCsvCell).join(',')
  const body = rows
    .map((row) => columns.map((col) => escapeCsvCell(row[col] ?? '')).join(','))
    .join('\r\n')
  const csv = [header, body].filter(Boolean).join('\r\n')
  const blob = new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename.endsWith('.csv') ? filename : `${filename}.csv`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

function escapeCsvCell(value: unknown) {
  const text = valueToText(value)
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

function parseCsvUpload(text: string) {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  const normalized = text.replace(/^\uFEFF/, '')

  const pushCell = () => {
    row.push(cell)
    cell = ''
  }
  const pushRow = () => {
    pushCell()
    rows.push(row)
    row = []
  }

  for (let index = 0; index < normalized.length; index += 1) {
    const ch = normalized[index]
    const next = normalized[index + 1]
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"'
        index += 1
      } else if (ch === '"') {
        inQuotes = false
      } else {
        cell += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      pushCell()
    } else if (ch === '\n') {
      pushRow()
    } else if (ch === '\r') {
      if (next === '\n') continue
      pushRow()
    } else {
      cell += ch
    }
  }
  if (cell || row.length) pushRow()

  const [header = [], ...body] = rows
  const columns = header.map((col) => col.trim())
  if (!columns.length || columns.every((col) => !col)) return []
  return body
    .filter((cells) => cells.some((value) => value !== ''))
    .map((cells) => {
      const item: NoticeRow = {}
      columns.forEach((col, index) => {
        if (!col) return
        item[col] = cells[index] ?? ''
      })
      return item
    })
}

function safeFileName(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_')
}

function App() {
  const [stage, setStage] = useState<Stage>('collect')
  const [rawRows, setRawRows] = useState<NoticeRow[]>([])
  const [preRows, setPreRows] = useState<NoticeRow[]>([])
  const [humanRows, setHumanRows] = useState<NoticeRow[]>([])
  const [finalRows, setFinalRows] = useState<NoticeRow[]>([])
  const [source, setSource] = useState('미수집')
  const [profiles, setProfiles] = useState<ServerColumnProfile[]>([])
  const [rules, setRules] = useState<StandardColumnRule[]>([])
  const [query] = useState('isDefault=Y&containCancel=N&onlyGong=Y')
  const [search, setSearch] = useState('')
  const [dateFilter, setDateFilter] = useState('')
  const [jongmokFilter, setJongmokFilter] = useState('')
  const [rowLimit, setRowLimit] = useState(200)
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('앱 준비 중')
  const [hasModuleKey, setHasModuleKey] = useState<boolean | null>(null)
  const [preStats, setPreStats] = useState<PipelineStats | null>(null)
  const [selectedGongo, setSelectedGongo] = useState('')
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [parserNote, setParserNote] = useState('')
  const [selectedRuleItem, setSelectedRuleItem] = useState('')
  const [ruleDraft, setRuleDraft] = useState<Record<string, string>>({})
  const [logs, setLogs] = useState<string[]>(['대기: API 호출 또는 샘플 로드를 실행하세요.'])
  const [detailRow, setDetailRow] = useState<NoticeRow | null>(null)
  const [parserCache, setParserCache] = useState<Record<string, ParserResult>>({})
  const [preprocessSettings, setPreprocessSettings] = useState<PreprocessSettings>({})
  const [settingRows, setSettingRows] = useState<Record<string, NoticeRow[]>>({})
  const [preprocessProgress, setPreprocessProgress] = useState<PreprocessProgress>({
    running: false,
    done: 0,
    total: 0,
    failed: 0,
    current: '',
  })
  const stopPreprocessRef = useRef(false)

  useEffect(() => {
    async function boot() {
      try {
        const [health, serverProfiles, standardRules, ...settingsResults] = await Promise.all([
          fetchHealth(),
          fetchServerColumnProfiles(),
          fetchStandardColumnRules(),
          ...settingsLoadKeys.map((key) => fetchSettingsRows(key)),
        ])
        const settingsByKey = settingsLoadKeys.reduce<Record<string, NoticeRow[]>>((acc, key, index) => {
          acc[key] = settingsResults[index] ?? []
          return acc
        }, {})
        const evaluationCriteria = settingsByKey.evaluationCriteria ?? []
        const secondaryCriteria = settingsByKey.secondaryCriteria ?? []
        const orgMap = settingsByKey.orgMap ?? []
        const regionDb = settingsByKey.regionDb ?? []
        const jongmokMap = settingsByKey.jongmokMap ?? []
        const noticeTags = settingsByKey.noticeTags ?? []
        const specialRecords = settingsByKey.specialRecords ?? []
        const specialCommon = settingsByKey.specialCommon ?? []
        const bidMethodSkip = settingsByKey.bidMethodSkip ?? []
        const deleteKeywords = settingsByKey.deleteKeywords ?? []
        const bracketRules = settingsByKey.bracketRules ?? []
        setHasModuleKey(health.hasModuleKey)
        setProfiles(serverProfiles)
        setRules(standardRules)
        setSettingRows(settingsByKey)
        setPreprocessSettings({ evaluationCriteria, secondaryCriteria, orgMap, regionDb, jongmokMap, noticeTags, specialRecords, specialCommon, bidMethodSkip, deleteKeywords, bracketRules })
        setStatus(
          `표준 컬럼 ${standardRules.length}개, 서버 컬럼 ${serverProfiles.length}개, 적격기준 ${evaluationCriteria.length}개 확인`,
        )
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error))
      }
    }
    boot()
  }, [])

  useEffect(() => {
    const selected = rules.find((rule) => rule.항목 === selectedRuleItem) ?? rules[0]
    if (!selected) {
      setRuleDraft({})
      return
    }
    if (selected.항목 !== selectedRuleItem) setSelectedRuleItem(selected.항목)
    setRuleDraft({ ...selected })
  }, [rules, selectedRuleItem])

  const stageRows = useMemo(() => {
    if (stage === 'flow') return rawRows
    if (stage === 'preprocess') return preRows
    if (stage === 'human') return humanRows
    if (stage === 'output') return finalRows.length ? finalRows : humanRows
    return rawRows
  }, [finalRows, humanRows, preRows, rawRows, stage])

  const columns = useMemo(() => getColumns(stageRows, profiles), [stageRows, profiles])
  const jongmokOptions = useMemo(() => {
    const values = (settingRows.jongmokMap ?? [])
      .map((row) => valueToText(row['업종']).trim())
      .filter(Boolean)
    return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b, 'ko'))
  }, [settingRows.jongmokMap])

  const filteredRows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const dateNeedle = dateFilter.trim()
    const jongmokNeedle = jongmokFilter.trim()
    return stageRows.filter((row) =>
      (!needle || columns.some((col) => valueToText(row[col]).toLowerCase().includes(needle))) &&
      (!dateNeedle || valueToText(row['입력일']).slice(0, 10) === dateNeedle) &&
      (!jongmokNeedle || valueToText(row['종목']).includes(jongmokNeedle)),
    )
  }, [columns, dateFilter, jongmokFilter, search, stageRows])

  const visibleRows = filteredRows.slice(0, rowLimit)
  const emptyCells = useMemo(() => {
    if (!stageRows.length || !columns.length) return 0
    let count = 0
    for (const row of stageRows) {
      for (const col of columns) {
        if (valueToText(row[col]).trim() === '') count += 1
      }
    }
    return count
  }, [columns, stageRows])

  const selectedRow = useMemo(
    () => humanRows.find((row) => valueToText(row['공고번호']) === selectedGongo) ?? humanRows[0],
    [humanRows, selectedGongo],
  )

  useEffect(() => {
    if (!selectedRow) {
      setDraft({})
      return
    }
    if (valueToText(selectedRow['공고번호']) !== selectedGongo) {
      setSelectedGongo(valueToText(selectedRow['공고번호']))
    }
    setDraft(
      humanEditFields.reduce<Record<string, string>>((acc, field) => {
        acc[field] = valueToText(selectedRow[field])
        return acc
      }, {}),
    )
  }, [selectedRow, selectedGongo])

  useEffect(() => {
    if (!detailRow) return
    function handleKeydown(event: KeyboardEvent) {
      if (event.key === 'Escape') setDetailRow(null)
    }
    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  }, [detailRow])

  async function loadLocalSample() {
    setLoading(true)
    setStatus('로컬 샘플 불러오는 중')
    try {
      const data = await fetchLocalServerNotices(500)
      setRawRows(data.rows)
      setPreRows([])
      setHumanRows([])
      setFinalRows([])
      setPreStats(null)
      setSource(data.source)
      setStage('collect')
      setStatus(`로컬 샘플 ${data.rows.length}건 로드`)
      addLog(`샘플 ${data.rows.length}건 로드`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  async function loadA1() {
    setLoading(true)
    setStatus('A1 서버공고 호출 중')
    try {
      const data = await fetchA1ServerNotices(query)
      setRawRows(data.rows)
      setPreRows([])
      setHumanRows([])
      setFinalRows([])
      setPreStats(null)
      setSource(data.source)
      setStage('collect')
      setStatus(`A1 서버공고 ${data.rows.length}건 로드`)
      addLog(`A1 서버공고 ${data.rows.length}건 로드`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  async function runPreprocess() {
    if (!rawRows.length) {
      setStatus('수집 row가 없습니다. 샘플 또는 A1을 먼저 불러오세요.')
      return
    }

    const targetRows = stage === 'collect' ? filteredRows : rawRows
    if (!targetRows.length) {
      setStatus('현재 필터에 해당하는 전처리 대상이 없습니다.')
      return
    }

    stopPreprocessRef.current = false
    setLoading(true)
    setPreprocessProgress({ running: true, done: 0, total: targetRows.length, failed: 0, current: '' })
    setStage('preprocess')
    addLog(`곡괭이질 시작 — ${targetRows.length}건`)

    const nextParserCache = { ...parserCache }
    const mergedRows: NoticeRow[] = []
    let failed = 0

    for (let index = 0; index < targetRows.length; index += 1) {
      if (stopPreprocessRef.current) {
        addLog(`사용자 중단 — ${index}/${targetRows.length}건 처리`)
        break
      }

      const rawRow = targetRows[index]
      const gongo = valueToText(rawRow['공고번호'])
      setPreprocessProgress({
        running: true,
        done: index,
        total: targetRows.length,
        failed,
        current: gongo || `row-${index + 1}`,
      })

      let merged = { ...rawRow }
      if (gongo) {
        try {
          const parserResult = nextParserCache[gongo] ?? (await fetchA3Parser(gongo))
          nextParserCache[gongo] = parserResult
          const parserMerge = mergeParserFields(merged, parserResult, rules)
          merged = parserMerge.row
          addLog(
            `[${index + 1}/${targetRows.length}] ${gongo} A3 ${parserMerge.filled.length}개 채움${
              parserMerge.conflicts.length ? ` / 충돌 ${parserMerge.conflicts.length}` : ''
            }`,
          )
        } catch (error) {
          failed += 1
          merged['검증상태'] = '오류'
          merged['검증메모'] = joinMemo(merged['검증메모'], `A3 문서곡괭이 실패: ${error instanceof Error ? error.message : String(error)}`)
          addLog(`[${index + 1}/${targetRows.length}] ${gongo} A3 실패`)
        }
      } else {
        failed += 1
        merged['검증상태'] = '오류'
        merged['검증메모'] = joinMemo(merged['검증메모'], '공고번호 없음')
      }
      mergedRows.push(merged)

      setPreprocessProgress({
        running: true,
        done: index + 1,
        total: targetRows.length,
        failed,
        current: gongo || `row-${index + 1}`,
      })
    }

    setParserCache(nextParserCache)
    const result = preprocessRows(mergedRows, rules, preprocessSettings)
    setPreRows(result.rows)
    setHumanRows(result.rows)
    setFinalRows(result.rows)
    setPreStats(result.stats)
    setStage('preprocess')
    setStatus(`전처리 완료: ${result.stats.total}건, 확인 ${result.stats.review}건, 오류 ${result.stats.errors}건, A3 실패 ${failed}건`)
    setPreprocessProgress({ running: false, done: result.stats.total, total: targetRows.length, failed, current: '' })
    setLoading(false)
    addLog(`전처리 완료: 전체 ${result.stats.total}, 확인 ${result.stats.review}, 오류 ${result.stats.errors}, A3 실패 ${failed}`)
  }

  function stopPreprocess() {
    stopPreprocessRef.current = true
    setStatus('곡괭이질 중단 요청됨. 현재 공고 처리 후 멈춥니다.')
  }

  function saveHumanEdit() {
    if (!selectedRow) return
    const gongo = valueToText(selectedRow['공고번호'])
    const updated = humanRows.map((row) => {
      if (valueToText(row['공고번호']) !== gongo) return row
      return reprocessHumanRow({ ...row, ...draft }, rules, preprocessSettings)
    })
    setHumanRows(updated)
    setFinalRows(updated)
    setStatus(`사람입력 저장 및 필요한 컬럼 재전처리: ${gongo}`)
    addLog(`사람입력 저장/재전처리: ${gongo}`)
  }

  async function runA3ParserForSelected() {
    if (!selectedRow) return
    const gongo = valueToText(selectedRow['공고번호'])
    if (!gongo) {
      setStatus('A3 문서곡괭이: 공고번호가 없습니다.')
      return
    }
    setLoading(true)
    setStatus(`A3 문서곡괭이 실행 중: ${gongo}`)
    try {
      const result = await fetchA3Parser(gongo)
      setParserCache((prev) => ({ ...prev, [gongo]: result }))
      setDraft({ ...draft, ...result.fields })
      setParserNote(
        Object.entries(result.evidence)
          .map(([key, value]) => `${key}: ${value}`)
          .join('\n\n'),
      )
      setStatus(`A3 문서곡괭이 후보 ${Object.keys(result.fields).length}개 추출`)
      addLog(`A3 문서곡괭이 후보 ${Object.keys(result.fields).length}개: ${gongo}`)
    } catch (error) {
      setParserNote(error instanceof Error ? error.message : String(error))
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  function finalizeRows() {
    const base = humanRows.length ? humanRows : preRows
    const result = preprocessRows(base, rules, preprocessSettings)
    setFinalRows(result.rows)
    setStage('output')
    setStatus(`최종출력 준비: ${result.rows.length}건`)
    addLog(`최종출력 준비: ${result.rows.length}건`)
  }

  function clearAllRows() {
    setRawRows([])
    setPreRows([])
    setHumanRows([])
    setFinalRows([])
    setPreStats(null)
    setSource('미수집')
    setSearch('')
    setDateFilter('')
    setJongmokFilter('')
    setDetailRow(null)
    setStage('collect')
    setStatus('수집 데이터를 모두 삭제했습니다.')
    addLog('수집/전처리/최종 row 모두 삭제')
  }

  async function saveRuleDraft() {
    const key = ruleDraft.항목?.trim()
    if (!key) {
      setStatus('룰 저장 실패: 항목명이 필요합니다.')
      return
    }
    const exists = rules.some((rule) => rule.항목 === selectedRuleItem)
    const next = exists
      ? rules.map((rule) => (rule.항목 === selectedRuleItem ? ({ ...rule, ...ruleDraft } as StandardColumnRule) : rule))
      : [...rules, { ...(ruleDraft as StandardColumnRule), id: ruleDraft.id || String(rules.length + 1) }]
    try {
      const saved = await saveStandardColumnRules(next)
      setRules(saved)
      setSelectedRuleItem(key)
      setStatus(`표준 컬럼 룰 저장: ${key}`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  async function addRuleDraft() {
    const newId = String(Math.max(0, ...rules.map((rule) => Number(rule.id) || 0)) + 1)
    const item = `새컬럼_${newId}`
    const newRule = {
      id: newId,
      항목: item,
      표시형식: '',
      처리방법: '',
      우선순위: '',
      참조방법: '',
      참조메모: '',
      선택목록: '',
      '공고관리 표시': 'true',
      상세정보입력: 'true',
      서버공고일치: 'N',
      확정메모: '',
    } as StandardColumnRule
    const saved = await saveStandardColumnRules([...rules, newRule])
    setRules(saved)
    setSelectedRuleItem(item)
    setStatus(`표준 컬럼 룰 추가: ${item}`)
  }

  async function deleteRuleDraft() {
    if (!selectedRuleItem) return
    const saved = await saveStandardColumnRules(rules.filter((rule) => rule.항목 !== selectedRuleItem))
    setRules(saved)
    setSelectedRuleItem(saved[0]?.항목 ?? '')
    setStatus(`표준 컬럼 룰 삭제: ${selectedRuleItem}`)
  }

  async function saveSettingDataset(key: string, rows: NoticeRow[]) {
    try {
      const saved = await saveSettingsRows(key, rows)
      setSettingRows((prev) => ({ ...prev, [key]: saved }))
      setPreprocessSettings((prev) => ({ ...prev, [key]: saved }))
      if (key !== 'changelog') {
        const logRows = createChangelogRows(settingRows.changelog ?? [], settingRows.settingTabs ?? [], settingRows.profileInfo ?? [], key, saved.length)
        const savedLogs = await saveSettingsRows('changelog', logRows)
        setSettingRows((prev) => ({ ...prev, changelog: savedLogs }))
      }
      setStatus(`설정 저장: ${key} ${saved.length.toLocaleString()}행`)
      addLog(`설정 저장: ${key} ${saved.length}행`)
      return saved
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  async function saveStandardRulesTable(rows: NoticeRow[]) {
    const saved = await saveStandardColumnRules(rows as unknown as StandardColumnRule[])
    setRules(saved)
    const logRows = createChangelogRows(settingRows.changelog ?? [], settingRows.settingTabs ?? [], settingRows.profileInfo ?? [], 'standardColumns', saved.length)
    const savedLogs = await saveSettingsRows('changelog', logRows)
    setSettingRows((prev) => ({ ...prev, changelog: savedLogs }))
    setStatus(`표준 컬럼 룰 저장: ${saved.length.toLocaleString()}행`)
    addLog(`표준 컬럼 룰 저장: ${saved.length}행`)
    return saved as unknown as NoticeRow[]
  }

  function exportCurrent() {
    const suffix = stage === 'output' ? '최종분류' : stage === 'preprocess' ? '전처리' : '수집'
    exportWorkbook(filteredRows, columns, suffix)
    addLog(`엑셀 출력: ${filteredRows.length}건`)
  }

  function addLog(message: string) {
    const now = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    setLogs((prev) => [`${now} ${message}`, ...prev].slice(0, 80))
  }

  function renderMain() {
    if (stage === 'flow') {
      return (
        <FlowOverviewView
          rows={settingRows.workflowMap ?? []}
          settings={settingRows}
          rowCounts={{
            raw: rawRows.length,
            pre: preRows.length,
            human: humanRows.length,
            final: finalRows.length,
          }}
          stats={preStats}
          progress={preprocessProgress}
          status={status}
          onGoStage={setStage}
        />
      )
    }
    if (stage === 'rules') {
      return (
        <RulesView
          profiles={profiles}
          rules={rules}
          selectedRuleItem={selectedRuleItem}
          setSelectedRuleItem={setSelectedRuleItem}
          ruleDraft={ruleDraft}
          setRuleDraft={setRuleDraft}
          onSave={saveRuleDraft}
          onAdd={addRuleDraft}
          onDelete={deleteRuleDraft}
        />
      )
    }
    if (stage === 'output') {
      return (
        <OutputView
          columns={columns}
          rows={finalRows}
          filteredCount={filteredRows.length}
          onExport={exportCurrent}
          onFinalize={finalizeRows}
          onRowOpen={setDetailRow}
        />
      )
    }
    if (stage === 'preprocess') {
      return (
        <PreprocessView
          columns={columns}
          rows={visibleRows}
          stats={preStats}
          onRun={runPreprocess}
          totalRows={stageRows.length}
          filteredRows={filteredRows.length}
          onRowOpen={setDetailRow}
        />
      )
    }
    if (stage === 'human') {
      return (
        <HumanView
          columns={columns}
          rows={visibleRows}
          allRows={humanRows}
          selectedGongo={selectedGongo}
          setSelectedGongo={setSelectedGongo}
          draft={draft}
          setDraft={setDraft}
          onSave={saveHumanEdit}
          onFinalize={finalizeRows}
          onA3Parse={runA3ParserForSelected}
          parserNote={parserNote}
          loading={loading}
          onRowOpen={setDetailRow}
        />
      )
    }
    return (
      <CollectionView
        columns={columns}
        rows={visibleRows}
        totalRows={stageRows.length}
        filteredRows={filteredRows.length}
        rowLimit={rowLimit}
        setRowLimit={setRowLimit}
        onRowOpen={setDetailRow}
      />
    )
  }

  if (stage === 'rules') {
    return (
      <SettingsShell
        profiles={profiles}
        rules={rules}
        settings={settingRows}
        rowCounts={{
          raw: rawRows.length,
          pre: preRows.length,
          human: humanRows.length,
          final: finalRows.length,
        }}
        selectedRuleItem={selectedRuleItem}
        setSelectedRuleItem={setSelectedRuleItem}
        ruleDraft={ruleDraft}
        setRuleDraft={setRuleDraft}
        onSave={saveRuleDraft}
        onAdd={addRuleDraft}
        onDelete={deleteRuleDraft}
        onSaveSetting={saveSettingDataset}
        onSaveStandardRules={saveStandardRulesTable}
        onClose={() => setStage('human')}
      />
    )
  }

  return (
    <div className="main-shell">
      <header className="main-tabs" aria-label="작업 단계">
        {stageItems
          .filter((item) => item.id !== 'rules')
          .map((item) => (
            <button
              key={item.id}
              className={stage === item.id ? 'active' : ''}
              type="button"
              onClick={() => setStage(item.id)}
            >
              {item.label}
              <span>{countForStage(item.id)}</span>
            </button>
          ))}
        <button className="settings-tab" type="button" onClick={() => setStage('rules')} title="설정">
          <Settings size={16} />
        </button>
      </header>

      <section className="work-grid">
        <main className="main-workspace">
          <section className="command-row">
            <div className="total-chip">총 {stageRows.length.toLocaleString()}건</div>
            <button type="button" onClick={loadA1} disabled={loading || preprocessProgress.running}>
              <Database size={15} />
              API 호출
            </button>
            <button className="primary" type="button" onClick={runPreprocess} disabled={!rawRows.length || preprocessProgress.running}>
              <Play size={15} />
              곡괭이질 시작
            </button>
            {preprocessProgress.running ? (
              <button className="danger" type="button" onClick={stopPreprocess}>
                <PanelRightClose size={15} />
                중단
              </button>
            ) : null}
            <button type="button" onClick={exportCurrent} disabled={!filteredRows.length}>
              <FileDown size={15} />
              엑셀 다운로드
            </button>
            <button type="button" onClick={loadLocalSample} disabled={loading}>
              <RefreshCw size={15} />
              샘플
            </button>
            <button className="danger" type="button" onClick={clearAllRows}>
              <AlertTriangle size={15} />
              모두 삭제
            </button>
            <div className="toolbar-spacer" />
            <label className="toolbar-field narrow">
              <span>입력일</span>
              <input
                type="date"
                value={dateFilter}
                onChange={(event) => setDateFilter(event.target.value)}
                onInput={(event) => setDateFilter(event.currentTarget.value)}
              />
            </label>
            <label className="toolbar-field">
              <span>종목</span>
              <select
                value={jongmokFilter}
                onChange={(event) => setJongmokFilter(event.target.value)}
                onInput={(event) => setJongmokFilter(event.currentTarget.value)}
              >
                <option value="">종목 선택</option>
                {jongmokOptions.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <div className="tb-search">
              <Search size={16} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="공사명·발주처·공고번호·종목 검색..."
              />
            </div>
          </section>

          <section className="compact-status">
            <span className={hasModuleKey ? 'ok' : 'warn'}>
              {hasModuleKey ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
              {hasModuleKey ? 'moduleKey 연결됨' : 'moduleKey 없음'}
            </span>
            <span>{source}</span>
            <span>{status}</span>
            <span>필터 {filteredRows.length.toLocaleString()}건</span>
            <span>컬럼 {columns.length.toLocaleString()}</span>
            <span>빈칸 {emptyCells.toLocaleString()}</span>
          </section>

          {preprocessProgress.running || preprocessProgress.total ? (
            <ProgressBar progress={preprocessProgress} />
          ) : null}

          {renderMain()}
        </main>

        <aside className="ai-log-panel">
          <div className="log-rail-label">AI 로그</div>
          <div className="log-head">
            <strong>처리 로그</strong>
            <button type="button" onClick={() => setLogs([])}>
              비우기
            </button>
          </div>
          <div className="log-list">
            {logs.map((log, index) => (
              <div key={`${log}-${index}`} className="log-row">
                {log}
              </div>
            ))}
          </div>
        </aside>
      </section>
      {detailRow ? <NoticeDetailModal row={detailRow} columns={columns} onClose={() => setDetailRow(null)} /> : null}
    </div>
  )

  function countForStage(target: Stage) {
    if (target === 'flow') return (settingRows.workflowMap ?? []).length
    if (target === 'collect') return rawRows.length
    if (target === 'preprocess') return preRows.length
    if (target === 'human') return humanRows.length
    if (target === 'output') return finalRows.length
    return 0
  }
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function ProgressBar({ progress }: { progress: PreprocessProgress }) {
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0
  return (
    <section className="progress-panel">
      <div className="progress-head">
        <strong>{progress.running ? '곡괭이질 진행 중' : '마지막 곡괭이질 결과'}</strong>
        <span>
          {progress.done.toLocaleString()} / {progress.total.toLocaleString()}건
          {progress.failed ? ` · 실패 ${progress.failed.toLocaleString()}건` : ''}
          {progress.current ? ` · 현재 ${progress.current}` : ''}
        </span>
      </div>
      <div className="progress-track">
        <div style={{ width: `${pct}%` }} />
      </div>
    </section>
  )
}

function FlowOverviewView({
  rows,
  settings,
  rowCounts,
  stats,
  progress,
  status,
  onGoStage,
}: {
  rows: NoticeRow[]
  settings: Record<string, NoticeRow[]>
  rowCounts: { raw: number; pre: number; human: number; final: number }
  stats: PipelineStats | null
  progress: PreprocessProgress
  status: string
  onGoStage: (stage: Stage) => void
}) {
  const orderedRows = [...rows].sort((a, b) => (Number(a['순서']) || 0) - (Number(b['순서']) || 0))
  const grouped = ['수집', '전처리', '사람입력', '최종출력', '룰관리']
    .map((stageName) => ({
      stageName,
      rows: orderedRows.filter((row) => valueToText(row['단계']) === stageName),
    }))
    .filter((group) => group.rows.length)
  const settingTotal = Object.values(settings).reduce((sum, value) => sum + value.length, 0)
  const reviewCount = stats?.review ?? rowCounts.human
  const errorCount = stats?.errors ?? 0

  return (
    <div className="flow-overview">
      <section className="flow-hero">
        <div>
          <p>전체 흐름</p>
          <h2>수집 → 전처리 → 사람입력 → 최종출력</h2>
          <span>룰관리는 중간 단계가 아니라 모든 단계가 참조하는 기준표입니다.</span>
        </div>
        <div className="flow-state-grid">
          <Metric label="수집 row" value={rowCounts.raw.toLocaleString()} />
          <Metric label="전처리 row" value={rowCounts.pre.toLocaleString()} />
          <Metric label="사람입력 row" value={rowCounts.human.toLocaleString()} />
          <Metric label="최종 row" value={rowCounts.final.toLocaleString()} />
          <Metric label="설정 row" value={settingTotal.toLocaleString()} />
        </div>
      </section>

      <section className="flow-lane" aria-label="작업 흐름도">
        {['수집', '전처리', '사람입력', '최종출력'].map((name, index, list) => (
          <div key={name} className="flow-lane-item">
            <strong>{name}</strong>
            <span>{flowStageSummary(name, rowCounts, reviewCount, errorCount)}</span>
            {index < list.length - 1 ? <b>→</b> : null}
          </div>
        ))}
        <div className="flow-rule-anchor">
          <strong>룰관리</strong>
          <span>{settingTotal.toLocaleString()} row 기준표</span>
        </div>
      </section>

      <section className="flow-runtime">
        <div>
          <strong>현재 상태</strong>
          <span>{status}</span>
        </div>
        <div>
          <strong>마지막 곡괭이질</strong>
          <span>
            {progress.total
              ? `${progress.done.toLocaleString()} / ${progress.total.toLocaleString()}건, 실패 ${progress.failed.toLocaleString()}건`
              : '아직 실행 전'}
          </span>
        </div>
        <div>
          <strong>검증</strong>
          <span>확인필요 {reviewCount.toLocaleString()}건 / 오류 {errorCount.toLocaleString()}건</span>
        </div>
      </section>

      <div className="flow-groups">
        {grouped.map((group) => (
          <section key={group.stageName} className="flow-group">
            <div className="flow-group-head">
              <h2>{group.stageName}</h2>
              <span>{group.rows.length.toLocaleString()}개 구현 단위</span>
            </div>
            <div className="flow-cards">
              {group.rows.map((row) => {
                const targetStage = flowTargetStage(row)
                const linkedCount = linkedSettingCount(row, settings)
                const state = flowItemState(row, rowCounts, stats, progress, linkedCount)
                return (
                  <article key={valueToText(row.id)} className={`flow-card ${state.kind}`}>
                    <div className="flow-card-top">
                      <strong>{valueToText(row['이름'])}</strong>
                      <span>{state.label}</span>
                    </div>
                    <p>{valueToText(row['설명'])}</p>
                    <dl>
                      <div>
                        <dt>구현</dt>
                        <dd>{valueToText(row['구현상태']) || '확인필요'}</dd>
                      </div>
                      <div>
                        <dt>연결화면</dt>
                        <dd>{stageLabel(targetStage)}</dd>
                      </div>
                      <div>
                        <dt>연결설정</dt>
                        <dd>{linkedCount.toLocaleString()} row</dd>
                      </div>
                    </dl>
                    <button type="button" onClick={() => onGoStage(targetStage)}>
                      {targetStage === 'rules' ? '룰관리 열기' : `${stageLabel(targetStage)} 보기`}
                    </button>
                  </article>
                )
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

function flowStageSummary(name: string, rowCounts: { raw: number; pre: number; human: number; final: number }, review: number, errors: number) {
  if (name === '수집') return `${rowCounts.raw.toLocaleString()}건`
  if (name === '전처리') return `${rowCounts.pre.toLocaleString()}건 · 확인 ${review.toLocaleString()} · 오류 ${errors.toLocaleString()}`
  if (name === '사람입력') return `${rowCounts.human.toLocaleString()}건`
  if (name === '최종출력') return `${rowCounts.final.toLocaleString()}건`
  return ''
}

function flowTargetStage(row: NoticeRow): Stage {
  const target = valueToText(row['화면'])
  if (target === 'collect' || target === 'preprocess' || target === 'human' || target === 'output' || target === 'rules') return target
  return 'flow'
}

function stageLabel(stage: Stage) {
  if (stage === 'flow') return '작업 흐름'
  if (stage === 'collect') return '입찰공고 원본'
  if (stage === 'preprocess') return '입찰공고 전처리'
  if (stage === 'human') return '공고관리'
  if (stage === 'output') return '2차분류 완료'
  return '룰관리'
}

function linkedSettingCount(row: NoticeRow, settings: Record<string, NoticeRow[]>) {
  return valueToText(row['연결설정'])
    .split('/')
    .map((key) => key.trim())
    .filter(Boolean)
    .reduce((sum, key) => sum + (settings[key]?.length ?? 0), 0)
}

function flowItemState(
  row: NoticeRow,
  rowCounts: { raw: number; pre: number; human: number; final: number },
  stats: PipelineStats | null,
  progress: PreprocessProgress,
  linkedCount: number,
) {
  const id = valueToText(row.id)
  if (progress.running && id.startsWith('pre.')) return { kind: 'running', label: '진행중' }
  if (id === 'collect') return rowCounts.raw ? { kind: 'done', label: '데이터 있음' } : { kind: 'ready', label: '대기' }
  if (id.startsWith('pre.')) {
    if (rowCounts.pre) {
      if ((stats?.errors ?? 0) > 0 && id === 'pre.validation') return { kind: 'warn', label: '오류 있음' }
      if ((stats?.review ?? 0) > 0 && id === 'pre.validation') return { kind: 'warn', label: '검토필요' }
      return { kind: 'done', label: '실행됨' }
    }
    return rowCounts.raw ? { kind: 'ready', label: '준비됨' } : { kind: 'idle', label: '대기' }
  }
  if (id === 'human') return rowCounts.human ? { kind: 'done', label: '대상 있음' } : { kind: 'idle', label: '대기' }
  if (id === 'output') return rowCounts.final ? { kind: 'done', label: '준비됨' } : { kind: 'idle', label: '대기' }
  if (id === 'rules') return linkedCount ? { kind: 'done', label: '설정 로드됨' } : { kind: 'warn', label: '설정 없음' }
  return { kind: 'idle', label: '대기' }
}

function CollectionView({
  columns,
  rows,
  totalRows,
  filteredRows,
  rowLimit,
  setRowLimit,
  onRowOpen,
}: {
  columns: string[]
  rows: NoticeRow[]
  totalRows: number
  filteredRows: number
  rowLimit: number
  setRowLimit: (value: number) => void
  onRowOpen: (row: NoticeRow) => void
}) {
  return (
    <section className="table-section">
      <div className="section-head">
        <div>
          <h2>서버공고 전체 컬럼</h2>
          <span>
            {totalRows.toLocaleString()}건 중 {filteredRows.toLocaleString()}건, 화면 표시 {rows.length}건
          </span>
        </div>
        <select value={rowLimit} onChange={(event) => setRowLimit(Number(event.target.value))}>
          <option value={100}>100행</option>
          <option value={200}>200행</option>
          <option value={500}>500행</option>
        </select>
      </div>
      <DataTable columns={columns} rows={rows} emptyText="샘플 또는 A1 서버공고를 불러오세요." onRowClick={onRowOpen} />
    </section>
  )
}

function PreprocessView({
  columns,
  rows,
  stats,
  onRun,
  totalRows,
  filteredRows,
  onRowOpen,
}: {
  columns: string[]
  rows: NoticeRow[]
  stats: PipelineStats | null
  onRun: () => void
  totalRows: number
  filteredRows: number
  onRowOpen: (row: NoticeRow) => void
}) {
  const steps = ['곡괭이전나라시', '문서곡괭이', '곡괭이후나라시', '적격 1차', '적격 2차', '검증']
  return (
    <>
      <section className="pipeline-panel">
        <div className="section-head">
          <div>
            <h2>곡괭이질</h2>
            <span>수집 row를 전처리 row로 변환</span>
          </div>
          <button className="inline-action" type="button" onClick={onRun}>
            <RotateCcw size={16} />
            다시 전처리
          </button>
        </div>
        <div className="pipeline">
          {steps.map((step, index) => (
            <div key={step} className="pipeline-step">
              <span>{index + 1}</span>
              <strong>{step}</strong>
            </div>
          ))}
        </div>
        <div className="run-summary">
          <Metric label="처리" value={(stats?.total ?? 0).toLocaleString()} />
          <Metric label="변경" value={(stats?.changed ?? 0).toLocaleString()} />
          <Metric label="확인" value={(stats?.review ?? 0).toLocaleString()} />
          <Metric label="오류" value={(stats?.errors ?? 0).toLocaleString()} />
        </div>
      </section>
      <section className="table-section">
        <div className="section-head">
          <div>
            <h2>전처리 결과</h2>
            <span>
              {totalRows.toLocaleString()}건 중 {filteredRows.toLocaleString()}건, 화면 표시 {rows.length}건
            </span>
          </div>
        </div>
        <DataTable columns={columns} rows={rows} emptyText="전처리를 실행하세요." onRowClick={onRowOpen} />
      </section>
    </>
  )
}

function HumanView({
  columns,
  rows,
  allRows,
  selectedGongo,
  setSelectedGongo,
  draft,
  setDraft,
  onSave,
  onFinalize,
  onA3Parse,
  parserNote,
  loading,
  onRowOpen,
}: {
  columns: string[]
  rows: NoticeRow[]
  allRows: NoticeRow[]
  selectedGongo: string
  setSelectedGongo: (value: string) => void
  draft: Record<string, string>
  setDraft: (value: Record<string, string>) => void
  onSave: () => void
  onFinalize: () => void
  onA3Parse: () => void
  parserNote: string
  loading: boolean
  onRowOpen: (row: NoticeRow) => void
}) {
  return (
    <>
      <section className="editor-panel">
        <div className="section-head">
          <div>
            <h2>사람입력</h2>
            <span>사람이 고친 값은 저장 후 필요한 컬럼만 재전처리</span>
          </div>
          <div className="panel-actions">
            <button className="inline-action" type="button" onClick={onSave} disabled={!allRows.length}>
              <Save size={16} />
              저장/재전처리
            </button>
            <button className="inline-action" type="button" onClick={onA3Parse} disabled={!allRows.length || loading}>
              <Search size={16} />
              A3 문서곡괭이
            </button>
            <button className="inline-action" type="button" onClick={onFinalize} disabled={!allRows.length}>
              <ClipboardCheck size={16} />
              최종분류
            </button>
          </div>
        </div>
        <div className="editor-grid">
          <label className="wide-field">
            <span>공고 선택</span>
            <select value={selectedGongo} onChange={(event) => setSelectedGongo(event.target.value)}>
              {allRows.map((row, index) => {
                const gongo = valueToText(row['공고번호']) || `row-${index + 1}`
                return (
                  <option key={`${gongo}-${index}`} value={gongo}>
                    {gongo} · {valueToText(row['공사명']).slice(0, 60)}
                  </option>
                )
              })}
            </select>
          </label>
          {humanEditFields.map((field) => (
            <label key={field}>
              <span>{field}</span>
              <input
                value={draft[field] ?? ''}
                onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
              />
            </label>
          ))}
          <label className="wide-field">
            <span>문서곡괭이 근거</span>
            <textarea value={parserNote} readOnly placeholder="A3 문서곡괭이 실행 시 rule/source 근거가 표시됩니다." />
          </label>
        </div>
      </section>
      <section className="table-section">
        <div className="section-head">
          <div>
            <h2>사람입력 대상</h2>
            <span>{rows.length.toLocaleString()}건 표시</span>
          </div>
        </div>
        <DataTable columns={columns} rows={rows} emptyText="전처리 후 사람입력을 진행하세요." onRowClick={onRowOpen} />
      </section>
    </>
  )
}

function SettingsShell({
  profiles,
  rules,
  settings,
  rowCounts,
  selectedRuleItem,
  setSelectedRuleItem,
  ruleDraft,
  setRuleDraft,
  onSave,
  onAdd,
  onDelete,
  onSaveSetting,
  onSaveStandardRules,
  onClose,
}: {
  profiles: ServerColumnProfile[]
  rules: StandardColumnRule[]
  settings: Record<string, NoticeRow[]>
  rowCounts: { raw: number; pre: number; human: number; final: number }
  selectedRuleItem: string
  setSelectedRuleItem: (value: string) => void
  ruleDraft: Record<string, string>
  setRuleDraft: (value: Record<string, string>) => void
  onSave: () => void
  onAdd: () => void
  onDelete: () => void
  onSaveSetting: (key: string, rows: NoticeRow[]) => Promise<NoticeRow[]>
  onSaveStandardRules: (rows: NoticeRow[]) => Promise<NoticeRow[]>
  onClose: () => void
}) {
  const [activeMenu, setActiveMenu] = useState('dashboard')
  const [settingsSearch, setSettingsSearch] = useState('')
  const [settingsDark, setSettingsDark] = useState(false)
  const dirtyRef = useRef<Record<string, { label: string; save: () => Promise<void>; reset: () => void }>>({})
  const [, bumpDirtyVersion] = useState(0)
  const settingTabs = settings.settingTabs ?? []
  const categories = buildSettingCategories(settingTabs)
  const activeTab = settingTabs.find((tab) => valueToText(tab.id) === activeMenu) ?? settingTabs[0]
  const activeCategory = valueToText(activeTab?.대분류) || categories[0]?.title || '설정'
  const visibleTabs = settingTabs.filter((tab) => valueToText(tab.대분류) === activeCategory)
  const menuGroups = buildSettingMenuGroups(visibleTabs, settings, rules)

  useEffect(() => {
    if (!settingTabs.length) return
    if (!settingTabs.some((tab) => valueToText(tab.id) === activeMenu)) {
      setActiveMenu(valueToText(settingTabs[0].id))
    }
  }, [activeMenu, settingTabs])

  function updateDirtyState(id: string, label: string, dirty: boolean, save: () => Promise<void>, reset: () => void) {
    if (!id) return
    const hadDirty = Boolean(dirtyRef.current[id])
    if (dirty) {
      dirtyRef.current[id] = { label, save, reset }
      if (!hadDirty) bumpDirtyVersion((value) => value + 1)
      return
    }
    if (hadDirty) {
      delete dirtyRef.current[id]
      bumpDirtyVersion((value) => value + 1)
    }
  }

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!Object.keys(dirtyRef.current).length) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [])

  async function guardUnsavedChanges() {
    const dirtyItems = Object.values(dirtyRef.current)
    if (!dirtyItems.length) return true
    const labels = dirtyItems.map((item) => item.label).join(', ')
    if (window.confirm(`저장하지 않은 변경이 있습니다.\n\n${labels}\n\n저장하고 이동할까요?`)) {
      for (const item of dirtyItems) await item.save()
      dirtyRef.current = {}
      bumpDirtyVersion((value) => value + 1)
      return true
    }
    if (window.confirm('저장하지 않고 이동할까요? 변경사항은 되돌립니다.')) {
      for (const item of dirtyItems) item.reset()
      dirtyRef.current = {}
      bumpDirtyVersion((value) => value + 1)
      return true
    }
    return false
  }

  async function moveMenu(nextMenu: string) {
    if (nextMenu === activeMenu) return
    if (await guardUnsavedChanges()) setActiveMenu(nextMenu)
  }

  async function closeSettings() {
    if (await guardUnsavedChanges()) onClose()
  }

  return (
    <div className={`settings-shell ${settingsDark ? 'settings-shell-dark' : ''}`}>
      <aside className="settings-rail" aria-label="설정 주요 메뉴">
        <div className="rail-logo">G</div>
        {categories.map((category) => (
          <button
            key={category.title}
            className={`rail-category ${category.title === activeCategory ? 'active' : ''}`}
            type="button"
            title={category.title}
            onClick={() => void moveMenu(category.firstId)}
          >
            <SettingsRailIcon name={category.icon} />
          </button>
        ))}
      </aside>

      <aside className="settings-panel">
        <div className="settings-title">
          <strong>{activeCategory}</strong>
          <span>{visibleTabs.length.toLocaleString()}개 탭</span>
        </div>
        {menuGroups.map((group) => (
          <div key={group.title} className="settings-group">
            <p>{group.title}</p>
            {group.items.map((item) => (
              <button key={item.id} className={activeMenu === item.id ? 'active' : ''} type="button" onClick={() => void moveMenu(item.id)}>
                {item.label}
                {item.count !== null ? <span>{item.count.toLocaleString()}</span> : null}
              </button>
            ))}
          </div>
        ))}
      </aside>

      <main className="settings-main">
        <header className="settings-cmdbar">
          <div className="settings-search">
            <Search size={15} />
            <input value={settingsSearch} onChange={(event) => setSettingsSearch(event.target.value)} placeholder="설정 검색" />
          </div>
          <button
            type="button"
            title={settingsDark ? '밝은 모드' : '다크 모드'}
            aria-pressed={settingsDark}
            onClick={() => setSettingsDark((value) => !value)}
          >
            <Moon size={16} />
          </button>
          <button type="button" title="설정 닫기" onClick={() => void closeSettings()}>
            <X size={16} />
          </button>
        </header>

        <section className="settings-content">
          {activeMenu === '표준 컬럼 룰' ? (
            <RulesView
              profiles={profiles}
              rules={rules}
              selectedRuleItem={selectedRuleItem}
              setSelectedRuleItem={setSelectedRuleItem}
              ruleDraft={ruleDraft}
              setRuleDraft={setRuleDraft}
              onSave={onSave}
              onAdd={onAdd}
              onDelete={onDelete}
            />
          ) : (
            <SettingsContent
              activeMenu={activeMenu}
              search={settingsSearch}
              profiles={profiles}
              rules={rules}
              settings={settings}
              rowCounts={rowCounts}
              activeTab={activeTab}
              onSaveSetting={onSaveSetting}
              onSaveStandardRules={onSaveStandardRules}
              onDirtyChange={updateDirtyState}
            />
          )}
        </section>
      </main>
    </div>
  )
}

const settingIconMap: Record<string, LucideIcon> = {
  LayoutDashboard,
  CloudDownload,
  Workflow,
  Tags,
  Database,
  ClipboardCheck,
  UserRound,
  History,
  Settings,
}

function SettingsRailIcon({ name }: { name: string }) {
  const Icon = settingIconMap[name] ?? Settings
  return <Icon size={20} strokeWidth={2.1} />
}

function buildSettingCategories(tabs: NoticeRow[]) {
  const categories: Array<{ title: string; firstId: string; icon: string }> = []
  for (const tab of tabs) {
    const title = valueToText(tab.대분류) || '기타'
    const id = valueToText(tab.id)
    const icon = valueToText(tab.아이콘) || 'Settings'
    if (!id) continue
    if (!categories.some((category) => category.title === title)) {
      categories.push({ title, firstId: id, icon })
    }
  }
  return categories
}

function buildSettingMenuGroups(tabs: NoticeRow[], settings: Record<string, NoticeRow[]>, rules: StandardColumnRule[]) {
  const groups: Array<{ title: string; items: Array<{ id: string; label: string; count: number | null }> }> = []
  for (const tab of tabs) {
    const title = valueToText(tab.소분류) || valueToText(tab.대분류) || '기타'
    const id = valueToText(tab.id)
    if (!id) continue
    let group = groups.find((item) => item.title === title)
    if (!group) {
      group = { title, items: [] }
      groups.push(group)
    }
    group.items.push({
      id,
      label: valueToText(tab.라벨) || id,
      count: countSettingRowsForTab(tab, settings, rules),
    })
  }
  return groups
}

function countSettingRowsForTab(tab: NoticeRow, settings: Record<string, NoticeRow[]>, rules: StandardColumnRule[]) {
  const screenType = valueToText(tab.화면유형)
  const dataKey = valueToText(tab.데이터키)
  if (screenType === 'summary') return null
  if (dataKey === 'standardColumns') return rules.length
  if (!dataKey) return null
  return settings[dataKey]?.length ?? 0
}

function createChangelogRows(
  currentRows: NoticeRow[],
  settingTabs: NoticeRow[],
  profileRows: NoticeRow[],
  key: string,
  rowCount: number,
) {
  const tab = settingTabs.find((item) => valueToText(item.데이터키) === key)
  const now = new Date()
  const category = valueToText(tab?.대분류) || (key === 'standardColumns' ? '공고수집' : '설정')
  const label = valueToText(tab?.라벨) || (key === 'standardColumns' ? '공고분류컬럼 설정' : key)
  const actor = currentUserName(profileRows)
  const nextId = Math.max(0, ...currentRows.map((row) => Number(row.id) || 0)) + 1
  const nextRow: NoticeRow = {
    id: nextId,
    일시: formatDateTime(now),
    구분: category,
    대상: label,
    내용: `${label} 저장 (${rowCount.toLocaleString()}행)`,
    사용자: actor,
    메모: '설정 화면 저장',
  }
  return [nextRow, ...currentRows].slice(0, 500)
}

function currentUserName(profileRows: NoticeRow[]) {
  for (const row of profileRows) {
    const item = valueToText(row.항목).trim()
    if (['사용자', '사용자명', '담당자', '이름'].includes(item)) {
      const value = valueToText(row.값).trim()
      if (value) return value
    }
  }
  return 'local'
}

function formatDateTime(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function SettingsContent({
  activeMenu,
  search,
  profiles,
  rules,
  settings,
  rowCounts,
  activeTab,
  onSaveSetting,
  onSaveStandardRules,
  onDirtyChange,
}: {
  activeMenu: string
  search: string
  profiles: ServerColumnProfile[]
  rules: StandardColumnRule[]
  settings: Record<string, NoticeRow[]>
  rowCounts: { raw: number; pre: number; human: number; final: number }
  activeTab?: NoticeRow
  onSaveSetting: (key: string, rows: NoticeRow[]) => Promise<NoticeRow[]>
  onSaveStandardRules: (rows: NoticeRow[]) => Promise<NoticeRow[]>
  onDirtyChange: (id: string, label: string, dirty: boolean, save: () => Promise<void>, reset: () => void) => void
}) {
  const editableProps = (key: string, label?: string) => ({ datasetId: key, settingKey: key, onSaveSetting, onDirtyChange, dirtyLabel: label ?? key })
  const tabId = valueToText(activeTab?.id)
  const dataKey = valueToText(activeTab?.데이터키)
  const screenType = valueToText(activeTab?.화면유형)
  const tabLabel = valueToText(activeTab?.라벨) || activeMenu

  if (tabId === 'dashboard') {
    return <SettingsSummary settings={settings} profiles={profiles} rules={rules} rowCounts={rowCounts} search={search} />
  }
  if (screenType === 'parser') {
    return (
      <ParserRuleEditor
        rows={settings.parserRules ?? []}
        search={search}
        parserTypeGuide={settings.parserTypeGuide ?? []}
        onSave={(rows) => onSaveSetting('parserRules', rows)}
      />
    )
  }
  if (screenType === 'guide') {
    return <ParserTypeGuideView rows={settings.parserTypeGuide ?? []} search={search} onSaveSetting={onSaveSetting} onDirtyChange={onDirtyChange} />
  }
  if (screenType === 'normalizer') {
    return <ParserNormalizationView search={search} />
  }
  if (screenType === 'standard') {
    return (
      <SettingsDatasetView
        title={tabLabel}
        rows={rules as unknown as NoticeRow[]}
        search={search}
        preferredColumns={preferredColumnsForSetting('standardColumns')}
        datasetId="standardColumns"
        dirtyLabel={tabLabel}
        onSaveRows={onSaveStandardRules}
        onDirtyChange={onDirtyChange}
      />
    )
  }
  if (screenType === 'jongmok') {
    return (
      <SettingsDatasetView
        title={tabLabel}
        rows={settings.jongmokMap ?? []}
        search={search}
        preferredColumns={preferredColumnsForSetting('jongmokMap')}
        {...editableProps('jongmokMap', tabLabel)}
      />
    )
  }
  if (dataKey && dataKey !== 'standardColumns' && settings[dataKey]) {
    return (
      <SettingsDatasetView
        title={tabLabel}
        rows={settings[dataKey] ?? []}
        search={search}
        preferredColumns={preferredColumnsForSetting(dataKey)}
        {...editableProps(dataKey, tabLabel)}
      />
    )
  }

  if (activeMenu === '상태 요약') {
    return <SettingsSummary settings={settings} profiles={profiles} rules={rules} rowCounts={rowCounts} search={search} />
  }
  if (activeMenu === '수집 현황') {
    return (
      <SettingsDatasetView
        title="A1 서버공고 컬럼 형식"
        rows={profiles as unknown as NoticeRow[]}
        search={search}
        preferredColumns={['순번', '항목', '추정입력형식', '권장표시형식', '빈값비율', '예시값', '원본타입분포']}
      />
    )
  }
  if (activeMenu === '적격심사기준') {
    return (
      <div className="settings-stack">
        <SettingsDatasetView
          title="1차 적격심사평가기준"
          rows={settings.evaluationCriteria ?? []}
          search={search}
          preferredColumns={['id', '원발주처', '적격발주처', '적격심사기준', '시행일', '일반건설 (원)', '전문건설 (원)', '기타건설 (원)', '적격평가기준_세부']}
          {...editableProps('evaluationCriteria')}
        />
        <SettingsDatasetView
          title="적격심사기준 2차변경"
          rows={settings.secondaryCriteria ?? []}
          search={search}
          preferredColumns={['id', '적격평가기준_세부 (매칭키)', '입찰방식', '종목', '공고확인', '특수실적', '원발주처', '적격발주처', '적격평가기준_세부', '메모']}
          {...editableProps('secondaryCriteria')}
        />
      </div>
    )
  }
  if (activeMenu === '공고확인') {
    return <SettingsDatasetView title="공고확인" rows={settings.noticeTags ?? []} search={search} preferredColumns={keywordRuleColumns()} {...editableProps('noticeTags')} />
  }
  if (activeMenu === '특수실적') {
    return <SettingsDatasetView title="특수실적" rows={settings.specialRecords ?? []} search={search} preferredColumns={keywordRuleColumns()} {...editableProps('specialRecords')} />
  }
  if (activeMenu === '특수실적 공통' || activeMenu === '특수실적_공통') {
    return <SettingsDatasetView title="특수실적_공통" rows={settings.specialCommon ?? []} search={search} preferredColumns={['id', '종목', '발주처', '입찰방식', '대분류', '적격업체', '결과값', '상위실적', '검색키워드', '제외키워드', '메모']} {...editableProps('specialCommon')} />
  }
  if (activeMenu === '적격심사평가기준') {
    return (
      <SettingsDatasetView
        title="적격심사평가기준"
        rows={settings.evaluationCriteria ?? []}
        search={search}
        preferredColumns={['id', '원발주처', '적격발주처', '적격심사기준', '시행일', '일반건설 (원)', '전문건설 (원)', '기타건설 (원)', '적격평가기준_세부']}
        {...editableProps('evaluationCriteria')}
      />
    )
  }
  if (activeMenu === '적격심사 제외입찰방식') {
    return <SettingsDatasetView title="적격심사 제외입찰방식" rows={settings.bidMethodSkip ?? []} search={search} preferredColumns={['id', '입찰방식', '메모']} {...editableProps('bidMethodSkip')} />
  }
  if (activeMenu === '종목 매핑' || activeMenu === '종목매핑') {
    return <SettingsDatasetView title="종목매핑" rows={settings.jongmokMap ?? []} search={search} preferredColumns={['id', '원본 (등록증 표기)', '일반_기타_전문', '세부유형', '업종', '주력업종', '상위업종', '대체업종', '상호진출_상대종목', '단독평가_제외', '길이']} {...editableProps('jongmokMap')} />
  }
  if (activeMenu === '지역 설정') {
    return <RegionSettingsView settings={settings} search={search} onSaveSetting={onSaveSetting} />
  }
  if (activeMenu === '발주처코드') {
    return <SettingsDatasetView title="발주처코드" rows={settings.agencyCode ?? []} search={search} preferredColumns={['코드', '발주처명', '상위코드']} {...editableProps('agencyCode')} />
  }
  if (activeMenu === '지역코드') {
    return <SettingsDatasetView title="지역코드" rows={settings.regionDb ?? []} search={search} preferredColumns={['ID', '광역시/도-전처리전', '광역시/도-전처리후', '시군구-전처리전', '시군구-전처리후', '하위구-전처리전', '하위구-전처리후', '시군구-홈페이지용', '인접지역']} {...editableProps('regionDb')} />
  }
  if (activeMenu === '한전 배전사업소') {
    return <SettingsDatasetView title="한전 배전사업소" rows={settings.kepcoOffice ?? []} search={search} preferredColumns={['id', '지역본부', '사업소명', '인접 사업소']} {...editableProps('kepcoOffice')} />
  }
  if (activeMenu === '한전 송전사업소') {
    return <SettingsDatasetView title="한전 송전사업소" rows={settings.transmissionOffice ?? []} search={search} preferredColumns={['id', '지역본부', '사업소명', '인접 사업소']} {...editableProps('transmissionOffice')} />
  }
  if (activeMenu === '폐광지역진흥지구') {
    return <SettingsDatasetView title="폐광지역진흥지구" rows={settings.regionMine ?? []} search={search} preferredColumns={['id', '광역', '시·군', '상세 구역']} {...editableProps('regionMine')} />
  }
  if (activeMenu === '공고분류컬럼 설정') {
    return <SettingsDatasetView title="공고분류컬럼 설정" rows={rules as unknown as NoticeRow[]} search={search} preferredColumns={preferredColumnsForSetting('standardColumns')} datasetId="standardColumns" dirtyLabel="공고분류컬럼 설정" onSaveRows={onSaveStandardRules} onDirtyChange={onDirtyChange} />
  }
  if (activeMenu === '발주처 변경') {
    return <SettingsDatasetView title="적격발주처 변경" rows={settings.orgMap ?? []} search={search} preferredColumns={['id', '발주처 키워드', '매핑 대상']} {...editableProps('orgMap')} />
  }
  if (activeMenu === '문서곡괭이 룰') {
    return (
      <ParserRuleEditor rows={settings.parserRules ?? []} search={search} parserTypeGuide={settings.parserTypeGuide ?? []} onSave={(rows) => onSaveSetting('parserRules', rows)} />
    )
  }
  if (activeMenu === '조건판단형태 가이드') {
    return (
      <ParserTypeGuideView rows={settings.parserTypeGuide ?? []} search={search} onSaveSetting={onSaveSetting} onDirtyChange={onDirtyChange} />
    )
  }
  if (activeMenu === '샘플 공고 테스트') {
    return <ParsermanTestView search={search} parserRules={settings.parserRules ?? []} />
  }
  if (activeMenu === '문서곡괭이 리포트') {
    return <ParsermanReport settings={settings} search={search} />
  }
  if (activeMenu === '오류 리포트') {
    return <SettingsErrorReport settings={settings} profiles={profiles} rules={rules} rowCounts={rowCounts} search={search} />
  }
  return <div className="empty-state">선택한 설정 화면이 없습니다.</div>
}

function keywordRuleColumns() {
  return ['id', '종목', '발주처', '입찰방식', '대분류', '결과값', '상위실적', '내용입력필요', '검색키워드', '제외키워드', '메모']
}

function preferredColumnsForSetting(key: string) {
  const map: Record<string, string[]> = {
    apiConfig: ['id', '엔드포인트명', '용도', 'URL', '사용여부', '메모'],
    deleteKeywords: ['id', '컬럼명', '검색키워드', '처리방법', '메모'],
    biddingFormula: ['id', '항목', '조건', '산식', '사용여부', '메모'],
    bracketRules: ['id', '컬럼명', '검색키워드', '변경 후', '처리방법'],
    autoValidateRules: ['id', '검증명', '대상컬럼', '조건', '심각도', '사용여부', '메모'],
    matcherRules: ['id', '단계', '대상', '조건', '결과', '사용여부', '메모'],
    fieldRules: ['id', '화면', '컬럼', '표시여부', '순서', '메모'],
    keywordRules: ['id', '대상컬럼', '검색키워드', '제외키워드', '결과값', '사용여부', '메모'],
    specialRecords: keywordRuleColumns(),
    specialCommon: ['id', '종목', '발주처', '입찰방식', '대분류', '적격업체', '결과값', '상위실적', '검색키워드', '제외키워드', '메모'],
    noticeTags: keywordRuleColumns(),
    evaluationCriteria: ['id', '원발주처', '적격발주처', '적격심사기준', '시행일', '일반건설 (원)', '전문건설 (원)', '기타건설 (원)', '적격평가기준_세부'],
    secondaryCriteria: ['id', '적격평가기준_세부 (매칭키)', '입찰방식', '종목', '공고확인', '특수실적', '등급공사', '동일실적평가여부', '원발주처', '적격발주처', '적격평가기준_세부', '지역제한', '추정가격기준', '추정금액기준', '기초금액기준', '메모'],
    jongmokMap: ['id', '원본 (등록증 표기)', '일반_기타_전문', '세부유형', '업종', '주력업종', '상위업종', '대체업종', '상호진출_상대종목', '단독평가_제외', '길이'],
    jongmokBundleRules: ['구분', '상황', '입력', '조건', '종목', '단독평가종목', '종목세부JSON', '메모'],
    agencyCode: ['코드', '발주처명', '상위코드'],
    wideRegion: ['id', '전처리전', '전처리후', '메모'],
    regionDb: ['ID', '광역시/도-전처리전', '광역시/도-전처리후', '시군구-전처리전', '시군구-전처리후', '하위구-전처리전', '하위구-전처리후', '시군구-홈페이지용', '인접지역'],
    adjacencyRegion: ['id', '광역', '시군구', '인접지역', '메모'],
    kepcoOffice: ['id', '지역본부', '사업소명', '인접 사업소'],
    transmissionOffice: ['id', '지역본부', '사업소명', '인접 사업소'],
    powerPlantRegion: ['id', '발전소명', '지역', '상세구역', '메모'],
    regionMine: ['id', '광역', '시·군', '상세 구역'],
    regionHint: ['id', '원문', '후보지역', '처리상태', '메모'],
    standardColumns: ['id', '항목', '표시형식', '처리방법', '우선순위', '참조방법', '참조메모', '선택목록', '공고관리 표시', '상세정보입력'],
    reviewQueue: ['id', '구분', '대상', '상태', '메모'],
    profileInfo: ['id', '항목', '값', '메모'],
    excludedItems: ['id', '종목', '사용여부', '메모'],
    changelog: ['id', '일시', '구분', '대상', '내용', '사용자', '메모'],
    parserTypeGuide: [
      '조건판단형태',
      '이름',
      '용도',
      '출력',
      '정규화범위',
      '키워드매칭방식',
      '우선섹션분류',
      'fallback범위',
      '제외검사범위',
      '근거저장단위',
      '판단로직',
      '영향정책',
      '예시본문',
      '결과예시',
      '주의',
      '토글비고',
    ],
    parserRules: ['id', '사용여부', '대상컬럼', '조건판단형태', '표시형식', '검색키워드', '제외키워드', '고정값', '참조마스터', '문맥범위', '검색범위', '제외범위', 'gap', '우선순위', '후처리', '예시본문', '기대값', '설명'],
    sectionRules: ['id', '사용여부', '섹션분류', '제목키워드', '본문키워드', '제외키워드', '우선순위', '메모'],
    bidMethodSkip: ['id', '입찰방식', '메모'],
  }
  return map[key] ?? ['id', '항목', '값', '메모']
}

function RegionSettingsView({
  settings,
  search,
  onSaveSetting,
}: {
  settings: Record<string, NoticeRow[]>
  search: string
  onSaveSetting: (key: string, rows: NoticeRow[]) => Promise<NoticeRow[]>
}) {
  const tabs = [
    {
      id: 'regionDb',
      label: '행정지역',
      title: '행정지역',
      rows: settings.regionDb ?? [],
      columns: ['ID', '광역시/도-전처리전', '광역시/도-전처리후', '시군구-전처리전', '시군구-전처리후', '하위구-전처리전', '하위구-전처리후', '시군구-홈페이지용', '인접지역'],
    },
    {
      id: 'kepcoOffice',
      label: '배전사업소',
      title: '한전 배전사업소',
      rows: settings.kepcoOffice ?? [],
      columns: ['id', '지역본부', '사업소명', '인접 사업소'],
    },
    {
      id: 'transmissionOffice',
      label: '송전사업소',
      title: '송전사업소',
      rows: settings.transmissionOffice ?? [],
      columns: ['id', '지역본부', '사업소명', '인접 사업소'],
    },
    {
      id: 'regionMine',
      label: '폐광지역진흥지구',
      title: '폐광지역진흥지구',
      rows: settings.regionMine ?? [],
      columns: ['id', '광역', '시·군', '상세 구역'],
    },
  ]
  const [activeTab, setActiveTab] = useState(tabs[0].id)
  const active = tabs.find((tab) => tab.id === activeTab) ?? tabs[0]

  return (
    <div className="settings-stack">
      <div className="settings-subtabs" role="tablist" aria-label="지역 설정 세부 탭">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={active.id === tab.id ? 'active' : ''}
            type="button"
            role="tab"
            aria-selected={active.id === tab.id}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
            <span>{tab.rows.length.toLocaleString()}</span>
          </button>
        ))}
      </div>
      <SettingsDatasetView title={active.title} rows={active.rows} search={search} preferredColumns={active.columns} settingKey={active.id} onSaveSetting={onSaveSetting} />
    </div>
  )
}

function SettingsDatasetView({
  title,
  rows,
  search,
  preferredColumns = [],
  datasetId,
  dirtyLabel,
  onDirtyChange,
  settingKey,
  onSaveSetting,
  onSaveRows,
  selectColumnOptions = {},
  multiSelectColumnOptions = {},
  columnHelpMap = {},
}: {
  title: string
  rows: NoticeRow[]
  search: string
  preferredColumns?: string[]
  datasetId?: string
  dirtyLabel?: string
  onDirtyChange?: (id: string, label: string, dirty: boolean, save: () => Promise<void>, reset: () => void) => void
  settingKey?: string
  onSaveSetting?: (key: string, rows: NoticeRow[]) => Promise<NoticeRow[]>
  onSaveRows?: (rows: NoticeRow[]) => Promise<NoticeRow[]>
  selectColumnOptions?: Record<string, string[]>
  multiSelectColumnOptions?: Record<string, string[]>
  columnHelpMap?: Record<string, string>
}) {
  const editable = Boolean((settingKey && onSaveSetting) || onSaveRows)
  const [draftRows, setDraftRows] = useState<NoticeRow[]>(rows)
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [saveStatus, setSaveStatus] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number | 'all'>(500)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    setDraftRows(rows)
    setSelectedIndex(null)
  }, [rows])

  useEffect(() => {
    setSaveStatus('')
  }, [title])

  useEffect(() => {
    setPage(1)
  }, [rows, search, title])

  const sourceRows = editable ? draftRows : rows
  const filtered = filterSettingRows(sourceRows, search)
  const baseColumns = columnsForRows(filtered.length ? filtered : sourceRows, preferredColumns)
  const columns = baseColumns.filter((col) => {
    if (SETTINGS_DEFAULT_HIDDEN_COLUMNS.has(col)) return false
    if (datasetId === 'standardColumns' && STANDARD_COLUMNS_DEFAULT_HIDDEN.has(col)) return false
    return true
  })
  const effectivePageSize = pageSize === 'all' ? Math.max(filtered.length, 1) : pageSize
  const totalPages = Math.max(1, Math.ceil(filtered.length / effectivePageSize))
  const safePage = Math.min(page, totalPages)
  const pageStart = pageSize === 'all' ? 0 : (safePage - 1) * effectivePageSize
  const pageRows = pageSize === 'all' ? filtered : filtered.slice(pageStart, pageStart + effectivePageSize)
  const displayed = pageRows.map((row) => ({ ...row, __settingsIndex: sourceRows.indexOf(row) }))
  const isDirty = editable && JSON.stringify(draftRows.map(stripSettingsMeta)) !== JSON.stringify(rows.map(stripSettingsMeta))

  function changeCell(row: NoticeRow, col: string, value: string) {
    const index = Number(row.__settingsIndex)
    if (!Number.isFinite(index) || index < 0) return
    setDraftRows((prev) => prev.map((item, itemIndex) => (itemIndex === index ? { ...item, [col]: value } : item)))
    setSaveStatus('변경됨. 저장을 누르면 파일에 반영됩니다.')
  }

  function addRow() {
    const nextId = String(Math.max(0, ...draftRows.map((row) => Number(row.id) || 0)) + 1)
    const nextRow = columns.reduce<NoticeRow>((acc, col) => {
      acc[col] = col === 'id' ? nextId : ''
      return acc
    }, {})
    setDraftRows((prev) => [...prev, nextRow])
    setSelectedIndex(draftRows.length)
    setSaveStatus(`새 행 추가: ${nextId}`)
  }

  function deleteSelected() {
    if (selectedIndex === null) return
    setDraftRows((prev) => prev.filter((_, index) => index !== selectedIndex))
    setSelectedIndex(null)
    setSaveStatus('선택 행 삭제됨. 저장을 눌러야 파일에 반영됩니다.')
  }

  async function saveRows() {
    if (!onSaveRows && (!settingKey || !onSaveSetting)) return
    const cleanRows = draftRows.map(stripSettingsMeta)
    const saved = onSaveRows ? await onSaveRows(cleanRows) : await onSaveSetting!(settingKey!, cleanRows)
    setDraftRows(saved)
    setSaveStatus(`저장 완료: ${saved.length.toLocaleString()}행`)
  }

  function downloadCsv() {
    const exportRows = sourceRows.map(stripSettingsMeta)
    const exportColumns = columnsForRows(exportRows, columns)
    const today = new Date().toISOString().slice(0, 10)
    exportCsv(exportRows, exportColumns, `${today}_${safeFileName(title)}.csv`)
  }

  async function uploadCsv(event: ReactChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const text = await file.text()
    const uploadedRows = parseCsvUpload(text)
    setDraftRows(uploadedRows)
    setSelectedIndex(null)
    setSaveStatus(`가져오기: ${uploadedRows.length.toLocaleString()}행. 저장을 누르면 파일에 반영됩니다.`)
  }

  function resetRows() {
    setDraftRows(rows)
    setSelectedIndex(null)
    setSaveStatus('원본으로 되돌림')
  }

  useEffect(() => {
    if (!datasetId || !onDirtyChange) return
    onDirtyChange(datasetId, dirtyLabel ?? title, isDirty, saveRows, resetRows)
  }, [datasetId, dirtyLabel, draftRows, isDirty, onDirtyChange, rows, title])

  return (
    <section className="table-section settings-table-section">
      <div className="section-head compact-section-head">
        <div className="section-title-line">
          <h2>{title}</h2>
          <span>
            전체 {sourceRows.length.toLocaleString()}건 · 검색 {filtered.length.toLocaleString()}건 · 표시 {displayed.length.toLocaleString()}건
            {totalPages > 1 ? ` · ${safePage.toLocaleString()}/${totalPages.toLocaleString()}쪽` : ''}
            {isDirty ? ' · 저장 필요' : ''}
          </span>
        </div>
        {editable || sourceRows.length ? (
          <div className="section-actions">
            <button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={safePage <= 1}>이전</button>
            <select
              className="page-size-select"
              value={pageSize}
              onChange={(event) => {
                const value = event.target.value
                setPageSize(value === 'all' ? 'all' : Number(value))
                setPage(1)
              }}
            >
              <option value={500}>500행</option>
              <option value={1000}>1000행</option>
              <option value="all">전체</option>
            </select>
            <button type="button" onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={safePage >= totalPages}>다음</button>
            <button type="button" onClick={downloadCsv}>내보내기</button>
            {editable ? (
              <>
                <button type="button" onClick={() => fileInputRef.current?.click()}>가져오기</button>
                <button type="button" onClick={addRow}>행 추가</button>
                <button type="button" onClick={deleteSelected} disabled={selectedIndex === null}>선택 삭제</button>
                <button type="button" onClick={resetRows}>되돌리기</button>
                <button type="button" onClick={saveRows}>저장</button>
                <input ref={fileInputRef} className="hidden-file-input" type="file" accept=".csv,text/csv" onChange={uploadCsv} />
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      {saveStatus ? <div className="settings-save-status">{saveStatus}</div> : null}
      <DataTable
        columns={columns}
        rows={displayed}
        emptyText={`${title} 데이터가 없습니다.`}
        tableId={`settings:${datasetId ?? settingKey ?? title}`}
        editable={editable}
        standardColumnMode={datasetId === 'standardColumns'}
        selectColumnOptions={selectColumnOptions}
        multiSelectColumnOptions={multiSelectColumnOptions}
        columnHelpMap={columnHelpMap}
        onCellChange={changeCell}
        onRowClick={editable ? (row) => setSelectedIndex(Number(row.__settingsIndex)) : undefined}
        rowClassName={editable ? (row) => (Number(row.__settingsIndex) === selectedIndex ? 'selected-row' : '') : undefined}
      />
    </section>
  )
}

function stripSettingsMeta(row: NoticeRow) {
  const clean: NoticeRow = {}
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith('__')) continue
    clean[key] = value
  }
  return clean
}

const parserRuleEditFields = [
  'id',
  '사용여부',
  '대상컬럼',
  '조건판단형태',
  '표시형식',
  '검색키워드',
  '제외키워드',
  '고정값',
  '참조마스터',
  '문맥범위',
  '검색범위',
  '제외범위',
  'gap',
  '우선순위',
  '후처리',
  '예시본문',
  '기대값',
  '설명',
]

function ParserRuleEditor({
  rows,
  search,
  parserTypeGuide = [],
  onSave,
}: {
  rows: NoticeRow[]
  search: string
  parserTypeGuide?: NoticeRow[]
  onSave: (rows: NoticeRow[]) => Promise<NoticeRow[]>
}) {
  const normalizedRows = useMemo(() => rows.map(normalizeParserRuleRow), [rows])
  const [selectedId, setSelectedId] = useState('')
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [status, setStatus] = useState('룰을 선택하거나 새 룰을 추가하세요.')
  const [testResult, setTestResult] = useState<{ actual: string; expected: string; status: string; source: string } | null>(null)
  const activeTypeGuide = parserTypeGuide.find((row) => valueToText(row['조건판단형태']) === valueToText(draft['조건판단형태']))

  useEffect(() => {
    const selected = normalizedRows.find((row) => valueToText(row.id) === selectedId) ?? normalizedRows[0]
    if (!selected) {
      setSelectedId('')
      setDraft({})
      return
    }
    if (valueToText(selected.id) !== selectedId) setSelectedId(valueToText(selected.id))
    setDraft(
      parserRuleEditFields.reduce<Record<string, string>>((acc, field) => {
        acc[field] = valueToText(selected[field])
        return acc
      }, {}),
    )
  }, [normalizedRows, selectedId])

  async function saveDraft() {
    const id = draft.id?.trim()
    if (!id) {
      setStatus('id가 필요합니다.')
      return
    }
    if (!draft.대상컬럼?.trim() || !draft.조건판단형태?.trim()) {
      setStatus('대상컬럼과 조건판단형태가 필요합니다.')
      return
    }
    const next = normalizedRows.some((row) => valueToText(row.id) === selectedId)
      ? normalizedRows.map((row) => (valueToText(row.id) === selectedId ? { ...row, ...draft } : row))
      : [...normalizedRows, { ...draft }]
    const saved = await onSave(next.map(normalizeParserRuleRow))
    setSelectedId(id)
    setStatus(`저장 완료: ${id} (${saved.length.toLocaleString()}행)`)
  }

  async function addRule() {
    const nextId = String(Math.max(0, ...normalizedRows.map((row) => Number(row.id) || 0)) + 1)
    const nextRule = normalizeParserRuleRow({
      id: nextId,
      사용여부: 'true',
      대상컬럼: '새파서컬럼',
      조건판단형태: '3_1',
      검색키워드: '새키워드',
      고정값: '1',
      문맥범위: '200',
      gap: '15',
      우선순위: String(Number(nextId) * 10),
      설명: '새 문서곡괭이 룰',
    })
    const saved = await onSave([...normalizedRows, nextRule])
    setSelectedId(nextId)
    setStatus(`새 룰 추가: ${nextId} (${saved.length.toLocaleString()}행)`)
  }

  async function deleteRule() {
    if (!selectedId) return
    const next = normalizedRows.filter((row) => valueToText(row.id) !== selectedId)
    const saved = await onSave(next)
    setSelectedId(saved[0] ? valueToText(saved[0].id) : '')
    setStatus(`삭제 완료: ${selectedId}`)
  }

  async function testDraftRule() {
    const body = draft.예시본문?.trim()
    const target = draft.대상컬럼?.trim()
    if (!body || !target) {
      setStatus('예시본문과 대상컬럼이 있어야 선택 룰 테스트를 할 수 있습니다.')
      return
    }
    try {
      const result = await runParsermanRuleTest({ rule: draft, body })
      const actual = valueToText(result.fields?.[target]).trim()
      const expected = valueToText(draft.기대값).trim()
      const ok = expected ? normalizeCompare(actual) === normalizeCompare(expected) : Boolean(actual)
      const source = result.matches?.[0]?.sourceText || result.evidence?.[target] || ''
      setTestResult({ actual, expected, source, status: ok ? '통과' : '확인필요' })
      setStatus(`선택 룰 테스트 ${ok ? '통과' : '확인필요'}: 실제값=${actual || '(빈값)'}`)
    } catch (error) {
      setTestResult({ actual: '', expected: valueToText(draft.기대값), source: '', status: '오류' })
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className="settings-stack">
      <section className="editor-panel">
        <div className="section-head">
          <div>
            <h2>문서곡괭이 룰 편집</h2>
            <span>{status}</span>
          </div>
          <div className="panel-actions">
            <button className="inline-action" type="button" onClick={addRule}>
              <Play size={16} />
              행 추가
            </button>
            <button className="inline-action" type="button" onClick={saveDraft}>
              <Save size={16} />
              저장
            </button>
            <button className="inline-action" type="button" onClick={testDraftRule}>
              <CheckCircle2 size={16} />
              선택 룰 테스트
            </button>
            <button className="inline-action danger" type="button" onClick={deleteRule}>
              <AlertTriangle size={16} />
              삭제
            </button>
          </div>
        </div>
        <div className="editor-grid parser-rule-editor">
          <label className="wide-field">
            <span>룰 선택</span>
            <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
              {normalizedRows.map((row) => (
                <option key={valueToText(row.id)} value={valueToText(row.id)}>
                  {valueToText(row.id)} · {valueToText(row.대상컬럼)} · {valueToText(row.조건판단형태)}
                </option>
              ))}
            </select>
          </label>
          {parserRuleEditFields.map((field) => (
            <label key={field} className={['검색키워드', '제외키워드', '검색범위', '제외범위', '예시본문', '기대값', '설명'].includes(field) ? 'wide-field' : ''}>
              <span>{field}</span>
              {field === '조건판단형태' ? (
                <select value={draft[field] ?? ''} onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}>
                  <option value="">선택</option>
                  {parserTypeGuide.map((guide) => (
                    <option key={valueToText(guide['조건판단형태'])} value={valueToText(guide['조건판단형태'])}>
                      {valueToText(guide['조건판단형태'])} · {valueToText(guide['이름'])}
                    </option>
                  ))}
                </select>
              ) : ['검색키워드', '제외키워드', '검색범위', '제외범위', '예시본문', '기대값', '설명'].includes(field) ? (
                <textarea value={draft[field] ?? ''} onChange={(event) => setDraft({ ...draft, [field]: event.target.value })} />
              ) : (
                <input value={draft[field] ?? ''} onChange={(event) => setDraft({ ...draft, [field]: event.target.value })} />
              )}
            </label>
          ))}
        </div>
        {activeTypeGuide ? (
          <div className="parser-type-help">
            <strong>{valueToText(activeTypeGuide['조건판단형태'])} · {valueToText(activeTypeGuide['이름'])}</strong>
            <span>{valueToText(activeTypeGuide['용도'])}</span>
            <p>예시: {valueToText(activeTypeGuide['예시본문'])} → {valueToText(activeTypeGuide['결과예시'])}</p>
            <em>{valueToText(activeTypeGuide['주의'])}</em>
          </div>
        ) : null}
        {testResult ? (
          <div className={`parser-rule-test-result ${testResult.status === '통과' ? 'ok' : 'warn'}`}>
            <strong>테스트 {testResult.status}</strong>
            <span>기대값: {testResult.expected || '(기대값 없음)'}</span>
            <span>실제값: {testResult.actual || '(빈값)'}</span>
            <p>{testResult.source || '근거 없음'}</p>
          </div>
        ) : null}
      </section>
      <SettingsDatasetView
        title="문서곡괭이 룰 목록"
        rows={normalizedRows}
        search={search}
        preferredColumns={['id', '사용여부', '대상컬럼', '조건판단형태', '표시형식', '검색키워드', '제외키워드', '고정값', '참조마스터', '문맥범위', '검색범위', '제외범위', 'gap', '우선순위', '후처리', '예시본문', '기대값', '설명']}
        onSaveRows={async (nextRows) => {
          const saved = await onSave(nextRows.map(normalizeParserRuleRow))
          setStatus(`룰 목록 저장 완료: ${saved.length.toLocaleString()}행`)
          return saved.map(normalizeParserRuleRow)
        }}
      />
    </div>
  )
}

function normalizeParserRuleRow(row: NoticeRow) {
  return parserRuleEditFields.reduce<NoticeRow>((acc, field) => {
    acc[field] = valueToText(row[field])
    return acc
  }, {})
}

function splitGuideItems(value: unknown) {
  return valueToText(value)
    .split('|')
    .map((item) => item.trim())
    .filter(Boolean)
}

function ParserTypeGuideView({
  rows,
  search,
  onSaveSetting,
  onDirtyChange,
}: {
  rows: NoticeRow[]
  search: string
  onSaveSetting: (key: string, rows: NoticeRow[]) => Promise<NoticeRow[]>
  onDirtyChange?: (id: string, label: string, dirty: boolean, save: () => Promise<void>, reset: () => void) => void
}) {
  const visibleRows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const base = rows.filter((row) => valueToText(row['조건판단형태']).trim())
    if (!needle) return base
    return base.filter((row) => Object.values(row).some((value) => valueToText(value).toLowerCase().includes(needle)))
  }, [rows, search])
  const [activeType, setActiveType] = useState('')
  const [policy, setPolicy] = useState({
    whitespace: true,
    wordBoundary: true,
    exclude: true,
  })

  useEffect(() => {
    if (!visibleRows.length) {
      setActiveType('')
      return
    }
    if (!visibleRows.some((row) => valueToText(row['조건판단형태']) === activeType)) {
      setActiveType(valueToText(visibleRows[0]['조건판단형태']))
    }
  }, [activeType, visibleRows])

  const active = visibleRows.find((row) => valueToText(row['조건판단형태']) === activeType) ?? visibleRows[0]
  const logic = splitGuideItems(active?.['판단로직'])
  const policies = splitGuideItems(active?.['영향정책'])
  const disabledNote = valueToText(active?.['토글비고']).trim()
  const scopeRows = [
    ['정규화범위', valueToText(active?.['정규화범위'])],
    ['키워드매칭방식', valueToText(active?.['키워드매칭방식'])],
    ['우선섹션분류', valueToText(active?.['우선섹션분류'])],
    ['fallback범위', valueToText(active?.['fallback범위'])],
    ['제외검사범위', valueToText(active?.['제외검사범위'])],
    ['근거저장단위', valueToText(active?.['근거저장단위'])],
  ].filter(([, value]) => value.trim())

  return (
    <div className="parser-guide-view">
      <section className="parser-policy-panel">
        <div className="parser-policy-head">
          <strong>매칭 정책</strong>
          <span>화면 기준 15개 조건판단형태</span>
        </div>
        <div className="parser-policy-list">
          <label>
            <input
              type="checkbox"
              checked={policy.whitespace}
              onChange={(event) => setPolicy({ ...policy, whitespace: event.target.checked })}
            />
            <strong>공백 무시</strong>
            <span>본문/키워드 공백 제거 후 매치. 예: 국민건강 보험료 ↔ 국민건강보험료</span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={policy.wordBoundary}
              onChange={(event) => setPolicy({ ...policy, wordBoundary: event.target.checked })}
            />
            <strong>단어 경계</strong>
            <span>매치 영역 앞뒤에 한글/영숫자가 붙으면 비매치. 예: 국민건강 ↔ 국민건강보험료 차단</span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={policy.exclude}
              onChange={(event) => setPolicy({ ...policy, exclude: event.target.checked })}
            />
            <strong>exclude 검사</strong>
            <span>제외키워드가 매치 주변에 있으면 해당 항목을 버립니다.</span>
          </label>
        </div>
      </section>

      <section className="parser-guide-intro">
        <strong>문서곡괭이 조건판단형태 가이드</strong>
        <span>
          문서곡괭이는 공고문 HTML을 읽고 각 컬럼 룰의 조건판단형태를 위에서 아래로 시도합니다. 룰에 여러 타입이 있으면 첫
          성공값을 채택하고, 실패하면 다음 타입으로 넘어갑니다.
        </span>
      </section>

      <section className="parser-guide-shell">
        <aside className="parser-guide-nav">
          {visibleRows.map((row) => {
            const code = valueToText(row['조건판단형태'])
            const name = valueToText(row['이름'])
            return (
              <button key={code} type="button" className={code === activeType ? 'active' : ''} onClick={() => setActiveType(code)}>
                {code} · {name}
              </button>
            )
          })}
        </aside>
        <div className="parser-guide-card">
          {active ? (
            <>
              <div className="parser-guide-card-head">
                <span>{valueToText(active['조건판단형태'])}</span>
                <strong>{valueToText(active['이름'])}</strong>
                <em>→ {valueToText(active['출력']) || valueToText(active['결과예시'])}</em>
              </div>
              <p className="parser-guide-desc">{valueToText(active['용도'])}</p>

              <div className="parser-guide-section">
                <strong>기본 파싱 범위</strong>
                <div className="parser-scope-grid">
                  {scopeRows.map(([label, value]) => (
                    <label key={label}>
                      <span>{label}</span>
                      <b>{value}</b>
                    </label>
                  ))}
                </div>
              </div>

              <div className="parser-guide-section">
                <strong>판단 로직 (이 순서대로)</strong>
                <ol>
                  {logic.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ol>
              </div>

              <div className="parser-guide-section">
                <strong>영향 받는 정책</strong>
                <div className="parser-guide-chips">
                  {policies.map((item) => (
                    <span key={item} className={item.includes('OFF') || item.includes('미적용') ? 'off' : ''}>
                      {item}
                    </span>
                  ))}
                </div>
              </div>

              <div className="parser-guide-example">
                <span>예시</span>
                <p>{valueToText(active['예시본문'])}</p>
                <b>→ {valueToText(active['결과예시'])}</b>
              </div>

              <div className="parser-guide-section">
                <strong>함정 / 주의</strong>
                <p>{valueToText(active['주의'])}</p>
              </div>

              <div className={disabledNote ? 'parser-guide-toggle disabled' : 'parser-guide-toggle'}>
                <strong>정책 토글 (이 type 만)</strong>
                {disabledNote ? (
                  <span>{disabledNote}</span>
                ) : (
                  <div>
                    {['공백 무시', '단어 경계', 'exclude'].map((label) => (
                      <label key={label}>
                        <span>{label}</span>
                        <button type="button">전역</button>
                        <button type="button">ON</button>
                        <button type="button">OFF</button>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="empty-state">조건판단형태 가이드 데이터가 없습니다.</div>
          )}
        </div>
      </section>

      <section className="parser-guide-policy">
        <strong>매칭 정책 / 추가 사양</strong>
        <ul>
          <li>multi-type fallback: types 배열은 위에서 아래로 시도하고 첫 매치를 채택합니다.</li>
          <li>단어 경계와 공백 무시는 기본 정책입니다. 1_4와 2_2는 코드에서 일부 정책을 고정합니다.</li>
          <li>제외키워드는 매치된 값이나 주변 문장에 하나라도 있으면 OR 조건으로 차단합니다.</li>
          <li>5_1은 추출값을 만들지 않고 검색 종료점만 설정합니다.</li>
          <li>7_1은 공고확인, 특수실적, 특수실적_공통 같은 설정 마스터와 연결됩니다.</li>
        </ul>
      </section>

      <SettingsDatasetView
        title="조건판단형태 범위 표"
        rows={rows}
        search={search}
        preferredColumns={preferredColumnsForSetting('parserTypeGuide')}
        datasetId="parserTypeGuide"
        dirtyLabel="조건판단형태 가이드"
        settingKey="parserTypeGuide"
        onSaveSetting={onSaveSetting}
        onDirtyChange={onDirtyChange}
        selectColumnOptions={PARSER_TYPE_GUIDE_OPTIONS}
        multiSelectColumnOptions={PARSER_TYPE_GUIDE_MULTI_OPTIONS}
        columnHelpMap={PARSER_TYPE_GUIDE_HELP}
      />
    </div>
  )
}

function ParserNormalizationView({ search }: { search: string }) {
  const [activeNotice, setActiveNotice] = useState('2026-06694')
  const [result, setResult] = useState<ParserNormalizationResult | null>(null)
  const [activeTab, setActiveTab] = useState('요약')
  const [status, setStatus] = useState('공고번호를 넣고 A3 정규화를 실행하세요.')
  const [loading, setLoading] = useState(false)

  async function runOne(target = activeNotice.trim()) {
    if (!target) {
      setStatus('공고번호가 필요합니다.')
      return
    }
    setLoading(true)
    setStatus(`${target} A3 정규화 중...`)
    try {
      const next = await fetchA3Normalization(target)
      setResult(next)
      setActiveNotice(target)
      setActiveTab('요약')
      setStatus(
        `${target} 정규화 완료: 문단 ${next.normalized.hardBlocks.length.toLocaleString()}개, 섹션 ${next.normalized.sections.length.toLocaleString()}개, 표후보 ${next.normalized.tables.length.toLocaleString()}개`,
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
      setResult(null)
    } finally {
      setLoading(false)
    }
  }

  const summaryRows = result
    ? [
        { 항목: '공고번호', 값: result.공고번호 },
        { 항목: 'HTML 길이', 값: result.htmlLength },
        { 항목: '텍스트 길이', 값: result.textLength },
        { 항목: '원문줄', 값: result.normalized.rawLines.length },
        { 항목: '문단', 값: result.normalized.hardBlocks.length },
        { 항목: '섹션', 값: result.normalized.sections.length },
        { 항목: '표 후보', 값: result.normalized.tables.length },
        { 항목: '이미지', 값: result.normalized.imageCount },
        { 항목: '파싱 컬럼', 값: result.parserSummary.fieldCount },
        { 항목: '근거', 값: result.parserSummary.matchCount },
        { 항목: '경고', 값: result.normalized.warnings.join(' / ') },
      ]
    : []
  const rawLineRows = (result?.normalized.rawLines ?? []).map((원문, index) => ({ 순번: index + 1, 원문 }))
  const softRows = (result?.normalized.softBlocks ?? []).map((원문, index) => ({ 순번: index + 1, 원문 }))
  const fieldRows = result
    ? Object.entries(result.parserSummary.fields ?? {}).map(([컬럼, 값]) => ({
        컬럼,
        값,
        근거수: (result.parserSummary.matches ?? []).filter((match) => match.column === 컬럼).length,
      }))
    : []
  const matchRows = (result?.parserSummary.matches ?? []).map((match, index) => ({
    순번: index + 1,
    컬럼: match.column,
    값: match.value,
    조건판단형태: match.type,
    rule_id: match.ruleId,
    키워드: match.matchedKeyword,
    근거: match.sourceText,
  }))

  return (
    <div className="settings-stack parser-normalization-view">
      <section className="parser-test-panel">
        <div className="parser-normalization-actions">
          <input
            className="parser-notice-input"
            value={activeNotice}
            onChange={(event) => setActiveNotice(event.target.value)}
            placeholder="공고번호"
            aria-label="공고번호"
          />
          <button type="button" onClick={() => runOne()} disabled={loading}>
            <FileCheck2 size={16} />
            선택 공고 정규화
          </button>
          <span className="parser-test-status">{status}</span>
        </div>
      </section>

      <div className="settings-subtabs" role="tablist" aria-label="공고문 정규화 상세">
        {['요약', '번호/섹션', '문단', '원문줄', '표 복원', '파싱 결과', '근거'].map((tab) => (
          <button key={tab} type="button" className={activeTab === tab ? 'active' : ''} onClick={() => setActiveTab(tab)}>
            {tab}
          </button>
        ))}
      </div>

      {activeTab === '요약' ? (
        <SettingsDatasetView title="공고문 정규화 요약" rows={summaryRows} search={search} preferredColumns={['항목', '값']} />
      ) : null}
      {activeTab === '번호/섹션' ? (
        <SettingsDatasetView title="번호/섹션 인식" rows={hideDisplayColumns(result?.normalized.sections ?? [], ['순번'])} search={search} preferredColumns={['대섹션번호', '대섹션제목', '번호', '계층', '섹션분류', '분류근거', '제외여부', '제목', '시작블록', '종료블록', '내용미리보기']} />
      ) : null}
      {activeTab === '표 복원' ? (
        <SettingsDatasetView title="표 후보 복원" rows={hideDisplayColumns(result?.normalized.tables ?? [], ['순번'])} search={search} preferredColumns={['유형', '행수', '열수', '헤더', '첫값행', '경고']} />
      ) : null}
      {activeTab === '문단' ? (
        <SettingsDatasetView title="정규화 문단" rows={hideDisplayColumns(result?.normalized.hardBlocks ?? softRows, ['순번'])} search={search} preferredColumns={['유형', '번호', '계층', '제목', '원문', '길이']} />
      ) : null}
      {activeTab === '원문줄' ? (
        <SettingsDatasetView title="원문 줄" rows={hideDisplayColumns(rawLineRows, ['순번'])} search={search} preferredColumns={['원문']} />
      ) : null}
      {activeTab === '파싱 결과' ? (
        <SettingsDatasetView title="문서곡괭이 파싱 결과" rows={fieldRows} search={search} preferredColumns={['컬럼', '값', '근거수']} />
      ) : null}
      {activeTab === '근거' ? (
        <SettingsDatasetView title="문서곡괭이 파싱 근거" rows={hideDisplayColumns(matchRows, ['순번'])} search={search} preferredColumns={['컬럼', '값', '조건판단형태', 'rule_id', '키워드', '근거']} />
      ) : null}
    </div>
  )
}

function ParsermanTestView({ search, parserRules }: { search: string; parserRules: NoticeRow[] }) {
  const sampleBody = useMemo(() => buildParserSampleBody(parserRules), [parserRules])
  const [gongsanum, setGongsanum] = useState('')
  const [body, setBody] = useState(sampleBody)
  const [result, setResult] = useState<ParserResult | null>(null)
  const [status, setStatus] = useState('샘플 본문을 넣고 테스트를 실행하세요.')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!body.trim() && sampleBody) setBody(sampleBody)
  }, [body, sampleBody])

  async function run(mode: 'body' | 'a3') {
    setLoading(true)
    setStatus(mode === 'a3' ? 'A3 파싱용공고문 호출 중...' : '붙여넣은 본문 파싱 중...')
    try {
      const next = await runParsermanTest(mode === 'a3' ? { gongsanum } : { body, gongsanum: gongsanum || 'SAMPLE' })
      setResult(next)
      setStatus(`문서곡괭이 완료: ${Object.keys(next.fields ?? {}).length.toLocaleString()}개 컬럼, 근거 ${(next.matches ?? []).length.toLocaleString()}건`)
    } catch (error) {
      setResult(null)
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  const fieldRows = result
    ? Object.entries(result.fields ?? {})
        .filter(([key]) => key !== '공고본문')
        .map(([컬럼, 값]) => ({ 컬럼, 값, 근거수: (result.matches ?? []).filter((match) => match.column === 컬럼).length }))
    : []
  const evidenceRows = filterSettingRows(
    (result?.matches ?? []).map((match, index) => ({
      순번: index + 1,
      컬럼: match.column,
      값: match.value,
      조건판단형태: match.type,
      참조마스터: match.settingTable,
      rule_id: match.ruleId,
      matched_keyword: match.matchedKeyword,
      source_text: match.sourceText,
    })),
    search,
  )

  return (
    <div className="settings-stack">
      <section className="parser-test-panel">
        <div className="parser-test-grid">
          <label>
            <span>공고번호</span>
            <input value={gongsanum} onChange={(event) => setGongsanum(event.target.value)} placeholder="예: R26BK01537599-000" />
          </label>
          <label className="parser-body-input">
            <span>본문 테스트</span>
            <textarea value={body} onChange={(event) => setBody(event.target.value)} />
          </label>
        </div>
        <div className="panel-actions">
          <button type="button" onClick={() => run('body')} disabled={loading || !body.trim()}>
            <Play size={16} />
            본문으로 테스트
          </button>
          <button type="button" onClick={() => run('a3')} disabled={loading || !gongsanum.trim()}>
            <FileDown size={16} />
            A3 공고번호 테스트
          </button>
          <span className="parser-test-status">{status}</span>
        </div>
      </section>
      <SettingsDatasetView title="문서곡괭이 결과" rows={fieldRows} search={search} preferredColumns={['컬럼', '값', '근거수']} />
      <SettingsDatasetView
        title="문서곡괭이 근거"
        rows={evidenceRows}
        search={search}
        preferredColumns={['순번', '컬럼', '값', '조건판단형태', '참조마스터', 'rule_id', 'matched_keyword', 'source_text']}
      />
    </div>
  )
}

function buildParserSampleBody(parserRules: NoticeRow[]) {
  return parserRules
    .map((row) => valueToText(row['예시본문']).trim())
    .filter(Boolean)
    .slice(0, 8)
    .join('\n')
}

function ParsermanReport({ settings, search }: { settings: Record<string, NoticeRow[]>; search: string }) {
  const groups = [
    { 구분: '공고확인', rows: settings.noticeTags ?? [] },
    { 구분: '특수실적', rows: settings.specialRecords ?? [] },
    { 구분: '특수실적_공통', rows: settings.specialCommon ?? [] },
  ]
  const rows = groups.map((group) => {
    const autoRows = group.rows.filter((row) => valueToText(row['검색키워드']).trim())
    const manualRows = group.rows.length - autoRows.length
    const duplicated = duplicatedValues(group.rows, '결과값')
    return {
      구분: group.구분,
      전체: group.rows.length,
      자동파싱대상: autoRows.length,
      사람입력대상: manualRows,
      결과값중복: duplicated.length ? duplicated.join(', ') : '',
      상태: duplicated.length ? '중복 확인 필요' : '정상',
      메모: '검색키워드가 비어 있으면 자동 파싱하지 않고 사람이 입력합니다.',
    }
  })
  return <SettingsDatasetView title="문서곡괭이 리포트" rows={rows} search={search} preferredColumns={['구분', '전체', '자동파싱대상', '사람입력대상', '결과값중복', '상태', '메모']} />
}

function duplicatedValues(rows: NoticeRow[], key: string) {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const value = valueToText(row[key]).trim()
    if (!value) continue
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([value]) => value)
}

function SettingsSummary({
  settings,
  rowCounts,
}: {
  settings: Record<string, NoticeRow[]>
  profiles: ServerColumnProfile[]
  rules: StandardColumnRule[]
  rowCounts: { raw: number; pre: number; human: number; final: number }
  search: string
}) {
  const changelog = normalizeChangelogRows(settings.changelog ?? [])
  const recent24h = changelog.filter((row) => isWithinHours(valueToText(row.일시), 24)).length
  const emptyRequired = [
    settings.evaluationCriteria,
    settings.secondaryCriteria,
    settings.noticeTags,
    settings.specialRecords,
    settings.specialCommon,
    settings.jongmokMap,
    settings.agencyCode,
    settings.regionDb,
  ].filter((rows) => !rows?.length).length
  const preprocessPct = rowCounts.raw ? Math.round((rowCounts.pre / rowCounts.raw) * 100) : 0
  return (
    <div className="dashboard-summary">
      <section className="dashboard-today">
        <h2>오늘 상태</h2>
        <p>자동분류 현황과 최근 편집 활동을 한눈에 봅니다.</p>
        <div className="dashboard-card-grid">
          <DashboardCard label="전처리 진행률" value={`${preprocessPct}%`} detail={`${rowCounts.pre.toLocaleString()} / ${rowCounts.raw.toLocaleString()}건`} tone="blue" />
          <DashboardCard label="검수 대기" value={rowCounts.human.toLocaleString()} detail={`공고관리 ${rowCounts.human.toLocaleString()}건`} tone="orange" />
          <DashboardCard label="최근 24h 수정" value={recent24h.toLocaleString()} detail={`전체 변경 ${changelog.length.toLocaleString()}건`} tone="dark" />
          <DashboardCard label="설정 점검" value={emptyRequired.toLocaleString()} detail={emptyRequired ? '비어있는 핵심 설정 있음' : '핵심 설정 로드됨'} tone={emptyRequired ? 'red' : 'green'} />
        </div>
      </section>
      <section className="recent-change-panel">
        <div className="recent-change-head">
          <h2>최근 변경</h2>
          <span>변경로그 기준</span>
        </div>
        <div className="recent-change-list">
          {changelog.slice(0, 8).map((row, index) => (
            <div key={`${row.id}-${index}`} className="recent-change-row">
              <span className="recent-change-time">{shortTime(valueToText(row.일시))}</span>
              <span className={`recent-change-mark ${changeTone(valueToText(row.내용))}`}>{changeMark(valueToText(row.내용))}</span>
              <span className="recent-change-main">
                <strong>{valueToText(row.구분)}</strong>
                <span>{valueToText(row.대상) ? ` · ${valueToText(row.대상)}` : ''}</span>
                <span> — {valueToText(row.내용)}</span>
              </span>
              <span className="recent-change-user">{valueToText(row.사용자) || 'local'}</span>
            </div>
          ))}
          {!changelog.length ? <div className="recent-change-empty">아직 저장된 변경 로그가 없습니다. 설정을 저장하면 여기에 기록됩니다.</div> : null}
        </div>
      </section>
    </div>
  )
}

function DashboardCard({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: 'blue' | 'orange' | 'dark' | 'green' | 'red' }) {
  return (
    <div className={`dashboard-card ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
    </div>
  )
}

function normalizeChangelogRows(rows: NoticeRow[]) {
  return [...rows].sort((a, b) => parseLogTime(valueToText(b.일시)).getTime() - parseLogTime(valueToText(a.일시)).getTime())
}

function parseLogTime(value: string) {
  const normalized = value.trim().replace(/\./g, '-')
  const date = new Date(normalized.includes('T') ? normalized : normalized.replace(' ', 'T'))
  return Number.isNaN(date.getTime()) ? new Date(0) : date
}

function isWithinHours(value: string, hours: number) {
  const time = parseLogTime(value).getTime()
  if (!time) return false
  return Date.now() - time <= hours * 60 * 60 * 1000
}

function shortTime(value: string) {
  const parsed = parseLogTime(value)
  if (!parsed.getTime()) return value || '-'
  return `${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}`
}

function changeMark(content: string) {
  if (content.includes('삭제')) return '×'
  if (content.includes('추가')) return '+'
  return '✎'
}

function changeTone(content: string) {
  if (content.includes('삭제')) return 'delete'
  if (content.includes('추가')) return 'add'
  return 'edit'
}

function SettingsErrorReport({
  settings,
  profiles,
  rules,
  rowCounts,
  search,
}: {
  settings: Record<string, NoticeRow[]>
  profiles: ServerColumnProfile[]
  rules: StandardColumnRule[]
  rowCounts: { raw: number; pre: number; human: number; final: number }
  search: string
}) {
  const rows: NoticeRow[] = [
    { 구분: '송전사업소', 상태: settings.transmissionOffice?.length ? '정상' : '데이터 대기', 설명: '현재 파일은 헤더만 있을 수 있음. 데이터 받으면 지역 설정에서 바로 표시됨.' },
    { 구분: '지역디비', 상태: settings.regionDb?.length ? '정상' : '확인 필요', 설명: settings.regionDb?.length ? `${settings.regionDb.length}개 행정지역 row 로드됨. 지역 설정 > 행정지역 탭에서 확인.` : '지역디비.csv 연결 필요.' },
    { 구분: '발전소지역', 상태: '파일 대기', 설명: '발전소지역 파일이 오면 지역 설정 하위 표로 추가.' },
    { 구분: '표준 컬럼 룰', 상태: rules.length ? '정상' : '확인 필요', 설명: `${rules.length}개 로드` },
    { 구분: '서버 컬럼 형식', 상태: profiles.length ? '정상' : '확인 필요', 설명: `${profiles.length}개 로드` },
    { 구분: '현재 row', 상태: rowCounts.raw ? '수집됨' : '미수집', 설명: `원본 ${rowCounts.raw} / 전처리 ${rowCounts.pre} / 공고관리 ${rowCounts.human} / 최종 ${rowCounts.final}` },
  ]
  return <SettingsDatasetView title="오류 리포트" rows={rows} search={search} preferredColumns={['구분', '상태', '설명']} />
}

function filterSettingRows(rows: NoticeRow[], search: string) {
  const needle = search.trim().toLowerCase()
  if (!needle) return rows
  return rows.filter((row) => Object.values(row).some((value) => valueToText(value).toLowerCase().includes(needle)))
}

function hideDisplayColumns(rows: NoticeRow[], hiddenColumns: string[]) {
  if (!hiddenColumns.length) return rows
  const hidden = new Set(hiddenColumns)
  return rows.map((row) => {
    const next: NoticeRow = {}
    for (const [key, value] of Object.entries(row)) {
      if (!hidden.has(key)) next[key] = value
    }
    return next
  })
}

function columnsForRows(rows: NoticeRow[], preferredColumns: string[]) {
  const all = Array.from(new Set(rows.slice(0, 100).flatMap((row) => Object.keys(row))))
  const front = preferredColumns.filter((col) => all.includes(col))
  const rest = all.filter((col) => !front.includes(col))
  return [...front, ...rest]
}

function defaultColumnWidth(col: string) {
  if (col === 'id' || col === '순번' || col === 'row수') return 76
  if (col.includes('공고번호') || col.includes('입력일') || col.includes('시행일')) return 150
  if (col.includes('원본') || col.includes('참조') || col.includes('검색키워드') || col.includes('제외키워드')) return 260
  if (col.includes('메모') || col.includes('설명') || col.includes('예시')) return 300
  return 150
}

function normalizeSortValue(value: unknown) {
  const raw = valueToText(value).trim()
  if (!raw) return { empty: true, text: '', number: null as number | null }
  const numericText = raw.replace(/[,\s원%]/g, '')
  const numeric = /^-?\d+(\.\d+)?$/.test(numericText) ? Number(numericText) : null
  return { empty: false, text: raw, number: Number.isFinite(numeric) ? numeric : null }
}

const sortCollator = new Intl.Collator('ko-KR', { numeric: true, sensitivity: 'base' })
const MIN_COLUMN_WIDTH = 12
const MAX_COLUMN_WIDTH = 720

const COLUMN_LABELS: Record<string, string> = {
  선택목록: '컬럼입력목록',
}

const COLUMN_HELP: Record<string, string> = {
  항목: '최종 공고분류 엑셀과 화면에서 사용하는 표준 컬럼명입니다.',
  표시형식: '값을 날짜, 금액, 숫자, 텍스트처럼 어떤 형식으로 보여줄지 정합니다.',
  처리방법: '계산, 수집, 둘다, 공란 중 하나입니다. 수집은 서버공고/문서곡괭이 수집값, 계산은 참조방법 코드로 값을 만듭니다.',
  우선순위: '같은 컬럼에 서버정보와 문서곡괭이 정보가 함께 있을 때 어떤 출처를 최종값으로 쓸지 정합니다.',
  참조방법: '처리방법이 계산 또는 둘다일 때 사용하는 코드형 규칙입니다. 참조메모를 기준으로 작성합니다.',
  참조메모: '참조방법 코드가 무엇을 계산하거나 조회하는지 사람이 이해할 수 있게 적어둡니다.',
  선택목록: '컬럼 입력 시 사용할 목록입니다. 상세 화면과 표 편집 드롭다운/검증 기준으로 씁니다.',
  '공고관리 표시': '공고관리 표에서 이 컬럼을 숨길지 조정하는 체크박스입니다.',
  상세정보입력: '상세정보 입력 화면에서 이 컬럼을 숨길지 조정하는 체크박스입니다.',
  서버공고일치: '서버공고 원본 컬럼과 표준 컬럼 비교 검증에 쓰던 메타입니다. 기본 운영 화면에서는 숨겨둡니다.',
  확정메모: '컬럼 규칙 확정 과정에서 남긴 메모입니다. 기본 운영 화면에서는 숨겨둡니다.',
  id: '행 식별자입니다.',
  '원본 (등록증 표기)': '공고문/API/등록증에 실제로 나타나는 종목 원문입니다. 이 값을 찾아 표준 종목으로 바꿉니다.',
  일반_기타_전문: '종목의 건설유형입니다. 적격심사 1차 기준표에서 일반건설/전문건설/기타건설 금액 칸을 고르는 기준입니다.',
  세부유형: '표준 종목인지, 운영 중 추가한 확장 표현인지 구분합니다.',
  업종: '업무상 표준 종목입니다. 전문건설이면 대업종이 들어갈 수 있습니다.',
  주력업종: '전문건설의 주력종목입니다. 업종과 같으면 주력종목 없음으로 보고 단독평가종목은 업종만 씁니다.',
  상위업종: '상위종목입니다. 예: 건축/토목의 상위종목은 토건, 기계소방/전기소방의 상위종목은 전문소방입니다.',
  대체업종: '참여 가능 면허 매칭에서 함께 인정할 대체종목입니다. 심사용 단독평가종목은 원 종목 기준을 유지합니다.',
  상호진출_상대종목: '상호진출 허용 시 이 종목과 연결 가능한 상대 종목 목록입니다. 콤마로 구분합니다. 예: 실내건축,금속창호지붕',
  단독평가_제외: '1이면 표시용 종목에는 나올 수 있지만 단독평가종목에는 넣지 않습니다. 예: 토건',
  길이: '원본 문자열 길이입니다. 긴 원문을 먼저 매칭하기 위한 정렬/충돌 방지 기준입니다.',
}

const CHECKBOX_COLUMNS = new Set(['공고관리 표시', '상세정보입력'])
const STANDARD_COLUMNS_DEFAULT_HIDDEN = new Set(['서버공고일치', '확정메모'])
const SETTINGS_DEFAULT_HIDDEN_COLUMNS = new Set(['id', 'ID'])
const SELECT_COLUMN_OPTIONS: Record<string, string[]> = {
  처리방법: ['', '계산', '수집', '둘다'],
  우선순위: ['', '서버정보', '문서곡괭이'],
}

const PARSER_TYPE_GUIDE_OPTIONS: Record<string, string[]> = {
  출력: ['', '날짜', '정수 원', '전화번호', 'N%', '텍스트', '매칭 텍스트', '문단 텍스트', '고정값', '매칭 키워드 또는 별칭 라벨', '종목 배열', '지역 배열', '제어용', '정수 원 또는 표 값', '결과값 목록'],
  정규화범위: ['', '원문줄', '문단', '표', '대섹션', '전체본문', '문단, 표', '문단, 대섹션', '대섹션, 문단', '대섹션, 전체본문'],
  fallback범위: ['', '없음', '같은 문단', '같은 대섹션', '같은 대섹션 -> 전체본문', '표 -> 같은 대섹션 -> 전체본문', '전체본문'],
  제외검사범위: ['', '같은 문단', '같은 표', '같은 대섹션', '전체본문', '같은 문단 또는 같은 표', '같은 문단 또는 같은 대섹션', '매칭 구간 포함 같은 문단', '매칭 문단 또는 같은 대섹션'],
  근거저장단위: ['', '매칭 원문줄', '매칭 문단', '매칭 문단 목록', '매칭 문단/표 셀', '문단 또는 대섹션', '표번호+행열', '종료점 위치'],
  토글비고: ['', '이 타입은 코드 정책이 고정되어 개별 토글을 사용하지 않습니다.', '이 타입은 의도적 부분매칭이라 개별 정책 토글을 사용하지 않습니다.'],
}

const PARSER_TYPE_GUIDE_MULTI_OPTIONS: Record<string, string[]> = {
  키워드매칭방식: ['키워드일치', '키워드포함', '키워드 앞뒤 와일드카드', '조사 포함 허용', '별칭후보', '헤더·라벨 매칭', '마스터 교집합', '지역마스터 교집합'],
  우선섹션분류: ['입찰일정', '금액정보', '문의처', '공동계약', '입찰참가자격', '낙찰방법', '계약방식', '지역제한', '안전보건', '기타사항'],
  영향정책: ['공백 무시', '단어 경계', '단어 경계 강제 OFF', 'exclude', '다중 블록', '정책 미적용', '정규화 매치', '와일드카드', '사전 필터'],
}

const PARSER_TYPE_GUIDE_HELP: Record<string, string> = {
  조건판단형태: '문서곡괭이 매처 타입 코드입니다. 예: 1_2는 키워드 다음 금액을 찾고, 6_1은 표에서 라벨-값을 찾습니다.',
  이름: '운영자가 이해하기 쉬운 조건판단형태 이름입니다. 짧고 구분 가능하게 적습니다.',
  용도: '이 타입을 어떤 컬럼/상황에 쓰는지 설명합니다.',
  출력: '이 타입이 최종적으로 반환하는 값의 형태입니다.',
  정규화범위: '문서 정규화 결과 중 어디를 우선 검색할지 정합니다. 예: 문단, 대섹션, 표.',
  키워드매칭방식: '검색키워드를 인정하는 방식입니다. 명확한 값은 일치 우선, 흔들리는 표현은 포함/와일드카드를 씁니다.',
  우선섹션분류: '섹션설정으로 분류된 공고문 섹션 중 먼저 볼 범위입니다. 비우면 특정 섹션으로 좁히지 않습니다.',
  fallback범위: '우선 범위에서 못 찾았을 때 검색 범위를 어디까지 넓힐지 정합니다.',
  제외검사범위: '검색키워드를 찾은 뒤 제외키워드를 비교할 원문 범위입니다.',
  근거저장단위: '검수 화면에 저장하고 보여줄 원문 근거 단위입니다.',
  판단로직: '문서곡괭이가 이 타입을 실행하는 순서입니다. 여러 단계는 | 로 구분합니다.',
  영향정책: '공백 무시, 단어 경계, exclude 같은 매칭 정책 중 이 타입에 영향을 주는 항목입니다.',
  예시본문: '이 조건판단형태를 검증할 수 있는 짧은 예시 본문입니다.',
  결과예시: '예시본문에서 기대하는 추출 결과입니다.',
  주의: '오탐, 누락, 제외키워드 필요성 등 운영자가 알아야 할 함정입니다.',
  토글비고: '정책 토글을 쓸 수 없는 타입이거나 별도 주의가 있을 때 적습니다.',
}

function displayColumnName(col: string) {
  return COLUMN_LABELS[col] ?? col
}

function columnHelp(col: string) {
  return COLUMN_HELP[col] ?? `${displayColumnName(col)} 기준으로 정렬합니다.`
}

function isCheckedValue(value: unknown) {
  const text = valueToText(value).trim().toLowerCase()
  return ['1', 'true', 't', 'y', 'yes', 'checked', '체크'].includes(text)
}

function RulesView({
  profiles,
  rules,
  selectedRuleItem,
  setSelectedRuleItem,
  ruleDraft,
  setRuleDraft,
  onSave,
  onAdd,
  onDelete,
}: {
  profiles: ServerColumnProfile[]
  rules: StandardColumnRule[]
  selectedRuleItem: string
  setSelectedRuleItem: (value: string) => void
  ruleDraft: Record<string, string>
  setRuleDraft: (value: Record<string, string>) => void
  onSave: () => void
  onAdd: () => void
  onDelete: () => void
}) {
  const profileColumns = ['순번', '항목', '추정입력형식', '권장표시형식', '빈값비율', '예시값']
  const ruleColumns = ['id', '항목', '표시형식', '처리방법', '우선순위', '참조방법', '참조메모', '선택목록', '공고관리 표시', '상세정보입력']
  const editFields = [
    'id',
    '항목',
    '표시형식',
    '처리방법',
    '우선순위',
    '참조방법',
    '참조메모',
    '선택목록',
    '공고관리 표시',
    '상세정보입력',
  ]
  return (
    <div className="split-view">
      <section className="editor-panel">
        <div className="section-head">
          <div>
            <h2>표준 컬럼 룰 편집</h2>
            <span>처리방법, 우선순위, 참조메모를 여기서 바로 수정</span>
          </div>
          <div className="panel-actions">
            <button className="inline-action" type="button" onClick={onAdd}>
              <Play size={16} />
              행 추가
            </button>
            <button className="inline-action" type="button" onClick={onSave}>
              <Save size={16} />
              저장
            </button>
            <button className="inline-action danger" type="button" onClick={onDelete}>
              <AlertTriangle size={16} />
              삭제
            </button>
          </div>
        </div>
        <div className="editor-grid">
          <label className="wide-field">
            <span>항목 선택</span>
            <select value={selectedRuleItem} onChange={(event) => setSelectedRuleItem(event.target.value)}>
              {rules.map((rule) => (
                <option key={rule.항목} value={rule.항목}>
                  {rule.항목}
                </option>
              ))}
            </select>
          </label>
          {editFields.map((field) => (
            <label key={field} className={field === '참조방법' || field === '참조메모' || field === '선택목록' ? 'wide-field' : ''}>
              <span title={columnHelp(field)}>{displayColumnName(field)}</span>
              {field === '참조방법' || field === '참조메모' || field === '선택목록' ? (
                <textarea
                  value={ruleDraft[field] ?? ''}
                  onChange={(event) => setRuleDraft({ ...ruleDraft, [field]: event.target.value })}
                />
              ) : (
                <input
                  value={ruleDraft[field] ?? ''}
                  onChange={(event) => setRuleDraft({ ...ruleDraft, [field]: event.target.value })}
                />
              )}
            </label>
          ))}
        </div>
      </section>
      <section className="table-section">
        <div className="section-head">
          <div>
            <h2>서버공고 컬럼 형식</h2>
            <span>{profiles.length}개</span>
          </div>
        </div>
        <DataTable columns={profileColumns} rows={profiles} emptyText="컬럼 형식 파일이 없습니다." />
      </section>
      <section className="table-section">
        <div className="section-head">
          <div>
            <h2>표준 컬럼 룰</h2>
            <span>{rules.length}개</span>
          </div>
        </div>
        <DataTable columns={ruleColumns} rows={rules} emptyText="표준 컬럼 룰 파일이 없습니다." />
      </section>
    </div>
  )
}

function OutputView({
  columns,
  rows,
  filteredCount,
  onExport,
  onFinalize,
  onRowOpen,
}: {
  columns: string[]
  rows: NoticeRow[]
  filteredCount: number
  onExport: () => void
  onFinalize: () => void
  onRowOpen: (row: NoticeRow) => void
}) {
  const ok = rows.filter((row) => valueToText(row['검증상태']) === '정상').length
  const review = rows.filter((row) => valueToText(row['검증상태']) === '확인필요').length
  const errors = rows.filter((row) => valueToText(row['검증상태']) === '오류').length
  return (
    <>
      <section className="output-panel">
        <div className="output-summary">
          <FileSpreadsheet size={34} />
          <div>
            <h2>최종 엑셀 출력</h2>
            <p>
              {filteredCount.toLocaleString()}행 · {columns.length.toLocaleString()}컬럼
            </p>
          </div>
        </div>
        <div className="panel-actions">
          <button type="button" onClick={onFinalize} disabled={!rows.length}>
            <FileCheck2 size={16} />
            최종검증
          </button>
          <button type="button" onClick={onExport} disabled={!rows.length}>
            <Download size={16} />
            현재 결과 출력
          </button>
        </div>
      </section>
      <section className="metrics output-metrics">
        <Metric label="정상" value={ok.toLocaleString()} />
        <Metric label="확인필요" value={review.toLocaleString()} />
        <Metric label="오류" value={errors.toLocaleString()} />
        <Metric label="출력행" value={rows.length.toLocaleString()} />
        <Metric label="출력컬럼" value={columns.length.toLocaleString()} />
      </section>
      <section className="table-section">
        <div className="section-head">
          <div>
            <h2>최종분류 결과</h2>
            <span>검증상태와 검증메모를 앞쪽에서 확인</span>
          </div>
        </div>
        <DataTable columns={columns} rows={rows.slice(0, 200)} emptyText="최종분류를 실행하세요." onRowClick={onRowOpen} />
      </section>
    </>
  )
}

const tableColumnWidthCache = new Map<string, Record<string, number>>()

function loadColumnWidthCache(key: string) {
  const cached = tableColumnWidthCache.get(key)
  if (cached) return cached
  try {
    if (typeof window === 'undefined' || !window.localStorage) return {}
    const raw = window.localStorage.getItem(key)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed ? parsed : {}
  } catch {
    return {}
  }
}

function saveColumnWidthCache(key: string, widths: Record<string, number>) {
  tableColumnWidthCache.set(key, widths)
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(key, JSON.stringify(widths))
    }
  } catch {
    // 일부 브라우저 검증 환경은 storage 접근을 막는다. 세션 캐시는 계속 유지한다.
  }
}

function DataTable({
  columns,
  rows,
  emptyText,
  tableId,
  onRowClick,
  editable = false,
  standardColumnMode = false,
  selectColumnOptions = {},
  multiSelectColumnOptions = {},
  columnHelpMap = {},
  onCellChange,
  rowClassName,
}: {
  columns: string[]
  rows: NoticeRow[]
  emptyText: string
  tableId?: string
  onRowClick?: (row: NoticeRow) => void
  editable?: boolean
  standardColumnMode?: boolean
  selectColumnOptions?: Record<string, string[]>
  multiSelectColumnOptions?: Record<string, string[]>
  columnHelpMap?: Record<string, string>
  onCellChange?: (row: NoticeRow, col: string, value: string) => void
  rowClassName?: (row: NoticeRow) => string
}) {
  const widthStorageKey = useMemo(
    () => `lastgonggo.columnWidths.${tableId || columns.join('|')}`,
    [columns, tableId],
  )
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({})
  const [sortState, setSortState] = useState<{ col: string; dir: 'asc' | 'desc' } | null>(null)
  const [openMultiCell, setOpenMultiCell] = useState<string | null>(null)

  useEffect(() => {
    setColumnWidths(loadColumnWidthCache(widthStorageKey))
  }, [widthStorageKey])

  const sortedRows = useMemo(() => {
    if (!sortState) return rows
    return rows
      .map((row, index) => ({ row, index }))
      .sort((left, right) => {
        const a = normalizeSortValue(left.row[sortState.col])
        const b = normalizeSortValue(right.row[sortState.col])
        if (a.empty && b.empty) return left.index - right.index
        if (a.empty) return 1
        if (b.empty) return -1
        const base =
          a.number !== null && b.number !== null
            ? a.number - b.number
            : sortCollator.compare(a.text, b.text)
        if (base === 0) return left.index - right.index
        return sortState.dir === 'asc' ? base : -base
      })
      .map((item) => item.row)
  }, [rows, sortState])

  function toggleSort(col: string) {
    setSortState((prev) => {
      if (!prev || prev.col !== col) return { col, dir: 'asc' }
      if (prev.dir === 'asc') return { col, dir: 'desc' }
      return null
    })
  }

  function columnWidth(col: string) {
    return columnWidths[col] ?? defaultColumnWidth(col)
  }

  function columnStyle(col: string) {
    const width = columnWidth(col)
    return { width, minWidth: width, maxWidth: width }
  }

  function helpForColumn(col: string) {
    return columnHelpMap[col] ?? columnHelp(col)
  }

  function optionsForColumn(col: string) {
    return selectColumnOptions[col] ?? (standardColumnMode ? SELECT_COLUMN_OPTIONS[col] : undefined)
  }

  function multiOptionsForColumn(col: string) {
    return multiSelectColumnOptions[col]
  }

  function multiValueParts(value: unknown) {
    return valueToText(value)
      .split(/[\/|,]/)
      .map((item) => item.trim())
      .filter(Boolean)
  }

  function toggleMultiValue(row: NoticeRow, col: string, option: string) {
    const current = multiValueParts(row[col])
    const exists = current.includes(option)
    const next = exists ? current.filter((item) => item !== option) : [...current, option]
    onCellChange?.(row, col, next.join('/'))
  }

  function startColumnResize(event: ReactMouseEvent<HTMLSpanElement>, col: string) {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startWidth = columnWidth(col)

    document.body.classList.add('col-resizing')

    const handleMove = (moveEvent: MouseEvent) => {
      const nextWidth = Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, startWidth + moveEvent.clientX - startX))
      setColumnWidths((prev) => {
        const next = { ...prev, [col]: nextWidth }
        saveColumnWidthCache(widthStorageKey, next)
        return next
      })
    }

    const stopResize = () => {
      document.body.classList.remove('col-resizing')
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', stopResize)
    }

    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', stopResize)
  }

  if (!rows.length || !columns.length) {
    return <div className="empty-state">{emptyText}</div>
  }
  return (
    <div className="table-frame">
      <div className="table-wrap">
        <table>
          <colgroup>
            {columns.map((col) => (
              <col key={col} style={{ width: columnWidth(col) }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {columns.map((col, colIndex) => {
                const activeSort = sortState?.col === col ? sortState.dir : null
                return (
                <th
                  key={col}
                  className={[
                    colIndex === 0 ? 'sticky-col' : '',
                    'resizable-th',
                    activeSort ? `sorted-${activeSort}` : '',
                  ].join(' ')}
                  style={columnStyle(col)}
                  aria-sort={activeSort === 'asc' ? 'ascending' : activeSort === 'desc' ? 'descending' : 'none'}
                >
                  <button className="th-sort-button" type="button" onClick={() => toggleSort(col)} title={helpForColumn(col)}>
                    <span className="th-label">{standardColumnMode ? displayColumnName(col) : col}</span>
                    <span className="sort-indicator" aria-hidden="true">
                      {activeSort === 'asc' ? '▲' : activeSort === 'desc' ? '▼' : ''}
                    </span>
                  </button>
                  <span
                    className="col-resizer"
                    onMouseDown={(event) => startColumnResize(event, col)}
                    title="드래그해서 열 너비 조정"
                  />
                </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row, rowIndex) => (
              <tr
                key={`${valueToText(row['공고번호'])}-${rowIndex}`}
                className={[onRowClick ? 'clickable-row' : '', rowClassName?.(row) ?? ''].join(' ')}
                onClick={() => onRowClick?.(row)}
              >
                {columns.map((col, colIndex) => {
                  const multiOptions = multiOptionsForColumn(col)
                  const cellKey = `${row.__settingsIndex ?? rowIndex}:${col}`
                  const selectedMultiValues = multiOptions ? multiValueParts(row[col]) : []
                  return (
                  <td
                    key={col}
                    className={[
                    colIndex === 0 ? 'sticky-col' : '',
                    multiOptions ? 'multi-cell' : '',
                    valueToText(row[col]).trim() === '' ? 'empty-cell' : '',
                    col === '검증상태' ? `status-${valueToText(row[col])}` : '',
                  ].join(' ')}
                  style={columnStyle(col)}
                  title={valueToText(row[col])}
                >
                    {editable && standardColumnMode && CHECKBOX_COLUMNS.has(col) ? (
                      <label className="cell-checkbox" onClick={(event) => event.stopPropagation()} title={helpForColumn(col)}>
                        <input
                          type="checkbox"
                          checked={isCheckedValue(row[col])}
                          onChange={(event) => onCellChange?.(row, col, event.target.checked ? '1' : '')}
                        />
                      </label>
                    ) : editable && multiOptions ? (
                      <div className="cell-multi-select" onClick={(event) => event.stopPropagation()}>
                        <button
                          type="button"
                          className="cell-multi-button"
                          title={valueToText(row[col]) || helpForColumn(col)}
                          onClick={() => setOpenMultiCell((current) => (current === cellKey ? null : cellKey))}
                        >
                          {valueToText(row[col]) || '(빈값)'}
                        </button>
                        {openMultiCell === cellKey ? (
                          <div className="cell-multi-popover">
                            {multiOptions.map((option) => (
                              <label key={option}>
                                <input
                                  type="checkbox"
                                  checked={selectedMultiValues.includes(option)}
                                  onChange={() => toggleMultiValue(row, col, option)}
                                />
                                <span>{option}</span>
                              </label>
                            ))}
                            <div className="cell-multi-actions">
                              <button type="button" onClick={() => onCellChange?.(row, col, '')}>비우기</button>
                              <button type="button" onClick={() => setOpenMultiCell(null)}>닫기</button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ) : editable && optionsForColumn(col) ? (
                      <select
                        className="cell-select"
                        value={valueToText(row[col])}
                        title={valueToText(row[col])}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => onCellChange?.(row, col, event.target.value)}
                      >
                        {optionsForColumn(col)!.map((option) => (
                          <option key={option} value={option}>
                            {option || '(빈값)'}
                          </option>
                        ))}
                      </select>
                    ) : editable ? (
                      <textarea
                        className="cell-editor"
                        value={valueToText(row[col])}
                        title={valueToText(row[col])}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => onCellChange?.(row, col, event.target.value)}
                        rows={2}
                      />
                    ) : (
                      <span className="cell-text">{valueToText(row[col])}</span>
                    )}
                  </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function NoticeDetailModal({
  row,
  columns,
  onClose,
}: {
  row: NoticeRow
  columns: string[]
  onClose: () => void
}) {
  const [activeTab, setActiveTab] = useState('추가')
  const [activeLeftTab, setActiveLeftTab] = useState('공고문')
  const [docSearch, setDocSearch] = useState('')
  const [activeHighlight, setActiveHighlight] = useState('')
  const [attachments, setAttachments] = useState<NoticeRow[]>([])
  const [attachmentStatus, setAttachmentStatus] = useState('')
  const [fileTabs, setFileTabs] = useState<Array<{ name: string; url: string; ext: string }>>([])
  const [qualificationRows, setQualificationRows] = useState<NoticeRow[]>([])
  const [qualificationStatus, setQualificationStatus] = useState('')
  const tabs = ['추가', '종목', '기본', '기타', '첨부', '적격심사기준']
  const detailKey = valueToText(row['적격평가기준_세부'])
  const constructionType = valueToText(row['일반_기타_전문']) || '일반건설'
  const gongsanum = valueToText(row['공고번호'])
  const regionIssues = getRegionIssues(row)
  const docText = buildDetailDocText(row)
  const highlightQuery = docSearch.trim() || activeHighlight.trim()
  const highlightCount = highlightQuery ? countMatches(docText, highlightQuery) : 0

  useEffect(() => {
    let alive = true
    if (activeTab !== '적격심사기준' || !detailKey) return
    setQualificationStatus('적격심사세부기준 불러오는 중')
    fetchQualification(detailKey, constructionType)
      .then((rows) => {
        if (!alive) return
        setQualificationRows(Array.isArray(rows) ? rows : [])
        setQualificationStatus(`A4 ${rows.length.toLocaleString()}행 로드`)
      })
      .catch((error) => {
        if (!alive) return
        setQualificationRows([])
        setQualificationStatus(error instanceof Error ? error.message : String(error))
      })
    return () => {
      alive = false
    }
  }, [activeTab, constructionType, detailKey])

  useEffect(() => {
    let alive = true
    if (activeTab !== '첨부') return
    const cached = parseAttachmentRows(row)
    if (cached.length) {
      setAttachments(cached)
      setAttachmentStatus(`row 첨부 ${cached.length.toLocaleString()}건`)
      return
    }
    if (!gongsanum) {
      setAttachments([])
      setAttachmentStatus('공고번호 없음')
      return
    }
    setAttachmentStatus('첨부파일 목록 로딩 중')
    fetchBidFiles(gongsanum)
      .then((rows) => {
        if (!alive) return
        setAttachments(rows)
        setAttachmentStatus(rows.length ? `A2 첨부 ${rows.length.toLocaleString()}건` : '첨부파일 없음')
      })
      .catch((error) => {
        if (!alive) return
        setAttachments([])
        setAttachmentStatus(error instanceof Error ? error.message : String(error))
      })
    return () => {
      alive = false
    }
  }, [activeTab, gongsanum, row])

  const columnSet = new Set(columns)
  const fieldGroups: Record<string, string[]> = {
    추가: ['공사현장', '협정상세', '특수조건', '공고확인', '공고확인_내용', '특수실적', '특수실적_공통', '특수실적_내용'],
    종목: ['종목', '전문건설_주력분야', '단독평가종목', '종목세부JSON', '일반_기타_전문', '종목_모두보유'],
    기본: ['공고번호', '공사명', '발주처', '입력일', '입찰방식', '지역제한', '기초금액', '추정가격', '추정금액', 'A값'],
    기타: columns.filter((col) => !col.startsWith('_')).slice(0, 80),
    첨부: ['공고번호', '첨부파일', '파싱용공고문', '웹용공고문'],
    적격심사기준: ['적격발주처', '원발주처', '적격평가기준_세부', '적격_1차상태', '적격_1차사유', '적격_2차상태', '적격_처치방법'],
  }
  const visibleFields = (fieldGroups[activeTab] ?? [])
    .filter((field, index, list) => list.indexOf(field) === index)
    .filter((field) => columnSet.has(field) || valueToText(row[field]))
  const allFilled = columns.filter((col) => valueToText(row[col]).trim() !== '').length

  return (
    <div className="detail-modal" role="dialog" aria-modal="true" aria-label="공고 상세">
      <div className="detail-modal__body">
        <section className="detail-left">
          <header className="detail-header">
            <div>
              <strong>{valueToText(row['공고번호']) || '공고번호 없음'}</strong>
              <h2>{valueToText(row['공사명']) || '공사명 없음'}</h2>
              <p>
                {valueToText(row['발주처']) || '발주처 없음'} · {valueToText(row['입력일']) || '입력일 없음'}
              </p>
            </div>
            <button type="button" onClick={onClose} aria-label="닫기">
              <X size={17} />
            </button>
          </header>

          <div className="detail-left__tabbar">
            <button className={activeLeftTab === '공고문' ? 'active' : ''} type="button" onClick={() => setActiveLeftTab('공고문')}>
              공고문
            </button>
            {fileTabs.map((file) => (
              <button key={file.name} className={activeLeftTab === file.name ? 'active' : ''} type="button" onClick={() => setActiveLeftTab(file.name)} title={file.name}>
                {file.ext || 'FILE'} {file.name}
              </button>
            ))}
            <label className="detail-doc-search">
              <Search size={14} />
              <input value={docSearch} onChange={(event) => setDocSearch(event.target.value)} placeholder="공고문 검색" />
              <span>{highlightQuery ? `${highlightCount}` : '0'}</span>
            </label>
          </div>

          <div className="detail-doc">
            {activeLeftTab !== '공고문' ? (
              <FilePreviewTab file={fileTabs.find((file) => file.name === activeLeftTab)} />
            ) : highlightQuery ? (
              <HighlightedDocument text={docText} query={highlightQuery} />
            ) : valueToText(row['공고본문_HTML']) ? (
              <div className="notice-html" dangerouslySetInnerHTML={{ __html: valueToText(row['공고본문_HTML']) }} />
            ) : (
              <>
                <div className="doc-placeholder">
                  <FileSpreadsheet size={30} />
                  <strong>A3 파싱용공고문 영역</strong>
                  <span>A3 HTML이 없는 공고는 문서곡괭이 텍스트 미리보기를 먼저 보여줍니다.</span>
                </div>
                <dl>
                  <div>
                    <dt>공고본문</dt>
                    <dd>{valueToText(row['공고본문']) || 'A3 문서곡괭이 실행 후 본문 미리보기가 표시됩니다.'}</dd>
                  </div>
                  <div>
                    <dt>참가자격</dt>
                    <dd>{valueToText(row['참가자격']) || '아직 수집/파싱된 값 없음'}</dd>
                  </div>
                  <div>
                    <dt>지역제한</dt>
                    <dd>{valueToText(row['지역제한']) || '빈값'}</dd>
                  </div>
                  <div>
                    <dt>종목</dt>
                    <dd>{valueToText(row['종목']) || '빈값'}</dd>
                  </div>
                </dl>
              </>
            )}
          </div>
        </section>

        <section className="detail-right">
          <div className="detail-right__summary">
            <span>채워진 컬럼 {allFilled.toLocaleString()}</span>
            <span>전체 컬럼 {columns.length.toLocaleString()}</span>
          </div>
          <div className="detail-right__tabs">
            {tabs.map((tabName) => (
              <button
                key={tabName}
                className={activeTab === tabName ? 'active' : ''}
                type="button"
                onClick={() => setActiveTab(tabName)}
              >
                {tabName}
              </button>
            ))}
          </div>
          <div className="detail-right__content">
            {regionIssues.length ? <RegionIssueBanner issues={regionIssues} /> : null}
            {activeTab === '첨부' ? (
              <AttachmentPanel
                status={attachmentStatus}
                files={attachments}
                onOpen={(file) => {
                  const next = {
                    name: valueToText(file['파일명']) || valueToText(file.name) || '첨부파일',
                    url: valueToText(file.URL) || valueToText(file.url),
                    ext: attachmentExt(valueToText(file['파일명']) || valueToText(file.URL)),
                  }
                  setFileTabs((prev) => (prev.some((item) => item.name === next.name) ? prev : [...prev, next]))
                  setActiveLeftTab(next.name)
                }}
              />
            ) : visibleFields.map((field) => (
              <label key={field} className={detailFieldClass(row, field, regionIssues)}>
                <span>{field}</span>
                <textarea
                  value={valueToText(row[field])}
                  readOnly
                  onFocus={() => {
                    setActiveLeftTab('공고문')
                    setActiveHighlight(valueToText(row[field]) || field)
                  }}
                />
              </label>
            ))}
            {activeTab === '적격심사기준' ? (
              <QualificationPanel detailKey={detailKey} status={qualificationStatus} rows={qualificationRows} />
            ) : null}
            {activeTab !== '첨부' && !visibleFields.length ? <div className="detail-empty">이 탭에 표시할 값이 아직 없습니다.</div> : null}
          </div>
        </section>
      </div>
    </div>
  )
}

function getRegionIssues(row: NoticeRow) {
  const checks = [
    { field: '지역제한', status: '지역제한_매핑상태' },
    { field: '공사현장', status: '공사현장_매핑상태' },
    { field: '검색용현장', status: '검색용현장_매핑상태' },
  ]
  return checks
    .map((item) => ({
      field: item.field,
      value: valueToText(row[item.field]),
      status: valueToText(row[item.status]),
    }))
    .filter((item) => item.status.includes('확인필요') || item.status.includes('후보') || (!item.value && item.field !== '검색용현장'))
}

function detailFieldClass(row: NoticeRow, field: string, regionIssues: Array<{ field: string }>) {
  const classes = ['detail-field']
  if (valueToText(row[field]).trim() === '') classes.push('empty')
  if (regionIssues.some((issue) => issue.field === field)) classes.push('needs-region-review')
  return classes.join(' ')
}

function RegionIssueBanner({ issues }: { issues: Array<{ field: string; value: string; status: string }> }) {
  return (
    <div className="region-issue-banner">
      <strong>지역 매핑 검토필요</strong>
      {issues.map((issue) => (
        <span key={issue.field}>
          {issue.field}: {issue.value || '빈값'} {issue.status ? `(${issue.status})` : ''}
        </span>
      ))}
    </div>
  )
}

function buildDetailDocText(row: NoticeRow) {
  const htmlText = stripHtml(valueToText(row['공고본문_HTML']))
  return [
    htmlText,
    valueToText(row['공고본문']),
    valueToText(row['참가자격']),
    valueToText(row['공고확인_내용']),
    valueToText(row['특수실적_내용']),
    valueToText(row['공사명']),
    valueToText(row['지역제한']),
    valueToText(row['종목']),
  ]
    .filter(Boolean)
    .join('\n\n')
}

function stripHtml(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function HighlightedDocument({ text, query }: { text: string; query: string }) {
  const parts = splitHighlightParts(text || '공고문 텍스트가 없습니다.', query)
  return (
    <div className="notice-text-highlight">
      {parts.map((part, index) =>
        part.hit ? <mark key={`${part.text}-${index}`}>{part.text}</mark> : <span key={`${part.text}-${index}`}>{part.text}</span>,
      )}
    </div>
  )
}

function splitHighlightParts(text: string, query: string) {
  const needle = query.trim()
  if (!needle) return [{ text, hit: false }]
  const source = text || ''
  const lower = source.toLowerCase()
  const target = needle.toLowerCase()
  const parts: Array<{ text: string; hit: boolean }> = []
  let cursor = 0
  let index = lower.indexOf(target)
  while (index >= 0) {
    if (index > cursor) parts.push({ text: source.slice(cursor, index), hit: false })
    parts.push({ text: source.slice(index, index + needle.length), hit: true })
    cursor = index + needle.length
    index = lower.indexOf(target, cursor)
  }
  if (cursor < source.length) parts.push({ text: source.slice(cursor), hit: false })
  return parts.length ? parts : [{ text: source, hit: false }]
}

function countMatches(text: string, query: string) {
  const target = query.trim().toLowerCase()
  if (!target) return 0
  let count = 0
  let index = text.toLowerCase().indexOf(target)
  while (index >= 0) {
    count += 1
    index = text.toLowerCase().indexOf(target, index + target.length)
  }
  return count
}

function parseAttachmentRows(row: NoticeRow) {
  const raw = valueToText(row['첨부파일'])
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    const list = Array.isArray(parsed) ? parsed : Object.entries(parsed).map(([name, url]) => ({ 파일명: name, URL: String(url) }))
    return list.map((item, index) => ({ id: String(index + 1), ...(item as NoticeRow) }))
  } catch (_) {
    return raw
      .split(/\n|;/)
      .map((item, index) => ({ id: String(index + 1), 파일명: item.trim(), URL: '' }))
      .filter((item) => item.파일명)
  }
}

function AttachmentPanel({
  status,
  files,
  onOpen,
}: {
  status: string
  files: NoticeRow[]
  onOpen: (file: NoticeRow) => void
}) {
  return (
    <div className="attachment-panel">
      <div className="attachment-status">첨부파일 · {status || '대기'}</div>
      {files.length ? (
        <div className="attachment-list">
          {files.map((file, index) => {
            const name = valueToText(file['파일명']) || valueToText(file.name) || `첨부파일_${index + 1}`
            const ext = attachmentExt(name || valueToText(file.URL))
            return (
              <button key={`${name}-${index}`} type="button" onClick={() => onOpen(file)} title={name}>
                <span>{attachmentIcon(ext)}</span>
                <em>{ext || 'FILE'}</em>
                <strong>{name}</strong>
              </button>
            )
          })}
        </div>
      ) : (
        <div className="detail-empty">첨부파일 목록이 없습니다.</div>
      )}
    </div>
  )
}

function FilePreviewTab({ file }: { file?: { name: string; url: string; ext: string } }) {
  if (!file) return <div className="doc-placeholder">파일 탭을 선택하세요.</div>
  const canFrame = file.url && ['pdf', 'html', 'htm', 'txt'].includes(file.ext)
  return (
    <div className="file-preview-tab">
      <div className="file-preview-head">
        <strong>{file.name}</strong>
        {file.url ? <a href={file.url} target="_blank" rel="noreferrer">새 창</a> : null}
      </div>
      {canFrame ? (
        <iframe title={file.name} src={file.url} />
      ) : (
        <div className="doc-placeholder">
          <FileDown size={30} />
          <strong>{file.ext || 'FILE'} 미리보기</strong>
          <span>이 형식은 다운로드 또는 새 창으로 확인하세요.</span>
        </div>
      )}
    </div>
  )
}

function attachmentExt(value: string) {
  const clean = value.split('?')[0]
  const ext = clean.includes('.') ? clean.split('.').pop() || '' : ''
  return ext.toLowerCase().slice(0, 8)
}

function attachmentIcon(ext: string) {
  if (ext === 'pdf') return 'PDF'
  if (ext === 'hwp') return 'HWP'
  if (['xls', 'xlsx'].includes(ext)) return 'XLS'
  if (['doc', 'docx'].includes(ext)) return 'DOC'
  if (['jpg', 'jpeg', 'png', 'gif'].includes(ext)) return 'IMG'
  if (ext === 'zip') return 'ZIP'
  return 'FILE'
}

function QualificationPanel({
  detailKey,
  status,
  rows,
}: {
  detailKey: string
  status: string
  rows: NoticeRow[]
}) {
  if (!detailKey) {
    return <div className="qualification-box empty">적격평가기준_세부 값이 없어 A4 기준을 불러오지 않습니다.</div>
  }
  const columns = ['시행일', '발주처', '적격심사기준', '이름', '형태', '내용', '배점', '메모']
  return (
    <div className="qualification-box">
      <div className="qualification-head">
        <strong>{detailKey}</strong>
        <span>{status || '대기'}</span>
      </div>
      {rows.length ? (
        <div className="qualification-table">
          <DataTable columns={columns} rows={rows.slice(0, 80)} emptyText="불러온 기준 row가 없습니다." />
        </div>
      ) : (
        <div className="detail-empty">불러온 기준 row가 없습니다.</div>
      )}
    </div>
  )
}

export default App


