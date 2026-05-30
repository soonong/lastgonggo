import type { NoticeRow, StandardColumnRule } from './types'

type JongmokCatalogEntry = {
  id: string
  original: string
  constructionType: string
  detailType: string
  job: string
  core: string
  upper: string
  alternative: string
  crossTargets: string[]
  standaloneExcluded: boolean
  length: number
}

type JongmokToken = {
  raw: string
  entry: JongmokCatalogEntry
  display: string
  standalone: string
}

type JongmokBuildResult = {
  display: string
  standalone: string
  constructionType: string
  coreFields: string
  status: string
}

export type PipelineStats = {
  total: number
  changed: number
  review: number
  errors: number
}

export type PipelineResult = {
  rows: NoticeRow[]
  stats: PipelineStats
}

export type PreprocessSettings = {
  evaluationCriteria?: NoticeRow[]
  secondaryCriteria?: NoticeRow[]
  orgMap?: NoticeRow[]
  regionDb?: NoticeRow[]
  jongmokMap?: NoticeRow[]
  noticeTags?: NoticeRow[]
  specialRecords?: NoticeRow[]
  specialCommon?: NoticeRow[]
  bidMethodSkip?: NoticeRow[]
  deleteKeywords?: NoticeRow[]
  bracketRules?: NoticeRow[]
  skipSpecialConditionRouter?: boolean
  skipSiteRegionNormalization?: boolean
}

export function preprocessRows(rows: NoticeRow[], rules: StandardColumnRule[], settings: PreprocessSettings = {}): PipelineResult {
  let changed = 0
  let review = 0
  let errors = 0
  const processed: NoticeRow[] = []
  for (const row of rows) {
    const deleteHit = matchDeleteKeyword(row, settings)
    if (deleteHit) {
      changed += 1
      continue
    }
    const next: NoticeRow = { ...row }
    const before = JSON.stringify(projectStable(next))

    normalizeRaw(next)
    applyBracketRules(next, settings)
    if (!settings.skipSpecialConditionRouter) applySpecialConditionRouter(next, settings)
    applyRegionNormalization(next, settings)
    applyBasicCalculations(next, settings)
    applyColumnDefaults(next, rules)
    applyEvaluationDebug(next, settings)
    validateRow(next, settings)

    const status = String(next['검증상태'] ?? '')
    if (status.includes('확인')) review += 1
    if (status.includes('오류')) errors += 1
    if (JSON.stringify(projectStable(next)) !== before) changed += 1
    processed.push(next)
  }
  return { rows: processed, stats: { total: rows.length, changed, review, errors } }
}

export function reprocessHumanRow(row: NoticeRow, rules: StandardColumnRule[], settings: PreprocessSettings = {}) {
  return preprocessRows([row], rules, settings).rows[0] ?? row
}

function projectStable(row: NoticeRow) {
  const copy: NoticeRow = {}
  for (const key of Object.keys(row).sort()) copy[key] = row[key]
  return copy
}

function normalizeRaw(row: NoticeRow) {
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'string') row[key] = value.trim()
  }
  for (const key of ['기초금액', '추정가격', '추정금액', 'A값', '순공사원가']) {
    const value = String(row[key] ?? '').replace(/,/g, '').trim()
    if (value && /^-?\d+(\.\d+)?$/.test(value)) row[key] = value
  }
  if (String(row['종목'] ?? '').includes('업종조건없음')) {
    row['종목'] = ''
    row['단독평가종목'] = ''
  }
}

function matchDeleteKeyword(row: NoticeRow, settings: PreprocessSettings) {
  for (const rule of settings.deleteKeywords ?? []) {
    const column = text(rule['컬럼명'] ?? rule.scope) || '공사명'
    const keyword = text(rule['검색키워드'] ?? rule.keyword)
    const method = text(rule['처리방법'])
    if (!keyword || (method && method !== '열삭제')) continue
    if (text(row[column]).includes(keyword)) return { column, keyword }
  }
  return null
}

