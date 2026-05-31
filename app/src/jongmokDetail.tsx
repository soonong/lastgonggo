import { useMemo, useState, type KeyboardEvent } from 'react'
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react'
import { buildJongmok, type PreprocessSettings } from './pipeline'
import type { NoticeRow } from './types'

type DongilEntry = {
  참가자격기준규모?: string
  평가기준?: string
  만점실적?: string
  최소인정규모?: string
  실적평가기간?: string
  평가비율?: string
}

type JongmokItem = {
  종목: string
  종목비율?: string
  종목평가기준금액?: string
  종목만점실적?: string
  종목실적평가기간?: string
  종목시평제한?: string
  종목평가만점항목?: string
  동일실적?: Record<string, Record<string, DongilEntry>>
}

type JongmokOptionGroup = {
  key: string
  label: string
  items: JongmokItem[]
}

type JongmokDetailPanelProps = {
  row: NoticeRow
  settings: PreprocessSettings
  displayFormatMap: Record<string, string>
  onPatch: (patch: NoticeRow) => void
  onFocusField: (field: string) => void
}

const TOP_FIELDS = ['일반_기타_전문', '종목', '전문건설_주력분야', '단독평가종목', '종목_모두보유']
const BUNDLE_TRIGGER_FIELDS = new Set(['종목', '전문건설_주력분야', '종목_모두보유'])
const JONGMOK_FIELDS: Array<{ key: keyof JongmokItem; label: string; kind?: 'money' | 'text' }> = [
  { key: '종목평가기준금액', label: '평가기준금액', kind: 'money' },
  { key: '종목만점실적', label: '만점실적', kind: 'money' },
  { key: '종목실적평가기간', label: '실적평가기간' },
  { key: '종목시평제한', label: '시평제한' },
  { key: '종목평가만점항목', label: '평가만점항목' },
]
const DONGIL_FIELDS: Array<{ key: keyof DongilEntry; label: string; kind?: 'money'; title?: string }> = [
  { key: '참가자격기준규모', label: '참가자격기준규모', kind: 'money', title: '공고문에 적힌 참가자격 기준 규모입니다.' },
  { key: '평가기준', label: '평가기준', title: '실적점수를 평가하는 금액이나 단위입니다.' },
  { key: '만점실적', label: '만점실적', kind: 'money' },
  { key: '최소인정규모', label: '최소인정규모', kind: 'money', title: '참가자격에 해당하는 최소 실적입니다.' },
  { key: '실적평가기간', label: '실적평가기간' },
  { key: '평가비율', label: '평가비율' },
]
const DONGIL_CATEGORIES = ['준공금액', '준공단위']

