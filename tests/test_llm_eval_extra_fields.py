import unittest

import litellm

from factgenie.campaign import CampaignMode
from factgenie.llm_campaign import parse_llm_eval_config
from factgenie.prompting.model_apis import MockingAPI
from factgenie.prompting.strategies.eval_default import StructuredAnnotationStrategy
from factgenie.prompting.strategies.eval_raw_output import RawOutputAnnotationStrategy
from factgenie.prompting.strategies.eval_sentence_split import SentenceSplitAnnotationStrategy
from factgenie.prompting.transforms import ParseExtraFields


class SequenceAPI(MockingAPI):
    def __init__(self, responses):
        super().__init__()
        self.responses = list(responses)
        self.calls = []

    def call_model_once(self, messages, model_service, prompt_strat_kwargs):
        self.calls.append(messages)
        payload = self.responses.pop(0)
        response = litellm.completion(model="gemini-2.0-flash", mock_response=payload["content"])
        reasoning = payload.get("reasoning")
        if reasoning is not None:
            response["choices"][0]["message"].reasoning_content = reasoning
        return response


def make_base_config():
    return {
        "annotation_span_categories": [{"name": "Issue", "description": "Issue label"}],
        "annotation_overlap_allowed": False,
        "annotation_granularity": "words",
        "prompt_template": "Annotate: {text}",
        "extra_args": {"with_reason": True},
    }


def make_extra_config():
    return make_base_config() | {
        "flags": ["Needs review"],
        "options": [{"label": "Severity", "values": ["low", "medium", "high"]}],
        "sliders": [{"label": "Confidence", "min": "1", "max": "5", "step": "1"}],
        "text_fields": ["Notes"],
    }


def annotation_json(span_text="world"):
    return f'{{"annotations": [{{"text": "{span_text}", "annotation_type": 0, "reason": "reason"}}]}}'


def extra_fields_json():
    return (
        '{"flags": {"Needs review": true}, '
        '"options": {"Severity": "high"}, '
        '"sliders": {"Confidence": 4}, '
        '"text_fields": {"Notes": "Check source"}}'
    )


class LlmEvalExtraFieldsTests(unittest.TestCase):
    def test_parse_llm_eval_config_preserves_extra_fields(self):
        parsed = parse_llm_eval_config(
            {
                "apiProvider": "openai",
                "modelName": "gpt-4.1",
                "promptStrat": "default",
                "promptTemplate": "Annotate",
                "systemMessage": "",
                "annotationSpanCategories": [{"name": "Issue", "description": "Issue label"}],
                "flags": ["Needs review"],
                "options": [{"label": "Severity", "values": ["low", "high"]}],
                "sliders": [{"label": "Confidence", "min": "1", "max": "5", "step": "1"}],
                "textFields": ["Notes"],
            }
        )

        self.assertEqual(parsed["flags"], ["Needs review"])
        self.assertEqual(parsed["options"], [{"label": "Severity", "values": ["low", "high"]}])
        self.assertEqual(
            parsed["sliders"],
            [{"label": "Confidence", "min": "1", "max": "5", "step": "1"}],
        )
        self.assertEqual(parsed["text_fields"], ["Notes"])

    def test_parse_extra_fields_transform(self):
        transform = ParseExtraFields(
            "extra_fields_json",
            flags=["Needs review"],
            options=[{"label": "Severity", "values": ["low", "medium", "high"]}],
            sliders=[{"label": "Confidence", "min": "1", "max": "5", "step": "1"}],
            text_fields=["Notes"],
        )

        result = transform([{"extra_fields_json": extra_fields_json()}], MockingAPI())[0]

        self.assertEqual(result["flags"], [{"label": "Needs review", "value": True}])
        self.assertEqual(
            result["options"],
            [
                {
                    "label": "Severity",
                    "index": 2,
                    "value": "high",
                    "optionList": ["Select an option...", "low", "medium", "high"],
                }
            ],
        )
        self.assertEqual(
            result["sliders"],
            [{"label": "Confidence", "value": 4, "min": 1, "max": 5, "step": 1}],
        )
        self.assertEqual(result["text_fields"], [{"label": "Notes", "value": "Check source"}])

    def test_default_strategy_keeps_one_turn_without_extra_fields(self):
        api = SequenceAPI([{"content": annotation_json(), "reasoning": "ann-trace"}])

        result = StructuredAnnotationStrategy(make_base_config(), CampaignMode.LLM_EVAL).get_output(
            api,
            {"question": "Q"},
            "hello world",
        )

        self.assertEqual(len(api.calls), 1)
        self.assertTrue(result["annotations"])
        self.assertNotIn("extra_fields_prompt", result["metadata"])

    def test_default_strategy_collects_extra_fields_in_second_turn(self):
        api = SequenceAPI(
            [
                {"content": annotation_json(), "reasoning": "ann-trace"},
                {"content": extra_fields_json(), "reasoning": "extra-trace"},
            ]
        )

        result = StructuredAnnotationStrategy(make_extra_config(), CampaignMode.LLM_EVAL).get_output(
            api,
            {"question": "Q"},
            "hello world",
        )

        self.assertEqual(len(api.calls), 2)
        self.assertEqual(len(api.calls[1]), 3)
        self.assertIn("Needs review", api.calls[1][-1]["content"])
        self.assertTrue(result["flags"][0]["value"])
        self.assertEqual(result["options"][0]["value"], "high")
        self.assertEqual(result["sliders"][0]["value"], 4)
        self.assertEqual(result["text_fields"][0]["value"], "Check source")
        self.assertEqual(result["metadata"]["extra_fields_thinking_trace"], "extra-trace")

    def test_parse_raw_strategy_collects_extra_fields(self):
        api = SequenceAPI(
            [
                {"content": f"before\n{annotation_json()}\nafter", "reasoning": "raw-trace"},
                {"content": extra_fields_json(), "reasoning": "extra-raw"},
            ]
        )

        result = RawOutputAnnotationStrategy(make_extra_config(), CampaignMode.LLM_EVAL).get_output(
            api,
            {"question": "Q"},
            "hello world",
        )

        self.assertEqual(len(api.calls), 2)
        self.assertTrue(result["annotations"])
        self.assertEqual(result["options"][0]["index"], 2)
        self.assertEqual(result["metadata"]["extra_fields_thinking_trace"], "extra-raw")

    def test_sentence_split_collects_extra_fields_once_after_unify(self):
        config = make_extra_config() | {"prompt_template": "Annotate: {part}"}
        api = SequenceAPI(
            [
                {"content": annotation_json("First")},
                {"content": annotation_json("Second")},
                {"content": extra_fields_json(), "reasoning": "extra-sentence"},
            ]
        )

        result = SentenceSplitAnnotationStrategy(config, CampaignMode.LLM_EVAL).get_output(
            api,
            {"question": "Q"},
            "First sentence. Second sentence.",
        )

        self.assertEqual(len(api.calls), 3)
        self.assertIn("Span annotations already generated:", api.calls[-1][-1]["content"])
        self.assertTrue(result["flags"][0]["value"])
        self.assertEqual(len(result["annotations"]), 2)
        self.assertEqual(result["metadata"]["extra_fields_thinking_trace"], "extra-sentence")


if __name__ == "__main__":
    unittest.main()
