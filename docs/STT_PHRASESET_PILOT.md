# STT PhraseSet 파일럿과 A/B/C v3 실험 기록

작성일: 2026-08-09

## 1. 이 문서의 목적

실제 Google Speech-to-Text V2로 수행한 기존 고정음원 파일럿과 현재 구현된 A/B/C 비교 규칙을 구분해 기록한다. 기존 106초 결과는 연결과 표기 변화를 확인한 **legacy 스모크 테스트**다. 최신 기준 문장을 그대로 읽었다고 선언한 별도 녹음에서는 완전한 accuracy 리포트 하나가 생성됐지만, 이는 단일 실행 관찰이며 publication-grade 반복 실험과 구분한다.

## 2. 보존 중인 106초 legacy 음원

- 녹음 ID: `6d9c7e31-9df8-454d-b6fa-8a7423773163`
- 음원: `test-fixtures/stt/audio/20260809001249-6d9c7e31-9df8-454d-b6fa-8a7423773163.wav`
- 길이: 106.435초
- 형식: 16 kHz, mono, 16-bit PCM WAV
- 환경: `speaker-a`, quiet
- 과거 비교 결과: `test-fixtures/stt/results/comparison-6d9c7e31-9df8-454d-b6fa-8a7423773163.json` (기존 파일명 그대로 보존)
- STT 조건: Google Speech-to-Text V2, `chirp_3`, `ko-KR`, `us`
- 평가 상태: `smoke`

이 음원은 녹음 당시 화면의 고정 문장이 아니라 별도의 프로젝트 소개 대본을 읽었다. 현재 `scripts.json`의 문장과 용어 출현 순서가 맞지 않으며 **“기준 문장을 그대로 읽었습니다”** 선언도 없다. 새 v3 실행기에 넣으면 연결 회귀는 볼 수 있지만, 계산된 누락이나 연결률을 publication accuracy로 인용하면 안 된다.

음원과 결과 JSON은 개인정보 및 API 결과를 포함할 수 있어 Git과 Docker에서 제외된다. 이 문서는 원본 자격증명이나 개인정보를 기록하지 않는다.

## 3. 기존 A/B 파일럿에서 관찰한 사실

당시 실행기는 같은 106초 WAV를 PhraseSet 없음과 영문 PhraseSet의 두 조건으로 재생했다. 두 실행 모두 전체 음원을 처리했고 오류 없이 완료됐다.

| 과거 조건 | 상태 | interim 수 | final 수 | 영문 targetTerms 정확 표기 |
|---|---|---:|---:|---:|
| PhraseSet 없음 | 완료 | 11 | 12 | 0개 |
| 영문 PhraseSet | 완료 | 12 | 12 | 1개 (`PhraseSet`) |

`0개`, `1개`는 당시 결과 문자열이 17개 영문 후보와 정확히 일치했는지만 센 값이다. 실제 발화 횟수를 분모로 계산한 전문용어 인식률이 아니다.

| 의도한 용어 | 관찰된 표기 | 당시 해석 |
|---|---|---|
| `RAG` | `레그` | 한국어 발음을 canonical 용어와 연결하지 못함 |
| `Transformer` | `트랜스포머` | 한글 음역을 영문 표기와 다른 문자열로 취급함 |
| `Fine-tuning` | `파인 튜닝` | 공백을 포함한 한글 음역을 canonical 용어와 연결하지 못함 |
| `PhraseSet` | 미적용 시 `프레이저스 셋` 등, 적용 시 `PhraseSet` | 영문 PhraseSet이 특정 표기를 바꿀 수 있음을 관찰 |
| `LLM` | `LLM` | 당시 기준 목록에는 `Large Language Model`만 있어 자동 집계 누락 |
| `PDF.js` | 미적용 시 `PDF. 자바스크립트`, 적용 시 `PDF.js` | 당시 targetTerms 밖이라 비교표에서 누락 |

따라서 과거의 `0/17 → 1/17`을 정확도 향상으로 발표하거나 논문에 쓰면 안 된다. 이 결과가 지지하는 것은 저장 음원을 Google STT에 반복 전송하는 경로가 동작했고, 한국어식 영어 발음을 제품 용어에 연결하는 별칭 계층이 필요했다는 관찰뿐이다.

## 4. 현재 고정 A/B/C 조건

`server/src/services/stt-comparison.ts`는 각 조건을 다음 순서로 정확히 한 번씩 만든다.

