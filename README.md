# 강연 용어 AI

강연 PDF에서 전문용어를 자동으로 추출해 실시간 음성인식 정확도를 높이고, 자막에 어려운 용어가 등장할 때마다 쉬운 설명을 최신순으로 보여주는 해커톤 MVP입니다.

Google API 자격증명이 없어도 내장된 샘플 강연으로 전체 발표 흐름을 시연할 수 있습니다.

## 해결하려는 문제

일반적인 실시간 자막은 강연자의 말을 글자로 바꾸지만, 청중이 모르는 전문용어의 의미까지 설명하지는 않습니다. 강연 용어 AI는 강연 자료를 먼저 읽어 자동 용어집을 만들고, 이 용어집을 음성인식 힌트와 청중용 해설에 동시에 사용합니다.

## 주요 기능

- 텍스트 PDF의 페이지별 내용 추출
- Gemini를 이용한 전문용어·영문 표기·한글 발음 별칭·쉬운 설명 자동 생성과 안전 규칙 기반 자동 승인
- PDF 원문에 실제 존재하는 용어만 서버에서 재검증
- 최대 50개 용어로 Google STT 인라인 `PhraseSet` 생성
- 한국어 실시간 임시·확정 자막 표시
- `RAG(레그)`처럼 정식 용어 바로 옆에 STT 원문을 괄호로 남기는 투명한 확정 자막 정정
- 자막 속 전문용어 강조와 반복 언급을 보존하는 최신순 설명 목록
- 큰 글씨, 고대비, 전체 화면 등 발표 접근성 기능
- 분석된 전체 용어 객체와 PhraseSet을 브라우저에 자동 저장하고 다시 불러오기
- 이 브라우저의 저장 용어집 목록, 이름 변경, 삭제
- 실시간 강연 음성과 PDF를 서버에 저장하지 않는 휘발성 처리
- 저장 녹음을 선택하고 유료 Google STT 스트림 정확히 3회 호출에 동의한 뒤 A/B/C 진행률과 저장 결과 기록을 확인하는 localhost 전용 개발 도구
- 저장된 브라우저 PDF 용어집과 정확한 대본을 5개 안팎의 실험 케이스로 스냅샷하고, 세트·케이스별 결과를 필터·집계·CSV/TSV/JSON으로 내보내는 STT 연구 흐름
- API 없이 실행되는 발표용 데모와 자동 종료 리포트

## 시스템 작동 구조

```mermaid
flowchart LR
    A["강연 PDF 업로드"] --> B["PDF.js 페이지별 텍스트 추출"]
    B --> C["Gemini 3.6 Flash 용어·설명 생성"]
    C --> D["Node.js 서버 원문 대조·중복 제거"]
    D --> E["자동 용어집 최대 50개"]
    E --> M["브라우저 localStorage v3<br/>용어집 + 발음 별칭 + PhraseSet만 저장"]
    M --> F
    M --> K
    E --> F["Google STT 인라인 PhraseSet"]
    G["브라우저 마이크"] --> H["16kHz PCM WebSocket 전송"]
    H --> I["Speech-to-Text V2 Chirp 3"]
    F --> I
    I --> J["임시 자막 원문<br/>확정 자막 원문 + 투명 정정"]
    E --> K["최신순 용어 설명 기록"]
    J --> L["React 발표 화면"]
    K --> L
```

### 실제 사용 순서