export function JongmokDetailPanel({ row, settings, displayFormatMap, onPatch, onFocusField }: JongmokDetailPanelProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const optionGroups = useMemo(() => getJongmokOptionGroups(row), [row])
  const groupStartIndexes = useMemo(() => {
    let cursor = 0
    return optionGroups.map((group) => {
      const start = cursor
      cursor += group.items.length
      return start
    })
  }, [optionGroups])
  const flatItems = useMemo(() => optionGroups.flatMap((group) => group.items), [optionGroups])
  const specialCandidates = useMemo(() => buildSpecialCandidates(settings.specialRecords ?? []), [settings.specialRecords])

  const runJongmokBundle = (basePatch: NoticeRow = {}) => {
    const base = { ...row, ...basePatch }
    const normalizedInput = normalizeJongmokInputForBundle(base['종목'])
    const bundleBase = normalizedInput ? { ...base, 종목: normalizedInput } : base
    const result = buildJongmok(bundleBase, settings)
    if (!result) {
      onPatch(basePatch)
      return
    }

    const nextPatch: NoticeRow = {
      ...basePatch,
      종목: result.display || toText(base['종목']),
      단독평가종목: result.standalone,
      일반_기타_전문: result.constructionType || toText(base['일반_기타_전문']),
      전문건설_주력분야: result.coreFields || toText(base['전문건설_주력분야']),
      종목묶기상태: result.status,
    }
    nextPatch.종목세부JSON = serializeJongmokItems(
      mergeParsedItemsWithExisting(parseDandokGroups(result.standalone).flatMap((group) => group.items), getExistingItems(row)),
    )
    onPatch(nextPatch)
  }

  const applyTopField = (field: string, value: string) => {
    if (field === '단독평가종목') {
      const items = mergeParsedItemsWithExisting(parseDandokGroups(value).flatMap((group) => group.items), getExistingItems(row))
      onPatch({ 단독평가종목: value, 종목세부JSON: serializeJongmokItems(items) })
      return
    }
    if (BUNDLE_TRIGGER_FIELDS.has(field)) runJongmokBundle({ [field]: value })
    else onPatch({ [field]: value })
  }

  const updateItem = (globalIndex: number, updater: (item: JongmokItem) => JongmokItem) => {
    const nextItems = flatItems.map((item, index) => (index === globalIndex ? updater({ ...item }) : item))
    onPatch({ 종목세부JSON: serializeJongmokItems(nextItems) })
  }

  const updateDongil = (globalIndex: number, category: string, name: string, field: keyof DongilEntry, value: string) => {
    updateItem(globalIndex, (item) => {
      const same = { ...(item.동일실적 ?? {}) }
      const categoryEntries = { ...(same[category] ?? {}) }
      categoryEntries[name] = { ...(categoryEntries[name] ?? createDongilEntry()), [field]: value }
      same[category] = categoryEntries
      return { ...item, 동일실적: same }
    })
  }

  const addDongil = (globalIndex: number, category: string, rawName: string) => {
    const name = rawName.trim()
    if (!name) return
    updateItem(globalIndex, (item) => {
      const same = { ...(item.동일실적 ?? {}) }
      const categoryEntries = { ...(same[category] ?? {}) }
      if (!categoryEntries[name]) categoryEntries[name] = createDongilEntry()
      same[category] = categoryEntries
      return { ...item, 동일실적: same }
    })
  }

  const removeDongil = (globalIndex: number, category: string, name: string) => {
    updateItem(globalIndex, (item) => {
      const same = { ...(item.동일실적 ?? {}) }
      const categoryEntries = { ...(same[category] ?? {}) }
      delete categoryEntries[name]
      if (Object.keys(categoryEntries).length) same[category] = categoryEntries
      else delete same[category]
      return { ...item, 동일실적: same }
    })
  }

  return (
    <div className="jongmok-detail-panel">
      <section className="jongmok-top-card">
        <div className="jongmok-card-head">
          <strong>종목묶기</strong>
          <span>{flatItems.length ? `${flatItems.length.toLocaleString()}개 평가종목` : '종목세부JSON 없음'}</span>
        </div>
        <div className="jongmok-top-fields">
          {TOP_FIELDS.map((field) => {
            if (field === '종목_모두보유') {
              return (
                <label key={field} className="jongmok-field">
                  <span>{field}</span>
                  <label className="detail-checkbox-control">
                    <input
                      type="checkbox"
                      checked={isChecked(row[field])}
                      onFocus={() => onFocusField(field)}
                      onChange={(event) => runJongmokBundle({ [field]: event.target.checked ? '1' : '' })}
                    />
                    <span>{isChecked(row[field]) ? '1' : '빈값'}</span>
                  </label>
                </label>
              )
            }
            const isLong = field === '종목' || field === '단독평가종목'
            return (
              <label key={field} className={isLong ? 'jongmok-field jongmok-field--textarea' : 'jongmok-field'}>
                <span>{field}</span>
                <textarea
                  rows={isLong ? 2 : 1}
                  value={toText(row[field])}
                  onFocus={() => onFocusField(field)}
                  onChange={(event) => onPatch({ [field]: event.target.value })}
                  onBlur={(event) => applyTopField(field, event.target.value)}
                  onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      applyTopField(field, event.currentTarget.value)
                    }
                  }}
                />
              </label>
            )
          })}
        </div>
      </section>

      {optionGroups.length ? (
        optionGroups.map((group, groupIndex) => {
          const isCollapsed = Boolean(collapsed[group.key])
          const groupStartIndex = groupStartIndexes[groupIndex] ?? 0
          return (
            <section key={group.key} className="jongmok-part">
              <button
                type="button"
                className="jongmok-part-head jongmok-part-toggle"
                onClick={() => setCollapsed((prev) => ({ ...prev, [group.key]: !prev[group.key] }))}
              >
                <span className="jongmok-toggle-icon">{isCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}</span>
                <strong>평가 그룹 {groupIndex + 1}</strong>
                <em>{group.label}</em>
                <span>{group.items.length > 1 ? `묶음 ${group.items.length}개` : '단일 평가'}</span>
              </button>
              {!isCollapsed
                ? group.items.map((item, itemIndex) => {
                    const globalIndex = groupStartIndex + itemIndex
                    const dongilCount = countDongilEntries(item)
                    return (
                      <article key={`${group.key}-${globalIndex}-${item.종목}`} className={`jongmok-item-card jongmok-item-card--tone-${globalIndex % 4}`}>
                        <div className="jongmok-item-title">
                          <span className="jongmok-item-index">종목 {globalIndex + 1}</span>
                          <strong>{item.종목}</strong>
                          <span className="jongmok-item-meta">{dongilCount ? `동일실적 ${dongilCount}개` : '동일실적 없음'}</span>
                        </div>
                        <div className="jongmok-subsection-title">기본 입력</div>
                        <div className="jongmok-field-list">
                          {JONGMOK_FIELDS.map((field) => (
                            <label key={String(field.key)} className="jongmok-field">
                              <span>{field.label}</span>
                              <input
                                value={formatInputValue(item[field.key], field.kind, displayFormatMap)}
                                inputMode={field.kind === 'money' ? 'decimal' : undefined}
                                onFocus={() => onFocusField('종목세부JSON')}
                                onChange={(event) =>
                                  updateItem(globalIndex, (current) => ({
                                    ...current,
                                    [field.key]: field.kind === 'money' ? event.target.value.replace(/,/g, '') : event.target.value,
                                  }))
                                }
                              />
                            </label>
                          ))}
                        </div>
                        <DongilEditor
                          item={item}
                          candidates={specialCandidates}
                          onFocus={() => onFocusField('종목세부JSON')}
                          onAdd={(category, name) => addDongil(globalIndex, category, name)}
                          onChange={(category, name, field, value) => updateDongil(globalIndex, category, name, field, value)}
                          onRemove={(category, name) => removeDongil(globalIndex, category, name)}
                        />
                      </article>
                    )
                  })
                : null}
            </section>
          )
        })
      ) : (
        <div className="jongmok-empty">종목을 수정한 뒤 Enter 또는 포커스 이동을 하면 종목묶기와 종목세부JSON이 갱신됩니다.</div>
      )}
    </div>
  )
}

