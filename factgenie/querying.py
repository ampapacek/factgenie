#!/usr/bin/env python3

import json
import logging
import re
from collections import defaultdict

import pandas as pd

import factgenie.workflows as workflows
from factgenie import CAMPAIGN_DIR
from factgenie.campaign import CampaignMode

logger = logging.getLogger("factgenie")

ANNOTATOR_PSEUDONYM_CITIES = [
    "Tokyo",
    "Paris",
    "London",
    "New York",
    "Sydney",
    "Berlin",
    "Rome",
    "Cairo",
    "Mumbai",
    "Mexico City",
]

ROW_COLUMNS = [
    "dataset",
    "split",
    "example_idx",
    "question_preview",
    "setups",
    "annotation_state",
    "annotator_aliases",
    "campaign_ids",
    "span_count",
    "skipped_count",
    "match_setup_id",
    "match_annotator_id",
    "match_annotator_alias",
    "match_details",
]

INTERNAL_ROW_COLUMNS = [
    "question_texts",
    "output_items",
    "submissions",
    "spans",
    "sliders",
    "any_texts",
    "annotator_ids",
    "annotator_alias_values",
    "setup_ids",
    "annotation_states",
    "has_done",
    "has_empty",
    "has_skipped",
    "has_assigned",
    "has_todo",
]

SPAN_FIELDS = {"span_category", "span_reason", "span_text"}
ANNOTATION_SCOPED_FIELDS = {"annotator", "annotation_state", "slider"} | SPAN_FIELDS
TEXT_FIELDS = {
    "setup",
    "annotation_state",
    "annotator",
    "span_category",
    "span_reason",
    "span_text",
    "question",
    "output",
    "any_text",
}
SLIDER_OPS = {"eq", "neq", "gt", "gte", "lt", "lte", "missing", "not_missing"}
TEXT_OPS = {"contains", "not_contains", "eq", "neq", "missing", "not_missing", "regex", "not_regex"}


class QueryFilterError(ValueError):
    pass


def normalize_annotator_id(value):
    if value is None:
        return ""
    text = str(value).strip()
    if not text or text.lower() in ["nan", "none"]:
        return ""
    text = re.sub(r"\s+", "_", text)
    return text.replace("/", "_").replace("\\", "_")