1. 사용자가 텍스트가 포함된 PDF를 업로드합니다.
2. 브라우저가 PDF를 페이지별 텍스트로 변환합니다.
3. Gemini가 강연에 중요한 전문용어 후보, 한글 발음 별칭 후보와 쉬운 설명을 생성합니다.
4. 서버가 후보 용어를 PDF 원문과 먼저 대조한 뒤, 영문 표기가 있는 용어의 Gemini 한글 발음을 자동 승인합니다. 완성형 한글·길이·개수·일반 단어 차단·용어 간 충돌 규칙을 통과한 발음만 남기며, 알려진 기술용어 목록은 누락 발음을 보완하는 데만 사용합니다.
5. 검증된 전체 용어 객체와 PhraseSet만 버전 3 브라우저 저장소에 자동 저장합니다. 기존 버전 1 저장소는 용어 ID와 기존 PhraseSet을 유지한 채 빈 `spokenAliases`를 넣어 버전 3으로 이전하며, WebSocket 서버도 별칭을 몰래 보완하지 않습니다. 버전 2는 같은 안전 규칙을 통과한 별칭만 보존하고 제거된 별칭의 PhraseSet 항목도 함께 제거해 버전 3으로 이전합니다. PDF, 추출 페이지 텍스트, PDF URL, 경고, 실시간 강연 음성은 저장하지 않습니다.
6. 같은 브라우저에서 저장 용어집을 불러오면 Gemini 분석 API를 다시 호출하지 않고 용어와 PhraseSet으로 준비 화면을 구성합니다.
7. 검증된 원본 전문용어는 최대 50개까지 사용합니다. 각 용어의 한글 발음 별칭과 PDF에 존재하는 영문 확장 표기는 이 50개에 포함하지 않고 같은 Google STT `PhraseSet`에 추가합니다.
8. 브라우저 마이크 음성을 16kHz mono PCM으로 변환해 WebSocket으로 보냅니다.
9. Chirp 3가 반환한 비어 있지 않은 모든 임시 자막은 앱에서 안정도 필터·debounce·묶음 대기 없이 수신 즉시 현재 아래 행을 교체합니다. 새 발화가 시작되면 남아 있는 확정 행만 실제 위치 차이만큼 위로 움직이고, 임시 자막이 이어지거나 같은 발화가 확정 자막으로 바뀔 때는 다시 움직이지 않습니다. 확정 자막의 검증된 발음 별칭만 정식 용어로 바꾸고 `RAG(레그)`처럼 원래 인식 표기를 바로 옆에 함께 표시합니다.
10. 정식 표기나 발음 별칭으로 용어가 등장할 때마다 canonical 용어의 새 설명 카드를 오른쪽 피드 맨 위에 추가하고, 같은 용어의 이전 언급도 아래 기록에 유지합니다.
11. 강연 종료 이벤트를 받으면 확정 자막 수, 연결된 용어, 분석 단계에서 준비한 PhraseSet 힌트 수를 리포트로 보여줍니다.

### 브라우저 저장 용어집

- 새 PDF 분석과 샘플 분석이 끝나면 용어집이 자동 저장됩니다.
- `#/lecture`의 `이 브라우저의 용어집`에서 앱 새로고침이나 서버 재시작 뒤에도 목록을 보고 바로 불러올 수 있습니다.
- 저장 항목은 `id`, `name`, `createdAt`, `updatedAt`, `spokenAliases`를 포함한 완전한 `GlossaryTerm[]`, `phraseSet`뿐입니다.
- 버전·필드·길이·개수·안전한 한글 발음·PhraseSet 대응 관계를 엄격히 검증하고, 유니코드·공백·대소문자 기준 중복을 제거합니다. 버전 1은 빈 별칭 상태로 버전 3으로 이전하며 용어 ID와 기존 PhraseSet을 다시 만들지 않습니다. 버전 2의 기존 용어집도 안전한 버전 3 데이터로 이전됩니다. v1 용어집에 별칭 정정과 별칭 STT 힌트를 추가하려면 PDF를 새로 분석해 저장해야 합니다.
- 이전 구현에서 PhraseSet 표기 50개로 잘린 버전 3 용어집은 저장된 원본 용어와 안전한 한글 발음을 이용해 로드할 때 자동 보완하며 Gemini를 다시 호출하지 않습니다.
- 전문용어가 하나도 없는 분석 결과는 저장하거나 저장 용어집 흐름으로 시작하지 않습니다.
- 용어집은 현재 브라우저와 사이트 저장소에만 존재합니다. 다른 브라우저·기기와 동기화되지 않으며 브라우저 데이터를 지우면 함께 삭제됩니다.
- 같은 사이트를 연 다른 탭의 저장 변경은 `storage` 이벤트로 목록에 반영합니다. 완전히 동시에 저장·이름 변경·삭제하면 `localStorage`의 한계상 마지막 쓰기가 우선하며 원자적 잠금은 제공하지 않습니다.
- 저장 용어집은 이름을 바꾸거나 삭제할 수 있습니다. 저장 공간 부족·차단·손상·버전 불일치 오류는 화면에 표시됩니다. 손상·버전 불일치는 사용자가 확인한 뒤 명시적으로 초기화할 수 있으며 자동 삭제하지 않습니다.
- 자동 저장에 실패해도 현재 분석 결과와 강연 시작 기능은 유지되며, 저장소를 정리한 뒤 같은 준비 화면에서 저장을 다시 시도할 수 있습니다.
- 저장 용어집을 불러와도 실시간 STT, 자막 강조, 반복 언급을 보존하는 용어 설명 목록과 결과 리포트가 동일하게 동작합니다.

## 기술 스택

