import type { ApiEnvelope, NoticeRow, ParserNormalizationResult, ParserResult, ServerColumnProfile, StandardColumnRule } from './types'

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) {
    const message = data?.message || data?.error || `HTTP ${res.status}`
    throw new Error(message)
  }
  return data as T
}

export async function fetchHealth() {
  return getJson<{ ok: boolean; hasModuleKey: boolean }>('/api/health')
}

export async function fetchServerColumnProfiles() {
  const data = await getJson<ApiEnvelope<ServerColumnProfile>>('/api/schema/server-columns')
  return data.rows ?? []
}

export async function fetchStandardColumnRules() {
  const data = await getJson<ApiEnvelope<StandardColumnRule>>('/api/schema/standard-columns')
  return data.rows ?? []
}

export async function fetchSettingsRows(name: string) {
  const data = await getJson<ApiEnvelope<NoticeRow>>(`/api/settings/${encodeURIComponent(name)}`)
  return data.rows ?? []
}

export async function saveSettingsRows(name: string, rows: NoticeRow[]) {
  const res = await fetch(`/api/settings/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows }),
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) {
    const message = data?.message || data?.error || `HTTP ${res.status}`
    throw new Error(message)
  }
  return (data.rows ?? rows) as NoticeRow[]
}

export async function saveStandardColumnRules(rows: StandardColumnRule[]) {
  const res = await fetch('/api/schema/standard-columns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`)
  return (data.rows ?? rows) as StandardColumnRule[]
}

export async function saveCsvExport(filename: string, csv: string) {
  const res = await fetch('/api/export-csv', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, csv }),
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`)
  return data as { ok: boolean; path: string; filename: string }
}

export async function fetchA1ServerNotices(query: string) {
  const prefix = query.trim().startsWith('?') ? '' : '?'
  const data = await getJson<NoticeRow[] | ApiEnvelope<NoticeRow>>(`/api/bid${prefix}${query.trim()}`)
  if (Array.isArray(data)) return { rows: data, source: 'A1 서버공고' }
  return { rows: data.rows ?? [], source: 'A1 서버공고' }
}

export async function fetchA3Parser(gongsanum: string) {
  return getJson<ParserResult>(`/api/parser/a3?gongsanum=${encodeURIComponent(gongsanum)}`)
}

export async function fetchA3Normalization(gongsanum: string) {
  return getJson<ParserNormalizationResult>(`/api/parser/normalize?gongsanum=${encodeURIComponent(gongsanum)}`)
}

export async function fetchBidFiles(gongsanum: string) {
  const data = await getJson<ApiEnvelope<NoticeRow>>(`/api/bid-files?gongsanum=${encodeURIComponent(gongsanum)}`)
  return data.rows ?? []
}

export async function runDocumentPickaxeRuleTest(payload: { rule: NoticeRow; body?: string }) {
  const res = await fetch('/api/document-pickaxe/rule-test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) {
    const message = data?.message || data?.error || `HTTP ${res.status}`
    throw new Error(message)
  }
  return data as ParserResult
}

export async function runDocumentPickaxeBatchTest(payload: { gongsanum: string; rows: NoticeRow[] }) {
  const res = await fetch('/api/document-pickaxe/batch-test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) {
    const message = data?.message || data?.error || `HTTP ${res.status}`
    throw new Error(message)
  }
  return data as ParserResult & { testedRows?: number; textLength?: number }
}

export async function fetchQualification(detail: string, construction: string) {
  const params = new URLSearchParams({ 적격기준세부: detail, 건설: construction || '일반건설' })
  return getJson<NoticeRow[]>(`/api/qualification?${params.toString()}`)
}
