import html as html_lib
import json
import re
import threading
import zipfile
from copy import deepcopy
from io import BytesIO
from types import SimpleNamespace

import pandas as pd
import pytest
import yaml
from flask import Flask, render_template_string

from factgenie import analysis, crowdsourcing, llm_campaign, querying, redo, workflows
from factgenie.campaign import CampaignMode, ExampleStatus
from factgenie.text_lists import normalize_config, normalize_annotation, submission_lists
from test_redo import configure_campaign_dir, make_campaign, make_per_example_campaign


@pytest.fixture
def definitions():
    return [
        {
            "label": "Chybějící informace",
            "description": "Co v odpovědi chybí?",
            "placeholder": "Popište chybějící informaci…",
            "empty_confirmation": True,
            "empty_label": "Nic nechybí",
            "choice_groups": [
                {
                    "label": "Top 10",
                    "default_values": ["Nevím"],
                    "options": [{"label": "Ano", "code": "InTop10"}, {"label": "Ne", "code": "NotInTop10"}, "Nevím"],
                },
                {
                    "label": "Seafile",
                    "default_values": ["Nevím"],
                    "options": [
                        {"label": "Ano", "code": "InSeafile"},
                        {"label": "Ne", "code": "NotInSeafile"},
                        "Nevím",
                    ],
                },
            ],
        }
    ]


def filled(definitions, item_id="stable-id"):
    return [
        {
            "label": definitions[0]["label"],
            "empty_confirmed": False,
            "items": [
                {
                    "id": item_id,
                    "text": "Chybí konkrétní příklady učiva.",
                    "choices": [{"label": "Top 10", "values": ["Ne"]}, {"label": "Seafile", "values": ["Ano"]}],
                }
            ],
        }
    ]


def test_yaml_config_round_trip(definitions):
    parsed = crowdsourcing.parse_crowdsourcing_config({"text_lists": definitions})
    loaded = yaml.safe_load(yaml.safe_dump(parsed, allow_unicode=True))
    assert normalize_config(loaded["text_lists"]) == parsed["text_lists"]
    assert parsed["text_lists"][0]["choice_groups"][0]["options"][-1] == {"label": "Nevím", "code": None}
    assert crowdsourcing.parse_crowdsourcing_config({})["text_lists"] == []


@pytest.mark.parametrize(
    "mutation",
    [
        lambda x: x[0].update(label=" "),
        lambda x: x.append(deepcopy(x[0])),
        lambda x: x[0].update(max_items=0),
        lambda x: x[0].update(max_items=True),
        lambda x: x[0].update(max_items=1.5),
        lambda x: x[0].update(required="true"),
        lambda x: x[0].update(required=True, empty_confirmation=False),
        lambda x: x[0]["choice_groups"][0].update(options=[]),
        lambda x: x[0]["choice_groups"][0].update(default_values=["missing"]),
        lambda x: x[0]["choice_groups"][0].update(default_values=["Ano", "Ne"]),
        lambda x: x[0]["choice_groups"][0]["options"].append("Nevím"),
        lambda x: x[0]["choice_groups"].append(deepcopy(x[0]["choice_groups"][0])),
        lambda x: x[0]["choice_groups"][0].update(display="slider"),
        lambda x: x[0]["choice_groups"][0].update(display="toggle"),  # three options and a default
        lambda x: x[0]["choice_groups"][0].update(display="toggle", options=["Ano", "Ne"], default_values=["Ne"]),
        lambda x: x[0]["choice_groups"][0].update(display="toggle", options=["Ano", "Ne"], default_values=[], required=True),
        lambda x: x[0]["choice_groups"][0].update(display="toggle", options=["Ano", "Ne"], default_values=[], multiple=True),
    ],
)
def test_invalid_configuration(definitions, mutation):
    mutation(definitions)
    with pytest.raises(ValueError):
        normalize_config(definitions)


def test_required_defaults_and_multiselect(definitions):
    group = definitions[0]["choice_groups"][0]
    group.update(multiple=True, required=True, default_values=["Ano", "Ne"])
    config = normalize_config(definitions)
    records = filled(definitions)
    records[0]["items"][0]["choices"][0]["values"] = ["Ano", "Ne"]
    assert normalize_annotation(config, records) == records
    records[0]["items"][0]["choices"][0]["values"] = []
    with pytest.raises(ValueError):
        normalize_annotation(config, records)