| 영역 | 기술 | 사용 이유 |
|---|---|---|
| 프론트엔드 | React 19, TypeScript | 화면 상태와 실시간 자막 UI를 컴포넌트 단위로 관리 |
| 빌드 도구 | Vite 7 | 빠른 개발 서버와 작은 설정으로 해커톤 개발 속도 확보 |
| 스타일 | Tailwind CSS 4 | 반응형 발표 화면과 접근성 상태를 빠르게 구성 |
| 아이콘 | Lucide React | 일관된 경량 SVG 아이콘 제공 |
| PDF | PDF.js | 별도 Python/OCR 서버 없이 브라우저에서 텍스트 추출 |
| 백엔드 | Node.js 22, Express 5 | 프론트와 같은 TypeScript 생태계에서 API와 정적 파일 제공 |
| 실시간 통신 | WebSocket (`ws`) | 브라우저 오디오와 자막 이벤트를 양방향 스트리밍 |
| 요청 검증 | Zod | PDF 분석 요청과 WebSocket 용어 데이터 검증 |
| 생성형 AI | Gemini Developer API, `gemini-3.6-flash` | PDF 기반 전문용어와 비전공자용 설명 생성 |
| 음성인식 | Google Cloud Speech-to-Text V2, `chirp_3` | 한국어 스트리밍 자막과 PhraseSet 기반 음성 적응 |
| 테스트 | Vitest, TypeScript | 용어 검증 로직과 타입 안정성 확인 |
| 배포 | Docker, Google Cloud Run | 프론트와 백엔드를 단일 컨테이너로 배포 |

## 외부 API

### Gemini Developer API

- 호출 시점: PDF 업로드 후 한 번
- 입력: 페이지 번호가 포함된 PDF 추출 텍스트
- 출력: `term`, `english`, `spokenAliases`, `easyExplanation` 구조의 JSON
- 안전장치: 서버가 PDF 원문에 실제 존재하는 표기만 최종 채택
- 장애 대응: API 키가 없거나 호출에 실패하면 보수적 휴리스틱 추출로 자동 전환

### Google Cloud Speech-to-Text V2

- 호출 시점: 사용자가 실시간 강연을 시작했을 때
- 모델: `chirp_3`, 언어: `ko-KR`
- 오디오: LINEAR16, 16kHz, mono
- 적응: canonical 용어·검증된 한글 발음 별칭·영문 확장 표기를 인라인 `PhraseSet`으로 전달
- 스트림 규칙: 첫 메시지에 암시적 recognizer와 전체 설정만 보내고, 이후 메시지는 15KB 이하 `audio`만 전송
- 결과: 비어 있지 않은 모든 임시 자막과 확정 자막을 WebSocket으로 즉시 브라우저에 전달
- 확정 민감도: Chirp 3의 `ENDPOINTING_SENSITIVITY_SHORT`를 사용해 발화 뒤 침묵에서 확정 결과를 더 민감하게 반환하도록 요청합니다. 짧은 멈춤에도 문장이 더 잘게 확정될 수 있는 절충이며 임시 결과의 생성 빈도나 속도를 높이는 설정은 아닙니다.

