import unittest

from factgenie.llm_campaign import format_campaign_processing_error


class LlmCampaignErrorFormattingTests(unittest.TestCase):
    def test_temperature_hint_is_added_for_unsupported_params_error(self):
        error = RuntimeError(
            "litellm.UnsupportedParamsError: gpt-5 models don't support temperature=0. Only temperature=1 is supported."
        )

        message = format_campaign_processing_error("wp1-1", "test", 0, error)

        self.assertIn("Error processing example wp1-1-test-0", message)
        self.assertIn("exclude the `temperature` parameter", message)

    def test_other_errors_are_left_without_temperature_hint(self):
        error = ValueError("something else failed")

        message = format_campaign_processing_error("wp1-1", "test", 0, error)

        self.assertIn("something else failed", message)
        self.assertNotIn("exclude the `temperature` parameter", message)


if __name__ == "__main__":
    unittest.main()