@pytest.mark.parametrize(
    "mutation",
    [
        lambda r: r[0].update(empty_confirmed=True),
        lambda r: r[0]["items"][0]["choices"][0].update(values=["missing"]),
        lambda r: r[0]["items"][0]["choices"][0].update(values=["Ano", "Ne"]),
        lambda r: r[0]["items"][0]["choices"][0].update(values=["Ne", "Ne"]),
        lambda r: r[0]["items"][0]["choices"].append({"label": "unknown", "values": []}),
        lambda r: r[0]["items"].append(deepcopy(r[0]["items"][0])),
        lambda r: r[0].update(label="unknown"),
        lambda r: r.append(deepcopy(r[0])),
    ],
)
def test_invalid_annotation(definitions, mutation):
    records = filled(definitions)
    mutation(records)
    with pytest.raises(ValueError):
        normalize_annotation(normalize_config(definitions), records)


def test_blank_rows_and_empty_states(definitions):
    config = normalize_config(definitions)
    records = filled(definitions)
    records[0]["items"][0].update(text=" \n ", choices=[{"label": "bad", "values": ["bad"]}])
    assert normalize_annotation(config, records)[0]["items"] == []
    assert not normalize_annotation(config, [])[0]["empty_confirmed"]
    config[0]["required"] = True
    with pytest.raises(ValueError):
        normalize_annotation(config, [])
    records[0]["empty_confirmed"] = True
    assert normalize_annotation(config, records)[0]["empty_confirmed"]


def test_limits_and_id_collision_across_lists(definitions, monkeypatch):
    config = normalize_config(definitions)
    config.append({**deepcopy(config[0]), "label": "Second"})
    records = filled(definitions)
    second = deepcopy(records[0])
    second["label"] = "Second"
    records.append(second)
    with pytest.raises(ValueError, match="Duplicate item IDs"):
        normalize_annotation(config, records)
    records[1]["items"][0].pop("id")
    ids = iter(["stable-id", "new-id"])
    monkeypatch.setattr("factgenie.text_lists.uuid4", lambda: SimpleNamespace(hex=next(ids)))
    normalized = normalize_annotation(config, records)
    assert normalized[0]["items"][0]["id"] == "stable-id"
    assert normalized[1]["items"][0]["id"] == "new-id"
    config[0]["max_items"] = 1
    records[0]["items"].append({**deepcopy(records[0]["items"][0]), "id": "other"})
    with pytest.raises(ValueError, match="too many"):
        normalize_annotation(config, records)


