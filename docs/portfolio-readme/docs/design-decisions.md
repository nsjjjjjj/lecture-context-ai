# 강연 용어 AI: 설계 결정과 근거

이 문서는 **팀 최종 병합본 기준 `68e2fa0`**의 동작을 정리합니다. Codex 프로젝트 기록으로 의도를 확인하고, 문서·코드·커밋으로 반영 여부를 따로 대조했습니다. 대화 원문은 포함하지 않습니다.

## 1. 발표 PDF를 용어집의 근거로 사용

**문제:** 일반 자막만으로는 낯선 용어의 의미를 알기 어렵고, 생성 모델이 낸 용어를 그대로 쓰면 해당 강연에 없는 표기가 음성인식 힌트로 들어갈 수 있습니다.

**선택:** PDF.js로 브라우저에서 페이지 텍스트를 추출합니다. Gemini가 용어·쉬운 설명 후보를 제안하면 서버가 PDF 원문에서 용어 위치를 확인하고, 표기 정규화·중복 제거 뒤 채택합니다. 그 용어집을 음성인식 힌트와 청중용 설명에 모두 사용합니다. 이 검증은 **용어의 원문 등장 여부**를 확인하는 것이며, 생성한 설명의 의미까지 검증한다는 뜻은 아닙니다.

근거: [논문·발표 기획](https://github.com/nsjjjjjj/lecture-context-ai/blob/68e2fa0ef2926b783b5e1f941ca9bdc90ab2630e/docs/PAPER_PRESENTATION_PLAN.md#41-강연-자료를-먼저-읽는-이유) · [용어 검증 코드](https://github.com/nsjjjjjj/lecture-context-ai/blob/68e2fa0ef2926b783b5e1f941ca9bdc90ab2630e/server/src/services/glossary.ts).

## 2. 빠른 자막 표시와 확정 자막 정정을 분리

**문제:** 확정 자막만 기다리면 체감이 느려지고, 임시 자막에서 용어를 확정하면 화면에 잘못된 정정과 설명이 남을 수 있습니다.

**선택:** 제공자가 전송한 임시 결과는 바로 화면에 표시하고, 확정 결과가 오면 임시 표시를 정리합니다. **발음 교정과 우측 용어 피드 갱신은 확정 결과에만** 적용합니다. 예를 들어 `레그`라는 인식 결과는 정정된 `RAG` 옆에 `(레그)`로 남겨 원래 인식 표기를 확인할 수 있습니다. 실제 제공자의 결과 도착 주기나 자막 지연은 보장하지 않습니다.

근거: [스트리밍 처리 변경](https://github.com/nsjjjjjj/lecture-context-ai/commit/c6a8ea5c40827961f98c30906de56a2a47bb8af2) · [발음 별칭 정정](https://github.com/nsjjjjjj/lecture-context-ai/commit/3801954a2a47a5126fac9109f7886fc55553a2d1) · [클라이언트 자막 상태](https://github.com/nsjjjjjj/lecture-context-ai/blob/68e2fa0ef2926b783b5e1f941ca9bdc90ab2630e/client/src/hooks/lecture-stream-state.ts).

## 3. 재사용할 용어집만 브라우저에 저장

같은 브라우저에서 다음 강연을 준비할 때 모델을 다시 호출하지 않도록 검증된 용어집과 PhraseSet을 로컬에 저장합니다. PDF·추출 페이지 텍스트·실시간 음성은 이 저장 대상에 포함되지 않습니다. 장치 간 동기화나 서버 계정 저장이 없는 대신, 브라우저 데이터를 지우면 용어집도 사라집니다.

근거: [용어집 재사용 커밋](https://github.com/nsjjjjjj/lecture-context-ai/commit/fad0b9c) · [저장 코드](https://github.com/nsjjjjjj/lecture-context-ai/blob/68e2fa0ef2926b783b5e1f941ca9bdc90ab2630e/client/src/lib/glossary-storage.ts).

## 4. 같은 음원으로 비교하고, 측정의 한계를 표시

조건마다 음원이 바뀌면 PhraseSet이나 발음 정정이 영향을 줬는지 구분하기 어렵습니다. 로컬 실험실은 동일 WAV를 세 조건에 같은 방식으로 재생합니다. PDF에서 만드는 **적응용 용어**와 비교를 위한 **채점용 목표 용어**를 분리해, 정답 용어를 손으로 추가해도 그것만으로 인식 힌트에 들어가지는 않게 했습니다. 기준 대본과 맞지 않는 과거 녹음은 연결 확인용으로만 남깁니다.

팀 최종 보고에는 5개 강연 × 3회, 총 213회 목표 용어 출현에 대한 세 조건의 결과가 있습니다. C 결과는 발음 별칭 힌트와 확정 자막 연결을 합친 결과여서 한 개 변경의 효과로 분해할 수 없습니다. 전체 자막 오인식률, 사용자 이해도, 현장 실시간 지연을 측정한 값도 아닙니다.

근거: [PDF 기반 반복 실험 커밋](https://github.com/nsjjjjjj/lecture-context-ai/commit/34e00babe14b184929d33449d193e0383e30ad72) · [실험 설정 코드](https://github.com/nsjjjjjj/lecture-context-ai/blob/68e2fa0ef2926b783b5e1f941ca9bdc90ab2630e/server/src/services/experiment-studies.ts) · [파일럿 기록](https://github.com/nsjjjjjj/lecture-context-ai/blob/68e2fa0ef2926b783b5e1f941ca9bdc90ab2630e/docs/STT_PHRASESET_PILOT.md) · [팀 최종 기록](https://github.com/nsjjjjjj/lecture-context-ai/blob/68e2fa0ef2926b783b5e1f941ca9bdc90ab2630e/README.md#최종-stt-비교-결과).

## 버전 및 검증 경계

| 구분 | 확인할 수 있는 것 | 이 문서가 주장하지 않는 것 |
| --- | --- | --- |
| 팀 병합본 | Google STT V2를 사용한 코드 경로, Cloud Run용 컨테이너 구성, 당시 팀 실험 기록 | 지금 공개 서버의 가동 또는 배포 소유 |
| README 발표 장면 | 그 팀 커밋의 앱을 실행한 내장 샘플과 별도 슬라이드의 합성 | PPT 내장 기능, 실제 마이크·Gemini·Google STT로 새로 실행한 결과 |
| 이후 로컬 후속 작업 | AWS Transcribe와 발표 PDF 사용 흐름은 다른 버전의 계획·구현 | 같은 GIF로 후속 기능을 검증했다거나 그 후속 작업을 공개 배포했다는 주장 |

## 도식 유지 방법

- **책임과 경계:** 브라우저, 앱 서버, 외부 서비스의 역할과 연결을 분리합니다. 추상화 기준은 [C4 컨테이너와 표기법](https://c4model.com/diagrams/container)을 참고했습니다.
- **보기 방식:** 업로드와 실시간 음성을 색과 번호로 구분하고, 데이터 이름과 진행 방향을 화살표와 함께 표시합니다. [D2의 테마 예시](https://d2lang.com/tour/themes/)에서 일관된 색·간격을, [Excalidraw](https://github.com/excalidraw/excalidraw)에서 표시용 이미지와 편집 원본을 나누는 방식을 참고했습니다. 다른 프로젝트의 이미지를 복사하지 않았습니다.

**아키텍처 원본:** [시스템·배포 구성 편집 자료와 MAS 적용 범위](architecture/README.md).
