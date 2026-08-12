# 강연 용어 AI 인수인계

## 현재 상태

한신대학교 ABC 해커톤에서 시연할 수 있는 MVP입니다. Google 자격증명이 없어도 내장 데모로 업로드 이후의 준비 화면, 실시간 자막, 반복 언급을 보존하는 용어 설명 목록과 결과 리포트를 확인할 수 있습니다. 로컬 ADC가 연결된 환경에서는 Google STT V2 실시간 스트림도 검증했습니다.

### 구현 완료

- React 기반 반응형 발표 화면
- `강연`과 DEV 전용 `STT 실험실`을 분리한 기본 탐색과 `#/lecture`, `#/experiment/setup`, `#/experiment/record`, `#/experiment/run`, `#/experiment/results` 해시 라우트
- 실험실에 `1. 실험 설정`, `2. 고정음원 녹음`, `3. A/B/C 비교 실행`, `4. 결과 기록` 보조 탐색 제공
- 브라우저 저장 용어집과 정확한 대본을 Gemini 재호출 없이 로컬 study/case 스냅샷으로 저장하고 glossary·script·case 해시와 고유 identity로 중복·덮어쓰기를 방지하는 실험 설정 UI
- 채점용 targetTerms와 PDF adaptationTerms를 분리해 A=없음, B=PDF canonical/English, C=PDF+자동 승인된 안전한 발음 별칭으로 실행하고 PDF에 없는 수동 정답 용어를 힌트에는 넣지 않는 v4 비교 계약
- 녹음과 v4 결과에 study/case/snapshot/glossary/script identity를 고정하고, 결과의 세트·케이스 필터·완전한 accuracy 평균·CSV/TSV/JSON 내보내기 제공
- 강연 `analyzing`·`live` 상태의 실험실 이동 차단과, 결과 기록의 데스크톱 history/detail pane 및 좁은 화면 목록/상세·`결과 목록으로` 전환
- PDF.js 페이지별 텍스트 추출
- Gemini 구조화 JSON 기반 자동 용어집 생성
- PDF 원문 대조, 중복 제거, 최대 50개 제한
- Google STT V2 Chirp 3 인라인 PhraseSet 구성
- Google STT V2 typed bidi 스트림과 실제 `us` 리전 연결 검증
- 브라우저 마이크 PCM 변환과 WebSocket 전송
- 실시간 마이크는 suspended AudioContext를 명시적으로 resume하고 실제 `running` 상태와 첫 PCM을 각각 확인합니다. 캡처에서는 16kHz를 선호하되 기기 기본 샘플레이트를 허용해 다운샘플링하며, 실제 AudioContext sample rate에서 100ms에 가장 가까운 ScriptProcessor power-of-two 크기를 선택합니다. Google 권고에 맞춰 브라우저 echo cancellation·noise suppression·auto gain control을 끕니다. 첫 PCM이 3초 안에 없거나 트랙·AudioContext가 중단되면 준비 완료로 가장하지 않고 오류로 종료합니다.
- Google SpeechClient는 프로세스에서 재사용하고 비동기 `initialize()`를 한 번만 기다립니다. V2 bidi 스트림의 첫 설정 write callback이 완료된 뒤에만 provider-ready를 보내고, 그 handshake 뒤에 마이크 캡처를 시작하므로 초기화 중인 서버에서 첫 음성 청크를 잃지 않습니다. 클라이언트 화면은 provider-ready와 첫 PCM을 모두 받은 뒤에만 준비 완료를 표시합니다. VAD begin/end 이벤트도 활성화해 실제 발화 감지와 첫 interim 사이를 개발 로그에서 구분할 수 있습니다.
- 16kHz mono PCM16의 초당 32,000바이트를 기준으로 브라우저 WebSocket과 서버의 이미 전달된 프레임 대기열 적체 한도를 각각 0.5초(16,000바이트)로 계산합니다. 한도를 넘으면 오래된 음성을 몰래 버리거나 늦게 재생하지 않고 세션을 실패시킵니다. 서버도 gRPC write가 backpressure를 알리면 WebSocket 입력을 pause하고, 이미 decode돼 도착한 프레임만 작은 대기열에 순서대로 보존한 뒤 drain에서 flush/resume합니다. 1초 내 drain되지 않으면 오류로 종료합니다.
- 개발 모드에서만 브라우저·서버의 세션별 단계 시간, PCM 청크 수·바이트 수, 최대 청크 간격, 최대 WebSocket bufferedAmount를 기록합니다. 음성·진폭·자막/원문·용어·프로젝트·장치 정보는 기록하지 않습니다.
- localhost 개발 화면에서 최대 120초 음성을 canonical 16kHz mono 16-bit PCM WAV로 저장하는 fixture recorder
- Vite·개발 백엔드의 `127.0.0.1` bind, 개발 녹음 API의 production JSON 404와 localhost 요청 재검증
- 3,840,000 PCM 바이트 capture hard cap과 manual/timer/limit 종료 단일화
- 녹음 시작 시 가명 화자·환경·실험문장 snapshot과 prepared 상태 선택 잠금
- temp WAV 검증·rename·atomic manifest, 실패 rollback/queue 회복과 cross-process writer lock
- 저장 WAV의 offline PCM 재로드와 15KB 이하 짝수 청크 분할 계약
- 기준 문장 각 용어의 canonical·English·안전한 한국어 발음과 출현 순서를 담는 구조화 fixture script v2
- 녹음별 **“기준 문장을 그대로 읽었습니다”** 선언과, 선언 없는 기존 manifest v1 녹음을 smoke 전용으로 읽는 v2 호환 경계
- 고정 음원을 PhraseSet 없음(A), canonical+English PhraseSet(B), canonical+English+안전한 한국어 발음 PhraseSet 및 별칭 정정(C) 순서로 실행하는 비교 코어
- localhost UI에서 저장 녹음 선택, 유료 Google STT 스트림 정확히 3회 호출 동의, 비동기 job 시작과 A/B/C 진행 상태 폴링
- UI와 CLI가 함께 사용하는 `.stt-comparison.lock` 기반 cross-process 단일 실행과 stale PID의 검증 후 회수·unsafe lock 차단
- 직접 인식·별칭 정정 성공·누락·잘못된 정정·잘못된 삽입·제품 용어 연결률을 출현 단위로 계산하는 비교 결과 v3
- `comparison-<recordingId>-<jobId>.json` immutable 결과 저장과 기존 파일 보존, 수정 시각 최신순 페이지 목록·파일별 상세 조회
- 저장된 v3/v4 결과의 조건 차트·A/B/C 원문/표시 자막·용어별 표와, 정확도·세 run 정상 완료 조건에서만 활성화되는 TSV 복사를 제공하고 v1/v2를 안내-only legacy로 격리하는 localhost 개발 결과 화면
- 약 1.25~1.5rem의 기본 글꼴과 비례 확대한 큰 글씨·매우 큰 글씨 3단계, Google STT 응답의 비어 있지 않은 임시 원문 구간을 응답마다 하나로 이어 확정 자막과 같은 크기의 어두운 아래 행에 즉시 갱신하고 final 수신 즉시 밝은 정정 확정 자막으로 전환하는 최대 세 행 실시간 자막. 행은 선택한 글꼴 크기에 맞춘 높이와 12px 간격으로 아래부터 공간을 채웁니다. 다음 발화가 아래 행에 즉시 생길 때만 남아 있는 확정 행을 실제 이전·현재 DOM 위치 차이로 약 240ms 동안 위로 이동하며, 반복 interim과 interim→final 치환은 재애니메이션하지 않습니다. 빠른 갱신·unmount와 reduced-motion 전환에서는 앱이 소유한 모션을 취소하고 새 아래 행과 고정 `aria-live` wrapper를 유지합니다.
- 용어 강조, 반복 언급마다 생성되는 최신순 쉬운 설명 목록
- PDF 전문용어를 원문 검증한 뒤 원본 용어를 최대 50개로 제한하고, 영문 표기와 Gemini 한글 발음은 원본 개수에 포함하지 않은 채 PhraseSet에 추가합니다. 한글 발음은 안전 규칙으로 자동 승인하며 알려진 기술용어 발음은 누락 보완에만 사용합니다.
- 임시 자막 원문 유지, 확정 자막의 위치 기반 canonical 정정, `rawText`·정정 내역 보존
- 자막에 `RAG(레그)`처럼 canonical 용어와 STT 원문을 나란히 표시하고 canonical 용어 설명 카드 연결
- API 없는 데모 모드
- 분석 완료 시 전체 `GlossaryTerm[]`과 `phraseSet`의 브라우저 `localStorage` v3 자동 저장
- 기존 localStorage v1의 빈 별칭·ID·PhraseSet을 보존하는 v3 이전과 v2의 안전하지 않은 별칭을 제거하는 v3 이전
- 앱 새로고침·서버 재시작 뒤 저장 용어집 목록/로드, 이름 변경, 삭제
- 저장 용어집 로드 시 Gemini 분석 없이 기존 WebSocket live/demo 시작 메시지 재사용
- 저장 형식 엄격 검증, 정규화 중복 제거, 용어 ID 보존, 저장 공간·차단·손상·버전 오류 표시
- PDF 없는 저장 용어집 세션에서도 동일한 실시간 용어 설명 목록 제공
- 전체 분석 PhraseSet의 WebSocket 전달과 Google STT 적용
- 데모·실시간 종료 이벤트의 자동 결과 화면 전환
- 타입 검사, 프로토콜·용어 검증 테스트, 프로덕션 빌드
- Docker 이미지 빌드와 컨테이너 헬스 체크

