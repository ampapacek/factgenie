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


@register_llm_eval(name="default")
class StructuredAnnotationStrategy(SequentialStrategy):
    def get_transform_sequence(self) -> list[t.Transform]:
        TEXT = SequentialStrategy.TEXT
        PROMPT = "prompt"
        CONVERSATION = "conversation"
        ANNOTATIONS_RAW = "annotations_raw"
        ANNOTATIONS = SequentialStrategy.ANNOTATIONS
        THINKING_TRACE = "thinking_trace"
        EXTRA_FIELDS_PROMPT = "extra_fields_prompt"
        EXTRA_FIELDS_RESPONSE = "extra_fields_response"
        EXTRA_FIELDS_JSON = "extra_fields_json"
        EXTRA_FIELDS_THINKING_TRACE = "extra_fields_thinking_trace"

        system_msg = self.config.get("system_msg", None)
        starts_with = self.config.get("start_with", None)
        extra_fields = normalize_extra_fields_config(self.config)

        annotation_span_categories = self.config["annotation_span_categories"]
        annotation_overlap_allowed = self.config.get("annotation_overlap_allowed", False)
        annotation_granularity = self.config.get("annotation_granularity", "words")
        with_reason = self.extra_args.get("with_reason", True)
        with_occurence_index = self.extra_args.get("with_occurence_index", False)
        output_validation_model = AnnotationModelFactory.get_output_model(with_reason, with_occurence_index)

        sequence = [
            # 1. Ask prompt.
            t.ApplyTemplate(self.config["prompt_template"], PROMPT),
            t.Log(text="Prompt: ", field=PROMPT, log_level="debug"),
            t.Log(text="Annotated text: ", field=TEXT),
            t.ConverseLLM(
                PROMPT,
                CONVERSATION,
                restart_conversation=True,
                system_msg=system_msg,
                start_with=starts_with,
                completion_kwargs={"response_format": output_validation_model},
            ),
            t.ConversationExtractResponse(CONVERSATION, ANNOTATIONS_RAW),
            t.ConversationExtractResponse(
                CONVERSATION,
                THINKING_TRACE,
                conversation_key=t.ConverseLLM.REASONING_CONTENT,
                default="",
            ),
            # 2. Parse annotations.
            t.ParseAnnotations(
                ANNOTATIONS_RAW,
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
                            annotations_field=ANNOTATIONS_RAW,
                        ),
                        EXTRA_FIELDS_PROMPT,
                    ),
                    t.Log(text="Extra fields prompt: ", field=EXTRA_FIELDS_PROMPT, log_level="debug"),
                    t.ConverseLLM(EXTRA_FIELDS_PROMPT, CONVERSATION),
                    t.ConversationExtractResponse(CONVERSATION, EXTRA_FIELDS_RESPONSE),
                    t.ConversationExtractResponse(
                        CONVERSATION,
                        EXTRA_FIELDS_THINKING_TRACE,
                        conversation_key=t.ConverseLLM.REASONING_CONTENT,
                        default="",
                    ),
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

        sequence.append(t.Metadata(fields=metadata_fields))
        return sequence
