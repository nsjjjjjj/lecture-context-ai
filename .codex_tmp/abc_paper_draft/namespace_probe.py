#!/usr/bin/env python3
"""Create a LibreOffice-compatibility probe by trimming unused namespaces."""

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path("/Users/nohsungbeen/dev/project/2026-2-ABC-hackathon/.codex_tmp/abc_paper_draft")
SOURCE = ROOT / "template_font_probe.docx"
OUTPUT = ROOT / "template_font_probe_namespace_trimmed.docx"


with ZipFile(SOURCE, "r") as source, ZipFile(OUTPUT, "w", ZIP_DEFLATED) as target:
    for info in source.infolist():
        data = source.read(info.filename)
        if info.filename == "word/document.xml":
            xml = data.decode("utf-8")
            for namespace in ("cx", "cx1", "w15", "w16se"):
                xml = __import__("re").sub(
                    rf' xmlns:{namespace}="[^"]+"',
                    "",
                    xml,
                    count=1,
                )
            xml = xml.replace(
                'mc:Ignorable="w14 w15 w16se wp14"',
                'mc:Ignorable="w14 wp14"',
            )
            data = xml.encode("utf-8")
        target.writestr(info, data)

print(OUTPUT)
