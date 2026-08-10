#!/usr/bin/env python3
"""Restricted AKShare/PDF worker for the Zen QDII holdings workflow.

The worker reads one JSON object from stdin and writes one JSON object to stdout.
It never accepts or downloads URLs. Network access is limited to the fixed AKShare
functions in the ``query`` action; PDF extraction only opens a validated local path.
"""

from __future__ import annotations

import json
import math
import os
import re
import sys
from pathlib import Path
from typing import Any, Iterable


def main() -> None:
    if sys.version_info < (3, 11):
        fail("Python 3.11 or newer is required")
    try:
        request = json.load(sys.stdin)
    except Exception as exc:  # pragma: no cover - exercised by process boundary
        fail(f"invalid worker input: {exc}")
    action = str(request.get("action") or "")
    try:
        if action == "self_test":
            import_dependencies()
            result = {"ok": True, "python": sys.version.split()[0]}
        elif action == "query":
            result = query_funds(request)
        elif action == "extract_pdf":
            result = extract_pdf(request)
        else:
            raise ValueError(f"unsupported action: {action}")
    except Exception as exc:
        fail(str(exc))
    json.dump(result, sys.stdout, ensure_ascii=False, allow_nan=False)


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def import_dependencies() -> None:
    import akshare  # noqa: F401
    import camelot  # noqa: F401
    import pandas  # noqa: F401
    import pdfplumber  # noqa: F401
    import pypdf  # noqa: F401


def query_funds(request: dict[str, Any]) -> dict[str, Any]:
    import akshare as ak

    codes = request.get("fundCodes")
    if not isinstance(codes, list) or not codes or len(codes) > 20:
        raise ValueError("fundCodes must contain 1-20 codes")
    normalized_codes = [validate_fund_code(code) for code in codes]
    year = str(request.get("year") or "")
    if year and not re.fullmatch(r"20\d{2}", year):
        raise ValueError("year must be empty or YYYY")

    names = None
    funds: list[dict[str, Any]] = []
    for code in normalized_codes:
        try:
            overview = dataframe_first_record(ak.fund_overview_em(symbol=code))
        except Exception:
            overview = {}
        fund_name = first_value(overview, "基金全称", "基金简称", "基金名称")
        fund_type = first_value(overview, "基金类型", "类型")
        manager = first_value(overview, "基金管理人", "基金管理公司", "基金公司")
        official_website = first_value(overview, "基金公司网址", "管理人网址", "官方网站")
        if not fund_name:
            try:
                if names is None:
                    names = ak.fund_name_em()
                match = names.loc[names["基金代码"].astype(str).str.zfill(6) == code]
                if not match.empty:
                    fund_name = clean(match.iloc[0].get("基金简称"))
                    fund_type = clean(match.iloc[0].get("基金类型"))
            except Exception:
                pass
        try:
            holdings = ak.fund_portfolio_hold_em(symbol=code, date=year)
            rows = normalize_akshare_rows(holdings)
            error = ""
        except Exception as exc:
            rows = []
            error = str(exc)[:500]
        funds.append(
            {
                "requested_code": code,
                "fund_code": code,
                "master_code": code,
                "fund_name": fund_name,
                "fund_type": fund_type,
                "manager": manager,
                "official_website": official_website,
                "is_qdii": bool(re.search(r"QDII|海外", f"{fund_name} {fund_type}", re.I)),
                "rows": rows,
                **({"error": error} if error and not rows else {}),
            }
        )
    return {"funds": funds}


def validate_fund_code(value: Any) -> str:
    code = str(value or "")
    if not re.fullmatch(r"\d{6}", code):
        raise ValueError(f"invalid six-digit fund code: {code}")
    return code


def dataframe_first_record(frame: Any) -> dict[str, Any]:
    if frame is None or frame.empty:
        return {}
    return {str(key): json_scalar(value) for key, value in frame.iloc[0].to_dict().items()}


def normalize_akshare_rows(frame: Any) -> list[dict[str, Any]]:
    if frame is None or frame.empty:
        return []
    output: list[dict[str, Any]] = []
    for _, row in frame.iterrows():
        output.append(
            {
                "rank": json_scalar(row.get("序号")),
                "security_code": clean(row.get("股票代码")),
                "security_name": clean(row.get("股票名称")),
                "nav_ratio_pct": json_scalar(row.get("占净值比例")),
                "market_value": json_scalar(row.get("持仓市值")),
                "report_label": clean(row.get("季度")),
            }
        )
    return output


