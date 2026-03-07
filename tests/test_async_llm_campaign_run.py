import contextlib
import unittest
from unittest.mock import MagicMock, patch

from factgenie.app import (
    reconcile_llm_campaign_runtime_state,
    run_llm_campaign_background,
    start_llm_campaign_background,
)
from factgenie.campaign import CampaignStatus


class DummyApp:
    def __init__(self):
        self.db = {"running_campaign_threads": {}, "running_campaigns": set(), "announcers": {}}

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

    def test_reconcile_marks_live_thread_as_running(self):
        app = DummyApp()
        thread = MagicMock()
        thread.is_alive.return_value = True
        app.db["running_campaign_threads"]["campaign-1"] = thread

        campaign = MagicMock()
        campaign.metadata = {"id": "campaign-1", "status": CampaignStatus.IDLE}

        is_running = reconcile_llm_campaign_runtime_state(app, campaign)

        self.assertTrue(is_running)
        self.assertEqual(campaign.metadata["status"], CampaignStatus.RUNNING)
        campaign.update_metadata.assert_called_once()

    def test_reconcile_cleans_stale_running_flag_without_live_thread(self):
        app = DummyApp()
        app.db["running_campaigns"].add("campaign-1")
        app.db["announcers"]["campaign-1"] = object()

        campaign = MagicMock()
        campaign.metadata = {"id": "campaign-1", "status": CampaignStatus.IDLE}

        is_running = reconcile_llm_campaign_runtime_state(app, campaign)

        self.assertFalse(is_running)
        self.assertNotIn("campaign-1", app.db["running_campaigns"])
        self.assertNotIn("campaign-1", app.db["announcers"])
        campaign.update_metadata.assert_not_called()


if __name__ == "__main__":
    unittest.main()
