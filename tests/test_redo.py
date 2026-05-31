import json
import threading
import zipfile
import logging
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

import pandas as pd
import pytest
from flask import Flask

import factgenie.app as app_mod
import factgenie.analysis as analysis
import factgenie.campaign as campaign_mod
import factgenie.crowdsourcing as crowdsourcing
import factgenie.querying as querying
import factgenie.redo as redo
import factgenie.workflows as workflows
from factgenie.campaign import Campaign, CampaignMode, ExampleStatus, HumanCampaign


def configure_campaign_dir(monkeypatch, tmp_path):
    monkeypatch.setattr(redo, "CAMPAIGN_DIR", tmp_path)
    monkeypatch.setattr(workflows, "CAMPAIGN_DIR", tmp_path)
    monkeypatch.setattr(crowdsourcing, "CAMPAIGN_DIR", tmp_path)
    monkeypatch.setattr(campaign_mod, "CAMPAIGN_DIR", tmp_path)


def make_campaign(tmp_path, campaign_id="redo-test"):
    campaign_dir = tmp_path / campaign_id
    files_dir = campaign_dir / "files"
    files_dir.mkdir(parents=True)
    metadata = {
        "id": campaign_id,
        "mode": CampaignMode.CROWDSOURCING,
        "created": "2026-05-07 12:00:00",
        "config": {
            "annotation_span_categories": [
                {"name": "Issue", "color": "#ff0000"},
                {"name": "Jádro", "color": "#00ff00"},
                {"name": "Nadbytečné", "color": "#0000ff"},
                {"name": "Zavádějící", "color": "#000088"},
                {"name": "Nesrozumitelné", "color": "#888800"},
                {"name": "Nepravda", "color": "#880000"},
                {"name": "Chybí", "color": "#0088ff"},
            ],
            "annotation_granularity": "word",
            "annotation_overlap_allowed": False,
            "annotator_instructions": "Annotate.",
            "final_message": "Thanks.",
        },
    }
    (campaign_dir / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
    db = pd.DataFrame(
        [
            {
                "dataset": "dataset-a",
                "split": "test",
                "setup_id": "setup-a",
                "example_idx": 0,
                "batch_idx": 0,
                "annotator_group": 0,
                "annotator_id": "ann-a",
                "status": ExampleStatus.FINISHED,
                "start": 10,
                "end": 20,
            }
        ]
    )
    db.to_csv(campaign_dir / "db.csv", index=False)
    return Campaign(campaign_id)


def write_active_record(campaign_id, filename, annotation_text="old", end_timestamp=20):
    record = {
        "dataset": "dataset-a",
        "split": "test",
        "setup_id": "setup-a",
        "example_idx": 0,
        "output": "old output",
        "annotations": [{"type": 0, "start": 0, "text": annotation_text}],
        "flags": [{"label": "Skip", "value": False}],
        "options": [{"label": "Quality", "index": 0, "value": "Good"}],
        "sliders": [{"label": "Tone", "value": 3}],
        "text_fields": [{"label": "Note", "value": "old note"}],
        "metadata": {
            "campaign_id": campaign_id,
            "annotator_id": "ann-a",
            "annotator_group": 0,
            "annotation_span_categories": [{"name": "Issue", "color": "#ff0000"}],
            "end_timestamp": end_timestamp,
        },
    }
    path = Path(redo.CAMPAIGN_DIR) / campaign_id / "files" / filename
    path.write_text(json.dumps(record) + "\n", encoding="utf-8")
    return record


def make_per_example_campaign(tmp_path, campaign_id="per-example-test"):
    campaign_dir = tmp_path / campaign_id
    files_dir = campaign_dir / "files"
    files_dir.mkdir(parents=True)
    metadata = {
        "id": campaign_id,
        "mode": CampaignMode.CROWDSOURCING,
        "created": "2026-05-30 12:00:00",
        "config": {
            "annotation_span_categories": [{"name": "Issue", "color": "#ff0000"}],
            "annotation_granularity": "word",
            "annotation_overlap_allowed": False,
            "annotator_instructions": "Annotate.",
            "final_message": "Thanks.",
            "save_mode": "per_example",
        },
    }
    (campaign_dir / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
    db = pd.DataFrame(
        [
            {
                "dataset": "dataset-a",
                "split": "test",
                "setup_id": "setup-a",
                "example_idx": 0,
                "batch_idx": 0,
                "annotator_group": 0,
                "annotator_id": "ann-a",
                "status": ExampleStatus.ASSIGNED,
                "start": 10,
                "end": None,
            },
            {
                "dataset": "dataset-a",
                "split": "test",
                "setup_id": "setup-a",
                "example_idx": 1,
                "batch_idx": 0,
                "annotator_group": 0,
                "annotator_id": "ann-a",
                "status": ExampleStatus.ASSIGNED,
                "start": 10,
                "end": None,
            },
        ]
    )
    db.to_csv(campaign_dir / "db.csv", index=False)
    return Campaign(campaign_id)


def write_custom_active_record(campaign_id, filename, **overrides):
    record = active_record_with_overrides(campaign_id, **overrides)
    path = Path(redo.CAMPAIGN_DIR) / campaign_id / "files" / filename
    path.write_text(json.dumps(record, ensure_ascii=False) + "\n", encoding="utf-8")
    return record


def active_record_with_overrides(campaign_id, annotation_text="old", end_timestamp=20, **overrides):
    record = {
        "dataset": "dataset-a",
        "split": "test",
        "setup_id": "setup-a",
        "example_idx": 0,
        "output": "old output",
        "annotations": [{"type": 0, "start": 0, "text": annotation_text}],
        "flags": [{"label": "Skip", "value": False}],
        "options": [{"label": "Quality", "index": 0, "value": "Good"}],
        "sliders": [{"label": "Tone", "value": 3}],
        "text_fields": [{"label": "Note", "value": "old note"}],
        "metadata": {
            "campaign_id": campaign_id,
            "annotator_id": "ann-a",
            "annotator_group": 0,
            "annotation_span_categories": [{"name": "Issue", "color": "#ff0000"}],
            "end_timestamp": end_timestamp,
        },
    }
    for key, value in overrides.items():
        if key == "metadata":
            record["metadata"].update(value)
        else:
            record[key] = value
    return record


def write_active_record_with_annotations(campaign_id, filename, annotations, end_timestamp=20):
    record = write_active_record(campaign_id, filename, end_timestamp=end_timestamp)
    record["annotations"] = annotations
    path = Path(redo.CAMPAIGN_DIR) / campaign_id / "files" / filename
    path.write_text(json.dumps(record, ensure_ascii=False) + "\n", encoding="utf-8")
    return record


def queue_row():
    return {
        "campaign_id": "redo-test",
        "dataset": "dataset-a",
        "split": "test",
        "setup_id": "setup-a",
        "example_idx": 0,
        "batch_idx": 0,
        "annotator_group": 0,
        "annotator_id": "ann-a",
    }


def condition(field, op, value="", slider_label=None, span_group=None):
    payload = {"field": field, "op": op, "value": value}
    if slider_label is not None:
        payload["sliderLabel"] = slider_label
    if span_group is not None:
        payload["spanGroup"] = span_group
    return payload


def redo_filter(campaign, conditions, mode="all", **kwargs):
    return redo.build_admin_filter_result(
        campaign,
        filters={"mode": mode, "conditions": conditions},
        **kwargs,
    )


def test_queue_duplicate_reuse_and_pending_mode(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    make_campaign(tmp_path)

    first = redo.add_items("redo-test", [queue_row()], instruction="Fix this")
    second = redo.add_items("redo-test", [queue_row()], instruction="Fix this again")

    queue = redo.load_queue("redo-test")
    assert len(queue["items"]) == 1
    assert len(first["added"]) == 1
    assert len(second["reused"]) == 1
    assert queue["items"][0]["instruction"] == "Fix this again"

    assert redo.is_redo_mode("redo-test", "ann-a")
    assert redo.counts_by_annotator("redo-test")["ann-a"][redo.STATUS_PENDING] == 1


def test_queue_item_stores_match_metadata(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    make_campaign(tmp_path)
    row = {
        **queue_row(),
        "match_details": [
            {
                "target": "span",
                "field": "span_text",
                "setup_id": "setup-a",
                "matched_text": "old",
                "start": 0,
            }
        ],
        "match_source": "filtered_selection",
    }

    item = redo.add_items("redo-test", [row])["added"][0]

    assert item["match_details"] == row["match_details"]
    assert item["match_source"] == "filtered_selection"


def test_readding_redo_item_updates_match_metadata(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    make_campaign(tmp_path)
    first = redo.add_items(
        "redo-test",
        [
            {
                **queue_row(),
                "match_details": [{"target": "question", "matched_text": "first"}],
                "match_source": "filtered_selection",
            }
        ],
    )["added"][0]
    redo.mark_completed("redo-test", first["redo_id"], "ann-a")

    redo.add_items(
        "redo-test",
        [
            {
                **queue_row(),
                "match_details": [{"target": "slider", "slider_label": "Tone", "slider_value": 3}],
                "match_source": "filtered_selection",
            }
        ],
        created_by="admin-b",
    )
    item = redo.find_item(redo.load_queue("redo-test"), first["redo_id"])

    assert item["status"] == redo.STATUS_PENDING
    assert item["match_details"] == [{"target": "slider", "slider_label": "Tone", "slider_value": 3}]
    assert item["match_source"] == "filtered_selection"


def test_redo_annotation_set_serves_match_metadata(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)
    match_details = [{"target": "output", "matched_text": "old output", "setup_id": "setup-a"}]
    redo.add_items(
        "redo-test",
        [{**queue_row(), "match_details": match_details, "match_source": "filtered_selection"}],
    )

    annotation_set = crowdsourcing.get_redo_annotation_set(None, campaign, campaign.db, "ann-a")

    assert annotation_set[0]["redo_match_details"] == match_details
    assert annotation_set[0]["redo_match_source"] == "filtered_selection"


def test_admin_overview_exposes_span_filter_data_for_category_and_reasons(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)
    write_active_record_with_annotations(
        "redo-test",
        "0-0-ann-a-20.jsonl",
        [
            {"type": 6, "text": "①", "start": 0, "reason": ""},
            {"type": 0, "text": "typo", "start": 5, "reason": "Není čeština"},
        ],
    )

    overview = redo.build_admin_overview(campaign)
    payload = redo.build_admin_filter_payload(campaign)
    filter_data = payload["rows"][0]["filter_data"]

    assert "Chybí" in overview["filter_options"]["categories"]
    assert "row_key" in overview["examples"][0]
    assert "Chybí" in filter_data["span_categories"]
    assert filter_data["has_chybi"] is True
    assert filter_data["has_missing_reason"] is True
    assert filter_data["has_chybi_without_top10"] is True
    assert {"category": "Chybí", "text": "①", "reason": "", "reason_missing": True, "start": 0} in filter_data["spans"]


def test_admin_overview_exposes_text_and_slider_filter_data(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)
    record = write_active_record_with_annotations(
        "redo-test",
        "0-0-ann-a-20.jsonl",
        [{"type": 0, "text": "span text", "start": 0, "reason": "span reason"}],
    )
    record["question"] = "Which claim is supported?"
    record["data"] = {"question": "Nested dataset question"}
    record["output"] = "Generated answer"
    record["text_fields"] = [{"label": "Admin note", "value": "free text note"}]
    record["sliders"] = [{"label": "Tone", "value": "4"}]
    path = Path(redo.CAMPAIGN_DIR) / "redo-test" / "files" / "0-0-ann-a-20.jsonl"
    path.write_text(json.dumps(record, ensure_ascii=False) + "\n", encoding="utf-8")

    overview = redo.build_admin_overview(campaign)
    payload = redo.build_admin_filter_payload(campaign)
    filter_data = payload["rows"][0]["filter_data"]

    assert "Tone" not in overview["filter_options"]["sliders"]
    assert "Tone" in payload["filter_options"]["sliders"]
    assert "Which claim is supported?" in filter_data["question_texts"]
    assert "Nested dataset question" in filter_data["question_texts"]
    assert "Generated answer" in filter_data["output_texts"]
    assert "free text note" in filter_data["any_texts"]
    assert {"label": "Tone", "value": "4", "numeric_value": 4.0, "missing": False} in filter_data["sliders"]


def test_admin_overview_does_not_load_annotation_records(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)

    def fail_if_loaded(*args, **kwargs):
        raise AssertionError("admin overview should not read annotation JSONL records")

    monkeypatch.setattr(redo, "latest_active_record", fail_if_loaded)

    overview = redo.build_admin_overview(campaign)

    assert overview["examples"]
    assert overview["examples"][0]["skipped"] is None


def test_admin_overview_treats_top10_reasons_as_present_for_chybi_filter(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)

    write_active_record_with_annotations(
        "redo-test",
        "0-0-ann-a-20.jsonl",
        [{"type": 6, "text": "①", "start": 0, "reason": "InTop10 InSeafile"}],
        end_timestamp=20,
    )
    assert redo.build_admin_filter_payload(campaign)["rows"][0]["filter_data"]["has_chybi_without_top10"] is False

    write_active_record_with_annotations(
        "redo-test",
        "0-0-ann-a-30.jsonl",
        [{"type": 6, "text": "①", "start": 0, "reason": "NotInTop10 InSeafile"}],
        end_timestamp=30,
    )
    assert redo.build_admin_filter_payload(campaign)["rows"][0]["filter_data"]["has_chybi_without_top10"] is False


def test_admin_overview_marks_chybi_without_top10_when_reason_lacks_token(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)
    write_active_record_with_annotations(
        "redo-test",
        "0-0-ann-a-20.jsonl",
        [{"type": 6, "text": "①", "start": 0, "reason": "InSeafile missing example"}],
    )

    filter_data = redo.build_admin_filter_payload(campaign)["rows"][0]["filter_data"]

    assert filter_data["has_chybi"] is True
    assert filter_data["has_missing_reason"] is False
    assert filter_data["has_chybi_without_top10"] is True


def test_admin_backend_filter_uses_same_span_semantics(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)
    write_active_record_with_annotations(
        "redo-test",
        "0-0-ann-a-20.jsonl",
        [
            {"type": 6, "text": "missing city", "start": 0, "reason": "NotInTop10"},
            {"type": 0, "text": "other", "start": 5, "reason": "InSeafile"},
        ],
    )

    crossed_spans = redo_filter(
        campaign,
        [
            condition("span_category", "eq", "Chybí"),
            condition("span_reason", "contains", "InSeafile"),
        ],
    )
    same_span = redo_filter(
        campaign,
        [
            condition("span_category", "eq", "Chybí"),
            condition("span_reason", "contains", "NotInTop10"),
        ],
    )

    assert crossed_spans["visible_count"] == 0
    assert same_span["visible_count"] == 1
    assert same_span["rows"][0]["match_details"][0]["start"] == 0


def test_admin_backend_filter_requires_one_reason_to_match_multiple_reason_conditions(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)
    write_active_record_with_annotations(
        "redo-test",
        "0-0-ann-a-20.jsonl",
        [
            {"type": 6, "text": "one", "start": 0, "reason": "NotInTop10"},
            {"type": 6, "text": "two", "start": 5, "reason": "InSeafile"},
        ],
    )

    split_reasons = redo_filter(
        campaign,
        [
            condition("span_reason", "contains", "NotInTop10"),
            condition("span_reason", "contains", "InSeafile"),
        ],
    )

    write_active_record_with_annotations(
        "redo-test",
        "0-0-ann-a-30.jsonl",
        [{"type": 6, "text": "one", "start": 0, "reason": "NotInTop10 InSeafile"}],
        end_timestamp=30,
    )
    same_reason = redo_filter(
        campaign,
        [
            condition("span_reason", "contains", "NotInTop10"),
            condition("span_reason", "contains", "InSeafile"),
        ],
    )

    assert split_reasons["visible_count"] == 0
    assert same_reason["visible_count"] == 1


def test_admin_backend_filter_matches_setup_condition_by_setup_id(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)
    campaign.db = pd.DataFrame(
        [
            {**queue_row(), "status": ExampleStatus.FINISHED, "start": 10, "end": 20},
            {
                **queue_row(),
                "setup_id": "setup-b",
                "annotator_id": "ann-b",
                "annotator_group": 1,
                "status": ExampleStatus.FINISHED,
                "start": 10,
                "end": 20,
            },
            {
                **queue_row(),
                "setup_id": "setup-unsaved",
                "annotator_id": "ann-c",
                "annotator_group": 2,
                "status": ExampleStatus.ASSIGNED,
            },
        ]
    )
    write_custom_active_record(
        "redo-test",
        "setup-a-ann-a.jsonl",
        metadata={"annotator_id": "ann-a", "annotator_group": 0},
    )
    write_custom_active_record(
        "redo-test",
        "setup-b-ann-b.jsonl",
        setup_id="setup-b",
        metadata={"annotator_id": "ann-b", "annotator_group": 1},
    )

    result = redo_filter(campaign, [condition("setup", "eq", "setup-b")])

    assert result["visible_count"] == 1
    assert result["rows"][0]["row_key"] == redo.admin_row_key(campaign.db.iloc[1])
    assert "setup-unsaved" in result["filter_options"]["setups"]


def test_admin_backend_filter_matches_split_condition(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)
    campaign.db = pd.DataFrame(
        [
            {**queue_row(), "status": ExampleStatus.FINISHED, "start": 10, "end": 20},
            {
                **queue_row(),
                "split": "dev",
                "annotator_id": "ann-b",
                "annotator_group": 1,
                "status": ExampleStatus.FINISHED,
                "start": 10,
                "end": 20,
            },
        ]
    )
    write_custom_active_record(
        "redo-test",
        "test-ann-a.jsonl",
        metadata={"annotator_id": "ann-a", "annotator_group": 0},
    )
    write_custom_active_record(
        "redo-test",
        "dev-ann-b.jsonl",
        split="dev",
        metadata={"annotator_id": "ann-b", "annotator_group": 1},
    )

    result = redo_filter(campaign, [condition("split", "eq", "dev")])

    assert result["visible_count"] == 1
    assert result["rows"][0]["row_key"] == redo.admin_row_key(campaign.db.iloc[1])
    assert result["filter_options"]["splits"] == ["dev", "test"]


def test_admin_backend_filter_matches_annotator_condition_by_real_id(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)
    campaign.db = pd.DataFrame(
        [
            {**queue_row(), "status": ExampleStatus.FINISHED, "start": 10, "end": 20},
            {
                **queue_row(),
                "annotator_id": "ann-b",
                "annotator_group": 1,
                "status": ExampleStatus.FINISHED,
                "start": 10,
                "end": 20,
            },
        ]
    )
    write_custom_active_record(
        "redo-test",
        "ann-a.jsonl",
        metadata={"annotator_id": "ann-a", "annotator_group": 0},
    )
    write_custom_active_record(
        "redo-test",
        "ann-b.jsonl",
        metadata={"annotator_id": "ann-b", "annotator_group": 1},
    )

    result = redo_filter(campaign, [condition("annotator", "eq", "ann-b")])

    assert result["visible_count"] == 1
    assert result["rows"][0]["row_key"] == redo.admin_row_key(campaign.db.iloc[1])


def test_admin_backend_filter_matches_annotator_condition_by_alias(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)
    write_custom_active_record(
        "redo-test",
        "ann-a.jsonl",
        metadata={"annotator_id": "ann-a", "annotator_group": 0},
    )

    result = redo_filter(campaign, [condition("annotator", "eq", "Prague")], alias_map={"ann-a": "Prague"})

    assert result["visible_count"] == 1
    assert "Prague" in result["filter_options"]["annotators"]


def test_admin_backend_filter_matches_done_and_skipped_annotation_states(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)
    campaign.db = pd.DataFrame(
        [
            {**queue_row(), "status": ExampleStatus.FINISHED, "start": 10, "end": 20},
            {
                **queue_row(),
                "setup_id": "setup-b",
                "annotator_id": "ann-b",
                "annotator_group": 1,
                "status": ExampleStatus.FINISHED,
                "start": 10,
                "end": 20,
            },
        ]
    )
    write_custom_active_record(
        "redo-test",
        "done.jsonl",
        metadata={"annotator_id": "ann-a", "annotator_group": 0},
    )
    write_custom_active_record(
        "redo-test",
        "skipped.jsonl",
        setup_id="setup-b",
        annotations=[],
        flags=[{"label": "Skip", "value": True}],
        metadata={"annotator_id": "ann-b", "annotator_group": 1},
    )

    done = redo_filter(campaign, [condition("annotation_state", "eq", "done")])
    skipped = redo_filter(campaign, [condition("annotation_state", "eq", "skipped")])

    assert done["visible_count"] == 1
    assert done["rows"][0]["row_key"] == redo.admin_row_key(campaign.db.iloc[0])
    assert skipped["visible_count"] == 1
    assert skipped["rows"][0]["row_key"] == redo.admin_row_key(campaign.db.iloc[1])
    assert skipped["filter_options"]["annotation_states"] == ["done", "skipped"]


def test_admin_backend_filter_span_groups_allow_different_spans(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)
    write_active_record_with_annotations(
        "redo-test",
        "0-0-ann-a-20.jsonl",
        [
            {"type": 6, "text": "missing city", "start": 0, "reason": "NotInTop10"},
            {"type": 0, "text": "other", "start": 5, "reason": "InSeafile"},
        ],
    )

    result = redo_filter(
        campaign,
        [
            condition("span_category", "eq", "Chybí", span_group="1"),
            condition("span_reason", "contains", "InSeafile", span_group="2"),
        ],
    )

    assert result["visible_count"] == 1
    assert {detail["start"] for detail in result["rows"][0]["match_details"] if detail["target"] == "span"} == {0, 5}


def test_admin_backend_filter_same_span_group_still_requires_one_matching_span(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)
    write_active_record_with_annotations(
        "redo-test",
        "0-0-ann-a-20.jsonl",
        [
            {"type": 6, "text": "missing city", "start": 0, "reason": "NotInTop10"},
            {"type": 0, "text": "other", "start": 5, "reason": "InSeafile"},
        ],
    )

    result = redo_filter(
        campaign,
        [
            condition("span_category", "eq", "Chybí", span_group="1"),
            condition("span_reason", "contains", "InSeafile", span_group="1"),
        ],
    )

    assert result["visible_count"] == 0


def test_admin_backend_filter_match_any_slider_and_invalid_regex(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)
    record = write_active_record_with_annotations(
        "redo-test",
        "0-0-ann-a-20.jsonl",
        [{"type": 0, "text": "span", "start": 0, "reason": "plain reason"}],
    )
    record["sliders"] = [{"label": "Tone", "value": "4"}]
    path = Path(redo.CAMPAIGN_DIR) / "redo-test" / "files" / "0-0-ann-a-20.jsonl"
    path.write_text(json.dumps(record, ensure_ascii=False) + "\n", encoding="utf-8")

    any_match = redo_filter(
        campaign,
        [
            condition("span_reason", "contains", "absent"),
            condition("slider", "lt", "5", slider_label="Tone"),
        ],
        mode="any",
    )

    with pytest.raises(querying.QueryFilterError):
        redo_filter(campaign, [condition("span_reason", "regex", "[")])

    assert any_match["visible_count"] == 1
    assert "Tone" in any_match["filter_options"]["sliders"]


def test_admin_backend_filter_keeps_skipped_and_completed_rows_visible(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)
    record = write_active_record_with_annotations(
        "redo-test",
        "0-0-ann-a-20.jsonl",
        [{"type": 6, "text": "skip me", "start": 0, "reason": "NotInTop10"}],
    )
    record["flags"] = [{"label": "Skip", "value": True}]
    path = Path(redo.CAMPAIGN_DIR) / "redo-test" / "files" / "0-0-ann-a-20.jsonl"
    path.write_text(json.dumps(record, ensure_ascii=False) + "\n", encoding="utf-8")
    skipped_visible = redo_filter(campaign, [condition("span_category", "eq", "Chybí")])
    item = redo.add_items("redo-test", [queue_row()])["added"][0]
    redo.mark_completed("redo-test", item["redo_id"], "ann-a")

    completed_visible = redo_filter(campaign, [condition("span_category", "eq", "Chybí")])

    assert skipped_visible["visible_count"] == 1
    assert skipped_visible["rows"][0]["skipped"] is True
    assert completed_visible["visible_count"] == 1
    assert completed_visible["rows"][0]["redo_status"] == redo.STATUS_COMPLETED


def test_admin_backend_filter_returns_redo_assignment_rows_not_question_rows(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)
    campaign.db = pd.concat(
        [
            campaign.db,
            pd.DataFrame(
                [
                    {
                        "dataset": "dataset-a",
                        "split": "test",
                        "setup_id": "setup-a",
                        "example_idx": 0,
                        "batch_idx": 1,
                        "annotator_group": 0,
                        "annotator_id": "ann-b",
                        "status": ExampleStatus.FINISHED,
                    }
                ]
            ),
        ],
        ignore_index=True,
    )
    write_active_record_with_annotations(
        "redo-test",
        "0-0-ann-a-20.jsonl",
        [{"type": 6, "text": "first", "start": 0, "reason": "NotInTop10"}],
    )
    record = write_active_record_with_annotations(
        "redo-test",
        "0-0-ann-b-20.jsonl",
        [{"type": 6, "text": "second", "start": 0, "reason": "NotInTop10"}],
    )
    record["metadata"]["annotator_id"] = "ann-b"
    path = Path(redo.CAMPAIGN_DIR) / "redo-test" / "files" / "0-0-ann-b-20.jsonl"
    path.write_text(json.dumps(record, ensure_ascii=False) + "\n", encoding="utf-8")

    result = redo_filter(campaign, [condition("span_category", "eq", "Chybí")])

    assert result["visible_count"] == 2
    assert len({row["row_key"] for row in result["rows"]}) == 2


def test_readding_completed_redo_item_reopens_it(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    make_campaign(tmp_path)

    first = redo.add_items("redo-test", [queue_row()])["added"][0]
    redo.mark_completed("redo-test", first["redo_id"], "ann-a")

    second = redo.add_items("redo-test", [queue_row()], created_by="admin-b", instruction="Redo again")
    item = redo.find_item(redo.load_queue("redo-test"), first["redo_id"])

    assert len(second["reused"]) == 1
    assert item["status"] == redo.STATUS_PENDING
    assert item["instruction"] == "Redo again"
    assert item["reopened_by"] == "admin-b"
    assert redo.is_redo_mode("redo-test", "ann-a")


def test_admin_add_items_puts_annotator_in_redo_by_pending_queue(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    make_campaign(tmp_path)
    app_mod.app.config.update(login={"active": False}, host_prefix="")

    response = app_mod.app.test_client().post(
        "/redo/redo-test/items",
        json={"items": [queue_row()], "selector": "example"},
    )

    assert response.status_code == 200
    assert response.get_json()["added"] == 1
    assert redo.is_redo_mode("redo-test", "ann-a")


def test_admin_add_items_does_not_reopen_completed_without_allow_completed(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    make_campaign(tmp_path)
    app_mod.app.config.update(login={"active": False}, host_prefix="")
    completed_item = redo.add_items("redo-test", [queue_row()])["added"][0]
    redo.mark_completed("redo-test", completed_item["redo_id"], "ann-a")

    response = app_mod.app.test_client().post(
        "/redo/redo-test/items",
        json={"items": [queue_row()], "selector": "example"},
    )
    item = redo.find_item(redo.load_queue("redo-test"), completed_item["redo_id"])

    assert response.status_code == 200
    assert response.get_json()["added"] == 0
    assert response.get_json()["reused"] == 0
    assert item["status"] == redo.STATUS_COMPLETED


def test_admin_add_items_reopens_completed_when_allowed(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    make_campaign(tmp_path)
    app_mod.app.config.update(login={"active": False}, host_prefix="")
    completed_item = redo.add_items("redo-test", [queue_row()])["added"][0]
    redo.mark_completed("redo-test", completed_item["redo_id"], "ann-a")

    response = app_mod.app.test_client().post(
        "/redo/redo-test/items",
        json={"items": [queue_row()], "selector": "example", "includeCompleted": True},
    )
    item = redo.find_item(redo.load_queue("redo-test"), completed_item["redo_id"])

    assert response.status_code == 200
    assert response.get_json()["added"] == 0
    assert response.get_json()["reused"] == 1
    assert item["status"] == redo.STATUS_PENDING


def test_blank_or_placeholder_annotator_id_keeps_auth_page_before_batch_load(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)
    campaign.metadata["config"]["service"] = "local"
    app_mod.app.config.update(login={"active": False}, host_prefix="")

    def fail_get_batch(*args, **kwargs):
        raise AssertionError("batch should not be loaded before annotator auth")

    monkeypatch.setattr(workflows, "load_campaign", lambda app, campaign_id: campaign)
    monkeypatch.setattr(crowdsourcing, "get_annotator_batch", fail_get_batch)
    captured = {}

    def fake_render_template(template_name, **kwargs):
        captured["template_name"] = template_name
        captured["kwargs"] = kwargs
        return "auth-shell"

    monkeypatch.setattr(app_mod, "render_template", fake_render_template)

    client = app_mod.app.test_client()
    for query in ["?annotatorId", "?annotatorId=FILL_YOUR_NAME_HERE"]:
        response = client.get(f"/annotate/redo-test{query}")
        assert response.status_code == 200
        assert response.get_data(as_text=True) == "auth-shell"

    assert captured["template_name"] == "crowdsourcing/annotate_auth.html"
    assert captured["kwargs"]["auth_redirect_template"] == "/annotate/redo-test?annotatorId=__ANNOTATOR__"
    assert captured["kwargs"]["campaign_id"] == "redo-test"
    assert "instructions" not in captured["kwargs"]


def test_preview_batch_link_bypasses_local_auth_page(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)
    campaign.metadata["config"]["service"] = "local"
    app_mod.app.config.update(login={"active": False}, host_prefix="")

    monkeypatch.setattr(workflows, "load_campaign", lambda app, campaign_id: campaign)
    monkeypatch.setattr(workflows, "refresh_indexes", lambda app: None)
    monkeypatch.setattr(crowdsourcing, "ensure_crowdsourcing_page_current", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        crowdsourcing,
        "get_annotator_batch",
        lambda *args, **kwargs: (
            [{"dataset": "dataset-a", "split": "test", "setup_id": "setup-a", "example_idx": 0, "batch_idx": 0}],
            {"mode": "normal", "is_redo": False, "empty_redo_fallback": False, "show_completed": False},
        ),
    )
    monkeypatch.setattr(app_mod.utils, "render_from_folder", lambda *args, **kwargs: "preview-shell")

    client = app_mod.app.test_client()
    response = client.get("/annotate/redo-test?batch_idx=0")

    assert response.status_code == 200
    assert response.get_data(as_text=True) == "preview-shell"


def test_campaign_preview_link_uses_preview_annotator_without_forcing_batch(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)
    campaign.metadata["config"]["service"] = "local"
    app_mod.app.config.update(login={"active": False}, host_prefix="")

    monkeypatch.setattr(workflows, "load_campaign", lambda app, campaign_id: campaign)
    monkeypatch.setattr(workflows, "refresh_indexes", lambda app: None)
    monkeypatch.setattr(crowdsourcing, "ensure_crowdsourcing_page_current", lambda *args, **kwargs: None)
    captured = {}

    def fake_get_annotator_batch(app, campaign, service_ids, batch_idx=None, **kwargs):
        captured["service_ids"] = service_ids
        captured["batch_idx"] = batch_idx
        return (
            [{"dataset": "dataset-a", "split": "test", "setup_id": "setup-a", "example_idx": 0, "batch_idx": 0}],
            {"mode": "normal", "is_redo": False, "empty_redo_fallback": False, "show_completed": False},
        )

    monkeypatch.setattr(crowdsourcing, "get_annotator_batch", fake_get_annotator_batch)
    monkeypatch.setattr(app_mod.utils, "render_from_folder", lambda *args, **kwargs: "preview-shell")

    client = app_mod.app.test_client()
    response = client.get("/annotate/redo-test?annotatorId=factgenie_preview")

    assert response.status_code == 200
    assert response.get_data(as_text=True) == "preview-shell"
    assert captured["service_ids"]["annotator_id"] == "factgenie_preview"
    assert captured["batch_idx"] is None


def test_campaign_preview_templates_link_to_preview_annotator():
    list_template = Path("factgenie/templates/pages/crowdsourcing.html").read_text(encoding="utf-8")
    detail_template = Path("factgenie/templates/pages/crowdsourcing_detail.html").read_text(encoding="utf-8")

    assert "/annotate/{{ campaign.metadata.id }}?annotatorId=factgenie_preview" in list_template
    assert "/annotate/{{ metadata.id }}?annotatorId=factgenie_preview" in detail_template
    assert "/annotate/{{ metadata.id }}?annotatorId=factgenie_preview&batch_idx={{ batch.batch_idx }}" in detail_template


def test_preview_annotator_without_batch_gets_first_batch_regardless_of_status(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)
    db_path = tmp_path / "redo-test" / "db.csv"
    db = pd.read_csv(db_path)
    db = pd.concat(
        [
            db,
            pd.DataFrame(
                [
                    {
                        "dataset": "dataset-a",
                        "split": "test",
                        "setup_id": "setup-a",
                        "example_idx": 1,
                        "batch_idx": 1,
                        "annotator_group": 0,
                        "annotator_id": "ann-b",
                        "status": ExampleStatus.ASSIGNED,
                        "start": 30,
                        "end": "",
                    }
                ]
            ),
        ],
        ignore_index=True,
    )
    db.to_csv(db_path, index=False)

    annotation_set, redo_context = crowdsourcing.get_annotator_batch(
        SimpleNamespace(db={"lock": threading.Lock()}),
        campaign,
        {"annotator_id": "factgenie_preview"},
        return_context=True,
    )

    assert redo_context["is_redo"] is False
    assert annotation_set
    assert {item["batch_idx"] for item in annotation_set} == {0}
    campaign.load_db()
    assert list(campaign.db["status"]) == [ExampleStatus.FINISHED, ExampleStatus.ASSIGNED]
    assert list(campaign.db["annotator_id"]) == ["ann-a", "ann-b"]


def test_build_auth_redirect_template_points_to_annotation_route():
    assert app_mod._build_auth_redirect_template("", "redo-test") == "/annotate/redo-test?annotatorId=__ANNOTATOR__"


def test_nan_annotator_ids_are_normalized_to_empty(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)

    assert redo.normalize_annotator_id(float("nan")) == ""
    assert redo.normalize_annotator_id(pd.NA) == ""
    assert app_mod._normalize_annotator_id(float("nan")) == ""
    assert app_mod._normalize_annotator_id(pd.NA) == ""
    assert analysis._normalize_annotator_id(float("nan")) == ""
    assert analysis._normalize_annotator_id(pd.NA) == ""

    row = pd.Series(
        {
            "dataset": "dataset-a",
            "split": "test",
            "setup_id": "setup-a",
            "example_idx": 0,
            "batch_idx": 0,
            "annotator_group": 0,
            "annotator_id": pd.NA,
            "start": 10,
            "end": 20,
        }
    )
    result = {
        "output": "out",
        "annotations": [],
        "flags": [],
        "options": [],
        "sliders": [],
        "text_fields": [],
    }

    workflows.save_record(CampaignMode.CROWDSOURCING, campaign, row, result)

    saved_files = sorted((Path(tmp_path) / "redo-test" / "files").glob("*.jsonl"))
    assert len(saved_files) == 1
    assert "nan" not in saved_files[0].name.lower()
    saved_record = json.loads(saved_files[0].read_text(encoding="utf-8").strip())
    assert saved_record["metadata"]["annotator_id"] == ""


def test_normal_submit_rejects_redo_payload(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    make_campaign(tmp_path)
    app_mod.app.config.update(login={"active": False}, host_prefix="")

    response = app_mod.app.test_client().post(
        "/submit_annotations",
        json={
            "campaign_id": "redo-test",
            "annotator_id": "ann-a",
            "annotation_set": [{"redo_id": "redo-1"}],
        },
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["success"] is False
    assert "Save current item" in payload["error"]


def test_normal_submit_returns_preview_completion_before_save(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)
    app_mod.app.config.update(login={"active": False}, host_prefix="")

    def fail_if_save_called(*args, **kwargs):
        raise AssertionError("preview submit should complete before save_annotations is called")

    monkeypatch.setattr(crowdsourcing, "save_annotations", fail_if_save_called)
    monkeypatch.setattr(workflows, "load_campaign", lambda app, campaign_id: campaign)

    response = app_mod.app.test_client().post(
        "/submit_annotations",
        json={
            "campaign_id": "redo-test",
            "annotator_id": app_mod.PREVIEW_STUDY_ID,
            "annotation_set": [{"batch_idx": 0, "annotations": [], "flags": [], "options": [], "sliders": []}],
        },
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["success"] is True
    assert "Thanks." in payload["message"]
    assert "No annotations were saved" in payload["message"]
    assert "read-only" in payload["message"]


def test_save_annotations_rejects_preview_annotator(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)
    monkeypatch.setattr(workflows, "load_campaign", lambda app, campaign_id: campaign)
    app = SimpleNamespace(db={"lock": threading.Lock()})

    flask_app = Flask(__name__)
    with flask_app.app_context():
        response = crowdsourcing.save_annotations(
            app,
            "redo-test",
            [{"batch_idx": 0, "annotations": [], "flags": [], "options": [], "sliders": [], "textFields": []}],
            app_mod.PREVIEW_STUDY_ID,
        )

    payload = response.get_json()
    assert payload["success"] is False
    assert "read-only" in payload["error"]

    campaign.load_db()
    assert campaign.db.loc[0, "status"] == ExampleStatus.FINISHED
    assert campaign.db.loc[0, "annotator_id"] == "ann-a"


def test_per_example_save_replaces_active_record_and_marks_one_row(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_per_example_campaign(tmp_path)
    write_active_record("per-example-test", "0-0-ann-a-20.jsonl", "old", 20)
    monkeypatch.setattr(workflows, "load_campaign", lambda app, campaign_id: campaign)
    monkeypatch.setattr(workflows, "get_output_for_setup", lambda **kwargs: {"output": "new output"})
    monkeypatch.setattr(workflows, "refresh_indexes", lambda app: None)
    app = SimpleNamespace(db={"lock": threading.Lock()})

    flask_app = Flask(__name__)
    with flask_app.app_context():
        response = crowdsourcing.save_annotation_item(
            app,
            "per-example-test",
            {
                "dataset": "dataset-a",
                "split": "test",
                "setup_id": "setup-a",
                "example_idx": 0,
                "batch_idx": 0,
                "annotator_group": 0,
                "annotations": [{"type": 0, "start": 1, "text": "new"}],
                "flags": [],
                "options": [],
                "sliders": [],
                "textFields": [],
            },
            "ann-a",
        )

    payload = response.get_json()
    assert payload["success"] is True
    item = {
        "dataset": "dataset-a",
        "split": "test",
        "setup_id": "setup-a",
        "example_idx": 0,
        "batch_idx": 0,
        "annotator_group": 0,
        "annotator_id": "ann-a",
    }
    matches = redo.find_active_records("per-example-test", item)
    assert len(matches) == 1
    assert matches[0]["record"]["annotations"][0]["text"] == "new"
    assert redo.load_revision_log("per-example-test") == []
    campaign.load_db()
    assert campaign.db.loc[0, "status"] == ExampleStatus.FINISHED
    assert campaign.db.loc[1, "status"] == ExampleStatus.ASSIGNED


def test_per_example_submit_saves_all_and_replaces_saved_items(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_per_example_campaign(tmp_path)
    write_active_record("per-example-test", "0-0-ann-a-20.jsonl", "old", 20)
    monkeypatch.setattr(workflows, "load_campaign", lambda app, campaign_id: campaign)
    monkeypatch.setattr(workflows, "get_output_for_setup", lambda **kwargs: {"output": f"output {kwargs['example_idx']}"})
    monkeypatch.setattr(workflows, "refresh_indexes", lambda app: None)
    app = SimpleNamespace(db={"lock": threading.Lock()})

    annotation_set = [
        {
            "dataset": "dataset-a",
            "split": "test",
            "setup_id": "setup-a",
            "example_idx": 0,
            "batch_idx": 0,
            "annotator_group": 0,
            "annotations": [{"type": 0, "start": 1, "text": "replacement"}],
            "flags": [],
            "options": [],
            "sliders": [],
            "textFields": [],
        },
        {
            "dataset": "dataset-a",
            "split": "test",
            "setup_id": "setup-a",
            "example_idx": 1,
            "batch_idx": 0,
            "annotator_group": 0,
            "annotations": [{"type": 0, "start": 2, "text": "second"}],
            "flags": [],
            "options": [],
            "sliders": [],
            "textFields": [],
        },
    ]

    flask_app = Flask(__name__)
    with flask_app.app_context():
        response = crowdsourcing.save_per_example_annotations(app, "per-example-test", annotation_set, "ann-a")

    payload = response.get_json()
    assert payload["success"] is True
    assert payload["saved_count"] == 2
    for example_idx, text in [(0, "replacement"), (1, "second")]:
        item = {
            "dataset": "dataset-a",
            "split": "test",
            "setup_id": "setup-a",
            "example_idx": example_idx,
            "batch_idx": 0,
            "annotator_group": 0,
            "annotator_id": "ann-a",
        }
        matches = redo.find_active_records("per-example-test", item)
        assert len(matches) == 1
        assert matches[0]["record"]["annotations"][0]["text"] == text
    campaign.load_db()
    assert set(campaign.db["status"]) == {ExampleStatus.FINISHED}


def test_parse_crowdsourcing_config_defaults_to_batch_save_mode():
    parsed = crowdsourcing.parse_crowdsourcing_config({})
    assert parsed["save_mode"] == "batch"
    parsed = crowdsourcing.parse_crowdsourcing_config({"saveMode": "per_example"})
    assert parsed["save_mode"] == "per_example"


def test_archive_replace_archives_duplicates_and_active_index_skips_revisions(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    make_campaign(tmp_path)
    write_active_record("redo-test", "0-0-ann-a-20.jsonl", "older", 20)
    write_active_record("redo-test", "0-0-ann-a-30.jsonl", "newer", 30)
    files_dir = tmp_path / "redo-test" / "files"
    item = redo.row_to_item("redo-test", queue_row())

    archived = redo.archive_and_remove_active_records("redo-test", item, "ann-a", redo.utc_now())

    assert len(archived) == 2
    assert redo.load_revision_log("redo-test")[0]["record"]["annotations"][0]["text"] in {"older", "newer"}
    assert redo.find_active_records("redo-test", item) == []
    assert str(redo.revision_log_path("redo-test")) not in workflows.get_annotation_files()
    assert not (files_dir / "0-0-ann-a-20.jsonl").exists()
    assert not (files_dir / "0-0-ann-a-30.jsonl").exists()


def test_archive_replace_keeps_file_when_other_records_remain(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    make_campaign(tmp_path)
    files_dir = tmp_path / "redo-test" / "files"
    matching = active_record_with_overrides("redo-test", "matching", 20)
    other = active_record_with_overrides(
        "redo-test",
        "other",
        21,
        example_idx=1,
        output="other output",
    )
    mixed_file = files_dir / "0-0-ann-a-20.jsonl"
    mixed_file.write_text(
        json.dumps(matching, ensure_ascii=False) + "\n" + json.dumps(other, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    item = redo.row_to_item("redo-test", queue_row())

    archived = redo.archive_and_remove_active_records("redo-test", item, "ann-a", redo.utc_now())

    assert len(archived) == 1
    assert mixed_file.exists()
    remaining_records = [json.loads(line) for line in mixed_file.read_text(encoding="utf-8").splitlines()]
    assert [record["annotations"][0]["text"] for record in remaining_records] == ["other"]


def test_redo_save_item_replaces_active_record_and_marks_completed(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)
    write_active_record("redo-test", "0-0-ann-a-20.jsonl", "old", 20)
    add_result = redo.add_items("redo-test", [queue_row()])
    redo_id = add_result["added"][0]["redo_id"]
    monkeypatch.setattr(workflows, "load_campaign", lambda app, campaign_id: campaign)
    monkeypatch.setattr(workflows, "get_output_for_setup", lambda **kwargs: {"output": "new output"})
    monkeypatch.setattr(workflows, "refresh_indexes", lambda app: None)
    app = SimpleNamespace(db={"lock": threading.Lock()})

    flask_app = Flask(__name__)
    with flask_app.app_context():
        response = crowdsourcing.save_redo_annotation(
            app,
            "redo-test",
            redo_id,
            {
                "annotations": [{"type": 0, "start": 1, "text": "new"}],
                "flags": [],
                "options": [],
                "sliders": [],
                "textFields": [],
            },
            "ann-a",
        )

    payload = response.get_json()
    assert payload["success"] is True
    assert payload["remaining_pending"] == 0
    assert "final_message" in payload
    item = redo.find_item(redo.load_queue("redo-test"), redo_id)
    assert item["status"] == redo.STATUS_COMPLETED
    assert item["completed_count"] == 1
    matches = redo.find_active_records("redo-test", item)
    assert len(matches) == 1
    assert matches[0]["record"]["annotations"][0]["text"] == "new"
    assert len(redo.load_revision_log("redo-test")) == 1


def test_redo_save_item_rolls_back_on_failure(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)
    write_active_record("redo-test", "0-0-ann-a-20.jsonl", "old", 20)
    add_result = redo.add_items("redo-test", [queue_row()])
    redo_id = add_result["added"][0]["redo_id"]
    monkeypatch.setattr(workflows, "load_campaign", lambda app, campaign_id: campaign)
    monkeypatch.setattr(workflows, "get_output_for_setup", lambda **kwargs: {"output": "new output"})
    monkeypatch.setattr(workflows, "refresh_indexes", lambda app: None)

    def failing_update_db(db):
        db.to_csv(campaign.db_path, index=False)
        raise RuntimeError("boom")

    monkeypatch.setattr(campaign, "update_db", failing_update_db)

    def failing_save_record(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(workflows, "save_record", failing_save_record)
    app = SimpleNamespace(db={"lock": threading.Lock()})

    flask_app = Flask(__name__)
    with flask_app.app_context():
        response = crowdsourcing.save_redo_annotation(
            app,
            "redo-test",
            redo_id,
            {
                "annotations": [{"type": 0, "start": 1, "text": "new"}],
                "flags": [],
                "options": [],
                "sliders": [],
                "textFields": [],
            },
            "ann-a",
        )

    payload = response.get_json()
    assert payload["success"] is False
    assert "boom" in payload["error"]

    item = redo.find_item(redo.load_queue("redo-test"), redo_id)
    assert item["status"] == redo.STATUS_PENDING
    assert redo.load_revision_log("redo-test") == []
    assert redo.find_active_records("redo-test", item)[0]["record"]["annotations"][0]["text"] == "old"
    campaign.load_db()
    assert int(campaign.db.loc[0, "end"]) == 20
    saved_db = pd.read_csv(Path(tmp_path) / "redo-test" / "db.csv")
    assert int(saved_db.loc[0, "end"]) == 20


def test_restore_original_annotations_rolls_back_on_failure(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)
    write_active_record("redo-test", "0-0-ann-a-20.jsonl", "old", 20)
    add_result = redo.add_items("redo-test", [queue_row()])
    redo_id = add_result["added"][0]["redo_id"]
    monkeypatch.setattr(workflows, "load_campaign", lambda app, campaign_id: campaign)
    monkeypatch.setattr(workflows, "get_output_for_setup", lambda **kwargs: {"output": "new output"})
    monkeypatch.setattr(workflows, "refresh_indexes", lambda app: None)
    app = SimpleNamespace(db={"lock": threading.Lock()})

    flask_app = Flask(__name__)
    with flask_app.app_context():
        response = crowdsourcing.save_redo_annotation(
            app,
            "redo-test",
            redo_id,
            {
                "annotations": [{"type": 0, "start": 1, "text": "new"}],
                "flags": [],
                "options": [],
                "sliders": [],
                "textFields": [],
            },
            "ann-a",
        )
    assert response.get_json()["success"] is True

    item = redo.find_item(redo.load_queue("redo-test"), redo_id)
    original_active = redo.find_active_records("redo-test", item)
    original_revision_log = redo.load_revision_log("redo-test")

    def failing_save_queue(*args, **kwargs):
        raise RuntimeError("restore boom")

    monkeypatch.setattr(redo, "save_queue", failing_save_queue)

    with pytest.raises(RuntimeError, match="restore boom"):
        redo.restore_original_annotations("redo-test", [redo_id])

    assert redo.find_item(redo.load_queue("redo-test"), redo_id)["status"] == redo.STATUS_COMPLETED
    assert redo.load_revision_log("redo-test") == original_revision_log
    assert redo.find_active_records("redo-test", item)[0]["record"]["annotations"][0]["text"] == "new"
    assert original_active[0]["record"]["annotations"][0]["text"] == "new"


def test_redo_keep_item_marks_completed_without_archiving(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)
    add_result = redo.add_items("redo-test", [queue_row()])
    redo_id = add_result["added"][0]["redo_id"]
    monkeypatch.setattr(workflows, "load_campaign", lambda app, campaign_id: campaign)
    app = SimpleNamespace(db={"lock": threading.Lock()})

    flask_app = Flask(__name__)
    with flask_app.app_context():
        response = crowdsourcing.keep_redo_annotation(
            app,
            "redo-test",
            redo_id,
            "ann-a",
        )

    payload = response.get_json()
    assert payload["success"] is True
    assert payload["remaining_pending"] == 0
    assert "final_message" in payload
    item = redo.find_item(redo.load_queue("redo-test"), redo_id)
    assert item["status"] == redo.STATUS_COMPLETED
    assert item["completed_count"] == 1
    assert redo.load_revision_log("redo-test") == []
    assert redo.find_active_records("redo-test", item) == []


def test_cancel_only_affects_pending_redo_items(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    make_campaign(tmp_path)
    first = redo.add_items("redo-test", [queue_row()])["added"][0]
    second_row = queue_row() | {"setup_id": "setup-b"}
    second = redo.add_items("redo-test", [second_row])["added"][0]
    redo.mark_completed("redo-test", second["redo_id"], "ann-a")

    cancelled = redo.cancel_items("redo-test", [first["redo_id"], second["redo_id"]])
    queue = redo.load_queue("redo-test")

    assert [item["redo_id"] for item in cancelled] == [first["redo_id"]]
    assert redo.find_item(queue, first["redo_id"])["status"] == redo.STATUS_CANCELLED
    assert redo.find_item(queue, second["redo_id"])["status"] == redo.STATUS_COMPLETED


def test_restore_original_annotation_archives_current_and_restores_first_revision(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)
    write_active_record("redo-test", "0-0-ann-a-20.jsonl", "old", 20)
    add_result = redo.add_items("redo-test", [queue_row()])
    redo_id = add_result["added"][0]["redo_id"]
    monkeypatch.setattr(workflows, "load_campaign", lambda app, campaign_id: campaign)
    monkeypatch.setattr(workflows, "get_output_for_setup", lambda **kwargs: {"output": "new output"})
    monkeypatch.setattr(workflows, "refresh_indexes", lambda app: None)
    app = SimpleNamespace(db={"lock": threading.Lock()})

    flask_app = Flask(__name__)
    with flask_app.app_context():
        response = crowdsourcing.save_redo_annotation(
            app,
            "redo-test",
            redo_id,
            {
                "annotations": [{"type": 0, "start": 1, "text": "new"}],
                "flags": [],
                "options": [],
                "sliders": [],
                "textFields": [],
            },
            "ann-a",
        )
    assert response.get_json()["success"] is True

    item = redo.find_item(redo.load_queue("redo-test"), redo_id)
    assert redo.find_active_records("redo-test", item)[0]["record"]["annotations"][0]["text"] == "new"

    result = redo.restore_original_annotations("redo-test", [redo_id])
    matches = redo.find_active_records("redo-test", item)

    assert len(result["restored"]) == 1
    assert len(matches) == 1
    assert matches[0]["record"]["annotations"][0]["text"] == "old"
    assert len(redo.load_revision_log("redo-test")) == 2


def test_campaign_overview_handles_mixed_finished_and_unfinished_setup_rows(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    make_campaign(tmp_path)
    scheduler = SimpleNamespace(add_job=lambda *args, **kwargs: None)
    campaign = HumanCampaign("redo-test", scheduler)
    campaign.db = pd.DataFrame(
        [
            {
                "dataset": "dataset-a",
                "split": "test",
                "setup_id": "setup-a",
                "example_idx": 0,
                "batch_idx": 0,
                "annotator_group": 0,
                "annotator_id": "ann-a",
                "status": ExampleStatus.ASSIGNED,
                "start": 10.0,
                "end": None,
            },
            {
                "dataset": "dataset-a",
                "split": "test",
                "setup_id": "setup-b",
                "example_idx": 0,
                "batch_idx": 0,
                "annotator_group": 0,
                "annotator_id": "ann-a",
                "status": ExampleStatus.FINISHED,
                "start": 10.0,
                "end": 30.0,
            },
        ]
    )
    campaign.update_db(campaign.db)

    overview = campaign.get_overview()
    stats = campaign.get_stats()

    assert overview[0]["end"] == 30.0
    assert overview[0]["status"] == ExampleStatus.ASSIGNED
    assert overview[0]["finished_cnt"] == 1
    assert overview[0]["example_cnt"] == 2
    assert overview[0]["example_list"][1]["status"] == ExampleStatus.FINISHED
    assert stats["assigned"] == 1
    assert stats["finished"] == 0


def test_get_annotator_batch_serves_redo_prefill_then_falls_back(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)
    write_active_record("redo-test", "0-0-ann-a-20.jsonl", "old", 20)
    add_result = redo.add_items("redo-test", [queue_row()])
    app = SimpleNamespace(db={"lock": threading.Lock()})

    annotation_set, context = crowdsourcing.get_annotator_batch(
        app,
        campaign,
        {"annotator_id": "ann-a"},
        return_context=True,
    )

    assert context["is_redo"] is True
    assert annotation_set[0]["redo_id"] == add_result["added"][0]["redo_id"]
    assert annotation_set[0]["output"] == "old output"
    assert annotation_set[0]["annotations"][0]["text"] == "old"
    assert annotation_set[0]["textFields"][0]["value"] == "old note"

    redo.mark_completed("redo-test", add_result["added"][0]["redo_id"], "ann-a")
    annotation_set, context = crowdsourcing.get_annotator_batch(
        app,
        campaign,
        {"annotator_id": "ann-a"},
        return_context=True,
    )
    assert annotation_set == []
    assert context["is_redo"] is False


def test_get_annotator_batch_can_review_completed_redo_items(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)
    write_active_record("redo-test", "0-0-ann-a-20.jsonl", "saved", 20)
    add_result = redo.add_items("redo-test", [queue_row()])
    redo.mark_completed("redo-test", add_result["added"][0]["redo_id"], "ann-a")
    app = SimpleNamespace(db={"lock": threading.Lock()})

    annotation_set, context = crowdsourcing.get_annotator_batch(
        app,
        campaign,
        {"annotator_id": "ann-a"},
        include_completed_redo=True,
        return_context=True,
    )

    assert context["is_redo"] is True
    assert context["show_completed"] is True
    assert annotation_set[0]["redo_id"] == add_result["added"][0]["redo_id"]
    assert annotation_set[0]["output"] == "old output"
    assert annotation_set[0]["redo_status"] == redo.STATUS_COMPLETED
    assert annotation_set[0]["annotations"][0]["text"] == "saved"


def test_get_annotator_batch_logs_and_filters_invalid_redo_annotation_types(monkeypatch, tmp_path, caplog):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)
    write_active_record_with_annotations(
        "redo-test",
        "0-0-ann-a-20.jsonl",
        [
            {"type": 0, "text": "valid", "start": 0},
            {"type": 99, "text": "invalid", "start": 6},
        ],
    )
    redo.add_items("redo-test", [queue_row()])
    app = SimpleNamespace(db={"lock": threading.Lock()})

    with caplog.at_level(logging.WARNING, logger="factgenie"):
        annotation_set, context = crowdsourcing.get_annotator_batch(
            app,
            campaign,
            {"annotator_id": "ann-a"},
            return_context=True,
        )

    assert context["is_redo"] is True
    assert annotation_set[0]["annotations"] == [{"type": 0, "text": "valid", "start": 0}]
    assert "Skipping redo annotation with unknown type" in caplog.text
    assert "redo_id" in caplog.text


def test_get_example_data_with_missing_setup_output_returns_placeholder(monkeypatch):
    class DummyDataset:
        splits = ["test"]

        def get_example(self, split, example_idx):
            assert split == "test"
            assert example_idx == 0
            return {"question": "Q"}

        def render(self, example):
            return "<div>Example</div>"

    app = SimpleNamespace(
        db={"datasets_obj": {"dataset-a": DummyDataset()}},
        config={"host_prefix": ""},
    )

    monkeypatch.setattr(workflows, "get_output_for_setup", lambda *args, **kwargs: None)
    monkeypatch.setattr(workflows, "get_annotations", lambda *args, **kwargs: [])

    example_data = workflows.get_example_data(app, "dataset-a", "test", 0, "missing-setup")

    assert example_data["html"] == "<div>Example</div>"
    assert example_data["generated_outputs"] == [
        {
            "setup_id": "missing-setup",
            "output": "",
            "annotations": [],
        }
    ]


def test_full_campaign_export_excludes_redo_artifacts(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    make_campaign(tmp_path)
    write_active_record("redo-test", "0-0-ann-a-20.jsonl", "old", 20)
    redo.add_items("redo-test", [queue_row()])
    log_path = redo.revision_log_path("redo-test")
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text(json.dumps({"revision_id": "rev_1"}) + "\n", encoding="utf-8")

    flask_app = Flask(__name__)
    with flask_app.app_context():
        response = workflows.export_campaign_outputs("redo-test")

    with zipfile.ZipFile(BytesIO(response.get_data())) as zip_file:
        names = set(zip_file.namelist())

    assert "files/0-0-ann-a-20.jsonl" in names
    assert "redo_queue.json" not in names
    assert "files/revisions/revision_log.jsonl" not in names


def test_question_coverage_admin_displays_redo_revision_status_and_public_hides_it(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)
    setup_b_row = campaign.db.iloc[0].copy()
    setup_b_row["setup_id"] = "setup-b"
    setup_b_row["status"] = ExampleStatus.ASSIGNED
    campaign.db = pd.concat([campaign.db, pd.DataFrame([setup_b_row])], ignore_index=True)
    completed_item = redo.add_items("redo-test", [queue_row()])["added"][0]
    pending_row = queue_row() | {"setup_id": "setup-b"}
    redo.add_items("redo-test", [pending_row])
    example_index = pd.DataFrame(
        [
            {
                "campaign_id": "redo-test",
                "dataset": "dataset-a",
                "split": "test",
                "setup_id": "setup-a",
                "example_idx": 0,
                "annotator_group": 0,
                "annotator_id": "ann-a",
                "annotations": [{"type": 0, "start": 0, "text": "new"}],
                "flags": [],
            }
        ]
    )
    redo.mark_completed("redo-test", completed_item["redo_id"], "ann-a")
    log_path = redo.revision_log_path("redo-test")
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text(
        json.dumps(
            {
                "revision_id": "rev_1",
                "campaign_id": "redo-test",
                "annotator_id": "ann-a",
                "annotator_group": 0,
                "batch_idx": 0,
                "dataset": "dataset-a",
                "split": "test",
                "setup_id": "setup-a",
                "example_idx": 0,
                "archived_at": "2026-05-07T10:00:00Z",
                "archived_by": "ann-a",
            }
        )
        + "\n",
        encoding="utf-8",
    )
    app = SimpleNamespace(db={"datasets_obj": {}})

    admin_stats = analysis.compute_question_coverage_stats(
        app,
        campaign,
        example_index,
        show_real_annotator_names=True,
    )
    admin_rows = {row["setup_id"]: row for row in admin_stats["matrix"]["rows"]}
    completed_cell = admin_rows["setup-a"]["cell_details"]["ann-a"]
    pending_cell = admin_rows["setup-b"]["cell_details"]["ann-a"]

    assert admin_stats["matrix"]["annotators"][0]["annotator_name"] == "ann-a"
    assert completed_cell["redo_status"] == redo.STATUS_COMPLETED
    assert admin_rows["setup-a"]["redo_statuses"]["ann-a"] == redo.STATUS_COMPLETED
    assert completed_cell["revision_count"] == 1
    assert completed_cell["latest_revision_at"] == "2026-05-07T10:00:00Z"
    assert pending_cell["redo_status"] == redo.STATUS_PENDING
    assert admin_rows["setup-b"]["redo_statuses"]["ann-a"] == redo.STATUS_PENDING

    public_stats = analysis.compute_question_coverage_stats(
        app,
        campaign,
        example_index,
        show_real_annotator_names=False,
    )
    public_cell = next(iter(public_stats["matrix"]["rows"][0]["cell_details"].values()))

    assert public_stats["matrix"]["annotators"][0]["annotator_name"] != "ann-a"
    assert "redo_status" not in public_cell
    assert "revision_count" not in public_cell


def test_login_disabled_counts_as_authenticated_view_for_analyze(monkeypatch):
    monkeypatch.setitem(app_mod.app.config["login"], "active", False)

    with app_mod.app.test_request_context("/analyze/detail/redo-test"):
        assert app_mod._is_authenticated_viewer() is True
