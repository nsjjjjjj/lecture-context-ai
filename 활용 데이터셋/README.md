# 활용 데이터셋

이 디렉터리는 프로젝트에서 수행한 STT A/B/C 비교 실험의 제출용 **복사본 스냅샷**입니다. 원본 데이터나 애플리케이션 코드의 실행 위치를 바꾸지 않았으며, 아래 파일은 2026-08-09 기준 원본을 그대로 복사해 항목별로 정리했습니다.

## 구성

| 제출용 경로 | 내용 | 원본 경로 |
| --- | --- | --- |
| `01_기준_대본_및_용어/scripts.json` | 기준 문장 1개와 전문용어·발음 별칭·출현 순서 | `test-fixtures/stt/scripts.json` |
| `02_실험_케이스_및_음원_메타데이터/` | 실험 케이스·용어집 스냅샷, WAV 형식·길이·가명 화자 메타데이터 | `test-fixtures/stt/studies.local.json`, `test-fixtures/stt/manifest.local.json` |
| `03_테스트_음원/` | 16 kHz, mono, 16-bit PCM WAV 테스트 음원 15개 | `test-fixtures/stt/audio/` |
| `04_AB_C_실행_결과/` | 조건 A/B/C 실행 결과 JSON 17개 | `test-fixtures/stt/results/` |
| `05_실험_입력_문서/` | 용어집·실험 케이스를 구성할 때 사용한 강연 맥락 AI 샘플 논문 | `docs/lecture-context-ai-paper-draft.docx` |
| `06_실험_및_테스트_문서/` | 고정음원 사용 규칙, A/B/C 조건·측정 지표·파일럿 결과 해석 경계 | `test-fixtures/stt/README.md`, `docs/STT_PHRASESET_PILOT.md` |
| `07_자동화_테스트_코드/` | STT 실험 흐름, 음원 검증, 결과·lock·job API, UI를 검증하는 테스트 코드 사본과 Vitest 설정 | `client/src/**/*.test.*`, `server/src/**/*.test.ts`, `package.json`, `vitest.config.ts` |

## 실험 조건 요약

- A: PhraseSet 미적용
- B: canonical 용어와 English 표기만 PhraseSet에 적용
- C: canonical·English 표기와 안전한 한국어 발음 별칭을 PhraseSet에 적용하고, 별칭을 canonical 용어로 정정

평가 시에는 기준 문장을 처음부터 끝까지 읽었다고 선언한 음원만 accuracy 분석에 사용합니다. 선언이 없는 legacy 녹음과 결과는 연결 경로 확인용 smoke 자료이므로, 논문 정확도 수치와 혼합하면 안 됩니다. 세 조건의 결과 파일·측정 지표·해석 제한은 `06_실험_및_테스트_문서/AB_C_파일럿_및_평가_기록.md`에 기록돼 있습니다.

## 제출·보안 주의

- 음원 메타데이터는 `speaker-a` 같은 가명만 사용하며 실명·API 키·환경변수는 포함하지 않았습니다.
- 음성은 개인을 식별할 수 있는 데이터가 될 수 있으므로, 외부 공개 또는 대회 제출 전 녹음자의 사용 동의를 확인해야 합니다.
- `.env`, Google 인증 정보, 임시 lock 파일, 실행 중간 파일은 이 디렉터리에 복사하지 않았습니다.
- 자동화 테스트 사본은 검증 근거용입니다. 전체 테스트 실행은 프로젝트 루트에서 `pnpm test`로 수행합니다. 이 명령은 Google STT 유료 호출을 하지 않습니다.

## 파일 수

- 기준 대본·용어: 1개
- 케이스·음원 메타데이터: 2개
- 테스트 음원: 15개
- A/B/C 실행 결과: 17개
- 실험 입력 문서: 1개
- 운영·평가 문서: 2개
- 자동화 테스트·설정 사본: 20개
