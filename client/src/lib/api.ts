import type { AnalysisResult, PageText, ServiceStatus } from "../types";

export type AudioFixtureScript = {
  id: string;
  title: string;
  languageCode: "ko-KR";
  text: string;
  targetTerms: string[];
};

export type AudioFixtureRecording = {
  id: string;
  fileName: string;
  relativePath: string;
  scriptId: string;
  speakerLabel: "speaker-a" | "speaker-b";
  environment: "quiet" | "noisy";
  createdAt: string;
  durationMs: number;
  sampleRate: 16000;
  channels: 1;
  bitsPerSample: 16;
  dataBytes: number;
};

export type AudioFixtureCatalog = {
  scripts: AudioFixtureScript[];
  recordings: AudioFixtureRecording[];
  storageDirectory: string;
};

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

export async function getAudioFixtures(): Promise<AudioFixtureCatalog> {
  const response = await fetch("/api/dev/audio-fixtures");
  return readJson<AudioFixtureCatalog>(response);
}

export async function saveAudioFixture(input: {
  wav: Blob;
  scriptId: string;
  speakerLabel: "speaker-a" | "speaker-b";
  environment: "quiet" | "noisy";
}): Promise<{ recording: AudioFixtureRecording; storageDirectory: string }> {
  const query = new URLSearchParams({
    scriptId: input.scriptId,
    speakerLabel: input.speakerLabel,
    environment: input.environment
  });
  const response = await fetch(`/api/dev/audio-fixtures?${query.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body: input.wav
  });
  return readJson<{ recording: AudioFixtureRecording; storageDirectory: string }>(response);
}
