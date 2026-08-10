from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt

fonts = ["NanumMyeongjo", "NanumMyeongjoOTF", "AppleMyungjo", "AppleGothic", "Apple SD Gothic Neo", "Arial Unicode MS"]
d = Document()
for font in fonts:
    p = d.add_paragraph()
    r = p.add_run(f"{font}: 한글 전문용어 음성인식 테스트 ABC 123")
    r.font.name = font
    r.font.size = Pt(14)
    rpr = r._r.get_or_add_rPr()
    rfonts = rpr.rFonts
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.insert(0, rfonts)
    for key in ("w:ascii", "w:hAnsi", "w:eastAsia", "w:cs"):
        rfonts.set(qn(key), font)
d.save("/Users/nohsungbeen/dev/project/2026-2-ABC-hackathon/.codex_tmp/abc_paper_draft/font_probe.docx")