function countDongilEntries(item: JongmokItem) {
  return Object.values(item.동일실적 ?? {}).reduce((sum, entries) => sum + Object.keys(entries ?? {}).length, 0)
}

function DongilEditor({
  item,
  candidates,
  onFocus,
  onAdd,
  onChange,
  onRemove,
}: {
  item: JongmokItem
  candidates: string[]
  onFocus: () => void
  onAdd: (category: string, name: string) => void
  onChange: (category: string, name: string, field: keyof DongilEntry, value: string) => void
  onRemove: (category: string, name: string) => void
}) {
  const [query, setQuery] = useState('')
  const candidateListId = `dongil-candidates-${safeDomId(item.종목)}`
  const selectedCategory = query.includes('금액') ? '준공금액' : '준공단위'

  const addCurrent = () => {
    onAdd(selectedCategory, query)
    setQuery('')
  }

  return (
    <div className="dongil-editor">
      <div className="dongil-add-row">
        <input
          value={query}
          list={candidateListId}
          placeholder="동일실적명 검색 또는 직접 입력"
          onFocus={onFocus}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              addCurrent()
            }
          }}
        />
        <button type="button" onClick={addCurrent} disabled={!query.trim()}>
          <Plus size={14} />
          추가
        </button>
        <datalist id={candidateListId}>
          {candidates.map((candidate) => (
            <option key={candidate} value={candidate} />
          ))}
        </datalist>
      </div>
      {DONGIL_CATEGORIES.map((category) => {
        const entries = item.동일실적?.[category] ?? {}
        const names = Object.keys(entries)
        return (
          <div key={category} className="dongil-category">
            <div className="dongil-category-head">
              <strong>{category}</strong>
              <span>{names.length ? `${names.length}개` : '없음'}</span>
            </div>
            {names.map((name) => (
              <div key={`${category}-${name}`} className="dongil-entry">
                <div className="dongil-entry-head">
                  <strong>{name}</strong>
                  <button type="button" onClick={() => onRemove(category, name)} title="동일실적 삭제">
                    <Trash2 size={14} />
                  </button>
                </div>
                <div className="dongil-field-grid">
                  {DONGIL_FIELDS.map((field) => (
                    <label key={field.key} className="jongmok-field" title={field.title}>
                      <span>{field.label}</span>
                      <input
                        value={formatDongilValue(entries[name]?.[field.key], field.kind)}
                        inputMode="decimal"
                        onFocus={onFocus}
                        onChange={(event) =>
                          onChange(category, name, field.key, field.kind === 'money' ? event.target.value.replace(/,/g, '') : event.target.value)
                        }
                      />
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}

function getJongmokOptionGroups(row: NoticeRow): JongmokOptionGroup[] {
  const existing = getExistingItems(row)
  const parsed = parseDandokGroups(toText(row['단독평가종목']))
  if (!parsed.length) {
    return existing.length ? [{ key: 'flat', label: '종목세부JSON', items: existing }] : []
  }

  const merged = mergeParsedItemsWithExisting(parsed.flatMap((group) => group.items), existing)
  let cursor = 0
  return parsed.map((group, index) => {
    const items = group.items.map(() => merged[cursor++] ?? createJongmokItem(''))
    return {
      key: `group-${index}-${group.label}`,
      label: group.label,
      items,
    }
  }).filter((group) => group.items.some((item) => item.종목))
}

function getExistingItems(row: NoticeRow): JongmokItem[] {
  return parseJsonItems(row['종목세부JSON'])
}

function parseJsonItems(value: unknown): JongmokItem[] {
  const raw = toText(value).trim()
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const flat = parsed.every(Array.isArray) ? parsed.flat() : parsed
    return flat.map(normalizeJongmokItem).filter((item) => item.종목)
  } catch (_) {
    return []
  }
}

function normalizeJongmokItem(value: unknown): JongmokItem {
  if (typeof value === 'string') return createJongmokItem(value)
  if (!value || typeof value !== 'object') return createJongmokItem('')
  const row = value as Record<string, unknown>
  return {
    종목: toText(row.종목),
    종목비율: toText(row.종목비율),
    종목평가기준금액: toText(row.종목평가기준금액 ?? row.평가기준금액),
    종목만점실적: toText(row.종목만점실적 ?? row.만점실적),
    종목실적평가기간: toText(row.종목실적평가기간 ?? row.실적평가기간 ?? row.종목실적평가기간),
    종목시평제한: toText(row.종목시평제한 ?? row.시평제한),
    종목평가만점항목: toText(row.종목평가만점항목 ?? row.평가만점항목),
    동일실적: normalizeDongil(row.동일실적),
  }
}

function parseDandokGroups(value: string): JongmokOptionGroup[] {
  return splitTopLevelSlash(value)
    .map((part, index) => {
      const names = splitPartItems(part)
      return {
        key: `parsed-${index}-${part}`,
        label: part,
        items: names.map(createJongmokItem).filter((item) => item.종목),
      }
    })
    .filter((group) => group.items.length)
}

function splitTopLevelSlash(value: string) {
  const result: string[] = []
  let depth = 0
  let buffer = ''
  for (const ch of value) {
    if (ch === '(') depth += 1
    if (ch === ')') depth = Math.max(0, depth - 1)
    if (ch === '/' && depth === 0) {
      if (buffer.trim()) result.push(buffer.trim())
      buffer = ''
      continue
    }
    buffer += ch
  }
  if (buffer.trim()) result.push(buffer.trim())
  return result
}

function splitPartItems(value: string) {
  const trimmed = value.trim().replace(/^\((.*)\)$/s, '$1')
  return trimmed.split(',').map((item) => item.trim()).filter(Boolean)
}

function mergeParsedItemsWithExisting(parsed: JongmokItem[], existing: JongmokItem[]) {
  const used = new Set<number>()
  return parsed.map((item, index) => {
    const byIndex = existing[index]
    if (byIndex?.종목 === item.종목) {
      used.add(index)
      return { ...item, ...byIndex, 종목: item.종목 }
    }
    const foundIndex = existing.findIndex((candidate, candidateIndex) => !used.has(candidateIndex) && candidate.종목 === item.종목)
    if (foundIndex >= 0) {
      used.add(foundIndex)
      return { ...item, ...existing[foundIndex], 종목: item.종목 }
    }
    return item
  })
}

function serializeJongmokItems(items: JongmokItem[]) {
  return JSON.stringify(items)
}

function createJongmokItem(name: string): JongmokItem {
  return {
    종목: name.trim(),
    종목평가기준금액: '',
    종목만점실적: '',
    종목실적평가기간: '',
    종목시평제한: '',
    종목평가만점항목: '',
    동일실적: {},
  }
}

function createDongilEntry(): DongilEntry {
  return {
    참가자격기준규모: '',
    평가기준: '',
    만점실적: '',
    최소인정규모: '',
    실적평가기간: '',
    평가비율: '',
  }
}

function normalizeDongil(value: unknown): Record<string, Record<string, DongilEntry>> {
  if (!value || typeof value !== 'object') return {}
  const result: Record<string, Record<string, DongilEntry>> = {}
  for (const [category, entries] of Object.entries(value as Record<string, unknown>)) {
    if (!entries || typeof entries !== 'object') continue
    result[category] = {}
    for (const [name, entry] of Object.entries(entries as Record<string, unknown>)) {
      result[category][name] = { ...createDongilEntry(), ...((entry as DongilEntry) ?? {}) }
    }
  }
  return result
}

function buildSpecialCandidates(rows: NoticeRow[]) {
  return Array.from(
    new Set(
      rows
        .map((row) => toText(row.결과값 || row.중분류 || row.특수실적 || row.이름))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ).sort((a, b) => a.localeCompare(b, 'ko'))
}

function normalizeJongmokInputForBundle(value: unknown) {
  return Array.from(
    new Set(
      toText(value)
        .replace(/[()]/g, '')
        .split(/[\/,\n]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ).join('/')
}

function formatInputValue(value: unknown, kind: 'money' | 'text' | undefined, displayFormatMap: Record<string, string>) {
  if (kind !== 'money') return toText(value)
  return formatMoney(value, displayFormatMap.평가기준금액)
}

function formatDongilValue(value: unknown, kind?: 'money') {
  return kind === 'money' ? formatMoney(value) : toText(value)
}

function formatMoney(value: unknown, _format = '') {
  const raw = toText(value)
  if (!raw.trim()) return ''
  const num = number(raw)
  if (!Number.isFinite(num)) return raw
  return new Intl.NumberFormat('ko-KR').format(num)
}

function number(value: unknown) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const raw = toText(value).replace(/,/g, '').replace(/%/g, '').trim()
  if (!raw) return 0
  const num = Number(raw.match(/-?\d+(\.\d+)?/)?.[0] ?? '')
  return Number.isFinite(num) ? num : 0
}

function toText(value: unknown) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function isChecked(value: unknown) {
  const clean = toText(value).trim().toLowerCase()
  return Boolean(clean && clean !== '0' && clean !== 'false')
}

function safeDomId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_')
}
