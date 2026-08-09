# 로컬 STT 고정음원

개발 화면에서 사용자가 명시적으로 녹음한 테스트 음원만 이 디렉터리에 저장합니다. 실시간 강연 음성은 이 기능과 무관하며 저장하지 않습니다.

- `scripts.json`: Git에 포함되는 고정 실험 문장
- `audio/*.wav`: 16kHz, mono, 16-bit PCM WAV 로컬 파일. Git·Docker 제외
- `manifest.local.json`: 가명 화자, 환경, 길이, 생성시각, 파일 상대 경로와 기준 문장 그대로 읽기 선언. Git·Docker 제외
- `.writer.lock`: 복수 개발 서버의 짧은 저장 충돌을 막는 임시 lock. Git·Docker 제외
- `results/*.json`: Google STT A/B/C v3 결과. Git·Docker 제외

음원과 manifest는 자동 만료되지 않습니다. 필요 없어진 파일은 개발자가 직접 삭제해야 합니다. 실제 이름이나 개인정보를 화자 label에 기록하지 말고 `speaker-a`, `speaker-b` 같은 가명만 사용합니다.

최신 기준 문장은 `엘엘엠`, `래그`, `에이피아이`, `프레이즈셋`처럼 실제로 읽을 한국어 발음을 명시합니다. 화면 문장을 처음부터 끝까지 그대로 읽은 경우에만 **“기준 문장을 그대로 읽었습니다”**를 선택합니다. 화자·환경·실험문장·선언은 녹음 시작 시 고정되며 PCM은 3,840,000바이트에서 hard cap됩니다. 저장은 cross-process lock 안에서 실행되고 60초 이상 남은 비정상 lock은 다음 저장에서 회수합니다.

이 도구는 동일 사용자가 제어하는 로컬 개발 환경용입니다. fixture root와 audio 파일 자체의 symlink·경로 이탈은 거부하지만 악의적인 동일 사용자 프로세스나 모든 ancestor 경로의 TOCTOU를 격리하는 sandbox는 아닙니다.

저장 모듈은 WAV를 다시 검증하고 PCM payload를 15,000바이트 이하의 짝수 길이 청크로 읽을 수 있습니다. 개발 서버를 실행한 뒤 `pnpm stt:compare`를 사용하면 최근 WAV를 다음 조건으로 실제 Google STT에 재생하고 결과를 `results/`에 저장합니다.

| 조건 | PhraseSet | 별칭 정정 |
|---|---|---|
| A | 없음 | 없음 |
| B | canonical + English | 없음 |
| C | canonical + English + 검토된 한국어 발음 | 검토된 별칭만 canonical로 정정 |

명령 한 번은 Google STT를 세 번 호출하므로 세 조건 모두 유료 사용량이 발생합니다. `pnpm test`는 Google STT를 호출하지 않습니다.

v3 결과는 기준 출현마다 직접 인식, 별칭 정정 성공, 누락을 기록하고, 예상 밖 정정과 canonical 용어 출현을 false correction·false insertion으로 별도 기록합니다. 제품 용어 연결률은 `(직접 인식 + 별칭 정정 성공) / 기준 출현 수`입니다.

명시적 선언이 있는 녹음만 `accuracy`로 평가합니다. 선언하지 않은 녹음과 manifest v1에서 읽은 녹음은 `smoke`이며 publication accuracy로 사용할 수 없습니다. 현재 로컬의 106초 legacy 녹음은 예전 대본과 최신 기준 문장이 달라 smoke 전용입니다. 논문 수치에는 최신 기준 문장을 그대로 읽은 새 녹음과 같은 WAV의 반복 A/B/C 실행이 필요합니다.

저장된 결과는 localhost 개발 UI에서 `새로고침`한 뒤 확인합니다. development-only `GET /api/dev/stt-comparisons`는 유효 결과 수와 수정 시각 기준 최신 결과 하나를 반환합니다. 최신 v3는 차트, 조건별 STT 원문/정정·표시 문장, 용어·출현별 표와 논문용 요약 표를 보여줍니다. TSV 복사는 accuracy 모드이고 세 run이 모두 오류 없이 완료된 경우에만 활성화됩니다. smoke v3는 화면 지표를 표시하되 TSV 복사를 막고, v1/v2는 `레거시 스모크 결과` 안내만 표시해 지표·자막·v3 표를 추정하지 않습니다. 결과 조회 자체는 Google STT를 호출하지 않습니다.
