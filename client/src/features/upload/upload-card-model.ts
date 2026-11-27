/** Decorative upload-card layer kept inert for pointer and accessibility input. */
export const UPLOAD_CARD_GLOW_PROPS = {
  "aria-hidden": true,
  className: "pointer-events-none absolute -inset-3 rounded-[2.4rem] bg-gradient-to-br from-cyan-300/15 via-transparent to-blue-500/10 blur-2xl"
} as const;

export function presentationUploadFailureMessage(
  error: unknown,
  attemptedFileName: string,
  retainedFileName?: string
): string {
  const reason = error instanceof Error && error.message.trim()
    ? error.message.trim()
    : "발표 PDF를 준비하지 못했습니다.";
  if (retainedFileName) {
    return `‘${attemptedFileName}’ 교체 실패 — ${reason} 기존 발표 PDF 유지: ‘${retainedFileName}’. 그대로 시작하거나 다른 PDF를 선택하세요.`;
  }
  return `‘${attemptedFileName}’ 선택 실패 — ${reason} 다른 PDF를 선택하거나 발표 PDF 없이 자막 모드로 계속하세요.`;
}
