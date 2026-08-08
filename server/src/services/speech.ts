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

type SpeechWritableStream = {
  destroyed?: boolean;
  writable?: boolean;
  writableEnded?: boolean;
  write: (value: unknown, callback?: (error?: Error | null) => void) => unknown;
};

export function isSpeechStreamWritable(stream: SpeechWritableStream): boolean {
  return stream.destroyed !== true && stream.writableEnded !== true && stream.writable !== false;
}

export function createGuardedSpeechWriter(stream: SpeechWritableStream, onError: (error: Error) => void) {
  let stopped = false;

  const fail = (error: unknown): void => {
    if (stopped) return;
    stopped = true;
    onError(error instanceof Error ? error : new Error(String(error)));
  };

  return {
    write(value: unknown): boolean {
      if (stopped || !isSpeechStreamWritable(stream)) return false;
      try {
        stream.write(value, (error?: Error | null) => {
          if (error) fail(error);
        });
        return true;
      } catch (error) {
        fail(error);
        return false;
      }
    },
    fail,
    stop(): void {
      stopped = true;
    }
  };
}

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
  let clientClosed = false;
  const closeClient = (): void => {
    if (clientClosed) return;
    clientClosed = true;
    void client.close();
  };
  const writer = createGuardedSpeechWriter(stream, callbacks.onError);

  stream.on("data", (response: any) => {
    for (const result of response.results ?? []) {
      const text = result.alternatives?.[0]?.transcript?.trim();
      if (!text) continue;
      callbacks.onTranscript(text, Boolean(result.isFinal));
    }
  });
  stream.on("error", (error: Error) => {
    writer.fail(error);
    closeClient();
  });
  stream.on("end", () => {
    writer.stop();
    callbacks.onEnd();
    closeClient();
  });
  stream.on("close", closeClient);

  writer.write(buildStreamingRecognizeRequest(projectId, location, model, phraseSet));

  return {
    writeAudio(audio: Buffer) {
      if (audio.byteLength > 15_000) {
        callbacks.onError(new Error("오디오 청크가 Google STT의 15KB 제한을 초과했습니다."));
        return;
      }
      writer.write({ audio });
    },
    close() {
      writer.stop();
      if (!stream.destroyed && !stream.writableEnded) stream.end();
      if (stream.destroyed || stream.writableEnded) closeClient();
    }
  };
}
