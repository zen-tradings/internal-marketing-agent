#!/usr/bin/env python3
"""Restricted Yahoo/yfinance calendar worker for Zen Opening Digest.

The worker accepts one JSON object on stdin and emits one JSON object on stdout.
It never accepts a URL or ticker list. The only network action is a bounded
yfinance earnings-calendar query for a validated date range of at most 7 days.
"""

from __future__ import annotations

import json
import math
import re
import sys
from datetime import date, datetime, timezone
from typing import Any


def main() -> None:
    if sys.version_info < (3, 11):
        fail("Python 3.11 or newer is required")
    try:
        request = json.load(sys.stdin)
    except Exception as exc:  # pragma: no cover - process boundary
        fail(f"invalid worker input: {exc}")
    try:
        action = str(request.get("action") or "")
        if action == "self_test":
            import_dependencies()
            fixture = normalize_rows(
                [
                    (
                        "ZEN",
                        {
                            "Company": "Zen Example",
                            "Marketcap": 1_000_000_000,
                            "Event Name": "Earnings Date",
                            "Event Start Date": "2026-08-13T20:00:00+00:00",
                            "Timing": "AMC",
                            "EPS Estimate": 1.25,
                            "Reported EPS": None,
                            "Surprise(%)": None,
                        },
                    )
                ]
            )
            if len(fixture) != 1 or fixture[0]["symbol"] != "ZEN":
                raise ValueError("normalization self-test failed")
            result = {"ok": True, "python": sys.version.split()[0]}
        elif action == "query":
            result = query_calendar(request)
        else:
            raise ValueError(f"unsupported action: {action}")
    except Exception as exc:
        fail(str(exc))
    json.dump(result, sys.stdout, ensure_ascii=False, allow_nan=False)


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def import_dependencies() -> None:
    import pandas  # noqa: F401
    import yfinance  # noqa: F401


def query_calendar(request: dict[str, Any]) -> dict[str, Any]:
    import yfinance as yf

    start_date = validated_date(request.get("startDate"), "startDate")
    end_date = validated_date(request.get("endDate"), "endDate")
    if end_date < start_date or (end_date - start_date).days > 7:
        raise ValueError("earnings date range must be ordered and no longer than 7 days")
    limit = request.get("limit", 100)
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100:
        raise ValueError("limit must be an integer from 1 through 100")

    frame = yf.Calendars(start=start_date, end=end_date).get_earnings_calendar(
        filter_most_active=False,
        limit=limit,
    )
    rows = [] if frame is None or frame.empty else list(frame.iterrows())
    candidates = normalize_rows(rows)
    candidates.sort(
        key=lambda item: (
            -(item.get("marketCap") or 0),
            item.get("eventStartDate") or "",
            item.get("symbol") or "",
        )
    )
    return {
        "schemaVersion": 1,
        "provider": "yfinance-yahoo",
        "capturedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "startDate": start_date.isoformat(),
        "endDate": end_date.isoformat(),
        "candidates": candidates,
    }


def validated_date(value: Any, label: str) -> date:
    text = str(value or "")
    if not re.fullmatch(r"20\d{2}-\d{2}-\d{2}", text):
        raise ValueError(f"{label} must be YYYY-MM-DD")
    try:
        return date.fromisoformat(text)
    except ValueError as exc:
        raise ValueError(f"invalid {label}: {text}") from exc


def normalize_rows(rows: list[tuple[Any, Any]]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw_symbol, row in rows:
        symbol = clean(raw_symbol).upper()
        if not re.fullmatch(r"[A-Z0-9][A-Z0-9.\-]{0,14}", symbol) or symbol in seen:
            continue
        event_start = iso_datetime(row.get("Event Start Date"))
        if not event_start:
            continue
        seen.add(symbol)
        timing = clean(row.get("Timing")).upper()
        output.append(
            {
                "symbol": symbol,
                "company": clean(row.get("Company"))[:240],
                "marketCap": finite_number(row.get("Marketcap")),
                "eventName": clean(row.get("Event Name"))[:120],
                "eventStartDate": event_start,
                "timing": timing if timing in {"BMO", "AMC", "TNS", "TAS"} else "",
                "epsEstimate": finite_number(row.get("EPS Estimate")),
                "reportedEps": finite_number(row.get("Reported EPS")),
                "surprisePct": finite_number(row.get("Surprise(%)")),
            }
        )
    return output


def iso_datetime(value: Any) -> str:
    if value is None:
        return ""
    if hasattr(value, "to_pydatetime"):
        value = value.to_pydatetime()
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    text = clean(value)
    if not text:
        return ""
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return ""
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def finite_number(value: Any) -> float | int | None:
    if value is None:
        return None
    if hasattr(value, "item"):
        value = value.item()
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return int(number) if number.is_integer() else number


def clean(value: Any) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


if __name__ == "__main__":
    main()