### 2026-08-09 독립 리뷰 조치와 후속 변경

- P1 임의·모호한 별칭 오정정: 최초에는 고정 검토 목록으로 제한했으나, 후속 요구에 따라 영문 용어의 Gemini 한글 발음을 사용자 검토 없이 자동 승인하도록 바꿨습니다. 대신 완성형 한글·길이·개수·일반 단어 차단·canonical/English 및 용어 간 충돌 제거를 유지하고, `사과를 먹습니다.`를 `API`로 바꾸지 않으며 `레그 프레스`도 RAG로 바꾸지 않는 회귀 테스트를 유지합니다.
- P2 WebSocket 중복 용어 ID: **수용**. 정규화된 용어 표기와 ID를 각각 검사하고, 중복 ID는 첫 번째 유효 용어만 남겨 자막 canonical 표기와 클라이언트 설명 카드 소유권을 일치시켰습니다.
- P3 v1 별칭 계약 불일치: **수용**. WebSocket의 숨은 알려진 별칭 보완을 제거해 v1의 빈 별칭과 기존 PhraseSet이 클라이언트·서버에서 일치합니다. 기존 v2도 열리지 않게 만들지 않도록 저장 버전을 v3으로 올리고 안전하게 이전합니다.
- 의미 분류기를 추가하는 범위는 보류했습니다. 그 결과 `레그 기반`처럼 실제 RAG를 뜻해도 모호한 별칭 뒤에 별도 한글 단어가 오면 정정하지 않을 수 있으며, 이는 오정정보다 누락을 택한 의도된 제한입니다. 자동 승인 방식은 새 용어 확장성을 높이는 대신 Gemini의 드문 오발음 후보가 안전 규칙을 통과할 위험을 수용합니다.