function applyBracketRules(row: NoticeRow, settings: PreprocessSettings) {
  for (const rule of settings.bracketRules ?? []) {
    const column = text(rule['컬럼명'] ?? '공사명') || '공사명'
    const keyword = text(rule['검색키워드'] ?? rule['패턴'])
    const replacement = text(rule['변경 후'])
    const method = text(rule['처리방법'])
    if (!keyword || (method && method !== '키워드변경')) continue
    const current = text(row[column])
    if (current.includes(keyword)) row[column] = current.split(keyword).join(replacement).replace(/\s{2,}/g, ' ').trim()
  }
}

function applySpecialConditionRouter(row: NoticeRow, settings: PreprocessSettings) {
  const special = splitValues(row['특수조건'])
  if (!special.length) return
  const noticeTags = new Set(splitValues(row['공고확인']))
  const commonTags = new Set(splitValues(row['특수실적_공통']))
  const specialRecords = new Set(splitValues(row['특수실적']))
  const unknown: string[] = []

  for (const value of special) {
    const target = routeSpecialCondition(value, settings)
    if (target === '특수실적_공통') {
      commonTags.add(value)
    } else if (target === '특수실적') {
      specialRecords.add(value)
    } else if (target === '공고확인') {
      noticeTags.add(value)
    } else {
      unknown.push(value)
    }
  }

  row['공고확인'] = Array.from(noticeTags).join('/')
  row['특수실적_공통'] = Array.from(commonTags).join('/')
  row['특수실적'] = Array.from(specialRecords).join('/')
  if (unknown.length) row['특수조건_라우팅상태'] = `확인필요 (${unknown.join('/')})`
}

function routeSpecialCondition(value: string, settings: PreprocessSettings) {
  if (hasResultValue(settings.noticeTags ?? [], value)) return '공고확인'
  if (hasResultValue(settings.specialCommon ?? [], value)) return '특수실적_공통'
  if (hasResultValue(settings.specialRecords ?? [], value)) return '특수실적'
  return ''
}

function hasResultValue(rows: NoticeRow[], value: string) {
  const normalized = normalizeCompare(value)
  return rows.some((row) => normalizeCompare(text(row['결과값'])) === normalized)
}

function applyRegionNormalization(row: NoticeRow, settings: PreprocessSettings) {
  const regionDb = settings.regionDb ?? []
  if (!regionDb.length) return

  const region = text(row['지역제한'])
  if (region) {
    const normalized = normalizeRegionValue(region, regionDb)
    if (normalized.value && normalized.value !== region && !text(row['지역제한_원문'])) row['지역제한_원문'] = region
    if (normalized.value) row['지역제한'] = normalized.value
    row['지역제한_매핑상태'] = normalized.status
  }

  if (settings.skipSiteRegionNormalization) return

  const site = text(row['공사현장'])
  if (site) {
    const normalizedSite = normalizeRegionValue(site, regionDb)
    if (normalizedSite.status === '정상' && normalizedSite.value && normalizedSite.value !== site) {
      if (!text(row['공사현장_원문'])) row['공사현장_원문'] = site
      row['공사현장'] = normalizedSite.value
    } else if (normalizedSite.status.includes('확인필요')) {
      row['공사현장_매핑상태'] = normalizedSite.status
    }
  }
}

function normalizeRegionValue(value: string, regionDb: NoticeRow[]) {
  const tokens = value
    .split('/')
    .map((token) => token.trim())
    .filter(Boolean)
  if (!tokens.length) return { value: '', status: '' }

  const mapped: string[] = []
  const reviews: string[] = []

  for (const token of tokens) {
    const result = normalizeRegionToken(token, regionDb)
    if (result.status === '정상') mapped.push(result.value)
    else {
      mapped.push(token)
      reviews.push(`${token}: ${result.status}`)
    }
  }

  return {
    value: dedupe(mapped).join('/'),
    status: reviews.length ? `확인필요 (${reviews.join('; ')})` : '정상',
  }
}

