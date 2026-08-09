# Lecture Context AI 인수인계

## 현재 상태

한신대학교 ABC 해커톤에서 시연할 수 있는 MVP입니다. Google 자격증명이 없어도 내장 데모로 업로드 이후의 준비 화면, 실시간 자막, 반복 언급을 보존하는 용어 설명 피드와 결과 리포트를 확인할 수 있습니다. 로컬 ADC가 연결된 환경에서는 Google STT V2 실시간 스트림도 검증했습니다.

### 구현 완료

- React 기반 반응형 발표 화면
- PDF.js 페이지별 텍스트 추출
- Gemini 구조화 JSON 기반 자동 용어집 생성
- PDF 원문 대조, 중복 제거, 최대 50개 제한
- Google STT V2 Chirp 3 인라인 PhraseSet 구성
- Google STT V2 typed bidi 스트림과 실제 `us` 리전 연결 검증
- 브라우저 마이크 PCM 변환과 WebSocket 전송
- localhost 개발 화면에서 최대 120초 음성을 canonical 16kHz mono 16-bit PCM WAV로 저장하는 fixture recorder
- Vite·개발 백엔드의 `127.0.0.1` bind, 개발 녹음 API의 production JSON 404와 localhost 요청 재검증
- 3,840,000 PCM 바이트 capture hard cap과 manual/timer/limit 종료 단일화
- 녹음 시작 시 가명 화자·환경·실험문장 snapshot과 prepared 상태 선택 잠금
- temp WAV 검증·rename·atomic manifest, 실패 rollback/queue 회복과 cross-process writer lock
- 저장 WAV의 offline PCM 재로드와 15KB 이하 짝수 청크 분할 계약
- 기준 문장 각 용어의 canonical·English·검토된 한국어 발음과 출현 순서를 담는 구조화 fixture script v2
- 녹음별 **“기준 문장을 그대로 읽었습니다”** 선언과, 선언 없는 기존 manifest v1 녹음을 smoke 전용으로 읽는 v2 호환 경계
- 고정 음원을 PhraseSet 없음(A), canonical+English PhraseSet(B), canonical+English+검토된 한국어 발음 PhraseSet 및 별칭 정정(C) 순서로 실행하는 비교 코어
- localhost UI에서 저장 녹음 선택, 유료 Google STT 스트림 정확히 3회 호출 동의, 비동기 job 시작과 A/B/C 진행 상태 폴링
- UI와 CLI가 함께 사용하는 `.stt-comparison.lock` 기반 cross-process 단일 실행과 stale PID의 검증 후 회수·unsafe lock 차단
- 직접 인식·별칭 정정 성공·누락·잘못된 정정·잘못된 삽입·제품 용어 연결률을 출현 단위로 계산하는 비교 결과 v3
- `comparison-<recordingId>-<jobId>.json` immutable 결과 저장과 기존 파일 보존, 수정 시각 최신순 페이지 목록·파일별 상세 조회
- 저장된 v3 결과의 조건 차트·A/B/C 원문/표시 자막·용어별 표와, 정확도·세 run 정상 완료 조건에서만 활성화되는 TSV 복사를 제공하고 v1/v2를 안내-only legacy로 격리하는 localhost 개발 결과 화면
- 임시·확정 자막, 용어 강조, 반복 언급마다 생성되는 최신순 쉬운 설명 피드
- `spokenAliases` 후보 중 코드에서 검토된 용어-발음 쌍만 채택하는 검증과 새 분석의 알려진 기술용어 발음 보완, 별칭을 포함할 수 있는 50개 제한 PhraseSet
- 임시 자막 원문 유지, 확정 자막의 위치 기반 canonical 정정, `rawText`·정정 내역 보존
- 자막에 `RAG(레그)`처럼 canonical 용어와 STT 원문을 나란히 표시하고 canonical 용어 설명 카드 연결
- API 없는 데모 모드
- 분석 완료 시 전체 `GlossaryTerm[]`과 `phraseSet`의 브라우저 `localStorage` v3 자동 저장
- 기존 localStorage v1의 빈 별칭·ID·PhraseSet을 보존하는 v3 이전과 v2의 미검토 별칭을 제거하는 v3 이전
- 앱 새로고침·서버 재시작 뒤 저장 용어집 목록/로드, 이름 변경, 삭제
- 저장 용어집 로드 시 Gemini 분석 없이 기존 WebSocket live/demo 시작 메시지 재사용
- 저장 형식 엄격 검증, 정규화 중복 제거, 용어 ID 보존, 저장 공간·차단·손상·버전 오류 표시
- PDF 없는 저장 용어집 세션에서도 동일한 실시간 용어 설명 피드 제공
- 전체 분석 PhraseSet의 WebSocket 전달과 Google STT 적용
- 데모·실시간 종료 이벤트의 자동 결과 화면 전환
- 타입 검사, 프로토콜·용어 검증 테스트, 프로덕션 빌드
- Docker 이미지 빌드와 컨테이너 헬스 체크

