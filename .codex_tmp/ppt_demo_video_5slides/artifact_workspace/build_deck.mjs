import fs from "node:fs/promises";
import path from "node:path";
import { Presentation, PresentationFile } from "@oai/artifact-tool";

const OUT_DIR = "/Users/nohsungbeen/dev/project/2026-2-ABC-hackathon/.codex_tmp/ppt_demo_video_5slides/artifact_output";
const FINAL_PPTX = "/Users/nohsungbeen/dev/project/2026-2-ABC-hackathon/deliverables/ABC_해커톤_시연영상_PPT_5장.pptx";
const READY_SCREEN = "/Users/nohsungbeen/.codex/visualizations/2026/08/09/019fe57b-515a-7290-995f-d78bf1bca77b/lecture-context-ready.png";
const PAPER = "/Users/nohsungbeen/Desktop/ABC 해커톤 제출물/ABC_해커톤_논문_참고문헌_정리본.docx";
const README = "/Users/nohsungbeen/dev/project/2026-2-ABC-hackathon/README.md";

const W = 1280;
const H = 720;
const FONT = "Apple SD Gothic Neo";
const C = {
  white: "#FFFFFF",
  soft: "#F3F5F7",
  inkDeep: "#0A1317",
  ink: "#1C1E21",
  slate: "#5D6C7B",
  muted: "#8A98A6",
  hair: "#D8DEE4",
  cobalt: "#0064E0",
  cobaltSoft: "#EAF3FF",
  dark: "#07111F",
  dark2: "#0B1624",
  chartA: "#B8C1CA",
  chartB: "#718494",
  chartC: "#0064E0",
};