| 조건 | 구현 label | Google STT PhraseSet | 애플리케이션 별칭 정정 |
|---|---|---|---|
| A | `without-phrase-set` | 없음 | 없음 |
| B | `canonical-phrase-set` | canonical 표기 + English 표기 | 없음 |
| C | `spoken-alias-phrase-set` | canonical 표기 + English 표기 + 검토된 한국어 발음 | 검토된 별칭을 canonical 용어로 정정 |

A와 B의 용어 객체에는 `spokenAliases`가 비어 있다. C만 `scripts.json`에 검토 완료로 등록된 한국어 발음을 PhraseSet과 자막 정정 양쪽에 사용한다. Gemini가 제안했지만 검토되지 않은 발음이나 다른 용어와 충돌하는 별칭은 fixture 스키마가 거부한다.

localhost UI에서는 저장 녹음을 선택하고 **유료 Google STT 스트림 정확히 3회 호출** 동의란을 선택한 뒤 비교를 시작한다. 서버는 A, B, C를 각각 한 번 실행하고, 브라우저는 메모리 job 상태를 폴링해 조건별 진행률을 표시한다. `pnpm stt:compare`도 같은 runner로 최근 WAV 또는 지정한 recording ID를 실행한다. UI와 CLI 모두 실행 한 번에 같은 WAV를 A, B, C에 각각 실시간 속도로 재생하므로 세 번의 유료 Google STT 사용량을 만든다.

조건 실행은 자동 재시도하지 않고 중단된 job을 자동 재개하지 않는다. 취소 API와 취소 UI도 없다. 한 조건이 error를 반환하면 해당 조건을 재호출하지 않고 다음 조건으로 진행해 오류를 포함한 v3 리포트를 저장한다. `pnpm test`와 일반 브라우저 QA는 조건 생성, 점수 계산, lock, job, legacy 판별과 파일 경계를 mock/local 데이터로만 검증한다. 테스트나 QA에서 Start를 누르거나 `POST /api/dev/stt-comparison-jobs`를 직접 호출해서는 안 된다.

## 5. 기준 문장과 녹음 선언

최신 기준 문장은 발화자에게 영문 철자를 임의로 읽게 하지 않는다. 실제 평가할 한국어 발음을 본문에 명시하며, 특히 다음 표기를 그대로 사용한다.

- `LLM`: **엘엘엠**
- `RAG`: **래그**
- `API`: **에이피아이**
- `PhraseSet`: **프레이즈셋**

녹음자는 화면 문장을 처음부터 끝까지 추가·생략·치환 없이 읽은 경우에만 **“기준 문장을 그대로 읽었습니다”**를 선택한다. 이 선언은 녹음 메타데이터의 `speakerReadReferenceScriptVerbatim`으로 저장된다.

- 선언 있음: `evaluationMode=accuracy`, `accuracyValid=true`; occurrence-level 수치를 정확도 분석에 사용할 수 있다.
- 선언 없음: `evaluationMode=smoke`, `accuracyValid=false`; 숫자는 연결 동작 관찰용이며 publication accuracy가 아니다.
- 기존 manifest v1 녹음: 선언이 없는 legacy 녹음으로 이전하므로 항상 smoke 전용이다.

선언은 대본 일치의 명시적 실험 계약이지 음질이나 STT 결정성을 보증하지 않는다.

## 6. v3 출현 단위 지표

구조화된 `targetTerms`는 용어 ID, canonical 표기, English 표기, 검토된 `spokenAliases`, `expectedOccurrences`를 가진다. 반복 등장한 같은 용어도 출현 순서별로 따로 정렬해 다음 결과 중 하나를 부여한다.

- **직접 인식(`directRecognitions`)**: STT 원문에서 해당 canonical 또는 English 표기를 직접 연결한 기준 출현 수
- **별칭 정정 성공(`aliasCorrectionSuccesses`)**: C에서 검토된 한국어 발음을 해당 canonical 용어로 올바르게 정정한 기준 출현 수
- **누락(`misses`)**: 직접 인식과 올바른 별칭 정정 어느 쪽에도 정렬되지 않은 기준 출현 수
- **잘못된 정정(`falseCorrections`)**: 검토되지 않은 원문을 바꾸거나, 예상 출현에 정렬되지 않거나, 별칭 정정을 허용하지 않는 A/B에서 정정이 발생한 수
- **잘못된 삽입(`falseInsertions`)**: 기준 출현에 정렬되지 않은 추가 canonical/English 용어 인식 수
- **제품 용어 연결률(`productLinkRate`)**: `(직접 인식 + 별칭 정정 성공) / 전체 기준 출현 수`