### 2026-08-09 독립 리뷰 조치

- P1 임의·모호한 별칭 오정정: **수용**. 검토된 용어-발음 쌍만 자동 정정·PhraseSet에 사용하고, `사과를 먹습니다.`를 `API`로 바꾸지 않으며 `레그 프레스`도 RAG로 바꾸지 않는 회귀 테스트를 추가했습니다.
- P2 WebSocket 중복 용어 ID: **수용**. 정규화된 용어 표기와 ID를 각각 검사하고, 중복 ID는 첫 번째 유효 용어만 남겨 자막 canonical 표기와 클라이언트 설명 카드 소유권을 일치시켰습니다.
- P3 v1 별칭 계약 불일치: **수용**. WebSocket의 숨은 알려진 별칭 보완을 제거해 v1의 빈 별칭과 기존 PhraseSet이 클라이언트·서버에서 일치합니다. 기존 v2도 열리지 않게 만들지 않도록 저장 버전을 v3으로 올리고 안전하게 이전합니다.
- 기각한 지적은 없습니다. 의미 분류기를 추가하는 범위는 이번 수정에서 보류했습니다. 그 결과 `레그 기반`처럼 실제 RAG를 뜻해도 모호한 별칭 뒤에 별도 한글 단어가 오면 정정하지 않을 수 있으며, 이는 오정정보다 누락을 택한 의도된 제한입니다.

## 실제 Google STT 검증 결과

2026-08-08 기준으로 프로젝트 ID가 활성 `gcloud` 프로젝트와 일치하고, Speech-to-Text API 활성화와 ADC 인증이 유효한 로컬 환경에서 확인했습니다. 프로젝트 ID와 인증정보는 문서와 로그에 기록하지 않았습니다.

- 엔드포인트: `us-speech.googleapis.com`
- recognizer: `projects/{project}/locations/us/recognizers/_`
- 모델·언어: `chirp_3`, `ko-KR`
- 빈 PhraseSet + 0.25초 무음: 스트림 정상 수락·종료, 임시 0개·확정 0개
- 인라인 PhraseSet 1개 + 0.25초 무음: 스트림 정상 수락·종료, 임시 0개·확정 1개
- 빈 PhraseSet + 로컬 한국어 음성: 3,200바이트 단위 16kHz mono LINEAR16 전송, 임시 1개·확정 1개
- 저장 WAV 106초 legacy A/B 스모크: 당시 PhraseSet 없음과 영문 targetTerms 17개 적용 조건 모두 전체 음원 재생·확정 자막 12개·오류 0개
- 같은 과거 스모크에서 영문 정확 표기는 0개에서 1개(`PhraseSet`)로 증가했지만 `RAG`는 `레그`, `Transformer`는 `트랜스포머`, `Fine-tuning`은 `파인 튜닝`으로 남았습니다.
- 최신 기준 문장을 그대로 읽었다고 선언한 한 녹음의 완전한 accuracy 리포트에서 제품 용어 연결률 A/B/C가 각각 **17.6% / 17.6% / 94.1%**로 관찰됐습니다.

무음 인라인 PhraseSet 호출의 확정 결과는 연결 성공 근거로만 사용하며 정확도 근거로 사용하지 않습니다. 현재 106초 WAV도 예전 프로젝트 소개 대본을 읽어 현재 기준 문장과 불일치하므로, 새 v3 실행기에 넣더라도 `smoke`일 뿐 누락·연결률을 논문 정확도로 사용할 수 없습니다. 한국어식 영어 발음 별칭이 필요하다는 관찰 근거로만 보존합니다.

