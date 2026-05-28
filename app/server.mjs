import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')
const port = Number(process.env.SERVER_PORT || 3101)

loadEnv(path.join(repoRoot, '.env.local'))
loadEnv(path.join(__dirname, '.env.local'))

const paths = {
  serverColumns: path.join(repoRoot, 'data', 'generated', 'server_notice_column_profiles.csv'),
  standardColumns: path.join(repoRoot, 'data', 'generated', 'api_column_format_confirmed_draft.csv'),
  sampleRows: path.join(repoRoot, 'data', 'generated', 'server_notice_raw_wide.csv'),
  settingsDir: path.join(repoRoot, 'data', 'settings'),
}

const settingFiles = {
  workflowMap: '작업흐름.csv',
  settingTabs: '설정탭구조.csv',
  apiConfig: '공고수집_API설정.csv',
  deleteKeywords: '삭제키워드.csv',
  biddingFormula: '투찰금액산식.csv',
  bracketRules: '공사명_괄호정리.csv',
  autoValidateRules: '자동검증.csv',
  matcherRules: '매처룰.csv',
  fieldRules: '필드표시룰.csv',
  keywordRules: '키워드룰.csv',
  evaluationCriteria: '적격심사평가기준.csv',
  secondaryCriteria: '적격심사기준_변경.csv',
  orgMap: '적격발주처_변경.csv',
  noticeTags: '공고확인.csv',
  specialRecords: '특수실적.csv',
  specialCommon: '특수실적_공통.csv',
  jongmokMap: '종목_매핑.csv',
  jongmokBundleRules: '종목묶기규칙.csv',
  agencyCode: '발주처코드.csv',
  regionDb: '지역디비.csv',
  wideRegion: '광역시도.csv',
  adjacencyRegion: '인접지역.csv',
  regionMine: '폐광지역진흥지구.csv',
  kepcoOffice: '한전_배전사업소.csv',
  transmissionOffice: '송전사업소.csv',
  powerPlantRegion: '발전소지역.csv',
  regionHint: '지역힌트.csv',
  parserRules: '문서곡괭이_룰.csv',
  newDocumentPickaxeRules: '신문서곡괭이_룰.csv',
  parserTypeGuide: '조건판단형태_가이드.csv',
  sectionRules: '섹션분류_룰.csv',
  bidMethodSkip: '적격심사_제외입찰방식.csv',
  reviewQueue: '검수대기열.csv',
  profileInfo: '프로필.csv',
  excludedItems: '제외종목.csv',
  changelog: '변경로그.csv',
}

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return
  const text = fs.readFileSync(filePath, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx < 0) continue
    const key = trimmed.slice(0, idx).trim()
    const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '')
    if (key && process.env[key] === undefined) process.env[key] = value
  }
}

function readCsv(filePath, limit) {
  const rows = parseCsv(fs.readFileSync(filePath, 'utf8'), limit)
  return typeof limit === 'number' && limit > 0 ? rows.slice(0, limit) : rows
}

function parseCsv(text, limit) {
  const rows = []
  let row = []
  let cell = ''
  let inQuotes = false
  let header = null
  let rowCount = 0

  const pushCell = () => {
    row.push(cell)
    cell = ''
  }
  const pushRow = () => {
    pushCell()
    if (!header) {
      header = row.map((value, index) => (index === 0 ? value.replace(/^\uFEFF/, '') : value))
    } else if (row.some((value) => value !== '')) {
      const obj = {}
      header.forEach((key, index) => {
        obj[key] = row[index] ?? ''
      })
      rows.push(obj)
      rowCount += 1
    }
    row = []
  }

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1]
    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"'
        index += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }
    if (char === ',' && !inQuotes) {
      pushCell()
      continue
    }
    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') index += 1
      pushRow()
      if (limit && rowCount >= limit) break
      continue
    }
    cell += char
  }

  if ((cell || row.length) && (!limit || rowCount < limit)) pushRow()
  return rows
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(body)
}

function sendText(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 20_000_000) {
        reject(new Error('request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function writeCsv(filePath, rows) {
  const headers = rows.length ? Object.keys(rows[0]) : []
  const lines = [headers.join(',')]
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header] ?? '')).join(','))
  }
  fs.writeFileSync(filePath, `\uFEFF${lines.join('\n')}`, 'utf8')
}

function fetchTextLoose(urlString, headers = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString)
    const client = url.protocol === 'https:' ? https : http
    const req = client.request(
      url,
      {
        method: 'GET',
        headers,
        rejectUnauthorized: url.hostname === 'file.bidding2.kr' ? false : undefined,
      },
      (response) => {
        const status = response.statusCode || 0
        const location = response.headers.location
        if (location && status >= 300 && status < 400 && redirects < 5) {
          response.resume()
          const nextUrl = new URL(location, url).toString()
          fetchTextLoose(nextUrl, headers, redirects + 1).then(resolve, reject)
          return
        }
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          resolve({
            status,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )
    req.on('error', reject)
    req.setTimeout(20_000, () => {
      req.destroy(new Error('upstream timeout'))
    })
    req.end()
  })
}

