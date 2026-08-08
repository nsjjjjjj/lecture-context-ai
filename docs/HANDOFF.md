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
- 분석 완료 시 전체 `GlossaryTerm[]`과 `phraseSet`의 브라우저 `localStorage` v1 자동 저장
- 앱 새로고침·서버 재시작 뒤 저장 용어집 목록/로드, 이름 변경, 삭제
- 저장 용어집 로드 시 Gemini 분석 없이 기존 WebSocket live/demo 시작 메시지 재사용
- 저장 형식 엄격 검증, 정규화 중복 제거, 용어 ID 보존, 저장 공간·차단·손상·버전 오류 표시
- PDF 없는 저장 용어집 세션의 명시적 미리보기 불가 상태
- 전체 분석 PhraseSet의 WebSocket 전달과 Google STT 적용
- 데모·실시간 종료 이벤트의 자동 결과 화면 전환
- 타입 검사, 프로토콜·용어 검증 테스트, 프로덕션 빌드
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
6. 마지막 데모 자막 뒤 자동으로 결과 리포트가 표시되고 확정 자막 4개가 유지되는지 확인합니다.
7. `처음으로` 이동해 `이 브라우저의 용어집`에 샘플 용어집이 표시되는지 확인합니다.
8. 페이지를 새로고침하거나 개발 서버를 다시 시작한 뒤 같은 용어집이 유지되는지 확인합니다.
9. 저장 용어집을 불러와 분석 화면이나 `/api/analyze` 요청 없이 준비 화면으로 이동하는지 확인합니다.
10. `실시간 강연 시작` 시 저장된 전체 용어와 PhraseSet이 WebSocket `start` 메시지에 포함되고, 자막 강조와 쉬운 설명이 동작하는지 확인합니다.
11. 저장 용어집 세션의 관련 자료 영역에 `PDF 미리보기 없음`이 표시되는지 확인합니다.
12. 첫 화면에서 용어집 이름 변경과 삭제를 확인합니다.

## 알려진 제한과 결정 사항

- OCR을 넣지 않았으므로 스캔 이미지 PDF는 처리하지 못합니다.
- PDF는 브라우저에서 추출하며 Python 런타임을 사용하지 않습니다.
- 강연자 검수 단계 없이 PDF 원문 대조 결과를 자동 채택합니다.
- PDF와 음성 원본을 서버에 저장하지 않으며 데이터베이스가 없습니다.
- 용어집은 `lecture-context-ai.glossaries` 키의 버전 1 브라우저 저장소에만 저장합니다. 서버 저장소는 추가하지 않았습니다.
- 저장 필드는 용어집 메타데이터(`id`, `name`, `createdAt`, `updatedAt`), 완전한 `GlossaryTerm[]`, `phraseSet`으로 제한합니다. PDF, 추출 페이지 텍스트, `pdfUrl`, 음성, 경고, API 키는 제외합니다.
- 저장 데이터는 정확한 필드 집합과 타입·길이·개수·타임스탬프·PhraseSet/용어 대응 관계를 검증합니다. 정규화 중복은 제거하되 채택한 용어의 기존 ID는 유지합니다.
- 전문용어가 비어 있는 분석·저장 항목은 거부해 데모 서버 fallback과 클라이언트 설명 상태가 어긋나지 않게 합니다.
- 동일한 이름과 내용의 자동 저장은 기존 항목을 갱신해 중복 목록을 만들지 않습니다.
- 동일 콘텐츠 비교는 용어와 PhraseSet 배열 순서에 영향받지 않습니다.
- 저장 용어집 로드는 `pages: []`, `mode: "saved"`인 클라이언트 분석 상태를 직접 만들며 `/api/analyze`를 호출하지 않습니다. `useLectureStream`은 이 상태의 용어와 PhraseSet을 기존 WebSocket 시작 메시지에 그대로 사용합니다.
- 저장 용어집에는 페이지 본문과 PDF가 없으므로 관련 자료 미리보기는 사용할 수 없습니다. 쉬운 설명, 용어 강조, 원본 페이지 번호 표시는 유지됩니다.
- 브라우저 저장소는 브라우저·기기·사이트 단위이며 동기화되지 않습니다. 브라우저 데이터 삭제 시 용어집도 삭제됩니다.
- 같은 사이트의 다른 탭에서 발생한 저장 변경은 `storage` 이벤트로 목록을 갱신합니다. 동시 read-modify-write는 잠그지 않으므로 실제 동시 변경은 마지막 쓰기가 우선합니다.
- 손상되거나 지원하지 않는 버전은 자동 삭제하지 않고 오류와 명시적 초기화 동작을 표시합니다. 저장 실패 시 현재 분석은 유지되어 초기화·정리 후 다시 저장할 수 있습니다.
- 실시간 모드의 용어집이 비어 있어도 데모 용어를 대신 넣지 않습니다. 데모 용어 fallback은 사용자가 데모 모드를 명시적으로 선택했을 때만 적용합니다.
- 실제 발화 시작 시점을 신뢰성 있게 측정하지 않으므로 결과 리포트에서 표시 지연을 추정하지 않고, 검증된 PhraseSet 힌트 수를 표시합니다.
- 공개 사용자 인증은 없으므로 외부 공개 시 Cloud Run·API 할당량으로 비용을 제한해야 합니다.
- 현재의 `easyExplanation`은 쉬운 정의에 가깝습니다. 제품명을 유지하려면 실제 발화 문맥을 설명하는 `contextExplanation` 확장을 권장합니다.

## 주요 코드 위치

- 전체 UI: `client/src/App.tsx`
- PDF 추출: `client/src/lib/pdf.ts`
- 마이크 처리: `client/src/lib/pcm-recorder.ts`
- 실시간 상태: `client/src/hooks/useLectureStream.ts`
- 브라우저 용어집: `client/src/lib/glossary-storage.ts`
- API·WebSocket 서버: `server/src/index.ts`
- Gemini·자동 용어집: `server/src/services/glossary.ts`
- Google STT: `server/src/services/speech.ts`
- 데모 데이터: `server/src/services/demo.ts`