def _city_alias_from_index(index):
    base_index = index % len(ANNOTATOR_PSEUDONYM_CITIES)
    suffix_index = (index // len(ANNOTATOR_PSEUDONYM_CITIES)) + 1
    alias = ANNOTATOR_PSEUDONYM_CITIES[base_index]
    if suffix_index > 1:
        alias = f"{alias} {suffix_index}"
    return alias


def _load_annotator_aliases(campaign_id):
    path = CAMPAIGN_DIR / campaign_id / "annotators.json"
    if not path.exists():
        return {}

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        logger.warning("Failed to read annotator registry for %s", campaign_id)
        return {}

    records = data.get("annotators", data) if isinstance(data, dict) else data
    if not isinstance(records, list):
        return {}

    aliases = {}
    used_aliases = set()
    for record in records:
        if isinstance(record, dict):
            annotator_id = normalize_annotator_id(record.get("id"))
            alias = str(record.get("alias", "")).strip()
        else:
            annotator_id = normalize_annotator_id(record)
            alias = ""
        if not annotator_id:
            continue
        if not alias or alias in used_aliases:
            index = 0
            while True:
                alias = _city_alias_from_index(index)
                if alias not in used_aliases:
                    break
                index += 1
        aliases[annotator_id.lower()] = alias
        used_aliases.add(alias)
    return aliases


def _fallback_alias(campaign_id, annotator_id):
    key = f"{campaign_id}:{annotator_id}".encode("utf-8", errors="ignore")
    return ANNOTATOR_PSEUDONYM_CITIES[sum(key) % len(ANNOTATOR_PSEUDONYM_CITIES)]


def _safe_list(value):
    return value if isinstance(value, list) else []


def _truthy(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0 and not pd.isna(value)
    text = str(value or "").strip().lower()
    return bool(text) and text not in ["false", "0", "no", "off"]


def is_skip_selected(flags):
    for flag in _safe_list(flags):
        if not isinstance(flag, dict):
            continue
        label = str(flag.get("label", "")).lower()
        if ("skip" in label or "přeskoč" in label or "preskoc" in label) and _truthy(flag.get("value")):
            return True
    return False


def _preview(value, limit=180):
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "..."


def _normalize_example_text(example):
    if example is None:
        return ""
    if isinstance(example, str):
        return example
    if isinstance(example, dict):
        for key in ["question", "text", "input", "prompt", "query"]:
            value = example.get(key)
            if isinstance(value, str) and value.strip():
                return value
        try:
            return json.dumps(example, ensure_ascii=False)
        except TypeError:
            return str(example)
    return str(example)


def _field_text(items):
    values = []
    for item in _safe_list(items):
        if not isinstance(item, dict):
            continue
        values.append(str(item.get("label", "")))
        values.append(str(item.get("value", "")))
    return " ".join(values)


def _coerce_columns(df, columns):
    if df is None or df.empty:
        return pd.DataFrame(columns=columns)
    df = df.copy()
    for col in columns:
        if col not in df.columns:
            df[col] = None
    return df


def build_query_tables(app, visible_campaign_ids=None, visible_dataset_ids=None):
    campaign_index = workflows.generate_campaign_index(app, force_reload=False)
    visible_campaign_ids = set(visible_campaign_ids or campaign_index.keys())
    visible_dataset_ids = set(visible_dataset_ids or [])

    output_index = workflows.get_output_index(app, force_reload=False).copy()
    if visible_dataset_ids and not output_index.empty:
        output_index = output_index[output_index["dataset"].isin(visible_dataset_ids)]
    outputs = _coerce_columns(output_index, ["dataset", "split", "setup_id", "example_idx", "output", "jsonl_file"])

    annotation_index = workflows.get_annotation_index(app, force_reload=False).copy()
    if not annotation_index.empty and "campaign_id" in annotation_index.columns:
        annotation_index = annotation_index[annotation_index["campaign_id"].isin(visible_campaign_ids)]
    if visible_dataset_ids and not annotation_index.empty and "dataset" in annotation_index.columns:
        annotation_index = annotation_index[annotation_index["dataset"].isin(visible_dataset_ids)]

    submissions = _build_submissions(annotation_index, campaign_index)
    spans = _build_spans(submissions, campaign_index)
    assignments = _build_assignments(campaign_index, visible_campaign_ids, visible_dataset_ids)
    rows = _build_example_rows(app, outputs, submissions, spans, assignments)

    return {
        "outputs": outputs,
        "submissions": submissions,
        "spans": spans,
        "assignments": assignments,
        "rows": rows,
    }


def _build_submissions(annotation_index, campaign_index):
    columns = [
        "campaign_id",
        "campaign_mode",
        "dataset",
        "split",
        "setup_id",
        "example_idx",
        "annotator_id",
        "annotator_alias",
        "annotator_group",
        "expose_annotator_id",
        "annotation_state",
        "is_skipped",
        "span_count",
        "flags",
        "options",
        "sliders",
        "text_fields",
        "annotations",
        "jsonl_file",
    ]
    if annotation_index.empty:
        return pd.DataFrame(columns=columns)

    alias_cache = {}
    records = []
    for _, row in annotation_index.iterrows():
        campaign_id = str(row.get("campaign_id", "") or "")
        campaign = campaign_index.get(campaign_id)
        metadata = getattr(campaign, "metadata", {}) if campaign else {}
        expose_annotator_id = metadata.get("config", {}).get("pseudonymize_annotators", True) is False
        annotator_id = normalize_annotator_id(row.get("annotator_id"))
        annotator_group = row.get("annotator_group", 0)
        alias = ""
        if annotator_id:
            if campaign_id not in alias_cache:
                alias_cache[campaign_id] = _load_annotator_aliases(campaign_id)
            alias = alias_cache[campaign_id].get(annotator_id.lower()) or _fallback_alias(campaign_id, annotator_id)
        else:
            alias = f"group {annotator_group}"

        annotations = _safe_list(row.get("annotations"))
        is_skipped = is_skip_selected(row.get("flags"))
        span_count = len([ann for ann in annotations if isinstance(ann, dict) and ann.get("text")])
        if is_skipped:
            state = "skipped"
        elif span_count == 0:
            state = "empty"
        else:
            state = "done"

        records.append(
            {
                "campaign_id": campaign_id,
                "campaign_mode": metadata.get("mode", ""),
                "dataset": row.get("dataset"),
                "split": row.get("split"),
                "setup_id": row.get("setup_id"),
                "example_idx": int(row.get("example_idx")),
                "annotator_id": annotator_id,
                "annotator_alias": alias,
                "annotator_group": annotator_group,
                "expose_annotator_id": expose_annotator_id,
                "annotation_state": state,
                "is_skipped": is_skipped,
                "span_count": span_count,
                "flags": _safe_list(row.get("flags")),
                "options": _safe_list(row.get("options")),
                "sliders": _safe_list(row.get("sliders")),
                "text_fields": _safe_list(row.get("text_fields")),
                "annotations": annotations,
                "jsonl_file": row.get("jsonl_file"),
            }
        )

    return pd.DataFrame.from_records(records, columns=columns)


def _category_lookup(campaign_index):
    lookup = {}
    for campaign_id, campaign in campaign_index.items():
        categories = campaign.metadata.get("config", {}).get("annotation_span_categories", [])
        lookup[campaign_id] = {
            i: category.get("name", str(i)) if isinstance(category, dict) else str(category)
            for i, category in enumerate(categories)
        }
    return lookup


def _build_spans(submissions, campaign_index):
    columns = [
        "campaign_id",
        "dataset",
        "split",
        "setup_id",
        "example_idx",
        "annotator_id",
        "annotator_alias",
        "annotator_group",
        "expose_annotator_id",
        "category_name",
        "annotation_text",
        "annotation_reason",
        "annotation_start",
    ]
    if submissions.empty:
        return pd.DataFrame(columns=columns)

    category_names = _category_lookup(campaign_index)
    records = []
    for _, row in submissions.iterrows():
        for ann in _safe_list(row.get("annotations")):
            if not isinstance(ann, dict) or not ann.get("text"):
                continue
            annotation_type = ann.get("type", ann.get("annotation_type"))
            try:
                annotation_type = int(annotation_type)
            except (TypeError, ValueError):
                annotation_type = None
            records.append(
                {
                    "campaign_id": row["campaign_id"],
                    "dataset": row["dataset"],
                    "split": row["split"],
                    "setup_id": row["setup_id"],
                    "example_idx": row["example_idx"],
                    "annotator_id": row["annotator_id"],
                    "annotator_alias": row["annotator_alias"],
                    "annotator_group": row["annotator_group"],
                    "expose_annotator_id": row["expose_annotator_id"],
                    "category_name": category_names.get(row["campaign_id"], {}).get(annotation_type, str(annotation_type)),
                    "annotation_text": ann.get("text", ""),
                    "annotation_reason": ann.get("reason", ""),
                    "annotation_start": ann.get("start", ""),
                }
            )
    return pd.DataFrame.from_records(records, columns=columns)


def _build_assignments(campaign_index, visible_campaign_ids, visible_dataset_ids):
    records = []
    for campaign_id, campaign in campaign_index.items():
        if campaign_id not in visible_campaign_ids:
            continue
        if campaign.metadata.get("mode") == CampaignMode.HIDDEN:
            continue
        db = getattr(campaign, "db", pd.DataFrame())
        if db is None or db.empty:
            continue
        for _, row in db.iterrows():
            dataset = row.get("dataset")
            if visible_dataset_ids and dataset not in visible_dataset_ids:
                continue
            records.append(
                {
                    "campaign_id": campaign_id,
                    "dataset": dataset,
                    "split": row.get("split"),
                    "setup_id": row.get("setup_id"),
                    "example_idx": int(row.get("example_idx")),
                    "annotator_id": normalize_annotator_id(row.get("annotator_id")),
                    "assignment_status": row.get("status"),
                }
            )
    return pd.DataFrame.from_records(
        records,
        columns=["campaign_id", "dataset", "split", "setup_id", "example_idx", "annotator_id", "assignment_status"],
    )


def _build_example_rows(app, outputs, submissions, spans, assignments):
    if outputs.empty:
        return pd.DataFrame(columns=ROW_COLUMNS + INTERNAL_ROW_COLUMNS)

    submission_groups = _groups_by_example(submissions)
    span_groups = _groups_by_example(spans)
    assignment_groups = _groups_by_example(assignments)
    output_groups = _groups_by_example(outputs)
    records = []

    for key, out_group in output_groups.items():
        dataset, split, example_idx = key
        question = ""
        dataset_obj = app.db.get("datasets_obj", {}).get(dataset) if hasattr(app, "db") else None
        if dataset_obj is not None:
            try:
                question = _normalize_example_text(dataset_obj.get_example(split, int(example_idx)))
            except Exception:
                question = ""

        sub_group = submission_groups.get(key, pd.DataFrame())
        span_group = span_groups.get(key, pd.DataFrame())
        assignment_group = assignment_groups.get(key, pd.DataFrame())
        states = sorted(set(sub_group["annotation_state"].dropna().tolist())) if not sub_group.empty else []
        has_done = "done" in states
        has_empty = "empty" in states
        has_skipped = "skipped" in states
        has_assigned = (
            not assignment_group.empty
            and "assigned" in assignment_group["assignment_status"].astype(str).str.lower().tolist()
        )
        if has_skipped and (has_done or has_empty):
            row_state = "mixed"
        elif has_done:
            row_state = "done"
        elif has_empty:
            row_state = "empty"
        elif has_skipped:
            row_state = "skipped"
        elif has_assigned:
            row_state = "assigned"
        else:
            row_state = "todo"

        output_items = [
            {"setup_id": row.get("setup_id"), "text": row.get("output", "")}
            for _, row in out_group.sort_values("setup_id").iterrows()
        ]
        setup_ids = sorted({str(item["setup_id"]) for item in output_items if str(item["setup_id"])})
        annotator_aliases = sorted(set(sub_group["annotator_alias"].dropna().astype(str).tolist())) if not sub_group.empty else []
        annotator_ids = sorted(set(sub_group["annotator_id"].dropna().astype(str).tolist())) if not sub_group.empty else []
        campaign_ids = sorted(set(sub_group["campaign_id"].dropna().astype(str).tolist())) if not sub_group.empty else []
        if not assignment_group.empty:
            campaign_ids = sorted(set(campaign_ids + assignment_group["campaign_id"].dropna().astype(str).tolist()))

        sliders = []
        any_texts = [question]
        for item in output_items:
            any_texts.append(item["text"])
        submissions_list = []
        if not sub_group.empty:
            for _, sub in sub_group.iterrows():
                submissions_list.append(sub.to_dict())
                any_texts.extend([_field_text(sub.get("flags")), _field_text(sub.get("options")), _field_text(sub.get("text_fields"))])
                if sub.get("annotation_state") != "skipped":
                    for slider in _safe_list(sub.get("sliders")):
                        if not isinstance(slider, dict):
                            continue
                        try:
                            numeric_value = float(slider.get("value"))
                        except (TypeError, ValueError):
                            numeric_value = None
                        sliders.append(
                            {
                                "label": str(slider.get("label", "")),
                                "value": slider.get("value", ""),
                                "numeric_value": numeric_value,
                                "campaign_id": sub.get("campaign_id"),
                                "annotator_id": sub.get("annotator_id"),
                                "annotator_alias": sub.get("annotator_alias"),
                                "expose_annotator_id": sub.get("expose_annotator_id", False),
                                "setup_id": sub.get("setup_id"),
                                "missing": numeric_value is None,
                            }
                        )

        span_items = []
        if not span_group.empty:
            for _, span in span_group.iterrows():
                span_item = {
                    "campaign_id": span.get("campaign_id", ""),
                    "category": span.get("category_name", ""),
                    "text": span.get("annotation_text", ""),
                    "reason": span.get("annotation_reason", ""),
                    "start": span.get("annotation_start", ""),
                    "setup_id": span.get("setup_id", ""),
                    "annotator_id": span.get("annotator_id", ""),
                    "annotator_alias": span.get("annotator_alias", ""),
                    "expose_annotator_id": span.get("expose_annotator_id", False),
                }
                span_items.append(span_item)
                any_texts.extend([span_item["text"], span_item["reason"]])

        records.append(
            {
                "dataset": dataset,
                "split": split,
                "example_idx": int(example_idx),
                "question_texts": [question],
                "question_preview": _preview(question),
                "output_items": output_items,
                "setups": ", ".join(setup_ids),
                "setup_ids": setup_ids,
                "submissions": submissions_list,
                "spans": span_items,
                "sliders": sliders,
                "any_texts": any_texts,
                "annotation_state": row_state,
                "annotation_states": sorted(set(states + ([row_state] if row_state else []))),
                "annotator_aliases": ", ".join(annotator_aliases),
                "annotator_alias_values": annotator_aliases,
                "annotator_ids": annotator_ids,
                "campaign_ids": ", ".join(campaign_ids),
                "span_count": len(span_items),
                "skipped_count": int((sub_group["annotation_state"] == "skipped").sum()) if not sub_group.empty else 0,
                "has_done": has_done,
                "has_empty": has_empty,
                "has_skipped": has_skipped,
                "has_assigned": has_assigned,
                "has_todo": row_state == "todo",
                "match_setup_id": setup_ids[0] if setup_ids else "",
                "match_annotator_id": "",
                "match_annotator_alias": "",
                "match_details": [],
            }
        )

    return pd.DataFrame.from_records(records)


def _groups_by_example(df):
    if df is None or df.empty:
        return {}
    groups = {}
    for key, group in df.groupby(["dataset", "split", "example_idx"], dropna=False):
        groups[key] = group
    return groups


def scope_tables(tables, datasets=None, splits=None, campaign_ids=None):
    scoped = {}
    datasets = {str(value) for value in (datasets or []) if str(value).strip()}
    splits = {str(value) for value in (splits or []) if str(value).strip()}
    campaign_ids = {str(value) for value in (campaign_ids or []) if str(value).strip()}

    for name, table in tables.items():
        df = table.copy()
        if df.empty:
            scoped[name] = df
            continue
        if datasets and "dataset" in df.columns:
            df = df[df["dataset"].astype(str).isin(datasets)]
        if splits and "split" in df.columns:
            df = df[df["split"].astype(str).isin(splits)]
        if campaign_ids:
            if "campaign_id" in df.columns:
                df = df[df["campaign_id"].astype(str).isin(campaign_ids)]
            elif "campaign_ids" in df.columns:
                df = df[df["campaign_ids"].apply(lambda cell: any(value in str(cell).split(", ") for value in campaign_ids))]
        scoped[name] = df.reset_index(drop=True)
    return scoped


def schema_payload(tables, authenticated=False):
    rows = tables["rows"]
    spans = tables["spans"]
    submissions = tables["submissions"]
    slider_labels = set()
    if not rows.empty:
        for sliders in rows["sliders"].tolist():
            for slider in _safe_list(sliders):
                if slider.get("label"):
                    slider_labels.add(str(slider["label"]))
    annotators = set()
    if not submissions.empty:
        annotators.update(submissions["annotator_alias"].dropna().astype(str).tolist())
        visible_ids = submissions[
            submissions.apply(lambda item: should_expose_annotator_id(item, authenticated), axis=1)
        ]
        annotators.update(visible_ids["annotator_id"].dropna().astype(str).tolist())
    return {
        "datasets": sorted(rows["dataset"].dropna().astype(str).unique().tolist()) if not rows.empty else [],
        "splits": sorted(rows["split"].dropna().astype(str).unique().tolist()) if not rows.empty else [],
        "setups": sorted({setup for setups in rows.get("setup_ids", []) for setup in _safe_list(setups)}) if not rows.empty else [],
        "annotators": sorted(value for value in annotators if value),
        "categories": sorted(spans["category_name"].dropna().astype(str).unique().tolist()) if not spans.empty else [],
        "slider_labels": sorted(slider_labels),
        "annotation_states": ["done", "skipped", "mixed", "empty", "assigned", "todo"],
    }


def apply_condition_filter(tables, filter_spec=None, authenticated=False):
    filter_spec = filter_spec or {}
    mode = str(filter_spec.get("mode") or "all").lower()
    if mode not in ["all", "any"]:
        mode = "all"
    conditions = normalize_conditions(filter_spec.get("conditions") or [])
    rows = tables["rows"].copy()
    if not conditions or rows.empty:
        return rows.reset_index(drop=True)

    records = []
    for _, row in rows.iterrows():
        row_dict = row.to_dict()
        matched, metadata = row_matches_conditions(row_dict, conditions, mode, authenticated=authenticated)
        if matched:
            row_dict.update(metadata)
            records.append(row_dict)
    return pd.DataFrame.from_records(records, columns=rows.columns).reset_index(drop=True)


def normalize_conditions(conditions):
    normalized = []
    if not isinstance(conditions, list):
        return normalized
    for condition in conditions:
        if not isinstance(condition, dict):
            continue
        field = str(condition.get("field") or "").strip()
        op = str(condition.get("op") or "").strip()
        embedded_slider_label = ""
        if field.startswith("slider:"):
            _, _, embedded_slider_label = field.partition(":")
            embedded_slider_label = embedded_slider_label.strip()
            field = "slider"
        if field not in TEXT_FIELDS and field != "slider":
            continue
        if field == "slider":
            if op not in SLIDER_OPS:
                continue
            slider_label = str(condition.get("sliderLabel") or condition.get("slider_label") or embedded_slider_label).strip()
            if not slider_label:
                continue
            value = condition.get("value")
            if op not in ["missing", "not_missing"] and str(value if value is not None else "").strip() == "":
                continue
            normalized.append({"field": field, "op": op, "value": value, "sliderLabel": slider_label})
            continue
        if op not in TEXT_OPS:
            continue
        value = condition.get("value")
        if op not in ["missing", "not_missing"] and str(value if value is not None else "").strip() == "":
            continue
        normalized.append({"field": field, "op": op, "value": value})
    return normalized


def row_matches_conditions(row, conditions, mode, authenticated=False):
    regex_cache = {}
    if mode == "any":
        details = []
        for condition in conditions:
            matched, metadata = condition_matches_row(row, condition, authenticated, regex_cache)
            if matched:
                details.extend(metadata.get("match_details") or [])
        if not details:
            return False, {}
        return True, metadata_from_details(details)

    has_annotation_scope = any(condition["field"] in ANNOTATION_SCOPED_FIELDS for condition in conditions)
    annotation_conditions = [
        condition
        for condition in conditions
        if condition["field"] in ANNOTATION_SCOPED_FIELDS or (has_annotation_scope and condition["field"] == "setup")
    ]
    row_conditions = [condition for condition in conditions if condition not in annotation_conditions]
    details = []

    if annotation_conditions:
        annotation_details = []
        for submission in _safe_list(row.get("submissions")):
            matched, condition_metadata = submission_matches_conditions(row, submission, annotation_conditions, authenticated, regex_cache)
            if matched:
                submission_details = condition_metadata.get("match_details") or []
                if submission_details:
                    annotation_details.extend(submission_details)
                else:
                    annotation_details.append(condition_detail({"field": "annotation", "op": "match", "value": ""}, "annotation", submission, authenticated))
        if not annotation_details:
            return False, {}
        details.extend(annotation_details)

    for condition in row_conditions:
        matched, condition_metadata = condition_matches_row(row, condition, authenticated, regex_cache)
        if not matched:
            return False, {}
        details.extend(condition_metadata.get("match_details") or [])
    return True, metadata_from_details(details)


def submission_matches_conditions(row, submission, conditions, authenticated, regex_cache):
    span_conditions = [condition for condition in conditions if condition["field"] in SPAN_FIELDS]
    submission_conditions = [condition for condition in conditions if condition["field"] not in SPAN_FIELDS]
    details = []

    if span_conditions:
        span_details = []
        for span in spans_for_submission(row, submission):
            if all(span_condition_matches(span, condition, regex_cache) for condition in span_conditions):
                for condition in span_conditions:
                    span_details.append(condition_detail(condition, "span", span, authenticated, matched_text_for_span(span, condition, regex_cache)))
        if not span_details:
            return False, {}
        details.extend(span_details)

    for condition in submission_conditions:
        matched, detail = submission_condition_matches(submission, condition, authenticated, regex_cache)
        if not matched:
            return False, {}
        if detail:
            details.append(detail)

    return True, metadata_from_details(details)


def spans_for_submission(row, submission):
    campaign_id = str(submission.get("campaign_id", "") or "")
    setup_id = str(submission.get("setup_id", "") or "")
    annotator_id = str(submission.get("annotator_id", "") or "")
    annotator_alias = str(submission.get("annotator_alias", "") or "")

    matches = []
    for span in _safe_list(row.get("spans")):
        if campaign_id and str(span.get("campaign_id", "") or "") != campaign_id:
            continue
        if setup_id and str(span.get("setup_id", "") or "") != setup_id:
            continue
        if annotator_id and str(span.get("annotator_id", "") or "") != annotator_id:
            continue
        if not annotator_id and annotator_alias and str(span.get("annotator_alias", "") or "") != annotator_alias:
            continue
        matches.append(span)
    return matches


def submission_condition_matches(submission, condition, authenticated, regex_cache):
    field = condition["field"]
    if field == "setup":
        matched = text_matches(submission.get("setup_id"), condition["op"], condition.get("value"), regex_cache)
        return matched, condition_detail(condition, "setup", submission, authenticated, matched_text_for_value(submission.get("setup_id"), condition, regex_cache)) if matched else {}
    if field == "annotation_state":
        matched = text_matches(submission.get("annotation_state"), condition["op"], condition.get("value"), regex_cache)
        return matched, condition_detail(condition, "annotation_state", submission, authenticated, matched_text_for_value(submission.get("annotation_state"), condition, regex_cache)) if matched else {}
    if field == "annotator":
        values = [submission.get("annotator_alias")]
        if should_expose_annotator_id(submission, authenticated):
            values.append(submission.get("annotator_id"))
        matched = text_matches(values, condition["op"], condition.get("value"), regex_cache)
        return matched, condition_detail(condition, "annotator", submission, authenticated, matched_text_for_values(values, condition, regex_cache)) if matched else {}
    if field == "slider":
        if submission.get("annotation_state") == "skipped":
            matched = condition["op"] == "missing"
            return matched, condition_detail(condition, "slider", submission, authenticated) if matched else {}
        slider_items = slider_items_from_submission(submission)
        if condition["op"] == "missing" and slider_matches(slider_items, condition):
            return True, condition_detail(condition, "slider", _missing_slider_item(submission, condition), authenticated)
        slider = first_matching_slider(slider_items, condition)
        return bool(slider), condition_detail(condition, "slider", slider, authenticated) if slider else {}
    return True, condition_detail(condition, field, submission, authenticated)


def condition_matches_row(row, condition, authenticated, regex_cache):
    field = condition["field"]
    if field in SPAN_FIELDS:
        for span in _safe_list(row.get("spans")):
            if span_condition_matches(span, condition, regex_cache):
                return True, metadata_from_details([condition_detail(condition, "span", span, authenticated, matched_text_for_span(span, condition, regex_cache))])
        return False, {}
    if field == "setup":
        values = row.get("setup_ids") or []
        matched = text_matches(values, condition["op"], condition.get("value"), regex_cache)
        return matched, metadata_from_details([condition_detail(condition, "setup", {}, authenticated, matched_text_for_values(values, condition, regex_cache))]) if matched else {}
    if field == "annotation_state":
        values = row.get("annotation_states") or []
        matched = text_matches(values, condition["op"], condition.get("value"), regex_cache)
        return matched, metadata_from_details([condition_detail(condition, "annotation_state", {}, authenticated, matched_text_for_values(values, condition, regex_cache))]) if matched else {}
    if field == "annotator":
        values = list(row.get("annotator_alias_values") or [])
        for submission in _safe_list(row.get("submissions")):
            if should_expose_annotator_id(submission, authenticated):
                values.append(submission.get("annotator_id"))
        matched = text_matches(values, condition["op"], condition.get("value"), regex_cache)
        if not matched:
            return False, {}
        detail = detail_for_first_matching_submission(row, condition, authenticated, regex_cache)
        return True, metadata_from_details([detail]) if detail else {}
    if field == "question":
        values = row.get("question_texts") or []
        matched = text_matches(values, condition["op"], condition.get("value"), regex_cache)
        detail = condition_detail(condition, "question", {}, authenticated, matched_text_for_values(values, condition, regex_cache), text=next((v for v in values if v), ""))
        return matched, metadata_from_details([detail]) if matched else {}
    if field == "output":
        details = []
        for item in _safe_list(row.get("output_items")):
            if text_matches(item.get("text"), condition["op"], condition.get("value"), regex_cache):
                details.append(condition_detail(condition, "output", item, authenticated, matched_text_for_value(item.get("text"), condition, regex_cache), text=item.get("text", "")))
        return bool(details), metadata_from_details(details) if details else {}
    if field == "any_text":
        values = row.get("any_texts") or []
        matched = text_matches(values, condition["op"], condition.get("value"), regex_cache)
        detail = condition_detail(condition, "any_text", {}, authenticated, matched_text_for_values(values, condition, regex_cache))
        return matched, metadata_from_details([detail]) if matched else {}
    if field == "slider":
        row_sliders = _safe_list(row.get("sliders"))
        sliders = [
            slider
            for slider in row_sliders
            if slider.get("label") == condition.get("sliderLabel") and slider_matches([slider], condition)
        ]
        details = [condition_detail(condition, "slider", slider, authenticated) for slider in sliders]
        if condition["op"] == "missing" and slider_matches(row_sliders, condition):
            details.append(condition_detail(condition, "slider", _missing_slider_item({}, condition), authenticated))
        return bool(details), metadata_from_details(details) if details else {}
    return True, {}


def span_condition_matches(span, condition, regex_cache):
    if condition["field"] == "span_category":
        value = span.get("category", "")
    elif condition["field"] == "span_reason":
        value = span.get("reason", "")
    else:
        value = span.get("text", "")
    return text_matches(value, condition["op"], condition.get("value"), regex_cache)


def matched_text_for_span(span, condition, regex_cache):
    if condition["field"] == "span_category":
        value = span.get("category", "")
    elif condition["field"] == "span_reason":
        value = span.get("reason", "")
    else:
        value = span.get("text", "")
    return matched_text_for_value(value, condition, regex_cache)


def _casefold(value):
    return str(value or "").casefold()


def text_matches(values, op, query, regex_cache):
    texts = [str(value or "") for value in (values if isinstance(values, list) else [values])]
    present = [text for text in texts if text.strip()]
    if op == "missing":
        return not present
    if op == "not_missing":
        return bool(present)
    if op in ["regex", "not_regex"]:
        pattern = str(query or "")
        try:
            regex = regex_cache.setdefault(pattern, re.compile(pattern, re.IGNORECASE))
        except re.error as exc:
            raise QueryFilterError(f"Invalid regex: {exc}") from exc
        matched = any(regex.search(text) for text in present)
        return matched if op == "regex" else not matched

    needle = _casefold(query)
    folded = [_casefold(text) for text in texts]
    if op == "contains":
        return any(needle in text for text in folded)
    if op == "not_contains":
        return all(needle not in text for text in folded)
    if op == "eq":
        return any(text == needle for text in folded)
    if op == "neq":
        return all(text != needle for text in folded)
    return True


def slider_matches(sliders, condition):
    label = condition["sliderLabel"]
    matching = [slider for slider in _safe_list(sliders) if slider.get("label") == label]
    if condition["op"] == "missing":
        return not matching or any(slider.get("missing") for slider in matching)
    if condition["op"] == "not_missing":
        return any(not slider.get("missing") for slider in matching)
    try:
        target = float(condition.get("value"))
    except (TypeError, ValueError):
        return False
    for slider in matching:
        value = slider.get("numeric_value")
        if not isinstance(value, (int, float)):
            continue
        if condition["op"] == "eq" and value == target:
            return True
        if condition["op"] == "neq" and value != target:
            return True
        if condition["op"] == "gt" and value > target:
            return True
        if condition["op"] == "gte" and value >= target:
            return True
        if condition["op"] == "lt" and value < target:
            return True
        if condition["op"] == "lte" and value <= target:
            return True
    return False


def first_matching_slider(sliders, condition):
    for slider in _safe_list(sliders):
        if slider.get("label") == condition.get("sliderLabel") and slider_matches([slider], condition):
            return slider
    return None


def _missing_slider_item(item, condition):
    return {
        "label": condition.get("sliderLabel", ""),
        "value": "",
        "numeric_value": None,
        "campaign_id": item.get("campaign_id", ""),
        "annotator_id": item.get("annotator_id", ""),
        "annotator_alias": item.get("annotator_alias", ""),
        "expose_annotator_id": item.get("expose_annotator_id", False),
        "setup_id": item.get("setup_id", ""),
        "missing": True,
    }


def slider_items_from_submission(submission):
    items = []
    for slider in _safe_list(submission.get("sliders")):
        if not isinstance(slider, dict):
            continue
        try:
            numeric_value = float(slider.get("value"))
        except (TypeError, ValueError):
            numeric_value = None
        items.append(
            {
                "label": str(slider.get("label", "")),
                "value": slider.get("value", ""),
                "numeric_value": numeric_value,
                "campaign_id": submission.get("campaign_id", ""),
                "annotator_id": submission.get("annotator_id", ""),
                "annotator_alias": submission.get("annotator_alias", ""),
                "expose_annotator_id": submission.get("expose_annotator_id", False),
                "setup_id": submission.get("setup_id", ""),
                "missing": numeric_value is None,
            }
        )
    return items


def match_metadata_from_item(item):
    return {
        "match_setup_id": item.get("setup_id", ""),
        "match_annotator_id": item.get("annotator_id", ""),
        "match_annotator_alias": item.get("annotator_alias", ""),
    }


def metadata_from_details(details):
    details = [detail for detail in _safe_list(details) if isinstance(detail, dict)]
    metadata = {"match_details": details}
    first = next((detail for detail in details if detail.get("setup_id") or detail.get("annotator_id") or detail.get("annotator_alias")), {})
    metadata.update(match_metadata_from_item(first))
    return metadata


def condition_detail(condition, target, item, authenticated, matched_text="", text=""):
    item = item or {}
    detail = {
        "field": condition.get("field", ""),
        "op": condition.get("op", ""),
        "value": str(condition.get("value", "") if condition.get("value") is not None else ""),
        "sliderLabel": condition.get("sliderLabel", ""),
        "target": target,
        "campaign_id": item.get("campaign_id", ""),
        "setup_id": item.get("setup_id", ""),
        "annotator_alias": item.get("annotator_alias", ""),
        "expose_annotator_id": item.get("expose_annotator_id", False),
        "matched_text": matched_text or "",
    }
    if should_expose_annotator_id(item, authenticated):
        detail["annotator_id"] = item.get("annotator_id", "")
    if target == "span":
        detail.update(
            {
                "category": item.get("category", ""),
                "span_text": item.get("text", ""),
                "reason": item.get("reason", ""),
                "start": item.get("start", ""),
            }
        )
    elif target == "slider":
        detail.update({"slider_label": item.get("label", condition.get("sliderLabel", "")), "slider_value": item.get("value", "")})
    elif text:
        detail["text"] = text
    return detail


def matched_text_for_values(values, condition, regex_cache):
    for value in values if isinstance(values, list) else [values]:
        matched = matched_text_for_value(value, condition, regex_cache)
        if matched:
            return matched
    return ""


def matched_text_for_value(value, condition, regex_cache):
    op = condition["op"]
    text = str(value or "")
    if not text.strip() or op in ["missing", "not_missing", "not_contains", "neq", "not_regex"]:
        return ""
    if op == "contains":
        needle = str(condition.get("value") or "")
        index = _casefold(text).find(_casefold(needle))
        return text[index : index + len(needle)] if index >= 0 else ""
    if op == "eq":
        return text if _casefold(text) == _casefold(condition.get("value")) else ""
    if op == "regex":
        pattern = str(condition.get("value") or "")
        try:
            regex = regex_cache.setdefault(pattern, re.compile(pattern, re.IGNORECASE))
        except re.error as exc:
            raise QueryFilterError(f"Invalid regex: {exc}") from exc
        match = regex.search(text)
        return match.group(0) if match else ""
    return ""


def detail_for_first_matching_submission(row, condition, authenticated, regex_cache):
    for submission in _safe_list(row.get("submissions")):
        values = [submission.get("annotator_alias")]
        if should_expose_annotator_id(submission, authenticated):
            values.append(submission.get("annotator_id"))
        if text_matches(values, condition["op"], condition.get("value"), regex_cache):
            return condition_detail(condition, "annotator", submission, authenticated, matched_text_for_values(values, condition, regex_cache))
    return {}


def should_expose_annotator_id(item, authenticated):
    if item is None:
        return False
    return bool(item.get("annotator_id") and (authenticated or item.get("expose_annotator_id")))


def metadata_for_first_matching_slider(row, condition):
    for slider in _safe_list(row.get("sliders")):
        if slider.get("label") == condition.get("sliderLabel") and slider_matches([slider], condition):
            return match_metadata_from_item(slider)
    return {}


def metadata_for_first_matching_submission_slider(submission, condition):
    for slider in slider_items_from_submission(submission):
        if slider.get("label") == condition.get("sliderLabel") and slider_matches([slider], condition):
            return match_metadata_from_item(slider)
    return {}


def summarize_rows(rows):
    if rows.empty:
        return {"total": 0, "by_state": []}
    return {
        "total": int(len(rows)),
        "by_state": rows.groupby("annotation_state").size().reset_index(name="count").to_dict(orient="records"),
    }


def table_payload(rows, limit=500, authenticated=False):
    public_rows = rows.drop(columns=INTERNAL_ROW_COLUMNS, errors="ignore")
    if not authenticated:
        if "match_details" in public_rows.columns:
            public_rows["match_details"] = public_rows["match_details"].apply(sanitize_public_match_details)
            if "match_annotator_id" in public_rows.columns:
                public_rows["match_annotator_id"] = public_rows["match_details"].apply(first_detail_annotator_id)
    public_rows = public_rows.where(pd.notnull(public_rows), "")
    if limit:
        public_rows = public_rows.head(int(limit))
    return {
        "columns": [col for col in ROW_COLUMNS if col in public_rows.columns],
        "rows": public_rows.to_dict(orient="records"),
        "summary": summarize_rows(rows),
    }


def sanitize_public_match_details(details):
    sanitized = []
    for detail in _safe_list(details):
        if not isinstance(detail, dict):
            continue
        public_detail = dict(detail)
        if not public_detail.get("expose_annotator_id"):
            public_detail.pop("annotator_id", None)
        public_detail.pop("expose_annotator_id", None)
        sanitized.append(public_detail)
    return sanitized


def first_detail_annotator_id(details):
    for detail in _safe_list(details):
        if isinstance(detail, dict) and detail.get("annotator_id"):
            return detail.get("annotator_id")
    return ""