현재 기준 문장은 실제 발화를 `엘엘엠`, `래그`, `에이피아이`, `프레이즈셋`처럼 한국어 발음으로 명시했습니다. 위 17.6% / 17.6% / 94.1%는 이 문장을 그대로 읽었다고 선언한 **단일 완전 리포트의 관찰값**이며 일반적 개선율이나 publication-grade 결론이 아닙니다. 같은 WAV의 A/B/C 반복 수와 요약 방식을 사전에 고정한 반복 실험이 여전히 필요합니다. 상세 프로토콜과 해석 제한은 [STT PhraseSet 파일럿 실험 기록](STT_PHRASESET_PILOT.md)에 보존되어 있습니다.

## 아직 실제 자격증명·기기로 검증하지 않은 부분

- Gemini 3.6 Flash 실제 PDF 호출
- 실제 발표용 브라우저·마이크 권한과 음질
- 보존된 exact-script WAV의 반복 A/B/C 실행과 논문용 요약 통계
- Cloud Run 배포 환경의 WebSocket 장시간 연결
- Secret Manager와 Cloud Run 서비스 계정 연결

## 다음 개발 우선순위

1. 단일 accuracy 리포트에 사용한 exact-script WAV를 보존하고 같은 녹음으로 A/B/C를 여러 차례 실행해 조건별 직접 인식·별칭 정정·누락·오정정·오삽입·제품 용어 연결률의 분포를 확인합니다. 기존 106초 음원은 smoke 회귀에만 사용합니다.
2. 논문에 반복 수, 실행 시각, 모델·리전, 집계 방식과 개별 실행값을 함께 기록합니다.
3. 용어별 발음 별칭을 사용자가 검수·수정하는 최소 UI의 필요성을 반복 실험의 오정정 결과로 판단합니다.
4. glossary 결과에 `contextExplanation`을 추가해 용어가 현재 문맥에서 등장한 이유를 표시합니다.
5. Google STT 스트리밍 제한에 대비한 자동 재연결과 자막 연속성 처리를 구현합니다.
6. Cloud Run에 배포하고 모바일·노트북 마이크 권한과 WebSocket을 재검증합니다.

## 인수인계 시 전달해야 하는 외부 리소스

- GitHub 저장소 접근 권한
- Google Cloud 프로젝트 IAM 권한
- 활성화할 API 목록: Speech-to-Text V2, Cloud Run, Cloud Build, Artifact Registry, Secret Manager
- Cloud Run 서비스 계정과 권한 설명
- 예산 알림·API 할당량 설정 위치

개인 API 키나 서비스 계정 JSON을 메신저와 Git으로 전달하지 않습니다. 다음 담당자는 IAM으로 프로젝트에 초대하고, Gemini 키는 Secret Manager에서 교체 가능한 형태로 관리합니다.

## 빠른 확인 절차

```bash
pnpm install
cp .env.example .env
pnpm typecheck
pnpm test
pnpm build
pnpm dev
```

