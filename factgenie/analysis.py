#!/usr/bin/env python3

import html
import json
import logging
import os
import re
import sys
import traceback
from collections import defaultdict

import pandas as pd

import factgenie.workflows as workflows

sys.path.append(os.path.join(os.path.dirname(__file__), ".."))

logger = logging.getLogger("factgenie")


def generate_example_index(app, campaign):
    logger.info(f"Preparing example index for campaign {campaign.campaign_id}")

    annotation_span_categories = campaign.metadata["config"]["annotation_span_categories"]
    example_index = workflows.get_annotation_index(app, force_reload=True).copy()

    fallback_columns = [
        "campaign_id",
        "dataset",
        "split",
        "setup_id",
        "example_idx",
        "annotator_group",
        "annotator_id",
        "annotations",
        "flags",
        "options",
        "sliders",
        "text_fields",
    ]

    if "campaign_id" not in example_index.columns:
        for i in range(len(annotation_span_categories)):
            fallback_columns.append(f"cat_{i}")
        return pd.DataFrame(columns=fallback_columns)

    # get the examples for a specific campaign
    example_index = example_index[example_index["campaign_id"] == campaign.campaign_id]

    for field in ["annotations", "flags", "options", "sliders", "text_fields"]:
        if field not in example_index.columns:
            example_index[field] = [[] for _ in range(len(example_index))]
        else:
            example_index[field] = example_index[field].apply(lambda value: value if isinstance(value, list) else [])

    # Add category count columns to example index
    for i in range(len(annotation_span_categories)):
        col_name = f"cat_{i}"
        example_index[col_name] = example_index["annotations"].apply(
            lambda anns: sum(1 for a in anns if isinstance(a, dict) and a.get("type") == i)
        )

    return example_index


def generate_span_index(app, campaign):
    logger.info(f"Preparing span index for campaign {campaign.campaign_id}")

    span_index = workflows.get_annotation_index(app).copy()
    empty_columns = [
        "campaign_id",
        "dataset",
        "split",
        "setup_id",
        "example_idx",
        "annotator_group",
        "annotation_type",
        "annotation_start",
        "annotation_text",
        "annotation_reason",
    ]

    if "campaign_id" not in span_index.columns or "annotations" not in span_index.columns:
        return pd.DataFrame(columns=empty_columns)

    # get the examples for a specific campaign
    span_index = span_index[span_index["campaign_id"] == campaign.campaign_id]

    # Remove examples with no annotations
    span_index = span_index[span_index["annotations"].apply(lambda x: isinstance(x, list) and len(x) > 0)]

    if not span_index.empty:
        # Create a separate row for each annotation
        span_index = span_index.explode("annotations").reset_index(drop=True)

        # Extract annotation fields into separate columns
        span_index["annotation_type"] = span_index["annotations"].apply(lambda x: x["type"])
        span_index["annotation_start"] = span_index["annotations"].apply(lambda x: x["start"])
        span_index["annotation_text"] = span_index["annotations"].apply(lambda x: x["text"])
        span_index["annotation_reason"] = span_index["annotations"].apply(lambda x: x.get("reason", ""))

        # Drop the original annotations column
        span_index = span_index.drop("annotations", axis=1)

        # Remove any annotations that have NaN start or type or empty text
        span_index = span_index.dropna(
            subset=["annotation_start", "annotation_type", "annotation_text", "annotation_reason"]
        )
        span_index = span_index[span_index["annotation_text"].apply(lambda x: len(x) > 0)]

        # remove annotations with type that is not in the correct range (0 - len(annotation_span_categories))
        annotation_span_categories = campaign.metadata["config"]["annotation_span_categories"]

        category_cnt = len(annotation_span_categories)
        span_index = span_index[span_index["annotation_type"].apply(lambda x: x in range(category_cnt))]

        # make annotation_type an integer
        span_index["annotation_type"] = span_index["annotation_type"].astype(int)

    if span_index.empty:
        return pd.DataFrame(columns=empty_columns)

    return span_index


def compute_ann_counts(df):
    """
    Compute annotation counts for each annotation type (separately for each dataset, split, setup_id).
    """
    logger.info("Computing annotation counts")

    # Create multi-index groupby once
    grouped = df.groupby(["dataset", "split", "setup_id", "annotation_type"]).size().reset_index(name="ann_count")

    # Create complete multi-index for all combinations
    idx = pd.MultiIndex.from_product(
        [df["dataset"].unique(), df["split"].unique(), df["setup_id"].unique(), sorted(df["annotation_type"].unique())],
        names=["dataset", "split", "setup_id", "annotation_type"],
    )

    # Reindex to include all combinations with zeros
    results = (
        grouped.set_index(["dataset", "split", "setup_id", "annotation_type"]).reindex(idx, fill_value=0).reset_index()
    )

    return results


def compute_avg_ann_counts(ann_counts, example_index):
    logger.info("Computing average annotation counts")

    # Get example counts through groupby operation
    example_counts = (
        example_index.groupby(["dataset", "split", "setup_id"])
        .agg(example_count=("example_idx", "nunique"))
        .reset_index()
        .astype({"example_count": int})
    )

    # Merge counts with original dataframe
    ann_counts = ann_counts.merge(example_counts, on=["dataset", "split", "setup_id"], how="left")

    # Compute average counts vectorized
    ann_counts["avg_count"] = (ann_counts["ann_count"] / ann_counts["example_count"]).round(3)

    return ann_counts


