import string
class TaskDeduplicator:
    @staticmethod
    def normalize(text: str) -> str:
            """Normalize text for comparison."""
            from task_rows import strip_markers
            text, _ = strip_markers(text)
            text = text.lower()
            text = text.translate(str.maketrans('', '', string.punctuation))
            text = ' '.join(text.split())
            return text