## 실제 Google STT 검증 결과

2026-08-08 기준으로 프로젝트 ID가 활성 `gcloud` 프로젝트와 일치하고, Speech-to-Text API 활성화와 ADC 인증이 유효한 로컬 환경에서 확인했습니다. 프로젝트 ID와 인증정보는 문서와 로그에 기록하지 않았습니다.

- 엔드포인트: `us-speech.googleapis.com`
- recognizer: `projects/{project}/locations/us/recognizers/_`
- 모델·언어: `chirp_3`, `ko-KR`
- 빈 PhraseSet + 0.25초 무음: 스트림 정상 수락·종료, 임시 0개·확정 0개
- 인라인 PhraseSet 1개 + 0.25초 무음: 스트림 정상 수락·종료, 임시 0개·확정 1개
- 빈 PhraseSet + 로컬 한국어 음성: 3,200바이트 단위 16kHz mono LINEAR16 전송, 임시 1개·확정 1개
- 저장 WAV 106초 legacy A/B 스모크: 당시 PhraseSet 없음과 영문 targetTerms 17개 적용 조건 모두 전체 음원 재생·확정 자막 12개·오류 0개

별도의 한 번의 로컬 실시간 마이크 진단에서는 provider 설정 write가 세션 시작 후 약 31.42ms, 첫 PCM 전송이 약 371.86ms에 끝났습니다. 첫 발화는 VAD begin 뒤 interim 없이 약 3.465초 만에 final이 왔고, 뒤의 다른 발화에서는 VAD begin 뒤 첫 interim까지 약 5.456초가 걸렸습니다. 클라이언트와 서버는 비어 있지 않은 interim을 필터·debounce·final 대기 없이 즉시 전달하므로, 이 관찰에서는 provider 응답 생성 시점이 체감 지연을 지배했습니다. 다만 한 세션 관찰일 뿐 기기·화자·네트워크 전체의 지연 보장이나 일반 벤치마크가 아닙니다.

