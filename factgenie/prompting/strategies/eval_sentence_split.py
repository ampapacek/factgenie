import logging

from factgenie.annotations import AnnotationModelFactory
from factgenie.prompting.llm_eval_extra_fields import (
    build_extra_fields_followup_prompt,
    has_extra_fields,
    normalize_extra_fields_config,
)
from factgenie.prompting import transforms as t
from factgenie.prompting.strategies import SequentialStrategy, register_llm_eval

logger = logging.getLogger("factgenie")


@register_llm_eval(name="sentence_split")
class SentenceSplitAnnotationStrategy(SequentialStrategy):
    def get_transform_sequence(self) -> list[t.Transform]:
        TEXT = SequentialStrategy.TEXT
        PART = "part"
        PROMPT = "annotation_prompt"
        ANNOTATION_RESPONSE = "annotation_response"
        ANNOTATIONS = SequentialStrategy.ANNOTATIONS
        THINKING_TRACE = "thinking_trace"
        EXTRA_FIELDS_PROMPT = "extra_fields_prompt"
        EXTRA_FIELDS_RESPONSE = "extra_fields_response"
        EXTRA_FIELDS_JSON = "extra_fields_json"
        EXTRA_FIELDS_THINKING_TRACE = "extra_fields_thinking_trace"

        annotation_span_categories = self.config["annotation_span_categories"]
        annotation_overlap_allowed = self.config.get("annotation_overlap_allowed", False)
        annotation_granularity = self.config.get("annotation_granularity", "words")
        with_reason = self.extra_args.get("with_reason", True)
        output_validation_model = AnnotationModelFactory.get_output_model(with_reason)
        extra_fields = normalize_extra_fields_config(self.config)

        sequence = [
            # 1. Split sentences
            t.SentenceSplit(TEXT, PART),
            t.Log(text="Sentences: ", field=PART),
            # 2. Ask prompt.
            t.ApplyTemplate(self.config["prompt_template"], PROMPT),
            t.Log(text="Prompt: ", field=PROMPT, log_level="debug"),
            t.AskPrompt(PROMPT, ANNOTATION_RESPONSE, reasoning_field=THINKING_TRACE),
            # 3. Parse annotations.
            t.Unify(annotation_fields=[ANNOTATION_RESPONSE], join_strings_by=t.join_string_long),
            t.ParseAnnotations(
                ANNOTATION_RESPONSE,
                ANNOTATIONS,
                annotation_span_categories,
                annotation_overlap_allowed,
                output_validation_model,
                annotation_granularity,
            ),
        ]

        metadata_fields = [PROMPT, THINKING_TRACE]

        if has_extra_fields(self.config):
            sequence.extend(
                [
                    t.ApplyTemplate(
                        build_extra_fields_followup_prompt(
                            self.config,
                            include_context=True,
                            annotations_field=ANNOTATION_RESPONSE,
                        ),
                        EXTRA_FIELDS_PROMPT,
                    ),
                    t.Log(text="Extra fields prompt: ", field=EXTRA_FIELDS_PROMPT, log_level="debug"),
                    t.AskPrompt(EXTRA_FIELDS_PROMPT, EXTRA_FIELDS_RESPONSE, reasoning_field=EXTRA_FIELDS_THINKING_TRACE),
                    t.ExtractJson(EXTRA_FIELDS_RESPONSE, EXTRA_FIELDS_JSON),
                    t.ParseExtraFields(
                        EXTRA_FIELDS_JSON,
                        flags=extra_fields["flags"],
                        options=extra_fields["options"],
                        sliders=extra_fields["sliders"],
                        text_fields=extra_fields["text_fields"],
                    ),
                ]
            )
            metadata_fields.extend([EXTRA_FIELDS_PROMPT, EXTRA_FIELDS_THINKING_TRACE])

        sequence.append(t.Metadata(metadata_fields))
        return sequence