def compute_prevalence(ann_counts, example_index):
    logger.info("Computing annotation prevalence")

    # Compute affected counts for all rows at once
    ann_counts["prevalence"] = ann_counts.apply(
        lambda row: (
            (
                (example_index["dataset"] == row["dataset"])
                & (example_index["split"] == row["split"])
                & (example_index["setup_id"] == row["setup_id"])
                & (example_index[f"cat_{row['annotation_type']}"] > 0)
            ).sum()
            / row["example_count"]
            if row["example_count"] > 0
            else 0
        ),
        axis=1,
    ).round(3)

    return ann_counts


def aggregate_ann_counts(ann_counts, groupby):
    if groupby == "span":
        aggregated = (
            ann_counts.groupby("annotation_type")
            .agg({"avg_count": "mean", "ann_count": "sum", "example_count": "sum", "prevalence": "mean"})
            .reset_index()
            .to_dict(orient="records")
        )

    elif groupby == "setup":
        # keep individual annotation categories, but aggregate setup_ids for each dataset, split
        aggregated = (
            ann_counts.groupby(["setup_id", "annotation_type"])
            .agg({"avg_count": "mean", "ann_count": "sum", "example_count": "sum", "prevalence": "mean"})
            .reset_index()
            .to_dict(orient="records")
        )

    elif groupby == "dataset":
        # keep individual annotation categories, but aggregate datasets for each split, setup_id
        aggregated = (
            ann_counts.groupby(["dataset", "split", "annotation_type"])
            .agg({"avg_count": "mean", "ann_count": "sum", "example_count": "sum", "prevalence": "mean"})
            .reset_index()
            .to_dict(orient="records")
        )

    # round to three decimal places
    for a in aggregated:
        a["avg_count"] = round(a["avg_count"], 3)
        a["prevalence"] = round(a["prevalence"], 3)

    return aggregated


def compute_extra_fields_stats(example_index):
    # compute aggregate statistics for flags, options and text_fields (aggregates of value counts for each label)
    extra_fields_stats = {}

    try:
        for field in ["flags", "options", "sliders", "text_fields"]:
            # each of `example_index[field]` is a list of dicts
            # each dict contains `label` and `value` keys
            # we want to count the number of occurrences of each `value` for each unique `label`
            # and then assign the dictionary with these counts to extra_fields_stats[label]

            if field not in example_index.columns:
                continue

            # find unique labels
            labels = set()
            for example in example_index[field]:
                for d in example:
                    labels.add(d["label"])

            # create a dictionary for each label
            for label in labels:
                extra_fields_stats[label] = defaultdict(int)

            # count the occurrences of each value for each label
            for example in example_index[field]:
                for d in example:
                    extra_fields_stats[d["label"]][d["value"]] += 1
    except Exception as e:
        logger.error(f"Error while computing extra fields statistics: {e}")
        traceback.print_exc()

    return extra_fields_stats


def _is_skip_selected(flags):
    skip_markers = ("skip", "přeskoč")
    if not isinstance(flags, list):
        return False
    for flag in flags:
        if not isinstance(flag, dict):
            continue
        label = str(flag.get("label", "")).lower()
        value = flag.get("value", False)
        if any(marker in label for marker in skip_markers) and bool(value):
            return True
    return False


def compute_annotator_stats(example_index, slider_label_order=None):
    if example_index.empty:
        return None

    df = example_index.copy()
    df["annotator_id"] = df["annotator_id"].fillna("unknown")

    def count_spans(anns):
        return len(anns) if isinstance(anns, list) else 0

    def has_text(fields):
        if not isinstance(fields, list):
            return False
        for field in fields:
            if not isinstance(field, dict):
                continue
            value = field.get("value", "")
            if str(value).strip() != "":
                return True
        return False

    df["span_count"] = df["annotations"].apply(count_spans)
    df["text_entered"] = df["text_fields"].apply(has_text)

    base = (
        df.groupby("annotator_id")
        .agg(
            example_count=("example_idx", "size"),
            avg_spans=("span_count", "mean"),
            text_questions_count=("text_entered", "sum"),
        )
        .reset_index()
    )
    base["avg_spans"] = base["avg_spans"].round(3)

    slider_rows = []
    for _, row in df.iterrows():
        annotator_id = row["annotator_id"]
        sliders = row.get("sliders", [])
        if not isinstance(sliders, list):
            continue
        for slider in sliders:
            if not isinstance(slider, dict):
                continue
            label = slider.get("label")
            value = slider.get("value")
            if label is None or value is None or value == "":
                continue
            try:
                value_num = float(value)
            except (TypeError, ValueError):
                continue
            slider_rows.append(
                {
                    "annotator_id": annotator_id,
                    "label": label,
                    "value": value_num,
                }
            )

    slider_labels = []
    slider_avgs = {}
    if slider_rows:
        slider_df = pd.DataFrame.from_records(slider_rows)
        slider_avgs = (
            slider_df.groupby(["annotator_id", "label"])["value"].mean().round(3).reset_index()
        )
        labels = sorted(slider_df["label"].unique())
        if slider_label_order:
            slider_labels = [label for label in slider_label_order if label in labels]
            slider_labels.extend([label for label in labels if label not in slider_labels])
        else:
            slider_labels = labels

    rows = []
    for _, row in base.iterrows():
        annotator_id = row["annotator_id"]
        entry = {
            "annotator_id": annotator_id,
            "example_count": int(row["example_count"]),
            "avg_spans": row["avg_spans"],
            "text_questions_count": int(row["text_questions_count"]),
            "slider_avgs": {},
        }

        if not isinstance(slider_avgs, dict) and not slider_avgs.empty:
            ann_rows = slider_avgs[slider_avgs["annotator_id"] == annotator_id]
            for _, ann_row in ann_rows.iterrows():
                entry["slider_avgs"][ann_row["label"]] = ann_row["value"]

        rows.append(entry)

    return {
        "slider_labels": slider_labels,
        "rows": rows,
    }


