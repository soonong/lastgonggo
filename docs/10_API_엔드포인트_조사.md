# API 엔드포인트 조사

조사일: 2026-05-22

## 조사 원칙

API 응답은 원본으로 보관하고, 전처리 단계에서 표준 컬럼으로 변환한다.

예시:

```text
원본 API `공사명`은 그대로 저장한다.
표준 컬럼 `공고명`에는 매핑된 값을 따로 저장한다.
```

## 샘플 공고번호

| 구분 | 공고번호 | 확인 결과 |
|---|---|---|
| G2B 계열 예시 | `R26BK01537599-000` | 첨부파일 JSON, 공고문 HTML URL 확인 |
| LH 계열 예시 | `2601767-00` | 첨부파일 JSON, 텍스트형 공고문 HTML, 기본정보 API 확인 |

## 엔드포인트 이름

| ID | 이름 | 엔드포인트 | 역할 | 현재 확인 결과 |
|---|---|---|---|---|
| A1 | 서버공고 | `https://bidding2.kr/api2/module/dingpago/bidDataOrigin_get.php` | 서버에 저장된 공고 원본 목록 | `moduleKey` 쿼리 파라미터를 붙이면 정상 응답 |
| A2 | 공고문첨부파일 | `https://bidding2.kr/api2/module/consortiumAPI/bidFile_get.php?gongsanum=...` | 입찰공고 첨부파일 목록 | 정상 응답 확인 |
| A3 | 파싱용공고문 | `https://bidding2.kr/api2/module/consortiumAPI/bidHwp_get.php?gongsanum=...` | 첨부 공고문을 HTML로 변환한 파싱용 본문 | 공고문 HTML URL 반환 확인 |
| A4 | 적격심사세부기준 | `https://file.bidding2.kr/api/calculator/qualification.php` | 적격심사 기준 row 목록 | `적격기준세부`, `건설` 파라미터로 정상 응답 확인 |
| A5 | 웹용공고문 | `https://bidding2.kr/bid/main-detail?num=...` | 사용자가 웹에서 확인하는 공고문 화면 | Vue 앱 HTML 반환. 실제 데이터는 내부 API로 로딩 |

## A3과 A5 차이

| 구분 | A3 파싱용공고문 | A5 웹용공고문 |
|---|---|---|
| 대상 | 첨부된 공고문 본문 | bidding2.kr 상세 화면 |
| 응답 | 공고문 HTML URL | Vue SPA HTML 페이지 |
| 주요 용도 | 빈 데이터 보완용 파싱, 공고문 근거 표시 | 사람이 공고 상세를 직접 확인하는 링크 |
| 데이터 성격 | 문서 내용 | 화면 껍데기와 앱 로딩 정보 |
| 파싱 우선순위 | 높음. 텍스트형이면 직접 파싱 | 낮음. 직접 파싱 대상이 아니라 화면 확인용 |

### 실제 내용 차이

샘플: `2601767-00`

| 항목 | A3 파싱용공고문 | A5 웹용공고문 |
|---|---|---|
| HTML 크기 | 약 141KB | 약 6KB |
| 추출 텍스트 길이 | 약 15,230자 | 제목 수준 |
| 본문 키워드 | `입찰에 부치는 사항`, `공사개요`, `입찰방법`, `입찰참가자격`, `공동계약`, `추정가격`, `기초금액` 포함 | 위 키워드 없음 |
| 실제 내용 | 공고문 조항, 금액, 참가자격, 공동계약 조건, 지역업체 조건 등 | 앱 번들, SEO 메타, 스크립트 링크 |

예시:

```text
A3 파싱용공고문: `2601767-00`의 전자입찰공고문 본문을 HTML로 열어 참가자격, 추정가격, 공사개요를 파싱한다.
A5 웹용공고문: `2601767-00` 상세 화면을 브라우저에서 열어 사람이 원문 링크와 화면 정보를 확인한다.
```

처리 기준:

```text
값을 채우는 파싱은 A3 파싱용공고문을 우선 사용한다.
A5 웹용공고문은 사람이 보는 상세 화면 링크로 보관하고, 자동 전처리의 주요 원천으로 쓰지 않는다.
단, 브라우저에서 A5 웹용공고문이 로딩한 내부 API와 화면 표시를 사람이 검증 근거로 사용할 수는 있다.
```

