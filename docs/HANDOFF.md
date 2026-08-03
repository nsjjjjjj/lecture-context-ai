# Lecture Context AI 인수인계

## 현재 상태

한신대학교 ABC 해커톤에서 시연할 수 있는 MVP입니다. Google 자격증명이 없어도 내장 데모로 업로드 이후의 준비 화면, 실시간 자막, 용어 카드, 관련 페이지와 결과 리포트를 확인할 수 있습니다.

### 구현 완료

- React 기반 반응형 발표 화면
- PDF.js 페이지별 텍스트 추출
- Gemini 구조화 JSON 기반 자동 용어집 생성
- PDF 원문 대조, 중복 제거, 최대 50개 제한
- Google STT V2 Chirp 3 인라인 PhraseSet 구성
- 브라우저 마이크 PCM 변환과 WebSocket 전송
- 임시·확정 자막, 용어 강조, 쉬운 설명과 PDF 페이지 연결
- API 없는 데모 모드
- 타입 검사, 용어 검증 테스트, 프로덕션 빌드
- Docker 이미지 빌드와 컨테이너 헬스 체크

## 아직 실제 자격증명으로 검증하지 않은 부분

- Gemini 3.6 Flash 실제 PDF 호출
- 한국어 마이크를 이용한 Chirp 3 스트리밍
- PhraseSet 적용 전후 전문용어 인식률 비교
- Cloud Run 배포 환경의 WebSocket 장시간 연결
- Secret Manager와 Cloud Run 서비스 계정 연결

## 다음 개발 우선순위

1. 별도의 테스트용 Google Cloud 프로젝트와 결제 예산 한도를 설정합니다.
2. Gemini 키와 Google Application Default Credentials를 연결합니다.
3. 실제 텍스트 PDF와 1~2분 한국어 강연 대본으로 전체 흐름을 검증합니다.
4. glossary 결과에 `contextExplanation`을 추가해 용어가 현재 문맥에서 등장한 이유를 표시합니다.
5. Google STT 스트리밍 제한에 대비한 자동 재연결과 자막 연속성 처리를 구현합니다.
6. Cloud Run에 배포하고 모바일·노트북 마이크 권한과 WebSocket을 재검증합니다.
7. 기준 대본을 사용해 일반 STT와 PhraseSet 적용 STT의 전문용어 정확도를 비교합니다.

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
5. 자막 속 전문용어, 쉬운 설명, 관련 페이지가 함께 바뀌는지 확인합니다.
6. 종료 후 결과 리포트가 표시되는지 확인합니다.

## 알려진 제한과 결정 사항

- OCR을 넣지 않았으므로 스캔 이미지 PDF는 처리하지 못합니다.
- PDF는 브라우저에서 추출하며 Python 런타임을 사용하지 않습니다.
- 강연자 검수 단계 없이 PDF 원문 대조 결과를 자동 채택합니다.
- PDF와 음성 원본을 서버에 저장하지 않으며 데이터베이스가 없습니다.
- 공개 사용자 인증은 없으므로 외부 공개 시 Cloud Run·API 할당량으로 비용을 제한해야 합니다.
- 현재의 `easyExplanation`은 쉬운 정의에 가깝습니다. 제품명을 유지하려면 실제 발화 문맥을 설명하는 `contextExplanation` 확장을 권장합니다.

## 주요 코드 위치

- 전체 UI: `client/src/App.tsx`
- PDF 추출: `client/src/lib/pdf.ts`
- 마이크 처리: `client/src/lib/pcm-recorder.ts`
- 실시간 상태: `client/src/hooks/useLectureStream.ts`
- API·WebSocket 서버: `server/src/index.ts`
- Gemini·자동 용어집: `server/src/services/glossary.ts`
- Google STT: `server/src/services/speech.ts`
- 데모 데이터: `server/src/services/demo.ts`
