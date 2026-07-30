#!/usr/bin/env python3
"""Summarize structural writing evidence from an AI article catalog."""

from __future__ import annotations

import argparse
import json
import re
import statistics
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable


FINAL_PUNCTUATION = "。！？；：，,.!?;:）)」』”\""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--articles", type=Path, required=True)
    parser.add_argument(
        "--cohort-index",
        type=Path,
        help="Optional index whose IDs identify the newly added corpus cohort.",
    )
    parser.add_argument("--out", type=Path, required=True)
    return parser.parse_args()


def median(values: Iterable[int | float]) -> float:
    items = list(values)
    return statistics.median(items) if items else 0


def percentile(values: Iterable[int], ratio: float) -> int:
    items = sorted(values)
    if not items:
        return 0
    index = round((len(items) - 1) * ratio)
    return items[index]


def article_body(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    parts = re.split(r"\n---\s*\n", text, maxsplit=1)
    return parts[1] if len(parts) == 2 else text


def paragraphs(body: str) -> list[str]:
    result = []
    for raw in re.split(r"\n\s*\n", body):
        text = " ".join(raw.split()).strip()
        if not text or text.startswith("![图片]") or text.startswith("题图来源"):
            continue
        result.append(text)
    return result


def is_heading(text: str) -> bool:
    if not (2 <= len(text) <= 38):
        return False
    if text.endswith(tuple(FINAL_PUNCTUATION)):
        return False
    if re.match(r"^(晚点|[A-Za-z\u4e00-\u9fff]{2,12})\s*[：:]", text):
        return False
    if re.match(r"^[“\"].+[”\"]$", text):
        return False
    if re.search(r"题图|对本文亦有贡献|来源", text):
        return False
    return True


def title_features(title: str) -> list[str]:
    features: list[str] = []
    if re.search(r"\d", title):
        features.append("数字")
    if "：" in title or ":" in title:
        features.append("冒号双层标题")
    if "？" in title or "?" in title:
        features.append("问题")
    if re.search(r"[“”\"]", title):
        features.append("引语/概念加引号")
    if re.search(r"从.+到", title):
        features.append("从…到…")
    if re.search(r"但|不再|不是|没有|拒绝|错过|困局|难题|挑战", title):
        features.append("反差/否定")
    if re.search(r"晚点独家|独家丨", title):
        features.append("独家标识")
    if "丨" in title:
        features.append("栏目后缀")
    return features or ["陈述式"]


def opening_feature(first: str) -> str:
    if re.match(r"^(19|20)\d{2}\s*年|^\d{1,2}\s*月|^(今年|去年|过去|最近|当地时间)", first):
        return "时间锚点"
    if re.match(r"^[“\"]", first):
        return "引语开场"
    if re.search(r"发布|宣布|完成|加入|离职|成立|融资|上市|调整", first[:100]):
        return "关键事实"
    if re.search(r"办公室|会议|现场|会场|工厂|实验室|凌晨|晚上|走进|站在", first[:100]):
        return "场景"
    return "判断/背景"


def ending_feature(last: str) -> str:
    if re.search(r"[”\"]$", last):
        return "引语收尾"
    if last.endswith(("？", "?")):
        return "问题收尾"
    if re.search(r"未来|接下来|最终|仍然|依然|才刚|开始|等待|考验|挑战", last):
        return "前景/悬念"
    if re.search(r"但|不过|只是|而", last[:25]):
        return "转折判断"
    return "事实/判断"


def metrics(item: dict[str, Any], article_path: Path) -> dict[str, Any]:
    body = article_body(article_path)
    ps = paragraphs(body)
    prose = [p for p in ps if not is_heading(p)]
    heads = [p for p in ps if is_heading(p)]
    first = prose[0] if prose else ""
    last = prose[-1] if prose else ""
    return {
        "id": item["id"],
        "title": item["title"],
        "author": item["author"],
        "type": item["content_type"],
        "layer": item["style_layer"],
        "chars": item["chars"],
        "paragraph_count": len(prose),
        "paragraph_lengths": [len(p) for p in prose],
        "lead_lengths": [len(p) for p in prose[:6]],
        "heading_count": len(heads),
        "headings": heads,
        "anonymous_source_hits": len(
            re.findall(
                r"据我们了解|晚点了解到|知情人士|接近.{0,12}人士|"
                r"一位.{0,15}人士|多位.{0,15}人士|上述人士",
                body,
            )
        ),
        "number_hits": len(re.findall(r"\d+(?:[.,]\d+)?", body)),
        "quote_hits": len(re.findall(r"[“\"]", body)),
        "dialogue_questions": len(re.findall(r"^晚点\s*[：:]", body, flags=re.M)),
        "title_features": title_features(item["title"]),
        "opening_feature": opening_feature(first),
        "ending_feature": ending_feature(last),
    }


def representative(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not rows:
        return None
    target = median(row["chars"] for row in rows)
    return min(rows, key=lambda row: abs(row["chars"] - target))


def format_num(value: float) -> str:
    if float(value).is_integer():
        return f"{int(value):,}"
    return f"{value:,.1f}"


def cohort_summary(
    label: str,
    rows: list[dict[str, Any]],
) -> str:
    primary = [row for row in rows if row["layer"] == "primary"]
    briefs = [row for row in rows if row["layer"] == "brief"]
    return (
        f"| {label} | {len(rows)} | {len(primary)} | {len(briefs)} | "
        f"{format_num(median(row['chars'] for row in primary))} | "
        f"{format_num(median(row['heading_count'] for row in primary))} | "
        f"{format_num(median(row['number_hits'] for row in primary))} |"
    )


def build_report(
    catalog: list[dict[str, Any]],
    articles_dir: Path,
    new_ids: set[int] | None = None,
) -> str:
    rows = [
        metrics(item, articles_dir / item["file"])
        for item in catalog
        if item["style_layer"] in {"primary", "brief"}
    ]
    primary = [row for row in rows if row["layer"] == "primary"]
    briefs = [row for row in rows if row["layer"] == "brief"]
    title_counts = Counter(feature for row in rows for feature in row["title_features"])
    opening_counts = Counter(row["opening_feature"] for row in primary)
    ending_counts = Counter(row["ending_feature"] for row in primary)
    author_counts = Counter(row["author"] for row in primary)

    lines = [
        "# 语料证据与结构统计",
        "",
        "本文件由 `scripts/analyze_corpus.py` 从本地入选文章确定性生成。统计用于支持写作规则，不代表《晚点》官方规范。",
        "",
        "## 总体",
        "",
        f"- 可用于风格分析：{len(rows)} 篇，其中原创长稿 {len(primary)} 篇、独立快讯 {len(briefs)} 篇。",
        f"- 原创长稿中位篇幅：{format_num(median(row['chars'] for row in primary))} 字；"
        f"四分位区间：{percentile((row['chars'] for row in primary), 0.25):,}–"
        f"{percentile((row['chars'] for row in primary), 0.75):,} 字。",
        f"- 快讯中位篇幅：{format_num(median(row['chars'] for row in briefs))} 字。",
        f"- 原创长稿中位段落长度：{format_num(median(length for row in primary for length in row['paragraph_lengths']))} 字；"
        f"前六段中位长度：{format_num(median(length for row in primary for length in row['lead_lengths']))} 字。",
        f"- 原创长稿每篇中位小标题数：{format_num(median(row['heading_count'] for row in primary))}。",
        f"- 原创长稿每篇中位数字锚点：{format_num(median(row['number_hits'] for row in primary))}；"
        f"中位匿名信源表达：{format_num(median(row['anonymous_source_hits'] for row in primary))}。",
        "",
    ]
    if new_ids is not None:
        old_rows = [row for row in rows if int(row["id"]) not in new_ids]
        new_rows = [row for row in rows if int(row["id"]) in new_ids]
        lines.extend(
            [
                "## 新旧批次对比",
                "",
                "| 批次 | 可分析篇数 | 原创长稿 | 独立快讯 | 长稿中位字数 | 长稿中位小标题 | 长稿中位数字锚点 |",
                "|---|---:|---:|---:|---:|---:|---:|",
                cohort_summary("旧批次", old_rows),
                cohort_summary("新增 353 篇复核后", new_rows),
                "",
                "新增批次只统计最终纳入且可参与风格分析的文章；多主题综合简报和非 AI 主线文章已排除。",
                "",
            ]
        )
    lines.extend(["## 标题信号", ""])
    lines.extend(f"- {feature}：{count} 篇" for feature, count in title_counts.most_common())
    lines.extend(["", "## 导语与收尾", "", "### 导语切入"])
    lines.append("")
    lines.extend(f"- {feature}：{count} 篇" for feature, count in opening_counts.most_common())
    lines.extend(["", "### 收尾方式", ""])
    lines.extend(f"- {feature}：{count} 篇" for feature, count in ending_counts.most_common())

    lines.extend(["", "## 稿型统计", ""])
    by_type: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_type[row["type"]].append(row)
    lines.append("| 稿型 | 篇数 | 中位字数 | 中位段落字数 | 中位小标题数 | 代表文章 |")
    lines.append("|---|---:|---:|---:|---:|---|")
    for content_type, type_rows in sorted(
        by_type.items(), key=lambda pair: (-len(pair[1]), pair[0])
    ):
        rep = representative(type_rows)
        paragraph_median = median(
            length for row in type_rows for length in row["paragraph_lengths"]
        )
        lines.append(
            f"| {content_type} | {len(type_rows)} | "
            f"{format_num(median(row['chars'] for row in type_rows))} | "
            f"{format_num(paragraph_median)} | "
            f"{format_num(median(row['heading_count'] for row in type_rows))} | "
            f"{rep['id']}《{rep['title']}》 |"
        )

    if new_ids is not None:
        new_type_counts = Counter(
            row["type"] for row in rows if int(row["id"]) in new_ids
        )
        lines.extend(["", "### 新增批次稿型分布", ""])
        lines.extend(
            f"- {content_type}：{count} 篇"
            for content_type, count in new_type_counts.most_common()
        )

    lines.extend(["", "## 高频作者（原创长稿）", ""])
    lines.extend(f"- {author}：{count} 篇" for author, count in author_counts.most_common(12))

    lines.extend(
        [
            "",
            "## 可追溯样本",
            "",
            "下列文章分别接近各稿型的中位篇幅，适合复核结构规则：",
            "",
        ]
    )
    for content_type, type_rows in sorted(by_type.items()):
        rep = representative(type_rows)
        lines.append(f"- {content_type}：{rep['id']}《{rep['title']}》")

    lines.extend(
        [
            "",
            "## 使用限制",
            "",
            "- 统计是结构信号，不应被当成固定字数或段落配额。",
            "- 人物对话的问答段会显著拉低段落中位长度，应与叙事长稿分开解释。",
            "- 匿名信源表达只统计现有文章；生成新稿时不得据此虚构信源。",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> None:
    args = parse_args()
    catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
    new_ids = None
    if args.cohort_index:
        cohort = json.loads(args.cohort_index.read_text(encoding="utf-8"))
        if not isinstance(cohort, list):
            raise TypeError("cohort index must contain a list")
        new_ids = {int(item["id"]) for item in cohort}
    report = build_report(catalog, args.articles, new_ids)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(report, encoding="utf-8")
    print(f"Wrote {args.out} from {len(catalog)} catalog articles")


if __name__ == "__main__":
    main()
