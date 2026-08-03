import type { AnalysisResult, PageText, ServiceStatus } from "../types";

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "요청을 처리하지 못했습니다.");
  return body;
}

export async function getHealth(): Promise<ServiceStatus> {
  const response = await fetch("/api/health");
  return readJson<ServiceStatus>(response);
}

export async function getDemo(): Promise<AnalysisResult> {
  const response = await fetch("/api/demo");
  return readJson<AnalysisResult>(response);
}

export async function analyzePdf(title: string, pages: PageText[]): Promise<AnalysisResult> {
  const response = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, pages })
  });
  const result = await readJson<Omit<AnalysisResult, "pages">>(response);
  return { ...result, pages };
}