Google V2의 [`interimResults`](https://cloud.google.com/speech-to-text/v2/docs/reference/rpc/google.cloud.speech.v2#streamingrecognitionfeatures)는 임시 결과 반환 여부만 설정합니다. 단어마다 또는 고정된 시간 간격마다 임시 결과가 나온다는 cadence나 지연 상한은 제공하지 않습니다. 따라서 앱은 Google이 보낸 임시 결과를 하나도 기다리거나 걸러내지 않지만, 첫 임시 자막 시점 자체는 네트워크·음성 조건과 제공자 응답 주기에 따라 달라집니다.

한 번의 로컬 실시간 마이크 진단에서는 provider 설정 전송이 세션 시작 후 약 31.42ms, 첫 PCM 전송이 약 371.86ms에 끝났습니다. 첫 발화는 VAD 감지 후 임시 결과 없이 약 3.465초 뒤 확정 결과가 왔고, 뒤의 다른 발화에서는 VAD 감지 후 첫 임시 결과까지 약 5.456초가 걸렸습니다. 이는 해당 세션에서 앱의 대기보다 제공자 응답 생성 시점이 체감 지연을 지배했다는 근거이지만, 일반적인 성능 보장이나 벤치마크는 아닙니다.

2026-08-08에 로컬 ADC와 `us-speech.googleapis.com`을 사용해 빈 PhraseSet, 인라인 PhraseSet 1개, 한국어 음성 스트림을 실제 V2 API로 검증했습니다. 한국어 음성 검증에서는 임시 자막과 확정 자막이 모두 반환되었습니다.

API 키와 Google 인증정보는 브라우저에 전달하지 않고 서버 환경변수와 Cloud Run 서비스 계정에서만 사용합니다.

## 내부 API와 WebSocket

| 방식 | 경로 | 역할 |
|---|---|---|
| `GET` | `/api/health` | Gemini·Google STT 설정 여부 확인 |
| `GET` | `/api/demo` | 자격증명 없이 사용할 샘플 PDF·용어집 반환 |
| `POST` | `/api/analyze` | PDF 페이지 텍스트를 받아 자동 용어집 생성 |
| `GET` | `/api/dev/audio-fixtures` | 개발용 고정 실험 문장과 로컬 녹음 목록 반환 |
| `POST` | `/api/dev/audio-fixtures` | 검증된 16kHz mono PCM WAV를 로컬 fixture로 저장 |
| `GET/POST` | `/api/dev/experiment-studies` | 로컬 실험 세트 목록 조회·생성 |
| `POST` | `/api/dev/experiment-studies/:studyId/cases` | 저장된 브라우저 용어집과 정확한 대본으로 immutable 케이스 스냅샷 추가 |
| `GET` | `/api/dev/stt-comparison-aggregates` | study/case별 완전한 accuracy 결과 A/B/C 평균 조회 |
| `POST` | `/api/dev/stt-comparison-jobs` | `recordingId`와 유료 STT 스트림 3회 명시적 동의를 받아 A/B/C 작업 시작 |
| `GET` | `/api/dev/stt-comparison-jobs/current` | 이 서버의 현재 작업 또는 CLI·다른 개발 서버가 보유한 공유 lock 상태 조회 |
| `GET` | `/api/dev/stt-comparison-jobs/:jobId` | 이 서버 프로세스 메모리에 있는 작업의 A/B/C 진행 상태 조회 |
| `GET` | `/api/dev/stt-comparisons?offset=<n>&limit=<n>` | 수정 시각 최신순 결과 기록과 페이지 정보 조회(기본 25개, 최대 100개) |
| `GET` | `/api/dev/stt-comparisons/:fileName` | 검증된 결과 파일 하나의 상세 리포트 조회 |
| WebSocket | `/ws` | 마이크 오디오 업로드와 자막 이벤트 스트리밍 |

WebSocket은 `start` 메시지로 `live` 또는 `demo` 모드를 시작합니다. 이 메시지에는 자동 용어집과 검증된 전체 `phraseSet`이 함께 포함되며, 실시간 모드에서는 이후 오디오 바이너리를 전송합니다. 서버는 정규화된 용어 표기와 ID를 각각 중복 제거하고 중복 ID에는 첫 번째 유효 용어만 사용합니다. 서버는 `ready`, `interim`, `final`, `error`, `ended` 이벤트를 반환합니다. `interim.text`는 STT 원문이며 자동 정정하지 않습니다. `final`은 표시용 `text`, 원본 `rawText`, 위치가 포함된 `corrections`, 실제 출현 순서와 반복을 보존한 `detectedTerms`를 함께 반환합니다. 화면은 이를 최신순 설명 목록에 쌓고 `ended`를 받으면 자막과 정정 근거를 보존한 채 결과 리포트로 이동합니다.

`pnpm dev`는 Vite와 백엔드를 모두 `127.0.0.1`에 bind해 LAN 연결 자체를 받지 않습니다. `/api/dev/*`는 여기에 더해 `NODE_ENV=development`와 요청의 socket·Host·Origin을 검사하는 개발 전용 경계입니다. 프로덕션의 개발 API 요청은 SPA HTML로 fallback하지 않고 JSON 404를 반환합니다.

## 폴더 구조

```text
client/
  src/App.tsx                 전체 화면과 사용자 흐름
  src/components/ExperimentWorkspace.tsx  DEV 전용 STT 실험실 탐색·라우트 셸
  src/components/ExperimentSetup.tsx  PDF 용어집·대본 실험 세트와 케이스 설정 UI
  src/components/AudioFixtureRecorder.tsx  개발용 고정음원 녹음 UI
  src/components/SttComparisonResults.tsx  저장된 A/B/C 결과 차트·자막·표·TSV UI
  src/components/TransparentCaption.tsx  원문 확인이 가능한 자동 정정 자막 UI
  src/hooks/useLectureStream.ts  WebSocket·자막 상태 관리
  src/lib/glossary-storage.ts 브라우저 용어집 v3 검증·v1/v2 이전·저장·로드
  src/lib/pdf.ts              PDF.js 텍스트 추출
  src/lib/pcm-recorder.ts     마이크 PCM 변환
server/
  src/app.ts                  주입 가능한 HTTP 앱·개발용 API 경계
  src/index.ts                HTTP listen·WebSocket 서버
  src/services/audio-fixtures.ts  WAV 검증·원자적 저장·오프라인 PCM 로드
  src/services/experiment-studies.ts  로컬 study/case 스냅샷·해시·원자적 저장
  src/services/stt-comparison.ts  고정 A/B/C 조건·출현 단위 점수·v3/v4 결과 스키마
  src/services/stt-comparison-runner.ts  CLI·UI 공용 A/B/C 실행과 immutable 결과 저장
  src/services/stt-comparison-jobs.ts  UI 작업의 프로세스 메모리 상태·진행률
  src/services/stt-comparison-lock.ts  CLI·UI 공용 cross-process 비교 lock
  src/services/stt-comparison-results.ts  로컬 결과 기록의 페이지별 목록·상세 검증 조회
  src/services/glossary.ts    Gemini·원문 검증·PhraseSet 생성
  src/services/spoken-aliases.ts  발음 별칭 제한·충돌 제거·알려진 별칭 보완
  src/services/caption.ts     확정 자막 용어 연결·원문 보존·안전한 위치 기반 정정
  src/services/speech.ts      Google STT V2 스트리밍
  src/services/demo.ts        발표용 샘플 데이터
docs/HANDOFF.md               인수인계 상태와 다음 작업
test-fixtures/stt/            고정 실험 문장과 Git 제외 로컬 WAV
Dockerfile                    Cloud Run용 다단계 이미지
```

## 로컬 실행

필요 환경은 Node.js 22 이상과 pnpm 11입니다.

```bash
pnpm install
cp .env.example .env
pnpm dev
```

- 웹 화면: `http://localhost:5173`
- 백엔드 API: `http://localhost:8787`

### 화면 탐색

상단 기본 탐색은 `강연`과 DEV 전용 `STT 실험실`을 분리합니다. `강연` 페이지에는 PDF 분석, 샘플 데모, 이 브라우저의 저장 용어집만 있으며, 고정음원 녹음·A/B/C 실행·결과 기록은 `STT 실험실`에서만 다룹니다.

| 영역 | 해시 경로 | 내용 |
|---|---|---|
| 강연 | `#/lecture` | PDF 분석, 샘플 데모, 저장 용어집 |
| 1. 실험 설정 | `#/experiment/setup` | 저장된 PDF 용어집+대본으로 study/case 스냅샷 생성 |
| 2. 고정음원 녹음 | `#/experiment/record` | 케이스 또는 기존 고정 문장 녹음과 로컬 fixture 저장 |
| 3. A/B/C 비교 실행 | `#/experiment/run` | 저장 녹음 선택, 유료 Google STT 스트림 정확히 3회 호출 동의, 비교 진행 상태 |
| 4. 결과 기록 | `#/experiment/results` | study/case 필터, immutable 상세, 케이스 평균과 CSV/TSV/JSON 내보내기 |

강연 PDF를 분석하는 `analyzing` 상태이거나 실시간 강연이 진행 중인 `live` 상태에서는 `STT 실험실`로 이동할 수 없습니다. 실험실 안에서는 위 네 단계의 보조 탐색으로 이동합니다. 결과 기록은 데스크톱에서 history/detail 두 pane을 함께 표시하고, 좁은 화면에서는 목록 또는 상세 하나만 표시하며 상세의 `결과 목록으로`로 목록에 돌아갑니다.

### PDF·대본 실험 세트

먼저 강연 화면에서 준비한 PDF 5종을 각각 분석해 브라우저 용어집으로 저장합니다. 이후 `#/experiment/setup`에서 실험 세트를 하나 만들고, 각 PDF 용어집과 실제로 읽을 정확한 대본을 케이스로 추가합니다. 저장 시 Gemini나 `/api/analyze`를 다시 호출하지 않고 브라우저 용어집을 서버의 `test-fixtures/stt/studies.local.json`에 복사합니다.

케이스는 고유 study/case/snapshot ID와 glossary/script/case SHA-256을 가지며 생성 후 수정하지 않습니다. 바뀐 PDF·대본·채점 기준은 새 케이스로 추가합니다. 채점용 `targetTerms`와 PDF 적응용 `adaptationTerms`를 분리하므로 A는 PhraseSet 없음, B는 PDF canonical/English, C는 PDF 용어와 자동 승인된 안전한 한국어 발음 별칭을 사용합니다. PDF에서 빠졌지만 대본에 있는 정답 용어는 수동 채점 용어로 추가할 수 있으나 B/C 힌트에는 들어가지 않아 PDF 추출 누락을 숨기지 않습니다.

환경변수 없이도 `#/lecture`에서 `샘플 강연 바로 체험하기`를 선택해 데모를 실행할 수 있습니다.

### 개발용 고정음원 녹음

`pnpm dev`로 `http://localhost:5173/#/experiment/record`를 열거나 `STT 실험실`의 `2. 고정음원 녹음`으로 이동합니다. 현재 기준 문장은 발화와 정답 표기가 어긋나지 않도록 `엘엘엠`, `래그`, `에이피아이`, `프레이즈셋`처럼 실제로 읽을 한국어 발음을 본문에 명시합니다. 문장을 처음부터 끝까지 그대로 읽은 경우에만 녹음 화면의 선언 **“기준 문장을 그대로 읽었습니다”**를 선택해 저장합니다.

고정 문장을 한 번 읽어 저장하면 다음 파일이 만들어집니다.

- 오디오: `test-fixtures/stt/audio/*.wav`
- 로컬 메타데이터: `test-fixtures/stt/manifest.local.json`
- 형식: canonical RIFF/WAVE, PCM1, mono, 16kHz, 16-bit, 최대 120초·3,840,000 PCM 바이트

두 파일은 Git과 Docker build context에서 제외되며 자동 만료되지 않습니다. 화자 label은 실제 이름이 아닌 `speaker-a`, `speaker-b` 가명만 사용하고, 필요 없어진 파일은 직접 삭제합니다. 녹음 시작 시 화자·환경·실험문장과 기준 문장 그대로 읽기 선언을 snapshot하므로 준비된 WAV의 메타데이터가 이후 화면 선택과 섞이지 않습니다. 브라우저 timer가 지연돼도 capture 계층이 PCM을 3,840,000바이트에서 hard cap합니다.

저장 시 `.writer.lock`을 짧게 획득해 같은 fixture root를 연 복수 개발 서버의 manifest 갱신을 직렬화합니다. 비정상 종료로 60초 이상 남은 lock은 다음 저장이 회수합니다. 저장 모듈은 PCM을 15,000바이트 이하의 짝수 길이 청크로 바이트 손실 없이 다시 읽습니다.

### localhost UI에서 A/B/C 비교

개발 서버와 Google ADC를 준비한 뒤 `http://localhost:5173/#/experiment/run` 또는 `STT 실험실`의 `3. A/B/C 비교 실행`에서 다음 순서로 실행합니다.

1. 저장된 녹음을 명시적으로 선택합니다.
2. **유료 Google STT 스트림이 정확히 3회 호출됨**을 확인하는 동의란을 선택합니다.
3. `유료 비교 시작`을 한 번 누릅니다. 서버는 선택한 WAV로 A, B, C를 동시에 각각 한 번 실행하고 화면은 job API를 폴링해 전체 진행률과 조건별 재생률을 표시합니다.
4. 완료되면 결과 기록 첫 페이지가 갱신되고 방금 생성된 상세 리포트가 선택됩니다.

실행 중인 조건을 자동 재시도하지 않으며 취소 API나 취소 버튼도 없습니다. 조건 하나가 오류로 끝나도 같은 job 안에서 나머지 조건을 각각 한 번만 실행하고, 오류를 포함한 완전한 v4 리포트를 저장합니다. 따라서 시작 전에 녹음, ADC, Google STT 설정을 확인해야 합니다. 테스트나 브라우저 QA에서는 `유료 비교 시작`을 누르거나 `POST /api/dev/stt-comparison-jobs`를 호출하지 않습니다.

동일한 실행기를 CLI에서도 사용할 수 있습니다. 가장 최근 녹음 또는 지정한 녹음을 실행합니다.

```bash
pnpm stt:compare
pnpm stt:compare -- <recording-id>
```

| 조건 | PhraseSet | 별칭 정정 |
|---|---|---|
| A · `without-phrase-set` | 없음 | 없음 |
| B · `canonical-phrase-set` | canonical 표기 + English 표기 | 없음 |
| C · `spoken-alias-phrase-set` | canonical 표기 + English 표기 + 안전한 한국어 발음 | 저장된 안전 발음을 canonical 용어로 정정 |

기존 고정 대본은 targetTerms를 적응 용어로도 사용합니다. 새 PDF 케이스는 위 B/C의 표기가 해당 케이스의 별도 `adaptationTerms`, 즉 PDF 용어집 스냅샷에서만 만들어집니다.

UI 또는 CLI 실행 한 번은 A/B/C 각각에 대해 실제 Google STT 스트림을 동시에 열므로 **유료 API 실행이 정확히 세 번 발생합니다.** 동시 실행은 대기 시간을 줄이지만 전송하는 총 오디오 길이는 바꾸지 않습니다. `pnpm test`는 저장 음원을 Google에 보내지 않고 스키마·조건 생성·점수 계산·파일 저장 경계만 검증하므로 유료 API를 호출하지 않습니다.

실행 결과는 `test-fixtures/stt/results/comparison-<recordingId>-<jobId>.json`의 버전 4 리포트로 새 파일에 원자적으로 저장되며 Git·Docker에서 제외됩니다. v4는 녹음에 고정된 study/case/snapshot/glossary/script identity를 보존합니다. job ID가 파일명에 포함되므로 같은 녹음을 반복해도 기존 결과를 덮어쓰지 않습니다. 이전 `comparison-<recordingId>.json`과 v1~v3 결과도 삭제하거나 이름을 바꾸지 않고 기존 규칙에 따라 계속 조회합니다. 리포트는 표시용 정정 자막, STT 원문 `rawText`, 정정 내역과 함께 정답 대본의 각 출현을 기준으로 직접 인식, 별칭 정정 성공, 누락, 잘못된 정정, 말하지 않은 용어 삽입, 제품 용어 연결률 `(직접 인식 + 별칭 정정 성공) / 기준 출현 수`를 기록합니다. A/B에서는 별칭 정정을 성공으로 인정하지 않습니다.

저장된 기록은 `http://localhost:5173/#/experiment/results` 또는 `STT 실험실`의 `4. 결과 기록`에서 확인합니다.

정확도 수치는 녹음 메타데이터에 **“기준 문장을 그대로 읽었습니다”**라는 명시적 선언이 있는 경우에만 유효합니다. 선언하지 않은 녹음과 기존 manifest v1 녹음은 자동으로 smoke 전용이며, 누락과 연결률이 계산되어도 논문 정확도로 해석하지 않습니다. 106초 legacy 녹음은 예전 소개 대본을 읽어 현재 기준 문장과 일치하지 않으므로 계속 smoke 전용입니다. 별도의 exact-script 녹음으로 완전한 accuracy 리포트 하나를 만들었지만, 논문 근거로 쓰려면 같은 WAV의 반복 실행이 더 필요합니다.

localhost 개발 화면의 `저장된 STT 비교 결과`는 study/case로 필터한 유효 파일을 수정 시각 최신순으로 5개씩 페이지 이동하고, 선택한 파일의 상세 리포트를 별도 API로 읽습니다. 새로고침·페이지 이동·상세 선택은 Google STT를 호출하지 않습니다. v3/v4 상세는 조건 비교 차트, A/B/C별 STT 원문과 정정·표시 문장, 용어별 출현 표와 논문용 요약 표를 보여줍니다. 케이스 집계는 오류 없는 accuracy 결과만 평균 내고 CSV·TSV·JSON으로 내보냅니다. TSV 복사는 정확도 모드이면서 세 조건이 모두 오류 없이 완료된 결과에서만 활성화되고, smoke 결과는 화면에서 관찰할 수 있어도 TSV 복사가 비활성화됩니다. 버전 1·2는 `레거시 스모크 결과` 안내만 표시하고 지표를 추정하지 않습니다.

UI job 상태는 서버 프로세스 메모리에만 있어 서버를 재시작하면 조회할 수 없습니다. 완료되어 `results/`에 저장된 파일은 서버 재시작 뒤에도 기록·상세 화면에서 다시 읽을 수 있습니다. 실행 중 재시작으로 파일 쓰기 전에 중단된 job은 결과가 없으며 자동 재개하거나 재시도하지 않습니다.

CLI와 UI는 fixture root의 `.stt-comparison.lock`을 함께 사용해 프로세스가 달라도 비교 job을 하나만 허용합니다. 살아 있는 PID가 소유한 lock은 중복 시작을 막습니다. 종료된 PID의 stale lock은 내용·파일 identity를 다시 검증한 뒤에만 회수합니다. 손상된 JSON, symlink, 잘못된 권한·크기처럼 안전성을 확인할 수 없는 lock은 자동 삭제하지 않고 시작을 차단하므로 사람이 원인을 확인해야 합니다.

정확도 선언이 있고 A/B/C가 모두 오류 없이 끝난 리포트 하나는 **한 번의 완전한 정확도 실행**일 뿐입니다. 같은 음원을 한 번씩 실행한 A/B/C 한 세트는 오디오 입력을 고정하지만 Google STT의 API 비결정성까지 제거하지 않습니다. publication-grade 근거에는 같은 WAV의 반복 실행, 사전에 정한 반복 수와 요약 방식, 개별 결과 보존이 추가로 필요합니다.

이 경계는 동일 사용자가 제어하는 로컬 개발 환경을 대상으로 합니다. 서버가 직접 사용하는 fixture root·audio·파일의 symlink와 생성 경로 이탈은 거부하지만, 악의적인 동일 사용자 프로세스와 모든 ancestor symlink/TOCTOU를 격리하는 보안 sandbox는 아닙니다.

## 환경변수

```bash
PORT=8080
GOOGLE_CLOUD_PROJECT=your-google-cloud-project
GOOGLE_STT_LOCATION=us
GOOGLE_STT_MODEL=chirp_3
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.6-flash
```

### Gemini 연결

Google AI Studio에서 API 키를 발급해 `.env`의 `GEMINI_API_KEY`에 설정합니다.

### Google STT 연결

Google Cloud 프로젝트에서 Speech-to-Text V2 API를 활성화하고 로컬 Application Default Credentials를 준비합니다.

```bash
gcloud auth application-default login
```

Cloud Run에서는 로컬 인증 파일 대신 서비스 계정에 Speech-to-Text 호출 권한을 부여합니다.

## 검증 명령

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm start
docker build -t lecture-context-ai:mvp .
```

## Cloud Run 배포

프론트엔드와 백엔드는 하나의 컨테이너로 실행됩니다. Gemini 키는 소스에 기록하지 않고 Secret Manager 또는 Cloud Run secret 환경변수로 연결합니다.

```bash
gcloud run deploy lecture-context-ai \
  --source . \
  --region asia-northeast3 \
  --allow-unauthenticated \
  --min 0 \
  --max 1 \
  --memory 512Mi \
  --cpu 1 \
  --timeout 3600 \
  --set-env-vars GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID,GOOGLE_STT_LOCATION=us,GOOGLE_STT_MODEL=chirp_3 \
  --set-secrets GEMINI_API_KEY=gemini-api-key:latest
```

## 개인정보와 비용 원칙

- 실시간 강연 음성과 PDF 파일은 서버나 브라우저 저장소에 영구 저장하지 않습니다.
- 예외적으로 개발자가 녹음 카드에서 명시적으로 만든 처리 음성만 프로젝트 로컬 fixture에 저장하며, Git·Docker에는 포함하지 않습니다.
- 브라우저 저장소에는 검증된 용어집·발음 별칭과 PhraseSet만 저장합니다. API 키, PDF URL, 추출 페이지 텍스트, 분석 경고도 저장하지 않습니다.
- Gemini는 새 PDF 업로드 시 한 번만 호출합니다. 저장 용어집을 다시 사용할 때는 호출하지 않아 실시간 지연과 토큰 비용을 줄입니다.
- STT는 전송한 오디오 길이를 기준으로 과금될 수 있습니다.
- 공개 배포 전 Google Cloud 예산 알림과 API 할당량을 설정해야 합니다.

## 현재 MVP 제한

- 텍스트가 포함된 10MB·100페이지 이하 PDF만 지원합니다.
- 스캔 PDF OCR, 화자 분리, 번역, TTS는 포함하지 않습니다.
- 데이터베이스, 회원가입, 강연자 검수 화면은 포함하지 않습니다.
- 브라우저 용어집은 현재 브라우저에만 있으며 계정 동기화·내보내기·가져오기를 지원하지 않습니다.
- 실시간 용어 설명 기록은 현재 강연 세션에만 유지되며 새 강연을 시작하면 초기화됩니다.
- 영문 전문용어의 Gemini 한글 발음은 사용자 검토 없이 자동 승인하되, 완성형 한글·길이·개수·일반 단어·표기 충돌 안전 규칙을 통과한 값만 사용합니다. 따라서 드문 오발음 후보가 통과할 가능성은 남으며 정정된 경우 괄호 안에서 STT 원문을 항상 확인할 수 있습니다.
- `레그`처럼 일반 문맥과 충돌할 수 있는 별칭은 별도 한글 단어 앞에서 정정하지 않습니다. 따라서 `레그는`은 `RAG(레그)는`으로 정정하지만 `레그 프레스`는 유지합니다. 이 규칙은 오정정을 줄이는 대신 일부 실제 RAG 발화를 놓칠 수 있으며 의미 판별 모델은 아닙니다.
- Gemini가 PDF에서 검증 가능한 용어를 3개 미만으로 반환해도 해당 용어를 버리지 않고 문서 표기 기반 휴리스틱 결과로 보완하며 화면에 경고를 남깁니다.
- 실제 Gemini PDF 분석 경로는 API 키 연결 후 추가 검증이 필요합니다.
- Google STT API 연결과 한국어 음성 응답은 검증했지만, 실제 발표에 사용할 브라우저·마이크 조합의 권한과 음질은 별도 현장 확인이 필요합니다.
- 긴 강연을 위한 STT 스트림 자동 재연결은 아직 구현하지 않았습니다.
- 실제 발화 시작 시점을 신뢰성 있게 추적하지 않으므로 결과 화면에서 실시간 표시 지연을 추정해 보여주지 않습니다.
- 개발용 고정음원 A/B/C v3 점수는 기준 문장 그대로 읽기 선언이 있는 exact-script 녹음에서만 정확도로 유효합니다. 106초 legacy 음원은 대본 불일치 smoke 전용입니다. 별도의 exact-script 단일 accuracy 리포트가 있어도 Google STT 비결정성을 다룬 publication-grade 근거에는 같은 WAV의 반복 실행이 필요합니다.
- 쉬운 용어 정의는 제공하지만 `이 용어가 지금 등장한 이유`를 설명하는 맥락 문장은 다음 버전 작업입니다.

현재 상태와 후속 작업은 [인수인계 문서](docs/HANDOFF.md)를 참고하세요. 기존 106초 smoke 관찰, 현재 A/B/C v3 프로토콜과 논문 해석 경계는 [STT PhraseSet 파일럿 실험 기록](docs/STT_PHRASESET_PILOT.md), 논문 연구문제·평가 설계·발표 흐름은 [논문·발표 구성안](docs/PAPER_PRESENTATION_PLAN.md)에 정리되어 있습니다.
