import { v2 } from "@google-cloud/speech";
import type { GlossaryTerm } from "../types.js";

type SpeechCallbacks = {
  onTranscript: (text: string, isFinal: boolean, latencyMs: number) => void;
  onError: (error: Error) => void;
  onEnd: () => void;
};

export type SpeechSession = {
  writeAudio: (audio: Buffer) => void;
  close: () => void;
};

export function isGoogleSpeechConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLOUD_PROJECT);
}

export function createGoogleSpeechSession(terms: GlossaryTerm[], callbacks: SpeechCallbacks): SpeechSession {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) throw new Error("GOOGLE_CLOUD_PROJECT가 설정되지 않았습니다.");

  const location = process.env.GOOGLE_STT_LOCATION || "us";
  const model = process.env.GOOGLE_STT_MODEL || "chirp_3";
  const apiEndpoint = location === "global" ? undefined : `${location}-speech.googleapis.com`;
  const client = new v2.SpeechClient(apiEndpoint ? { apiEndpoint } : undefined);
  const stream = (client as unknown as { streamingRecognize: () => any }).streamingRecognize();
  let lastAudioAt = Date.now();

  stream.on("data", (response: any) => {
    for (const result of response.results ?? []) {
      const text = result.alternatives?.[0]?.transcript?.trim();
      if (!text) continue;
      callbacks.onTranscript(text, Boolean(result.isFinal), Math.max(0, Date.now() - lastAudioAt));
    }
  });
  stream.on("error", (error: Error) => callbacks.onError(error));
  stream.on("end", () => callbacks.onEnd());

  stream.write({
    recognizer: `projects/${projectId}/locations/${location}/recognizers/_`,
    streamingConfig: {
      config: {
        explicitDecodingConfig: {
          encoding: "LINEAR16",
          sampleRateHertz: 16_000,
          audioChannelCount: 1
        },
        languageCodes: ["ko-KR"],
        model,
        features: { enableAutomaticPunctuation: true },
        adaptation: {
          phraseSets: [
            {
              inlinePhraseSet: {
                phrases: terms.slice(0, 50).map((term) => ({ value: term.term }))
              }
            }
          ]
        }
      },
      streamingFeatures: { interimResults: true }
    }
  });

  return {
    writeAudio(audio: Buffer) {
      if (audio.byteLength > 15_000) {
        callbacks.onError(new Error("오디오 청크가 Google STT의 15KB 제한을 초과했습니다."));
        return;
      }
      lastAudioAt = Date.now();
      stream.write({ audio });
    },
    close() {
      stream.end();
      void client.close();
    }
  };
}
