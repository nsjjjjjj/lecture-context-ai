// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GLOSSARY_STORAGE_KEY,
  GLOSSARY_STORAGE_RECOVERY_KEY,
  deleteStoredGlossary,
  listStoredGlossaries,
  saveAnalyzedGlossary
} from "./lib/glossary-storage";
import type { PresentationAsset } from "./lib/presentation";
import type { AnalysisResult } from "./types";

const mocks = vi.hoisted(() => ({
  getHealth: vi.fn(),
  getDemo: vi.fn(),
  analyzePdf: vi.fn(),
  prepareAwsVocabulary: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  discardSession: vi.fn(),
  stream: {
    status: "idle" as const,
    statusMessage: "강연을 시작할 준비가 되었습니다.",
    sessionOutcome: null,
    interim: "",
    partialSegments: [],
    finalizedSegmentIds: [],
    transcript: {
      completedChunks: [],
      activeChunk: [],
      lineCount: 0,
      appendOperations: 0,
      structuralReferenceCopies: 0
    },
    captionTail: [],
    termOccurrences: []
  }
}));

vi.mock("./lib/api", () => ({
  analyzePdf: (...args: unknown[]) => mocks.analyzePdf(...args),
  getDemo: (...args: unknown[]) => mocks.getDemo(...args),
  getHealth: (...args: unknown[]) => mocks.getHealth(...args),
  prepareAwsVocabulary: (...args: unknown[]) => mocks.prepareAwsVocabulary(...args)
}));

vi.mock("./hooks/useLectureStream", () => ({
  useLectureStream: () => ({
    ...mocks.stream,
    start: mocks.start,
    stop: mocks.stop,
    discardSession: mocks.discardSession
  })
}));

import {
  App,
  LiveCaptionRows,
  LiveScreen,
  PresentationUploadCard
} from "./App";
import { LIVE_CAPTION_SIZE_CLASS } from "./features/captions/live-caption-model";

const demoAnalysis: AnalysisResult = {
  title: "RAG 강연",
  pages: [{ pageNumber: 1, text: "RAG와 Retrieval-Augmented Generation을 설명합니다." }],
  terms: [{
    id: "rag",
    term: "RAG",
    english: "Retrieval-Augmented Generation",
    spokenAliases: ["래그"],
    easyExplanation: "외부 자료를 찾아 답변에 활용하는 방식",
    pageNumber: 1,
    occurrences: 2,
    source: "demo"
  }],
  phraseSet: ["RAG", "Retrieval-Augmented Generation", "래그"],
  mode: "demo"
};

const reviewAnalysis: AnalysisResult = {
  ...demoAnalysis,
  terms: [
    ...demoAnalysis.terms,
    {
      id: "vector-database",
      term: "벡터 데이터베이스",
      english: "Vector Database",
      spokenAliases: ["벡터 디비"],
      easyExplanation: "비슷한 의미의 데이터를 빠르게 찾는 저장소",
      pageNumber: 1,
      occurrences: 1,
      source: "demo"
    }
  ],
  phraseSet: [
    ...demoAnalysis.phraseSet,
    "벡터 데이터베이스",
    "Vector Database",
    "벡터 디비"
  ]
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "#/lecture");
  delete (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker;
  Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
  mocks.stream.status = "idle";
  mocks.stream.statusMessage = "강연을 시작할 준비가 되었습니다.";
  mocks.stream.sessionOutcome = null;
  mocks.stream.interim = "";
  mocks.stream.partialSegments = [];
  mocks.stream.finalizedSegmentIds = [];
  mocks.stream.transcript = {
    completedChunks: [],
    activeChunk: [],
    lineCount: 0,
    appendOperations: 0,
    structuralReferenceCopies: 0
  };
  mocks.stream.captionTail = [];
  mocks.stream.termOccurrences = [];
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))
  });
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0)
  });
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    value: (id: number) => window.clearTimeout(id)
  });
  mocks.getHealth.mockReset().mockResolvedValue({
    ok: true,
    sttProvider: "aws",
    services: {
      speech: { configured: true, verification: "unverified" },
      gemini: true,
      customVocabulary: { configured: true, verification: "unverified" }
    }
  });
  mocks.getDemo.mockReset().mockResolvedValue(demoAnalysis);
  mocks.analyzePdf.mockReset();
  mocks.prepareAwsVocabulary.mockReset().mockResolvedValue({
    vocabularyName: "lecture-ko-0123456789abcdef",
    hash: "0".repeat(64),
    reused: false
  });
  mocks.start.mockReset().mockResolvedValue({ status: "opening", mode: "live" });
  mocks.stop.mockReset().mockResolvedValue({
    status: "completed",
    reason: "server-ended",
    message: "강연을 종료했습니다."
  });
  mocks.discardSession.mockReset();
});

