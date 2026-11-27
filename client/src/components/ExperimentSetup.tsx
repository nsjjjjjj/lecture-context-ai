import { useMemo, useState } from "react";
import { Check, Database, FilePlus2, LoaderCircle, Plus } from "lucide-react";
import {
  createExperimentCase,
  createExperimentStudy,
  type ExperimentStudy,
  type ExperimentTargetInput
} from "../lib/api";
import type { StoredGlossary } from "../lib/glossary-storage";

const INPUT_FOCUS_RING = "outline-none focus-visible:border-cyan-300 focus-visible:ring-2 focus-visible:ring-cyan-300/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#07111f]";

export type ExperimentSetupProps = {
  glossaries: StoredGlossary[];
  studies: ExperimentStudy[];
  loading: boolean;
  error: string;
  onChanged: () => Promise<void>;
  onContinue: () => void;
};

function normalized(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("ko-KR");
}

export function parseManualTargetTerms(value: string): ExperimentTargetInput[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [canonicalTerm = "", english = "", aliases = ""] = line.split("|").map((part) => part.trim());
    if (!canonicalTerm) throw new Error("수동 채점 용어의 정식 표기가 비어 있습니다.");
    return {
      canonicalTerm,
      english,
      spokenAliases: aliases.split(",").map((alias) => alias.trim()).filter(Boolean)
    };
  });
}

function targetKey(target: ExperimentTargetInput): string {
  return normalized(target.canonicalTerm);
}