@pytest.mark.parametrize("mode", ["batch", "per_example", "per_example_finish", "backup"])
def test_save_load_export_round_trip(definitions, mode, monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_per_example_campaign(tmp_path)
    campaign.metadata["config"]["text_lists"] = normalize_config(definitions)
    campaign.metadata["config"]["save_mode"] = "batch" if mode in ("batch", "backup") else "per_example"
    (tmp_path / campaign.campaign_id / "metadata.json").write_text(json.dumps(campaign.metadata))
    monkeypatch.setattr(workflows, "load_campaign", lambda app, campaign_id: campaign)
    monkeypatch.setattr(workflows, "get_output_for_setup", lambda **kwargs: {"output": "Answer"})
    monkeypatch.setattr(workflows, "refresh_indexes", lambda app: None)
    app = SimpleNamespace(db={"lock": threading.Lock()})
    payloads = [
        {
            **row,
            "annotations": [],
            "flags": [],
            "options": [],
            "sliders": [],
            "textFields": [],
            "text_lists": filled(definitions),
        }
        for row in campaign.db.to_dict("records")
    ]
    flask_app = Flask(__name__)
    with flask_app.app_context():
        if mode == "per_example":
            response = crowdsourcing.save_annotation_item(app, campaign.campaign_id, payloads[0], "ann-a")
        elif mode == "per_example_finish":
            response = crowdsourcing.save_per_example_annotations(app, campaign.campaign_id, payloads, "ann-a")
        else:
            response = crowdsourcing.save_annotations(
                app, campaign.campaign_id, payloads, "ann-a", is_backup_import=mode == "backup"
            )
        assert response.get_json()["success"], response.get_json()
        exported = workflows.export_campaign_outputs(campaign.campaign_id)
    paths = list((tmp_path / campaign.campaign_id / "files").glob("*.jsonl"))
    records = [json.loads(line) for path in paths for line in path.read_text().splitlines()]
    assert all(record["text_lists"] == filled(definitions) for record in records)
    loaded = workflows.load_annotations_from_file(paths[0], campaign.metadata)
    assert loaded[0]["text_lists"] == filled(definitions)
    submissions = querying._build_submissions(pd.DataFrame(loaded), {campaign.campaign_id: campaign})
    assert submissions.iloc[0]["annotation_state"] == "done"
    assert submissions.iloc[0]["text_lists"] == filled(definitions)
    with zipfile.ZipFile(BytesIO(exported.data)) as archive:
        assert any(
            "text_lists" in archive.read(name).decode() for name in archive.namelist() if name.endswith(".jsonl")
        )
    if mode == "per_example":
        campaign.load_db()
        restored = crowdsourcing.get_examples_for_batch(campaign.db, 0, campaign, "ann-a", include_saved=True)
        assert restored[0]["text_lists"] == filled(definitions)


@pytest.mark.parametrize("mode", ["batch", "per_example", "backup"])
def test_invalid_save_preserves_db_and_files(definitions, mode, monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_per_example_campaign(tmp_path)
    campaign.metadata["config"]["text_lists"] = normalize_config(definitions)
    monkeypatch.setattr(workflows, "load_campaign", lambda app, campaign_id: campaign)
    monkeypatch.setattr(workflows, "get_output_for_setup", lambda **kwargs: {"output": "Answer"})
    app = SimpleNamespace(db={"lock": threading.Lock()})
    records = filled(definitions)
    records[0]["items"].append(deepcopy(records[0]["items"][0]))
    payloads = [
        {**row, "annotations": [], "flags": [], "options": [], "sliders": [], "textFields": [], "text_lists": records}
        for row in campaign.db.to_dict("records")
    ]
    db_path = tmp_path / campaign.campaign_id / "db.csv"
    before = db_path.read_bytes()
    with Flask(__name__).app_context():
        if mode == "per_example":
            response = crowdsourcing.save_annotation_item(app, campaign.campaign_id, payloads[0], "ann-a")
        else:
            response = crowdsourcing.save_annotations(
                app, campaign.campaign_id, payloads, "ann-a", is_backup_import=mode == "backup"
            )
    assert not response.get_json()["success"]
    assert db_path.read_bytes() == before
    assert not list((tmp_path / campaign.campaign_id / "files").glob("*.jsonl"))


def test_redo_blocked_with_existing_queue(definitions, monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_per_example_campaign(tmp_path)
    campaign.metadata["config"]["text_lists"] = normalize_config(definitions)
    (tmp_path / campaign.campaign_id / "metadata.json").write_text(json.dumps(campaign.metadata))
    redo.save_queue(campaign.campaign_id, {"items": [{"redo_id": "old", "status": "pending", "annotator_id": "ann-a"}]})
    monkeypatch.setattr(workflows, "load_campaign", lambda app, campaign_id: campaign)
    with pytest.raises(ValueError, match="Text lists|text lists"):
        redo.add_items(campaign.campaign_id, [])
    with pytest.raises(ValueError):
        crowdsourcing.get_redo_annotation_set(None, campaign, campaign.db, "ann-a")
    with Flask(__name__).app_context():
        assert not crowdsourcing.save_redo_annotation(None, campaign.campaign_id, "old", {}, "ann-a").get_json()[
            "success"
        ]
        assert not crowdsourcing.keep_redo_annotation(None, campaign.campaign_id, "old", "ann-a").get_json()["success"]
    assert redo.load_queue(campaign.campaign_id)["items"][0]["status"] == "pending"


@pytest.mark.parametrize("parser", [llm_campaign.parse_llm_eval_config, llm_campaign.parse_llm_gen_config])
def test_llm_rejection(definitions, parser):
    with pytest.raises(ValueError, match="not supported"):
        parser({"text_lists": definitions})


def test_generated_page_escapes_labels(definitions, monkeypatch, tmp_path):
    monkeypatch.setattr(crowdsourcing, "CAMPAIGN_DIR", tmp_path)
    definitions[0]["label"] = '<script>alert("test")</script>'
    definitions[0]["description"] = "{{ 7 * 7 }}"
    config = {"annotator_instructions": "Review", "text_lists": normalize_config(definitions)}
    crowdsourcing.create_crowdsourcing_page("temporary", config)
    page = (tmp_path / "temporary/pages/annotate.html").read_text()
    assert "text-lists.js" in page and "<script>alert(" not in page

    # Configuration is embedded by the final (serving) render only, never interpreted as Jinja.
    with Flask(__name__, template_folder=str(crowdsourcing.TEMPLATES_DIR)).test_request_context():
        html = render_template_string(page, metadata={"config": config}, annotation_set=[], annotator_preferences={}, redo_context={}, host_prefix="")
    embedded = re.search(r'id="text-lists" data-config="([^"]*)"', html).group(1)
    assert json.loads(html_lib.unescape(embedded)) == config["text_lists"]
    assert "<script>alert(" not in html


def test_ui_state_transitions():
    import shutil
    import subprocess
    from pathlib import Path

    if not shutil.which("node"):
        pytest.skip("Node is required for the text-list UI state tests")
    root = Path(__file__).resolve().parents[1]
    subprocess.run(["node", str(root / "tests/test_text_lists_ui.cjs")], cwd=root, check=True, capture_output=True)


def test_creation_freezes_normalized_configuration(definitions, monkeypatch, tmp_path):
    monkeypatch.setattr(crowdsourcing, "CAMPAIGN_DIR", tmp_path)
    monkeypatch.setattr(crowdsourcing, "generate_crowdsourcing_campaign_db", lambda *args, **kwargs: pd.DataFrame())
    monkeypatch.setattr(workflows, "load_campaign", lambda *args: None)
    definitions[0]["label"] = "  Chybějící informace  "
    config = {"annotator_instructions": "Review", "text_lists": definitions}
    crowdsourcing.create_crowdsourcing_campaign(None, "new-campaign", config, [])
    metadata = json.loads((tmp_path / "new-campaign/metadata.json").read_text())
    assert metadata["config"]["text_lists"] == normalize_config(definitions)
    assert config["text_lists"][0]["label"].startswith("  ")  # caller input remains untouched


def test_required_preview_validates_without_saving(definitions, monkeypatch):
    config = normalize_config(definitions)
    config[0]["required"] = True
    campaign = SimpleNamespace(metadata={"config": {"text_lists": config, "final_message": "Thanks"}})
    monkeypatch.setattr(workflows, "load_campaign", lambda *args, **kwargs: campaign)
    with Flask(__name__).app_context():
        invalid = crowdsourcing.preview_submission_response(None, "preview", [{}])
        assert not invalid.get_json()["success"]
        valid = crowdsourcing.preview_submission_response(None, "preview", [{"text_lists": filled(definitions)}])
        assert valid.get_json()["success"]
        assert "No annotations were saved" in valid.get_json()["message"]


def test_question_coverage_counts_list_only_submissions(monkeypatch, tmp_path):
    configure_campaign_dir(monkeypatch, tmp_path)
    campaign = make_campaign(tmp_path)
    base = campaign.db.iloc[0]
    campaign.db = pd.DataFrame([{**base, "setup_id": setup} for setup in ["items", "confirmed", "unfilled"]])
    lists = {
        "items": [{"label": "Missing", "empty_confirmed": False, "items": [{"id": "a", "text": "x", "choices": []}]}],
        "confirmed": [{"label": "Missing", "empty_confirmed": True, "items": []}],
        "unfilled": [{"label": "Missing", "empty_confirmed": False, "items": []}],
    }
    example_index = pd.DataFrame(
        [
            {
                "campaign_id": "redo-test",
                "dataset": base["dataset"],
                "split": base["split"],
                "setup_id": setup,
                "example_idx": int(base["example_idx"]),
                "annotator_group": 0,
                "annotator_id": "ann-a",
                "annotations": [],
                "flags": [],
                "sliders": [],
                "text_fields": [],
                "text_lists": text_lists,
            }
            for setup, text_lists in lists.items()
        ]
    )
    stats = analysis.compute_question_coverage_stats(
        SimpleNamespace(db={"datasets_obj": {}}), campaign, example_index, show_real_annotator_names=True
    )
    statuses = {row["setup_id"]: row["statuses"]["ann-a"] for row in stats["matrix"]["rows"]}

    assert statuses == {"items": "done", "confirmed": "done", "unfilled": "todo"}


def test_toggle_neutral_middle_stores_no_value(definitions):
    for group in definitions[0]["choice_groups"]:
        group.update(display="toggle", default_values=[], options=group["options"][:2])
    config = normalize_config(definitions)
    assert [group["display"] for group in config[0]["choice_groups"]] == ["toggle", "toggle"]
    records = filled(definitions)
    records[0]["items"][0]["choices"][0]["values"] = []
    assert normalize_annotation(config, records) == records
    # Frozen configurations from before `display` existed keep plain choices.
    assert normalize_config([{"label": "L", "choice_groups": [{"label": "G", "options": ["a"]}]}])[0][
        "choice_groups"
    ][0]["display"] == "choices"


def test_skipped_example_waives_required_lists_and_choices(definitions):
    definitions[0].update(required=True)
    definitions[0]["choice_groups"][0].update(required=True, default_values=[])
    config = {"text_lists": definitions}
    empty = {"text_lists": [{"label": definitions[0]["label"], "empty_confirmed": False, "items": []}]}
    with pytest.raises(ValueError):
        submission_lists(config, empty)
    skipped = {**empty, "flags": [{"label": "Přeskočit tuto otázku", "value": True}]}
    assert submission_lists(config, skipped)[0]["items"] == []
    records = filled(definitions)
    records[0]["items"][0]["choices"][0]["values"] = []
    assert submission_lists(config, {"text_lists": records, "flags": skipped["flags"]}) == records
    # Skipping waives only completeness, not structure.
    records[0]["items"][0]["choices"][0]["values"] = ["missing"]
    with pytest.raises(ValueError):
        submission_lists(config, {"text_lists": records, "flags": skipped["flags"]})


@pytest.mark.parametrize("lists", [[], "definitions"])
def test_config_modal_round_trip_keeps_crowdsourcing_lists(definitions, lists, monkeypatch):
    import factgenie.app as app_mod

    lists = normalize_config(definitions) if lists == "definitions" else lists
    saved = []
    campaign = SimpleNamespace(
        metadata={"mode": CampaignMode.CROWDSOURCING, "config": {"final_message": "Thanks", "text_lists": lists}},
        update_metadata=lambda: saved.append(deepcopy(campaign.metadata["config"])),
    )
    monkeypatch.setattr(workflows, "load_campaign", lambda *args, **kwargs: campaign)
    app_mod.app.config.update(login={"active": False}, host_prefix="")
    # The modal renders each value with {{ value }} into a textarea and posts the text back.
    modal = {key: str(value) for key, value in campaign.metadata["config"].items()}
    response = app_mod.app.test_client().post(
        "/llm_campaign/update_metadata", json={"campaignId": "c", "config": modal}
    )
    assert response.get_json()["success"]
    assert saved == [{"final_message": "Thanks", "text_lists": lists}]

    modal["text_lists"] = "[{'label': ''}]"
    response = app_mod.app.test_client().post(
        "/llm_campaign/update_metadata", json={"campaignId": "c", "config": modal}
    )
    assert not response.get_json()["success"]
    assert len(saved) == 1


def test_config_modal_rejects_lists_in_llm_campaigns(definitions, monkeypatch):
    import factgenie.app as app_mod

    saved = []
    campaign = SimpleNamespace(
        metadata={"mode": CampaignMode.LLM_EVAL, "config": {}}, update_metadata=lambda: saved.append(True)
    )
    monkeypatch.setattr(workflows, "load_campaign", lambda *args, **kwargs: campaign)
    app_mod.app.config.update(login={"active": False}, host_prefix="")
    client = app_mod.app.test_client()
    ok = client.post("/llm_campaign/update_metadata", json={"campaignId": "c", "config": {"text_lists": "[]"}})
    assert ok.get_json()["success"]
    bad = client.post(
        "/llm_campaign/update_metadata",
        json={"campaignId": "c", "config": {"text_lists": str(normalize_config(definitions))}},
    )
    assert not bad.get_json()["success"]
    assert saved == [True]
