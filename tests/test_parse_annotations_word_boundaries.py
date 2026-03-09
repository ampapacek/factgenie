import unittest

from factgenie.annotations import AnnotationModelFactory
from factgenie.prompting.transforms import ParseAnnotations


class ParseAnnotationsWordBoundaryTests(unittest.TestCase):
    def test_word_granularity_expands_span_to_token_boundaries(self):
        parser = ParseAnnotations(
            input_field="annotations_json",
            output_field="annotations",
            annotation_span_categories=[{"name": "Jazyk"}],
            annotation_overlap_allowed=True,
            output_validation_model=AnnotationModelFactory.get_output_model(with_reason=True, with_occurence_index=False),
            annotation_granularity="words",
        )
        text = 'Podle textu "1994-02.pdf" patri mezi ne.'
        annotations_json = (
            '{"annotations": [{"text": "1994-02.pdf", "annotation_type": 0, "reason": "soubor misto nazvu"}]}'
        )

        annotations = parser.parse_annotations({"text": text, "annotations_json": annotations_json}, api=None)

        self.assertEqual(len(annotations), 1)
        self.assertEqual(annotations[0]["start"], text.index('"1994-02.pdf"'))
        self.assertEqual(annotations[0]["text"], '"1994-02.pdf"')

    def test_character_granularity_keeps_original_span(self):
        parser = ParseAnnotations(
            input_field="annotations_json",
            output_field="annotations",
            annotation_span_categories=[{"name": "Jazyk"}],
            annotation_overlap_allowed=True,
            output_validation_model=AnnotationModelFactory.get_output_model(with_reason=True, with_occurence_index=False),
            annotation_granularity="characters",
        )
        text = 'Podle textu "1994-02.pdf" patri mezi ne.'
        annotations_json = (
            '{"annotations": [{"text": "1994-02.pdf", "annotation_type": 0, "reason": "soubor misto nazvu"}]}'
        )

        annotations = parser.parse_annotations({"text": text, "annotations_json": annotations_json}, api=None)

        self.assertEqual(len(annotations), 1)
        self.assertEqual(annotations[0]["start"], text.index("1994-02.pdf"))
        self.assertEqual(annotations[0]["text"], "1994-02.pdf")


if __name__ == "__main__":
    unittest.main()
