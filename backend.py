from __future__ import annotations

import csv
import json
import mimetypes
import os
import re
import shutil
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pypdfium2 as pdfium
import zxingcpp
from PIL import Image, ImageFilter, ImageOps


ROOT = Path(__file__).resolve().parent
BARCODE_RE = re.compile(r"\d{8}|\d{12,14}")
MAX_WORKERS = min(max(1, (os.cpu_count() or 2) - 1), 4)
MASTER_PATH = ROOT / "\u5546\u54c1\u30de\u30b9\u30bf" / "\u5546\u54c1\u30de\u30b9\u30bf.csv"
SAMPLE_PDF_DIR = ROOT / "\u793e\u8ca9\u8868\u30b5\u30f3\u30d7\u30eb"
MASTER_BARCODE_COL = 1  # B column
MASTER_NAME_COL = 2  # C column
MASTER_COST_COL = 18  # S column, per user request
EAN13_FORMAT = zxingcpp.BarcodeFormat.EAN13
BINARIZERS = (
    zxingcpp.Binarizer.LocalAverage,
    zxingcpp.Binarizer.GlobalHistogram,
    zxingcpp.Binarizer.FixedThreshold,
    zxingcpp.Binarizer.BoolCast,
)
SKEW_ANGLES = (-10, -6, -2, 2, 6, 10)
_MASTER_CACHE: list[dict[str, Any]] | None = None
_MASTER_BARCODE_CACHE: set[str] | None = None


def employee_from_file_name(name: str) -> str:
    normalized = name.replace("\uff08", "(").replace("\uff09", ")")
    match = re.search(r"\(([^)]+)\)", normalized)
    if match:
        return match.group(1).strip()
    cleaned = re.sub(
        r"\d{4}\u5e74|\d+\u6708|\uff14\u6708|\u793e\u8ca9|\u30bf\u30b0|\u8868|\.pdf",
        "",
        normalized,
        flags=re.I,
    )
    return re.sub(r"\s+", "", cleaned).strip() or "\u793e\u54e1\u540d\u672a\u53d6\u5f97"


def normalize_barcode(value: Any) -> str:
    digits = re.sub(r"\D", "", str(value or ""))
    if len(digits) == 14 and digits.startswith("0"):
        return digits[1:]
    return digits


def pil_variants(image: Image.Image) -> list[tuple[str, Image.Image]]:
    gray = ImageOps.grayscale(image)
    autocontrast = ImageOps.autocontrast(gray)
    equalized = ImageOps.equalize(gray)
    sharpened = autocontrast.filter(ImageFilter.SHARPEN)
    return [
        ("original", image),
        ("autocontrast", autocontrast),
        ("equalized", equalized),
        ("sharpened", sharpened),
        ("binary_160", gray.point(lambda p: 0 if p < 160 else 255, "1")),
        ("binary_190", gray.point(lambda p: 0 if p < 190 else 255, "1")),
    ]


def position_key(result: Any, width: int, height: int) -> str:
    position = getattr(result, "position", None)
    if not position:
        return "0:0"
    text = str(position)
    nums = [float(n) for n in re.findall(r"\d+(?:\.\d+)?", text)]
    if len(nums) >= 8:
        xs = nums[0::2]
        ys = nums[1::2]
        x = sum(xs) / len(xs)
        y = sum(ys) / len(ys)
        return f"{round((x / width) * 100)}:{round((y / height) * 100)}"
    if len(nums) >= 2:
        return f"{round((nums[0] / width) * 100)}:{round((nums[1] / height) * 100)}"
    return "0:0"


def read_barcodes_from_image(image: Image.Image, employee: str, file_name: str, page_number: int) -> list[dict[str, Any]]:
    found: dict[str, dict[str, Any]] = {}
    for variant_name, variant in pil_variants(image):
        for binarizer in BINARIZERS:
            for result in zxingcpp.read_barcodes(
                variant,
                formats=EAN13_FORMAT,
                try_rotate=True,
                try_downscale=False,
                try_invert=True,
                binarizer=binarizer,
            ):
                barcode = normalize_barcode(result.text)
                if len(barcode) != 13:
                    continue
                pos = position_key(result, variant.width, variant.height)
                found[f"{barcode}:{pos}"] = {
                    "employee": employee,
                    "barcode": barcode,
                    "quantity": 1,
                    "fileName": file_name,
                    "page": page_number,
                    "position": pos,
                    "source": f"backend:{variant_name}:{binarizer.name}",
                    "format": str(result.format),
                }
    return list(found.values())