## 추가 발견 엔드포인트

상세 페이지의 Vue 번들을 확인한 결과, 공고 기본정보는 아래 API를 사용한다.

```text
https://bidding2.kr/api2/data/openBidInfo_get.php?gongNum=...
```

예시:

```text
https://bidding2.kr/api2/data/openBidInfo_get.php?gongNum=2601767-00
```

응답 예시:

| 필드 | 값 예시 |
|---|---|
| 공사명 | `[협정]2026년 노후공임 리모델링공사 7-3권역(전기소방)` |
| 공고번호 | `2601767-00` |
| 종목 | `(전기,전문소방)` |
| 발주처 | `한국토지주택공사 부산울산지역본부` |
| 지역제한 | `전국/울산` |
| 입력일 | `2026-05-21` |
| 공동도급형태 | `공동` |

## A2 공고문첨부파일 확인

### G2B 계열 예시

요청:

```text
https://bidding2.kr/api2/module/consortiumAPI/bidFile_get.php?gongsanum=R26BK01537599-000
```

응답 형태:

```text
{
  "입찰공고문(...).pdf": "https://www.g2b.go.kr/fs/fsc/fsca/fileUpload.do?...",
  "공사시방서(...).hwp": "https://www.g2b.go.kr/fs/fsc/fsca/fileUpload.do?..."
}
```

처리 기준:

```text
파일명과 URL을 원본 첨부파일 목록으로 저장한다.
공고문으로 보이는 파일을 우선 파싱 후보로 표시한다.
```

### LH 계열 예시

요청:

```text
https://bidding2.kr/api2/module/consortiumAPI/bidFile_get.php?gongsanum=2601767-00
```

응답 형태:

```text
{
  "전자입찰공고문.hwp": "javascript:lh_href(\"bidinfo\", \"전자입찰공고문.hwp\", \"전자입찰공고문_20260521153639136.hwp\", \"\")",
  "발주관련서류.zip": "javascript:lh_href(\"bidinfo\", \"발주관련서류.zip\", \"발주관련서류_20260521153639139.zip\", \"\")"
}
```

처리 기준:

```text
직접 URL이 아니라 `lh_href` 다운로드 스크립트 형태다.
파일명, 저장파일명, 발주처 다운로드 방식 정보를 원본으로 보관한다.
실제 다운로드 구현은 별도 확인이 필요하다.
```

## A3 파싱용공고문 확인

### G2B 계열 예시

요청:

```text
https://bidding2.kr/api2/module/consortiumAPI/bidHwp_get.php?gongsanum=R26BK01537599-000
```

응답:

```text
https://file.bidding2.kr/files/2026-06-09/R26BK01537599-000+00+2026-06-09/
```

확인 결과:

```text
해당 URL은 열리지만 공고문 내용이 base64 이미지 중심 HTML로 구성된다.
텍스트 파싱보다 화면 근거 표시 또는 OCR 후보로 보는 것이 안전하다.
```

### LH 계열 예시

요청:

```text
https://bidding2.kr/api2/module/consortiumAPI/bidHwp_get.php?gongsanum=2601767-00
```

응답:

```text
https://file.bidding2.kr/files/2026-06-08/2601767-00+00+2026-06-08/
```

확인 결과:

```text
해당 URL은 텍스트 추출 가능한 HTML이다.
예: 공사명, 입찰일, 추정가격, 공사개요, 참가자격 문구 확인 가능.
```

## A1 서버공고 확인

A1은 주소 문제가 아니라 `moduleKey` 누락 시 권한 오류가 발생한다.

```text
https://bidding2.kr/api2/module/dingpago/bidDataOrigin_get.php?moduleKey=...
```

`moduleKey` 없이 호출하면 아래 응답을 반환한다.

```json
{"contents":null,"msg":"권한이 없습니다.","code":404}
```

`moduleKey`를 붙이면 배열 JSON을 반환한다.