async function reachReadyScreen() {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole("button", { name: "샘플 강연 바로 체험하기" }));
  await screen.findByRole("heading", { name: /준비가 됐어요/ });
  return user;
}

describe("browser workflow boundaries", () => {
  it("AWS 설정 감지와 실제 동작 검증을 구분해 안내한다", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("AWS 설정 감지 · 동작 미확인");
    await user.click(screen.getByRole("button", { name: "샘플 강연 바로 체험하기" }));
    await screen.findByRole("heading", { name: /준비가 됐어요/ });

    expect(screen.getByText(/AWS 설정값만 감지했습니다/).textContent).toContain("pnpm aws:doctor");
    expect((screen.getByRole("button", { name: "용어집 적용해 실시간 시작" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("이미 확인된 AWS 동작 실패를 미설정이나 사용 가능으로 표시하지 않는다", async () => {
    mocks.getHealth.mockResolvedValue({
      ok: true,
      sttProvider: "aws",
      services: {
        speech: { configured: true, verification: "failed" },
        gemini: true,
        customVocabulary: { configured: true, verification: "failed" }
      }
    });

    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("AWS 동작 확인 실패 · 데모 가능");
    await user.click(screen.getByRole("button", { name: "샘플 강연 바로 체험하기" }));
    await screen.findByRole("heading", { name: /준비가 됐어요/ });
    expect(screen.getByText(/AWS 동작 확인에 실패했습니다/)).not.toBeNull();
    expect((screen.getByRole("button", { name: "기본 AWS 자막으로 시작" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "데모 자막으로 미리보기" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each([
    ["손상된 JSON", "{not-json"],
    ["지원하지 않는 미래 버전", JSON.stringify({ version: 99, glossaries: [{ future: true }] })],
    ["잘못된 v3 저장 봉투", JSON.stringify({ version: 3, glossaries: [], unexpected: "keep-exactly" })]
  ])("preserves the exact %s source before recovering a valid active v3 store", async (_caseName, source) => {
    window.localStorage.setItem(GLOSSARY_STORAGE_KEY, source);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    render(<App />);

    const recover = await screen.findByRole("button", { name: "원본 보존 후 복구" });
    expect(window.localStorage.getItem(GLOSSARY_STORAGE_KEY)).toBe(source);
    await user.click(recover);

    await waitFor(() => {
      const activeRaw = window.localStorage.getItem(GLOSSARY_STORAGE_KEY);
      expect(activeRaw).not.toBeNull();
      expect(JSON.parse(activeRaw!)).toMatchObject({ version: 3, glossaries: expect.any(Array) });
    });
    const recoveryStore = JSON.parse(window.localStorage.getItem(GLOSSARY_STORAGE_RECOVERY_KEY)!);
    expect(recoveryStore).toMatchObject({
      version: 1,
      backups: [expect.objectContaining({ reason: "manual-recovery", raw: source })]
    });
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("원본 전체"));
    expect(screen.getByText("원본 복구 데이터 1개를 이 브라우저에 보관하고 있습니다.")).not.toBeNull();
  });

  it("recovers losslessly from Ready and then retry-saves the current analysis", async () => {
    const source = JSON.stringify({ version: 99, glossaries: [{ future: "must-survive" }] });
    window.localStorage.setItem(GLOSSARY_STORAGE_KEY, source);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = await reachReadyScreen();

    expect(window.localStorage.getItem(GLOSSARY_STORAGE_KEY)).toBe(source);
    await user.click(screen.getByRole("button", { name: "원본 보존 후 복구·저장" }));

    await waitFor(() => expect(listStoredGlossaries(window.localStorage)).toHaveLength(1));
    const [saved] = listStoredGlossaries(window.localStorage);
    expect(saved).toMatchObject({
      name: demoAnalysis.title,
      terms: [expect.objectContaining({ id: "rag", term: "RAG" })]
    });
    const activeStore = JSON.parse(window.localStorage.getItem(GLOSSARY_STORAGE_KEY)!);
    expect(activeStore).toMatchObject({ version: 3, glossaries: [expect.objectContaining({ id: saved.id })] });
    const recoveryStore = JSON.parse(window.localStorage.getItem(GLOSSARY_STORAGE_RECOVERY_KEY)!);
    expect(recoveryStore.backups[0]).toMatchObject({ reason: "manual-recovery", raw: source });
    expect(await screen.findByText("자동 분석·저장 완료")).not.toBeNull();
  });

  it("lets the user export and explicitly clear a malformed recovery envelope", async () => {
    const malformedRecoverySource = "{malformed-recovery";
    window.localStorage.setItem(GLOSSARY_STORAGE_RECOVERY_KEY, malformedRecoverySource);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const createObjectUrl = vi.fn(() => "blob:recovery-export");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const user = userEvent.setup();
    render(<App />);

    const exportButton = await screen.findByRole("button", { name: "손상 원본 JSON 다운로드 요청" });
    await user.click(exportButton);
    expect(createObjectUrl).toHaveBeenCalledOnce();
    expect(window.localStorage.getItem(GLOSSARY_STORAGE_RECOVERY_KEY)).toBe(malformedRecoverySource);

    await user.click(screen.getByRole("button", { name: "손상 보관본 정리" }));
    await waitFor(() => expect(window.localStorage.getItem(GLOSSARY_STORAGE_RECOVERY_KEY)).toBeNull());
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("현재 용어집은 유지"));
    expect(await screen.findByText(/브라우저에 보관한 원본 복구 데이터를 정리했습니다/)).not.toBeNull();
  });

  it("disables every stored-glossary mutation while one locked mutation is pending", async () => {
    const saved = saveAnalyzedGlossary(window.localStorage, demoAnalysis, "잠금 테스트", {
      id: "locked-glossary",
      now: "2026-08-29T00:00:00.000Z"
    });
    const user = userEvent.setup();
    render(<App />);
    const renameButton = await screen.findByRole("button", { name: `${saved.name} 이름 바꾸기` });
    const deleteButton = screen.getByRole("button", { name: `${saved.name} 삭제` }) as HTMLButtonElement;
    const lockRelease = deferred<void>();
    const request = vi.fn(async (_name: string, _options: unknown, callback: () => unknown) => {
      await lockRelease.promise;
      return callback();
    });
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request } });
    vi.spyOn(window, "prompt").mockReturnValue("바뀐 이름");
    const confirm = vi.spyOn(window, "confirm");

    await user.click(renameButton);
    await waitFor(() => expect(deleteButton.disabled).toBe(true));
    fireEvent.click(deleteButton);
    expect(confirm).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();

    await act(async () => {
      lockRelease.resolve();
      await lockRelease.promise;
    });
    await screen.findByText("바뀐 이름");
  });

  it("focuses the current main from the skip link without replacing the hash route", async () => {
    const user = userEvent.setup();
    render(<App />);

    const skipLink = screen.getByRole("link", { name: "본문으로 건너뛰기" });
    const main = document.getElementById("app-main-content");
    expect(skipLink.getAttribute("href")).toBe("#/lecture");
    expect(main?.tagName).toBe("MAIN");
    await user.click(skipLink);
    expect(window.location.hash).toBe("#/lecture");
    expect(document.activeElement).toBe(main);
  });

  it("exposes the upload file control with an accessible purpose and stable form name", () => {
    render(<App />);

    const input = screen.getByLabelText("분석할 강연 PDF 파일 선택") as HTMLInputElement;
    expect(input.type).toBe("file");
    expect(input.name).toBe("analysis-pdf");
    expect(input.accept).toContain("application/pdf");
  });

  it("moves focus with the workflow and prevents experiment navigation during vocabulary preparation", async () => {
    const vocabulary = deferred<{ vocabularyName: string; hash: string; reused: boolean }>();
    mocks.prepareAwsVocabulary.mockReturnValue(vocabulary.promise);
    const user = await reachReadyScreen();

    await waitFor(() => expect(document.activeElement?.getAttribute("data-app-stage")).toBe("ready"));
    await user.click(screen.getByRole("button", { name: "용어집 적용해 실시간 시작" }));
    await screen.findByText("검증된 전문용어를 AWS 사용자 지정 용어집으로 준비하고 있습니다.");

    act(() => {
      window.location.hash = "#/experiment/setup";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await waitFor(() => expect(window.location.hash).toBe("#/lecture"));
    expect(screen.queryByText("STT 실험실 불러오는 중")).toBeNull();

    await act(async () => {
      vocabulary.resolve({
        vocabularyName: "lecture-ko-0123456789abcdef",
        hash: "0".repeat(64),
        reused: false
      });
      await vocabulary.promise;
    });
    await screen.findByText("발표 PDF 없이 자막 모드로 진행 중");
    await waitFor(() => expect(document.activeElement?.getAttribute("data-app-stage")).toBe("live"));
  });

  it("aborts an in-flight start on home reset and never resurrects a hidden session", async () => {
    mocks.prepareAwsVocabulary.mockImplementation((_terms: unknown, signal?: AbortSignal) => new Promise((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      void resolve;
    }));
    const user = await reachReadyScreen();

    await user.click(screen.getByRole("button", { name: "용어집 적용해 실시간 시작" }));
    await screen.findByText("검증된 전문용어를 AWS 사용자 지정 용어집으로 준비하고 있습니다.");
    await user.click(screen.getByRole("button", { name: "처음 화면으로 이동" }));

    await screen.findByRole("button", { name: /PDF를 여기에 놓아주세요/ });
    expect(mocks.discardSession).toHaveBeenCalledOnce();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("re-reads a stored glossary after pending stream cleanup so cross-tab deletion cannot resurrect it", async () => {
    const saved = saveAnalyzedGlossary(window.localStorage, demoAnalysis, "공유 용어집", {
      id: "shared-glossary",
      now: "2026-08-29T00:00:00.000Z"
    });
    const stopping = deferred<{ status: "completed"; reason: "server-ended"; message: string }>();
    mocks.stop.mockReturnValue(stopping.promise);
    const user = userEvent.setup();
    render(<App />);
    const glossaryLoadButton = (await screen.findByText(saved.name)).closest("button");
    expect(glossaryLoadButton).not.toBeNull();
    await user.click(glossaryLoadButton!);

    act(() => {
      deleteStoredGlossary(window.localStorage, saved.id);
      window.dispatchEvent(new StorageEvent("storage", { key: GLOSSARY_STORAGE_KEY }));
    });
    await act(async () => {
      stopping.resolve({ status: "completed", reason: "server-ended", message: "종료" });
      await stopping.promise;
    });

    await waitFor(() => expect(screen.queryByRole("heading", { name: /준비가 됐어요/ })).toBeNull());
    expect(screen.getByRole("button", { name: /PDF를 여기에 놓아주세요/ })).not.toBeNull();
  });

  it("applies another tab's update to a fresh analyzed glossary instead of claiming stale data is saved", async () => {
    await reachReadyScreen();
    const [saved] = listStoredGlossaries(window.localStorage);
    expect(saved).toBeDefined();

    act(() => {
      saveAnalyzedGlossary(window.localStorage, reviewAnalysis, "다른 탭에서 갱신", { id: saved!.id });
      window.dispatchEvent(new StorageEvent("storage", { key: GLOSSARY_STORAGE_KEY }));
    });

    expect(await screen.findByText("벡터 데이터베이스")).not.toBeNull();
    expect(screen.getByText("다른 탭에서 변경한 현재 용어집을 이 화면에도 반영했습니다.")).not.toBeNull();
    expect(screen.getByText("자동 분석·저장 완료")).not.toBeNull();
  });

  it("preserves browser modifier shortcuts while plain presentation shortcuts still work", () => {
    const stream = {
      ...mocks.stream,
      status: "ready" as const,
      statusMessage: "준비됨",
      start: mocks.start,
      stop: mocks.stop,
      discardSession: mocks.discardSession
    };
    render(
      <LiveScreen
        analysis={demoAnalysis}
        presentation={null}
        stream={stream as never}
        fontScale="normal"
        onFontScale={vi.fn()}
        highContrast={false}
        onHighContrast={vi.fn()}
        onFinish={vi.fn()}
      />
    );

    expect(screen.getByRole("region", { name: "현재 라이브 자막" })).not.toBeNull();
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    expect(screen.getByRole("region", { name: "현재 라이브 자막" })).not.toBeNull();
    fireEvent.keyDown(window, { key: "c", metaKey: true });
    expect(screen.getByRole("region", { name: "현재 라이브 자막" })).not.toBeNull();
    fireEvent.keyDown(window, { key: "c" });
    expect(screen.queryByRole("region", { name: "현재 라이브 자막" })).toBeNull();
  });

  it("scopes the user-controlled high contrast class to the live presentation stage", () => {
    const stream = {
      ...mocks.stream,
      status: "ready" as const,
      start: mocks.start,
      stop: mocks.stop,
      discardSession: mocks.discardSession
    };
    const { rerender } = render(
      <LiveScreen
        analysis={demoAnalysis}
        presentation={null}
        stream={stream as never}
        fontScale="normal"
        onFontScale={vi.fn()}
        highContrast
        onHighContrast={vi.fn()}
        onFinish={vi.fn()}
      />
    );
    expect(document.querySelector("main")?.classList.contains("contrast-more")).toBe(true);

    rerender(
      <LiveScreen
        analysis={demoAnalysis}
        presentation={null}
        stream={stream as never}
        fontScale="normal"
        onFontScale={vi.fn()}
        highContrast={false}
        onHighContrast={vi.fn()}
        onFinish={vi.fn()}
      />
    );
    expect(document.querySelector("main")?.classList.contains("contrast-more")).toBe(false);
  });

  it("keeps the unload warning after an unconfirmable download request until the user verifies the file", async () => {
    const line = {
      id: "line-export",
      text: "RAG를 설명합니다.",
      rawText: "RAG를 설명합니다.",
      termIds: ["rag"],
      corrections: []
    };
    mocks.stream.transcript = {
      completedChunks: [],
      activeChunk: [line as never],
      lineCount: 1,
      appendOperations: 1,
      structuralReferenceCopies: 0
    };
    mocks.stream.captionTail = [line as never];
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:result-export") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const user = await reachReadyScreen();

    await user.click(screen.getByRole("button", { name: "데모 자막으로 미리보기" }));
    await screen.findByText("발표 PDF 없이 자막 모드로 진행 중");
    await user.click(screen.getByRole("button", { name: "종료" }));
    await screen.findByRole("heading", { name: "강연 자막 결과" });

    const beforeDownload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(beforeDownload);
    expect(beforeDownload.defaultPrevented).toBe(true);

    await user.click(screen.getByRole("button", { name: "결과 JSON 저장" }));
    await screen.findByText(/다운로드 목록에서 파일이 생성됐는지 확인하기 전까지/);
    const afterRequest = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(afterRequest);
    expect(afterRequest.defaultPrevented).toBe(true);

    await user.click(screen.getByRole("button", { name: "다운로드 파일 생성 확인" }));
    await screen.findByText(/파일 생성을 확인했습니다/);
    const afterConfirmation = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(afterConfirmation);
    expect(afterConfirmation.defaultPrevented).toBe(false);
  });

  it("updates the same saved glossary only after explicitly applying review exclusions", async () => {
    mocks.getDemo.mockResolvedValue(reviewAnalysis);
    const user = await reachReadyScreen();
    const [before] = listStoredGlossaries(window.localStorage);
    expect(before.terms.map((term) => term.id)).toEqual(["rag", "vector-database"]);

    await user.click(screen.getByRole("button", { name: "RAG 제외하기" }));
    expect(listStoredGlossaries(window.localStorage)[0].terms).toHaveLength(2);
    expect(screen.getByText("기본적으로 이번 강연에만 적용됩니다.", { exact: false })).not.toBeNull();

    vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "제외 1개를 저장본에 반영" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "제외 1개를 저장본에 반영" })).toBeNull());
    const [after] = listStoredGlossaries(window.localStorage);
    expect(after.id).toBe(before.id);
    expect(after.terms.map((term) => term.id)).toEqual(["vector-database"]);
    expect(after.phraseSet).toEqual(["벡터 데이터베이스", "Vector Database", "벡터 디비"]);
    expect(screen.queryByRole("button", { name: "RAG 제외하기" })).toBeNull();
  });

  it("keeps review exclusions selected when saving the reviewed glossary fails", async () => {
    mocks.getDemo.mockResolvedValue(reviewAnalysis);
    const user = await reachReadyScreen();
    const rawBefore = window.localStorage.getItem(GLOSSARY_STORAGE_KEY);

    await user.click(screen.getByRole("button", { name: "RAG 제외하기" }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("storage full", "QuotaExceededError");
    });
    await user.click(screen.getByRole("button", { name: "제외 1개를 저장본에 반영" }));

    await screen.findByText("브라우저 저장 공간이 부족합니다. 저장된 용어집을 삭제한 뒤 다시 시도해 주세요.");
    expect(screen.getByRole("button", { name: "RAG 다시 포함" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "제외 1개를 저장본에 반영" })).not.toBeNull();
    expect(window.localStorage.getItem(GLOSSARY_STORAGE_KEY)).toBe(rawBefore);
  });

  it("does not persist review changes while a lecture start is in progress", async () => {
    mocks.getDemo.mockResolvedValue(reviewAnalysis);
    const vocabulary = deferred<{ vocabularyName: string; hash: string; reused: boolean }>();
    mocks.prepareAwsVocabulary.mockReturnValue(vocabulary.promise);
    const user = await reachReadyScreen();
    await user.click(screen.getByRole("button", { name: "RAG 제외하기" }));
    const rawBefore = window.localStorage.getItem(GLOSSARY_STORAGE_KEY);

    await user.click(screen.getByRole("button", { name: "용어집 적용해 실시간 시작" }));
    await screen.findByText("검증된 전문용어를 AWS 사용자 지정 용어집으로 준비하고 있습니다.");
    const persistButton = screen.getByRole("button", { name: "제외 1개를 저장본에 반영" }) as HTMLButtonElement;
    expect(persistButton.disabled).toBe(true);
    fireEvent.click(persistButton);
    expect(window.localStorage.getItem(GLOSSARY_STORAGE_KEY)).toBe(rawBefore);

    await act(async () => {
      vocabulary.resolve({
        vocabularyName: "lecture-ko-0123456789abcdef",
        hash: "0".repeat(64),
        reused: false
      });
      await vocabulary.promise;
    });
    await screen.findByText("발표 PDF 없이 자막 모드로 진행 중");
    expect(listStoredGlossaries(window.localStorage)[0].terms).toHaveLength(2);
  });

  it("starts basic AWS captions without preparing a custom vocabulary when the service is unavailable", async () => {
    mocks.getHealth.mockResolvedValue({
      ok: true,
      sttProvider: "aws",
      services: {
        speech: { configured: true, verification: "unverified" },
        gemini: true,
        customVocabulary: { configured: false, verification: "unverified" }
      }
    });
    const user = await reachReadyScreen();

    await user.click(screen.getByRole("button", { name: "기본 AWS 자막으로 시작" }));

    await screen.findByText("발표 PDF 없이 자막 모드로 진행 중");
    expect(mocks.prepareAwsVocabulary).not.toHaveBeenCalled();
    expect(mocks.start).toHaveBeenCalledWith("live", undefined);
  });

  it("locks every presentation mutation during lecture start without reporting PDF loading", () => {
    const onSelect = vi.fn();
    const onUseAnalysisFile = vi.fn();
    const onClear = vi.fn();
    const file = new File(["pdf"], "slides.pdf", { type: "application/pdf" });
    const { container, rerender } = render(
      <PresentationUploadCard
        presentation={null}
        busy={false}
        disabled
        error=""
        analysisFileAvailable
        onSelect={onSelect}
        onUseAnalysisFile={onUseAnalysisFile}
        onClear={onClear}
      />
    );

    const section = container.querySelector(".presentation-upload")!;
    expect(section.getAttribute("aria-busy")).toBe("false");
    expect(section.getAttribute("data-disabled")).toBe("true");
    expect(screen.queryByText("발표 PDF 확인 중")).toBeNull();
    const picker = screen.getByRole("button", { name: "발표 PDF 선택" }) as HTMLButtonElement;
    const input = screen.getByLabelText("발표 PDF 파일 선택") as HTMLInputElement;
    expect(picker.disabled).toBe(true);
    expect(input.disabled).toBe(true);
    fireEvent.drop(picker, { dataTransfer: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "분석한 PDF를 발표에 사용" }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(onUseAnalysisFile).not.toHaveBeenCalled();

    const presentation = {
      id: "presentation-locked",
      name: "slides.pdf",
      file,
      objectUrl: "blob:presentation-locked",
      pageCount: 2
    } satisfies PresentationAsset;
    rerender(
      <PresentationUploadCard
        presentation={presentation}
        busy={false}
        disabled
        error=""
        analysisFileAvailable
        onSelect={onSelect}
        onUseAnalysisFile={onUseAnalysisFile}
        onClear={onClear}
      />
    );
    const replaceButton = screen.getByRole("button", { name: "교체" }) as HTMLButtonElement;
    const clearButton = screen.getByRole("button", { name: "제거" }) as HTMLButtonElement;
    expect(replaceButton.disabled).toBe(true);
    expect(clearButton.disabled).toBe(true);
    fireEvent.click(replaceButton);
    fireEvent.click(clearButton);
    expect(onClear).not.toHaveBeenCalled();
  });

  it("remounts the polite announcement for consecutive final captions with identical text", () => {
    const line = {
      id: "final-1",
      text: "같은 확정 문장",
      rawText: "같은 확정 문장",
      termIds: [],
      corrections: []
    };
    const { rerender } = render(
      <LiveCaptionRows
        presentation={{ historyLines: [], rows: [{ kind: "final", line }] }}
        terms={[]}
        sizeClass={LIVE_CAPTION_SIZE_CLASS.normal}
        finalAnnouncement={{ id: line.id, text: line.text }}
      />
    );
    const firstAnnouncement = screen.getByRole("status");

    const nextLine = { ...line, id: "final-2" };
    rerender(
      <LiveCaptionRows
        presentation={{ historyLines: [], rows: [{ kind: "final", line: nextLine }] }}
        terms={[]}
        sizeClass={LIVE_CAPTION_SIZE_CLASS.normal}
        finalAnnouncement={{ id: nextLine.id, text: nextLine.text }}
      />
    );

    const nextAnnouncement = screen.getByRole("status");
    expect(nextAnnouncement).not.toBe(firstAnnouncement);
    expect(nextAnnouncement.dataset.captionAnnouncementId).toBe("final-2");
    expect(nextAnnouncement.textContent).toBe("같은 확정 문장");
    expect(screen.getAllByTestId("live-caption-current")).toHaveLength(1);
    expect(screen.queryAllByTestId("live-caption-previous")).toHaveLength(0);
  });
});