def skew_crops(image: Image.Image) -> list[tuple[str, Image.Image]]:
    width, height = image.size
    return [
        ("full", image),
        ("top", image.crop((0, 0, width, int(height * 0.48)))),
        ("right", image.crop((int(width * 0.62), 0, width, int(height * 0.62)))),
    ]


def read_skew_corrected_barcodes(image: Image.Image, employee: str, file_name: str, page_number: int) -> list[dict[str, Any]]:
    found: dict[str, dict[str, Any]] = {}
    for angle in SKEW_ANGLES:
        rotated = image.rotate(angle, expand=True, fillcolor="white")
        gray = ImageOps.grayscale(rotated)
        variants = [
            ("skew_auto", ImageOps.autocontrast(gray)),
            ("skew_sharpened", ImageOps.autocontrast(gray).filter(ImageFilter.SHARPEN)),
        ]
        for variant_name, variant in variants:
            for result in zxingcpp.read_barcodes(
                variant,
                formats=EAN13_FORMAT,
                try_rotate=True,
                try_downscale=False,
                try_invert=True,
                binarizer=zxingcpp.Binarizer.FixedThreshold,
            ):
                barcode = normalize_barcode(result.text)
                if len(barcode) != 13:
                    continue
                pos = position_key(result, variant.width, variant.height)
                key = f"{barcode}:{angle}:{pos}"
                found[key] = {
                    "employee": employee,
                    "barcode": barcode,
                    "quantity": 1,
                    "fileName": file_name,
                    "page": page_number,
                    "position": f"skew:full:{angle}:{pos}",
                    "source": f"backend:{variant_name}:FixedThreshold:skew_{angle}",
                    "format": str(result.format),
                }
    return list(found.values())


def is_suspicious_barcode(barcode: str, master_barcodes: set[str] | None) -> bool:
    if master_barcodes and barcode in master_barcodes:
        return False
    return len(barcode) == 13 and not barcode.startswith("290")


def extract_text_candidates(page: Any, employee: str, file_name: str, page_number: int) -> list[dict[str, Any]]:
    try:
        text = page.get_textpage().get_text_range()
    except Exception:
        text = ""

    records = []
    for match in BARCODE_RE.findall(text):
        barcode = normalize_barcode(match)
        if len(barcode) in (8, 12, 13):
            records.append(
                {
                    "employee": employee,
                    "barcode": barcode,
                    "quantity": 1,
                    "fileName": file_name,
                    "page": page_number,
                    "position": "text",
                    "source": "backend:text-layer",
                    "format": "TEXT",
                }
            )
    return records


def same_cluster(cluster: dict[str, Any], record: dict[str, Any]) -> bool:
    if not (
        cluster["employee"] == record["employee"]
        and cluster["barcode"] == record["barcode"]
        and cluster["fileName"] == record["fileName"]
        and cluster["page"] == record["page"]
    ):
        return False
    if str(cluster.get("position")).startswith("skew:") or str(record.get("position")).startswith("skew:"):
        return False
    if cluster.get("position") == "text" or record.get("position") == "text":
        return cluster.get("position") == record.get("position")
    try:
        cx, cy = [int(v) for v in str(cluster.get("position")).split(":", 1)]
        rx, ry = [int(v) for v in str(record.get("position")).split(":", 1)]
    except ValueError:
        return False
    return abs(cx - rx) <= 3 and abs(cy - ry) <= 3