async function bytes(filePath) {
  const buffer = await fs.readFile(filePath);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function addShape(slide, geometry, position, fill, line = { style: "solid", fill: "none", width: 0 }, name) {
  return slide.shapes.add({ geometry, position, fill, line, ...(name ? { name } : {}) });
}

function addText(slide, text, position, style = {}, name) {
  const shape = addShape(slide, "textbox", position, "none", { style: "solid", fill: "none", width: 0 }, name);
  shape.text = text;
  shape.text.style = {
    typeface: FONT,
    color: C.ink,
    fontSize: 20,
    alignment: "left",
    verticalAlignment: "top",
    autoFit: "shrinkText",
    insets: { top: 0, right: 0, bottom: 0, left: 0 },
    ...style,
  };
  return shape;
}

function addEyebrow(slide, text, x = 64, y = 54, w = 400) {
  return addText(slide, text, { left: x, top: y, width: w, height: 24 }, {
    fontSize: 14,
    bold: true,
    color: C.cobalt,
    lineSpacing: 1,
  });
}

function addSlideNumber(slide, value) {
  addText(slide, value, { left: 64, top: 682, width: 50, height: 22 }, {
    fontSize: 13,
    bold: true,
    color: C.muted,
  });
}

function addRule(slide, x, y, width, color = C.hair, height = 2) {
  return addShape(slide, "rect", { left: x, top: y, width, height }, color);
}

function addCircleNumber(slide, number, cx, cy, fill = C.white, lineFill = C.cobalt, textColor = C.cobalt, size = 42) {
  addShape(slide, "ellipse", { left: cx - size / 2, top: cy - size / 2, width: size, height: size }, fill, {
    style: "solid",
    fill: lineFill,
    width: 2,
  });
  addText(slide, String(number), { left: cx - size / 2, top: cy - 13, width: size, height: 28 }, {
    fontSize: 16,
    bold: true,
    color: textColor,
    alignment: "center",
    verticalAlignment: "middle",
  });
}

function setNotes(slide, lines, sources) {
  const notes = [
    ...lines,
    "",
    "[Sources]",
    ...sources.map((source) => `- ${source}`),
    "[/Sources]",
  ].join("\n");
  slide.speakerNotes.textFrame.setText(notes);
  slide.speakerNotes.setVisible(true);
}

function addNodeLabel(slide, x, y, number, title, detail) {
  addCircleNumber(slide, number, x + 75, y, C.white, C.cobalt, C.cobalt, 42);
  addText(slide, title, { left: x, top: y + 36, width: 150, height: 28 }, {
    fontSize: 19,
    bold: true,
    color: C.inkDeep,
    alignment: "center",
  });
  addText(slide, detail, { left: x, top: y + 66, width: 150, height: 34 }, {
    fontSize: 14,
    color: C.slate,
    alignment: "center",
  });
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.mkdir(path.dirname(FINAL_PPTX), { recursive: true });
  const readyBytes = await bytes(READY_SCREEN);

  const presentation = Presentation.create({ slideSize: { width: W, height: H } });

  // Slide 1 — problem / title
  {
    const slide = presentation.slides.add();
    slide.background.fill = C.white;
    addEyebrow(slide, "LECTURE CONTEXT AI · 2026 ABC HACKATHON");
    addText(slide, "전문용어를 놓치면,\n맥락도 놓칩니다.", { left: 64, top: 150, width: 490, height: 150 }, {
      fontSize: 52,
      bold: true,
      color: C.inkDeep,
      lineSpacing: 0.95,
    }, "title-slide-headline");
    addText(slide, "발표자료 기반 실시간 전문용어 자막", { left: 64, top: 326, width: 500, height: 36 }, {
      fontSize: 24,
      bold: true,
      color: C.cobalt,
    });
    addText(slide, "비전공자가 겪는 표현의 장벽과 지식의 장벽을\n하나의 강연별 용어집으로 함께 낮춥니다.", { left: 64, top: 382, width: 490, height: 72 }, {
      fontSize: 20,
      color: C.slate,
      lineSpacing: 1.25,
    });

    addShape(slide, "roundRect", { left: 603, top: 145, width: 628, height: 354 }, C.cobaltSoft, {
      style: "solid",
      fill: C.cobaltSoft,
      width: 0,
    }).borderRadius = 28;
    slide.images.add({
      blob: readyBytes,
      contentType: "image/jpeg",
      alt: "PDF 분석을 마치고 추출한 전문용어를 보여주는 강연맥락 AI 준비 화면",
      fit: "cover",
      geometry: "roundRect",
      borderRadius: 24,
      position: { left: 585, top: 127, width: 628, height: 354 },
    });

    addRule(slide, 64, 561, 1148, C.hair, 1);
    const bottom = [
      [64, "01", "저빈도 전문용어 인식"],
      [420, "02", "한국어식 발음 연결"],
      [786, "03", "쉬운 설명 제공"],
    ];
    for (const [x, no, label] of bottom) {
      addText(slide, no, { left: x, top: 586, width: 34, height: 24 }, { fontSize: 13, bold: true, color: C.cobalt });
      addText(slide, label, { left: x + 42, top: 581, width: 280, height: 34 }, { fontSize: 18, bold: true, color: C.ink });
    }
    addText(slide, "PDF 문맥 → STT 적응 → 의미 보조", { left: 64, top: 655, width: 430, height: 26 }, {
      fontSize: 15,
      bold: true,
      color: C.slate,
    });
    setNotes(slide, [
      "[Timing] 0:00–0:40",
      "[Narration] 안녕하세요. 이 프로젝트는 발표자료의 문맥을 활용해 전문용어 인식을 보조하고, 어려운 용어의 의미를 함께 제공하는 실시간 자막 시스템입니다.",
      "[Narration] 포용적 AI라는 주제에서 출발해, 비전공자가 강의나 발표를 들을 때 전문용어 때문에 내용을 놓치는 문제를 줄이고자 구현했습니다.",
      "[Video] 0:40부터 서비스 화면으로 전환한다. PDF 업로드 → 분석 → 용어집과 PhraseSet 확인 → 실시간 자막 시작을 2:50까지 보여준다. 분석 대기 구간은 2–3초로 편집한다.",
    ], [
      `${PAPER} — 서론, 시스템 목표, 실험 요약`,
      `${README} — 현재 서비스 기능과 데이터 처리 범위`,
      `${READY_SCREEN} — 실제 제품 준비 화면 캡처`,
    ]);
  }

  // Slide 2 — pipeline
  {
    const slide = presentation.slides.add();
    slide.background.fill = C.white;
    addEyebrow(slide, "SYSTEM PIPELINE · 2:50–4:00");
    addText(slide, "발표자료의 문맥이 실시간 자막까지 이어집니다", { left: 64, top: 84, width: 1152, height: 58 }, {
      fontSize: 40,
      bold: true,
      color: C.inkDeep,
    });
    addText(slide, "하나의 검증된 용어집을 STT 인식 힌트와 청중용 설명에 함께 사용", { left: 64, top: 148, width: 1152, height: 30 }, {
      fontSize: 19,
      color: C.slate,
    });

    // Connectors are created before nodes so every arrow stays behind labels.
    addText(slide, "강연 전 · PREP", { left: 64, top: 206, width: 180, height: 24 }, { fontSize: 14, bold: true, color: C.cobalt });
    addRule(slide, 180, 336, 810, "#C7D2DE", 3);
    for (const x of [298, 568, 838]) {
      addText(slide, "›", { left: x, top: 316, width: 36, height: 42 }, { fontSize: 30, bold: true, color: C.cobalt, alignment: "center" });
    }
    addRule(slide, 989, 357, 3, C.cobalt, 116);
    addText(slide, "↓", { left: 972, top: 442, width: 36, height: 36 }, { fontSize: 22, bold: true, color: C.cobalt, alignment: "center" });

    addText(slide, "강연 중 · LIVE", { left: 64, top: 460, width: 180, height: 24 }, { fontSize: 14, bold: true, color: C.cobalt });
    addRule(slide, 270, 500, 720, "#C7D2DE", 3);
    for (const x of [435, 795]) {
      addText(slide, "‹", { left: x, top: 480, width: 36, height: 42 }, { fontSize: 30, bold: true, color: C.cobalt, alignment: "center" });
    }

    const prepNodes = [
      { cx: 180, no: 1, title: "PDF.js", detail: "페이지별 텍스트 추출" },
      { cx: 450, no: 2, title: "Gemini", detail: "전문용어 후보 생성" },
      { cx: 720, no: 3, title: "서버 검증", detail: "원문 대조 · 별칭 검사" },
      { cx: 990, no: 4, title: "검증 결과", detail: "terms[] + phraseSet[]" },
    ];
    for (const node of prepNodes) {
      addText(slide, node.title, { left: node.cx - 100, top: 244, width: 200, height: 30 }, { fontSize: 20, bold: true, color: C.inkDeep, alignment: "center" });
      addText(slide, node.detail, { left: node.cx - 110, top: 279, width: 220, height: 26 }, { fontSize: 15, color: C.slate, alignment: "center" });
      addCircleNumber(slide, node.no, node.cx, 336, C.white, C.cobalt, C.cobalt, 44);
    }

    const liveNodes = [
      { cx: 990, no: 5, title: "WS 세션 시작", detail: "용어 데이터 + 16 kHz PCM" },
      { cx: 630, no: 6, title: "Google STT", detail: "SpeechAdaptation 적용" },
      { cx: 270, no: 7, title: "자막 + 설명", detail: "확정 결과에서 용어 연결" },
    ];
    for (const node of liveNodes) {
      addCircleNumber(slide, node.no, node.cx, 500, C.white, C.cobalt, C.cobalt, 44);
      addText(slide, node.title, { left: node.cx - 115, top: 536, width: 230, height: 30 }, { fontSize: 20, bold: true, color: C.inkDeep, alignment: "center" });
      addText(slide, node.detail, { left: node.cx - 125, top: 571, width: 250, height: 28 }, { fontSize: 15, color: C.slate, alignment: "center" });
    }

    addSlideNumber(slide, "02");
    setNotes(slide, [
      "[Timing] 2:50–4:00",
      "[Narration] 전체 파이프라인은 발표자료 분석과 실시간 자막 처리로 구분됩니다. PDF.js로 발표자료의 텍스트를 추출하고 Gemini API로 전문용어 후보를 생성합니다.",
      "[Narration] 서버에서 후보와 발음 별칭을 검증한 뒤 강연별 PhraseSet을 직접 구성하고, Google Speech-to-Text의 SpeechAdaptation에 명시적으로 적용합니다.",
      "[Narration] PhraseSet은 STT가 자동으로 만들어 주는 기능이 아니라, 검증한 강연 문맥을 개발자가 직접 구성해 인식 요청에 넣는 데이터입니다.",
    ], [
      `${PAPER} — 2.1 전체 파이프라인, 2.2 PDF 용어집 검증, 2.3 PhraseSet 적용`,
      `${README} — PDF.js, Gemini, Google STT V2, WebSocket 구현`,
    ]);
  }

  // Slide 3 — interim/final/term flow
  {
    const slide = presentation.slides.add();
    slide.background.fill = C.white;
    addEyebrow(slide, "CORE BEHAVIOR · 4:00–5:00");
    addText(slide, "빠르게 보여주고, 확정된 순간에만 연결합니다", { left: 64, top: 84, width: 1152, height: 58 }, {
      fontSize: 40,
      bold: true,
      color: C.inkDeep,
    });
    addText(slide, "실시간성은 유지하고, 자동 정정의 근거는 숨기지 않습니다", { left: 64, top: 148, width: 1152, height: 30 }, {
      fontSize: 19,
      color: C.slate,
    });

    addRule(slide, 113, 214, 3, C.hair, 402);
    for (const y of [236, 382, 536]) {
      addShape(slide, "ellipse", { left: 96, top: y - 17, width: 36, height: 36 }, C.white, { style: "solid", fill: C.cobalt, width: 2 });
    }
    addText(slide, "1", { left: 96, top: 226, width: 36, height: 24 }, { fontSize: 15, bold: true, color: C.cobalt, alignment: "center" });
    addText(slide, "2", { left: 96, top: 372, width: 36, height: 24 }, { fontSize: 15, bold: true, color: C.cobalt, alignment: "center" });
    addText(slide, "3", { left: 96, top: 526, width: 36, height: 24 }, { fontSize: 15, bold: true, color: C.cobalt, alignment: "center" });

    addText(slide, "발화 중 · INTERIM", { left: 162, top: 203, width: 240, height: 24 }, { fontSize: 14, bold: true, color: C.cobalt });
    addText(slide, "임시 자막은 STT 원문 그대로", { left: 162, top: 232, width: 980, height: 32 }, { fontSize: 24, bold: true, color: C.inkDeep });
    addShape(slide, "roundRect", { left: 162, top: 278, width: 1054, height: 52 }, C.soft, { style: "solid", fill: C.soft, width: 0 }).borderRadius = 14;
    addText(slide, "래그는 외부 문서를 검색해서 답변의 근거를 보강합니다…", { left: 182, top: 291, width: 1014, height: 28 }, { fontSize: 20, color: C.slate });

    addText(slide, "문장 확정 · FINAL", { left: 162, top: 349, width: 240, height: 24 }, { fontSize: 14, bold: true, color: C.cobalt });
    addText(slide, "검증된 발음 별칭만 정식 용어와 연결", { left: 162, top: 378, width: 980, height: 32 }, { fontSize: 24, bold: true, color: C.inkDeep });
    addText(slide, "RAG", { left: 162, top: 424, width: 78, height: 38 }, { fontSize: 28, bold: true, color: C.cobalt });
    addText(slide, "(래그) 는 외부 문서를 검색해서 답변의 근거를 보강합니다.", { left: 242, top: 429, width: 934, height: 32 }, { fontSize: 20, color: C.ink });
    addText(slide, "원래 STT 표기를 함께 남겨 정정 근거를 확인", { left: 162, top: 466, width: 900, height: 24 }, { fontSize: 14, bold: true, color: C.slate });

    addText(slide, "용어 감지 · CONTEXT", { left: 162, top: 503, width: 250, height: 24 }, { fontSize: 14, bold: true, color: C.cobalt });
    addText(slide, "설명 피드에 자동으로 추가", { left: 162, top: 532, width: 900, height: 32 }, { fontSize: 24, bold: true, color: C.inkDeep });
    addShape(slide, "roundRect", { left: 162, top: 580, width: 1054, height: 72 }, C.cobaltSoft, { style: "solid", fill: C.cobaltSoft, width: 0 }).borderRadius = 16;
    addText(slide, "RAG · Retrieval-Augmented Generation", { left: 182, top: 593, width: 520, height: 24 }, { fontSize: 16, bold: true, color: C.cobalt });
    addText(slide, "외부 문서를 먼저 검색해 근거를 보강하는 생성 방식", { left: 182, top: 622, width: 980, height: 22 }, { fontSize: 16, color: C.ink });

    addSlideNumber(slide, "03");
    setNotes(slide, [
      "[Timing] 4:00–5:00",
      "[Narration] 발화 중에는 빠른 표시를 위해 임시 인식 결과를 먼저 보여줍니다. 문장이 확정된 뒤에만 검증된 한국어 발음 별칭을 정식 전문용어와 연결합니다.",
      "[Narration] 예를 들어 RAG를 ‘래그’라고 말하면 확정 자막에서 RAG와 원래 STT 표기를 함께 보여주고, 오른쪽 설명 피드에 쉬운 설명이 자동으로 추가됩니다.",
      "[Narration] 실제 구현은 용어를 클릭해 여는 방식이 아니라, 확정 자막에서 감지된 용어 설명이 최신순으로 쌓이는 방식입니다.",
      "[Video] 임시 자막 변화 → 확정 자막 → 원문 병기 → 오른쪽 설명 카드 자동 추가를 차례로 보여준다.",
    ], [
      `${PAPER} — 2.3 임시·확정 자막, 2.4 발음 별칭과 투명한 정정, 2.5 설명 피드`,
      `${README} — 확정 자막과 용어 설명 카드의 실제 동작`,
    ]);
  }

  // Slide 4 — results
  {
    const slide = presentation.slides.add();
    slide.background.fill = C.white;
    addEyebrow(slide, "EXPERIMENT · 5:00–6:00");
    addText(slide, "발음 별칭까지 연결했을 때 84.5%", { left: 64, top: 84, width: 1152, height: 58 }, {
      fontSize: 40,
      bold: true,
      color: C.inkDeep,
    });
    addText(slide, "목표 전문용어 인식·연결률 · 전체 문장 정확도(CER/WER)가 아님", { left: 64, top: 148, width: 1152, height: 30 }, {
      fontSize: 18,
      bold: true,
      color: C.slate,
    });

    const barX = 370;
    const trackW = 700;
    const rows = [
      { y: 236, code: "A", label: "기본 STT", value: 28.2, count: "60 / 213", color: C.chartA },
      { y: 352, code: "B", label: "정식·영문 PhraseSet", value: 54.9, count: "117 / 213", color: C.chartB },
      { y: 468, code: "C", label: "발음 별칭 + 확정 연결", value: 84.5, count: "180 / 213", color: C.chartC },
    ];
    addText(slide, "전문용어 연결률", { left: barX, top: 205, width: trackW, height: 22 }, { fontSize: 13, bold: true, color: C.muted, alignment: "right" });
    for (const row of rows) {
      addText(slide, row.code, { left: 64, top: row.y + 2, width: 36, height: 40 }, { fontSize: 26, bold: true, color: row.code === "C" ? C.cobalt : C.inkDeep });
      addText(slide, row.label, { left: 118, top: row.y + 4, width: 230, height: 42 }, { fontSize: 18, bold: true, color: C.ink });
      addShape(slide, "roundRect", { left: barX, top: row.y, width: trackW, height: 48 }, "#E9EDF1", { style: "solid", fill: "#E9EDF1", width: 0 }).borderRadius = 18;
      addShape(slide, "roundRect", { left: barX, top: row.y, width: trackW * (row.value / 100), height: 48 }, row.color, { style: "solid", fill: row.color, width: 0 }).borderRadius = 18;
      addText(slide, `${row.value.toFixed(1)}%`, { left: barX + trackW * (row.value / 100) + 14, top: row.y - 2, width: 104, height: 42 }, {
        fontSize: 28,
        bold: true,
        color: row.code === "C" ? C.cobalt : C.inkDeep,
      });
      addText(slide, row.count, { left: barX, top: row.y + 57, width: 150, height: 22 }, { fontSize: 13, bold: true, color: C.slate });
    }
    addShape(slide, "roundRect", { left: 64, top: 586, width: 1152, height: 62 }, C.cobaltSoft, { style: "solid", fill: C.cobaltSoft, width: 0 }).borderRadius = 16;
    addText(slide, "C 조건의 180회 연결 중 104회는 한국어 발음 별칭 연결", { left: 88, top: 603, width: 1090, height: 28 }, { fontSize: 18, bold: true, color: C.cobalt });
    addText(slide, "5개 기술 강연 × 조건별 3회 · 동일 음원 비교 · 목표 용어 213회", { left: 64, top: 660, width: 1152, height: 24 }, { fontSize: 14, color: C.slate });

    addSlideNumber(slide, "04");
    setNotes(slide, [
      "[Timing] 5:00–6:00",
      "[Narration] 다섯 개 기술 강연 대본을 조건별로 세 차례 비교해 총 213회의 목표 전문용어 출현을 측정했습니다.",
      "[Narration] 기본 STT는 28.2%, 정식 표기와 영어 표기를 PhraseSet으로 적용한 조건은 54.9%, 한국어 발음 별칭과 확정 자막 연결을 결합한 조건은 84.5%였습니다.",
      "[Narration] 이 값은 전체 문장 정확도가 아니라, 발화된 목표 용어가 정식 용어와 설명 카드에 연결될 수 있는 상태로 처리된 비율입니다.",
      "[Caveat] C는 5개 중 4개 케이스에서 가장 높았지만, 복합 약어가 집중된 test03에서는 B보다 낮았다. 필요하면 질의응답에서 혼합형 발음과 겹치는 약어의 한계를 설명한다.",
    ], [
      `${PAPER} — 3.1 실험 절차, 3.2 지표 정의, 3.3 결과(60/213, 117/213, 180/213)`,
    ]);
  }

  // Slide 5 — application and conclusion
  {
    const slide = presentation.slides.add();
    slide.background.fill = C.white;
    addEyebrow(slide, "IMPACT · 6:00–6:40");
    addText(slide, "음성을 문자로 바꾸는 것을 넘어,\n맥락과 의미를 전달합니다", { left: 64, top: 84, width: 1152, height: 104 }, {
      fontSize: 40,
      bold: true,
      color: C.inkDeep,
      lineSpacing: 1.02,
    });

    addRule(slide, 190, 315, 900, "#BFD5EC", 3);
    for (const x of [390, 840]) {
      addText(slide, "›", { left: x, top: 294, width: 44, height: 48 }, { fontSize: 32, bold: true, color: C.cobalt, alignment: "center" });
    }
    const finalNodes = [
      { x: 60, no: "01", title: "발표자료", desc: "사전에 확보한 문맥" },
      { x: 510, no: "02", title: "더 잘 들리는 용어", desc: "PhraseSet + 발음 별칭" },
      { x: 960, no: "03", title: "바로 이해하는 설명", desc: "확정 자막과 자동 연결" },
    ];
    for (const node of finalNodes) {
      addCircleNumber(slide, node.no, node.x + 130, 315, C.white, C.cobalt, C.cobalt, 46);
      addText(slide, node.title, { left: node.x, top: 357, width: 260, height: 34 }, { fontSize: 21, bold: true, color: C.inkDeep, alignment: "center" });
      addText(slide, node.desc, { left: node.x, top: 396, width: 260, height: 28 }, { fontSize: 14, color: C.slate, alignment: "center" });
    }

    addText(slide, "확장 가능한 환경", { left: 64, top: 476, width: 220, height: 28 }, { fontSize: 16, bold: true, color: C.cobalt });
    addRule(slide, 64, 518, 1152, C.hair, 1);
    const useCases = ["온라인 강의", "전문지식 콘텐츠", "학술대회·웨비나", "뉴스·공공 브리핑"];
    for (let i = 0; i < useCases.length; i++) {
      const x = 64 + i * 288;
      if (i > 0) addRule(slide, x, 542, 1, C.hair, 44);
      addText(slide, useCases[i], { left: x + (i > 0 ? 22 : 0), top: 548, width: 260, height: 30 }, { fontSize: 17, bold: true, color: C.ink });
    }
    addText(slide, "다음 검증 · 혼합형 발음 · 다중 화자와 소음 · 실제 사용자 이해도", { left: 64, top: 625, width: 1152, height: 26 }, { fontSize: 15, bold: true, color: C.slate });

    addSlideNumber(slide, "05");
    setNotes(slide, [
      "[Timing] 6:00–6:40",
      "[Narration] 이 시스템은 온라인 강의, 전문지식 중심 콘텐츠, 학술대회와 웨비나처럼 발표자료와 음성이 함께 제공되는 환경에 적용할 수 있습니다.",
      "[Narration] 기사 원고나 보도자료가 있는 뉴스와 공공 브리핑에도 같은 개념을 확장할 수 있지만, 오류 영향이 큰 공공정보는 사람의 검수와 출처 확인이 필요합니다.",
      "[Narration] 이번 프로젝트는 단순히 음성을 문자로 바꾸는 데 그치지 않고, 발표자료의 문맥으로 전문용어를 더 잘 전달하고 그 의미까지 이해하도록 보조하는 것을 목표로 했습니다. 이상으로 시연을 마치겠습니다.",
    ], [
      `${PAPER} — 4. 결론 및 향후 활용`,
      `${README} — 현재 구현 범위와 개인정보 처리 경계`,
    ]);
  }

  for (const [index, slide] of presentation.slides.items.entries()) {
    const stem = `slide-${String(index + 1).padStart(2, "0")}`;
    const png = await presentation.export({ slide, format: "png", scale: 1 });
    await fs.writeFile(path.join(OUT_DIR, `${stem}.png`), new Uint8Array(await png.arrayBuffer()));
    const layout = await slide.export({ format: "layout" });
    await fs.writeFile(path.join(OUT_DIR, `${stem}.layout.json`), await layout.text());
  }
  const montage = await presentation.export({ format: "webp", montage: true, scale: 1 });
  await fs.writeFile(path.join(OUT_DIR, "deck-montage.webp"), new Uint8Array(await montage.arrayBuffer()));

  const pptx = await PresentationFile.exportPptx(presentation);
  await pptx.save(FINAL_PPTX);
  console.log(FINAL_PPTX);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