def _normalize_example_text(example):
    if example is None:
        return ""

    if isinstance(example, str):
        text = example
    elif isinstance(example, dict):
        for key in ["question", "text", "input", "prompt", "query"]:
            if key in example:
                text = str(example[key])
                break
        else:
            text = json.dumps(example, ensure_ascii=False)
    elif isinstance(example, list):
        text = " ".join(str(item) for item in example)
    else:
        text = str(example)

    if "<" in text and ">" in text:
        text = re.sub(r"(?i)<br\s*/?>", "\n", text)
        text = re.sub(r"(?i)</(p|div|li|h[1-6]|tr|table)>", "\n", text)
        text = re.sub(r"<[^>]+>", " ", text)
        text = html.unescape(text)
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        text = text.strip()

    return text


def _build_example_preview(text, word_count=5):
    words = text.split()
    if len(words) <= word_count:
        return text
    return " ".join(words[:word_count])


def _normalize_annotator_group(group):
    if group is None:
        return "0"
    if pd.isna(group):
        return "0"
    try:
        group_float = float(group)
        if group_float.is_integer():
            return str(int(group_float))
    except (TypeError, ValueError):
        pass
    return str(group)


def _coverage_status(annotated_count, expected_count):
    if annotated_count <= 0:
        return "missing"
    if annotated_count >= expected_count:
        return "complete"
    return "partial"


def _compute_coverage_summary(question_df, annotated_col, span_col):
    total_questions = int(len(question_df))
    total_expected_assignments = int(question_df["expected_annotators"].sum()) if total_questions else 0
    annotated_assignments = int(question_df[annotated_col].sum()) if total_questions else 0
    missing_assignments = max(total_expected_assignments - annotated_assignments, 0)

    fully_annotated_questions = (
        int((question_df[annotated_col] == question_df["expected_annotators"]).sum()) if total_questions else 0
    )
    partially_annotated_questions = (
        int(((question_df[annotated_col] > 0) & (question_df[annotated_col] < question_df["expected_annotators"])).sum())
        if total_questions
        else 0
    )
    questions_without_annotations = int((question_df[annotated_col] == 0).sum()) if total_questions else 0
    questions_with_annotations = max(total_questions - questions_without_annotations, 0)

    return {
        "total_questions": total_questions,
        "total_expected_assignments": total_expected_assignments,
        "annotated_assignments": annotated_assignments,
        "missing_assignments": missing_assignments,
        "assignment_coverage": round(
            annotated_assignments / total_expected_assignments, 3
        )
        if total_expected_assignments > 0
        else 0.0,
        "fully_annotated_questions": fully_annotated_questions,
        "partially_annotated_questions": partially_annotated_questions,
        "questions_with_annotations": questions_with_annotations,
        "questions_without_annotations": questions_without_annotations,
        "total_spans": int(question_df[span_col].sum()) if total_questions else 0,
    }


def _compute_coverage_distribution(question_df, annotated_col):
    if question_df.empty:
        return []

    total_questions = len(question_df)
    max_annotators = int(question_df["expected_annotators"].max())
    counts = question_df.groupby(annotated_col).size()

    distribution = []
    for annotated_annotators in range(max_annotators + 1):
        question_count = int(counts.get(annotated_annotators, 0))
        distribution.append(
            {
                "annotated_annotators": annotated_annotators,
                "question_count": question_count,
                "share": round(question_count / total_questions, 3),
            }
        )

    return distribution


def _load_campaign_annotator_alias_map(campaign):
    try:
        annotator_path = os.path.join(campaign.dir, "annotators.json")
        if not os.path.exists(annotator_path):
            return {}
        with open(annotator_path) as f:
            data = json.load(f)

        records = data.get("annotators", []) if isinstance(data, dict) else data
        alias_map = {}
        if isinstance(records, list):
            for record in records:
                if not isinstance(record, dict):
                    continue
                annotator_id = str(record.get("id", "")).strip()
                alias = str(record.get("alias", "")).strip()
                if annotator_id and alias:
                    alias_map[annotator_id.lower()] = alias
        return alias_map
    except Exception:
        logger.warning(f"Failed to load annotator aliases for campaign {campaign.campaign_id}")
        return {}


