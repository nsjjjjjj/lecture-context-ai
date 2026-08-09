# STT PhraseSet 파일럿과 A/B/C v3 실험 기록

작성일: 2026-08-09

## 1. 이 문서의 목적

실제 Google Speech-to-Text V2로 수행한 기존 고정음원 파일럿과 현재 구현된 A/B/C 비교 규칙을 구분해 기록한다. 기존 106초 결과는 연결과 표기 변화를 확인한 **legacy 스모크 테스트**다. 논문 전문용어 정확도에는 화면의 최신 기준 문장을 그대로 읽었다고 선언한 새 녹음의 v3 출현 단위 결과만 사용할 수 있다.

## 2. 보존 중인 106초 legacy 음원

- 녹음 ID: `6d9c7e31-9df8-454d-b6fa-8a7423773163`
- 음원: `test-fixtures/stt/audio/20260809001249-6d9c7e31-9df8-454d-b6fa-8a7423773163.wav`
- 길이: 106.435초
- 형식: 16 kHz, mono, 16-bit PCM WAV
- 환경: `speaker-a`, quiet
- 과거 비교 결과: `test-fixtures/stt/results/comparison-6d9c7e31-9df8-454d-b6fa-8a7423773163.json`
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

`pnpm stt:compare` 한 번은 같은 WAV를 A, B, C에 각각 실시간 속도로 재생하므로 **세 번의 유료 Google STT 실행**을 만든다. 반면 `pnpm test`는 조건 생성, 점수 계산, legacy 판별과 결과 파일 쓰기를 로컬 fixture 데이터로 검증하며 Google STT 유료 API를 호출하지 않는다.

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

## 7. v3 결과 파일과 localhost UI

실행기는 세 run, 조건별 PhraseSet과 용어 구성, 표시 자막, STT `rawText`, 정정 내역, 출현별 결과, 예상 밖 관찰과 위 지표를 버전 3 JSON으로 원자적으로 저장한다. 저장 위치는 `test-fixtures/stt/results/comparison-<recording-id>.json`이다.

저장 결과가 생기면 localhost 개발 결과 화면에서 `새로고침`을 눌러 가장 최근의 유효한 파일을 읽고 다음을 확인한다.

- A/B/C 조건 비교 차트
- 세 조건의 STT 원문과 정정·표시 문장
- 용어·출현별 A/B/C 결과 표
- 조건별 논문용 요약 표
- 정확도 모드이고 세 run이 모두 오류 없이 완료됐을 때만 활성화되는 TSV 복사

결과 조회 API는 `GET /api/dev/stt-comparisons`이며, 유효한 결과 파일 수와 수정 시각 기준 최신 결과 하나를 반환한다. 파일명, 파일 크기, symlink와 결과 스키마를 검증하고 잘못된 파일은 목록 수와 최신 결과 선정에서 제외한다. 녹음 API와 동일하게 development 모드와 loopback socket·Host·Origin을 요구하며 production이나 원격 호스트에 공개하지 않는다. 이 조회 화면 자체는 Google STT를 호출하지 않는다.

버전 1·2 결과는 읽을 수 있는 opaque `legacy` 자료로만 분류한다. 가장 최근 파일이 v1/v2이면 UI는 `레거시 스모크 결과` 안내만 표시하며 지표나 자막을 추정하지 않는다. 해당 형식에는 현재의 기준 문장 선언과 출현 단위 v3 계약이 없으므로 v3 차트·용어별 표·논문용 TSV에 섞지 않는다.

smoke v3는 연결 관찰을 위해 차트·원문·표를 표시하지만 TSV 복사는 비활성화한다. 화면의 `PUBLICATION READY`는 선언된 accuracy 결과의 세 run이 오류 없이 끝났다는 단일 리포트 완전성만 뜻한다. Google STT 비결정성을 다룰 반복 실험까지 완료했다는 뜻은 아니다.

## 8. 논문 수치에 필요한 다음 측정

현재 106초 녹음을 다시 v3로 실행하는 것은 A/B/C 파이프라인과 UI를 확인하는 smoke 회귀로는 유용하다. 그러나 대본 불일치는 그대로이므로 논문 수치를 만들지는 못한다. 가장 먼저 필요한 것은 최신 화면 문장을 그대로 읽고 선언한 **새 exact-script 녹음**이다.

또한 같은 음원으로 A/B/C를 한 번씩 실행해도 Google STT API의 비결정성은 사라지지 않는다. 최종 논문에서는 동일 WAV로 각 조건을 여러 번 반복하고 다음 정보를 함께 남긴다.

- 조건별 반복 횟수와 실행 시각
- `chirp_3`, `ko-KR`, `us` 모델·언어·리전
- 각 실행의 원시 v3 결과와 누락된/error run
- 직접 인식, 별칭 정정 성공, 누락, 오정정, 오삽입, 제품 용어 연결률의 개별 값과 요약 방식

반복 수와 통계 요약 방식은 결과를 본 뒤 유리하게 바꾸지 말고 논문 측정 전에 고정하는 것이 좋다.

## 9. 권장 실행 순서

1. `pnpm dev`로 localhost 녹음 화면을 연다.
2. 최신 기준 문장을 그대로 읽고 **“기준 문장을 그대로 읽었습니다”**를 선택해 새 음원을 저장한다.
3. Google ADC와 개발 서버를 준비하고 `pnpm stt:compare -- <recording-id>`를 실행한다. 이 단계는 A/B/C 세 번의 유료 STT 사용량을 발생시킨다.
4. 저장된 v3 결과의 선언 상태, 세 run, 오류와 occurrence-level 합계 불변식을 확인한다.
5. localhost 결과 UI에서 `새로고침`을 누르고 차트, 조건별 원문/표시 자막과 용어별 표를 검수한다. accuracy이고 세 run이 정상 완료된 경우에만 TSV 복사가 활성화되는지 확인한다.
6. 같은 WAV로 사전에 정한 횟수만큼 반복하고 개별 결과를 보존한다.
7. 오정정 결과를 근거로 별칭 목록과 회귀 테스트를 함께 수정할지 판단한다.
8. 이후 소음 환경, 다른 화자, 10분 이상 스트림과 Cloud Run 환경으로 범위를 확대한다.

현재 구현으로 `레그`, `트랜스포머`, `파인 튜닝` 같은 검토된 발음을 canonical 용어에 연결하고 원문을 함께 표시할 수 있다. 남은 논문 실험의 핵심은 새 exact-script 녹음과 반복 실행이며, 기존 106초 파일럿 수치를 정확도로 재해석하는 것이 아니다.
