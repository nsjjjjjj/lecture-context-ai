#!/usr/bin/env python3
"""Build the ABC hackathon paper draft from the supplied Word template."""

from __future__ import annotations

import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from docx import Document
from docx.enum.section import WD_ORIENT, WD_SECTION_START
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT, WD_ROW_HEIGHT_RULE, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK, WD_LINE_SPACING
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.opc.constants import RELATIONSHIP_TYPE as RT
from docx.shared import Inches, Pt, RGBColor


ROOT = Path("/Users/nohsungbeen/dev/project/2026-2-ABC-hackathon")
WORK = ROOT / ".codex_tmp" / "abc_paper_draft"
REFERENCE = WORK / "reference.docx"
SOURCE = WORK / "draft_content.md"
DIAGRAM = ROOT / "deliverables" / "figures" / "figure1_korean_academic_pipeline.png"
RESULTS_CHART = ROOT / "deliverables" / "figures" / "figure2_stt_results.png"
OUTPUT = ROOT / "deliverables" / "ABC_해커톤_논문_참고문헌_정리본.docx"
TABLE_HELPERS = Path(
    "/Users/nohsungbeen/.codex/plugins/cache/openai-primary-runtime/"
    "documents/26.805.11740/skills/documents/scripts"
)
sys.path.insert(0, str(TABLE_HELPERS))
from table_geometry import apply_table_geometry  # noqa: E402


SERIF = "NanumMyeongjo"
SANS = "Apple SD Gothic Neo"
BLUE = "1F4E79"
LIGHT_BLUE = "EAF2F8"
LIGHT_GRAY = "F2F2F2"
MID_GRAY = "B7B7B7"


def set_run_font(run, name=SERIF, size=Pt(8.6), bold=None, italic=None, color=None):
    run.font.name = name
    run.font.size = size
    if bold is not None:
        run.bold = bold
    if italic is not None:
        run.italic = italic
    if color:
        run.font.color.rgb = RGBColor.from_string(color)
    rpr = run._r.get_or_add_rPr()
    rfonts = rpr.rFonts
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.insert(0, rfonts)
    for key in ("w:ascii", "w:hAnsi", "w:eastAsia", "w:cs"):
        rfonts.set(qn(key), name)
    return run


def set_style_font(style, name, size, bold=None):
    style.font.name = name
    style.font.size = size
    if bold is not None:
        style.font.bold = bold
    rpr = style._element.get_or_add_rPr()
    rfonts = rpr.rFonts
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.insert(0, rfonts)
    for key in ("w:ascii", "w:hAnsi", "w:eastAsia", "w:cs"):
        rfonts.set(qn(key), name)


def style_by_id(doc, style_id):
    for style in doc.styles:
        if style.style_id == style_id:
            return style
    raise KeyError(style_id)


def clear_cell(cell):
    tc = cell._tc
    for child in list(tc):
        if child.tag != qn("w:tcPr"):
            tc.remove(child)


def add_cell_paragraph(cell, text="", style=None, alignment=WD_ALIGN_PARAGRAPH.CENTER):
    p = cell.add_paragraph()
    if style is not None:
        p.style = style
    p.alignment = alignment
    p.paragraph_format.space_before = Pt(0)
    p.paragraph_format.space_after = Pt(0)
    return p, p.add_run(text)


def add_shading(element_pr, fill):
    shd = element_pr.find(qn("w:shd"))
    if shd is None:
        shd = OxmlElement("w:shd")
        element_pr.append(shd)
    shd.set(qn("w:fill"), fill)
    shd.set(qn("w:val"), "clear")


def set_cell_border(cell, color="B7B7B7", size="4"):
    tc_pr = cell._tc.get_or_add_tcPr()
    borders = tc_pr.find(qn("w:tcBorders"))
    if borders is None:
        borders = OxmlElement("w:tcBorders")
        tc_pr.append(borders)
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        tag = qn(f"w:{edge}")
        el = borders.find(tag)
        if el is None:
            el = OxmlElement(f"w:{edge}")
            borders.append(el)
        el.set(qn("w:val"), "single")
        el.set(qn("w:sz"), size)
        el.set(qn("w:color"), color)


def set_paragraph_box(paragraph, fill="F2F2F2"):
    ppr = paragraph._p.get_or_add_pPr()
    add_shading(ppr, fill)
    borders = ppr.find(qn("w:pBdr"))
    if borders is None:
        borders = OxmlElement("w:pBdr")
        ppr.append(borders)
    for edge in ("top", "left", "bottom", "right"):
        el = OxmlElement(f"w:{edge}")
        el.set(qn("w:val"), "single")
        el.set(qn("w:sz"), "4")
        el.set(qn("w:space"), "3")
        el.set(qn("w:color"), MID_GRAY)
        borders.append(el)