1. `http://localhost:5173`에 접속합니다.
2. `샘플 강연 바로 체험하기`를 누릅니다.
3. 자동 용어집 5개가 표시되는지 확인합니다.
4. `데모 자막으로 미리보기`를 누릅니다.
5. 두 번째 임시 자막의 `알에이지`가 원문 그대로 보이고, 확정 자막은 별도 배지 없이 `RAG(레그)`로 표시되는지 확인합니다.
6. 정정된 `RAG`가 오른쪽 피드 맨 위에 새 쉬운 설명 카드를 만들고 이전 카드가 아래에 남는지 확인합니다.
7. 마지막 데모 자막 뒤 자동으로 결과 리포트가 표시되고 확정 자막 4개와 `RAG(레그)` 표기가 유지되는지 확인합니다.
8. `처음으로` 이동해 `이 브라우저의 용어집`에 샘플 용어집이 표시되는지 확인합니다.
9. 페이지를 새로고침하거나 개발 서버를 다시 시작한 뒤 같은 용어집이 유지되는지 확인합니다.
10. 저장 용어집을 불러와 분석 화면이나 `/api/analyze` 요청 없이 준비 화면으로 이동하는지 확인합니다.
11. `실시간 강연 시작` 시 저장된 전체 용어와 PhraseSet이 WebSocket `start` 메시지에 포함되고, 자막 강조와 쉬운 설명이 동작하는지 확인합니다.
12. 저장 용어집 세션에서도 관련 자료 영역 없이 오른쪽 전체를 용어 설명 피드로 사용하고, 같은 용어의 반복 카드가 각각 유지되는지 확인합니다.
13. 첫 화면에서 용어집 이름 변경과 삭제를 확인합니다.
14. localhost 개발 화면의 `개발용 고정음원 녹음`에서 가명 화자와 환경을 선택하고 고정 문장을 녹음합니다.
15. 정확도용 녹음이라면 화면의 문장을 그대로 읽고 **“기준 문장을 그대로 읽었습니다”**를 선택합니다. 일부를 바꾸거나 빼고 읽었다면 선택하지 않습니다.
16. 녹음 종료와 최대 120초 timer/PCM hard cap 종료가 한 번만 처리되는지, 미리 듣기와 재녹음이 동작하는지 확인합니다.
17. 저장 뒤 `test-fixtures/stt/audio/*.wav`와 `manifest.local.json`이 생성되고 Git 상태에 나타나지 않는지 확인합니다.
18. 테스트·브라우저 QA에서는 `A/B/C 비교 시작`을 누르거나 `POST /api/dev/stt-comparison-jobs`를 호출하지 않습니다. 저장 녹음 selector, 3회 유료 호출 동의 문구와 동의 전 비활성 Start 상태까지만 확인합니다. `pnpm test`도 Google STT를 호출하지 않습니다.
19. 기존 저장 결과만 사용해 새로고침, 이전/다음 페이지와 파일 선택이 해당 상세 리포트를 여는지 확인합니다. 이 목록·상세 동작은 유료 호출을 만들지 않습니다.
20. 정확도 모드이고 세 run이 모두 오류 없이 완료된 기존 v3에서만 TSV 복사가 활성화되는지 확인합니다. smoke v3는 차트·자막·표를 표시하되 TSV 복사가 비활성화되어야 합니다.
21. v1/v2가 `레거시 스모크 결과` 안내만 표시하고 지표·자막·v3 차트·표·TSV를 추정하지 않는지 확인합니다.

실제 유료 측정은 브라우저 QA와 분리해 [STT PhraseSet 파일럿 실험 기록](STT_PHRASESET_PILOT.md)의 프로토콜로만 수행합니다. 이때 저장 녹음 선택과 정확히 3회 호출 동의 후 Start를 한 번 누르며, 자동 재시도·취소가 없고 공유 lock이 중복 UI/CLI 시작을 막는다는 점을 전제로 합니다.

## 알려진 제한과 결정 사항

