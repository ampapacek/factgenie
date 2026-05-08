#!/usr/bin/env python3

import csv
import datetime
import json
import uuid
from io import StringIO
from pathlib import Path

import pandas as pd

from factgenie import CAMPAIGN_DIR

QUEUE_VERSION = 1
STATUS_PENDING = "pending"
STATUS_COMPLETED = "completed"
STATUS_CANCELLED = "cancelled"

KEY_FIELDS = [
    "campaign_id",
    "annotator_id",
    "annotator_group",
    "batch_idx",
    "dataset",
    "split",
    "setup_id",
    "example_idx",
]


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def queue_path(campaign_id):
    return Path(CAMPAIGN_DIR) / campaign_id / "redo_queue.json"


def revision_log_path(campaign_id):
    return Path(CAMPAIGN_DIR) / campaign_id / "files" / "revisions" / "revision_log.jsonl"


def empty_queue(campaign_id):
    return {
        "version": QUEUE_VERSION,
        "campaign_id": campaign_id,
        "items": [],
    }


def load_queue(campaign_id):
    path = queue_path(campaign_id)
    if not path.exists():
        return empty_queue(campaign_id)

    with open(path) as f:
        data = json.load(f)

    data.setdefault("version", QUEUE_VERSION)
    data.setdefault("campaign_id", campaign_id)
    data.setdefault("items", [])
    return data


