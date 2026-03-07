import unittest

from factgenie.prompting.model_apis import OpenAIAPI


class ModelApiNormalizationTests(unittest.TestCase):
    def make_openai_api(self, model_name: str):
        api = object.__new__(OpenAIAPI)
        api.config = {"model": model_name}
        api.api_kwargs = {}
        return api

    def test_openai_keeps_supported_temperature_for_non_gpt5(self):
        api = self.make_openai_api("gpt-4o-mini")
        kwargs = api.normalize_completion_kwargs({"temperature": 0, "max_tokens": 256})
        self.assertEqual(kwargs["temperature"], 0)
        self.assertEqual(kwargs["max_tokens"], 256)

    def test_openai_drops_unsupported_temperature_for_gpt5(self):
        api = self.make_openai_api("gpt-5-mini")
        kwargs = api.normalize_completion_kwargs({"temperature": 0, "max_tokens": 256})
        self.assertNotIn("temperature", kwargs)
        self.assertEqual(kwargs["max_tokens"], 256)

    def test_openai_keeps_temperature_one_for_gpt5(self):
        api = self.make_openai_api("gpt-5-mini")
        kwargs = api.normalize_completion_kwargs({"temperature": 1, "max_tokens": 256})
        self.assertEqual(kwargs["temperature"], 1)


if __name__ == "__main__":
    unittest.main()
