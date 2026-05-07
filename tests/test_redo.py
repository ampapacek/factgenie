import json
import threading
import zipfile
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
    filter_data = overview["examples"][0]["filter_data"]

    assert "Chybí" in overview["filter_options"]["categories"]
    assert "Chybí" in filter_data["span_categories"]
    assert filter_data["has_chybi"] is True
    assert filter_data["has_missing_reason"] is True
    assert filter_data["has_chybi_without_top10"] is True
    assert {"category": "Chybí", "text": "①", "reason": "", "reason_missing": True} in filter_data["spans"]


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
    filter_data = overview["examples"][0]["filter_data"]

    assert "Tone" in overview["filter_options"]["sliders"]
    assert "Which claim is supported?" in filter_data["question_texts"]
    assert "Nested dataset question" in filter_data["question_texts"]
    assert "Generated answer" in filter_data["output_texts"]
    assert "free text note" in filter_data["any_texts"]
    assert {"label": "Tone", "value": "4", "numeric_value": 4.0, "missing": False} in filter_data["sliders"]


def test_admin_overview_treats_top10_reasons_as_present_for_chybi_filter(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)

    write_active_record_with_annotations(
        "redo-test",
        "0-0-ann-a-20.jsonl",
        [{"type": 6, "text": "①", "start": 0, "reason": "InTop10 InSeafile"}],
        end_timestamp=20,
    )
    assert redo.build_admin_overview(campaign)["examples"][0]["filter_data"]["has_chybi_without_top10"] is False

    write_active_record_with_annotations(
        "redo-test",
        "0-0-ann-a-30.jsonl",
        [{"type": 6, "text": "①", "start": 0, "reason": "NotInTop10 InSeafile"}],
        end_timestamp=30,
    )
    assert redo.build_admin_overview(campaign)["examples"][0]["filter_data"]["has_chybi_without_top10"] is False


def test_admin_overview_marks_chybi_without_top10_when_reason_lacks_token(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)
    write_active_record_with_annotations(
        "redo-test",
        "0-0-ann-a-20.jsonl",
        [{"type": 6, "text": "①", "start": 0, "reason": "InSeafile missing example"}],
    )

    filter_data = redo.build_admin_overview(campaign)["examples"][0]["filter_data"]

    assert filter_data["has_chybi"] is True
    assert filter_data["has_missing_reason"] is False
    assert filter_data["has_chybi_without_top10"] is True


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


def test_archive_replace_archives_duplicates_and_active_index_skips_revisions(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    make_campaign(tmp_path)
    write_active_record("redo-test", "0-0-ann-a-20.jsonl", "older", 20)
    write_active_record("redo-test", "0-0-ann-a-30.jsonl", "newer", 30)
    item = redo.row_to_item("redo-test", queue_row())

    archived = redo.archive_and_remove_active_records("redo-test", item, "ann-a", redo.utc_now())

    assert len(archived) == 2
    assert redo.load_revision_log("redo-test")[0]["record"]["annotations"][0]["text"] in {"older", "newer"}
    assert redo.find_active_records("redo-test", item) == []
    assert str(redo.revision_log_path("redo-test")) not in workflows.get_annotation_files()


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

    assert overview[0]["end"] == 30.0


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
    assert annotation_set[0]["redo_status"] == redo.STATUS_COMPLETED
    assert annotation_set[0]["annotations"][0]["text"] == "saved"


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