function csvEscape(value) {
  const text = String(value)
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

async function proxyServerNotice(reqUrl, res) {
  const moduleKey = process.env.BID_MODULE_KEY
  if (!moduleKey) {
    sendJson(res, 400, {
      error: 'missing_module_key',
      message: 'BID_MODULE_KEY가 없습니다. app/.env.local 또는 프로젝트 .env.local에 값을 넣어주세요.',
    })
    return
  }

  const target = new URL('https://bidding2.kr/api2/module/dingpago/bidDataOrigin_get.php')
  for (const [key, value] of reqUrl.searchParams.entries()) {
    if (key !== 'moduleKey') target.searchParams.append(key, value)
  }
  target.searchParams.set('moduleKey', moduleKey)

  const upstream = await fetch(target, {
    headers: {
      Accept: 'application/json,text/plain,*/*',
      'User-Agent': 'Mozilla/5.0 bidding-preprocess-local',
    },
  })
  const contentType = upstream.headers.get('content-type') || 'application/octet-stream'
  const body = await upstream.text()
  res.writeHead(upstream.status, {
    'Content-Type': contentType.includes('charset') ? contentType : `${contentType}; charset=utf-8`,
    'Access-Control-Allow-Origin': '*',
  })
  res.end(body)
}

async function parseA3Notice(reqUrl, res) {
  const gongsanum = reqUrl.searchParams.get('gongsanum') || reqUrl.searchParams.get('공고번호')
  const moduleKey = process.env.BID_MODULE_KEY
  if (!moduleKey) {
    sendJson(res, 400, {
      error: 'missing_module_key',
      message: 'BID_MODULE_KEY가 없습니다. A3 파싱용공고문을 호출할 수 없습니다.',
    })
    return
  }
  if (!gongsanum) {
    sendJson(res, 400, { error: 'missing_gongsanum', message: 'gongsanum 또는 공고번호가 필요합니다.' })
    return
  }

  const body = await fetchA3Html(gongsanum, moduleKey)
  sendJson(res, 200, parseNoticeHtml(body, gongsanum))
}

function escapeHtmlText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

async function openA3NoticeHtml(reqUrl, res) {
  const gongsanum = reqUrl.searchParams.get('gongsanum') || reqUrl.searchParams.get('怨듦퀬踰덊샇')
  const moduleKey = process.env.BID_MODULE_KEY
  if (!moduleKey) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><meta charset="utf-8"><body>BID_MODULE_KEY가 없습니다.</body>')
    return
  }
  if (!gongsanum) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><meta charset="utf-8"><body>공고번호가 필요합니다.</body>')
    return
  }
  const body = await fetchA3Html(gongsanum, moduleKey)
  const safeNo = escapeHtmlText(gongsanum)
  const doc = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <title>${safeNo} 파싱용공고문</title>
  <style>
    body { margin: 0; padding: 24px; font-family: "Malgun Gothic", Arial, sans-serif; line-height: 1.55; color: #0f172a; background: #fff; }
    .notice-toolbar { position: sticky; top: 0; z-index: 1; margin: -24px -24px 18px; padding: 12px 18px; border-bottom: 1px solid #d7e0ec; background: #f8fafc; }
    .notice-toolbar strong { font-size: 15px; }
    .notice-body { max-width: 1120px; margin: 0 auto; }
    table { border-collapse: collapse; }
    td, th { border: 1px solid #d7e0ec; padding: 4px 6px; }
  </style>
</head>
<body>
  <div class="notice-toolbar"><strong>${safeNo}</strong> 파싱용공고문</div>
  <main class="notice-body">${body || '<p>공고문 내용이 없습니다.</p>'}</main>
</body>
</html>`
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(doc)
}

async function normalizeA3Notice(reqUrl, res) {
  const gongsanum = reqUrl.searchParams.get('gongsanum') || reqUrl.searchParams.get('공고번호')
  const moduleKey = process.env.BID_MODULE_KEY
  if (!moduleKey) {
    sendJson(res, 400, {
      error: 'missing_module_key',
      message: 'BID_MODULE_KEY가 없습니다. A3 파싱용공고문을 호출할 수 없습니다.',
    })
    return
  }
  if (!gongsanum) {
    sendJson(res, 400, { error: 'missing_gongsanum', message: 'gongsanum 또는 공고번호가 필요합니다.' })
    return
  }

  const body = await fetchA3Html(gongsanum, moduleKey)
  const normalized = normalizeNoticeDocument(body)
  const parsed = parseNoticeHtml(body, gongsanum)
  sendJson(res, 200, {
    공고번호: gongsanum,
    htmlLength: body.length,
    textLength: normalized.normalizedText.length,
    normalized,
    parserSummary: {
      fields: parsed.fields,
      matches: parsed.matches,
      fieldCount: Object.keys(parsed.fields ?? {}).length,
      matchCount: parsed.matches?.length ?? 0,
    },
  })
}

async function fetchA3Html(gongsanum, moduleKey) {
  const target = new URL('https://bidding2.kr/api2/module/consortiumAPI/bidHwp_get.php')
  target.searchParams.set('gongsanum', gongsanum)
  target.searchParams.set('moduleKey', moduleKey)
  const first = await fetch(target, {
    headers: { Accept: 'text/html,text/plain,*/*', 'User-Agent': 'Mozilla/5.0 bidding-preprocess-local' },
  })
  let body = await first.text()
  const maybeUrl = body.trim()
  if (/^https?:\/\//i.test(maybeUrl)) {
    const htmlRes = await fetchTextLoose(maybeUrl, {
      Accept: 'text/html,text/plain,*/*',
      'User-Agent': 'Mozilla/5.0 bidding-preprocess-local',
    })
    body = htmlRes.body
  }
  return body
}

async function proxyBidFiles(reqUrl, res) {
  const gongsanum = reqUrl.searchParams.get('gongsanum') || reqUrl.searchParams.get('공고번호')
  const moduleKey = process.env.BID_MODULE_KEY
  if (!moduleKey) {
    sendJson(res, 400, {
      error: 'missing_module_key',
      message: 'BID_MODULE_KEY가 없습니다. 공고문첨부파일을 호출할 수 없습니다.',
    })
    return
  }
  if (!gongsanum) {
    sendJson(res, 400, { error: 'missing_gongsanum', message: 'gongsanum 또는 공고번호가 필요합니다.' })
    return
  }
  const target = new URL('https://bidding2.kr/api2/module/consortiumAPI/bidFile_get.php')
  target.searchParams.set('gongsanum', gongsanum)
  target.searchParams.set('moduleKey', moduleKey)
  const upstream = await fetchTextLoose(target.toString(), {
    Accept: 'application/json,text/plain,*/*',
    'User-Agent': 'Mozilla/5.0 bidding-preprocess-local',
  })
  sendJson(res, 200, { rows: normalizeBidFiles(upstream.body), raw: upstream.body })
}

function normalizeBidFiles(body) {
  let data = null
  try {
    data = JSON.parse(body)
  } catch (_) {
    return []
  }
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.rows)
      ? data.rows
      : Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.files)
          ? data.files
          : []
  return list
    .map((item, index) => {
      const row = item && typeof item === 'object' ? item : { url: String(item || '') }
      const name =
        row.fileName ||
        row.filename ||
        row.name ||
        row.파일명 ||
        row.첨부파일명 ||
        row.orgFileName ||
        `첨부파일_${index + 1}`
      const url = row.url || row.fileUrl || row.href || row.다운로드URL || row.downloadUrl || row.path || ''
      return { id: String(index + 1), 파일명: String(name || '').trim(), URL: String(url || '').trim(), 원본: row }
    })
    .filter((row) => row.파일명 || row.URL)
}

async function documentPickaxeTest(req, res) {
  const raw = await readBody(req)
  const data = JSON.parse(raw || '{}')
  const gongsanum = String(data.gongsanum || data.공고번호 || 'SAMPLE').trim()
  const inlineBody = String(data.body || data.html || '').trim()

  if (inlineBody) {
    sendJson(res, 200, parseNoticeHtml(inlineBody, gongsanum))
    return
  }

  if (!gongsanum || gongsanum === 'SAMPLE') {
    sendJson(res, 400, { error: 'missing_body', message: '본문 또는 공고번호가 필요합니다.' })
    return
  }

  const moduleKey = process.env.BID_MODULE_KEY
  if (!moduleKey) {
    sendJson(res, 400, {
      error: 'missing_module_key',
      message: 'BID_MODULE_KEY가 없어 A3 공고번호 테스트를 실행할 수 없습니다. 본문 붙여넣기 테스트는 가능합니다.',
    })
    return
  }

  const body = await fetchA3Html(gongsanum, moduleKey)
  sendJson(res, 200, parseNoticeHtml(body, gongsanum))
}

async function documentPickaxeRuleTest(req, res) {
  const raw = await readBody(req)
  const data = JSON.parse(raw || '{}')
  const rule = data.rule && typeof data.rule === 'object' ? data.rule : null
  const body = String(data.body || data.html || rule?.['예시본문'] || '').trim()
  if (!rule) {
    sendJson(res, 400, { error: 'missing_rule', message: '테스트할 문서곡괭이 룰이 필요합니다.' })
    return
  }
  if (!body) {
    sendJson(res, 400, { error: 'missing_body', message: '예시본문 또는 본문이 필요합니다.' })
    return
  }

  const normalized = normalizeNoticeHtml(body)
  const fields = {}
  const evidence = {}
  const matches = []
  applyEditableParserRules(normalized.text, normalized.blocks, fields, evidence, matches, [rule])
  sendJson(res, 200, {
    공고번호: 'RULE_TEST',
    htmlLength: body.length,
    textLength: normalized.text.length,
    fields,
    evidence,
    matches,
    textPreview: normalized.text,
  })
}

async function documentPickaxeBatchTest(req, res) {
  const raw = await readBody(req)
  const data = JSON.parse(raw || '{}')
  const gongsanum = String(data.gongsanum || data.공고번호 || '').trim()
  const rows = Array.isArray(data.rows) ? data.rows : []
  if (!gongsanum) {
    sendJson(res, 400, { error: 'missing_gongsanum', message: '공고번호가 필요합니다.' })
    return
  }
  const moduleKey = process.env.BID_MODULE_KEY
  if (!moduleKey) {
    sendJson(res, 400, {
      error: 'missing_module_key',
      message: 'BID_MODULE_KEY가 없어 A3 공고번호 테스트를 실행할 수 없습니다.',
    })
    return
  }

  const body = await fetchA3Html(gongsanum, moduleKey)
  const normalized = normalizeNoticeHtml(body)
  const fields = {}
  const evidence = {}
  const matches = []
  const executableRows = cleanNewDocumentPickaxeRows(rows).filter((row) =>
    String(row['조건판단형태'] || '').trim() && String(row['검색키워드'] || '').trim(),
  )
  applyEditableParserRules(normalized.text, normalized.blocks, fields, evidence, matches, executableRows)
  sendJson(res, 200, {
    공고번호: gongsanum,
    htmlLength: body.length,
    textLength: normalized.text.length,
    fields,
    evidence,
    matches,
    testedRows: executableRows.length,
  })
}

async function proxyQualification(reqUrl, res) {
  const detail = reqUrl.searchParams.get('적격기준세부') || reqUrl.searchParams.get('detail') || ''
  const construction = reqUrl.searchParams.get('건설') || reqUrl.searchParams.get('construction') || '일반건설'
  if (!detail) {
    sendJson(res, 400, { error: 'missing_detail', message: '적격기준세부 값이 필요합니다.' })
    return
  }

  const target = new URL('https://file.bidding2.kr/api/calculator/qualification.php')
  target.searchParams.set('적격기준세부', detail)
  target.searchParams.set('건설', construction)
  const upstream = await fetchTextLoose(target.toString(), {
    Accept: 'application/json,text/plain,*/*',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  })
  try {
    sendJson(res, 200, JSON.parse(upstream.body))
  } catch {
    sendJson(res, 502, {
      error: 'bad_qualification_response',
      message: upstream.body.slice(0, 500),
    })
  }
}

function parseNoticeHtml(html, gongsanum) {
  const normalized = normalizeNoticeHtml(html)
  const text = normalized.text
  const blocks = normalized.blocks
  const fields = {}
  const evidence = {}
  const matches = []

  const editableRules = readParserRuleRows()
  if (editableRules.length) {
    applyEditableParserRules(text, blocks, fields, evidence, matches, editableRules)
  }

  applySettingKeywordRules(text, blocks, fields, evidence, matches)

  if (text) {
    fields['공고본문'] = text.slice(0, 5000)
  }

  return {
    공고번호: gongsanum,
    htmlLength: html.length,
    textLength: text.length,
    fields,
    evidence,
    matches,
    html: sanitizeNoticeHtml(html),
    textPreview: text.slice(0, 5000),
  }
}

function normalizeNoticeDocument(html) {
  const imageCount = (String(html || '').match(/<img\b/gi) || []).length
  const source = decodeHtmlEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<\/(tr|p|div|li|h[1-6])\s*>/gi, '\n')
      .replace(/<(br)\b[^>]*>/gi, '\n')
      .replace(/<\/(td|th)\s*>/gi, ' | ')
      .replace(/<[^>]+>/g, ' '),
  )
  const rawLines = source
    .split(/\r?\n/)
    .map((line) => normalizeLine(line))
    .filter(Boolean)
    .filter((line) => !/^\.(hwpBody|contents|Section)/i.test(line) && !/^@page\b/i.test(line))
  if (!rawLines.length && imageCount) {
    rawLines.push(`이미지형 공고문: 텍스트 추출 불가, 이미지 ${imageCount}개`)
  }
  const softBlocks = mergeSoftWrappedLines(rawLines)
  const hardBlocks = softBlocks.map((text, index) => {
    const numbering = detectNumbering(text)
    return {
      순번: index + 1,
      유형: classifyBlock(text, numbering),
      번호: numbering?.번호 ?? '',
      계층: numbering?.계층 ?? '',
      제목: numbering?.제목 ?? '',
      원문: text,
      길이: text.length,
    }
  })
  const sections = classifySections(buildSections(hardBlocks), readSectionRuleRows())
  const tables = detectTables(rawLines)
  return {
    rawLines,
    softBlocks,
    hardBlocks,
    sections,
    tables,
    imageCount,
    warnings: !rawLines.length || rawLines[0]?.startsWith('이미지형 공고문') ? ['본문 텍스트 없음: 이미지 OCR 또는 사람 확인 필요'] : [],
    normalizedText: softBlocks.join('\n'),
  }
}

function normalizeLine(line) {
  return String(line || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+\|/g, ' |')
    .replace(/\|\s+/g, '| ')
    .trim()
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
}

function mergeSoftWrappedLines(lines) {
  const blocks = []
  for (const line of lines) {
    const previous = blocks[blocks.length - 1] || ''
    const startsNew = isHardStart(line)
    const previousEnds = /[.。:：;；)]$/.test(previous) || previous.endsWith('다') || previous.includes('|')
    if (!previous || startsNew || previousEnds || line.includes('|')) {
      blocks.push(line)
    } else {
      blocks[blocks.length - 1] = `${previous} ${line}`.replace(/\s+/g, ' ').trim()
    }
  }
  return blocks
}

function isHardStart(line) {
  return /^(\d+[\).\-\s]|[가-힣]\.|[가-힣]\)|[①-⑳]|[㉠-㉭]|제\s*\d+\s*조|\[[^\]]+\])/.test(line)
}

function detectNumbering(text) {
  const match = String(text || '').match(/^((?:\d+(?:[.)-]|\s+))|(?:[가-힣][.)])|(?:[①-⑳])|(?:[㉠-㉭])|(?:제\s*\d+\s*조))\s*(.*)$/)
  if (!match) return null
  const 번호 = match[1].trim()
  return { 번호, 계층: numberingLevel(번호), 제목: (match[2] || '').slice(0, 80).trim() }
}

function numberingLevel(no) {
  const value = String(no || '').trim()
  if (/^\d+[.]$/.test(value)) return 1
  if (/^[가-힣][.]$/.test(value)) return 2
  if (/^\d+[)]$/.test(value)) return 3
  if (/^[가-힣][)]$/.test(value)) return 4
  if (/^[①-⑳]$/.test(value)) return 4
  if (/^[㉠-㉭]$/.test(value)) return 5
  if (/^제\s*\d+\s*조/.test(value)) return 1
  if (/^\d+$/.test(value)) return 1
  return 9
}

function classifyBlock(text, numbering) {
  if (String(text).includes('|')) return '표후보'
  if (numbering) return '번호문단'
  if (/^(붙임|첨부|별첨|별표|서식)\b/.test(text)) return '첨부/붙임'
  if (text.length <= 30 && /[:：]$/.test(text)) return '제목'
  return '문단'
}

function buildSections(blocks) {
  const sections = []
  let current = null
  let currentMajor = null
  for (const block of blocks) {
    if (block.번호 || block.유형 === '제목') {
      if (current) sections.push(current)
      const level = Number(block.계층 || 1)
      if ((block.번호 && level === 1) || !currentMajor) {
        currentMajor = {
          번호: block.번호,
          제목: block.제목 || block.원문.slice(0, 80),
          시작블록: block.순번,
        }
      }
      current = {
        순번: sections.length + 1,
        번호: block.번호,
        계층: level,
        대섹션번호: currentMajor?.번호 || block.번호,
        대섹션제목: currentMajor?.제목 || block.제목 || block.원문.slice(0, 80),
        제목: block.제목 || block.원문.slice(0, 80),
        시작블록: block.순번,
        종료블록: block.순번,
        내용미리보기: block.원문,
      }
      continue
    }
    if (current) {
      current.종료블록 = block.순번
      current.내용미리보기 = `${current.내용미리보기} ${block.원문}`.slice(0, 260)
    }
  }
  if (current) sections.push(current)
  return sections
}

function readSectionRuleRows() {
  try {
    return readCsv(path.join(paths.settingsDir, settingFiles.sectionRules))
      .filter((row) => String(row['사용여부'] ?? '1').trim().toLowerCase() !== 'false' && String(row['사용여부'] ?? '1').trim() !== '0')
      .sort((a, b) => (Number(a['우선순위']) || Number(a.id) || 0) - (Number(b['우선순위']) || Number(b.id) || 0))
  } catch {
    return []
  }
}

function splitKeywords(value) {
  return String(value || '')
    .split(/[,\n/]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function findKeyword(text, keywords) {
  const haystack = String(text || '').replace(/\s+/g, '')
  return keywords.find((keyword) => haystack.includes(String(keyword || '').replace(/\s+/g, ''))) || ''
}

function classifySections(sections, rules) {
  if (!rules.length) return sections
  return sections.map((section) => {
    const title = `${section.번호 || ''} ${section.제목 || ''}`
    const body = `${section.내용미리보기 || ''}`
    const allText = `${title} ${body}`
    for (const rule of rules) {
      const exclude = findKeyword(allText, splitKeywords(rule['제외키워드']))
      if (exclude) {
        const titleHit = findKeyword(title, splitKeywords(rule['제목키워드']))
        const bodyHit = findKeyword(body, splitKeywords(rule['본문키워드']))
        if (titleHit || bodyHit) {
          return {
            ...section,
            섹션분류: '',
            분류근거: titleHit ? `제목:${titleHit}` : `본문:${bodyHit}`,
            제외여부: `제외:${exclude}`,
          }
        }
        continue
      }
      const titleHit = findKeyword(title, splitKeywords(rule['제목키워드']))
      if (titleHit) {
        return {
          ...section,
          섹션분류: String(rule['섹션분류'] || ''),
          분류근거: `제목:${titleHit}`,
          제외여부: '',
        }
      }
      const bodyHit = findKeyword(body, splitKeywords(rule['본문키워드']))
      if (bodyHit) {
        return {
          ...section,
          섹션분류: String(rule['섹션분류'] || ''),
          분류근거: `본문:${bodyHit}`,
          제외여부: '',
        }
      }
    }
    return { ...section, 섹션분류: '', 분류근거: '', 제외여부: '' }
  })
}

function detectTables(lines) {
  const tables = []
  let current = []
  const flush = () => {
    if (current.length >= 2) {
      const rows = current.map((line) => line.split('|').map((cell) => cell.trim()).filter(Boolean))
      const widths = rows.map((row) => row.length)
      tables.push({
        순번: tables.length + 1,
        유형: Math.max(...widths) >= 3 ? '가로형/복합형 후보' : '세로형 후보',
        행수: rows.length,
        열수: Math.max(...widths),
        헤더: rows[0]?.join(' / ') ?? '',
        첫값행: rows[1]?.join(' / ') ?? '',
        경고: new Set(widths).size > 1 ? '행별 열 수 다름' : '',
      })
    }
    current = []
  }
  for (const line of lines) {
    if (line.includes('|')) current.push(line)
    else flush()
  }
  flush()
  return tables
}

function readParserRuleRows() {
  try {
    return readCsv(path.join(paths.settingsDir, settingFiles.parserRules))
      .filter((row) => String(row['사용여부'] ?? 'true').trim().toLowerCase() !== 'false')
      .sort((a, b) => (Number(a['우선순위']) || Number(a.id) || 0) - (Number(b['우선순위']) || Number(b.id) || 0))
  } catch {
    return []
  }
}

function readNewDocumentPickaxeRows() {
  const filePath = path.join(paths.settingsDir, settingFiles.newDocumentPickaxeRules)
  const storedRows = fs.existsSync(filePath) ? readCsv(filePath) : []
  const byItem = new Map(storedRows.map((row) => [String(row['항목'] || '').trim(), row]))
  const standardItems = readCsv(paths.standardColumns)
    .map((row) => String(row['항목'] || '').trim())
    .filter(Boolean)
  const rows = []
  const seen = new Set()
  for (const item of standardItems) {
    const existing = byItem.get(item)
    rows.push({
      항목: item,
      조건판단형태: String(existing?.['조건판단형태'] || ''),
      검색키워드: String(existing?.['검색키워드'] || ''),
      제외키워드: String(existing?.['제외키워드'] || ''),
      고정값: String(existing?.['고정값'] || ''),
      금액선택방식: String(existing?.['금액선택방식'] || ''),
      결과값: '',
    })
    seen.add(item)
  }
  for (const row of storedRows) {
    const item = String(row['항목'] || '').trim()
    if (!item || seen.has(item)) continue
    rows.push({
      항목: item,
      조건판단형태: String(row['조건판단형태'] || ''),
      검색키워드: String(row['검색키워드'] || ''),
      제외키워드: String(row['제외키워드'] || ''),
      고정값: String(row['고정값'] || ''),
      금액선택방식: String(row['금액선택방식'] || ''),
      결과값: '',
    })
  }
  return rows
}

function cleanNewDocumentPickaxeRows(rows) {
  return rows.map((row) => ({
    항목: String(row['항목'] || '').trim(),
    조건판단형태: String(row['조건판단형태'] || ''),
    검색키워드: String(row['검색키워드'] || ''),
    제외키워드: String(row['제외키워드'] || ''),
    고정값: String(row['고정값'] || ''),
    금액선택방식: String(row['금액선택방식'] || ''),
  })).filter((row) => row.항목)
}

function normalizeNoticeHtml(html) {
  const document = normalizeNoticeDocument(html)
  const lines = document.softBlocks
  return {
    text: lines.join(' ').replace(/\s+/g, ' ').trim(),
    blocks: lines,
  }
}

function addParserField(fields, evidence, matches, match) {
  if (!match.value) return
  const current = String(fields[match.column] || '').trim()
  const values = current ? current.split('/').filter(Boolean) : []
  if (!values.includes(String(match.value))) values.push(String(match.value))
  fields[match.column] = values.join('/')

  const evidenceLine = `[${match.settingTable} ${match.type} rule=${match.ruleId}] ${match.matchedKeyword}\n${match.sourceText}`
  evidence[match.column] = evidence[match.column] ? `${evidence[match.column]}\n\n${evidenceLine}` : evidenceLine
  matches.push({
    column: match.column,
    value: String(match.value),
    type: match.type,
    settingTable: match.settingTable,
    ruleId: String(match.ruleId ?? ''),
    matchedKeyword: match.matchedKeyword,
    sourceText: match.sourceText,
  })
}

function applyEditableParserRules(text, blocks, fields, evidence, matches, rules) {
  for (const rule of rules) {
    const column = String(rule['대상컬럼'] || rule['항목'] || '').trim()
    const types = splitRuleTypes(rule['조건판단형태'] || rule.type || '')
    if (!column || !types.length) continue

    for (const type of types) {
      if (type === '7_1') continue
      const parsed = extractByParserRule(text, blocks, rule, type)
      if (!parsed || !parsed.value) continue
      addParserField(fields, evidence, matches, {
        column,
        value: parsed.value,
        type,
        settingTable: '문서곡괭이_룰',
        ruleId: rule.id || column,
        matchedKeyword: parsed.matchedKeyword,
        sourceText: parsed.sourceText,
      })
      break
    }
  }
}

function splitRuleTypes(value) {
  return String(value || '')
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function extractByParserRule(text, blocks, rule, type) {
  if (type === '4_3') {
    const keywords = splitRuleKeywords(rule['검색키워드'])
    const hit = keywords.length ? findFirstAvailableHit(text, blocks, keywords, splitRuleKeywords(rule['제외키워드']), Number(rule.gap) || 15) : null
    const context = hit?.sourceText || collectKeywordContext(text, keywords, Number(rule['문맥범위']) || 1300)
    const found = findJongmokCandidates(context)
    if (!found.length) return null
    return {
      value: Array.from(new Set(found)).join('/'),
      matchedKeyword: hit?.matchedKeyword || '종목마스터',
      sourceText: context || sourceAround(text, 0),
    }
  }

  const hit = findFirstAvailableHit(text, blocks, splitRuleKeywords(rule['검색키워드']), splitRuleKeywords(rule['제외키워드']), Number(rule.gap) || 15)
  if (!hit) return null

  const fixedValue = fixedValueForRule(rule, hit.matchedKeyword)
  if (type === '3_1') {
    return { value: fixedValue || '1', matchedKeyword: hit.matchedKeyword, sourceText: hit.sourceText }
  }
  if (type === '3_2') {
    return { value: fixedValue || hit.aliasLabel || aliasValue(hit.matchedKeyword) || hit.matchedKeyword, matchedKeyword: hit.matchedKeyword, sourceText: hit.sourceText }
  }
  if (type === '2_2') {
    return { value: hit.matchedText, matchedKeyword: hit.matchedKeyword, sourceText: hit.sourceText }
  }
  if (type === '2_3') {
    return { value: hit.sourceText, matchedKeyword: hit.matchedKeyword, sourceText: hit.sourceText }
  }
  if (type === '2_1') {
    return { value: cleanShortValue(textAfterKeyword(hit.sourceText, hit.matchedText)), matchedKeyword: hit.matchedKeyword, sourceText: hit.sourceText }
  }
  if (type === '1_1') {
    const date = hit.sourceText.match(/(\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}|\d{2}[.\-/]\d{1,2}[.\-/]\d{1,2})/)
    return date ? { value: normalizeDateValue(date[1]), matchedKeyword: hit.matchedKeyword, sourceText: hit.sourceText } : null
  }
  if (type === '1_2') {
    const money = pickMoneyValue(hit.sourceText, rule)
    return money ? { value: money, matchedKeyword: hit.matchedKeyword, sourceText: hit.sourceText } : null
  }
  if (type === '1_3') {
    const phone = hit.sourceText.match(/0\d{1,2}[-.\s]\d{3,4}[-.\s]\d{4}/)
    return phone ? { value: phone[0].replace(/[.\s]+/g, '-'), matchedKeyword: hit.matchedKeyword, sourceText: hit.sourceText } : null
  }
  if (type === '1_4') {
    const rate = extractRate(hit.sourceText)
    return rate ? { value: rate, matchedKeyword: hit.matchedKeyword, sourceText: hit.sourceText } : null
  }
  return null
}

function pickMoneyValue(sourceText, rule) {
  const mode = String(rule['금액선택방식'] || '').trim()
  const moneyPattern = /([\d,]{6,})\s*원?/g
  if (mode === '공사비_괄호안금액') {
    const parenMoney = [...String(sourceText || '').matchAll(/\(([\d,]{6,})\s*원?\)/g)]
    if (parenMoney.length) return parenMoney[parenMoney.length - 1][1].replace(/,/g, '')
  }
  const first = moneyPattern.exec(String(sourceText || ''))
  return first ? first[1].replace(/,/g, '') : ''
}

function findFirstAvailableHit(text, blocks, keywords, excludeKeywords, gap = 15) {
  for (const keyword of keywords) {
    const hit = findKeywordHit(text, blocks, keyword, gap)
    if (!hit) continue
    if (isHitExcluded(hit.sourceText, excludeKeywords)) continue
    return { ...hit, matchedKeyword: keyword }
  }
  return null
}

function fixedValueForRule(rule, matchedKeyword) {
  const raw = String(rule['고정값'] || '').trim()
  if (!raw) return ''
  if (raw.startsWith('{')) {
    try {
      const map = JSON.parse(raw)
      return map[matchedKeyword] || ''
    } catch {
      return raw
    }
  }
  return raw
}

function aliasValue(keyword) {
  const match = String(keyword).match(/^\(([^:]+):(.+)\)$/)
  return match ? match[1].trim() : ''
}

function textAfterKeyword(sourceText, matchedText) {
  const index = sourceText.indexOf(matchedText)
  if (index < 0) return sourceText
  return sourceText.slice(index + matchedText.length).replace(/^[:：\s\-]+/, '').trim()
}

function normalizeDateValue(raw) {
  const parts = String(raw).split(/[.\-/]/).map((part) => part.padStart(2, '0'))
  if (parts.length !== 3) return raw
  const year = parts[0].length === 2 ? `20${parts[0]}` : parts[0]
  return `${year}-${parts[1]}-${parts[2]}`
}

function extractRate(text) {
  const percent = text.match(/(\d+(?:\.\d+)?)\s*%/)
  if (percent) return `${percent[1]}%`
  const fraction = text.match(/(\d+)\s*분의\s*(\d+)/)
  if (!fraction) return ''
  const denominator = Number(fraction[1])
  const numerator = Number(fraction[2])
  if (!denominator) return ''
  return `${Math.round((numerator / denominator) * 10000) / 100}%`
}

function applySettingKeywordRules(text, blocks, fields, evidence, matches) {
  const groups = [
    { key: 'noticeTags', column: '공고확인', label: '공고확인', type: '7_1' },
    { key: 'specialRecords', column: '특수실적', label: '특수실적', type: '7_1' },
    { key: 'specialCommon', column: '특수실적_공통', label: '특수실적_공통', type: '7_1' },
  ]

  for (const group of groups) {
    const fileName = settingFiles[group.key]
    if (!fileName) continue
    const rows = readCsv(path.join(paths.settingsDir, fileName))
    for (const row of rows) {
      const value = String(row['결과값'] || '').trim()
      const keywords = splitRuleKeywords(row['검색키워드'])
      if (!value || keywords.length === 0) continue

      const excludeKeywords = splitRuleKeywords(row['제외키워드'])
      for (const keyword of keywords) {
        const hit = findKeywordHit(text, blocks, keyword)
        if (!hit) continue
        if (isHitExcluded(hit.sourceText, excludeKeywords)) continue
        addParserField(fields, evidence, matches, {
          column: group.column,
          value,
          type: group.type,
          settingTable: group.label,
          ruleId: row.id || value,
          matchedKeyword: keyword,
          sourceText: hit.sourceText,
        })
        break
      }
    }
  }
}

function splitRuleKeywords(value) {
  return String(value || '')
    .split(/\r?\n|[;；]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function findKeywordHit(text, blocks, keyword, gap = 15) {
  const alias = parseAliasKeyword(keyword)
  if (alias) {
    for (const candidate of alias.candidates) {
      const hit = findKeywordHit(text, blocks, candidate, gap)
      if (hit) return { ...hit, aliasLabel: alias.label }
    }
    return null
  }

  const regex = keywordToRegex(keyword, gap)
  for (const block of blocks) {
    const match = block.match(regex)
    if (match) {
      return {
        index: text.indexOf(block),
        sourceText: block,
        matchedText: match[0],
        aliasLabel: '',
      }
    }
  }
  const match = text.match(regex)
  if (!match) return null
  return {
    index: match.index ?? 0,
    sourceText: sourceAround(text, match.index ?? 0, 360),
    matchedText: match[0],
    aliasLabel: '',
  }
}

function parseAliasKeyword(keyword) {
  const match = String(keyword || '').trim().match(/^\(([^:]+):(.+)\)$/)
  if (!match) return null
  return {
    label: match[1].trim(),
    candidates: match[2].split('/').map((item) => item.trim()).filter(Boolean),
  }
}

function keywordToRegex(keyword, gap = 15) {
  const escaped = String(keyword || '')
    .trim()
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*'))
    .join(`[\\s\\S]{0,${gap}}`)
  return new RegExp(escaped, 'i')
}

function isHitExcluded(sourceText, excludeKeywords) {
  return excludeKeywords.some((keyword) => keywordToRegex(keyword).test(sourceText))
}

function sanitizeNoticeHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '')
    .replace(/\son\w+='[^']*'/gi, '')
    .replace(/\s(href|src)=["']javascript:[^"']*["']/gi, '')
}

function pickKeyword(text, keywords) {
  return keywords.find((keyword) => text.includes(keyword)) || ''
}

function cleanShortValue(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+\d+\)\s.*$/, '')
    .trim()
}

function findJongmokCandidates(contextText) {
  const context = String(contextText || '')
  const patterns = readJongmokPatternSettings()
  const found = []
  for (const item of patterns) {
    if (item.regex.test(context)) found.push(item.value)
  }
  return Array.from(new Set(found))
}

function readJongmokPatternSettings() {
  const rows = readCsv(path.join(paths.settingsDir, settingFiles.jongmokMap))
  const patterns = []
  for (const row of rows) {
    const value = String(row['업종'] || row['주력업종'] || '').trim()
    if (!value) continue
    for (const alias of jongmokAliases(row)) {
      patterns.push({
        value,
        alias,
        regex: aliasToLooseRegex(alias),
      })
    }
  }
  return patterns.sort((a, b) => b.alias.length - a.alias.length)
}

function jongmokAliases(row) {
  const rawValues = [
    row['원본 (등록증 표기)'],
    row['업종'],
    row['주력업종'],
  ]
  const aliases = rawValues
    .flatMap((value) => splitSettingTokens(value))
    .map((value) => value.trim())
    .filter(Boolean)
  return Array.from(new Set(aliases))
}

function splitSettingTokens(value) {
  return String(value || '')
    .split(/[;\n]/)
    .flatMap((part) => part.split(/\s*\/\s*/))
    .map((part) => part.trim())
    .filter(Boolean)
}

function aliasToLooseRegex(alias) {
  const escaped = String(alias || '')
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/[·ㆍ‧,.\-\s]+/g, '[\\s·ㆍ‧,\\.\\-]*')
  return new RegExp(escaped, 'i')
}

function collectKeywordContext(text, keywords, size = 1300) {
  const parts = []
  for (const keyword of keywords) {
    const normalizedKeyword = String(keyword || '').replace(/\*/g, '').trim()
    if (!normalizedKeyword) continue
    let start = text.indexOf(normalizedKeyword)
    while (start >= 0 && parts.length < 12) {
      parts.push(sourceAround(text, start, size))
      start = text.indexOf(normalizedKeyword, start + normalizedKeyword.length)
    }
  }
  return parts.join(' ')
}

function sourceAround(text, index, size = 260) {
  const start = Math.max(0, index - 80)
  return text.slice(start, start + size).trim()
}

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url) return sendJson(res, 400, { error: 'bad_request' })
    if (req.method === 'OPTIONS') return sendText(res, 200, '')

    const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

    if (reqUrl.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, hasModuleKey: Boolean(process.env.BID_MODULE_KEY) })
      return
    }

    if (reqUrl.pathname === '/api/schema/server-columns') {
      sendJson(res, 200, { rows: readCsv(paths.serverColumns) })
      return
    }

    if (reqUrl.pathname === '/api/schema/standard-columns') {
      if (req.method === 'POST') {
        const body = await readBody(req)
        const data = JSON.parse(body || '{}')
        const rows = Array.isArray(data.rows) ? data.rows : []
        writeCsv(paths.standardColumns, rows)
        sendJson(res, 200, { ok: true, rows })
        return
      }
      sendJson(res, 200, { rows: readCsv(paths.standardColumns) })
      return
    }

    if (reqUrl.pathname === '/api/local/server-notices') {
      const limit = Number(reqUrl.searchParams.get('limit') || 300)
      sendJson(res, 200, { rows: readCsv(paths.sampleRows, limit), source: 'local-sample' })
      return
    }

    if (reqUrl.pathname.startsWith('/api/settings/')) {
      const key = decodeURIComponent(reqUrl.pathname.replace('/api/settings/', ''))
      const fileName = settingFiles[key]
      if (!fileName) {
        sendJson(res, 404, { error: 'unknown_setting', message: `알 수 없는 설정 데이터: ${key}` })
        return
      }
      if (req.method === 'POST') {
        const body = await readBody(req)
        const data = JSON.parse(body || '{}')
        const rows = key === 'newDocumentPickaxeRules'
          ? cleanNewDocumentPickaxeRows(Array.isArray(data.rows) ? data.rows : [])
          : Array.isArray(data.rows) ? data.rows : []
        writeCsv(path.join(paths.settingsDir, fileName), rows)
        sendJson(res, 200, { ok: true, rows, source: fileName })
        return
      }
      if (key === 'newDocumentPickaxeRules') {
        sendJson(res, 200, { rows: readNewDocumentPickaxeRows(), source: fileName })
        return
      }
      sendJson(res, 200, { rows: readCsv(path.join(paths.settingsDir, fileName)), source: fileName })
      return
    }

    if (reqUrl.pathname === '/api/bid') {
      await proxyServerNotice(reqUrl, res)
      return
    }

    if (reqUrl.pathname === '/api/parser/a3') {
      await parseA3Notice(reqUrl, res)
      return
    }

    if (reqUrl.pathname === '/api/parser/a3/html') {
      await openA3NoticeHtml(reqUrl, res)
      return
    }

    if (reqUrl.pathname === '/api/parser/normalize') {
      await normalizeA3Notice(reqUrl, res)
      return
    }

    if (reqUrl.pathname === '/api/bid-files') {
      await proxyBidFiles(reqUrl, res)
      return
    }

    if (reqUrl.pathname === '/api/document-pickaxe/test' && req.method === 'POST') {
      await documentPickaxeTest(req, res)
      return
    }

    if (reqUrl.pathname === '/api/document-pickaxe/rule-test' && req.method === 'POST') {
      await documentPickaxeRuleTest(req, res)
      return
    }

    if (reqUrl.pathname === '/api/document-pickaxe/batch-test' && req.method === 'POST') {
      await documentPickaxeBatchTest(req, res)
      return
    }

    if (reqUrl.pathname === '/api/qualification') {
      await proxyQualification(reqUrl, res)
      return
    }

    sendJson(res, 404, { error: 'not_found' })
  } catch (error) {
    sendJson(res, 500, {
      error: 'server_error',
      message: error instanceof Error ? error.message : String(error),
    })
  }
})

server.listen(port, () => {
  console.log(`[api] listening on http://127.0.0.1:${port}`)
})