```text
요청 예시:
bidDataOrigin_get.php?moduleKey=...&isDefault=Y&containCancel=N&onlyGong=Y

응답 예시:
3348건, 118컬럼 배열 JSON
```

확인된 주요 컬럼:

| 컬럼 | 예시 |
|---|---|
| 공고번호 | `2601767-00` |
| 공사명 | `[협정]2026년 노후공임 리모델링공사 7-3권역(전기소방)` |
| 종목 | `(전기,전문소방)` |
| 발주처 | `한국토지주택공사 부산울산지역본부` |
| 지역제한 | `전국/울산` |
| 입력일 | `2026-05-21 00:00:00` |
| 기초금액 | `1200179000` |
| 추정가격 | `1091073000` |
| 입찰업무구분 | `공사` |

브라우저 구현 기준:

```text
프론트에서 직접 외부 URL을 호출하지 않는다.
로컬 Vite proxy `/api/bid?...`를 통해 호출하고, 서버측 proxy에서 `moduleKey`를 주입한다.
```

이유:

```text
moduleKey를 브라우저 코드에 노출하지 않고, CORS 문제도 피하기 위해서다.
```

주의:

```text
기존 메모에는 `1208건 x 74컬럼`이라고 되어 있었지만,
2026-05-22 현재 직접 확인한 응답은 `3348건 x 118컬럼`이다.
API 조건, 날짜, 키, 서버 데이터 변경에 따라 건수와 컬럼 수는 달라질 수 있다.
```

## A4 적격심사세부기준 확인

A4는 공고번호(`gongsanum`)로 조회하는 API가 아니다.
`적격기준세부`와 `건설` 파라미터로 조회한다.

```text
https://file.bidding2.kr/api/calculator/qualification.php?적격기준세부=행자부_별표-4&건설=일반건설
```

확인 결과:

```text
69개 row 배열 JSON 반환
```

응답 row shape:

| 필드 | 예시 |
|---|---|
| 발주처 | `행자부` |
| 적격심사기준 | `별표-4` |
| 시행일 | `2025-07-01` |
| 일반건설 | `3000000000` |
| 전문건설 | `0` |
| 기타건설 | `0` |
| 이름 | `적격통과점수` |
| 형태 | `0` |
| 내용 | `0~95` |
| 배점 | 빈값 가능 |
| 메모 | 빈값 가능 |

브라우저 구현 기준:

```text
프론트에서 `qualification.php`를 직접 호출하지 않는다.
`/api/proxy?url=...`를 통해 `server.js` 프록시를 거친다.
```

이유:

```text
`file.bidding2.kr`는 일반 호출에서 502가 날 수 있으므로,
server.js의 `/api/proxy`에서 Chrome User-Agent를 주입해 우회한다.
```

클라이언트 호출 예시:

```text
fetchQualification("행자부_별표-4", "일반건설")
```

내부 요청 흐름:

```text
브라우저
-> /api/proxy?url=https%3A%2F%2Ffile.bidding2.kr%2Fapi%2Fcalculator%2Fqualification.php%3F...
-> server.js proxyGet
-> Chrome UA 주입
-> file.bidding2.kr/api/calculator/qualification.php
```

주의:

```text
`qualification.php?gongsanum=2601767-00`은 빈 배열 `[]`을 반환한다.
공고 row에서 `적격평가기준_세부`, `일반_기타_전문` 값을 뽑아 호출해야 한다.
```

## 초기 수집 우선순위 제안

초기 개발에서는 아래 순서로 수집하는 것이 안전하다.

```text
1. 서버공고: bidDataOrigin_get.php에 moduleKey를 붙여 원본 목록 수집
2. openBidInfo_get.php로 단건 기본정보 보완
3. 공고문첨부파일: bidFile_get.php로 첨부파일 목록 수집
4. 파싱용공고문: bidHwp_get.php로 공고문 HTML URL 수집
5. 공고문 HTML을 텍스트형과 이미지형으로 구분
6. 텍스트형은 파싱 후보로 사용
7. 이미지형은 근거 표시 또는 OCR 후보로 보류
8. 적격심사세부기준: 필요한 경우 A4를 `/api/proxy` 경유로 호출
```
