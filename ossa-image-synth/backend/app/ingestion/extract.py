"""Format adapters: turn an uploaded file into text pages + tables with source references.

Each adapter declares whether it is actually implemented. DWG/RVT adapters only identify the file;
they do not pretend to parse it.
"""
from __future__ import annotations

import csv
import io
from dataclasses import dataclass, field

from PIL import Image

from ..config import settings

SUPPORTED_EXT = {"pdf", "png", "jpg", "jpeg", "webp", "csv", "xlsx", "txt", "md", "text", "spec"}
CAD_EXT = {"dwg", "rvt", "dxf", "rfa"}
IMAGE_EXT = {"png", "jpg", "jpeg", "webp"}
MAX_PDF_PAGES = 300


@dataclass
class Table:
    ref: str  # e.g. "page 2 table 1", "Sheet1"
    rows: list[list[str]]
    row_refs: list[str] = field(default_factory=list)


@dataclass
class Extracted:
    kind: str  # pdf|image|table|text|cad
    pages: list[tuple[str, str]] = field(default_factory=list)  # (ref, text)
    tables: list[Table] = field(default_factory=list)
    image: dict | None = None
    page_count: int = 0
    warnings: list[str] = field(default_factory=list)
    unsupported: str = ""

    @property
    def full_text(self) -> str:
        return "\n".join(t for _, t in self.pages)


def _clean(v) -> str:
    if v is None:
        return ""
    s = str(v).replace("\r", " ").replace("\n", " ").strip()
    return " ".join(s.split())


def extract_pdf(data: bytes) -> Extracted:
    import pdfplumber

    out = Extracted(kind="pdf")
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        out.page_count = len(pdf.pages)
        if out.page_count > MAX_PDF_PAGES:
            out.warnings.append(f"Only the first {MAX_PDF_PAGES} of {out.page_count} pages were processed.")
        for i, page in enumerate(pdf.pages[:MAX_PDF_PAGES], start=1):
            text = page.extract_text() or ""
            out.pages.append((f"page {i}", text))
            try:
                for t_i, tbl in enumerate(page.extract_tables() or [], start=1):
                    rows = [[_clean(c) for c in r] for r in tbl if r and any(c for c in r)]
                    if rows:
                        out.tables.append(Table(ref=f"page {i} table {t_i}", rows=rows,
                                                row_refs=[f"page {i} table {t_i} row {n}" for n in range(1, len(rows) + 1)]))
            except Exception as e:  # pragma: no cover - pdfplumber edge cases
                out.warnings.append(f"Table extraction failed on page {i}: {e}")
    if not out.full_text.strip():
        out.warnings.append("PDF has no text layer (scanned drawing?). OCR is not supported yet; enter data manually or upload a text-based export.")
    return out


def extract_image(data: bytes) -> Extracted:
    out = Extracted(kind="image")
    Image.MAX_IMAGE_PIXELS = settings.max_image_pixels
    with Image.open(io.BytesIO(data)) as im:
        im.verify()
    with Image.open(io.BytesIO(data)) as im:
        out.image = {"width": im.width, "height": im.height, "mode": im.mode, "format": im.format}
    out.page_count = 1
    return out


def extract_csv(data: bytes) -> Extracted:
    text = data.decode("utf-8-sig", errors="replace")
    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    rows = [[_clean(c) for c in r] for r in csv.reader(io.StringIO(text), dialect)]
    rows = [r for r in rows if any(r)]
    out = Extracted(kind="table", page_count=1)
    out.tables.append(Table(ref="csv", rows=rows, row_refs=[f"row {n}" for n in range(1, len(rows) + 1)]))
    out.pages.append(("csv", "\n".join(" | ".join(r) for r in rows)))
    return out


def extract_xlsx(data: bytes) -> Extracted:
    import openpyxl

    wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    out = Extracted(kind="table")
    for ws in wb.worksheets:
        rows, refs = [], []
        for idx, r in enumerate(ws.iter_rows(values_only=True), start=1):
            vals = [_clean(c) for c in r]
            if any(vals):
                rows.append(vals)
                refs.append(f"sheet '{ws.title}' row {idx}")
            if idx > 20000:
                out.warnings.append(f"Sheet {ws.title}: truncated at 20000 rows")
                break
        if rows:
            out.tables.append(Table(ref=f"sheet '{ws.title}'", rows=rows, row_refs=refs))
            out.pages.append((f"sheet '{ws.title}'", "\n".join(" | ".join(r) for r in rows)))
    out.page_count = len(wb.worksheets)
    wb.close()
    return out


def extract_text(data: bytes) -> Extracted:
    text = data.decode("utf-8-sig", errors="replace")
    out = Extracted(kind="text", page_count=1)
    # Keep line numbers as source references.
    out.pages.append(("text", text))
    return out


def identify_cad(ext: str, data: bytes) -> Extracted:
    out = Extracted(kind="cad")
    if ext == "dwg":
        ver = data[:6].decode("ascii", errors="replace")
        out.unsupported = (f"DWG file recognised (header '{ver}'). Native DWG parsing is not implemented: "
                           "no licensed DWG reader (e.g. ODA Teigha / Autodesk Platform Services) is configured. "
                           "Export the relevant sheets to PDF and upload those.")
    elif ext in ("rvt", "rfa"):
        ole = data[:8] == bytes.fromhex("D0CF11E0A1B11AE1")
        out.unsupported = (f"Revit file recognised ({'OLE container' if ole else 'unrecognised header'}). "
                           "Native RVT parsing requires Autodesk Platform Services (Model Derivative API), which is not "
                           "configured. Export schedules to CSV/XLSX and sheets to PDF instead.")
    else:
        out.unsupported = f".{ext} CAD files are not parsed. Export to PDF."
    return out


def extract(ext: str, data: bytes) -> Extracted:
    ext = ext.lower()
    if ext == "pdf":
        return extract_pdf(data)
    if ext in IMAGE_EXT:
        return extract_image(data)
    if ext == "csv":
        return extract_csv(data)
    if ext == "xlsx":
        return extract_xlsx(data)
    if ext in ("txt", "md", "text", "spec"):
        return extract_text(data)
    if ext in CAD_EXT:
        return identify_cad(ext, data)
    out = Extracted(kind="unknown")
    out.unsupported = f"File type .{ext} is not supported."
    return out
