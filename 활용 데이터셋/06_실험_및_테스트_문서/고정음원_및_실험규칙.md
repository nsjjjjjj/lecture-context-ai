# 로컬 STT 고정음원

개발 화면에서 사용자가 명시적으로 녹음한 테스트 음원만 이 디렉터리에 저장합니다. 실시간 강연 음성은 이 기능과 무관하며 저장하지 않습니다.

- `scripts.json`: Git에 포함되는 고정 실험 문장
- `audio/*.wav`: 16kHz, mono, 16-bit PCM WAV 로컬 파일. Git·Docker 제외
- `manifest.local.json`: 가명 화자, 환경, 길이, 생성시각, 파일 상대 경로와 기준 문장 그대로 읽기 선언. Git·Docker 제외
- `studies.local.json`: 실험 세트와 append-only PDF 용어집·대본 케이스 스냅샷. Git·Docker 제외
- `.writer.lock`: 복수 개발 서버의 짧은 저장 충돌을 막는 임시 lock. Git·Docker 제외
- `.stt-comparison.lock`: UI·CLI의 동시 A/B/C 실행을 막는 cross-process lock. Git·Docker 제외
- `results/comparison-<recordingId>-<jobId>.json`: 실행마다 추가되는 immutable Google STT A/B/C v3/v4 결과. Git·Docker 제외

음원과 manifest는 자동 만료되지 않습니다. 필요 없어진 파일은 개발자가 직접 삭제해야 합니다. 실제 이름이나 개인정보를 화자 label에 기록하지 말고 `speaker-a`, `speaker-b` 같은 가명만 사용합니다.

## PDF·대본 실험 세트

`#/experiment/setup`에서 브라우저에 이미 저장된 용어집과 정확히 읽을 대본을 선택해 케이스를 만듭니다. 이 동작은 `/api/analyze`나 Gemini를 호출하지 않습니다. 서버는 glossary·script·case SHA-256과 고유 study/case/snapshot ID를 기록하고 같은 세트의 동일 스냅샷 중복 생성을 거부합니다. 케이스 수정 API는 없으며 변경 실험은 새 케이스로 추가합니다.

채점 정답인 `targetTerms`와 PDF에서 얻은 `adaptationTerms`는 분리됩니다. A는 PhraseSet 없음, B는 PDF canonical/English, C는 PDF canonical/English와 안전 규칙을 통과해 자동 승인된 한국어 발음 별칭을 사용합니다. PDF에 없는 용어도 채점 정답으로 수동 등록할 수 있지만 B/C PhraseSet에는 들어가지 않습니다. 정확한 대본에서 발견되지 않는 채점 용어는 케이스 저장 전에 거부합니다.

PDF 적응의 50개 제한은 원본 `adaptationTerms` 개수에만 적용합니다. 각 원본에 딸린 English와 `spokenAliases`는 별도 용어로 세지 않으며 B/C PhraseSet에 그대로 포함됩니다.

녹음 manifest와 v4 결과에는 study/case/snapshot/glossary/script identity가 이어집니다. 결과 화면은 세트·케이스 필터, 완전한 accuracy 실행만 사용한 케이스별 A/B/C 평균, CSV·TSV·JSON 내보내기를 제공합니다. 기존 고정 대본, manifest v1/v2, 결과 v1~v3 읽기는 유지됩니다.

최신 기준 문장은 `엘엘엠`, `래그`, `에이피아이`, `프레이즈셋`처럼 실제로 읽을 한국어 발음을 명시합니다. 화면 문장을 처음부터 끝까지 그대로 읽은 경우에만 **“기준 문장을 그대로 읽었습니다”**를 선택합니다. 화자·환경·실험문장·선언은 녹음 시작 시 고정되며 PCM은 3,840,000바이트에서 hard cap됩니다. 저장은 cross-process lock 안에서 실행되고 60초 이상 남은 비정상 lock은 다음 저장에서 회수합니다.