def json_scalar(value: Any) -> Any:
    if value is None:
        return None
    try:
        if math.isnan(value):
            return None
    except (TypeError, ValueError):
        pass
    if hasattr(value, "item"):
        value = value.item()
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def first_value(record: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = clean(record.get(key))
        if value:
            return value
    return ""


def extract_pdf(request: dict[str, Any]) -> dict[str, Any]:
    import camelot
    import pdfplumber
    from pypdf import PdfReader

    pdf_path = Path(str(request.get("pdfPath") or "")).resolve()
    if not pdf_path.is_absolute() or not pdf_path.is_file() or pdf_path.suffix.lower() != ".pdf":
        raise ValueError("pdfPath must be an existing absolute local PDF")
    if pdf_path.stat().st_size > 30 * 1024 * 1024:
        raise ValueError("PDF exceeds worker size limit")
    with pdf_path.open("rb") as handle:
        if b"%PDF-" not in handle.read(1024):
            raise ValueError("local file is not a real PDF")

    reader = PdfReader(str(pdf_path))
    if len(reader.pages) > 300:
        raise ValueError("PDF exceeds 300-page extraction limit")
    page_texts = [(page.extract_text() or "") for page in reader.pages]
    full_text = "\n".join(page_texts)
    compact_text = re.sub(r"\s+", "", full_text)
    scan_detected = len(compact_text) < max(400, len(reader.pages) * 40)

    code = validate_fund_code(request.get("fundCode"))
    master_code = validate_fund_code(request.get("masterCode") or code)
    fund_name = clean(request.get("fundName"))
    manager = clean(request.get("manager"))
    code_verified = code in compact_text or master_code in compact_text
    corroborated = not fund_name and not manager
    if fund_name:
        tokens = [token for token in re.split(r"[（）()\s]+", fund_name) if len(token) >= 4]
        corroborated = corroborated or any(re.sub(r"\s+", "", token) in compact_text for token in tokens)
    if manager:
        manager_token = re.sub(r"(?:股份)?有限公司$", "", manager)
        corroborated = corroborated or (len(manager_token) >= 4 and manager_token in compact_text)
    identity_verified = code_verified and corroborated

    report_label = find_report_label(compact_text)
    candidate_pages = candidate_page_numbers(page_texts)
    holdings: list[dict[str, Any]] = []
    market_unit = find_market_unit(full_text)
    if not scan_detected:
        with pdfplumber.open(str(pdf_path)) as pdf:
            inherited_mapping: dict[str, int] | None = None
            for page_number in candidate_pages:
                for table in pdf.pages[page_number - 1].extract_tables() or []:
                    detected_mapping = table_header_mapping(table)
                    if detected_mapping:
                        inherited_mapping = detected_mapping
                    holdings.extend(parse_table(table, inherited_mapping=inherited_mapping))
        holdings = dedupe_rows(holdings)
        if not holdings:
            page_spec = ",".join(str(number) for number in candidate_pages[:12]) or "1-end"
            for flavor in ("lattice", "stream"):
                try:
                    tables = camelot.read_pdf(str(pdf_path), pages=page_spec, flavor=flavor)
                    for table in tables:
                        holdings.extend(parse_table(table.df.values.tolist()))
                    holdings = dedupe_rows(holdings)
                    if holdings:
                        break
                except Exception:
                    continue

    requested_period = request.get("reportPeriod") or {}
    period_type = str(requested_period.get("type") or "")
    complete_heading = bool(re.search(r"(?:所有|全部)(?:股票|权益)投资明细|所有权益投资", compact_text))
    disclosure_scope = "full" if period_type in {"H1", "FY"} and len(holdings) > 10 and complete_heading else "top10"
    return {
        "identity_verified": identity_verified,
        "scan_detected": scan_detected,
        "fund_name": fund_name,
        "master_code": master_code,
        "manager": manager,
        "report_label": report_label,
        "disclosure_scope": disclosure_scope,
        "market_value_currency": "CNY" if "人民币" in market_unit else "source",
        "market_value_unit": market_unit or "source unit",
        "holdings": holdings,
        "candidate_pages": candidate_pages,
    }


def find_report_label(compact_text: str) -> str:
    patterns = [
        r"(20\d{2}年(?:第?[一二三四1234]季度|半年度|中期|年度)报告)",
        r"((?:第一|第二|第三|第四)季度报告)",
    ]
    for pattern in patterns:
        match = re.search(pattern, compact_text)
        if match:
            return match.group(1)
    return ""


def candidate_page_numbers(page_texts: list[str]) -> list[int]:
    pattern = re.compile(r"股票投资明细|权益投资明细|公允价值占基金资产净值|占基金资产净值比例")
    pages = {index + 1 for index, text in enumerate(page_texts) if pattern.search(text)}
    expanded = set(pages)
    for page in pages:
        if page > 1:
            expanded.add(page - 1)
        if page < len(page_texts):
            expanded.add(page + 1)
    return sorted(expanded)[:30]


def find_market_unit(text: str) -> str:
    match = re.search(r"(?:金额)?单位\s*[:：]\s*(人民币)?\s*(元|万元|百万元)", text)
    if not match:
        return ""
    return f"{match.group(1) or ''}{match.group(2)}"


def table_header_mapping(table: Iterable[Iterable[Any]]) -> dict[str, int] | None:
    rows = [[cell_text(cell) for cell in row] for row in table if row]
    for row in rows[:8]:
        combined = re.sub(r"\s+", "", "|".join(row))
        if "代码" not in combined or "名称" not in combined or not ("净值" in combined or "比例" in combined):
            continue
        mapping = header_mapping(row)
        if {"code", "name", "ratio"}.issubset(mapping):
            return mapping
    return None


def parse_table(
    table: Iterable[Iterable[Any]], inherited_mapping: dict[str, int] | None = None
) -> list[dict[str, Any]]:
    rows = [[cell_text(cell) for cell in row] for row in table if row]
    header_index = None
    mapping: dict[str, int] = {}
    for index, row in enumerate(rows[:8]):
        combined = re.sub(r"\s+", "", "|".join(row))
        if "代码" not in combined or "名称" not in combined or not ("净值" in combined or "比例" in combined):
            continue
        header_index = index
        mapping = header_mapping(row)
        if {"code", "name", "ratio"}.issubset(mapping):
            break
    if header_index is None:
        if not inherited_mapping or not {"code", "name", "ratio"}.issubset(inherited_mapping):
            return []
        header_index = -1
        mapping = inherited_mapping
    output: list[dict[str, Any]] = []
    previous_name = ""
    previous_rank: float | None = None
    for row in rows[header_index + 1 :]:
        if len(row) <= max(mapping.values()):
            continue
        code = compact_security_code(row[mapping["code"]])
        name = compact_security_name(row[mapping["name"]])
        ratio = parse_number(row[mapping["ratio"]])
        market_value = parse_number(row[mapping["value"]]) if "value" in mapping else None
        rank = parse_number(row[mapping["rank"]]) if "rank" in mapping else len(output) + 1
        if name:
            previous_name = name
        elif code:
            name = previous_name
        if rank is not None:
            previous_rank = rank
        elif code:
            rank = previous_rank
        if not code or not name or ratio is None or ratio < 0 or ratio > 100:
            continue
        output.append(
            {
                "rank": int(rank) if rank is not None and rank > 0 else len(output) + 1,
                "security_code": code,
                "security_name": name,
                "nav_ratio_pct": ratio,
                "market_value": market_value,
            }
        )
    return output


def header_mapping(row: list[str]) -> dict[str, int]:
    mapping: dict[str, int] = {}
    for index, value in enumerate(row):
        compact = re.sub(r"\s+", "", value)
        if "序号" in compact and "rank" not in mapping:
            mapping["rank"] = index
        if ("证券代码" in compact or "股票代码" in compact or compact == "代码") and "code" not in mapping:
            mapping["code"] = index
        if "名称" in compact and "name" not in mapping:
            mapping["name"] = index
        if ("占基金资产净值比例" in compact or "占净值比例" in compact or ("净值" in compact and "比例" in compact)) and "ratio" not in mapping:
            mapping["ratio"] = index
        if ("公允价值" in compact or "持仓市值" in compact or compact == "市值") and "value" not in mapping:
            mapping["value"] = index
    return mapping


def dedupe_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for row in rows:
        key = (str(row.get("security_code")), str(row.get("security_name")))
        if key in seen:
            continue
        seen.add(key)
        output.append(row)
    return output


def parse_number(value: Any) -> float | None:
    text = re.sub(r"[,，%\s]", "", clean(value))
    if not text or text in {"-", "—", "N/A"}:
        return None
    match = re.search(r"-?\d+(?:\.\d+)?", text)
    if not match:
        return None
    try:
        return float(match.group(0))
    except ValueError:
        return None


def cell_text(value: Any) -> str:
    return clean(value).replace("\r", " ").replace("\n", " ")


def compact_cell(value: Any) -> str:
    return re.sub(r"\s+", " ", clean(value)).strip()


def compact_security_code(value: Any) -> str:
    raw = clean(value)
    compact = re.sub(r"\s+", "", raw)
    if re.search(r"\s", raw):
        compact = re.sub(r"(?:US|HK|LN|JP|KS|AU|CN)$", "", compact, flags=re.I)
    return compact


def compact_security_name(value: Any) -> str:
    tokens = compact_cell(value).split(" ")
    output: list[str] = []
    for token in tokens:
        if output and len(token) == 1 and token.islower() and "." in output[-1]:
            output[-1] += token
        else:
            output.append(token)
    return " ".join(output)


def clean(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    return "" if text.lower() == "nan" else text


if __name__ == "__main__":
    main()