function normalizeRegionToken(rawToken: string, regionDb: NoticeRow[]) {
  const token = rawToken.replace(/\s+/g, ' ').trim()
  if (!token) return { value: '', status: '빈값' }
  if (token === '전국') return { value: '전국', status: '정상' }
  if (/[()]/.test(token) && /제외|포함|이상|이하/.test(token)) return { value: token, status: '괄호 조건 확인' }

  const words = token
    .replace(/[(),]/g, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean)
  const candidates = [token, ...words]
  const wideMatches = matchWideRegions(candidates, regionDb)
  const cityMatches = matchCityRegions(candidates, regionDb)
  const districtMatches = matchDistrictRegions(candidates, regionDb)
  const allCityMatches = cityMatches.length ? cityMatches : districtMatches

  if (allCityMatches.length) {
    const scoped = wideMatches.length
      ? allCityMatches.filter((item) => wideMatches.some((wide) => wide.wide === item.wide))
      : allCityMatches
    const unique = uniqueRegionPairs(scoped)
    if (unique.length === 1) return { value: `${unique[0].wide},${unique[0].city}`, status: '정상' }
    if (unique.length > 1) return { value: token, status: `복수후보 ${unique.map((item) => `${item.wide},${item.city}`).join('/')}` }
    return { value: token, status: '광역-시군구 불일치' }
  }

  const uniqueWide = Array.from(new Set(wideMatches.map((item) => item.wide)))
  if (uniqueWide.length === 1) return { value: uniqueWide[0], status: '정상' }
  if (uniqueWide.length > 1) return { value: token, status: `복수광역 ${uniqueWide.join('/')}` }
  return { value: token, status: '미매칭' }
}

function matchWideRegions(candidates: string[], regionDb: NoticeRow[]) {
  const matches: Array<{ wide: string }> = []
  for (const row of regionDb) {
    const wide = text(row['광역시/도-전처리후'])
    if (!wide) continue
    const aliases = splitAliases(row['광역시/도-전처리전'])
    if (candidates.some((candidate) => aliases.includes(candidate) || candidate === wide)) matches.push({ wide })
  }
  return matches
}

function matchCityRegions(candidates: string[], regionDb: NoticeRow[]) {
  const matches: Array<{ wide: string; city: string }> = []
  for (const row of regionDb) {
    const wide = text(row['광역시/도-전처리후'])
    const city = text(row['시군구-전처리후'])
    if (!wide || !city) continue
    const aliases = [...splitAliases(row['시군구-전처리전']), ...splitAliases(row['시군구-홈페이지용']), city]
    if (candidates.some((candidate) => aliases.includes(candidate))) matches.push({ wide, city })
  }
  return matches
}

function matchDistrictRegions(candidates: string[], regionDb: NoticeRow[]) {
  const matches: Array<{ wide: string; city: string }> = []
  for (const row of regionDb) {
    const wide = text(row['광역시/도-전처리후'])
    const city = text(row['시군구-전처리후'])
    if (!wide || !city) continue
    const aliases = splitAliases(row['하위구-전처리전'])
    if (aliases.length && candidates.some((candidate) => aliases.includes(candidate) || candidate === text(row['하위구-전처리후']))) {
      matches.push({ wide, city })
    }
  }
  return matches
}