각 기준 출현은 직접 인식·별칭 정정 성공·누락 중 정확히 하나다. 따라서 `직접 인식 + 별칭 정정 성공 + 누락 = 전체 기준 출현 수`가 성립한다. false correction과 false insertion은 이 분모 밖의 예상하지 않은 관찰을 별도로 센다.

제품 용어 연결률은 설명 카드까지 canonical 용어에 연결할 수 있었는지를 나타낸다. ASR 자체가 영문 철자를 얼마나 정확히 출력했는지와는 다른 제품 지표이며, 논문에서는 둘을 같은 이름으로 섞지 않는다.

## 7. v3 결과 파일, job과 localhost UI

실행기는 세 run, 조건별 PhraseSet과 용어 구성, 표시 자막, STT `rawText`, 정정 내역, 출현별 결과, 예상 밖 관찰과 위 지표를 버전 3 JSON으로 원자적으로 저장한다. 새 저장 위치는 `test-fixtures/stt/results/comparison-<recordingId>-<jobId>.json`이다. job ID가 매번 달라 같은 녹음을 반복해도 기존 결과를 덮어쓰지 않는 immutable 기록이 된다. 과거 `comparison-<recordingId>.json`은 삭제·rename하지 않고 함께 조회한다.

localhost 개발 화면은 다음 두 영역을 제공한다.

- 실행: 저장 녹음 선택 → 유료 스트림 3회 동의 → Start → `GET /api/dev/stt-comparison-jobs/:jobId` 폴링으로 A/B/C 진행률 확인
- 결과: 수정 시각 최신순 history를 5개씩 이전/다음 페이지로 이동 → 파일 선택 → 별도 detail API로 리포트 확인

결과 상세에서는 다음을 확인한다.

- A/B/C 조건 비교 차트
- 세 조건의 STT 원문과 정정·표시 문장
- 용어·출현별 A/B/C 결과 표
- 조건별 논문용 요약 표
- 정확도 모드이고 세 run이 모두 오류 없이 완료됐을 때만 활성화되는 TSV 복사

API 계약은 다음과 같다.

| 방식 | 경로 | 계약 |
|---|---|---|
| `POST` | `/api/dev/stt-comparison-jobs` | `recordingId`와 정확히 3회 유료 호출 동의를 검증하고 202 job 반환 |
| `GET` | `/api/dev/stt-comparison-jobs/current` | 이 서버의 current job 또는 공유 lock을 보유한 CLI/다른 서버 작업 반환 |
| `GET` | `/api/dev/stt-comparison-jobs/:jobId` | 이 서버 프로세스 메모리의 job 상태·진행률 반환 |
| `GET` | `/api/dev/stt-comparisons?offset=<n>&limit=<n>` | 유효 결과 수, 최신 리포트, 최신순 history와 `offset`·`limit`·`hasMore` 반환 |
| `GET` | `/api/dev/stt-comparisons/:fileName` | 검증된 결과 파일의 상세 리포트 반환 |

목록·상세 reader는 파일명, 최대 크기, symlink와 결과 스키마를 검증하고 잘못된 파일을 결과 수·history·latest 선정에서 제외한다. 목록 limit 기본값은 25, 최대값은 100이며 현재 UI는 5개씩 요청한다. 모든 route는 development 모드와 loopback socket·Host·Origin을 요구하며 production이나 원격 호스트에 공개하지 않는다. 새로고침, 페이지 이동과 상세 조회는 Google STT를 호출하지 않는다.

UI job은 데이터베이스가 아니라 서버 프로세스 메모리에만 있다. 서버를 재시작하면 진행·종료 상태 endpoint에서 사라지지만, 원자적 쓰기가 끝난 결과 파일은 그대로 남아 history/detail에서 다시 읽힌다. 쓰기 전에 중단된 job은 결과가 없으며 자동 재개되지 않는다.

UI와 CLI는 fixture root의 `.stt-comparison.lock`을 공유한다. 살아 있는 PID 또는 확인 권한이 없어 `EPERM`인 PID의 lock은 active로 취급해 중복 시작을 막는다. PID가 존재하지 않는 stale lock은 owner token과 파일 identity가 바뀌지 않았는지 다시 확인한 뒤에만 회수한다. malformed JSON, symlink, 0600이 아닌 권한, 비정상 크기 또는 PID를 안전하게 확인할 수 없는 lock은 자동 삭제하지 않고 unsafe 상태로 시작을 차단한다.

