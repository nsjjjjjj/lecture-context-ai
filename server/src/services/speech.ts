import { v2 } from "@google-cloud/speech";

type SpeechCallbacks = {
  onTranscript: (text: string, isFinal: boolean) => void;
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

export function buildStreamingRecognizeRequest(projectId: string, location: string, model: string, phraseSet: string[]) {
  const config: {
    explicitDecodingConfig: {
      encoding: "LINEAR16";
      sampleRateHertz: number;
      audioChannelCount: number;
    };
    languageCodes: string[];
    model: string;
    features: { enableAutomaticPunctuation: boolean };
    adaptation?: { phraseSets: Array<{ inlinePhraseSet: { phrases: Array<{ value: string }> } }> };
  } = {
    explicitDecodingConfig: {
      encoding: "LINEAR16",
      sampleRateHertz: 16_000,
      audioChannelCount: 1
    },
    languageCodes: ["ko-KR"],
    model,
    features: { enableAutomaticPunctuation: true }
  };

  if (phraseSet.length > 0) {
    config.adaptation = {
      phraseSets: [
        {
          inlinePhraseSet: {
            phrases: phraseSet.slice(0, 50).map((value) => ({ value }))
          }
        }
      ]
    };
  }

  return {
    recognizer: `projects/${projectId}/locations/${location}/recognizers/_`,
    streamingConfig: {
      config,
      streamingFeatures: { interimResults: true }
    }
  };
}

export function createGoogleSpeechSession(phraseSet: string[], callbacks: SpeechCallbacks): SpeechSession {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) throw new Error("GOOGLE_CLOUD_PROJECT가 설정되지 않았습니다.");

  const location = process.env.GOOGLE_STT_LOCATION || "us";
  const model = process.env.GOOGLE_STT_MODEL || "chirp_3";
  const apiEndpoint = location === "global" ? undefined : `${location}-speech.googleapis.com`;
  const client = new v2.SpeechClient(apiEndpoint ? { apiEndpoint } : undefined);
  const stream = (client as unknown as { streamingRecognize: () => any }).streamingRecognize();

  stream.on("data", (response: any) => {
    for (const result of response.results ?? []) {
      const text = result.alternatives?.[0]?.transcript?.trim();
      if (!text) continue;
      callbacks.onTranscript(text, Boolean(result.isFinal));
    }
  });
  stream.on("error", (error: Error) => callbacks.onError(error));
  stream.on("end", () => callbacks.onEnd());

  stream.write(buildStreamingRecognizeRequest(projectId, location, model, phraseSet));

  return {
    writeAudio(audio: Buffer) {
      if (audio.byteLength > 15_000) {
        callbacks.onError(new Error("오디오 청크가 Google STT의 15KB 제한을 초과했습니다."));
        return;
      }
      stream.write({ audio });
    },
    close() {
      stream.end();
      void client.close();
    }
  };
}
