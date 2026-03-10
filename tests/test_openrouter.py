import sys
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
import requests

import factgenie.llm_campaign as llm_campaign
from factgenie.app import app as flask_app
from factgenie.models import ModelFactory
from factgenie.prompting.model_apis import OpenRouterAPI


def _mock_litellm(validate_response):
    return SimpleNamespace(validate_environment=MagicMock(return_value=validate_response))


@pytest.fixture
def app_client():
    flask_app.config.update(TESTING=True, login={"active": False, "lock_view_pages": True}, host_prefix="")
    with flask_app.test_client() as client:
        yield client


def test_openrouter_provider_is_registered():
    assert "openrouter" in ModelFactory.get_model_apis()


def test_openrouter_provider_prefixes_model_name():
    mock_litellm = _mock_litellm({"keys_in_environment": True, "missing_keys": []})

    with patch.dict(sys.modules, {"litellm": mock_litellm}):
        api = OpenRouterAPI({"model": "google/gemini-2.0-flash-001"})

    assert api.get_model_service_name() == "openrouter/google/gemini-2.0-flash-001"
    mock_litellm.validate_environment.assert_called_once_with(model="openrouter/google/gemini-2.0-flash-001")


def test_openrouter_provider_requires_expected_environment_key():
    mock_litellm = _mock_litellm({"keys_in_environment": False, "missing_keys": ["OPENROUTER_API_KEY"]})

    with patch.dict(sys.modules, {"litellm": mock_litellm}):
        with pytest.raises(ValueError, match="OPENROUTER_API_KEY"):
            OpenRouterAPI({"model": "google/gemini-2.0-flash-001"})


def test_fetch_openrouter_model_ids_normalizes_response():
    response = MagicMock()
    response.json.return_value = {
        "data": [
            {"id": "openai/gpt-4o-mini"},
            {"id": "anthropic/claude-3.5-sonnet"},
            {"id": "openai/gpt-4o-mini"},
            {"name": "missing-id"},
        ]
    }

    with patch("factgenie.llm_campaign.requests.get", return_value=response) as mock_get:
        model_ids = llm_campaign.fetch_openrouter_model_ids()

    assert model_ids == ["anthropic/claude-3.5-sonnet", "openai/gpt-4o-mini"]
    mock_get.assert_called_once()


def test_fetch_openrouter_model_ids_rejects_malformed_response():
    response = MagicMock()
    response.json.return_value = {"unexpected": []}

    with patch("factgenie.llm_campaign.requests.get", return_value=response):
        with pytest.raises(ValueError, match="data"):
            llm_campaign.fetch_openrouter_model_ids()


def test_validate_openrouter_model_reports_available():
    with patch("factgenie.llm_campaign.fetch_openrouter_model_ids", return_value=["openai/gpt-4o-mini"]):
        result = llm_campaign.validate_openrouter_model("openai/gpt-4o-mini")

    assert result["available"] is True
    assert result["lookup_failed"] is False
    assert result["suggestions"] == []


def test_validate_openrouter_model_suggests_similar_names():
    model_ids = [
        "openai/gpt-4o-mini",
        "openai/gpt-4.1-mini",
        "google/gemini-2.0-flash-001",
    ]

    with patch("factgenie.llm_campaign.fetch_openrouter_model_ids", return_value=model_ids):
        result = llm_campaign.validate_openrouter_model("openai/gpt-4o-min")

    assert result["available"] is False
    assert result["lookup_failed"] is False
    assert result["suggestions"] == ["openai/gpt-4o-mini", "openai/gpt-4.1-mini"]
    assert "Did you mean" in result["message"]


def test_validate_openrouter_model_handles_lookup_failure():
    with patch(
        "factgenie.llm_campaign.fetch_openrouter_model_ids",
        side_effect=requests.RequestException("network problem"),
    ):
        result = llm_campaign.validate_openrouter_model("openai/gpt-4o-mini")

    assert result["available"] is False
    assert result["lookup_failed"] is True
    assert result["suggestions"] == []
    assert "Could not verify" in result["message"]


def test_validate_model_endpoint_returns_openrouter_validation(app_client):
    with patch(
        "factgenie.llm_campaign.validate_openrouter_model",
        return_value={
            "available": False,
            "lookup_failed": False,
            "suggestions": ["openai/gpt-4o-mini"],
            "message": "OpenRouter model `foo` is not available. Did you mean: `openai/gpt-4o-mini`?",
        },
    ):
        response = app_client.post(
            "/llm_campaign/validate_model",
            json={"provider": "openrouter", "model": "foo"},
        )

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["success"] is True
    assert payload["available"] is False
    assert payload["suggestions"] == ["openai/gpt-4o-mini"]


def test_validate_model_endpoint_bypasses_non_openrouter_provider(app_client):
    response = app_client.post(
        "/llm_campaign/validate_model",
        json={"provider": "openai", "model": "gpt-4o-mini"},
    )

    payload = response.get_json()
    assert response.status_code == 200
    assert payload == {
        "success": True,
        "available": True,
        "lookup_failed": False,
        "suggestions": [],
        "message": None,
    }
