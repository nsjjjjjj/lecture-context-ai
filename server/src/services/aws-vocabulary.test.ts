import { describe, expect, it, vi } from "vitest";
import type { GlossaryTerm } from "../types.js";
import {
  AWS_VOCABULARY_MAX_BYTES,
  AwsVocabularyManager,
  AwsVocabularyPreparationCancelledError,
  AwsVocabularyPreparationError,
  awsVocabularyNameForTerms,
  buildAwsVocabularyTable,
  formatAwsVocabularyPhrase,
  hashAwsVocabularyTable
} from "./aws-vocabulary.js";

const terms: GlossaryTerm[] = [
  {
    id: "rag",
    term: "RAG",
    english: "Retrieval-Augmented Generation",
    spokenAliases: ["래그", "알에이지"],
    easyExplanation: "검색 결과를 답변에 더하는 방식",
    pageNumber: 1,
    occurrences: 2,
    source: "demo"
  }
];

describe("AWS custom vocabulary table", () => {
  it("필수 네 열과 canonical DisplayAs를 만들고 공백·약어를 AWS 형식으로 바꾼다", () => {
    expect(formatAwsVocabularyPhrase("RAG 2")).toBe("R.A.G.-two");
    expect(buildAwsVocabularyTable(terms)).toBe(
      "Phrase\tSoundsLike\tIPA\tDisplayAs\n" +
        "R.A.G.\t\t\tRAG\n" +
        "Retrieval-Augmented-Generation\t\t\tRetrieval-Augmented Generation\n" +
        "래그\t\t\t래그\n" +
        "알에이지\t\t\t알에이지\n"
    );
  });

  it("기술 표기의 점·기호·숫자를 의미가 충돌하지 않는 AWS phrase로 변환한다", () => {
    expect(formatAwsVocabularyPhrase("PDF.js")).toBe("P.D.F.-js");
    expect(formatAwsVocabularyPhrase("C++")).toBe("C-plus-plus");
    expect(formatAwsVocabularyPhrase("C#")).toBe("C-sharp");
    expect(formatAwsVocabularyPhrase("VX02Q")).toBe("V.X.-zero-two-Q");
    expect(formatAwsVocabularyPhrase("GPT-42")).toBe("G.P.T.-four-two");
    expect(formatAwsVocabularyPhrase("DynamoDB")).toBe("DynamoDB");

    const table = buildAwsVocabularyTable([
      { ...terms[0]!, id: "cpp", term: "C++", english: "", spokenAliases: [] },
      { ...terms[0]!, id: "csharp", term: "C#", english: "", spokenAliases: [] }
    ]);
    expect(table).toContain("C-plus-plus\t\t\tC++");
    expect(table).toContain("C-sharp\t\t\tC#");
  });

  it("AWS의 항목당 256자 제한을 생성 전에 검증한다", () => {
    expect(() => buildAwsVocabularyTable([
      { ...terms[0]!, term: "가".repeat(257), english: "", spokenAliases: [] }
    ])).toThrow("256자 이하");
  });

  it("같은 표는 같은 content hash를 만든다", () => {
    const table = buildAwsVocabularyTable(terms);
    expect(hashAwsVocabularyTable(table)).toMatch(/^[a-f0-9]{64}$/u);
    expect(hashAwsVocabularyTable(table)).toBe(hashAwsVocabularyTable(buildAwsVocabularyTable(terms)));
  });

  it("용어·alias 순서와 중복 입력에 관계없이 같은 canonical 표와 이름을 만든다", () => {
    const llm: GlossaryTerm = {
      ...terms[0]!,
      id: "llm",
      term: "LLM",
      english: "Large Language Model",
      spokenAliases: ["엘엘엠", "거대 언어 모델"]
    };
    const canonicalInput = [terms[0]!, llm];
    const reorderedWithDuplicates = [
      { ...llm, spokenAliases: [...llm.spokenAliases].reverse() },
      { ...terms[0]!, spokenAliases: [...terms[0]!.spokenAliases].reverse() },
      terms[0]!,
      llm
    ];

    const canonicalTable = buildAwsVocabularyTable(canonicalInput);
    const reorderedTable = buildAwsVocabularyTable(reorderedWithDuplicates);
    expect(reorderedTable).toBe(canonicalTable);
    expect(hashAwsVocabularyTable(reorderedTable)).toBe(hashAwsVocabularyTable(canonicalTable));
    expect(awsVocabularyNameForTerms(reorderedWithDuplicates)).toBe(awsVocabularyNameForTerms(canonicalInput));
  });

  it("같은 AWS phrase가 서로 다른 표기로 변환되는 충돌은 계속 거부한다", () => {
    expect(() => buildAwsVocabularyTable([
      { ...terms[0]!, id: "spaced", term: "foo bar", english: "", spokenAliases: [] },
      { ...terms[0]!, id: "hyphenated", term: "foo-bar", english: "", spokenAliases: [] }
    ])).toThrow("표기 변환 결과가 충돌");
  });

  it("50KB를 넘으면 일부 용어를 조용히 버리지 않고 실패한다", () => {
    const manyTerms = Array.from({ length: 700 }, (_, index) => ({
      ...terms[0]!,
      id: String(index),
      term: `용어${index}가나다라마바사아자차카타파하`,
      english: `Very Long Technical Vocabulary Number ${index} With More Content`
    }));
    expect(() => buildAwsVocabularyTable(manyTerms)).toThrow(AwsVocabularyPreparationError);
    expect(Buffer.byteLength(buildAwsVocabularyTable(terms))).toBeLessThan(AWS_VOCABULARY_MAX_BYTES);
  });
});

