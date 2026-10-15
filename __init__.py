"""Universal Prompt Forge — standalone ComfyUI node."""
import os

from .nodes_prompt_forge import (
    NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS,
)
from . import prompt_forge  # noqa: F401 — registers /forge/* routes

WEB_DIRECTORY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]