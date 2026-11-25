# 강연 용어 AI | 그림 원본

팀 기준 커밋 `68e2fa0ef2926b783b5e1f941ca9bdc90ab2630e`의 실제 PDF·마이크 처리 코드와 배포 설정을 기준으로 그렸다. 시스템과 인프라 그림은 운영 배포의 현재 상태나 외부 서비스 호출을 시연한 결과가 아니다.

| 그림 | 읽는 기준 | 편집 원본 |
| --- | --- | --- |
| [시스템](abc-system.svg) | PDF 텍스트 분석과 음성 WebSocket이 같은 용어집으로 연결되는 흐름 | [draw.io](abc-system.drawio) |
| [인프라](abc-infrastructure.svg) | React·Express가 한 Cloud Run 컨테이너에 있고 외부 Google 서비스에 연결되는 구성 | [draw.io](abc-infrastructure.drawio) |
| [샘플 워크플로](abc-workflow.svg) | 내장 용어집을 열고 임시·확정 자막과 결과를 확인하는 실제 시연 경로 | [draw.io](abc-workflow.drawio) |

코드 대조 지점: `client/src/hooks/useLectureStream.ts`, `server/src/app.ts`, `server/src/index.ts`, `server/src/services/glossary.ts`, `server/src/services/speech.ts`, `Dockerfile`. [팀 기준 코드](https://github.com/nsjjjjjj/lecture-context-ai/tree/68e2fa0ef2926b783b5e1f941ca9bdc90ab2630e)