describe("AwsVocabularyManager", () => {
  it("NOT_CONFIGURED는 같은 설정으로 재시도해도 낫지 않으므로 retryable=false다", () => {
    expect(new AwsVocabularyPreparationError("NOT_CONFIGURED", "bucket 설정 필요")).toMatchObject({
      httpStatus: 503,
      retryable: false
    });
  });

  it("이미 취소된 호출은 AWS 조회나 S3 쓰기를 시작하지 않는다", async () => {
    const transcribe = {
      getVocabulary: vi.fn(),
      createVocabulary: vi.fn(),
      countVocabularies: vi.fn()
    };
    const storage = { putText: vi.fn(), deleteObject: vi.fn() };
    const manager = new AwsVocabularyManager({ bucket: "vocab-bucket", transcribe, storage });
    const controller = new AbortController();
    controller.abort(new Error("request already closed"));

    await expect(manager.prepare(terms, { signal: controller.signal }))
      .rejects.toBeInstanceOf(AwsVocabularyPreparationCancelledError);
    expect(transcribe.getVocabulary).not.toHaveBeenCalled();
    expect(transcribe.countVocabularies).not.toHaveBeenCalled();
    expect(storage.putText).not.toHaveBeenCalled();
  });

  it("READY content hash 용어집을 재사용하고 업로드하지 않는다", async () => {
    const transcribe = {
      getVocabulary: vi.fn(async () => ({ $metadata: {}, VocabularyState: "READY" as const })),
      createVocabulary: vi.fn()
    };
    const storage = { putText: vi.fn(), deleteObject: vi.fn() };
    const manager = new AwsVocabularyManager({ bucket: "vocab-bucket", transcribe, storage });

    const result = await manager.prepare(terms);
    expect(result.reused).toBe(true);
    expect(result.vocabularyName).toMatch(/^lecture-ko-[a-f0-9]{16}$/u);
    expect(storage.putText).not.toHaveBeenCalled();
  });

  it("S3 table을 올리고 PENDING을 READY까지 기다린 뒤 source를 지운다", async () => {
    let inspections = 0;
    const transcribe = {
      getVocabulary: vi.fn(async () => {
        inspections += 1;
        if (inspections === 1) {
          const error = new Error("couldn't be found");
          error.name = "BadRequestException";
          throw error;
        }
        return { $metadata: {}, VocabularyState: inspections === 2 ? "PENDING" as const : "READY" as const };
      }),
      createVocabulary: vi.fn(async () => ({ $metadata: {}, VocabularyState: "PENDING" as const }))
    };
    const storage = { putText: vi.fn(async () => undefined), deleteObject: vi.fn(async () => undefined) };
    const manager = new AwsVocabularyManager({
      bucket: "vocab-bucket",
      transcribe,
      storage,
      wait: vi.fn(async () => undefined)
    });

    const result = await manager.prepare(terms);
    expect(result.reused).toBe(false);
    expect(storage.putText).toHaveBeenCalledWith(
      "vocab-bucket",
      expect.stringMatching(/lecture-ko-[a-f0-9]{16}\.txt$/u),
      expect.stringContaining("Phrase\tSoundsLike\tIPA\tDisplayAs"),
      expect.any(AbortSignal)
    );
    expect(transcribe.createVocabulary).toHaveBeenCalledWith(
      expect.objectContaining({ LanguageCode: "ko-KR", VocabularyName: result.vocabularyName }),
      expect.any(AbortSignal)
    );
    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
  });

  it("동일 hash 동시 요청은 하나의 AWS 작업만 공유한다", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transcribe = {
      getVocabulary: vi.fn(async () => {
        await gate;
        return { $metadata: {}, VocabularyState: "READY" as const };
      }),
      createVocabulary: vi.fn()
    };
    const manager = new AwsVocabularyManager({
      bucket: "vocab-bucket",
      transcribe,
      storage: { putText: vi.fn(), deleteObject: vi.fn() }
    });

    const first = manager.prepare(terms);
    const second = manager.prepare(terms);
    expect(first).toBe(second);
    release?.();
    await expect(first).resolves.toMatchObject({ reused: true });
    expect(transcribe.getVocabulary).toHaveBeenCalledTimes(1);
  });

  it("마지막 HTTP 구독자가 취소하면 READY polling을 멈추고 S3 source를 정리한다", async () => {
    let inspections = 0;
    let markWaiting: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => { markWaiting = resolve; });
    const missing = new Error("not found");
    missing.name = "NotFoundException";
    const transcribe = {
      getVocabulary: vi.fn(async () => {
        inspections += 1;
        if (inspections === 1) throw missing;
        return { $metadata: {}, VocabularyState: "PENDING" as const };
      }),
      createVocabulary: vi.fn(async () => ({ $metadata: {}, VocabularyState: "PENDING" as const }))
    };
    const storage = {
      putText: vi.fn(async () => undefined),
      deleteObject: vi.fn(async () => undefined)
    };
    const manager = new AwsVocabularyManager({
      bucket: "vocab-bucket",
      transcribe,
      storage,
      wait: vi.fn((_delayMs, signal) => {
        markWaiting?.();
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      })
    });
    const controller = new AbortController();
    const preparation = manager.prepare(terms, { signal: controller.signal });
    await waiting;

    controller.abort(new Error("client disconnected"));

    await expect(preparation).rejects.toBeInstanceOf(AwsVocabularyPreparationCancelledError);
    await vi.waitFor(() => expect(storage.deleteObject).toHaveBeenCalledTimes(1));
    expect(transcribe.getVocabulary).toHaveBeenCalledTimes(2);
    expect(transcribe.createVocabulary).toHaveBeenCalledTimes(1);
  });

  it("동일 hash의 다른 구독자가 남아 있으면 한 client 취소로 공유 AWS 작업을 중단하지 않는다", async () => {
    let releaseInspection: (() => void) | undefined;
    const inspectionGate = new Promise<void>((resolve) => { releaseInspection = resolve; });
    let operationSignal: AbortSignal | undefined;
    const transcribe = {
      getVocabulary: vi.fn(async (_name: string, signal?: AbortSignal) => {
        operationSignal = signal;
        await inspectionGate;
        return { $metadata: {}, VocabularyState: "READY" as const };
      }),
      createVocabulary: vi.fn()
    };
    const manager = new AwsVocabularyManager({
      bucket: "vocab-bucket",
      transcribe,
      storage: { putText: vi.fn(), deleteObject: vi.fn() }
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = manager.prepare(terms, { signal: firstController.signal });
    const second = manager.prepare(terms, { signal: secondController.signal });

    firstController.abort(new Error("first client disconnected"));
    await expect(first).rejects.toBeInstanceOf(AwsVocabularyPreparationCancelledError);
    expect(operationSignal?.aborted).toBe(false);

    releaseInspection?.();
    await expect(second).resolves.toMatchObject({ reused: true });
    expect(transcribe.getVocabulary).toHaveBeenCalledTimes(1);
  });

  it("FAILED와 timeout을 기본 인식 fallback 없이 명시적으로 실패시킨다", async () => {
    const failed = new AwsVocabularyManager({
      bucket: "vocab-bucket",
      transcribe: {
        getVocabulary: vi.fn(async () => ({ $metadata: {}, VocabularyState: "FAILED" as const })),
        createVocabulary: vi.fn()
      },
      storage: { putText: vi.fn(), deleteObject: vi.fn() }
    });
    await expect(failed.prepare(terms)).rejects.toThrow("실패 상태");

    let now = 0;
    const timedOut = new AwsVocabularyManager({
      bucket: "vocab-bucket",
      transcribe: {
        getVocabulary: vi.fn(async () => ({ $metadata: {}, VocabularyState: "PENDING" as const })),
        createVocabulary: vi.fn()
      },
      storage: { putText: vi.fn(), deleteObject: vi.fn() },
      timeoutMs: 10,
      now: () => now,
      wait: vi.fn(async () => {
        now = 10;
      })
    });
    await expect(timedOut.prepare(terms)).rejects.toThrow("시간이 초과");
  });

  it("create 실패 시 올린 S3 source를 정리하고 원래 원인을 cause로 보존한다", async () => {
    const missing = new Error("not found");
    missing.name = "NotFoundException";
    const createFailure = new Error("access denied");
    const storage = {
      putText: vi.fn(async () => undefined),
      deleteObject: vi.fn(async () => undefined)
    };
    const manager = new AwsVocabularyManager({
      bucket: "vocab-bucket",
      transcribe: {
        getVocabulary: vi.fn(async () => { throw missing; }),
        createVocabulary: vi.fn(async () => { throw createFailure; })
      },
      storage
    });

    const rejection = await manager.prepare(terms).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(AwsVocabularyPreparationError);
    expect(rejection).toMatchObject({ code: "DEPENDENCY_ERROR", httpStatus: 502, cause: createFailure });
    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
  });

  it("다른 인스턴스가 같은 vocabulary를 먼저 만들면 conflict 뒤 READY를 재사용한다", async () => {
    let inspection = 0;
    const missing = new Error("not found");
    missing.name = "NotFoundException";
    const conflict = new Error("already exists");
    conflict.name = "ConflictException";
    const manager = new AwsVocabularyManager({
      bucket: "vocab-bucket",
      transcribe: {
        getVocabulary: vi.fn(async () => {
          inspection += 1;
          if (inspection === 1) throw missing;
          return { $metadata: {}, VocabularyState: "READY" as const };
        }),
        createVocabulary: vi.fn(async () => { throw conflict; })
      },
      storage: { putText: vi.fn(async () => undefined), deleteObject: vi.fn(async () => undefined) },
      wait: vi.fn(async () => undefined)
    });

    await expect(manager.prepare(terms)).resolves.toMatchObject({ reused: true });
  });

  it("계정 vocabulary가 안전 한도에 도달하면 S3 업로드 전에 생성을 막는다", async () => {
    const missing = new Error("not found");
    missing.name = "NotFoundException";
    const storage = { putText: vi.fn(), deleteObject: vi.fn() };
    const manager = new AwsVocabularyManager({
      bucket: "vocab-bucket",
      maxVocabularyCount: 95,
      transcribe: {
        getVocabulary: vi.fn(async () => { throw missing; }),
        createVocabulary: vi.fn(),
        countVocabularies: vi.fn(async () => 95)
      },
      storage
    });

    await expect(manager.prepare(terms)).rejects.toMatchObject({
      code: "QUOTA_GUARD",
      httpStatus: 503,
      retryable: false
    });
    expect(storage.putText).not.toHaveBeenCalled();
  });
});