def save_queue(campaign_id, queue):
    path = queue_path(campaign_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    queue.pop("annotator_modes", None)
    with open(path, "w") as f:
        json.dump(queue, f, indent=2, ensure_ascii=False)


def normalize_annotator_id(value):
    if value is None:
        return ""
    if pd.isna(value):
        return ""
    text = str(value).strip()
    if not text or text.lower() in {"nan", "<na>"}:
        return ""
    return text


def normalize_key_value(field, value):
    if field in {"annotator_group", "batch_idx", "example_idx"}:
        if pd.isna(value):
            return ""
        return str(int(value))
    return str(value or "").strip()


def item_key(item):
    return tuple(normalize_key_value(field, item.get(field)) for field in KEY_FIELDS)


def admin_row_key(row):
    return json.dumps(
        [
            normalize_annotator_id(row.get("annotator_id")),
            normalize_key_value("annotator_group", row.get("annotator_group")),
            normalize_key_value("batch_idx", row.get("batch_idx", row.get("example_idx", 0))),
            normalize_key_value("dataset", row.get("dataset")),
            normalize_key_value("split", row.get("split")),
            normalize_key_value("setup_id", row.get("setup_id")),
            normalize_key_value("example_idx", row.get("example_idx")),
        ],
        ensure_ascii=False,
    )


def row_to_item(campaign_id, row, annotator_id=None, source=None, instruction=None, created_by="admin"):
    now = utc_now()
    annotator = normalize_annotator_id(annotator_id if annotator_id is not None else row.get("annotator_id"))
    return {
        "redo_id": f"redo_{uuid.uuid4().hex}",
        "campaign_id": campaign_id,
        "annotator_id": annotator,
        "annotator_group": int(row.get("annotator_group", 0)),
        "batch_idx": int(row.get("batch_idx", row.get("example_idx", 0))),
        "dataset": str(row.get("dataset")),
        "split": str(row.get("split")),
        "setup_id": str(row.get("setup_id")),
        "example_idx": int(row.get("example_idx")),
        "jsonl_file": row.get("jsonl_file"),
        "status": STATUS_PENDING,
        "created_at": now,
        "created_by": created_by,
        "saved_at": None,
        "saved_by": None,
        "completed_count": 0,
        "instruction": instruction,
        "source": source or {"type": "manual", "selector": "example"},
    }


def find_item(queue, redo_id):
    for item in queue.get("items", []):
        if item.get("redo_id") == redo_id:
            return item
    return None


def find_equivalent_item(queue, item):
    key = item_key(item)
    for existing in queue.get("items", []):
        if existing.get("status") != STATUS_CANCELLED and item_key(existing) == key:
            return existing
    return None


def add_items(campaign_id, rows, created_by="admin", instruction=None, source=None):
    queue = load_queue(campaign_id)
    added = []
    reused = []

    for row in rows:
        item = row_to_item(
            campaign_id,
            row,
            annotator_id=row.get("annotator_id"),
            source=source,
            instruction=instruction,
            created_by=created_by,
        )
        existing = find_equivalent_item(queue, item)
        if existing:
            existing["instruction"] = instruction
            existing["source"] = source or existing.get("source") or {"type": "manual", "selector": "example"}
            if existing.get("status") == STATUS_COMPLETED:
                existing["status"] = STATUS_PENDING
                existing["reopened_at"] = utc_now()
                existing["reopened_by"] = created_by
            reused.append(existing)
        else:
            queue["items"].append(item)
            added.append(item)

    save_queue(campaign_id, queue)
    return {"added": added, "reused": reused, "queue": queue}


def is_redo_mode(campaign_id, annotator_id):
    return pending_count(campaign_id, annotator_id) > 0


def list_items_for_annotator(campaign_id, annotator_id, include_completed=False):
    queue = load_queue(campaign_id)
    annotator_id = normalize_annotator_id(annotator_id)
    items = [
        item
        for item in queue.get("items", [])
        if normalize_annotator_id(item.get("annotator_id")) == annotator_id
        and item.get("status") != STATUS_CANCELLED
        and (include_completed or item.get("status") == STATUS_PENDING)
    ]
    return sorted(
        items,
        key=lambda item: (
            int(item.get("batch_idx", 0)),
            int(item.get("example_idx", 0)),
            str(item.get("setup_id", "")),
        ),
    )


def counts_by_annotator(campaign_id):
    queue = load_queue(campaign_id)
    counts = {}
    for item in queue.get("items", []):
        annotator_id = normalize_annotator_id(item.get("annotator_id"))
        if not annotator_id:
            continue
        counts.setdefault(annotator_id, {STATUS_PENDING: 0, STATUS_COMPLETED: 0, STATUS_CANCELLED: 0})
        status = item.get("status", STATUS_PENDING)
        counts[annotator_id][status] = counts[annotator_id].get(status, 0) + 1
    return counts


def pending_count(campaign_id, annotator_id):
    return counts_by_annotator(campaign_id).get(normalize_annotator_id(annotator_id), {}).get(STATUS_PENDING, 0)


def mark_completed(campaign_id, redo_id, saved_by):
    queue = load_queue(campaign_id)
    item = find_item(queue, redo_id)
    if item is None:
        raise ValueError(f"Unknown redo item: {redo_id}")
    item["status"] = STATUS_COMPLETED
    item["saved_at"] = utc_now()
    item["saved_by"] = saved_by
    item["completed_count"] = int(item.get("completed_count") or 0) + 1
    save_queue(campaign_id, queue)
    return item


def cancel_items(campaign_id, redo_ids):
    queue = load_queue(campaign_id)
    cancelled = []
    redo_ids = set(redo_ids)
    for item in queue.get("items", []):
        if item.get("redo_id") in redo_ids and item.get("status") == STATUS_PENDING:
            item["status"] = STATUS_CANCELLED
            cancelled.append(item)
    save_queue(campaign_id, queue)
    return cancelled


def find_original_revision(campaign_id, redo_id):
    matching = [revision for revision in load_revision_log(campaign_id) if revision.get("redo_id") == redo_id]
    if not matching:
        return None
    return matching[0]


def restore_original_annotations(campaign_id, redo_ids, restored_by="admin"):
    queue = load_queue(campaign_id)
    redo_ids = set(redo_ids)
    restored = []
    errors = []
    queue_file = queue_path(campaign_id)
    revision_file = revision_log_path(campaign_id)
    queue_backup = queue_file.read_text(encoding="utf-8") if queue_file.exists() else None
    revision_backup = revision_file.read_text(encoding="utf-8") if revision_file.exists() else None
    active_backups = {}
    restored_file_backups = {}

    def restore_backups():
        if queue_backup is not None:
            queue_file.write_text(queue_backup, encoding="utf-8")
        elif queue_file.exists():
            queue_file.unlink()

        if revision_backup is not None:
            revision_file.write_text(revision_backup, encoding="utf-8")
        elif revision_file.exists():
            revision_file.unlink()

        for file_path, content in active_backups.items():
            path = Path(file_path)
            if content is not None:
                path.write_text(content, encoding="utf-8")
            elif path.exists():
                path.unlink()

        for file_path, content in restored_file_backups.items():
            path = Path(file_path)
            if content is not None:
                path.write_text(content, encoding="utf-8")
            elif path.exists():
                path.unlink()

    for item in queue.get("items", []):
        redo_id = item.get("redo_id")
        if redo_id not in redo_ids:
            continue
        if item.get("status") != STATUS_COMPLETED:
            errors.append({"redo_id": redo_id, "error": "Only completed redo items can be restored."})
            continue

        original_revision = find_original_revision(campaign_id, redo_id)
        if not original_revision or not original_revision.get("record"):
            errors.append({"redo_id": redo_id, "error": "No archived original annotation found."})
            continue

        try:
            for match in find_active_records(campaign_id, item):
                match_path = str(match["file"])
                if match_path not in active_backups:
                    active_backups[match_path] = match["file"].read_text(encoding="utf-8")

            archive_and_remove_active_records(
                campaign_id,
                item,
                archived_by=restored_by,
                replacement_saved_at=utc_now(),
            )

            record = original_revision["record"]
            files_dir = Path(CAMPAIGN_DIR) / campaign_id / "files"
            files_dir.mkdir(parents=True, exist_ok=True)
            filename = (
                f"{item.get('batch_idx')}-{item.get('annotator_group', 0)}-"
                f"{normalize_annotator_id(item.get('annotator_id'))}-restored-{uuid.uuid4().hex[:8]}.jsonl"
            )
            restored_path = files_dir / filename
            restored_file_backups[str(restored_path)] = (
                restored_path.read_text(encoding="utf-8") if restored_path.exists() else None
            )
            with open(restored_path, "a") as f:
                f.write(json.dumps(record, ensure_ascii=False, allow_nan=True) + "\n")
        except Exception:
            restore_backups()
            raise

        item["restored_at"] = utc_now()
        item["restored_by"] = restored_by
        item["restore_count"] = int(item.get("restore_count") or 0) + 1
        restored.append(item)

    if restored:
        try:
            save_queue(campaign_id, queue)
        except Exception:
            restore_backups()
            raise
    return {"restored": restored, "errors": errors}


def is_skip_selected(flags):
    if not isinstance(flags, list):
        return False
    for flag in flags:
        if not isinstance(flag, dict) or not flag.get("value"):
            continue
        label = str(flag.get("label", "")).lower()
        if "skip" in label or "přeskoč" in label:
            return True
    return False


def active_files(campaign_id):
    files_dir = Path(CAMPAIGN_DIR) / campaign_id / "files"
    if not files_dir.exists():
        return []
    return sorted(files_dir.glob("*.jsonl"))


def record_matches_item(record, item):
    metadata = record.get("metadata", {})
    return (
        str(record.get("dataset")) == str(item.get("dataset"))
        and str(record.get("split")) == str(item.get("split"))
        and str(record.get("setup_id")) == str(item.get("setup_id"))
        and int(record.get("example_idx")) == int(item.get("example_idx"))
        and normalize_annotator_id(metadata.get("annotator_id")) == normalize_annotator_id(item.get("annotator_id"))
        and str(int(metadata.get("annotator_group", 0))) == str(int(item.get("annotator_group", 0)))
    )


def find_active_records(campaign_id, item):
    matches = []
    for jsonl_file in active_files(campaign_id):
        with open(jsonl_file) as f:
            for line_index, line in enumerate(f):
                if not line.strip():
                    continue
                record = json.loads(line)
                if record_matches_item(record, item):
                    matches.append(
                        {
                            "file": jsonl_file,
                            "line_index": line_index,
                            "line": line,
                            "record": record,
                        }
                    )
    return matches


def latest_active_record(campaign_id, item):
    matches = find_active_records(campaign_id, item)
    if not matches:
        return None

    def sort_key(match):
        metadata = match["record"].get("metadata", {})
        return (
            float(metadata.get("end_timestamp") or 0),
            match["file"].stat().st_mtime,
            match["line_index"],
        )

    return sorted(matches, key=sort_key)[-1]["record"]


def archive_and_remove_active_records(campaign_id, item, archived_by, replacement_saved_at):
    matches = find_active_records(campaign_id, item)
    if not matches:
        return []

    archived = []
    log_path = revision_log_path(campaign_id)
    log_path.parent.mkdir(parents=True, exist_ok=True)

    matches_by_file = {}
    for match in matches:
        matches_by_file.setdefault(match["file"], set()).add(match["line_index"])

        revision = {
            "revision_id": f"rev_{uuid.uuid4().hex}",
            "redo_id": item.get("redo_id"),
            "campaign_id": campaign_id,
            "annotator_id": item.get("annotator_id"),
            "annotator_group": item.get("annotator_group"),
            "batch_idx": item.get("batch_idx"),
            "dataset": item.get("dataset"),
            "split": item.get("split"),
            "setup_id": item.get("setup_id"),
            "example_idx": item.get("example_idx"),
            "original_jsonl_file": match["file"].name,
            "archived_at": utc_now(),
            "archived_by": archived_by,
            "replacement_saved_at": replacement_saved_at,
            "instruction": item.get("instruction"),
            "record": match["record"],
        }
        archived.append(revision)

    with open(log_path, "a") as f:
        for revision in archived:
            f.write(json.dumps(revision, ensure_ascii=False, allow_nan=True) + "\n")

    for jsonl_file, line_indexes in matches_by_file.items():
        with open(jsonl_file) as f:
            lines = f.readlines()
        with open(jsonl_file, "w") as f:
            for idx, line in enumerate(lines):
                if idx not in line_indexes:
                    f.write(line)

    return archived


def load_revision_log(campaign_id):
    path = revision_log_path(campaign_id)
    if not path.exists():
        return []
    revisions = []
    with open(path) as f:
        for line in f:
            if line.strip():
                revisions.append(json.loads(line))
    return revisions


def rows_to_csv(rows):
    if not rows:
        return ""
    output = StringIO()
    fieldnames = sorted({key for row in rows for key in row.keys() if key != "record"})
    writer = csv.DictWriter(output, fieldnames=fieldnames)
    writer.writeheader()
    for row in rows:
        writer.writerow({field: row.get(field) for field in fieldnames})
    return output.getvalue()


def category_lookup(campaign):
    categories = campaign.metadata.get("config", {}).get("annotation_span_categories", [])
    return {
        index: category.get("name", str(index)) if isinstance(category, dict) else str(category)
        for index, category in enumerate(categories)
    }


def slider_labels_from_config(campaign):
    sliders = campaign.metadata.get("config", {}).get("sliders", [])
    return [
        str(slider["label"])
        for slider in sliders
        if isinstance(slider, dict) and slider.get("label") is not None
    ]


def slider_labels_from_record(record):
    labels = []
    for slider in record.get("sliders", []) if record else []:
        if isinstance(slider, dict) and slider.get("label") is not None:
            labels.append(str(slider["label"]))
    return labels


def text_values_for_keys(value, keys):
    texts = []
    if isinstance(value, dict):
        for key, child in value.items():
            if str(key).casefold() in keys and child is not None:
                texts.append(str(child))
            texts.extend(text_values_for_keys(child, keys))
    elif isinstance(value, list):
        for child in value:
            texts.extend(text_values_for_keys(child, keys))
    return texts


def text_field_values(record):
    values = []
    for field in record.get("text_fields", []) if record else []:
        if isinstance(field, dict) and field.get("value") is not None:
            values.append(str(field["value"]))
    return values


def span_filter_data(record, categories):
    spans = []
    annotations = record.get("annotations", []) if record else []
    for annotation in annotations:
        if not isinstance(annotation, dict) or not annotation.get("text"):
            continue
        try:
            annotation_type = int(annotation.get("type", annotation.get("annotation_type")))
        except (TypeError, ValueError):
            annotation_type = None
        category = categories.get(annotation_type, str(annotation_type))
        reason = str(annotation.get("reason") or "").strip()
        spans.append(
            {
                "category": category,
                "text": str(annotation.get("text") or ""),
                "reason": reason,
                "reason_missing": reason == "",
            }
        )

    sliders = []
    for slider in record.get("sliders", []) if record else []:
        if not isinstance(slider, dict) or slider.get("label") is None:
            continue
        raw_value = slider.get("value")
        try:
            numeric_value = float(raw_value)
        except (TypeError, ValueError):
            numeric_value = None
        sliders.append(
            {
                "label": str(slider["label"]),
                "value": raw_value,
                "numeric_value": numeric_value,
                "missing": raw_value in (None, ""),
            }
        )

    question_texts = text_values_for_keys(record or {}, {"question"})
    output_texts = text_values_for_keys(record or {}, {"output"})
    any_texts = (
        text_values_for_keys(record or {}, {"question", "output", "text", "reason"})
        + text_field_values(record or {})
    )
    has_chybi = any(span["category"].casefold() == "chybí".casefold() for span in spans)
    has_missing_reason = any(span["reason_missing"] for span in spans)
    has_chybi_without_top10 = any(
        span["category"].casefold() == "chybí".casefold() and "top10" not in span["reason"].casefold()
        for span in spans
    )
    return {
        "spans": spans,
        "sliders": sliders,
        "question_texts": question_texts,
        "output_texts": output_texts,
        "any_texts": any_texts,
        "span_categories": sorted({span["category"] for span in spans}, key=lambda value: value.casefold()),
        "span_reasons": [span["reason"] for span in spans if span["reason"]],
        "has_chybi": has_chybi,
        "has_missing_reason": has_missing_reason,
        "has_chybi_without_top10": has_chybi_without_top10,
    }


def build_admin_overview(campaign, alias_map=None):
    alias_map = alias_map or {}
    queue = load_queue(campaign.campaign_id)
    counts = counts_by_annotator(campaign.campaign_id)
    queue_by_key = {item_key(item): item for item in queue.get("items", []) if item.get("status") != STATUS_CANCELLED}
    categories = category_lookup(campaign)

    examples = []
    annotator_ids = set()
    db = campaign.db.copy() if hasattr(campaign, "db") else pd.DataFrame()
    slider_labels = set(slider_labels_from_config(campaign))
    if db.empty:
        return {
            "annotators": [],
            "examples": [],
            "queue": queue,
            "filter_options": {"categories": [], "sliders": sorted(slider_labels, key=lambda value: value.casefold())},
        }

    for _, row in db.iterrows():
        annotator_id = normalize_annotator_id(row.get("annotator_id"))
        if not annotator_id:
            continue
        annotator_ids.add(annotator_id)
        item = row_to_item(campaign.campaign_id, row, annotator_id=annotator_id)
        existing = queue_by_key.get(item_key(item))
        active_record = latest_active_record(campaign.campaign_id, item)
        flags = active_record.get("flags", []) if active_record else []
        slider_labels.update(slider_labels_from_record(active_record))
        example = {
            "annotator_id": annotator_id,
            "annotator_alias": alias_map.get(annotator_id.lower(), ""),
            "batch_idx": int(row.get("batch_idx", row.get("example_idx", 0))),
            "dataset": row.get("dataset"),
            "split": row.get("split"),
            "setup_id": row.get("setup_id"),
            "example_idx": int(row.get("example_idx")),
            "annotator_group": int(row.get("annotator_group", 0)),
            "status": row.get("status"),
            "skipped": is_skip_selected(flags),
            "redo_id": existing.get("redo_id") if existing else "",
            "redo_status": existing.get("status") if existing else "",
            "row_key": admin_row_key(row),
        }
        examples.append(example)

    annotators = []
    for annotator_id in sorted(annotator_ids, key=lambda value: value.lower()):
        annotators.append(
            {
                "id": annotator_id,
                "alias": alias_map.get(annotator_id.lower(), ""),
                "counts": counts.get(
                    annotator_id,
                    {STATUS_PENDING: 0, STATUS_COMPLETED: 0, STATUS_CANCELLED: 0},
                ),
            }
        )

    examples.sort(key=lambda row: (row["annotator_id"].lower(), row["batch_idx"], row["example_idx"], row["setup_id"]))
    return {
        "annotators": annotators,
        "examples": examples,
        "queue": queue,
        "filter_options": {
            "categories": [categories[index] for index in sorted(categories)],
            "sliders": sorted(slider_labels, key=lambda value: value.casefold()),
        },
    }


def build_admin_filter_payload(campaign):
    categories = category_lookup(campaign)
    db = campaign.db.copy() if hasattr(campaign, "db") else pd.DataFrame()
    rows = []
    if db.empty:
        return {"rows": rows}

    for _, row in db.iterrows():
        annotator_id = normalize_annotator_id(row.get("annotator_id"))
        if not annotator_id:
            continue
        item = row_to_item(campaign.campaign_id, row, annotator_id=annotator_id)
        active_record = latest_active_record(campaign.campaign_id, item)
        rows.append(
            {
                "row_key": admin_row_key(row),
                "filter_data": span_filter_data(active_record, categories),
            }
        )

    return {"rows": rows}