버전 1·2 결과는 읽을 수 있는 opaque `legacy` 자료로만 분류한다. 가장 최근 파일이 v1/v2이면 UI는 `레거시 스모크 결과` 안내만 표시하며 지표나 자막을 추정하지 않는다. 해당 형식에는 현재의 기준 문장 선언과 출현 단위 v3 계약이 없으므로 v3 차트·용어별 표·논문용 TSV에 섞지 않는다.

smoke v3는 연결 관찰을 위해 차트·원문·표를 표시하지만 TSV 복사는 비활성화하고 `TSV LOCKED`로 표시한다. 화면의 `TSV READY`는 선언된 accuracy 결과의 세 run이 오류 없이 끝났다는 단일 리포트 완전성만 뜻한다. Google STT 비결정성을 다룰 반복 실험까지 완료했다는 뜻은 아니다.

## 8. 현재 단일 accuracy 관찰과 해석 경계

최신 기준 문장을 그대로 읽었다고 선언한 한 녹음의 완전한 v3 리포트에서 제품 용어 연결률은 다음과 같이 관찰됐다.

| A · PhraseSet 없음 | B · canonical+English | C · 발음 별칭+정정 |
|---:|---:|---:|
| 17.6% | 17.6% | 94.1% |

이는 **한 WAV를 조건별로 한 번씩 실행한 단일 리포트의 관찰값**이다. C가 모든 화자·환경·실행에서 같은 수준으로 향상된다는 일반적 주장이 아니며, 효과 크기·분산·통계적 유의성을 말할 근거도 아니다. 세 run이 완전하다는 사실과 publication-grade 반복 측정이 완료됐다는 판단을 분리한다.

## 9. 논문 수치에 필요한 다음 측정

현재 106초 녹음을 다시 v3로 실행하는 것은 A/B/C 파이프라인과 UI를 확인하는 smoke 회귀로는 유용하다. 그러나 대본 불일치는 그대로이므로 논문 수치를 만들지는 못한다. 반복 측정에는 위 단일 accuracy 결과에 사용한 exact-script WAV를 그대로 사용해 입력을 고정한다.

또한 같은 음원으로 A/B/C를 한 번씩 실행해도 Google STT API의 비결정성은 사라지지 않는다. 최종 논문에서는 동일 WAV로 각 조건을 여러 번 반복하고 다음 정보를 함께 남긴다.

- 조건별 반복 횟수와 실행 시각
- `chirp_3`, `ko-KR`, `us` 모델·언어·리전
- 각 실행의 원시 v3 결과와 누락된/error run
- 직접 인식, 별칭 정정 성공, 누락, 오정정, 오삽입, 제품 용어 연결률의 개별 값과 요약 방식

반복 수와 통계 요약 방식은 결과를 본 뒤 유리하게 바꾸지 말고 논문 측정 전에 고정하는 것이 좋다.

## 10. 권장 실행 순서

1. 반복 수와 요약 방식을 결과를 보기 전에 고정한다.
2. `pnpm dev`와 Google ADC를 준비하고 localhost 화면을 연다.
3. 단일 accuracy 리포트에 사용한 저장 녹음을 선택한다.
4. **유료 Google STT 스트림 정확히 3회 호출** 동의란을 선택하고 Start를 한 번만 누른다.
5. A/B/C job 진행률을 폴링 화면에서 확인한다. 자동 retry와 cancel이 없으므로 중복 Start나 임의 중단을 하지 않는다.
6. 완료 뒤 새 immutable 결과가 history 첫 페이지에 추가됐는지 확인하고 해당 파일 상세에서 선언 상태, 세 run, 오류와 occurrence-level 합계 불변식을 검수한다.
7. 같은 WAV로 사전에 정한 횟수만큼 반복하고 모든 개별 파일을 보존한다. 필요하면 같은 runner의 `pnpm stt:compare -- <recording-id>`를 사용할 수 있다.
8. 오정정 결과를 근거로 별칭 목록과 회귀 테스트를 함께 수정할지 판단한다.
9. 이후 소음 환경, 다른 화자, 10분 이상 스트림과 Cloud Run 환경으로 범위를 확대한다.

현재 구현으로 `레그`, `트랜스포머`, `파인 튜닝` 같은 검토된 발음을 canonical 용어에 연결하고 원문을 함께 표시할 수 있다. 남은 논문 실험의 핵심은 동일 exact-script WAV의 사전 계획된 반복 실행이며, 단일 17.6% / 17.6% / 94.1% 결과나 기존 106초 파일럿 수치를 일반적 정확도 향상으로 재해석하는 것이 아니다.
