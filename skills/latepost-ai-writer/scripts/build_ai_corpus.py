#!/usr/bin/env python3
"""Build an auditable broad-AI catalog from the scraped LatePost corpus.

The classifier is deliberately deterministic. It combines high-precision title
signals with body-density checks, then applies a small human-reviewed override
file for ambiguous inclusions and exclusions.
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
from collections import Counter
from pathlib import Path
from typing import Any


TOPIC_LABELS = {
    "models_research": "模型与研究",
    "products_agents": "产品与 Agent",
    "companies_capital": "公司与资本",
    "compute_chips": "算力与芯片",
    "embodied_robotics": "具身机器人",
    "autonomous_driving": "智驾",
}

CORE_TITLE_PATTERNS = [
    r"(?<![A-Za-z])AI(?![A-Za-z])",
    r"人工智能|AGI|大模型|基础模型|基座模型|世界模型|语言模型|视频模型|生成模型",
    r"多模态|智能体|Agent|AICoding|AI\s*Coding|AI云|AI\s*for\s*Science",
    r"OpenAI|Anthropic|Claude|DeepSeek|豆包|千问|混元|Kimi|智谱|MiniMax",
    r"ChatGPT|GPT[-\s]?\d|Sora|Manus|OpenClaw|ClawdBot|Qwen|GLM",
    r"模型训练|Scaling\s*Law|强化学习|注意力|Transformer|Diffusion|DiT",
]

ROBOTICS_TITLE_PATTERNS = [
    r"具身|人形机器人|通用机器人|机器人公司|机器人业务|机器人研发",
    r"机器人创业|家务机器人|机器人大脑|物理\s*AI|VLA",
]

AUTONOMOUS_TITLE_PATTERNS = [
    r"智驾|自动驾驶|辅助驾驶|无人驾驶|无人出租车|Robotaxi|FSD|L4|舱驾|端到端",
    r"世界基座模型|激光雷达|视觉能力将决定智驾",
]

COMPUTE_TITLE_PATTERNS = [
    r"GPU|HBM|英伟达|算力|AI\s*芯片|AI芯片|AI\s*云|数据中心",
    r"PPU\s*芯片|舱驾一体芯片|智驾芯片",
]

BODY_AI_TERMS = {
    "AI": 1.5,
    "人工智能": 2.0,
    "大模型": 3.0,
    "基础模型": 3.0,
    "基座模型": 3.0,
    "语言模型": 3.0,
    "世界模型": 3.0,
    "多模态": 2.5,
    "智能体": 2.5,
    "Agent": 2.0,
    "OpenAI": 2.5,
    "Anthropic": 2.5,
    "DeepSeek": 2.5,
    "ChatGPT": 2.5,
    "豆包": 2.0,
    "千问": 2.0,
    "混元": 2.0,
    "Kimi": 2.0,
    "智谱": 2.0,
    "MiniMax": 2.0,
    "具身智能": 3.0,
    "人形机器人": 2.5,
    "自动驾驶": 2.0,
    "智驾": 2.0,
    "GPU": 1.5,
    "算力": 1.5,
}

EXTERNAL_AUTHOR_PATTERNS = [
    r"特约作者",
    r"资本合伙人",
    r"创始人",
    r"晚点专栏作者",
    r"Antigravity",
]

SPONSORED_TITLE_PATTERNS = [
    r"特别策划",
    r"长期选择$",
    r"做足了准备$",
    r"产品体验的二次跨越$",
    r"旗舰重塑逻辑$",
    r"加速制造\s*AI\+\s*爆款$",
    r"如何把\s*AI\s*融入操作系统",
    r"AI\s*金融务实样本",
]

MIXED_DIGEST_TITLE_PATTERNS = [
    r"百亿美元公司动向",
]


def compile_any(patterns: list[str]) -> re.Pattern[str]:
    return re.compile("|".join(f"(?:{pattern})" for pattern in patterns), re.I)


CORE_TITLE_RE = compile_any(CORE_TITLE_PATTERNS)
ROBOTICS_TITLE_RE = compile_any(ROBOTICS_TITLE_PATTERNS)
AUTONOMOUS_TITLE_RE = compile_any(AUTONOMOUS_TITLE_PATTERNS)
COMPUTE_TITLE_RE = compile_any(COMPUTE_TITLE_PATTERNS)
EXTERNAL_AUTHOR_RE = compile_any(EXTERNAL_AUTHOR_PATTERNS)
SPONSORED_TITLE_RE = compile_any(SPONSORED_TITLE_PATTERNS)
MIXED_DIGEST_TITLE_RE = compile_any(MIXED_DIGEST_TITLE_PATTERNS)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--index",
        type=Path,
        nargs="+",
        required=True,
        help="One or more index JSON files. Duplicate IDs must agree on core metadata.",
    )
    parser.add_argument("--articles", type=Path, required=True)
    parser.add_argument("--overrides", type=Path)
    parser.add_argument("--json-out", type=Path, required=True)
    parser.add_argument("--md-out", type=Path, required=True)
    return parser.parse_args()


def load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def read_body(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    parts = re.split(r"\n---\s*\n", text, maxsplit=1)
    return parts[1] if len(parts) == 2 else text


def matched_terms(regex: re.Pattern[str], text: str) -> list[str]:
    return sorted({match.group(0) for match in regex.finditer(text)}, key=str.lower)


def body_score(body: str) -> tuple[float, list[str]]:
    weighted = 0.0
    hits: list[str] = []
    for term, weight in BODY_AI_TERMS.items():
        count = len(re.findall(re.escape(term), body, flags=re.I))
        if count:
            weighted += min(count, 20) * weight
            hits.append(f"{term}×{count}")
    normalized = weighted / max(len(body) / 1000, 1)
    return round(normalized, 2), hits


def infer_topics(title: str, body: str) -> list[str]:
    topics: list[str] = []
    head = body[:5000]

    model_count = len(
        re.findall(
            r"大模型|基础模型|基座模型|语言模型|世界模型|多模态|"
            r"训练模型|模型训练|OpenAI|Anthropic|DeepSeek|Qwen|"
            r"混元|智谱|MiniMax|Kimi",
            head,
            re.I,
        )
    )
    product_count = len(
        re.findall(
            r"Agent|智能体|AI\s*应用|AI应用|AI\s*产品|AI产品|"
            r"AI\s*助手|AI助手|AI\s*硬件|AI硬件|Coding|创作工具|模型评测",
            head,
            re.I,
        )
    )
    compute_count = len(
        re.findall(r"算力|GPU|芯片|HBM|数据中心|训练集群|AI\s*云|AI云|Infra", head, re.I)
    )
    robotics_count = len(
        re.findall(r"具身智能|人形机器人|通用机器人|机器人本体|灵巧手|运动控制", head, re.I)
    )
    autonomous_count = len(
        re.findall(r"智驾|自动驾驶|Robotaxi|无人驾驶|辅助驾驶|舱驾|VLA", head, re.I)
    )

    if CORE_TITLE_RE.search(title) or model_count >= 4:
        topics.append("models_research")
    if re.search(
        r"Agent|智能体|AI\s*应用|AI应用|AI\s*产品|AI产品|AI\s*硬件|"
        r"AI硬件|Coding|创作工具|评测|实测|助手",
        title,
        re.I,
    ) or product_count >= 3:
        topics.append("products_agents")
    if re.search(
        r"融资|估值|IPO|上市|收入|营收|商业化|创业|组织|团队|"
        r"人才|投资|资本|并购|离职|加入|换帅|调整|CEO|大战|竞争|账本",
        title,
        re.I,
    ):
        topics.append("companies_capital")
    if COMPUTE_TITLE_RE.search(title) or compute_count >= 4:
        topics.append("compute_chips")
    if ROBOTICS_TITLE_RE.search(title) or robotics_count >= 4:
        topics.append("embodied_robotics")
    if AUTONOMOUS_TITLE_RE.search(title) or autonomous_count >= 4:
        topics.append("autonomous_driving")

    # Every included article needs at least one useful category.
    if not topics:
        topics.append("models_research")
    return topics


def infer_content_type(title: str, body: str, chars: int) -> str:
    if re.search(r"实测|评测|上手|体验", title):
        return "产品实测"
    if re.search(
        r"AI\s*月报|AI\s*季报|具身\s*季报|晚点播客|"
        r"AI\s*中场战事|AI\s*一年|年末\s*AI\s*回顾",
        title,
        re.I,
    ):
        return "AI 月报与趋势综合"
    if re.search(r"AI\s*创业访谈", title, re.I) or (
        re.search(r"对话|对谈|专访", title)
        and re.search(r"创始人|联合创始人", body[:2600])
        and re.search(r"创业|融资|成立于", body[:2600])
        and body_score(body)[0] >= 4.0
    ):
        return "AI 创业访谈"
    if re.search(r"晚点周末", title) and CORE_TITLE_RE.search(title):
        return "AI 议题观察"
    if re.search(r"对话|对谈|专访|晚点聊|100\s*个\s*AI\s*创业者", title, re.I):
        return "人物对话"
    if re.search(r"是什么|为什么|详解|解读|复盘|回顾", title, re.I):
        return "技术解释"
    question_count = len(re.findall(r"^晚点\s*[：:]", body, flags=re.M))
    if question_count >= 4:
        return "人物对话"
    if re.search(r"晚点独家|独家丨|独家专访", title) or chars < 2000:
        return "独家快讯"
    return "公司与产业深描"


def style_policy(item: dict[str, Any], body: str) -> tuple[bool, str, str]:
    title = item["title"]
    author = item.get("author") or ""
    if EXTERNAL_AUTHOR_RE.search(author):
        return False, "excluded", "外部作者或机构署名，不参与编辑部主风格蒸馏"
    if SPONSORED_TITLE_RE.search(title):
        return False, "excluded", "疑似品牌合作或特别策划，不参与主风格蒸馏"
    if re.search(
        r"本文(?:为|系).{0,20}(?:商业|品牌)合作|"
        r"(?:商业|品牌)合作(?:内容|呈现)|联合出品",
        body[:2200],
    ):
        return False, "excluded", "正文含合作内容标记，不参与主风格蒸馏"
    if infer_content_type(title, body, int(item["chars"])) == "独家快讯":
        return True, "brief", ""
    return True, "primary", ""


def automatic_decision(title: str, body: str) -> tuple[bool, float, list[str]]:
    reasons: list[str] = []
    score = 0.0

    if MIXED_DIGEST_TITLE_RE.search(title):
        return False, 0.0, ["多主题综合简报，不属于整篇以 AI 为主线的文章"]

    core_hits = matched_terms(CORE_TITLE_RE, title)
    robotics_hits = matched_terms(ROBOTICS_TITLE_RE, title)
    autonomous_hits = matched_terms(AUTONOMOUS_TITLE_RE, title)
    compute_hits = matched_terms(COMPUTE_TITLE_RE, title)
    density, density_hits = body_score(body)

    if core_hits:
        score += 7.0 + min(len(core_hits), 4)
        reasons.append(f"标题核心 AI 信号：{', '.join(core_hits)}")
    if robotics_hits:
        score += 6.5 + min(len(robotics_hits), 3)
        reasons.append(f"标题具身/机器人信号：{', '.join(robotics_hits)}")
    if autonomous_hits:
        score += 6.0 + min(len(autonomous_hits), 3)
        reasons.append(f"标题智驾信号：{', '.join(autonomous_hits)}")
    if compute_hits:
        score += 5.5 + min(len(compute_hits), 3)
        reasons.append(f"标题算力/芯片信号：{', '.join(compute_hits)}")

    score += min(density, 8.0)
    if density >= 2.0:
        reasons.append(f"正文 AI 词密度 {density}/千字（{', '.join(density_hits[:5])}）")

    # Title signals are sufficient for broad-AI topics. Body-only matches are
    # emitted as candidates in the score/reasons but require a human-reviewed
    # include override; this prevents background AI mentions from changing scope.
    include = bool(core_hits or robotics_hits or autonomous_hits)
    include = include or bool(compute_hits and density >= 1.0)

    # Known lexical traps: only a strong independent AI signal may override them.
    if re.search(r"效率算法|睡眠|智能床|智能门锁|智能域控", title) and not core_hits:
        include = False
        if not include:
            reasons.append("命中泛技术词陷阱，且正文 AI 密度不足")

    return include, round(score, 2), reasons


def parse_override_map(raw: Any) -> dict[int, Any]:
    if not raw:
        return {}
    return {int(key): value for key, value in raw.items()}


def build_catalog(
    index: list[dict[str, Any]],
    articles_dir: Path,
    overrides: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    include_overrides = parse_override_map(overrides.get("include"))
    exclude_overrides = parse_override_map(overrides.get("exclude"))
    style_overrides = parse_override_map(overrides.get("style"))
    selected: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []

    for source in sorted(index, key=lambda row: int(row["id"]), reverse=True):
        article_path = articles_dir / source["file"]
        body = read_body(article_path)
        include, score, reasons = automatic_decision(source["title"], body)
        article_id = int(source["id"])

        if article_id in include_overrides:
            include = True
            override = include_overrides[article_id]
            override_reason = (
                override.get("reason", "人工复核纳入")
                if isinstance(override, dict)
                else str(override)
            )
            reasons.append(f"人工复核：{override_reason}")
            score = max(score, 6.0)
        if article_id in exclude_overrides:
            include = False
            override = exclude_overrides[article_id]
            override_reason = (
                override.get("reason", "人工复核排除")
                if isinstance(override, dict)
                else str(override)
            )
            reasons.append(f"人工复核排除：{override_reason}")

        if not include:
            rejected.append(
                {
                    "id": article_id,
                    "title": source["title"],
                    "ai_score": score,
                    "reason": "；".join(reasons) or "未达到广义 AI 纳入阈值",
                }
            )
            continue

        topics = infer_topics(source["title"], body)
        if article_id in include_overrides and isinstance(include_overrides[article_id], dict):
            configured_topics = include_overrides[article_id].get("topics")
            if configured_topics:
                topics = configured_topics

        eligible, style_layer, exclusion_reason = style_policy(source, body)
        if article_id in style_overrides:
            configured_style = style_overrides[article_id]
            if not isinstance(configured_style, dict):
                raise TypeError(f"Style override for {article_id} must be an object")
            style_layer = configured_style.get("layer", style_layer)
            if style_layer not in {"primary", "brief", "excluded"}:
                raise ValueError(
                    f"Invalid style layer for {article_id}: {style_layer}"
                )
            eligible = style_layer != "excluded"
            exclusion_reason = configured_style.get("reason", exclusion_reason)

        content_type = infer_content_type(
            source["title"], body, int(source.get("chars") or len(body))
        )
        if article_id in include_overrides and isinstance(include_overrides[article_id], dict):
            content_type = include_overrides[article_id].get(
                "content_type", content_type
            )
        selected.append(
            {
                "id": article_id,
                "title": source["title"],
                "author": source.get("author") or "佚名",
                "date": source.get("date") or "",
                "file": source["file"],
                "url": source.get("url") or "",
                "chars": int(source.get("chars") or len(body)),
                "views": int(source["views"]) if str(source.get("views", "")).isdigit() else None,
                "topics": [TOPIC_LABELS[topic] for topic in topics],
                "content_type": content_type,
                "ai_score": score,
                "inclusion_reason": "；".join(reasons),
                "style_eligible": eligible,
                "style_layer": style_layer,
                "style_exclusion_reason": exclusion_reason,
            }
        )

    return selected, rejected


CORE_DUPLICATE_FIELDS = (
    "id",
    "title",
    "author",
    "date",
    "file",
    "url",
    "chars",
    "views",
)


def merge_indices(paths: list[Path]) -> list[dict[str, Any]]:
    merged: dict[int, dict[str, Any]] = {}
    origins: dict[int, Path] = {}
    for path in paths:
        raw = load_json(path)
        if not isinstance(raw, list):
            raise TypeError(f"{path} must contain a list")
        for item in raw:
            article_id = int(item["id"])
            if article_id not in merged:
                merged[article_id] = item
                origins[article_id] = path
                continue
            previous = merged[article_id]
            conflicts = [
                field
                for field in CORE_DUPLICATE_FIELDS
                if str(previous.get(field, "")) != str(item.get(field, ""))
            ]
            if conflicts:
                fields = ", ".join(conflicts)
                raise ValueError(
                    f"Duplicate article {article_id} conflicts on {fields}: "
                    f"{origins[article_id]} vs {path}"
                )
    return list(merged.values())


def validate_source(index: list[dict[str, Any]], articles_dir: Path) -> None:
    ids = [int(item["id"]) for item in index]
    if len(ids) != len(set(ids)):
        raise ValueError("index.json contains duplicate article IDs")
    missing = [item["file"] for item in index if not (articles_dir / item["file"]).is_file()]
    if missing:
        raise FileNotFoundError(f"Missing {len(missing)} article files: {missing[:5]}")


def write_json(path: Path, catalog: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(catalog, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def write_markdown(
    path: Path,
    catalog: list[dict[str, Any]],
    source_count: int,
    override_path: Path | None,
) -> None:
    topic_counts = Counter(topic for item in catalog for topic in item["topics"])
    type_counts = Counter(item["content_type"] for item in catalog)
    layer_counts = Counter(item["style_layer"] for item in catalog)
    lengths = [item["chars"] for item in catalog]

    lines = [
        "# 晚点 LatePost：广义 AI 文章清单",
        "",
        "## 筛选摘要",
        "",
        f"- 源文章：{source_count} 篇",
        f"- 纳入广义 AI：{len(catalog)} 篇",
        f"- 总字数：{sum(lengths):,} 字",
        f"- 中位篇幅：{int(statistics.median(lengths)):,} 字",
        "- 口径：模型与研究、产品与 Agent、公司与资本、算力与芯片、具身机器人、智驾。",
        "- 方法：标题高精度信号 + 正文 AI 词密度 + 人工边界覆核；多主题综合简报整体排除。",
        f"- 人工覆核表：`{override_path.as_posix() if override_path else '未提供'}`",
        "",
        "## 分类统计",
        "",
        "### 主题（可多选）",
        "",
    ]
    lines.extend(f"- {name}：{count} 篇" for name, count in topic_counts.most_common())
    lines.extend(["", "### 稿型", ""])
    lines.extend(f"- {name}：{count} 篇" for name, count in type_counts.most_common())
    lines.extend(
        [
            "",
            "### 写作语料层",
            "",
            f"- 主风格原创长稿：{layer_counts['primary']} 篇",
            f"- 独立快讯层：{layer_counts['brief']} 篇",
            f"- 标记但不参与主风格：{layer_counts['excluded']} 篇",
            "",
            "## 文章目录",
            "",
            "| 日期 | 标题 | 作者 | 主题 | 稿型 | 风格层 | AI 分数 |",
            "|---|---|---|---|---|---|---:|",
        ]
    )
    for item in catalog:
        title = item["title"].replace("|", "\\|")
        author = item["author"].replace("|", "\\|")
        topics = "、".join(item["topics"])
        file_link = f"articles/{item['file'].replace(' ', '%20')}"
        lines.append(
            f"| {item['date'][:10]} | [{title}]({file_link}) | {author} | "
            f"{topics} | {item['content_type']} | {item['style_layer']} | "
            f"{item['ai_score']:.2f} |"
        )
    lines.extend(
        [
            "",
            "## 字段说明",
            "",
            "- `style_layer=primary`：编辑部原创长稿，用于主写作方法蒸馏。",
            "- `style_layer=brief`：独家或短快讯，只用于快讯稿型。",
            "- `style_layer=excluded`：文章仍属 AI 清单，但不参与主风格蒸馏。",
            "- 完整纳入依据、排除原因和多主题标签见 `ai_articles.json`。",
            "",
        ]
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    args = parse_args()
    index = merge_indices(args.index)
    validate_source(index, args.articles)
    overrides = load_json(args.overrides) if args.overrides else {}
    catalog, rejected = build_catalog(index, args.articles, overrides)
    write_json(args.json_out, catalog)
    write_markdown(args.md_out, catalog, len(index), args.overrides)

    summary = {
        "source_articles": len(index),
        "selected_articles": len(catalog),
        "rejected_articles": len(rejected),
        "style_layers": dict(Counter(item["style_layer"] for item in catalog)),
        "content_types": dict(Counter(item["content_type"] for item in catalog)),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