def create_pipeline_diagram(path: Path):
    image = Image.new("RGB", (720, 1060), "white")
    draw = ImageDraw.Draw(image)
    font_path = "/System/Library/Fonts/AppleSDGothicNeo.ttc"
    font = ImageFont.truetype(font_path, 20)
    small = ImageFont.truetype(font_path, 18)
    tiny = ImageFont.truetype(font_path, 16)
    heading = ImageFont.truetype(font_path, 24)

    def centered_text(box, text, text_font=font, fill="#1F2933", spacing=4):
        left, top, right, bottom = box
        bounds = draw.multiline_textbbox((0, 0), text, font=text_font, spacing=spacing, align="center")
        tw, th = bounds[2] - bounds[0], bounds[3] - bounds[1]
        draw.multiline_text(
            ((left + right - tw) / 2, (top + bottom - th) / 2 - 1),
            text,
            font=text_font,
            fill=fill,
            spacing=spacing,
            align="center",
        )

    def rounded_box(box, text, fill, text_font=font, outline="#6C7A89", width=2):
        draw.rounded_rectangle(box, radius=11, fill=fill, outline=outline, width=width)
        centered_text(box, text, text_font)

    def arrow(start, end, color="#657786", width=3):
        x1, y1 = start
        x2, y2 = end
        draw.line((x1, y1, x2, y2), fill=color, width=width)
        dx, dy = x2 - x1, y2 - y1
        length = max((dx * dx + dy * dy) ** 0.5, 1)
        ux, uy = dx / length, dy / length
        px, py = -uy, ux
        tip = (x2, y2)
        base = (x2 - ux * 13, y2 - uy * 13)
        draw.polygon(
            [tip, (base[0] + px * 6, base[1] + py * 6), (base[0] - px * 6, base[1] - py * 6)],
            fill=color,
        )

    def dashed_arrow(start, end, color="#7B8794", width=2, dash=9, gap=6):
        x1, y1 = start
        x2, y2 = end
        dx, dy = x2 - x1, y2 - y1
        length = max((dx * dx + dy * dy) ** 0.5, 1)
        ux, uy = dx / length, dy / length
        cursor = 0.0
        while cursor < length - 13:
            segment_end = min(cursor + dash, length - 13)
            draw.line(
                (x1 + ux * cursor, y1 + uy * cursor, x1 + ux * segment_end, y1 + uy * segment_end),
                fill=color,
                width=width,
            )
            cursor += dash + gap
        arrow((x1 + ux * max(0, length - 13), y1 + uy * max(0, length - 13)), end, color=color, width=width)

    # A. The browser extracts page text; the server deliberately builds the
    # glossary and PhraseSet after Gemini/heuristic candidate generation.
    draw.rounded_rectangle((18, 14, 702, 464), radius=15, fill="#F7FAFC", outline="#AAB7C4", width=2)
    draw.text((42, 30), "① 강연 전 · 강연별 문맥 생성", font=heading, fill="#1F4E79")
    rounded_box((64, 72, 656, 128), "[브라우저] PDF.js → 페이지별 PageText[] 추출", "#E8F1FB")
    centered_text((270, 130, 450, 153), "POST /api/analyze", tiny, "#52606D")
    arrow((360, 128), (360, 158))
    rounded_box(
        (64, 158, 656, 242),
        "[Node.js 서버 ↔ Gemini API]\n용어 · 영문 · 발음 별칭 · 쉬운 설명 후보 생성\n실패하거나 후보가 부족하면 문서 휴리스틱으로 보완",
        "#FFF4DA",
        small,
    )
    arrow((360, 242), (360, 276))
    rounded_box(
        (64, 276, 656, 354),
        "[Node.js 서버] 원문 근거 · 정규화 · 별칭 안전성/충돌 검사\n검증 결과로 terms[] + phraseSet[] 직접 구성",
        "#EAF6EC",
        small,
    )
    centered_text((270, 356, 450, 378), "AnalysisResult 응답", tiny, "#52606D")
    arrow((360, 354), (360, 384))
    rounded_box((48, 384, 456, 448), "[브라우저] 현재 terms[] + phraseSet[]\n강연 시작에 직접 사용", "#E8F1FB", small)
    rounded_box(
        (500, 388, 672, 444),
        "localStorage v3\n자동 저장 시도",
        "#F1F3F5",
        tiny,
        outline="#9AA5B1",
    )
    dashed_arrow((456, 416), (500, 416))

    # B. terms and PhraseSet share the start message but have different jobs:
    # PhraseSet configures STT; terms are retained for final-only postprocessing.
    draw.rounded_rectangle((18, 484, 702, 1046), radius=15, fill="#FAFAFA", outline="#AAB7C4", width=2)
    draw.text((42, 500), "② 강연 중 · 실시간 자막 및 용어 설명", font=heading, fill="#1F4E79")
    rounded_box((38, 546, 410, 608), "WS start 메시지\n{ terms[], phraseSet[] }", "#E8F1FB", small)
    rounded_box((454, 546, 680, 608), "마이크 → 브라우저 변환\nmono · 16 kHz · Int16 PCM", "#E8F1FB", tiny)
    # Route the hand-off to the right of the phase title so the label stays clear.
    arrow((440, 448), (410, 546), color="#1F4E79", width=4)
    arrow((224, 608), (272, 642))
    arrow((567, 608), (448, 642))
    rounded_box(
        (66, 642, 654, 720),
        "[Node.js /ws] 시작 데이터 재검증\nterms[] → 확정 결과 후처리 · phraseSet[] → STT 설정\nPCM 청크 → Google 스트림 중계",
        "#EAF6EC",
        small,
    )
    centered_text((244, 722, 476, 744), "스트리밍 인식 요청", tiny, "#52606D")
    arrow((360, 720), (360, 750))
    rounded_box(
        (92, 750, 628, 828),
        "Google Speech-to-Text V2 · ko-KR · chirp_3\nLINEAR16 16 kHz mono + interimResults\nphraseSet[] → 인라인 SpeechAdaptation에 명시적으로 적용",
        "#FFF4DA",
        small,
    )
    centered_text((250, 830, 470, 851), "STT 원문 + isFinal", tiny, "#52606D")
    arrow((360, 828), (180, 866))
    arrow((360, 828), (516, 866))
    rounded_box(
        (38, 866, 318, 936),
        "[interim]\n정정 없이 브라우저에 전달\n임시 자막을 즉시 갱신",
        "#F1F3F5",
        small,
    )
    rounded_box(
        (366, 866, 682, 946),
        "[final] Node.js 서버 후처리\n발음 별칭 → 정식 용어 · rawText 보존\ncorrections + detectedTerms 생성",
        "#EAF6EC",
        tiny,
    )

    # A side path makes the retained terms input to final processing explicit.
    draw.line((654, 682, 692, 682, 692, 906, 682, 906), fill="#1F4E79", width=3)
    arrow((682, 906), (664, 906), color="#1F4E79", width=3)
    draw.text((646, 788), "terms[]", font=tiny, fill="#1F4E79", anchor="mm")

    rounded_box((342, 982, 500, 1032), "현재 확정 자막\n정식 용어 + 원 STT 표기", "#E8F1FB", tiny)
    rounded_box((516, 982, 686, 1032), "쉬운 설명 카드\n최신순 자동 추가 · 반복 보존", "#E8F1FB", tiny)
    arrow((478, 946), (421, 982))
    arrow((570, 946), (601, 982))

    image.save(path, dpi=(220, 220), optimize=True)