Google V2의 [`interimResults`](https://cloud.google.com/speech-to-text/v2/docs/reference/rpc/google.cloud.speech.v2#streamingrecognitionfeatures)는 interim 반환 여부만 제공합니다. 단어별·고정 주기 cadence나 첫 interim SLA는 제공하지 않습니다. Chirp 3에는 `ENDPOINTING_SENSITIVITY_SHORT`를 적용해 발화 뒤 침묵에서 final을 더 민감하게 확정하도록 요청합니다. 이는 final endpointing의 지연·분절 절충이며, 짧은 멈춤에서 문장이 더 잘게 나뉠 수 있고 interim 생성 빈도나 속도 개선을 보장하지 않습니다.
- 같은 과거 스모크에서 영문 정확 표기는 0개에서 1개(`PhraseSet`)로 증가했지만 `RAG`는 `레그`, `Transformer`는 `트랜스포머`, `Fine-tuning`은 `파인 튜닝`으로 남았습니다.
- 최신 기준 문장을 그대로 읽었다고 선언한 한 녹음의 완전한 accuracy 리포트에서 제품 용어 연결률 A/B/C가 각각 **17.6% / 17.6% / 94.1%**로 관찰됐습니다.

무음 인라인 PhraseSet 호출의 확정 결과는 연결 성공 근거로만 사용하며 정확도 근거로 사용하지 않습니다. 현재 106초 WAV도 예전 프로젝트 소개 대본을 읽어 현재 기준 문장과 불일치하므로, 새 v3 실행기에 넣더라도 `smoke`일 뿐 누락·연결률을 논문 정확도로 사용할 수 없습니다. 한국어식 영어 발음 별칭이 필요하다는 관찰 근거로만 보존합니다.

현재 기준 문장은 실제 발화를 `엘엘엠`, `래그`, `에이피아이`, `프레이즈셋`처럼 한국어 발음으로 명시했습니다. 위 17.6% / 17.6% / 94.1%는 이 문장을 그대로 읽었다고 선언한 **단일 완전 리포트의 관찰값**이며 일반적 개선율이나 publication-grade 결론이 아닙니다. 같은 WAV의 A/B/C 반복 수와 요약 방식을 사전에 고정한 반복 실험이 여전히 필요합니다. 상세 프로토콜과 해석 제한은 [STT PhraseSet 파일럿 실험 기록](STT_PHRASESET_PILOT.md)에 보존되어 있습니다.

## 아직 실제 자격증명·기기로 검증하지 않은 부분

- Gemini 3.6 Flash 실제 PDF 호출
- 실제 발표용 브라우저·마이크 권한과 음질
- 실제 마이크 발화에서 SHORT endpointing 전후의 VAD begin→final 분포·문장 분절률, VAD begin→첫 interim 지연 및 서로 다른 기기·네트워크의 backpressure 동작. 현재 수치는 한 세션 관찰이고, 단위 테스트와 무과금 브라우저 QA는 전송·상태·모션 계약만 검증하며 Google이 interim을 보내는 주기 자체는 보장하지 않습니다.
- 보존된 exact-script WAV의 반복 A/B/C 실행과 논문용 요약 통계
- Cloud Run 배포 환경의 WebSocket 장시간 연결
- Secret Manager와 Cloud Run 서비스 계정 연결

## 다음 개발 우선순위

1. 단일 accuracy 리포트에 사용한 exact-script WAV를 보존하고 같은 녹음으로 A/B/C를 여러 차례 실행해 조건별 직접 인식·별칭 정정·누락·오정정·오삽입·제품 용어 연결률의 분포를 확인합니다. 기존 106초 음원은 smoke 회귀에만 사용합니다.
2. 논문에 반복 수, 실행 시각, 모델·리전, 집계 방식과 개별 실행값을 함께 기록합니다.
3. 자동 생성 발음의 오정정률을 별도로 집계하고, 안전 차단 목록이나 문맥 규칙을 보완할 필요가 있는지 판단합니다.
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

## 문서 반영 범위

UI 탐색 구조의 사용자 안내는 `README.md`, 구현 상태와 브라우저 QA 인수인계는 이 문서만 갱신합니다. 새 권위 문서는 만들지 않으며, API 계약과 STT 실험 프로토콜·해석 제한의 기존 권위 문서는 변경하지 않습니다.

## 빠른 확인 절차

```bash
pnpm install
cp .env.example .env
pnpm typecheck
pnpm test
pnpm build
pnpm dev
```

1. 데스크톱 너비에서 `http://localhost:5173/#/lecture`에 접속하고 기본 탐색이 `강연`과 DEV 전용 `STT 실험실`로 분리되는지 확인합니다.
2. `강연` 페이지에는 PDF 분석, `샘플 강연 바로 체험하기`, `이 브라우저의 용어집`만 있고 실험 도구가 섞여 있지 않은지 확인합니다.
3. `샘플 강연 바로 체험하기`를 누릅니다.
4. 자동 용어집 5개가 표시되는지 확인합니다.
5. `데모 자막으로 미리보기`를 누르고 `live` 동안 `STT 실험실` 이동이 차단되는지 확인합니다. PDF 분석 중인 `analyzing` 상태에도 같은 차단이 적용됩니다.
6. 기본 자막이 약 1.25~1.5rem로 표시되고 글자 크기 버튼이 `보통`·`크게`·`매우 크게` 3단계를 순환하는지 확인합니다. `LIVE CAPTION`에는 최대 세 행이 아래부터 채워져야 하며 선택한 자막 크기를 기준으로 3개 한 줄 높이와 두 번의 12px 간격이 예약되어야 합니다. 첫 임시 자막은 어두운 색의 가장 아래 행에 즉시 나타나고 final 수신 즉시 같은 행의 밝은 정정 확정 자막으로 바뀌어야 합니다. 한 Google STT 응답에 여러 interim 구간이 있으면 제공자가 준 문자열 경계를 그대로 이어 하나의 아래 행 업데이트로 표시하고, 다음 응답에서는 그 전체를 다시 교체해야 합니다. 다음 발화가 시작되면 새 아래 행은 opacity 없이 즉시 보이고, 남아 있는 확정 행만 직전 rect에서 새 rect까지 약 240ms transform-only FLIP으로 위로 이동해야 합니다. final 수신 시와 반복 interim에는 다시 움직이지 않아야 하며, 네 번째 발화에서는 가장 오래된 확정 자막만 기록 영역으로 이동해야 합니다. 320px·639px·desktop 너비와 모든 글꼴 단계에서 1~3줄로 래핑되는 한글·영문을 확인하고, 시작/종료 rect와 delta·12px 간격·겹침 없음·최대 3행을 검증합니다. 빠른 연속 갱신은 이전 owned animation을 취소하고 최종 DOM이 맞아야 하며, `prefers-reduced-motion: reduce`에서는 승격 애니메이션이 없어야 합니다. 고정 current `aria-live` wrapper는 interim→final에서도 유지되어야 합니다.
7. 정정된 `RAG`가 오른쪽 피드 맨 위에 새 쉬운 설명 카드를 만들고 이전 카드가 아래에 남는지 확인합니다.
8. 마지막 데모 자막 뒤 자동으로 결과 리포트가 표시되고 확정 자막 4개와 `RAG(레그)` 표기가 유지되는지 확인합니다.
9. `처음으로` 이동해 `#/lecture`의 `이 브라우저의 용어집`에 샘플 용어집이 표시되는지 확인합니다.
10. 페이지를 새로고침하거나 개발 서버를 다시 시작한 뒤 같은 용어집이 유지되는지 확인합니다.
11. 저장 용어집을 불러와 분석 화면이나 `/api/analyze` 요청 없이 준비 화면으로 이동하는지 확인합니다.
12. `실시간 강연 시작` 시 저장된 전체 용어와 PhraseSet이 WebSocket `start` 메시지에 포함되고, 자막 강조와 쉬운 설명이 동작하는지 확인합니다.
13. 저장 용어집 세션에서도 관련 자료 영역 없이 오른쪽 전체를 용어 설명 목록으로 사용하고, 같은 용어의 반복 카드가 각각 유지되는지 확인합니다.
14. `#/lecture`에서 용어집 이름 변경과 삭제를 확인합니다.
15. `#/experiment/setup`에서 실험 세트를 만들고 저장된 브라우저 용어집·정확한 대본·채점 용어로 케이스를 저장합니다. 이때 `/api/analyze`나 Gemini 호출이 발생하지 않는지 확인합니다.
16. `#/experiment/record`로 이동해 `2. 고정음원 녹음`에서 방금 만든 `[실험 케이스]` 대본을 선택하고 가명 화자와 환경을 선택해 녹음합니다.
17. 정확도용 녹음이라면 화면의 문장을 그대로 읽고 **“기준 문장을 그대로 읽었습니다”**를 선택합니다. 일부를 바꾸거나 빼고 읽었다면 선택하지 않습니다.
18. 녹음 종료와 최대 120초 timer/PCM hard cap 종료가 한 번만 처리되는지, 미리 듣기와 재녹음이 동작하는지 확인합니다.
19. 저장 뒤 `test-fixtures/stt/audio/*.wav`와 `manifest.local.json`이 생성되고 Git 상태에 나타나지 않는지 확인합니다.
20. `#/experiment/run`에서 `3. A/B/C 비교 실행`과 저장 녹음 selector, 3회 유료 호출 동의 문구, 동의 전 비활성 Start 상태까지만 확인합니다.
21. 테스트·브라우저 QA에서는 `A/B/C 비교 시작`을 누르거나 `POST /api/dev/stt-comparison-jobs`를 호출하지 않습니다. 저장 녹음 selector, 3회 유료 호출 동의 문구와 동의 전 비활성 Start 상태까지만 확인합니다. `pnpm test`도 Google STT를 호출하지 않습니다.
22. `#/experiment/results`에서 `4. 결과 기록`이 선택되고, 세트·케이스 필터와 집계 표·CSV/TSV/JSON 내보내기, 데스크톱 history/detail pane을 확인합니다.
23. 기존 저장 결과만 사용해 새로고침, 이전/다음 페이지와 파일 선택이 해당 상세 리포트를 여는지 확인합니다. 이 목록·상세 동작은 유료 호출을 만들지 않습니다.
24. 좁은 화면에서 `#/experiment/results`가 목록을 먼저 표시하고, 파일을 선택하면 상세만 표시되며 `결과 목록으로`가 목록으로 돌아가는지 확인합니다.
25. 정확도 모드이고 세 run이 모두 오류 없이 완료된 v3/v4에서만 TSV 복사가 활성화되는지 확인합니다. smoke는 차트·자막·표를 표시하되 TSV 복사가 비활성화되어야 합니다.
26. v1/v2가 `레거시 스모크 결과` 안내만 표시하고 지표·자막·v3/v4 차트·표·TSV를 추정하지 않는지 확인합니다.

실제 유료 측정은 브라우저 QA와 분리해 [STT PhraseSet 파일럿 실험 기록](STT_PHRASESET_PILOT.md)의 프로토콜로만 수행합니다. 이때 저장 녹음 선택과 정확히 3회 호출 동의 후 Start를 한 번 누르며, 자동 재시도·취소가 없고 공유 lock이 중복 UI/CLI 시작을 막는다는 점을 전제로 합니다.

## 알려진 제한과 결정 사항

- OCR을 넣지 않았으므로 스캔 이미지 PDF는 처리하지 못합니다.
- PDF는 브라우저에서 추출하며 Python 런타임을 사용하지 않습니다.
- 강연자 검수 단계 없이 PDF 원문 대조 결과를 자동 채택합니다.
- PDF와 실시간 강연 음성은 서버에 저장하지 않으며 데이터베이스가 없습니다. localhost 개발 녹음 카드에서 사용자가 명시적으로 만든 fixture만 프로젝트 로컬에 보존합니다.
- 강연용 용어집 원본은 `lecture-context-ai.glossaries` 키의 버전 3 브라우저 저장소에만 저장합니다. 실험 설정에서 사용자가 명시적으로 선택한 용어집은 재현 가능한 케이스 스냅샷으로 `test-fixtures/stt/studies.local.json`에 복사되며 Git·Docker에서 제외됩니다. PDF 바이너리와 추출 페이지 본문은 이 스냅샷에 저장하지 않습니다.
- 저장 필드는 용어집 메타데이터(`id`, `name`, `createdAt`, `updatedAt`), `spokenAliases`를 포함한 완전한 `GlossaryTerm[]`, `phraseSet`으로 제한합니다. PDF, 추출 페이지 텍스트, `pdfUrl`, 음성, 경고, API 키는 제외합니다.
- 저장 데이터는 정확한 필드 집합과 타입·길이·개수·타임스탬프·PhraseSet/용어 대응 관계를 검증합니다. 정규화 중복은 제거하되 채택한 용어의 기존 ID는 유지합니다.
- 이전 구현에서 정확히 50개로 잘린 v3 PhraseSet은 저장된 원본 용어와 안전한 발음 별칭을 로드 시 보완합니다. PDF나 Gemini를 다시 호출하지 않으며, 과거에 잘린 영문 확장 표기는 원문 근거를 복구할 수 없으므로 기존 PhraseSet에 남아 있던 값만 유지합니다.
- 전문용어가 비어 있는 분석·저장 항목은 거부해 데모 서버 fallback과 클라이언트 설명 상태가 어긋나지 않게 합니다.
- 동일한 이름과 내용의 자동 저장은 기존 항목을 갱신해 중복 목록을 만들지 않습니다.
- 동일 콘텐츠 비교는 용어와 PhraseSet 배열 순서에 영향받지 않습니다.
- 저장 용어집 로드는 `pages: []`, `mode: "saved"`인 클라이언트 분석 상태를 직접 만들며 `/api/analyze`를 호출하지 않습니다. `useLectureStream`은 이 상태의 용어와 PhraseSet을 기존 WebSocket 시작 메시지에 그대로 사용합니다. 따라서 v1에서 이전된 용어집은 새 PDF 분석 전까지 별칭 기반 정정·별칭 PhraseSet 힌트가 없습니다.
- 저장 용어집에는 페이지 본문과 PDF가 없지만 실시간 화면은 관련 자료 미리보기를 사용하지 않으므로, 쉬운 설명 목록과 용어 강조가 분석 직후 세션과 동일하게 동작합니다.
- 브라우저 저장소는 브라우저·기기·사이트 단위이며 동기화되지 않습니다. 브라우저 데이터 삭제 시 용어집도 삭제됩니다.
- 같은 사이트의 다른 탭에서 발생한 저장 변경은 `storage` 이벤트로 목록을 갱신합니다. 동시 read-modify-write는 잠그지 않으므로 실제 동시 변경은 마지막 쓰기가 우선합니다.
- 손상되거나 지원하지 않는 버전은 자동 삭제하지 않고 오류와 명시적 초기화 동작을 표시합니다. 저장 실패 시 현재 분석은 유지되어 초기화·정리 후 다시 저장할 수 있습니다.
- 실시간 모드의 용어집이 비어 있어도 데모 용어를 대신 넣지 않습니다. 데모 용어 fallback은 사용자가 데모 모드를 명시적으로 선택했을 때만 적용합니다.
- `@google-cloud/speech` 7.5.0의 공개 `streamingRecognize()` 호환 래퍼는 V2 첫 설정을 빈 설정과 `audioContent` 쓰기로 변형하므로 사용하지 않습니다. 설치된 타입이 제공하는 `_streamingRecognize()`를 직접 호출해 첫 메시지는 recognizer+전체 설정, 이후 메시지는 `audio`만 보냅니다.
- Google STT 환경은 검증된 `us` + `chirp_3` 조합만 허용하며 다른 location/model 값은 API 호출 전에 거부합니다.
- Google STT 오디오 write는 15KB 이하로 제한합니다. 정상 종료는 request 쪽만 half-close한 뒤 지연된 final과 readable `end`/`close`를 기다리고, 5초 안에 종료되지 않으면 강제 정리합니다. error/end/close/크기 초과 중 첫 terminal event만 콜백하고 클라이언트 close는 한 번만 실행합니다.
- 실제 발화 시작 시점을 신뢰성 있게 측정하지 않으므로 결과 리포트에서 표시 지연을 추정하지 않고, 검증된 PhraseSet 힌트 수를 표시합니다.
- 서버의 `final.detectedTerms`는 왼쪽부터 실제 출현한 순서와 반복을 보존합니다. canonical 자막 강조와 서버 matcher는 grapheme별 NFKC·문맥 독립 소문자화·공백·ASCII 경계 기반을 공유하고, 서버는 여기에 영문 표기·검증된 한글 별칭 경계를 추가합니다. 같은 글자 구간에 용어가 겹치면 가장 긴 표기 하나를 선택하고, 한 원문 grapheme이 여러 용어로 확장돼도 표시 자막은 glyph를 중복 생성하지 않습니다. 자막·결과용 `termIds`는 고유하게 유지하고 용어 설명 목록에 사용하는 출현 목록만 중복을 보존합니다.
- 발음 별칭은 영문 원어가 있는 용어에만 허용하며 용어당 최대 6개·별칭당 2~40자, 완성형 한글과 내부 공백/하이픈만 허용합니다. Gemini가 제안한 값은 이 안전 규칙을 통과하면 자동 승인하고, 알려진 기술용어 목록은 결정적 보완에만 사용합니다. 고빈도 일반 표현 차단 목록·다른 canonical/영문 표기·다른 용어의 별칭과 충돌하면 제거하거나 저장을 거부합니다. `레그`는 별도 한글 단어 앞에서 모호하므로 `레그는`은 찾지만 `레그레이즈`와 `레그 프레스`는 찾지 않습니다. 이는 오탐을 줄이는 대신 일부 RAG 발화를 놓치는 의도된 절충입니다.
- WebSocket 용어 입력은 정규화된 canonical 표기뿐 아니라 ID도 중복 제거하며, 같은 ID에는 첫 번째 유효 용어를 결정적으로 보존합니다. 이로써 서버 정정의 canonical 용어와 클라이언트 `termById` 소유권이 어긋나지 않습니다.
- Google STT V2의 한 응답에는 새 final prefix 뒤에 여러 interim 구간이 올 수 있습니다. 서버는 final을 순서대로 먼저 전달하고, interim 원문은 제공자가 준 각 문자열을 구분자 없이 이어 합친 바깥 공백만 제거한 뒤 응답당 정확히 한 번 전달합니다. 임의의 공백·단어·문자를 만들거나 interim을 정정하지 않으며, 다음 응답의 interim 전체가 현재 아래 행을 교체합니다. 확정 자막은 `text`와 별도로 `rawText`, `corrections`를 보존하고, 원문 위치 기준 왼쪽→오른쪽 최장 일치로 겹침·반복 치환을 방지합니다. UI는 `RAG(레그)`처럼 canonical 용어 옆에 원문을 괄호로 항상 표시하며 결과 화면에서도 같은 표기를 유지합니다. 앱은 throttle/debounce하지 않지만 제공자가 첫 interim을 보내는 시점이나 매우 빠른 연속 이벤트를 브라우저가 각각 별도의 physical paint로 보여주는 것은 보장하지 않습니다.
- Chirp 3 스트리밍 설정은 설치된 `@google-cloud/speech` enum의 `ENDPOINTING_SENSITIVITY_SHORT`를 사용합니다. 이 설정은 발화 뒤 침묵에서 final endpoint를 더 민감하게 잡는 대신 짧은 멈춤에서 문장을 분절할 수 있으며 interim cadence를 바꾸는 근거는 아닙니다. 모델·리전·오디오 프레임·PhraseSet·자동 문장부호는 이 지연 조정에서 변경하지 않았습니다.
- 라이브 자막 승격은 semantic final ID별 이전·현재 DOM rect를 `useLayoutEffect`에서 측정해 retained final에만 WAAPI transform을 적용합니다. 새 current 아래 행은 불투명 surface 위에 즉시 표시해 이동 중인 이전 글자와 겹쳐 보이지 않으며 clone·ghost·opacity 전환을 만들지 않습니다. 반복 interim, interim→final, placeholder→첫 발화에는 승격을 적용하지 않고 final-only 새 발화는 retained final을 승격합니다. 갱신·unmount·reduced-motion에서는 앱 소유 animation을 취소합니다.
- 개발 빌드는 비어 있지 않은 interim/final 이벤트를 받은 뒤 `requestAnimationFrame` 다음 task까지의 시간을 `caption-receive-to-after-paint-estimate` 디버그 로그로 남깁니다. 로그에는 일련번호·이벤트 종류·시각·기간만 있고 자막·음성 내용은 없습니다. 이 수치는 앱 수신부터 다음 렌더링 기회 이후까지의 추정치이며 실제 화면 제시 완료나 제공자 발화→응답 지연을 증명하지 않습니다. production 빌드에서는 수집하지 않습니다.
- 개발 빌드의 `live-stt-diagnostic`은 브라우저에서 WebSocket open·recorder running·first PCM·provider ready·첫 interim/final을, 서버에서 client initialized·config written·first PCM·gRPC backpressure/drain·VAD begin/end·첫 interim/final을 단계별로 기록합니다. 세션 난수 ID와 경과 시간·청크/바이트 카운터만 사용하며 음성 내용·진폭·자막/원문·용어·프로젝트 ID·장치 label은 기록하지 않습니다. Google VAD는 발화 감지 경계를 관찰하기 위한 것이며 interim 생성 빈도를 높이거나 단어 단위 결과를 보장하지 않습니다.
- 브라우저 capture-ready는 provider-ready handshake 뒤 AudioContext `running`과 첫 PCM이 모두 확인되어야 하며 첫 PCM이 3초 안에 없으면 오류로 종료합니다. 서버 provider-ready는 공유 SpeechClient의 `initialize()`와 첫 설정 write callback 완료 뒤에만 전송합니다. handshake 전 PCM은 전송하지 않으므로 비동기 서버 초기화 중 첫 청크가 `active` 세션 없이 버려지는 경쟁 조건을 만들지 않습니다. 설치된 `@google-cloud/speech` 7.5.0의 `_streamingRecognize()`는 내부에서 초기화를 비동기로 시작하고 gax StreamProxy가 실제 gRPC writable 연결 전 write를 cork하므로, 초기화를 선행하고 config callback까지 기다리는 순서를 유지해야 합니다. callback은 설정 write가 실제 writable에 전달됐다는 경계이지 첫 인식 응답이나 성공한 발화 인식을 보장하지 않습니다.
- 실시간 WebSocket 고수위와 서버의 already-delivered frame 대기열은 magic byte가 아니라 PCM16 mono 16kHz의 32,000바이트/초 × 허용 적체 0.5초 = 16,000바이트로 계산합니다. 초과 시 stale audio를 몰래 버리거나 계속 쌓지 않고 세션을 실패시킵니다. 서버 gRPC write가 `false`를 반환하면 이미 수락된 현재 청크는 보존하고 WebSocket ingress를 pause합니다. pause 전에 이미 decode된 후속 프레임은 16,000바이트까지만 순서대로 보존해 `drain`에서 먼저 flush한 다음 resume하며, flush 중 다시 backpressure가 생기면 남은 순서를 유지합니다. 1초 동안 drain되지 않거나 대기열이 넘으면 입력을 재개한 뒤 명시적 오류와 1013 close로 세션을 종료합니다.
- 공개 사용자 인증은 없으므로 외부 공개 시 Cloud Run·API 할당량으로 비용을 제한해야 합니다.
- `pnpm dev`의 Vite와 백엔드는 `127.0.0.1`에만 listen합니다. 모든 `/api/dev/*` 경로도 `NODE_ENV=development`와 loopback socket·Host·Origin을 확인하며, production의 모든 미등록 `/api` 경로는 SPA fallback 전에 JSON 404로 종료합니다.
- 개발 fixture WAV와 `manifest.local.json`은 Git·Docker에서 제외되며 자동 삭제되지 않습니다. 가명 화자 label만 사용하고 개발자가 직접 정리해야 합니다.
- capture는 wall-clock timer와 별개로 PCM 3,840,000바이트를 hard cap하고 limit 신호를 한 번만 냅니다. 화자·환경·실험문장은 녹음 시작 시 snapshot됩니다.
- fixture 저장은 canonical WAV 검증, temp 파일, 최종 rename, atomic manifest 순서이며 manifest 실패 시 WAV를 rollback합니다. process-local queue와 `.writer.lock`이 같은 root를 쓰는 복수 프로세스를 직렬화하고 실패 뒤에도 다음 요청을 처리합니다.
- same-user 로컬 개발 도구를 전제로 합니다. 직접 사용하는 fixture root·audio·파일 symlink와 경로 이탈은 거부하지만 모든 ancestor symlink/TOCTOU를 막는 sandbox라고 주장하지 않습니다.
- localhost UI와 `pnpm stt:compare`는 같은 runner를 사용해 저장 WAV를 3,200바이트 청크로 실시간 속도 재생하고 A/B/C 유료 Google STT 스트림을 동시에 각각 한 번만 엽니다. 입력 순서대로 결과를 저장하되 각 스트림 오류는 격리하며, UI는 job API에서 세 조건의 재생률을 폴링합니다. UI 시작에는 정확히 3회 호출 동의가 필요합니다. 자동 재시도·자동 재개·취소 route는 없습니다. 단위·통합 테스트와 브라우저 QA는 Start나 유료 API를 호출하지 않습니다.
- UI와 CLI는 fixture root의 `.stt-comparison.lock` 하나를 공유합니다. 살아 있는 PID 또는 PID 확인 권한이 없는 lock은 active로 보아 중복 시작을 막습니다. 종료된 PID의 stale lock만 owner token과 파일 identity를 재검증한 뒤 회수합니다. malformed·symlink·권한/크기 오류·PID 확인 불능 상태는 자동 삭제하지 않고 unsafe로 차단합니다.
- UI job 상태는 서버 프로세스 메모리에만 있으므로 재시작 뒤 `GET /api/dev/stt-comparison-jobs/:jobId`로 복구되지 않습니다. 원자적 쓰기까지 완료된 결과 파일은 남아 기록·상세 API에서 계속 조회됩니다.
- v3 지표는 기준 출현마다 직접 인식, 별칭 정정 성공, 누락을 하나로 결정하고 예상 밖 정정을 false correction, 예상 밖 canonical 출현을 false insertion으로 셉니다. 제품 용어 연결률은 `(직접 인식 + 별칭 정정 성공) / 기준 출현 수`입니다. 선언이 없는 녹음에서는 같은 숫자가 계산돼도 `accuracyValid=false`, `evaluationMode=smoke`입니다.
- 기존 manifest v1 녹음은 선언이 없는 것으로 이전하고, 비교 결과 v1/v2도 legacy로만 읽습니다. legacy 결과에 v3 occurrence-level 정확도 의미를 소급하지 않습니다.
- 새 결과 파일명은 `comparison-<recordingId>-<jobId>.json`이며 현재 runner는 identity를 포함한 v4를 반복 실행마다 immutable 파일로 추가합니다. 기존 `comparison-<recordingId>.json`과 v1~v3 결과도 그대로 남겨 읽습니다. 결과 API는 파일명·크기·symlink·스키마를 검증하고 수정 시각 최신순 history를 study/case 필터와 함께 페이지화하며, 파일명 상세 route를 제공합니다. UI는 v1/v2에 legacy 안내만 표시하며, v3/v4 TSV 복사는 accuracy 모드와 세 run 정상 완료·오류 없음이 모두 충족될 때만 허용합니다. 결과 조회 자체는 Google STT를 호출하지 않습니다.
- 현재 106초 녹음은 현재 기준 문장과 맞지 않아 smoke 전용입니다. 별도의 exact-script 단일 accuracy 리포트에서 A/B/C 제품 용어 연결률 17.6% / 17.6% / 94.1%가 관찰됐지만, publication-grade 수치에는 같은 WAV의 사전 계획된 반복 실행이 필요합니다.
- 현재의 `easyExplanation`은 쉬운 정의에 가깝습니다. 제품명을 유지하려면 실제 발화 문맥을 설명하는 `contextExplanation` 확장을 권장합니다.

## 주요 코드 위치

- 전체 UI: `client/src/App.tsx`
- STT 실험실 탐색·해시 라우트 셸: `client/src/components/ExperimentWorkspace.tsx`
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
