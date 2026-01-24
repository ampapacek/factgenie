import logging

from factgenie.annotations import AnnotationModelFactory
from factgenie.prompting import transforms as t
from factgenie.prompting.strategies import SequentialStrategy, register_llm_eval

logger = logging.getLogger("factgenie")


@register_llm_eval(name="default")
class StructuredAnnotationStrategy(SequentialStrategy):
    def get_transform_sequence(self) -> list[t.Transform]:
        TEXT = SequentialStrategy.TEXT
        PROMPT = "prompt"
        ANNOTATIONS_RAW = "annotations_raw"
        ANNOTATIONS = SequentialStrategy.ANNOTATIONS

        system_msg = self.config.get("system_msg", None)
        starts_with = self.config.get("start_with", None)

        annotation_span_categories = self.config["annotation_span_categories"]
        annotation_overlap_allowed = self.config.get("annotation_overlap_allowed", False)
        annotation_granularity = self.config.get("annotation_granularity", "words")
        with_reason = self.extra_args.get("with_reason", True)
        with_occurence_index = self.extra_args.get("with_occurence_index", False)
        output_validation_model = AnnotationModelFactory.get_output_model(with_reason, with_occurence_index)
        flags = self.config.get("flags")
        options = self.config.get("options")
        sliders = self.config.get("sliders")
        text_fields = self.config.get("text_fields") or self.config.get("textFields")

        return [
            # 1. Ask prompt.
            t.ApplyTemplate(self.config["prompt_template"], PROMPT),
            t.Log(text="Prompt: ", field=PROMPT, log_level="debug"),
            t.Log(text="Annotated text: ", field=TEXT),
            t.AskPrompt(
                PROMPT,
                ANNOTATIONS_RAW,
                system_msg,
                starts_with,
                completion_kwargs={"response_format": output_validation_model},
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
            t.ParseExtraFields(ANNOTATIONS_RAW, flags=flags, options=options, sliders=sliders, text_fields=text_fields),
            # Metadata.
        ]
