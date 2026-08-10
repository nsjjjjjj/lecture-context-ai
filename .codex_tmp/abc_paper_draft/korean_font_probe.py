from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt


def configure(run, east_asia, ascii_font="Times New Roman", hint=False, lang=False):
    run.font.name = ascii_font
    run.font.size = Pt(14)
    rpr = run._r.get_or_add_rPr()
    rfonts = rpr.rFonts
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.insert(0, rfonts)
    rfonts.set(qn("w:ascii"), ascii_font)
    rfonts.set(qn("w:hAnsi"), ascii_font)
    rfonts.set(qn("w:eastAsia"), east_asia)
    rfonts.set(qn("w:cs"), east_asia)
    if hint:
        rfonts.set(qn("w:hint"), "eastAsia")
    if lang:
        lang_el = OxmlElement("w:lang")
        lang_el.set(qn("w:val"), "ko-KR")
        lang_el.set(qn("w:eastAsia"), "ko-KR")
        rpr.append(lang_el)


d = Document()
variants = [
    ("Apple SD Gothic Neo", False, False),
    ("Apple SD 산돌고딕 Neo", False, False),
    (".Apple SD Gothic NeoI", False, False),
    ("AppleGothic", True, True),
    ("AppleMyungjo", True, True),
    ("NanumMyeongjo", True, True),
    ("나눔명조", True, True),
    ("NanumMyeongjoOTF", True, True),
    ("나눔명조OTF", True, True),
    ("Arial Unicode MS", True, True),
]
for font, hint, lang in variants:
    p = d.add_paragraph()
    label = p.add_run(f"{font}: ")
    configure(label, font, hint=hint, lang=lang)
    korean = p.add_run("한글 전문용어 음성인식 테스트 ")
    configure(korean, font, ascii_font=font, hint=hint, lang=lang)
    english = p.add_run("ABC 123")
    configure(english, font, hint=hint, lang=lang)

d.save("korean_font_probe.docx")