function uniqueRegionPairs(values: Array<{ wide: string; city: string }>) {
  const seen = new Set<string>()
  const result: Array<{ wide: string; city: string }> = []
  for (const value of values) {
    const key = `${value.wide},${value.city}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

function splitAliases(value: unknown) {
  return text(value)
    .split('/')
    .map((item) => item.trim())
    .filter(Boolean)
}

function applyBasicCalculations(row: NoticeRow, settings: PreprocessSettings) {
  const region = text(row['지역제한'])
  if (!text(row['검색용현장']) && region) row['검색용현장'] = region

  const org = text(row['적격발주처']) || text(row['발주처'])
  if (!text(row['원발주처']) && org) row['원발주처'] = org

  const bidRateAmount = bidAmountByRate(row)
  if (!text(row['투찰율_투찰금액']) && bidRateAmount > 0) row['투찰율_투찰금액'] = String(bidRateAmount)

  const pureAmount = pureConstructionAmount(row)
  if (!text(row['순공사_투찰금액']) && pureAmount > 0) row['순공사_투찰금액'] = String(pureAmount)

  const expected = Math.max(number(row['투찰율_투찰금액']), number(row['순공사_투찰금액']))
  if (!text(row['예상투찰금액']) && expected > 0) row['예상투찰금액'] = String(expected)

  const jongmok = splitValues(row['종목'])
  if (!text(row['종목_모두보유']) && jongmok.length > 1) row['종목_모두보유'] = '1'

  const jongmokResult = buildJongmok(row, settings)
  if (jongmokResult) {
    if (jongmokResult.display && jongmokResult.display !== text(row['종목']) && !text(row['종목_원문'])) row['종목_원문'] = text(row['종목'])
    if (jongmokResult.display) row['종목'] = jongmokResult.display
    if (!text(row['단독평가종목'])) row['단독평가종목'] = jongmokResult.standalone
    if (!text(row['일반_기타_전문'])) row['일반_기타_전문'] = jongmokResult.constructionType
    if (!text(row['전문건설_주력분야']) && jongmokResult.coreFields) row['전문건설_주력분야'] = jongmokResult.coreFields
    if (jongmokResult.status) row['종목_정규화상태'] = jongmokResult.status
  }
  if (!text(row['일반_기타_전문'])) row['일반_기타_전문'] = inferConstructionType(row, settings)
  row['종목세부JSON'] = buildJongmokJson(row)
  const duplicateStatus = detectStandaloneDuplicate(text(row['단독평가종목']))
  if (duplicateStatus) row['단독평가종목_중복상태'] = duplicateStatus
}

function applyColumnDefaults(row: NoticeRow, rules: StandardColumnRule[]) {
  for (const rule of rules) {
    const key = rule.항목
    if (!key || key in row) continue
    row[key] = ''
  }
}

function applyEvaluationDebug(row: NoticeRow, settings: PreprocessSettings) {
  const bidMethod = text(row['입찰방식'])
  const skip = isSkipBidMethod(bidMethod, settings.bidMethodSkip ?? [])
  if (skip) {
    row['적격평가기준_세부'] = ''
    row['적격_1차상태'] = '정상제외'
    row['적격_1차사유'] = `입찰방식=${bidMethod}`
    row['적격_처치방법'] = ''
    return
  }

  const primary = matchPrimaryCriteria(row, settings)
  if (primary) {
    row['원발주처'] = primary.origin
    row['적격발주처'] = primary.org
    row['적격평가기준_세부'] = primary.key
    row['적격_1차상태'] = 'OK'
    row['적격_1차사유'] = `id=${primary.id}, ${primary.reason}`
    row['적격_처치방법'] = ''
  } else if (!text(row['적격평가기준_세부'])) {
    const reason = missingReason(row)
    row['적격_1차상태'] = '확인필요'
    row['적격_1차사유'] = reason
    row['적격_처치방법'] = `${reason} 입력 또는 룰 보강`
  } else {
    row['적격_1차상태'] = '값있음'
    row['적격_1차사유'] = ''
    row['적격_처치방법'] = ''
  }

  const secondary = applySecondaryCriteria(row, settings)
  if (secondary) {
    row['적격_2차상태'] = 'OK'
    row['적격_2차사유'] = `id=${secondary.id}`
  } else {
    row['적격_2차상태'] = text(row['공고확인']) || text(row['특수실적']) ? '조건값있음/미매칭' : ''
    row['적격_2차사유'] = ''
  }
}

function isSkipBidMethod(bidMethod: string, rows: NoticeRow[]) {
  if (!bidMethod || !rows.length) return false
  return rows.some((row) => {
    const keyword = text(row['입찰방식']) || text(row['키워드']) || text(row['결과값'])
    return keyword ? bidMethod.includes(keyword) : false
  })
}

function validateRow(row: NoticeRow, settings: PreprocessSettings) {
  const errors: string[] = []
  const reviews: string[] = []
  if (!text(row['공고번호'])) errors.push('공고번호 없음')
  if (!text(row['공사명'])) errors.push('공사명 없음')
  if (!text(row['발주처'])) reviews.push('발주처 확인')
  if (!text(row['종목'])) reviews.push('종목 확인')
  if (!text(row['지역제한'])) reviews.push('지역제한 확인')
  if (text(row['지역제한_매핑상태']).includes('확인필요')) reviews.push(text(row['지역제한_매핑상태']))
  if (text(row['공사현장_매핑상태']).includes('확인필요')) reviews.push(text(row['공사현장_매핑상태']))
  if (text(row['종목_정규화상태']).includes('확인필요')) reviews.push(text(row['종목_정규화상태']))
  if (text(row['단독평가종목_중복상태'])) reviews.push(text(row['단독평가종목_중복상태']))
  if (text(row['특수조건_라우팅상태']).includes('확인필요')) reviews.push(text(row['특수조건_라우팅상태']))
  if (specialRecordNeedsValue(row, settings)) errors.push('특수실적 내용 입력 확인')

  row['검증메모'] = [...errors, ...reviews].join(' / ')
  row['검증상태'] = errors.length ? '오류' : reviews.length ? '확인필요' : '정상'
}

function matchPrimaryCriteria(row: NoticeRow, settings: PreprocessSettings) {
  const criteria = settings.evaluationCriteria ?? []
  if (!criteria.length) return null

  const rawOrg = text(row['원발주처']) || text(row['적격발주처']) || text(row['발주처'])
  const org = normalizeOrg(rawOrg, settings.orgMap ?? [])
  const constructionType = text(row['일반_기타_전문'])
  const price = number(row['추정가격'])
  const noticeDate = parseDate(text(row['입력일']))
  const amountColumn = `${constructionType} (원)`

  if (!org || !constructionType || price <= 0 || !noticeDate) return null

  const candidates = criteria.filter((item) => text(item['적격발주처']) === org && number(item[amountColumn]) > 0)
  if (!candidates.length) return null

  const dated = candidates.filter((item) => {
    const since = parseDate(text(item['시행일']))
    return since ? since <= noticeDate : false
  })
  const groupSource = dated.length ? dated : candidates
  const selectedDate = dated.length
    ? Math.max(...dated.map((item) => parseDate(text(item['시행일']))?.getTime() ?? 0))
    : Math.min(...candidates.map((item) => parseDate(text(item['시행일']))?.getTime() || Number.MAX_SAFE_INTEGER))
  const dateGroup = groupSource.filter((item) => (parseDate(text(item['시행일']))?.getTime() ?? 0) === selectedDate)

  const sorted = [...dateGroup].sort((a, b) => number(b[amountColumn]) - number(a[amountColumn]))
  let candidate: NoticeRow | null = null
  for (const item of sorted) {
    const threshold = number(item[amountColumn])
    if (price < threshold) candidate = item
    else break
  }
  if (!candidate) return null

  const origin = text(candidate['원발주처'])
  const criterionName = text(candidate['적격심사기준'])
  const key = text(candidate['적격평가기준_세부']) || `${origin}_${criterionName}`
  return {
    id: text(candidate.id),
    org: text(candidate['적격발주처']) || org,
    origin,
    key,
    reason: `${constructionType}, 추정가격 ${price}, ${criterionName}`,
  }
}

function applySecondaryCriteria(row: NoticeRow, settings: PreprocessSettings) {
  const criteria = settings.secondaryCriteria ?? []
  const key = text(row['적격평가기준_세부'])
  if (!criteria.length || !key) return null

  const conditionColumns = ['입찰방식', '종목', '공고확인', '특수실적', '등급공사', '동일실적평가여부']
  const matched = criteria.find((item) => {
    if (text(item['적격평가기준_세부 (매칭키)']) !== key) return false
    return conditionColumns.every((col) => {
      const expected = text(item[col])
      if (!expected) return true
      const actual = text(row[col])
      if (col === '특수실적') return actual.includes(expected)
      return actual === expected
    })
  })
  if (!matched) return null

  const overwriteColumns = ['원발주처', '적격발주처', '적격평가기준_세부', '지역제한', '추정가격기준', '추정금액기준', '기초금액기준']
  for (const col of overwriteColumns) {
    const value = text(matched[col])
    if (value) row[col] = value
  }
  return { id: text(matched.id) }
}

function normalizeOrg(rawOrg: string, orgMap: NoticeRow[]) {
  if (!rawOrg) return ''
  for (const item of orgMap) {
    const keyword = text(item['발주처 키워드'])
    if (keyword && rawOrg.includes(keyword)) return text(item['매핑 대상']) || rawOrg
  }
  return rawOrg
}

function parseDate(value: string) {
  if (!value) return null
  const normalized = value.match(/\d{4}[-.]\d{1,2}[-.]\d{1,2}/)?.[0]?.replace(/\./g, '-')
  if (!normalized) return null
  const date = new Date(`${normalized}T00:00:00`)
  return Number.isNaN(date.getTime()) ? null : date
}

function buildJongmok(row: NoticeRow, settings: PreprocessSettings): JongmokBuildResult | null {
  const catalog = buildJongmokCatalog(settings.jongmokMap ?? [])
  const rawItems = splitValues(row['종목'])
  if (!catalog.length || !rawItems.length) return null

  const majorHints = splitValues(row['전문건설_주력분야'])
  const tokens: JongmokToken[] = []
  const misses: string[] = []

  rawItems.forEach((raw, index) => {
    const token = resolveJongmokToken(raw, catalog, majorHints[index] || majorHints[0] || '')
    if (token) tokens.push(token)
    else misses.push(raw)
  })

  if (!tokens.length) return {
    display: '',
    standalone: '',
    constructionType: '',
    coreFields: '',
    status: `확인필요 (${misses.join('/')})`,
  }

  const display = formatJongmokDisplay(tokens, row)
  const standalone = formatStandaloneJongmok(tokens, row)
  const constructionType = tokens.find((token) => token.entry.constructionType)?.entry.constructionType ?? ''
  const coreFields = dedupe(tokens.map((token) => token.standalone.split('_')[1] ?? '').filter(Boolean)).join('/')
  const status = misses.length ? `확인필요 (${misses.join('/')})` : '정상'
  return { display, standalone, constructionType, coreFields, status }
}

function buildJongmokCatalog(rows: NoticeRow[]): JongmokCatalogEntry[] {
  return rows
    .map((row) => {
      const job = text(row['업종'])
      return {
        id: text(row.id),
        original: text(row['원본 (등록증 표기)']),
        constructionType: text(row['일반_기타_전문']),
        detailType: text(row['세부유형']),
        job,
        core: text(row['주력업종']),
        upper: text(row['상위업종']),
        alternative: text(row['대체업종']),
        crossTargets: splitCatalogValues(row['상호진출_상대종목']),
        standaloneExcluded: text(row['단독평가_제외']) === '1',
        length: number(row['길이']) || job.length,
      }
    })
    .filter((entry) => entry.job)
    .sort((a, b) => b.length - a.length)
}

function resolveJongmokToken(raw: string, catalog: JongmokCatalogEntry[], majorHint: string): JongmokToken | null {
  const [base, explicitCore] = raw.split('_').map((part) => part.trim()).filter(Boolean)
  const search = base || raw
  const entry = selectJongmokEntry(search, catalog, explicitCore || majorHint)
  if (!entry) return null

  const normalizedSearch = normalizeJongmokKey(search)
  const normalizedCore = normalizeJongmokKey(entry.core)
  const normalizedJob = normalizeJongmokKey(entry.job)
  const core = explicitCore ||
    majorHint ||
    (entry.core && normalizedSearch === normalizedCore && normalizedCore !== normalizedJob ? entry.core : '')
  const standalone = entry.standaloneExcluded ? '' : formatStandaloneToken(entry, core)
  return {
    raw,
    entry,
    display: entry.job,
    standalone,
  }
}

function selectJongmokEntry(token: string, catalog: JongmokCatalogEntry[], preferredCore: string) {
  const normalized = normalizeJongmokKey(token)
  if (!normalized) return null

  let selected: JongmokCatalogEntry | null = null
  let selectedScore = -Infinity
  for (const entry of catalog) {
    const score = scoreJongmokEntry(entry, normalized, preferredCore)
    if (score > selectedScore) {
      selected = entry
      selectedScore = score
    }
  }
  return selectedScore > 0 ? selected : null
}

function scoreJongmokEntry(entry: JongmokCatalogEntry, normalized: string, preferredCore: string) {
  const aliases = getJongmokAliases(entry)
  let score = 0
  for (const alias of aliases) {
    if (alias.key !== normalized) continue
    score = Math.max(score, alias.score)
  }
  if (!score) return 0
  if (preferredCore && normalizeJongmokKey(entry.core) === normalizeJongmokKey(preferredCore)) score += 80
  if (entry.core && entry.core !== entry.job && normalizeJongmokKey(entry.core) === normalized) score += 40
  if (entry.constructionType && entry.constructionType !== '미분류') score += 20
  return score + entry.length / 100
}

function getJongmokAliases(entry: JongmokCatalogEntry) {
  const aliases: Array<{ key: string; score: number }> = []
  const add = (value: string, score: number) => {
    const key = normalizeJongmokKey(value)
    if (key) aliases.push({ key, score })
  }
  add(entry.original, 90)
  add(entry.job, 80)
  add(entry.core, entry.core && entry.core !== entry.job ? 95 : 65)
  add(entry.upper, 55)
  for (const value of splitCatalogValues(entry.alternative)) add(value, 70)
  return aliases
}

function formatStandaloneToken(entry: JongmokCatalogEntry, core: string) {
  const cleanCore = core && core !== entry.job ? core : ''
  return cleanCore ? `${entry.job}_${cleanCore}` : entry.job
}

function formatJongmokDisplay(tokens: JongmokToken[], row: NoticeRow) {
  const displays = dedupe(tokens.flatMap((token) => [token.display, ...splitCatalogValues(token.entry.alternative)]))
  if (!displays.length) return ''

  const upperValues = dedupe(tokens.map((token) => token.entry.upper).filter(Boolean))
  if (!requiresAllJongmok(row)) return dedupe([...displays, ...upperValues]).join('/')
  if (displays.length === 1) return dedupe([...displays, ...upperValues]).join('/')

  const baseOption = groupDisplayOption(displays)
  const upperOptions = upperValues.map((upper) => groupDisplayOption(replaceUpperGroup(tokens, upper)))
  return dedupe([baseOption, ...upperOptions]).join('/')
}

function formatStandaloneJongmok(tokens: JongmokToken[], row: NoticeRow) {
  const items = applyCrossMarket(tokens, row).map((token) => token.standalone).filter(Boolean)
  if (!items.length) return ''
  if (requiresAllJongmok(row) && items.length > 1) return `(${items.join(',')})`
  return items.join('/')
}

function applyCrossMarket(tokens: JongmokToken[], row: NoticeRow) {
  if (!truthy(row['상호진출여부'])) return tokens
  const main = tokens[0]
  if (!main) return tokens

  return tokens.map((token, index) => {
    if (index === 0) return token
    if (main.entry.crossTargets.includes(token.display) && token.standalone) {
      return { ...token, standalone: `${token.standalone}_${main.display}` }
    }
    if (token.entry.crossTargets.includes(main.display) && token.standalone && main.standalone) {
      return { ...token, standalone: `${token.standalone}_${main.standalone}` }
    }
    return token
  })
}

function replaceUpperGroup(tokens: JongmokToken[], upper: string) {
  const values: string[] = []
  let inserted = false
  for (const token of tokens) {
    if (token.entry.upper === upper) {
      if (!inserted) {
        values.push(upper)
        inserted = true
      }
      continue
    }
    values.push(token.display)
  }
  return dedupe(values)
}

function groupDisplayOption(values: string[]) {
  const clean = values.filter(Boolean)
  if (clean.length <= 1) return clean[0] ?? ''
  return `(${clean.join(',')})`
}

function requiresAllJongmok(row: NoticeRow) {
  return text(row['종목_모두보유']) === '1' || Boolean(text(row['공동도급형태']))
}

function inferConstructionType(row: NoticeRow, settings: PreprocessSettings) {
  const catalog = buildJongmokCatalog(settings.jongmokMap ?? [])
  const first = splitStandalone(text(row['단독평가종목']))[0] || splitValues(row['종목'])[0] || ''
  const base = first.split('_')[0]
  return resolveJongmokToken(base, catalog, '')?.entry.constructionType ?? ''
}

function buildJongmokJson(row: NoticeRow) {
  const items = splitStandalone(text(row['단독평가종목']))
  return JSON.stringify(
    items.map((item) => ({
      종목: item,
      종목평가기준금액: text(row['평가기준금액']) || text(row['추정가격']) || text(row['기초금액']) || '',
      종목만점실적: '',
      종목실적평가기간: '',
    })),
  )
}

function bidAmountByRate(row: NoticeRow) {
  const base = number(row['기초금액'])
  const a = number(row['A값'])
  const rate = number(row['투찰율'])
  if (base <= 0 || rate <= 0) return 0
  return roundDownToTens((base - a) * rate + a)
}

function pureConstructionAmount(row: NoticeRow) {
  const base = number(row['기초금액'])
  const pure = number(row['순공사원가'])
  if (base <= 0 || pure <= 0) return 0
  if (base * 0.99 > 10_000_000_000) return 0
  return roundDownToTens(pure * 0.98)
}

function specialRecordNeedsValue(row: NoticeRow, settings: PreprocessSettings) {
  const selected = splitValues(row['특수실적'])
  if (!selected.length || text(row['특수실적_내용'])) return false
  const needValues = new Set(
    (settings.specialRecords ?? [])
      .filter((item) => text(item['내용입력필요']) === '1')
      .map((item) => normalizeCompare(text(item['결과값']))),
  )
  return selected.some((value) => needValues.has(normalizeCompare(value)))
}

function missingReason(row: NoticeRow) {
  for (const key of ['원발주처', '일반_기타_전문', '추정가격', '입력일']) {
    if (!text(row[key]) || text(row[key]) === '0') return `${key} 없음`
  }
  return '적격 기준 미매칭'
}

function splitValues(value: unknown) {
  return text(value)
    .split('/')
    .map((item) => item.trim())
    .filter(Boolean)
}

function splitCatalogValues(value: unknown) {
  return text(value)
    .split(/[\/,\n;]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function splitStandalone(value: string) {
  return value
    .replace(/[()]/g, '')
    .split(/[\/,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function detectStandaloneDuplicate(value: string) {
  const options = value
    .split('/')
    .map((item) => item.trim())
    .filter(Boolean)
  const seen = new Set<string>()
  for (const option of options) {
    const key = normalizeJongmokKey(option)
    if (!key) continue
    if (seen.has(key)) return `중복옵션 확인: ${option}`
    seen.add(key)
  }
  return ''
}

function normalizeJongmokKey(value: unknown) {
  return text(value).replace(/[\s·ㆍ\-.・･,()（）]/g, '')
}

function normalizeCompare(value: unknown) {
  return text(value).replace(/[\s,]/g, '').toLowerCase()
}

function truthy(value: unknown) {
  const clean = text(value)
  return Boolean(clean && clean !== '0' && clean !== 'false')
}

function dedupe(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)))
}

function number(value: unknown) {
  const parsed = Number(text(value).replace(/[,%]/g, ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function text(value: unknown) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function roundDownToTens(value: number) {
  return Math.floor(value / 10) * 10
}