def _extract_question_from_font_mono(raw_text):
    if not raw_text:
        return ""

    match = re.search(
        r"<h4>\s*Otázka\s*</h4>\s*<div[^>]*class=[\"'][^\"']*\bfont-mono\b[^\"']*[\"'][^>]*>(.*?)</div>",
        raw_text,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if not match:
        return ""

    text = re.sub(r"<[^>]+>", " ", match.group(1))
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _make_question_preview(example):
    if example is None:
        return ""
    raw_text = example if isinstance(example, str) else str(example)
    return _extract_question_from_font_mono(raw_text)


def compute_question_coverage_stats(app, campaign, example_index):
    key_cols = ["dataset", "split", "setup_id", "example_idx"]
    assignment_cols = key_cols + ["annotator_group_key"]

    expected = pd.DataFrame(columns=assignment_cols)
    campaign_db = getattr(campaign, "db", pd.DataFrame())

    if isinstance(campaign_db, pd.DataFrame) and not campaign_db.empty and set(key_cols).issubset(campaign_db.columns):
        expected = campaign_db[key_cols + (["annotator_group"] if "annotator_group" in campaign_db.columns else [])].copy()
        if "annotator_group" not in expected.columns:
            expected["annotator_group"] = 0

        expected["example_idx"] = pd.to_numeric(expected["example_idx"], errors="coerce")
        expected = expected.dropna(subset=key_cols)
        if not expected.empty:
            expected["example_idx"] = expected["example_idx"].astype(int)
            expected["annotator_group_key"] = expected["annotator_group"].apply(_normalize_annotator_group)
            expected = expected[key_cols + ["annotator_group_key"]].drop_duplicates()

    if expected.empty and not example_index.empty and set(key_cols).issubset(example_index.columns):
        expected = example_index.copy()
        if "annotator_group" not in expected.columns:
            expected["annotator_group"] = 0
        expected["example_idx"] = pd.to_numeric(expected["example_idx"], errors="coerce")
        expected = expected.dropna(subset=key_cols)
        if not expected.empty:
            expected["example_idx"] = expected["example_idx"].astype(int)
            expected["annotator_group_key"] = expected["annotator_group"].apply(_normalize_annotator_group)
            expected = expected[key_cols + ["annotator_group_key"]].drop_duplicates()

    if expected.empty:
        return None

    if example_index.empty:
        submitted_agg = pd.DataFrame(
            columns=assignment_cols
            + [
                "has_annotations_including_skipped",
                "has_annotations_excluding_skipped",
                "skip_selected",
                "span_count_including_skipped",
                "span_count_excluding_skipped",
            ]
        )
    else:
        submitted = example_index.copy()
        for field in key_cols:
            if field not in submitted.columns:
                submitted[field] = None

        if "annotator_group" not in submitted.columns:
            submitted["annotator_group"] = 0
        if "annotations" not in submitted.columns:
            submitted["annotations"] = [[] for _ in range(len(submitted))]
        if "flags" not in submitted.columns:
            submitted["flags"] = [[] for _ in range(len(submitted))]

        submitted["example_idx"] = pd.to_numeric(submitted["example_idx"], errors="coerce")
        submitted = submitted.dropna(subset=key_cols)

        if submitted.empty:
            submitted_agg = pd.DataFrame(
                columns=assignment_cols
                + [
                    "has_annotations_including_skipped",
                    "has_annotations_excluding_skipped",
                    "skip_selected",
                    "span_count_including_skipped",
                    "span_count_excluding_skipped",
                ]
            )
        else:
            submitted["example_idx"] = submitted["example_idx"].astype(int)
            submitted["annotator_group_key"] = submitted["annotator_group"].apply(_normalize_annotator_group)
            submitted["annotations"] = submitted["annotations"].apply(lambda value: value if isinstance(value, list) else [])
            submitted["flags"] = submitted["flags"].apply(lambda value: value if isinstance(value, list) else [])

            submitted["has_annotations"] = submitted["annotations"].apply(lambda anns: len(anns) > 0)
            submitted["skip_selected"] = submitted["flags"].apply(_is_skip_selected)
            submitted["span_count"] = submitted["annotations"].apply(len)

            submitted["has_annotations_including_skipped"] = submitted["has_annotations"]
            submitted["has_annotations_excluding_skipped"] = submitted["has_annotations"] & (~submitted["skip_selected"])
            submitted["span_count_including_skipped"] = submitted["span_count"]
            submitted["span_count_excluding_skipped"] = submitted.apply(
                lambda row: row["span_count"] if not row["skip_selected"] else 0, axis=1
            )

            submitted_agg = (
                submitted.groupby(assignment_cols)
                .agg(
                    has_annotations_including_skipped=("has_annotations_including_skipped", "max"),
                    has_annotations_excluding_skipped=("has_annotations_excluding_skipped", "max"),
                    skip_selected=("skip_selected", "max"),
                    span_count_including_skipped=("span_count_including_skipped", "max"),
                    span_count_excluding_skipped=("span_count_excluding_skipped", "max"),
                )
                .reset_index()
            )

    coverage_df = expected.merge(submitted_agg, on=assignment_cols, how="left")
    bool_cols = [
        "has_annotations_including_skipped",
        "has_annotations_excluding_skipped",
        "skip_selected",
    ]
    int_cols = [
        "span_count_including_skipped",
        "span_count_excluding_skipped",
    ]

    for col in bool_cols:
        coverage_df[col] = coverage_df[col].astype("boolean").fillna(False).astype(bool)
    for col in int_cols:
        coverage_df[col] = pd.to_numeric(coverage_df[col], errors="coerce").fillna(0).astype(int)

    question_df = (
        coverage_df.groupby(key_cols)
        .agg(
            expected_annotators=("annotator_group_key", "nunique"),
            annotated_annotators_including_skipped=("has_annotations_including_skipped", "sum"),
            annotated_annotators_excluding_skipped=("has_annotations_excluding_skipped", "sum"),
            skipped_annotators=("skip_selected", "sum"),
            span_count_including_skipped=("span_count_including_skipped", "sum"),
            span_count_excluding_skipped=("span_count_excluding_skipped", "sum"),
        )
        .reset_index()
    )

    int_question_cols = [
        "example_idx",
        "expected_annotators",
        "annotated_annotators_including_skipped",
        "annotated_annotators_excluding_skipped",
        "skipped_annotators",
        "span_count_including_skipped",
        "span_count_excluding_skipped",
    ]
    for col in int_question_cols:
        question_df[col] = question_df[col].astype(int)

    question_df["missing_annotators_including_skipped"] = (
        question_df["expected_annotators"] - question_df["annotated_annotators_including_skipped"]
    ).clip(lower=0)
    question_df["missing_annotators_excluding_skipped"] = (
        question_df["expected_annotators"] - question_df["annotated_annotators_excluding_skipped"]
    ).clip(lower=0)
    question_df["status_including_skipped"] = question_df.apply(
        lambda row: _coverage_status(row["annotated_annotators_including_skipped"], row["expected_annotators"]), axis=1
    )
    question_df["status_excluding_skipped"] = question_df.apply(
        lambda row: _coverage_status(row["annotated_annotators_excluding_skipped"], row["expected_annotators"]), axis=1
    )

    question_df = question_df.sort_values(["dataset", "split", "example_idx", "setup_id"])

    questions_without_annotations_excluding_skipped = question_df[
        (question_df["annotated_annotators_excluding_skipped"] == 0) & (question_df["skipped_annotators"] == 0)
    ][
        [
            "dataset",
            "split",
            "setup_id",
            "example_idx",
            "expected_annotators",
            "annotated_annotators_excluding_skipped",
            "missing_annotators_excluding_skipped",
            "skipped_annotators",
        ]
    ].copy()

    # Build matrix data for coverage tab
    alias_map = _load_campaign_annotator_alias_map(campaign)

    annotator_values = []
    matrix_status = {}

    if (
        not example_index.empty
        and "annotator_id" in example_index.columns
        and set(key_cols).issubset(example_index.columns)
    ):
        ann_df = example_index[key_cols + ["annotator_id", "annotations", "flags"]].copy()
        ann_df["annotator_id"] = ann_df["annotator_id"].fillna("").astype(str).str.strip()
        ann_df = ann_df[ann_df["annotator_id"] != ""]

        if not ann_df.empty:
            ann_df["annotations"] = ann_df["annotations"].apply(lambda value: value if isinstance(value, list) else [])
            ann_df["flags"] = ann_df["flags"].apply(lambda value: value if isinstance(value, list) else [])

            ann_df["has_annotations"] = ann_df["annotations"].apply(lambda anns: len(anns) > 0)
            ann_df["skip_selected"] = ann_df["flags"].apply(_is_skip_selected)
            ann_df["has_annotations_excluding_skipped"] = ann_df["has_annotations"] & (~ann_df["skip_selected"])

            ann_agg = (
                ann_df.groupby(key_cols + ["annotator_id"])
                .agg(
                    has_annotations_excluding_skipped=("has_annotations_excluding_skipped", "max"),
                    skip_selected=("skip_selected", "max"),
                )
                .reset_index()
            )

            annotator_values = sorted(ann_agg["annotator_id"].unique(), key=lambda value: value.lower())

            for _, ann_row in ann_agg.iterrows():
                output_key = (
                    ann_row["dataset"],
                    ann_row["split"],
                    ann_row["setup_id"],
                    int(ann_row["example_idx"]),
                )
                annotator_id = ann_row["annotator_id"]
                if bool(ann_row["has_annotations_excluding_skipped"]):
                    status = "done"
                elif bool(ann_row["skip_selected"]):
                    status = "skipped"
                else:
                    status = "todo"
                matrix_status[(output_key, annotator_id)] = status

    # Question preview text for last column
    question_preview_map = {}
    datasets_obj = app.db.get("datasets_obj", {}) if app else {}
    if not question_df.empty:
        question_keys = (
            question_df[["dataset", "split", "example_idx"]]
            .drop_duplicates()
            .sort_values(["dataset", "split", "example_idx"])
        )
        for _, q_row in question_keys.iterrows():
            dataset_id = q_row["dataset"]
            split = q_row["split"]
            example_idx = int(q_row["example_idx"])
            dataset_obj = datasets_obj.get(dataset_id)
            preview = ""
            if dataset_obj is not None:
                try:
                    example = dataset_obj.get_example(split, example_idx)
                    preview = _make_question_preview(example)
                except Exception:
                    preview = ""
            question_preview_map[(dataset_id, split, example_idx)] = preview

    matrix_rows = []
    question_group_keys = (
        question_df[["dataset", "split", "example_idx"]]
        .drop_duplicates()
        .sort_values(["dataset", "split", "example_idx"])
        .reset_index(drop=True)
    )
    question_group_keys["group_idx"] = question_group_keys.index

    question_group_map = {
        (row["dataset"], row["split"], int(row["example_idx"])): int(row["group_idx"]) for _, row in question_group_keys.iterrows()
    }

    for _, row in question_df.iterrows():
        dataset = row["dataset"]
        split = row["split"]
        setup_id = row["setup_id"]
        example_idx = int(row["example_idx"])
        output_key = (dataset, split, setup_id, example_idx)
        question_key = (dataset, split, example_idx)
        group_idx = question_group_map.get(question_key, 0)
        group_parity = group_idx % 2

        row_statuses = {}
        row_done_count = 0
        for annotator_id in annotator_values:
            status = matrix_status.get((output_key, annotator_id), "todo")
            row_statuses[annotator_id] = status
            if status == "done":
                row_done_count += 1

        matrix_rows.append(
            {
                "dataset": dataset,
                "split": split,
                "setup_id": setup_id,
                "example_idx": example_idx,
                "row_done_count": int(row_done_count),
                "group_parity": int(group_parity),
                "question_preview": question_preview_map.get(question_key, ""),
                "statuses": row_statuses,
            }
        )

    annotator_columns = []
    for annotator_id in annotator_values:
        done_count = sum(1 for row in matrix_rows if row["statuses"].get(annotator_id) == "done")
        alias = alias_map.get(annotator_id.lower(), "") if annotator_id else ""
        annotator_columns.append(
            {
                "annotator_key": annotator_id,
                "annotator_group_key": annotator_id,
                "annotator_name": annotator_id,
                "annotator_alias": alias,
                "done_count": int(done_count),
            }
        )

    return {
        "summary_including_skipped": _compute_coverage_summary(
            question_df, "annotated_annotators_including_skipped", "span_count_including_skipped"
        ),
        "summary_excluding_skipped": _compute_coverage_summary(
            question_df, "annotated_annotators_excluding_skipped", "span_count_excluding_skipped"
        ),
        "distribution_including_skipped": _compute_coverage_distribution(
            question_df, "annotated_annotators_including_skipped"
        ),
        "distribution_excluding_skipped": _compute_coverage_distribution(
            question_df, "annotated_annotators_excluding_skipped"
        ),
        "questions": question_df.to_dict(orient="records"),
        "questions_without_annotations_excluding_skipped": questions_without_annotations_excluding_skipped.to_dict(
            orient="records"
        ),
        "matrix": {
            "annotators": annotator_columns,
            "rows": matrix_rows,
        },
    }


def compute_slider_stats(example_index, datasets, slider_label_order=None):
    slider_rows = []

    for _, row in example_index.iterrows():
        sliders = row.get("sliders", [])
        if not isinstance(sliders, list):
            continue

        for slider in sliders:
            if not isinstance(slider, dict):
                continue
            label = slider.get("label")
            value = slider.get("value")
            if label is None or value is None or value == "":
                continue
            try:
                value_num = float(value)
            except (TypeError, ValueError):
                continue

            slider_rows.append(
                {
                    "dataset": row["dataset"],
                    "split": row["split"],
                    "setup_id": row["setup_id"],
                    "example_idx": row["example_idx"],
                    "label": label,
                    "value": value_num,
                }
            )

    if not slider_rows:
        return None

    df = pd.DataFrame.from_records(slider_rows)

    def build_stats_df(groupby_cols):
        stats = (
            df.groupby(groupby_cols)["value"]
            .agg(count="count", min_value="min", max_value="max", avg_value="mean", std_value="std")
            .reset_index()
        )
        stats["avg_value"] = stats["avg_value"].round(3)
        stats["min_value"] = stats["min_value"].round(3)
        stats["max_value"] = stats["max_value"].round(3)
        stats["std_value"] = stats["std_value"].fillna(0).round(3)
        return stats

    overall_df = build_stats_df(["label"])
    by_example_df = build_stats_df(["dataset", "split", "setup_id", "example_idx", "label"])
    overall = overall_df.to_dict(orient="records")

    example_text_map = {}
    unique_examples = example_index[["dataset", "split", "example_idx"]].drop_duplicates()
    for _, ex in unique_examples.iterrows():
        dataset_id = ex["dataset"]
        split = ex["split"]
        example_idx = ex["example_idx"]

        dataset = datasets.get(dataset_id)
        if dataset is None:
            text = ""
        else:
            try:
                text = _normalize_example_text(dataset.get_example(split, example_idx))
            except Exception:
                text = ""

        example_text_map[(dataset_id, split, example_idx)] = {
            "full": text,
            "preview": _build_example_preview(text, word_count=5),
        }

    by_setup = []
    for (dataset, split, setup_id), group in by_example_df.groupby(["dataset", "split", "setup_id"]):
        rows_by_example = {}
        labels = set(group["label"].tolist())

        for _, row in group.iterrows():
            ex_idx = row["example_idx"]
            ex_key = (dataset, split, ex_idx)
            text_data = example_text_map.get(ex_key, {"full": "", "preview": ""})

            if ex_idx not in rows_by_example:
                rows_by_example[ex_idx] = {
                    "example_idx": ex_idx,
                    "example_preview": text_data["preview"],
                    "example_full": text_data["full"],
                    "stats": {},
                }

            rows_by_example[ex_idx]["stats"][row["label"]] = {
                "count": int(row["count"]),
                "min_value": row["min_value"],
                "max_value": row["max_value"],
                "avg_value": row["avg_value"],
            }

        if slider_label_order:
            labels_sorted = [label for label in slider_label_order if label in labels]
            labels_sorted.extend([label for label in sorted(labels) if label not in labels_sorted])
        else:
            labels_sorted = sorted(labels)

        rows = [rows_by_example[idx] for idx in sorted(rows_by_example)]

        by_setup.append(
            {
                "dataset": dataset,
                "split": split,
                "setup_id": setup_id,
                "slider_labels": labels_sorted,
                "rows": rows,
            }
        )

    return {
        "overall": overall,
        "by_setup": by_setup,
    }


def compute_statistics(app, campaign):
    statistics = {}

    span_index = generate_span_index(app, campaign)
    example_index = generate_example_index(app, campaign)
    coverage_stats = compute_question_coverage_stats(app, campaign, example_index)
    if coverage_stats:
        statistics["coverage_stats"] = coverage_stats

    if not span_index.empty:
        annotation_counts = compute_ann_counts(span_index)
        annotation_counts = compute_avg_ann_counts(annotation_counts, example_index)
        annotation_counts = compute_prevalence(annotation_counts, example_index)

        # replace NaNs with 0
        annotation_counts = annotation_counts.fillna(0.0)

        statistics["ann_counts"] = {
            "full": annotation_counts.to_dict(orient="records"),
            "span": aggregate_ann_counts(annotation_counts, "span"),
            "setup": aggregate_ann_counts(annotation_counts, "setup"),
            "dataset": aggregate_ann_counts(annotation_counts, "dataset"),
        }

    if not example_index.empty:
        filtered_example_index = example_index
        if "flags" in example_index.columns:
            filtered_example_index = example_index[~example_index["flags"].apply(_is_skip_selected)]

        extra_fields_stats = compute_extra_fields_stats(filtered_example_index)
        statistics["extra_fields"] = extra_fields_stats
        slider_label_order = [
            slider.get("label")
            for slider in campaign.metadata["config"].get("sliders", [])
            if isinstance(slider, dict) and slider.get("label")
        ]
        slider_stats = compute_slider_stats(filtered_example_index, app.db["datasets_obj"], slider_label_order)
        if slider_stats:
            statistics["slider_stats"] = slider_stats
        annotator_stats = compute_annotator_stats(filtered_example_index, slider_label_order)
        if annotator_stats:
            statistics["annotator_stats"] = annotator_stats

    return statistics


def compute_span_index(app, selected_campaigns, campaigns, combinations=None):
    span_index = []

    # deduplicate
    selected_campaigns = list(set(selected_campaigns))

    for campaign_id in selected_campaigns:
        df = generate_span_index(app, campaigns[campaign_id])
        if df.empty:
            continue

        # filter out examples that are not in the selected combinations (dataset, split, setup_id)
        if combinations:
            df = df[df.apply(lambda x: (x["dataset"], x["split"], x["setup_id"]) in combinations, axis=1)]
        if df.empty:
            continue

        # Make sure that annotation_start is an integer
        df["annotation_start"] = df["annotation_start"].astype(int)
        df["annotation_end"] = df["annotation_start"] + df["annotation_text"].str.len()
        df["annotator_group_id"] = df.apply(
            lambda x: format_group_id(x["campaign_id"], str(x["annotator_group"])), axis=1
        )
        span_index.append(df)

    if not span_index:
        return pd.DataFrame(
            columns=[
                "campaign_id",
                "dataset",
                "split",
                "setup_id",
                "example_idx",
                "annotator_group",
                "annotation_type",
                "annotation_start",
                "annotation_end",
                "annotation_text",
                "annotator_group_id",
            ]
        )

    span_index = pd.concat(span_index, ignore_index=True)

    columns_to_drop = [
        "annotation_span_categories",
        # "annotator_id",
        "annotation_granularity",
        "annotation_overlap_allowed",
        "flags",
        "options",
        "sliders",
        "text_fields",
        "jsonl_file",
        # "annotation_text",
    ]

    # Only drop columns that exist in the DataFrame
    existing_columns = [col for col in columns_to_drop if col in span_index.columns]
    span_index = span_index.drop(columns=existing_columns)

    span_index["annotator_group"] = span_index["annotator_group"].astype(int)

    return span_index


def assert_common_categories(campaign_ids, campaign_index):
    """Verify that all campaigns share the same annotation categories."""
    common_category_names = None

    for campaign_id in campaign_ids:
        campaign = campaign_index[campaign_id]
        categories = campaign.metadata["config"]["annotation_span_categories"]
        category_names = [category["name"] for category in categories]

        if common_category_names is None:
            common_category_names = category_names
        elif common_category_names != category_names:
            logger.error(
                f"Annotation span categories do not match across campaigns: {common_category_names} vs {category_names}"
            )
            return False

    category_list = ", ".join([f"{i}: {category_name}" for i, category_name in enumerate(common_category_names)])
    logger.info(f"Categories: {category_list}")
    return True


def format_group_id(campaign_id, group):
    """Format annotator group ID."""
    if group is None:
        return f"{campaign_id}-anngroup-all"

    return f"{campaign_id}-anngroup-{group}"


def get_common_examples(first_campaign_data, second_campaign_data, first_group=None, second_group=None):
    """Find common examples between two annotator groups.

    If a group is None, all examples from that campaign are considered regardless of group.
    """
    # Filter examples for first group (or all if first_group is None)
    if first_group is None:
        first_examples = first_campaign_data[first_campaign_data["status"] == "finished"][
            ["dataset", "split", "setup_id"]
        ].drop_duplicates()
    else:
        first_examples = first_campaign_data[
            (first_campaign_data["annotator_group"] == first_group) & (first_campaign_data["status"] == "finished")
        ][["dataset", "split", "setup_id"]].drop_duplicates()

    # Filter examples for second group (or all if second_group is None)
    if second_group is None:
        second_examples = second_campaign_data[second_campaign_data["status"] == "finished"][
            ["dataset", "split", "setup_id"]
        ].drop_duplicates()
    else:
        second_examples = second_campaign_data[
            (second_campaign_data["annotator_group"] == second_group) & (second_campaign_data["status"] == "finished")
        ][["dataset", "split", "setup_id"]].drop_duplicates()

    # Find intersection using merge
    common = pd.merge(first_examples, second_examples, how="inner")

    # Convert to list of tuples
    return list(map(tuple, common.values))


def get_ref_hyp_spans(span_index, annotator_groups):
    """Get reference and hypothesis spans for a set of spans."""
    # Unpack annotator groups
    ref_camp_id, ref_group = annotator_groups[0]
    hyp_camp_id, hyp_group = annotator_groups[1]

    # Get reference and hypothesis spans for this example
    ref_spans = span_index[
        (span_index["campaign_id"] == ref_camp_id)
        & (span_index["annotator_group"] == ref_group if ref_group is not None else True)
    ]
    hyp_spans = span_index[
        (span_index["campaign_id"] == hyp_camp_id)
        & (span_index["annotator_group"] == hyp_group if hyp_group is not None else True)
    ]

    return ref_spans, hyp_spans


def get_example_list(
    campaign_index, annotator_groups, include_dataset=None, include_split=None, include_example_id=None
):
    """
    Get list of examples to consider for gamma score computation.

    Args:
        campaign_index: Dictionary mapping campaign_id to campaign object
        annotator_groups: List of tuples (campaign_id, ann_group)
        include_dataset: List of dataset IDs to include (None means include all)
        include_split: List of splits to include (None means include all)
        include_example_id: List of example IDs to include (None means include all)

    Returns:
        DataFrame with columns dataset, split, setup_id, example_idx
    """
    all_examples = []

    # Collect examples from each campaign and annotator group
    for campaign_id, ann_group in annotator_groups:
        campaign = campaign_index[campaign_id]
        campaign_examples = campaign.db.copy()

        # Filter by annotator group if specified
        if ann_group is not None:
            campaign_examples = campaign_examples[campaign_examples["annotator_group"] == ann_group]

        # Filter examples with finished status
        campaign_examples = campaign_examples[campaign_examples["status"] == "finished"]

        # Filter by datasets if specified
        if include_dataset:
            campaign_examples = campaign_examples[campaign_examples["dataset"].isin(include_dataset)]

        # Filter by splits if specified
        if include_split:
            campaign_examples = campaign_examples[campaign_examples["split"].isin(include_split)]

        # Filter by example_ids if specified
        if include_example_id:
            campaign_examples = campaign_examples[campaign_examples["example_idx"].isin(include_example_id)]

        # Check for multiple groups annotating the same examples
        if (
            ann_group is None
            and campaign_examples.duplicated(subset=["dataset", "split", "setup_id", "example_idx"], keep=False).any()
        ):
            logger.warning(
                f"Warning: Campaign {campaign_id} has multiple groups annotating the same example(s) and no annotator groups are specified. This may mix outputs from different annotators, potentially affecting metrics."
            )

        # Keep only relevant columns
        campaign_examples = campaign_examples[["annotator_group", "dataset", "split", "setup_id", "example_idx"]]
        campaign_examples["campaign_id"] = campaign_id

        # Add to the list of all examples
        all_examples.append(campaign_examples)

    # Combine all example sets
    if not all_examples:
        return pd.DataFrame(columns=["dataset", "split", "setup_id", "example_idx"])

    combined_examples = pd.concat(all_examples, ignore_index=True)

    # Filter examples: keep only those that are annotated by ALL given annotator groups.
    # An annotator group is defined as a (campaign_id, annotator_group) tuple.
    # If annotator_group is None, any example from that campaign is acceptable.
    def is_annotated_by_all_groups(group):
        for camp, req_group in annotator_groups:
            if req_group is None:
                if camp not in group["campaign_id"].values:
                    return False
            else:
                if not (((group["campaign_id"] == camp) & (group["annotator_group"] == req_group)).any()):
                    return False
        return True

    # Group by the identifying columns and filter accordingly
    groups = combined_examples.groupby(["dataset", "split", "setup_id", "example_idx"])
    valid_keys = [key for key, group in groups if is_annotated_by_all_groups(group)]

    # Create a DataFrame from the valid example keys
    filtered_examples = pd.DataFrame(valid_keys, columns=["dataset", "split", "setup_id", "example_idx"])

    # Report number of examples skipped
    total_unique = groups.ngroups
    skipped = total_unique - filtered_examples.shape[0]

    if skipped > 0:
        logger.info(f"Skipped {skipped} examples not annotated by all required groups.")

    return filtered_examples
