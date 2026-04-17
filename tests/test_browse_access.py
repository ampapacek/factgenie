from unittest.mock import patch

import pytest

from factgenie.app import app as flask_app


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

    with patch("factgenie.app.workflows.refresh_indexes"), patch(
        "factgenie.app.workflows.get_local_dataset_overview",
        return_value=datasets,
    ):
        response = app_client.get("/browse?dataset=wp1-1&split=test&example_idx=6&setup_id=rag-generated")

    assert response.status_code == 403
    body = response.get_data(as_text=True)
    assert "The requested dataset is hidden. Please sign in to access it." in body
    assert '"wp1-0-9"' in body
    assert '"wp1-1"' not in body
