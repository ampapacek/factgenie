import contextlib
import unittest
from unittest.mock import MagicMock, patch

from factgenie.app import run_llm_campaign_background, start_llm_campaign_background


class DummyApp:
    def __init__(self):
        self.db = {"running_campaign_threads": {}, "running_campaigns": set()}

    def app_context(self):
        return contextlib.nullcontext()


class AsyncLlmCampaignRunTests(unittest.TestCase):
    @patch("factgenie.app.threading.Thread")
    def test_start_llm_campaign_background_starts_daemon_thread(self, thread_cls):
        app = DummyApp()
        thread = MagicMock()
        thread_cls.return_value = thread

        returned = start_llm_campaign_background(
            app,
            "llm_eval",
            "campaign-1",
            announcer=object(),
            campaign=object(),
            datasets={},
            model=object(),
        )

        thread_cls.assert_called_once()
        self.assertTrue(thread_cls.call_args.kwargs["daemon"])
        thread.start.assert_called_once()
        self.assertIs(app.db["running_campaign_threads"]["campaign-1"], thread)
        self.assertIs(returned, thread)

    @patch("factgenie.app.utils.announce")
    @patch("factgenie.app.llm_campaign.pause_llm_campaign")
    @patch("factgenie.app.llm_campaign.run_llm_campaign")
    def test_background_runner_announces_errors(self, run_llm_campaign, pause_llm_campaign, announce):
        app = DummyApp()
        app.db["running_campaign_threads"]["campaign-1"] = object()

        response = MagicMock()
        response.get_json.return_value = {"success": False, "error": "boom"}
        run_llm_campaign.return_value = response

        announcer = object()
        run_llm_campaign_background(
            app,
            "llm_eval",
            "campaign-1",
            announcer,
            campaign=object(),
            datasets={},
            model=object(),
        )

        pause_llm_campaign.assert_called_once_with(app, "campaign-1")
        announce.assert_called_once()
        self.assertNotIn("campaign-1", app.db["running_campaign_threads"])


if __name__ == "__main__":
    unittest.main()
