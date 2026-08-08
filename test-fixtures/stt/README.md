# 로컬 STT 고정음원

개발 화면에서 사용자가 명시적으로 녹음한 테스트 음원만 이 디렉터리에 저장합니다. 실시간 강연 음성은 이 기능과 무관하며 저장하지 않습니다.

- `scripts.json`: Git에 포함되는 고정 실험 문장
- `audio/*.wav`: 16kHz, mono, 16-bit PCM WAV 로컬 파일. Git·Docker 제외
- `manifest.local.json`: 가명 화자, 환경, 길이, 생성시각과 파일 상대 경로. Git·Docker 제외
- `.writer.lock`: 복수 개발 서버의 짧은 저장 충돌을 막는 임시 lock. Git·Docker 제외

음원과 manifest는 자동 만료되지 않습니다. 필요 없어진 파일은 개발자가 직접 삭제해야 합니다. 실제 이름이나 개인정보를 화자 label에 기록하지 말고 `speaker-a`, `speaker-b` 같은 가명만 사용합니다.

화자·환경·실험문장은 녹음 시작 시 고정되며 PCM은 3,840,000바이트에서 hard cap됩니다. 저장은 cross-process lock 안에서 실행되고 60초 이상 남은 비정상 lock은 다음 저장에서 회수합니다.

이 도구는 동일 사용자가 제어하는 로컬 개발 환경용입니다. fixture root와 audio 파일 자체의 symlink·경로 이탈은 거부하지만 악의적인 동일 사용자 프로세스나 모든 ancestor 경로의 TOCTOU를 격리하는 sandbox는 아닙니다.

저장 모듈은 WAV를 다시 검증하고 PCM payload를 15,000바이트 이하의 짝수 길이 청크로 읽을 수 있습니다. 실제 Google STT 호출과 PhraseSet 정확도 비교는 별도 후속 단계입니다.