def create_results_chart(path: Path):
    """Create a print-friendly 100% stacked bar chart for the STT conditions."""
    canvas = Image.new("RGB", (1600, 900), "white")
    draw = ImageDraw.Draw(canvas)
    font_path = "/System/Library/Fonts/AppleSDGothicNeo.ttc"
    title_font = ImageFont.truetype(font_path, 50)
    label_font = ImageFont.truetype(font_path, 36)
    value_font = ImageFont.truetype(font_path, 33)
    small_font = ImageFont.truetype(font_path, 29)
    legend_font = ImageFont.truetype(font_path, 31)

    navy = "#1F4E79"
    teal = "#2A9D8F"
    miss_gray = "#D9E1E8"
    grid_gray = "#D8DEE5"
    text_dark = "#263238"
    text_muted = "#52606D"

    plot_left, plot_right = 180, 1300
    plot_top, plot_bottom = 245, 735
    plot_width = plot_right - plot_left
    bar_height = 110
    y_positions = [285, 470, 655]
    rows = [
        ("A", 60, 0, 153, "연결률 28.2%"),
        ("B", 117, 0, 96, "연결률 54.9%"),
        ("C", 76, 104, 33, "연결률 84.5%"),
    ]
    total = 213

    def center_text(box, text, font, fill=text_dark, spacing=2):
        left, top, right, bottom = box
        bbox = draw.multiline_textbbox((0, 0), text, font=font, spacing=spacing, align="center")
        width = bbox[2] - bbox[0]
        height = bbox[3] - bbox[1]
        draw.multiline_text(
            ((left + right - width) / 2, (top + bottom - height) / 2 - 2),
            text,
            font=font,
            fill=fill,
            spacing=spacing,
            align="center",
        )

    title = "조건별 전문용어 처리 구성"
    title_box = draw.textbbox((0, 0), title, font=title_font)
    draw.text(((1600 - (title_box[2] - title_box[0])) / 2, 40), title, font=title_font, fill=text_dark)

    legend = [(navy, "직접 인식·연결"), (teal, "발음 별칭 연결"), (miss_gray, "누락")]
    legend_x = 360
    for color, label in legend:
        draw.rounded_rectangle((legend_x, 122, legend_x + 34, 156), radius=4, fill=color)
        draw.text((legend_x + 48, 119), label, font=legend_font, fill=text_dark)
        label_width = draw.textbbox((0, 0), label, font=legend_font)[2]
        legend_x += 48 + label_width + 75

    for tick in (0, 25, 50, 75, 100):
        x = plot_left + plot_width * tick / 100
        draw.line((x, plot_top - 28, x, plot_bottom + 15), fill=grid_gray, width=2)
        tick_label = f"{tick}%"
        tick_width = draw.textbbox((0, 0), tick_label, font=small_font)[2]
        draw.text((x - tick_width / 2, plot_top - 68), tick_label, font=small_font, fill=text_muted)

    for (condition, direct, alias, miss, link_label), y in zip(rows, y_positions):
        draw.text((92, y + 29), condition, font=label_font, fill=text_dark)
        values = [(direct, navy, "white"), (alias, teal, "white"), (miss, miss_gray, text_dark)]
        cursor = plot_left
        for value, color, font_color in values:
            if value == 0:
                continue
            width = plot_width * value / total
            box = (cursor, y, cursor + width, y + bar_height)
            draw.rectangle(box, fill=color)
            pct = value / total * 100
            center_text(box, f"{value}회\n{pct:.1f}%", value_font, font_color)
            cursor += width
        draw.rectangle((plot_left, y, plot_right, y + bar_height), outline="#8FA3B5", width=2)
        draw.text((plot_right + 28, y + 34), link_label, font=label_font, fill=navy)

    draw.text(
        (plot_left, 805),
        "※ 각 조건은 동일한 목표용어 출현 213회를 기준으로 비교함.",
        font=small_font,
        fill=text_muted,
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(path, dpi=(300, 300), optimize=True)


def parse_source(path: Path):
    lines = path.read_text(encoding="utf-8").splitlines()
    title = lines[0].removeprefix("# ").strip()
    english_title = lines[2].removeprefix("## ").strip()
    blocks = []
    buf = []
    i = 4
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            if buf:
                blocks.append(("paragraph", " ".join(x.strip() for x in buf)))
                buf = []
            i += 1
            continue
        if line.startswith("## "):
            if buf:
                blocks.append(("paragraph", " ".join(x.strip() for x in buf)))
                buf = []
            blocks.append(("heading1", line[3:].strip()))
        elif line.startswith("### "):
            if buf:
                blocks.append(("paragraph", " ".join(x.strip() for x in buf)))
                buf = []
            blocks.append(("heading2", line[4:].strip()))
        elif re.match(r"<표\s+\d+>", line):
            if buf:
                blocks.append(("paragraph", " ".join(x.strip() for x in buf)))
                buf = []
            blocks.append(("table_caption", line.strip()))
            table_lines = []
            i += 1
            while i < len(lines) and (not lines[i].strip() or lines[i].lstrip().startswith("|")):
                if lines[i].lstrip().startswith("|"):
                    table_lines.append(lines[i].strip())
                i += 1
            rows = []
            for row_line in table_lines:
                cells = [c.strip() for c in row_line.strip("|").split("|")]
                if cells and all(re.fullmatch(r":?-{2,}:?", c) for c in cells):
                    continue
                rows.append(cells)
            blocks.append(("table", rows))
            continue
        else:
            buf.append(line)
        i += 1
    if buf:
        blocks.append(("paragraph", " ".join(x.strip() for x in buf)))
    return title, english_title, blocks


def clean_inline(text):
    return text.replace("`", "")


def remove_template_body(doc):
    body = doc._element.body
    first_table = doc.tables[0]._tbl
    for child in list(body):
        if child is first_table or child.tag == qn("w:sectPr"):
            continue
        body.remove(child)


def configure_styles(doc):
    mappings = {
        "a4": (SERIF, Pt(15.2), True),
        "a9": (SERIF, Pt(12.0), True),
        "aa": (SERIF, Pt(8.6), False),
        "ab": (SERIF, Pt(8.0), False),
        "a3": (SERIF, Pt(8.0), False),
        "1": (SERIF, Pt(9.2), True),
        "a7": (SANS, Pt(7.7), False),
        "a6": (SERIF, Pt(8.8), True),
    }
    for sid, (font, size, bold) in mappings.items():
        try:
            style = style_by_id(doc, sid)
        except KeyError:
            continue
        set_style_font(style, font, size, bold)


def fill_title_block(doc, title, english_title, abstract):
    table = doc.tables[0]
    title_style = style_by_id(doc, "a4")
    eng_style = style_by_id(doc, "a9")
    author_style = style_by_id(doc, "aa")
    summary_style = style_by_id(doc, "ab")

    cell = table.rows[0].cells[2]
    clear_cell(cell)
    p, run = add_cell_paragraph(cell, style=title_style)
    title_lines = title.replace("강연 자료 기반", "강연 자료 기반\n")
    parts = title_lines.split("\n")
    for idx, part in enumerate(parts):
        if idx:
            run.add_break()
        run.add_text(part)
    set_run_font(run, SERIF, Pt(15.2), bold=True)
    p.paragraph_format.line_spacing = 1.15

    cell = table.rows[2].cells[2]
    clear_cell(cell)
    p, run = add_cell_paragraph(cell, "[저자명]", author_style)
    set_run_font(run, SERIF, Pt(9.0), bold=True)
    p, run = add_cell_paragraph(cell, "[소속학과], 한신대학교", author_style)
    set_run_font(run, SERIF, Pt(8.2))
    p, run = add_cell_paragraph(cell, "[이메일]", author_style)
    set_run_font(run, SERIF, Pt(8.0))

    cell = table.rows[4].cells[2]
    clear_cell(cell)
    p, run = add_cell_paragraph(cell, english_title, eng_style)
    set_run_font(run, SERIF, Pt(11.2), bold=True)
    p.paragraph_format.line_spacing = 1.08

    cell = table.rows[6].cells[2]
    clear_cell(cell)
    p, run = add_cell_paragraph(cell, "[Author Name]", author_style)
    set_run_font(run, SERIF, Pt(8.3), bold=True)
    p, run = add_cell_paragraph(cell, "[Department], Hanshin University", author_style)
    set_run_font(run, SERIF, Pt(7.8))

    cell = table.rows[8].cells[1]
    clear_cell(cell)
    p, run = add_cell_paragraph(cell, "요   약", summary_style)
    set_run_font(run, SERIF, Pt(8.6), bold=True)
    p.paragraph_format.space_after = Pt(1.5)
    p, run = add_cell_paragraph(cell, clean_inline(abstract), summary_style, WD_ALIGN_PARAGRAPH.JUSTIFY)
    set_run_font(run, SERIF, Pt(7.85))
    p.paragraph_format.first_line_indent = Pt(8)
    p.paragraph_format.line_spacing = 1.18


def format_body_paragraph(p, text):
    p.style = style_by_id(p._parent.part.document, "a3") if False else p.style
    p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    pf = p.paragraph_format
    pf.first_line_indent = Pt(8.5)
    pf.space_before = Pt(0)
    pf.space_after = Pt(0.5)
    pf.line_spacing_rule = WD_LINE_SPACING.MULTIPLE
    pf.line_spacing = 1.14
    run = p.add_run(clean_inline(text))
    set_run_font(run, SERIF, Pt(8.0))
    return p


def add_body_heading(doc, text, level):
    p = doc.add_paragraph()
    p.style = style_by_id(doc, "1")
    p.alignment = WD_ALIGN_PARAGRAPH.LEFT
    pf = p.paragraph_format
    pf.first_line_indent = Pt(0)
    pf.keep_with_next = True
    pf.keep_together = True
    pf.space_before = Pt(3.2 if level == 1 else 1.7)
    pf.space_after = Pt(0.6)
    run = p.add_run(text)
    set_run_font(run, SERIF, Pt(9.4 if level == 1 else 8.7), bold=True)
    return p


def add_body_text(doc, text, placeholder=False):
    p = doc.add_paragraph()
    p.style = style_by_id(doc, "a3")
    p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    pf = p.paragraph_format
    pf.first_line_indent = Pt(8.5 if not placeholder else 0)
    pf.space_before = Pt(0)
    pf.space_after = Pt(0.5)
    pf.line_spacing_rule = WD_LINE_SPACING.MULTIPLE
    pf.line_spacing = 1.14
    run = p.add_run(clean_inline(text))
    set_run_font(run, SERIF, Pt(8.0), italic=placeholder, color="666666" if placeholder else None)
    if placeholder:
        p.alignment = WD_ALIGN_PARAGRAPH.LEFT
        p.paragraph_format.left_indent = Pt(3)
        p.paragraph_format.right_indent = Pt(3)
        p.paragraph_format.space_before = Pt(2)
        p.paragraph_format.space_after = Pt(2)
        set_paragraph_box(p, LIGHT_GRAY)
    return p


def add_figure(doc):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.keep_together = True
    p.paragraph_format.space_before = Pt(1)
    p.paragraph_format.space_after = Pt(0)
    run = p.add_run()
    shape = run.add_picture(str(DIAGRAM), width=Inches(2.85))
    shape._inline.docPr.set(
        "descr",
        "강연 PDF를 PDF.js로 추출해 Gemini API 후보 생성과 서버 검증을 거친 뒤 실시간 자막과 용어 설명으로 연결하는 흐름. terms는 확정 결과 처리에, PhraseSet은 STT 문맥 적응에 사용되고 임시 자막은 원문 그대로 표시된다.",
    )
    shape._inline.docPr.set("title", "강연 자료 분석과 실시간 자막의 데이터 흐름")
    cap = doc.add_paragraph()
    cap.style = style_by_id(doc, "a7")
    cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
    cap.paragraph_format.keep_with_next = False
    cap.paragraph_format.space_before = Pt(0)
    cap.paragraph_format.space_after = Pt(2)
    set_run_font(cap.add_run("(그림 1) 강연 자료 분석과 실시간 자막의 데이터 흐름"), SANS, Pt(7.5))


def add_pipeline_table(doc):
    add_table_caption(doc, "<표 1> 시스템 처리 단계와 데이터별 역할")
    rows = [
        ["단계", "실행 위치", "데이터 흐름 및 역할"],
        ["1-3", "브라우저\nNode.js\n→ Gemini API", "PDF → PDF.js → PageText[] → 후보 생성\n용어·영문·발음 별칭·쉬운 설명 후보를 구성"],
        ["4-5", "Node.js", "후보+원문 → 근거·별칭 검사 → terms[]+phraseSet[]\n검증된 표기로 강연별 PhraseSet을 직접 구성"],
        ["6", "브라우저→Node", "WS start{terms, phraseSet}+16 kHz Int16 PCM\n용어 데이터와 마이크 음성을 실시간 세션에 전달"],
        ["7", "Google·Node", "PCM+phraseSet → STT, final+terms → 후처리\ninterim은 원문 전달, final만 별칭 연결·rawText 보존"],
        ["8", "React", "자막 이벤트+detectedTerms → 자막·설명 카드\n확정 용어 설명을 최신순으로 표시하고 반복을 보존"],
        ["보조", "브라우저", "terms+phraseSet ↔ localStorage v3\n저장·재사용 경로이며 실시간 처리의 필수 단계는 아님"],
    ]
    table = doc.add_table(rows=len(rows), cols=3)
    table.alignment = WD_TABLE_ALIGNMENT.LEFT
    widths = [500, 980, 2830]
    apply_table_geometry(
        table,
        widths,
        table_width_dxa=sum(widths),
        indent_dxa=55,
        cell_margins_dxa={"top": 42, "bottom": 42, "start": 55, "end": 55},
    )
    for r_idx, row in enumerate(table.rows):
        row.height_rule = WD_ROW_HEIGHT_RULE.AT_LEAST
        if r_idx == 0:
            tr_pr = row._tr.get_or_add_trPr()
            repeat = OxmlElement("w:tblHeader")
            repeat.set(qn("w:val"), "true")
            tr_pr.append(repeat)
        for c_idx, cell in enumerate(row.cells):
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            set_cell_border(cell, "9EADBA", "4")
            if r_idx == 0:
                add_shading(cell._tc.get_or_add_tcPr(), "D9EAF7")
            elif r_idx in (2, 4):
                add_shading(cell._tc.get_or_add_tcPr(), "F4F8FB")
            clear_cell(cell)
            p, run = add_cell_paragraph(
                cell,
                rows[r_idx][c_idx],
                style_by_id(doc, "a3"),
                WD_ALIGN_PARAGRAPH.CENTER if c_idx < 2 or r_idx == 0 else WD_ALIGN_PARAGRAPH.LEFT,
            )
            p.paragraph_format.line_spacing = 1.02
            set_run_font(run, SANS if r_idx == 0 else SERIF, Pt(6.25), bold=(r_idx == 0))
    note = doc.add_paragraph()
    note.style = style_by_id(doc, "a3")
    note.alignment = WD_ALIGN_PARAGRAPH.LEFT
    note.paragraph_format.space_before = Pt(1)
    note.paragraph_format.space_after = Pt(2)
    note.paragraph_format.line_spacing = 1.0
    set_run_font(
        note.add_run("※ phraseSet[]은 STT 인식 힌트로, terms[]는 확정 자막 매칭·별칭 정정·설명 조회에 사용한다."),
        SERIF,
        Pt(6.4),
    )


def add_table_caption(doc, text):
    p = doc.add_paragraph()
    p.style = style_by_id(doc, "a7")
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.keep_with_next = True
    p.paragraph_format.space_before = Pt(2)
    p.paragraph_format.space_after = Pt(1)
    set_run_font(p.add_run(text), SANS, Pt(7.6), bold=True)


def add_condition_table(doc, rows):
    table = doc.add_table(rows=len(rows), cols=3)
    table.alignment = 0
    widths = [470, 1660, 2180]
    apply_table_geometry(
        table,
        widths,
        table_width_dxa=sum(widths),
        indent_dxa=55,
        cell_margins_dxa={"top": 45, "bottom": 45, "start": 55, "end": 55},
    )
    for r_idx, row in enumerate(table.rows):
        row.height_rule = WD_ROW_HEIGHT_RULE.AT_LEAST
        if r_idx == 0:
            tr_pr = row._tr.get_or_add_trPr()
            repeat = OxmlElement("w:tblHeader")
            repeat.set(qn("w:val"), "true")
            tr_pr.append(repeat)
        for c_idx, cell in enumerate(row.cells):
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            set_cell_border(cell, "9EADBA", "4")
            if r_idx == 0:
                add_shading(cell._tc.get_or_add_tcPr(), "D9EAF7")
            clear_cell(cell)
            p, run = add_cell_paragraph(
                cell,
                clean_inline(rows[r_idx][c_idx]),
                style_by_id(doc, "a3"),
                WD_ALIGN_PARAGRAPH.CENTER if c_idx == 0 or r_idx == 0 else WD_ALIGN_PARAGRAPH.LEFT,
            )
            p.paragraph_format.line_spacing = 1.05
            set_run_font(run, SANS if r_idx == 0 else SERIF, Pt(6.7), bold=(r_idx == 0))
    tail = doc.add_paragraph()
    tail.paragraph_format.space_before = Pt(0)
    tail.paragraph_format.space_after = Pt(0)
    tail.paragraph_format.line_spacing = 0.7
    set_run_font(tail.add_run(""), SERIF, Pt(2))


def add_result_table(doc, rows):
    """Add the compact four-column case comparison table for one body column."""
    table = doc.add_table(rows=len(rows), cols=4)
    table.alignment = WD_TABLE_ALIGNMENT.LEFT
    widths = [620, 1040, 1220, 1430]
    apply_table_geometry(
        table,
        widths,
        table_width_dxa=sum(widths),
        indent_dxa=55,
        cell_margins_dxa={"top": 42, "bottom": 42, "start": 48, "end": 48},
    )
    last_row = len(rows) - 1
    for r_idx, row in enumerate(table.rows):
        row.height_rule = WD_ROW_HEIGHT_RULE.AT_LEAST
        if r_idx == 0:
            tr_pr = row._tr.get_or_add_trPr()
            repeat = OxmlElement("w:tblHeader")
            repeat.set(qn("w:val"), "true")
            tr_pr.append(repeat)
        for c_idx, cell in enumerate(row.cells):
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            set_cell_border(cell, "9EADBA", "4")
            if r_idx == 0:
                add_shading(cell._tc.get_or_add_tcPr(), "D9EAF7")
            elif r_idx == last_row:
                add_shading(cell._tc.get_or_add_tcPr(), "EAF2F8")
            clear_cell(cell)
            p, run = add_cell_paragraph(
                cell,
                clean_inline(rows[r_idx][c_idx]),
                style_by_id(doc, "a3"),
                WD_ALIGN_PARAGRAPH.CENTER,
            )
            p.paragraph_format.line_spacing = 1.0
            set_run_font(
                run,
                SANS if r_idx == 0 else SERIF,
                Pt(6.1 if r_idx == 0 else 6.55),
                bold=(r_idx == 0 or r_idx == last_row),
            )
    note = doc.add_paragraph()
    note.style = style_by_id(doc, "a3")
    note.alignment = WD_ALIGN_PARAGRAPH.LEFT
    note.paragraph_format.space_before = Pt(0.7)
    note.paragraph_format.space_after = Pt(1.5)
    note.paragraph_format.line_spacing = 1.0
    set_run_font(
        note.add_run("※ test01~test05는 케이스별 3회 평균이며, 전체는 213회 목표용어 출현을 합산한 값이다."),
        SERIF,
        Pt(6.25),
    )
    add_results_figure(doc)


def add_results_figure(doc):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.keep_together = True
    p.paragraph_format.space_before = Pt(2)
    p.paragraph_format.space_after = Pt(0)
    run = p.add_run()
    shape = run.add_picture(str(RESULTS_CHART), width=Inches(3.0))
    shape._inline.docPr.set(
        "descr",
        "조건 A, B, C의 전문용어 처리 결과를 직접 인식·연결, 발음 별칭 연결, 누락으로 구분한 100퍼센트 누적 막대그래프. 전체 연결률은 A 28.2퍼센트, B 54.9퍼센트, C 84.5퍼센트이다.",
    )
    shape._inline.docPr.set("title", "조건별 전문용어 인식·연결 결과")
    cap = doc.add_paragraph()
    cap.style = style_by_id(doc, "a7")
    cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
    cap.paragraph_format.keep_with_next = True
    cap.paragraph_format.space_before = Pt(0)
    cap.paragraph_format.space_after = Pt(1.5)
    set_run_font(
        cap.add_run("(그림 2) 조건별 전문용어 인식·연결 결과(목표용어 213회)"),
        SANS,
        Pt(7.3),
    )


def configure_header(doc):
    header = doc.sections[0].header
    if not header.tables:
        return
    table = header.tables[0]
    left = table.rows[0].cells[0].paragraphs[0]
    right = table.rows[0].cells[2].paragraphs[0]
    left.clear()
    left.alignment = WD_ALIGN_PARAGRAPH.LEFT
    set_run_font(left.add_run("Hanshin University"), SERIF, Pt(7.5), color="666666")
    right.clear()
    right.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    set_run_font(right.add_run("2026 ABC Hackathon"), SERIF, Pt(7.5), color="666666")
    for doc_pr in header._element.xpath(".//wp:docPr"):
        doc_pr.set("descr", "한신대학교 로고")
        doc_pr.set("title", "한신대학교")


def configure_title_and_body_sections(doc):
    """Use a one-column title section followed by a continuous two-column body.

    The supplied template uses a floating title table. Converting that table to
    an inline element keeps the same visual title block while avoiding a
    LibreOffice final-page column-balancing defect that can cover the header.
    """
    table = doc.tables[0]
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    tbl_pr = table._tbl.tblPr
    for tag in ("w:tblpPr", "w:tblOverlap"):
        el = tbl_pr.find(qn(tag))
        if el is not None:
            tbl_pr.remove(el)

    first = doc.sections[0]
    cols = first._sectPr.find(qn("w:cols"))
    if cols is None:
        cols = OxmlElement("w:cols")
        first._sectPr.append(cols)
    cols.set(qn("w:num"), "1")
    cols.set(qn("w:space"), "567")

    body = doc.add_section(WD_SECTION_START.CONTINUOUS)
    body_cols = body._sectPr.find(qn("w:cols"))
    if body_cols is None:
        body_cols = OxmlElement("w:cols")
        body._sectPr.append(body_cols)
    body_cols.set(qn("w:num"), "2")
    body_cols.set(qn("w:space"), "567")
    body.header.is_linked_to_previous = True
    body.footer.is_linked_to_previous = True


def drop_unused_body_images(doc):
    used = set(doc._element.xpath(".//a:blip/@r:embed"))
    for rid, rel in list(doc.part.rels.items()):
        if rel.reltype == RT.IMAGE and rid not in used:
            doc.part.drop_rel(rid)


def build():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    if not DIAGRAM.exists():
        raise FileNotFoundError(f"Generated pipeline figure not found: {DIAGRAM}")
    create_results_chart(RESULTS_CHART)
    title, english_title, blocks = parse_source(SOURCE)
    abstract = ""
    for idx, (kind, text) in enumerate(blocks):
        if kind == "heading2" and text == "요약" and idx + 1 < len(blocks):
            abstract = blocks[idx + 1][1]
            blocks = blocks[idx + 2 :]
            break

    doc = Document(REFERENCE)
    remove_template_body(doc)
    configure_styles(doc)
    fill_title_block(doc, title, english_title, abstract)
    configure_title_and_body_sections(doc)
    configure_header(doc)

    inserted_figure = False
    in_references = False
    active_table_caption = ""
    for kind, payload in blocks:
        if kind == "heading1":
            if payload == "참고문헌":
                in_references = True
                break_p = doc.add_paragraph()
                break_p.paragraph_format.space_before = Pt(0)
                break_p.paragraph_format.space_after = Pt(0)
                break_p.add_run().add_break(WD_BREAK.COLUMN)
                p = add_body_heading(doc, payload, 1)
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            else:
                add_body_heading(doc, payload, 1)
        elif kind == "heading2":
            add_body_heading(doc, payload, 2)
        elif kind == "paragraph":
            placeholder = payload.startswith("[재실험 완료 후")
            if in_references:
                p = doc.add_paragraph()
                p.style = style_by_id(doc, "a3")
                p.alignment = WD_ALIGN_PARAGRAPH.LEFT
                p.paragraph_format.left_indent = Pt(9)
                p.paragraph_format.first_line_indent = Pt(-9)
                p.paragraph_format.space_before = Pt(0)
                p.paragraph_format.space_after = Pt(0.25)
                p.paragraph_format.line_spacing = 1.0
                set_run_font(p.add_run(clean_inline(payload)), SERIF, Pt(6.55))
            else:
                add_body_text(doc, payload, placeholder=placeholder)
                if (
                    not inserted_figure
                    and payload.startswith("시스템은 강연 전")
                ):
                    add_figure(doc)
                    add_pipeline_table(doc)
                    inserted_figure = True
        elif kind == "table_caption":
            active_table_caption = payload.replace("<표 1> STT", "<표 2> STT", 1)
            add_table_caption(doc, active_table_caption)
        elif kind == "table":
            if active_table_caption.startswith("<표 3>"):
                add_result_table(doc, payload)
            else:
                add_condition_table(doc, payload)
            active_table_caption = ""

    # Preserve the supplied A4/two-column section exactly.
    for section in doc.sections:
        section.orientation = WD_ORIENT.PORTRAIT

    props = doc.core_properties
    props.title = title
    props.subject = "ABC Hackathon undergraduate ICT paper draft"
    props.author = ""
    props.last_modified_by = ""
    props.comments = "Reference 7 and its related YouTube automatic-captioning sentence removed; references 1-6 preserved."

    drop_unused_body_images(doc)
    doc.save(OUTPUT)
    print(OUTPUT)


if __name__ == "__main__":
    build()