- OCR을 넣지 않았으므로 스캔 이미지 PDF는 처리하지 못합니다.
- PDF는 브라우저에서 추출하며 Python 런타임을 사용하지 않습니다.
- 강연자 검수 단계 없이 PDF 원문 대조 결과를 자동 채택합니다.
- PDF와 실시간 강연 음성은 서버에 저장하지 않으며 데이터베이스가 없습니다. localhost 개발 녹음 카드에서 사용자가 명시적으로 만든 fixture만 프로젝트 로컬에 보존합니다.
- 용어집은 `lecture-context-ai.glossaries` 키의 버전 3 브라우저 저장소에만 저장합니다. 유효한 버전 1 데이터는 용어 ID와 기존 PhraseSet을 유지하고 각 용어에 빈 `spokenAliases`를 넣어 버전 3으로 이전합니다. WebSocket 경계에서도 이 빈 배열을 그대로 유지하며 알려진 별칭을 숨겨서 보완하지 않습니다. 버전 2 데이터는 검토된 별칭만 보존하고 제거한 별칭에만 대응하던 PhraseSet 항목도 함께 제거해 버전 3으로 이전합니다. 서버 저장소는 추가하지 않았습니다.
- 저장 필드는 용어집 메타데이터(`id`, `name`, `createdAt`, `updatedAt`), `spokenAliases`를 포함한 완전한 `GlossaryTerm[]`, `phraseSet`으로 제한합니다. PDF, 추출 페이지 텍스트, `pdfUrl`, 음성, 경고, API 키는 제외합니다.
- 저장 데이터는 정확한 필드 집합과 타입·길이·개수·타임스탬프·PhraseSet/용어 대응 관계를 검증합니다. 정규화 중복은 제거하되 채택한 용어의 기존 ID는 유지합니다.
- 전문용어가 비어 있는 분석·저장 항목은 거부해 데모 서버 fallback과 클라이언트 설명 상태가 어긋나지 않게 합니다.
- 동일한 이름과 내용의 자동 저장은 기존 항목을 갱신해 중복 목록을 만들지 않습니다.
- 동일 콘텐츠 비교는 용어와 PhraseSet 배열 순서에 영향받지 않습니다.
- 저장 용어집 로드는 `pages: []`, `mode: "saved"`인 클라이언트 분석 상태를 직접 만들며 `/api/analyze`를 호출하지 않습니다. `useLectureStream`은 이 상태의 용어와 PhraseSet을 기존 WebSocket 시작 메시지에 그대로 사용합니다. 따라서 v1에서 이전된 용어집은 새 PDF 분석 전까지 별칭 기반 정정·별칭 PhraseSet 힌트가 없습니다.
- 저장 용어집에는 페이지 본문과 PDF가 없지만 실시간 화면은 관련 자료 미리보기를 사용하지 않으므로, 쉬운 설명 피드와 용어 강조가 분석 직후 세션과 동일하게 동작합니다.
- 브라우저 저장소는 브라우저·기기·사이트 단위이며 동기화되지 않습니다. 브라우저 데이터 삭제 시 용어집도 삭제됩니다.
- 같은 사이트의 다른 탭에서 발생한 저장 변경은 `storage` 이벤트로 목록을 갱신합니다. 동시 read-modify-write는 잠그지 않으므로 실제 동시 변경은 마지막 쓰기가 우선합니다.
- 손상되거나 지원하지 않는 버전은 자동 삭제하지 않고 오류와 명시적 초기화 동작을 표시합니다. 저장 실패 시 현재 분석은 유지되어 초기화·정리 후 다시 저장할 수 있습니다.
- 실시간 모드의 용어집이 비어 있어도 데모 용어를 대신 넣지 않습니다. 데모 용어 fallback은 사용자가 데모 모드를 명시적으로 선택했을 때만 적용합니다.
- `@google-cloud/speech` 7.5.0의 공개 `streamingRecognize()` 호환 래퍼는 V2 첫 설정을 빈 설정과 `audioContent` 쓰기로 변형하므로 사용하지 않습니다. 설치된 타입이 제공하는 `_streamingRecognize()`를 직접 호출해 첫 메시지는 recognizer+전체 설정, 이후 메시지는 `audio`만 보냅니다.
- Google STT 환경은 검증된 `us` + `chirp_3` 조합만 허용하며 다른 location/model 값은 API 호출 전에 거부합니다.
- Google STT 오디오 write는 15KB 이하로 제한합니다. 정상 종료는 request 쪽만 half-close한 뒤 지연된 final과 readable `end`/`close`를 기다리고, 5초 안에 종료되지 않으면 강제 정리합니다. error/end/close/크기 초과 중 첫 terminal event만 콜백하고 클라이언트 close는 한 번만 실행합니다.
- 실제 발화 시작 시점을 신뢰성 있게 측정하지 않으므로 결과 리포트에서 표시 지연을 추정하지 않고, 검증된 PhraseSet 힌트 수를 표시합니다.
- 서버의 `final.detectedTerms`는 왼쪽부터 실제 출현한 순서와 반복을 보존합니다. canonical 자막 강조와 서버 matcher는 grapheme별 NFKC·문맥 독립 소문자화·공백·ASCII 경계 기반을 공유하고, 서버는 여기에 영문 표기·검증된 한글 별칭 경계를 추가합니다. 같은 글자 구간에 용어가 겹치면 가장 긴 표기 하나를 선택하고, 한 원문 grapheme이 여러 용어로 확장돼도 표시 자막은 glyph를 중복 생성하지 않습니다. 자막·결과용 `termIds`는 고유하게 유지하고 설명 피드용 출현 목록만 중복을 보존합니다.
- 발음 별칭은 영문 원어가 있는 용어 중 코드에서 검토된 용어-발음 쌍만 허용하며 용어당 최대 6개·별칭당 2~40자, 완성형 한글과 내부 공백/하이픈만 허용합니다. Gemini가 제안하거나 WebSocket에 직접 넣은 임의 별칭은 버립니다. 고빈도 일반 표현 차단 목록·다른 canonical/영문 표기·다른 용어의 별칭과 충돌하면 제거하거나 저장을 거부합니다. `레그`는 별도 한글 단어 앞에서 모호하므로 `레그는`은 찾지만 `레그레이즈`와 `레그 프레스`는 찾지 않습니다. 이는 오탐을 줄이는 대신 일부 RAG 발화를 놓치는 의도된 절충입니다.
- WebSocket 용어 입력은 정규화된 canonical 표기뿐 아니라 ID도 중복 제거하며, 같은 ID에는 첫 번째 유효 용어를 결정적으로 보존합니다. 이로써 서버 정정의 canonical 용어와 클라이언트 `termById` 소유권이 어긋나지 않습니다.
- 임시 자막은 STT 원문 그대로입니다. 확정 자막은 `text`와 별도로 `rawText`, `corrections`를 보존하고, 원문 위치 기준 왼쪽→오른쪽 최장 일치로 겹침·반복 치환을 방지합니다. UI는 `RAG(레그)`처럼 canonical 용어 옆에 원문을 괄호로 항상 표시하며 결과 화면에서도 같은 표기를 유지합니다.
- 공개 사용자 인증은 없으므로 외부 공개 시 Cloud Run·API 할당량으로 비용을 제한해야 합니다.
- `pnpm dev`의 Vite와 백엔드는 `127.0.0.1`에만 listen합니다. 모든 `/api/dev/*` 경로도 `NODE_ENV=development`와 loopback socket·Host·Origin을 확인하며, production의 모든 미등록 `/api` 경로는 SPA fallback 전에 JSON 404로 종료합니다.
- 개발 fixture WAV와 `manifest.local.json`은 Git·Docker에서 제외되며 자동 삭제되지 않습니다. 가명 화자 label만 사용하고 개발자가 직접 정리해야 합니다.
- capture는 wall-clock timer와 별개로 PCM 3,840,000바이트를 hard cap하고 limit 신호를 한 번만 냅니다. 화자·환경·실험문장은 녹음 시작 시 snapshot됩니다.
- fixture 저장은 canonical WAV 검증, temp 파일, 최종 rename, atomic manifest 순서이며 manifest 실패 시 WAV를 rollback합니다. process-local queue와 `.writer.lock`이 같은 root를 쓰는 복수 프로세스를 직렬화하고 실패 뒤에도 다음 요청을 처리합니다.
- same-user 로컬 개발 도구를 전제로 합니다. 직접 사용하는 fixture root·audio·파일 symlink와 경로 이탈은 거부하지만 모든 ancestor symlink/TOCTOU를 막는 sandbox라고 주장하지 않습니다.
- localhost UI와 `pnpm stt:compare`는 같은 runner를 사용해 저장 WAV를 3,200바이트 청크로 실시간 속도 재생하고 A/B/C 유료 Google STT 스트림을 각각 한 번만 엽니다. UI 시작에는 정확히 3회 호출 동의가 필요하고 job API를 폴링합니다. 자동 재시도·자동 재개·취소 route는 없습니다. 단위·통합 테스트와 브라우저 QA는 Start나 유료 API를 호출하지 않습니다.
- UI와 CLI는 fixture root의 `.stt-comparison.lock` 하나를 공유합니다. 살아 있는 PID 또는 PID 확인 권한이 없는 lock은 active로 보아 중복 시작을 막습니다. 종료된 PID의 stale lock만 owner token과 파일 identity를 재검증한 뒤 회수합니다. malformed·symlink·권한/크기 오류·PID 확인 불능 상태는 자동 삭제하지 않고 unsafe로 차단합니다.
- UI job 상태는 서버 프로세스 메모리에만 있으므로 재시작 뒤 `GET /api/dev/stt-comparison-jobs/:jobId`로 복구되지 않습니다. 원자적 쓰기까지 완료된 결과 파일은 남아 기록·상세 API에서 계속 조회됩니다.
- v3 지표는 기준 출현마다 직접 인식, 별칭 정정 성공, 누락을 하나로 결정하고 예상 밖 정정을 false correction, 예상 밖 canonical 출현을 false insertion으로 셉니다. 제품 용어 연결률은 `(직접 인식 + 별칭 정정 성공) / 기준 출현 수`입니다. 선언이 없는 녹음에서는 같은 숫자가 계산돼도 `accuracyValid=false`, `evaluationMode=smoke`입니다.
- 기존 manifest v1 녹음은 선언이 없는 것으로 이전하고, 비교 결과 v1/v2도 legacy로만 읽습니다. legacy 결과에 v3 occurrence-level 정확도 의미를 소급하지 않습니다.
- 새 v3 결과 파일명은 `comparison-<recordingId>-<jobId>.json`이며 반복 실행마다 immutable 파일을 추가합니다. 기존 `comparison-<recordingId>.json`도 그대로 남깁니다. 결과 API는 파일명·크기·symlink·스키마를 검증하고 수정 시각 최신순 history를 offset/limit으로 페이지화하며, 파일명 상세 route를 제공합니다. UI는 v1/v2에 legacy 안내만 표시하며, v3 TSV 복사는 accuracy 모드와 세 run 정상 완료·오류 없음이 모두 충족될 때만 허용합니다. 결과 조회 자체는 Google STT를 호출하지 않습니다.
- 현재 106초 녹음은 현재 기준 문장과 맞지 않아 smoke 전용입니다. 별도의 exact-script 단일 accuracy 리포트에서 A/B/C 제품 용어 연결률 17.6% / 17.6% / 94.1%가 관찰됐지만, publication-grade 수치에는 같은 WAV의 사전 계획된 반복 실행이 필요합니다.
- 현재의 `easyExplanation`은 쉬운 정의에 가깝습니다. 제품명을 유지하려면 실제 발화 문맥을 설명하는 `contextExplanation` 확장을 권장합니다.