def aggregate(records: list[dict[str, Any]], master_barcodes: set[str] | None = None) -> list[dict[str, Any]]:
    clusters: list[dict[str, Any]] = []
    for record in records:
        match = next((cluster for cluster in clusters if same_cluster(cluster, record)), None)
        if not match:
            match = {**record, "quantity": 1, "sources": []}
            clusters.append(match)
        if record.get("source") not in match["sources"]:
            match["sources"].append(record.get("source"))

    grouped: dict[str, dict[str, Any]] = {}
    for record in clusters:
        key = f"{record['employee']}|{record['barcode']}|{record['fileName']}"
        current = grouped.get(
            key,
            {
                "employee": record["employee"],
                "barcode": record["barcode"],
                "quantity": 0,
                "fileName": record["fileName"],
                "sources": [],
            },
        )
        current["quantity"] += 1
        for source in record.get("sources", [record.get("source")]):
            if source not in current["sources"]:
                current["sources"].append(source)
        grouped[key] = current
    items = list(grouped.values())
    if master_barcodes:
        items = [
            item
            for item in items
            if item["barcode"] in master_barcodes or not is_suspicious_barcode(item["barcode"], master_barcodes)
        ]
    return items


def scan_page(
    page: Any,
    employee: str,
    file_name: str,
    page_number: int,
    master_barcodes: set[str] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    records = extract_text_candidates(page, employee, file_name, page_number)
    before = len(records)

    image = page.render(scale=4).to_pil()
    records.extend(read_barcodes_from_image(image, employee, file_name, page_number))

    if any(is_suspicious_barcode(record["barcode"], master_barcodes) for record in records):
        existing_barcodes = {record["barcode"] for record in records}
        added_barcodes = set()
        for record in read_skew_corrected_barcodes(image, employee, file_name, page_number):
            barcode = record["barcode"]
            if barcode in existing_barcodes or barcode in added_barcodes:
                continue
            if master_barcodes and barcode not in master_barcodes:
                continue
            records.append(record)
            added_barcodes.add(barcode)

    # Expensive high-DPI retry only for pages where the fast pass found nothing.
    if len(records) == before:
        image = page.render(scale=6).to_pil()
        records.extend(read_barcodes_from_image(image, employee, file_name, page_number))

    return records, {"page": page_number, "found": len(records)}


def scan_pdf(path: Path, file_name: str) -> dict[str, Any]:
    employee = employee_from_file_name(file_name)
    master_barcodes = load_master_barcodes()
    records: list[dict[str, Any]] = []
    page_reports = []
    pdf = pdfium.PdfDocument(str(path))

    try:
        for page_index, page in enumerate(pdf):
            page_records, page_report = scan_page(page, employee, file_name, page_index + 1, master_barcodes)
            records.extend(page_records)
            page_reports.append(page_report)
    finally:
        pdf.close()

    scans = aggregate(records, master_barcodes)
    return {
        "fileName": file_name,
        "employee": employee,
        "count": sum(item["quantity"] for item in scans),
        "items": scans,
        "pages": page_reports,
    }


def parse_number(value: Any) -> float:
    text = str(value or "").replace(",", "").strip()
    try:
        return float(text)
    except ValueError:
        return 0.0


def load_master(path: Path = MASTER_PATH) -> list[dict[str, Any]]:
    global _MASTER_CACHE
    if path == MASTER_PATH and _MASTER_CACHE is not None:
        return _MASTER_CACHE

    if not path.exists():
        return []

    items: list[dict[str, Any]] = []
    with path.open("r", encoding="cp932", newline="") as f:
        reader = csv.reader(f)
        next(reader, None)
        for row in reader:
            if len(row) <= MASTER_COST_COL:
                continue
            barcode = normalize_barcode(row[MASTER_BARCODE_COL])
            cost = parse_number(row[MASTER_COST_COL])
            if not barcode:
                continue
            items.append(
                {
                    "barcode": barcode,
                    "name": row[MASTER_NAME_COL] if len(row) > MASTER_NAME_COL else "",
                    "price": cost,
                    "cost": cost,
                }
            )
    if path == MASTER_PATH:
        _MASTER_CACHE = items
    return items


def load_master_barcodes() -> set[str]:
    global _MASTER_BARCODE_CACHE
    if _MASTER_BARCODE_CACHE is None:
        _MASTER_BARCODE_CACHE = {item["barcode"] for item in load_master()}
    return _MASTER_BARCODE_CACHE


def scan_jobs(jobs: list[tuple[Path, str]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    reports = []
    all_items = []
    workers = min(len(jobs) or 1, MAX_WORKERS)
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(scan_pdf, pdf_path, file_name) for pdf_path, file_name in jobs]
        for future in as_completed(futures):
            report = future.result()
            reports.append({k: v for k, v in report.items() if k != "items"})
            all_items.extend(report["items"])
    reports.sort(key=lambda item: item["fileName"])
    all_items.sort(key=lambda item: (item["employee"], item["fileName"], item["barcode"]))
    return reports, all_items


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self) -> None:
        request_path = self.path.split("?", 1)[0]
        if request_path == "/api/master":
            try:
                items = load_master()
                self.write_json(
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "items": items,
                        "count": len(items),
                        "source": str(MASTER_PATH),
                        "columns": {"barcode": "B", "name": "C", "cost": "S"},
                    },
                )
            except Exception as exc:
                traceback.print_exc()
                self.write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)})
            return
        if request_path == "/api/scan-samples":
            try:
                jobs = [(path, path.name) for path in sorted(SAMPLE_PDF_DIR.glob("*.pdf"), key=lambda p: p.name)]
                reports, all_items = scan_jobs(jobs)
                self.write_json(
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "items": all_items,
                        "files": reports,
                        "source": str(SAMPLE_PDF_DIR),
                    },
                )
            except Exception as exc:
                traceback.print_exc()
                self.write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)})
            return
        super().do_GET()

    def do_POST(self) -> None:
        if self.path != "/api/scan-pdfs":
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        try:
            fields = self.read_uploaded_files()
            reports = []
            all_items = []
            tmp_dir = ROOT / ".scan_tmp" / uuid.uuid4().hex
            tmp_dir.mkdir(parents=True, exist_ok=True)
            try:
                jobs = []
                for index, field in enumerate(fields):
                    file_name = Path(field.filename).name
                    pdf_path = tmp_dir / f"upload_{index}.pdf"
                    pdf_path.write_bytes(field.file.read())
                    jobs.append((pdf_path, file_name))

                reports, all_items = scan_jobs(jobs)
            finally:
                shutil.rmtree(tmp_dir, ignore_errors=True)

            self.write_json(HTTPStatus.OK, {"ok": True, "items": all_items, "files": reports})
        except Exception as exc:
            traceback.print_exc()
            self.write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)})

    def read_uploaded_files(self) -> list[Any]:
        from multipart import create_form_parser

        files: list[Any] = []

        def on_file(f: Any) -> None:
            f.file_object.seek(0)
            files.append(f)

        headers = {k.lower(): v.encode() if isinstance(v, str) else v for k, v in self.headers.items()}
        parser = create_form_parser(headers, None, on_file)
        content_length = int(self.headers.get("Content-Length", "0"))
        parser.write(self.rfile.read(content_length))
        parser.finalize()

        result = []
        for f in files:
            raw_name = f.file_name
            if not raw_name:
                continue
            filename = raw_name.decode() if isinstance(raw_name, bytes) else raw_name

            class _Wrap:
                def __init__(self, name: str, fo: Any) -> None:
                    self.filename = name
                    self.file = fo

            result.append(_Wrap(filename, f.file_object))
        return result

    def write_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def translate_path(self, path: str) -> str:
        clean = path.split("?", 1)[0].split("#", 1)[0].lstrip("/")
        if clean in ("", "/"):
            clean = "index.html"
        target = (ROOT / clean).resolve()
        if ROOT not in target.parents and target != ROOT:
            return str(ROOT / "index.html")
        return str(target)

    def guess_type(self, path: str) -> str:
        if path.endswith(".js"):
            return "text/javascript; charset=utf-8"
        guessed = mimetypes.guess_type(path)[0]
        if guessed and guessed.startswith("text/"):
            return f"{guessed}; charset=utf-8"
        return guessed or "application/octet-stream"


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 8000), Handler)
    print("Staff sale scanner running at http://127.0.0.1:8000", flush=True)
    print("POST PDFs to http://127.0.0.1:8000/api/scan-pdfs", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