export function ExperimentSetup({ glossaries, studies, loading, error, onChanged, onContinue }: ExperimentSetupProps) {
  const [studyId, setStudyId] = useState(studies[0]?.id ?? "");
  const [newStudyTitle, setNewStudyTitle] = useState("");
  const [glossaryId, setGlossaryId] = useState(glossaries[0]?.id ?? "");
  const [caseTitle, setCaseTitle] = useState("");
  const [scriptText, setScriptText] = useState("");
  const [selectedTermIds, setSelectedTermIds] = useState<Set<string>>(new Set());
  const [manualTargets, setManualTargets] = useState("");
  const [busyAction, setBusyAction] = useState<"study" | "case" | null>(null);
  const [message, setMessage] = useState("");
  const [localError, setLocalError] = useState("");
  const busy = busyAction !== null;

  const selectedStudy = studies.find((study) => study.id === studyId) ?? studies[0] ?? null;
  const selectedGlossary = glossaries.find((glossary) => glossary.id === glossaryId) ?? glossaries[0] ?? null;
  const targetTerms = useMemo(() => {
    if (!selectedGlossary) return [];
    const fromGlossary = selectedGlossary.terms
      .filter((term) => selectedTermIds.has(term.id))
      .map((term): ExperimentTargetInput => ({
        canonicalTerm: term.term,
        english: term.english,
        spokenAliases: term.spokenAliases
      }));
    try {
      const manual = parseManualTargetTerms(manualTargets);
      const seen = new Set(fromGlossary.map(targetKey));
      return [...fromGlossary, ...manual.filter((term) => {
        const key = targetKey(term);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })];
    } catch {
      return fromGlossary;
    }
  }, [manualTargets, selectedGlossary, selectedTermIds]);

  const autoSelectTerms = () => {
    if (!selectedGlossary || !scriptText.trim()) return;
    const haystack = normalized(scriptText);
    setSelectedTermIds(new Set(selectedGlossary.terms.filter((term) =>
      [term.term, term.english, ...term.spokenAliases].some((form) => form && haystack.includes(normalized(form)))
    ).map((term) => term.id)));
  };

  const createStudy = async () => {
    if (!newStudyTitle.trim() || busy) return;
    setBusyAction("study");
    setLocalError("");
    try {
      const { study } = await createExperimentStudy(newStudyTitle.trim());
      await onChanged();
      setStudyId(study.id);
      setNewStudyTitle("");
      setMessage(`실험 세트 “${study.title}”를 만들었습니다.`);
    } catch (caught) {
      setLocalError(caught instanceof Error ? caught.message : "실험 세트를 만들지 못했습니다.");
    } finally {
      setBusyAction(null);
    }
  };

  const createCase = async () => {
    if (!selectedStudy || !selectedGlossary || busy) return;
    setBusyAction("case");
    setLocalError("");
    setMessage("");
    try {
      const parsedManual = parseManualTargetTerms(manualTargets);
      const selected = selectedGlossary.terms.filter((term) => selectedTermIds.has(term.id)).map((term) => ({
        canonicalTerm: term.term,
        english: term.english,
        spokenAliases: term.spokenAliases
      }));
      const seen = new Set(selected.map(targetKey));
      const merged = [...selected, ...parsedManual.filter((term) => {
        const key = targetKey(term);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })];
      if (merged.length === 0) throw new Error("채점할 전문용어를 하나 이상 선택해 주세요.");
      const { experimentCase } = await createExperimentCase(selectedStudy.id, {
        title: caseTitle.trim() || `${selectedGlossary.name} 실험`,
        scriptText,
        glossary: selectedGlossary,
        targetTerms: merged
      });
      await onChanged();
      setMessage(`케이스 “${experimentCase.title}”를 저장했습니다. 이제 녹음 단계에서 이 대본을 선택하세요.`);
      setCaseTitle("");
      setScriptText("");
      setSelectedTermIds(new Set());
      setManualTargets("");
    } catch (caught) {
      setLocalError(caught instanceof Error ? caught.message : "실험 케이스를 만들지 못했습니다.");
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="space-y-5">
      <section className="rounded-[1.6rem] border border-amber-300/15 bg-[#0b1727]/95 p-5 shadow-xl shadow-black/20 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-extrabold text-white"><Database className="size-4 text-amber-300" /> 실험 세트</h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">5개 PDF·대본을 한 연구 묶음 아래 서로 다른 immutable 케이스로 저장합니다.</p>
          </div>
          <span className="rounded-full bg-white/[0.06] px-2.5 py-1 text-[10px] font-black text-slate-400">{studies.length}개 세트</span>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]">
          <label className="sr-only" htmlFor="experiment-study-title">새 실험 세트 이름</label>
          <input id="experiment-study-title" name="experimentStudyTitle" value={newStudyTitle} onChange={(event) => setNewStudyTitle(event.target.value)} placeholder="예: PDF 문맥 STT 실험 v1" autoComplete="off" className={`h-11 rounded-xl border border-white/10 bg-[#07111f] px-3 text-xs text-white ${INPUT_FOCUS_RING}`} />
          <button type="button" onClick={() => void createStudy()} disabled={busy || !newStudyTitle.trim()} aria-busy={busyAction === "study"} className="secondary-button !min-h-11 text-xs disabled:opacity-40">{busyAction === "study" ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : <Plus className="size-4" />} 새 세트</button>
        </div>
        {studies.length > 0 && <label htmlFor="experiment-study-select" className="mt-3 block text-[11px] font-bold text-slate-500">작업할 실험 세트
          <select id="experiment-study-select" name="experimentStudyId" value={selectedStudy?.id ?? ""} onChange={(event) => setStudyId(event.target.value)} className={`mt-1.5 h-11 w-full rounded-xl border border-white/10 bg-[#07111f] px-3 text-xs text-white ${INPUT_FOCUS_RING}`}>
            {studies.map((study) => <option key={study.id} value={study.id}>{study.title} · 케이스 {study.cases.length}개</option>)}
          </select>
        </label>}
      </section>

      <section className="rounded-[1.6rem] border border-white/[0.08] bg-[#0b1727]/95 p-5 shadow-xl shadow-black/20 sm:p-6">
        <h2 className="flex items-center gap-2 text-sm font-extrabold text-white"><FilePlus2 className="size-4 text-cyan-300" /> PDF·대본 케이스 만들기</h2>
        <p className="mt-1 text-xs leading-5 text-slate-500">Gemini를 다시 호출하지 않습니다. 브라우저에 저장된 용어집을 PDF 적응 스냅샷으로 복사합니다.</p>

        {!selectedStudy ? <div className="mt-4 rounded-xl bg-amber-300/10 p-3 text-xs text-amber-100">먼저 위에서 실험 세트를 만드세요.</div> : !selectedGlossary ? <div className="mt-4 rounded-xl bg-amber-300/10 p-3 text-xs text-amber-100">강연 화면에서 PDF를 분석해 브라우저 용어집을 먼저 저장하세요.</div> : <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label htmlFor="experiment-glossary-select" className="text-[11px] font-bold text-slate-500">저장된 PDF 용어집
              <select id="experiment-glossary-select" name="experimentGlossaryId" value={selectedGlossary.id} onChange={(event) => { setGlossaryId(event.target.value); setSelectedTermIds(new Set()); }} className={`mt-1.5 h-11 w-full rounded-xl border border-white/10 bg-[#07111f] px-3 text-xs text-white ${INPUT_FOCUS_RING}`}>
                {glossaries.map((glossary) => <option key={glossary.id} value={glossary.id}>{glossary.name} · {glossary.terms.length}개</option>)}
              </select>
            </label>
            <label htmlFor="experiment-case-title" className="text-[11px] font-bold text-slate-500">케이스 이름
              <input id="experiment-case-title" name="experimentCaseTitle" value={caseTitle} onChange={(event) => setCaseTitle(event.target.value)} placeholder="예: 생성형 AI 발표 01" autoComplete="off" className={`mt-1.5 h-11 w-full rounded-xl border border-white/10 bg-[#07111f] px-3 text-xs text-white ${INPUT_FOCUS_RING}`} />
            </label>
          </div>
          <label htmlFor="experiment-script-text" className="mt-3 block text-[11px] font-bold text-slate-500">실제로 그대로 읽을 전체 대본
            <textarea id="experiment-script-text" name="experimentScriptText" value={scriptText} onChange={(event) => setScriptText(event.target.value)} rows={8} placeholder="정답으로 사용할 발표 대본을 붙여넣으세요." className={`mt-1.5 w-full rounded-xl border border-white/10 bg-[#07111f] p-3 text-xs leading-6 text-white ${INPUT_FOCUS_RING}`} />
          </label>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <div className="text-[11px] font-black text-slate-400">채점 용어 선택 · {selectedTermIds.size}개</div>
            <button type="button" onClick={autoSelectTerms} disabled={!scriptText.trim()} className="secondary-button !min-h-9 text-[11px] disabled:opacity-40">대본에서 자동 선택</button>
          </div>
          <div className="mt-2 grid max-h-52 gap-2 overflow-y-auto rounded-2xl border border-white/[0.07] bg-[#07111f]/70 p-3 sm:grid-cols-2">
            {selectedGlossary.terms.map((term) => <label key={term.id} className="flex items-start gap-2 rounded-xl bg-white/[0.025] p-2 text-xs text-slate-300">
              <input type="checkbox" name="experimentTargetTermIds" value={term.id} checked={selectedTermIds.has(term.id)} onChange={(event) => setSelectedTermIds((current) => {
                const next = new Set(current);
                if (event.target.checked) next.add(term.id); else next.delete(term.id);
                return next;
              })} className="mt-0.5 size-4 accent-cyan-300 focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#07111f]" />
              <span><strong className="text-white">{term.term}</strong>{term.spokenAliases.length ? <span className="block text-[10px] text-slate-500">발음: {term.spokenAliases.join(", ")}</span> : null}</span>
            </label>)}
          </div>
          <label htmlFor="experiment-manual-targets" className="mt-3 block text-[11px] font-bold text-slate-500">PDF에 없지만 채점할 용어 <span className="font-normal">(선택)</span>
            <textarea id="experiment-manual-targets" name="experimentManualTargets" value={manualTargets} onChange={(event) => setManualTargets(event.target.value)} rows={3} placeholder={"한 줄에 하나: RAG | Retrieval-Augmented Generation | 래그,레그"} className={`mt-1.5 w-full rounded-xl border border-white/10 bg-[#07111f] p-3 text-xs leading-5 text-white ${INPUT_FOCUS_RING}`} />
          </label>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => void createCase()} disabled={busy || !scriptText.trim() || targetTerms.length === 0} aria-busy={busyAction === "case"} className="primary-button !min-h-10 text-xs disabled:opacity-40">{busyAction === "case" ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : <FilePlus2 className="size-4" />} 케이스 스냅샷 저장</button>
            <span className="text-[11px] text-slate-500">PDF 적응 {selectedGlossary.terms.length}개 · 채점 후보 {targetTerms.length}개</span>
          </div>
        </>}

        {(localError || error) && <div role="alert" className="mt-4 whitespace-pre-line rounded-xl border border-rose-400/20 bg-rose-400/10 p-3 text-xs leading-5 text-rose-100">{localError || error}</div>}
        {message && <div role="status" className="mt-4 flex items-start gap-2 rounded-xl border border-emerald-300/15 bg-emerald-300/[0.06] p-3 text-xs text-emerald-100"><Check className="mt-0.5 size-4" /> {message}</div>}
        {busyAction && <div role="status" className="sr-only">{busyAction === "study" ? "새 실험 세트를 저장하는 중입니다." : "실험 케이스를 저장하는 중입니다."}</div>}
        {loading && <div role="status" className="mt-3 flex items-center gap-2 text-xs text-slate-500"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> 저장 목록 갱신 중</div>}
      </section>

      {selectedStudy?.cases.length ? <section className="rounded-[1.6rem] border border-white/[0.08] bg-[#0b1727]/95 p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-extrabold text-white">{selectedStudy.title} 케이스</h2><button type="button" onClick={onContinue} className="secondary-button !min-h-9 text-[11px]">녹음으로 이동</button></div>
        <div className="mt-3 space-y-2">{selectedStudy.cases.map((item, index) => <div key={item.id} className="rounded-xl border border-white/[0.06] bg-white/[0.025] p-3">
          <div className="flex items-center justify-between gap-3 text-xs"><strong className="text-white">{index + 1}. {item.title}</strong><span className="text-slate-500">정답 {item.script.targetTerms.length} · PDF {item.script.adaptationTerms?.length ?? 0}</span></div>
          <div className="mt-1 truncate font-mono text-[10px] text-slate-600">{item.snapshotId} · {item.snapshotHash.slice(0, 12)}</div>
        </div>)}</div>
      </section> : null}
    </div>
  );
}