## 주요 코드 위치

- 전체 UI: `client/src/App.tsx`
- 개발 고정음원 UI: `client/src/components/AudioFixtureRecorder.tsx`
- 저장 STT 비교 결과 UI: `client/src/components/SttComparisonResults.tsx`
- PDF 추출: `client/src/lib/pdf.ts`
- 마이크 처리: `client/src/lib/pcm-recorder.ts`
- 실시간 상태: `client/src/hooks/useLectureStream.ts`
- 브라우저 용어집: `client/src/lib/glossary-storage.ts`
- HTTP 앱·개발 API: `server/src/app.ts`
- WebSocket·listen: `server/src/index.ts`
- WAV fixture 저장·offline load: `server/src/services/audio-fixtures.ts`
- A/B/C 조건·출현 단위 지표·v3 스키마: `server/src/services/stt-comparison.ts`
- CLI·UI 공용 A/B/C runner: `server/src/services/stt-comparison-runner.ts`
- UI job 상태·진행률: `server/src/services/stt-comparison-jobs.ts`
- CLI·UI 공유 lock: `server/src/services/stt-comparison-lock.ts`
- 로컬 결과 기록·상세 조회: `server/src/services/stt-comparison-results.ts`
- 저장 WAV Google STT A/B/C 실행기: `server/src/tools/compare-stt-fixture.ts`
- 발음 별칭 검증: `server/src/services/spoken-aliases.ts`
- 원문 보존 자막 정정: `server/src/services/caption.ts`
- Gemini·자동 용어집: `server/src/services/glossary.ts`
- Google STT: `server/src/services/speech.ts`
- 데모 데이터: `server/src/services/demo.ts`