이 도구는 동일 사용자가 제어하는 로컬 개발 환경용입니다. fixture root와 audio 파일 자체의 symlink·경로 이탈은 거부하지만 악의적인 동일 사용자 프로세스나 모든 ancestor 경로의 TOCTOU를 격리하는 sandbox는 아닙니다.

저장 모듈은 WAV를 다시 검증하고 PCM payload를 15,000바이트 이하의 짝수 길이 청크로 읽을 수 있습니다. localhost UI에서 저장 녹음을 선택하고 **유료 Google STT 스트림 정확히 3회 호출**에 명시적으로 동의한 뒤 Start를 누르면 A/B/C job을 시작하고 진행 상태를 폴링합니다. 동일 runner는 `pnpm stt:compare`로도 최근 WAV 또는 지정한 recording ID를 실행할 수 있습니다.

| 조건 | PhraseSet | 별칭 정정 |
|---|---|---|
| A | 없음 | 없음 |
| B | canonical + English | 없음 |
| C | canonical + English + 안전한 한국어 발음 | 저장된 안전 발음을 canonical로 정정 |

UI나 CLI 실행 한 번은 Google STT를 세 번 호출하므로 세 조건 모두 유료 사용량이 발생합니다. 자동 retry·자동 재개·cancel route/UI는 없습니다. 테스트와 브라우저 QA에서는 Start를 누르거나 job POST API를 호출하지 않으며, `pnpm test`도 Google STT를 호출하지 않습니다.

UI와 CLI는 fixture root의 `.stt-comparison.lock` 하나를 공유합니다. 살아 있는 프로세스의 lock은 녹음 ID와 무관하게 중복 실행을 막습니다. 종료된 PID가 남긴 stale lock만 owner token과 파일 identity를 재검증한 뒤 회수합니다. malformed·symlink·권한/크기 오류 또는 PID 안전 확인 실패 상태는 자동 삭제하지 않고 실행을 차단합니다.

v3/v4 결과는 기준 출현마다 직접 인식, 별칭 정정 성공, 누락을 기록하고, 예상 밖 정정과 canonical 용어 출현을 false correction·false insertion으로 별도 기록합니다. 제품 용어 연결률은 `(직접 인식 + 별칭 정정 성공) / 기준 출현 수`입니다.

명시적 선언이 있는 녹음만 `accuracy`로 평가합니다. 선언하지 않은 녹음과 manifest v1에서 읽은 녹음은 `smoke`이며 publication accuracy로 사용할 수 없습니다. 현재 로컬의 106초 legacy 녹음은 예전 대본과 최신 기준 문장이 달라 smoke 전용입니다. 별도의 exact-script 녹음으로 완전한 accuracy 리포트 하나가 존재하더라도 publication-grade 수치에는 같은 WAV의 사전 계획된 반복 A/B/C 실행이 필요합니다.

새 결과는 `comparison-<recordingId>-<jobId>.json`으로 저장해 같은 녹음의 이전 실행을 덮어쓰지 않습니다. 기존 `comparison-<recordingId>.json` 파일도 그대로 남습니다. localhost UI는 유효 결과를 수정 시각 최신순으로 5개씩 페이지화하고 파일 선택 시 detail API로 리포트를 읽습니다. v3/v4는 차트, 조건별 STT 원문/정정·표시 문장, 용어·출현별 표와 논문용 요약 표를 보여줍니다. TSV 복사는 accuracy 모드이고 세 run이 모두 오류 없이 완료된 경우에만 활성화됩니다. smoke는 화면 지표를 표시하되 TSV 복사를 막고, v1/v2는 `레거시 스모크 결과` 안내만 표시해 지표를 추정하지 않습니다. 새로고침·페이지 이동·상세 조회는 Google STT를 호출하지 않습니다.

UI job 상태는 서버 프로세스 메모리에만 있어 재시작하면 사라집니다. 원자적 저장이 끝난 결과 파일은 남아 서버 재시작 뒤에도 history/detail에서 조회할 수 있습니다. 쓰기 전에 중단된 job은 결과가 없고 자동 재개되지 않습니다.
