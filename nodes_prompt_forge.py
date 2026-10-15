"""Universal Prompt Forge node — text prompt field with Clear / Copy / Forge."""
from .prompt_forge import unload_forge_models, log


class PromptForge:
    DESCRIPTION = (
        "Prompt Forge: universal text prompt field with Clear, Copy and Forge buttons. "
        "Forge drafts a model-appropriate prompt from a short brief using a local "
        "Ollama model. Ships with profiles for ANIMA, Flux, Qwen Image, Krea 2, "
        "Z-Image Turbo, SDXL, SD 1.5, and a Custom tab."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "placeholder": "Write a brief, or click Forge to draft it…",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    FUNCTION = "run"
    CATEGORY = "Prompt Forge"

    @classmethod
    def IS_CHANGED(cls, prompt, unique_id=None, **kwargs):
        return float("nan")

    def run(self, prompt, unique_id=None):
        try:
            unload_forge_models()
        except Exception as exc:
            log(f"backstop unload skipped: {exc}")
        return (str(prompt or ""),)


NODE_CLASS_MAPPINGS = {"PromptForge": PromptForge}
NODE_DISPLAY_NAME_MAPPINGS = {"PromptForge": "Prompt Forge"}