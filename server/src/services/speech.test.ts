import { describe, expect, it } from "vitest";
import { buildStreamingRecognizeRequest } from "./speech.js";

describe("buildStreamingRecognizeRequest", () => {
  it("검증된 PhraseSet 값을 Google STT 인라인 적응 설정에 그대로 전달한다", () => {
    const request = buildStreamingRecognizeRequest("project", "us", "chirp_3", [
      "RAG",
      "Retrieval-Augmented Generation"
    ]);

    expect(request.streamingConfig.config.adaptation?.phraseSets[0]?.inlinePhraseSet.phrases).toEqual([
      { value: "RAG" },
      { value: "Retrieval-Augmented Generation" }
    ]);
  });

  it("PhraseSet이 비어 있으면 adaptation 설정을 보내지 않는다", () => {
    const request = buildStreamingRecognizeRequest("project", "us", "chirp_3", []);

    expect(request.streamingConfig.config).not.toHaveProperty("adaptation");
  });
});
