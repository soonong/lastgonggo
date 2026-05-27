export type NoticeRow = Record<string, unknown>

export type ServerColumnProfile = {
  순번: string
  항목: string
  추정입력형식: string
  권장표시형식: string
  추정이유: string
  원본타입분포: string
  전체건수: string
  빈값수: string
  빈값비율: string
  고유값수: string
  예시값: string
  상위값: string
}

export type StandardColumnRule = {
  id: string
  항목: string
  표시형식: string
  처리방법: string
  우선순위: string
  참조방법: string
  참조메모: string
  선택목록: string
  '공고관리 표시': string
  상세정보입력: string
  서버공고일치: string
  확정메모: string
}

export type ApiEnvelope<T> = {
  rows?: T[]
  source?: string
  error?: string
  message?: string
}

export type ParserResult = {
  공고번호: string
  htmlLength: number
  textLength: number
  fields: Record<string, string>
  evidence: Record<string, string>
  matches?: Array<{
    column: string
    value: string
    type: string
    settingTable: string
    ruleId: string
    matchedKeyword: string
    sourceText: string
  }>
  html?: string
  textPreview?: string
}

export type ParserNormalizationResult = {
  공고번호: string
  htmlLength: number
  textLength: number
  normalized: {
    rawLines: string[]
    softBlocks: string[]
    hardBlocks: NoticeRow[]
    sections: NoticeRow[]
    tables: NoticeRow[]
    imageCount: number
    warnings: string[]
    normalizedText: string
  }
  parserSummary: {
    fields: Record<string, string>
    matches?: ParserResult['matches']
    fieldCount: number
    matchCount: number
  }
}
