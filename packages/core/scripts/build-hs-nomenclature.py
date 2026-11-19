#!/usr/bin/env python3
"""Build packages/core/src/hs-nomenclature.json.gz from the saved Order No. 21 annex."""
import argparse
from collections import Counter
import gzip
import hashlib
from io import BytesIO
import json
from pathlib import Path
import re
from xml.etree import ElementTree as ET
from zipfile import ZipFile

SHA256 = "7fee741dfcb966846e572580cdc96733528c548c2b75b1554691414971a2e51d"
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
LENGTHS = (4, 6, 8, 9, 11)
OUTPUT = Path(__file__).resolve().parents[1] / "src" / "hs-nomenclature.json.gz"


def cell_text(cell):
    parts = []
    for paragraph in cell.findall(W + "p"):
        parts.append("".join(
            (node.text or "") if node.tag == W + "t" else " "
            for node in paragraph.iter()
            if node.tag in (W + "t", W + "br", W + "tab", W + "cr")
        ))
    return " ".join(" ".join(parts).split())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("docx", type=Path)
    args = parser.parse_args()
    source = args.docx.read_bytes()
    actual = hashlib.sha256(source).hexdigest()
    if actual != SHA256:
        parser.error(f"expected SHA-256 {SHA256}, got {actual}")

    with ZipFile(BytesIO(source)) as docx:
        root = ET.fromstring(docx.read("word/document.xml"))
    counts = Counter({length: 0 for length in LENGTHS})
    entries = {}
    skipped = 0
    tables = root.findall(".//" + W + "tbl")
    for table in tables:
        for row in table.findall(W + "tr"):
            cells = row.findall(W + "tc")
            code = cell_text(cells[0]).replace(" ", "") if len(cells) == 3 else ""
            if len(code) not in LENGTHS or not re.fullmatch(r"[0-9]+", code):
                skipped += 1
                continue
            description = cell_text(cells[1])
            leader = re.match(r"^(?:[–—-] *)*", description)[0]
            unit = cell_text(cells[2])
            entry = [code, description[len(leader):], sum(c != " " for c in leader)]
            if unit and unit != "—":
                entry.append(unit)
            if code in entries or not entry[1]:
                raise ValueError(f"duplicate code or empty description: {code}")
            entries[code] = entry
            counts[len(code)] += 1

    subheadings = {code[:6] for code in entries if len(code) >= 6}
    if subheadings != {code[:6] for code in entries if len(code) == 11}:
        raise ValueError("a subheading has no national codes")

    data = {
        "edition": {
            "orderNumber": 21,
            "orderDate": "2024-01-26",
            "publishedDate": "2024-01-30",
            "inForceFrom": "2024-01-26",
            "title": "საგარეო-ეკონომიკური საქმიანობის ეროვნული სასაქონლო ნომენკლატურის (სეს ესნ) დამტკიცების თაობაზე",
            "documentId": 6086072,
            "publication": 0,
            "laterAmendmentsVerified": False,
        },
        "sourceUrl": "https://matsne.gov.ge/ka/document/download/6086072/0/1",
        "sha256": SHA256,
        "fetchedOn": "2026-11-19",
        "countsByLength": dict(counts),
        "skippedRows": skipped,
        "entries": sorted(entries.values()),
    }
    payload = (json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    with OUTPUT.open("wb") as target, gzip.GzipFile(filename="", fileobj=target, mode="wb", mtime=0) as compressed:
        compressed.write(payload)
    print(f"{len(entries)} entries in {len(tables)} tables ({dict(counts)}), {skipped} rows skipped")


if __name__ == "__main__":
    main()
