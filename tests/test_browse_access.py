import json
from unittest.mock import patch

import pytest

from factgenie.app import app as flask_app
import factgenie.app as app_module
from factgenie import workflows


@pytest.fixture
def app_client():
    flask_app.config.update(TESTING=True, login={"active": False, "lock_view_pages": True}, host_prefix="")
    with flask_app.test_client() as client:
        yield client


def test_browse_hidden_dataset_permalink_shows_warning_for_anonymous_user(app_client):
    datasets = {
        "wp1-0-9": {"enabled": True, "name": "Visible dataset", "splits": ["test"]},
        "wp1-1": {
            "enabled": True,
            "name": "Hidden dataset",
            "splits": ["test"],
            "hidden_from_regular_users": True,
        },
    }

    with patch("factgenie.app._is_authenticated_viewer", return_value=False), patch(
        "factgenie.app._has_public_annotator_name_campaign", return_value=False,
    ), patch("factgenie.app.workflows.refresh_indexes"), patch(
        "factgenie.app.workflows.get_local_dataset_overview",
        return_value=datasets,
    ):
        response = app_client.get("/browse?dataset=wp1-1&split=test&example_idx=6&setup_id=rag-generated")

    assert response.status_code == 403
    body = response.get_data(as_text=True)
    assert "The requested dataset is hidden. Please sign in to access it. Redirected to an available dataset." in body
    assert '"wp1-0-9"' in body
    assert '"wp1-1"' not in body


@pytest.fixture
def instructions_campaigns(tmp_path, monkeypatch):
    monkeypatch.setattr(app_module, "CAMPAIGN_DIR", tmp_path)
    monkeypatch.setattr(workflows, "CAMPAIGN_DIR", tmp_path)
    monkeypatch.setitem(flask_app.db, "annotation_index", None)
    monkeypatch.setitem(flask_app.db, "annotation_index_cache", {})
    monkeypatch.setattr(app_module.utils, "load_dataset_config", lambda: {
        "demo": {"enabled": True},
        "private": {"enabled": True, "hidden_from_regular_users": True},
    })

    def create(campaign_id, split="test", hidden=False, dataset="demo", mode="crowdsourcing"):
        campaign_dir = tmp_path / campaign_id
        (campaign_dir / "files").mkdir(parents=True)
        config = {
            "annotator_instructions": f"# {campaign_id}\n\nFull **instructions**.",
            "annotation_span_categories": [
                {"name": "Category", "color": "rgb(231, 41, 138)", "description": "Explanation"},
            ],
        }
        (campaign_dir / "metadata.json").write_text(json.dumps({
            "id": campaign_id, "mode": mode, "config": config,
            "hidden_from_regular_users": hidden,
        }), encoding="utf-8")
        # Duplicate submissions must count as one campaign, including empty span annotations.
        records = [{
            "dataset": dataset, "split": split, "setup_id": "model", "example_idx": 0,
            "metadata": {"annotator_id": annotator}, "annotations": [],
        } for annotator in ("alice", "bob")]
        (campaign_dir / "files" / "annotations.jsonl").write_text(
            "".join(json.dumps(record) + "\n" for record in records), encoding="utf-8",
        )
        return config

    return create


@pytest.mark.parametrize("count", [0, 1, 2])
def test_browse_instructions_campaign_count(app_client, instructions_campaigns, count):
    for index in range(count):
        instructions_campaigns(f"camp-{index}")
    payload = app_client.get("/browse/instructions?dataset=demo&split=test").get_json()
    assert payload["success"] is True
    if count == 1:
        assert payload["instructions"]["campaign_id"] == "camp-0"
        assert "<strong>instructions</strong>" in payload["instructions"]["html"]
        assert payload["instructions"]["categories"][0]["description"] == "Explanation"
    else:
        assert payload["instructions"] is None


def test_browse_instructions_scoped_to_dataset_and_split(app_client, instructions_campaigns):
    instructions_campaigns("test-camp")
    instructions_campaigns("dev-one", split="dev")
    instructions_campaigns("dev-two", split="dev")
    instructions_campaigns("other-dataset", dataset="private")
    assert app_client.get("/browse/instructions?dataset=demo&split=test").get_json()["instructions"]["campaign_id"] == "test-camp"
    for scope in ("dataset=demo&split=dev", "dataset=demo&split=missing", "dataset=unknown&split=test", "dataset=demo"):
        assert app_client.get(f"/browse/instructions?{scope}").get_json()["instructions"] is None


@pytest.mark.parametrize("authenticated", [False, True])
def test_browse_instructions_hidden_campaign_visibility(app_client, instructions_campaigns, authenticated):
    instructions_campaigns("secret", hidden=True)
    with patch("factgenie.app._is_authenticated_viewer", return_value=authenticated):
        payload = app_client.get("/browse/instructions?dataset=demo&split=test").get_json()
    if authenticated:
        assert payload["instructions"]["campaign_id"] == "secret"
    else:
        assert payload["instructions"] is None
        assert "secret" not in json.dumps(payload)


@pytest.mark.parametrize("authenticated", [False, True])
def test_browse_instructions_counts_only_visible_campaigns(app_client, instructions_campaigns, authenticated):
    instructions_campaigns("public")
    instructions_campaigns("secret", hidden=True)
    with patch("factgenie.app._is_authenticated_viewer", return_value=authenticated):
        payload = app_client.get("/browse/instructions?dataset=demo&split=test").get_json()
    if authenticated:
        assert payload["instructions"] is None
    else:
        assert payload["instructions"]["campaign_id"] == "public"
        assert "secret" not in json.dumps(payload)


def test_browse_instructions_ignore_llm_campaigns(app_client, instructions_campaigns):
    instructions_campaigns("human")
    instructions_campaigns("llm", mode="llm_eval")
    assert app_client.get("/browse/instructions?dataset=demo&split=test").get_json()["instructions"]["campaign_id"] == "human"
    instructions_campaigns("llm-only", split="dev", mode="llm_eval")
    assert app_client.get("/browse/instructions?dataset=demo&split=dev").get_json()["instructions"] is None


def test_browse_instructions_hidden_dataset_is_not_public(app_client, instructions_campaigns):
    instructions_campaigns("private-camp", dataset="private")
    with patch("factgenie.app._is_authenticated_viewer", return_value=False):
        response = app_client.get("/browse/instructions?dataset=private&split=test")
    assert response.get_json()["instructions"] is None


def test_browse_instructions_obeys_browse_login_setting(app_client, instructions_campaigns, monkeypatch):
    instructions_campaigns("public")
    monkeypatch.setitem(flask_app.config, "login", {"active": True, "lock_view_pages": True})
    assert app_client.get("/browse/instructions?dataset=demo&split=test").status_code == 302
    monkeypatch.setitem(flask_app.config, "login", {"active": True, "lock_view_pages": False})
    assert app_client.get("/browse/instructions?dataset=demo&split=test").get_json()["instructions"]["campaign_id"] == "public"
