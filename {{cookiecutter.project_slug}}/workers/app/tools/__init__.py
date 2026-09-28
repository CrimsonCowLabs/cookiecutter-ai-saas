"""Tool registry for __PROJECT_NAME__.

Adding a tool to the agent is **one new file**:

1. Create `tools/my_tool.py`.
2. Define the work as a function (async is fine).
3. Expose it as a module-level `TOOL`:

   ```python
   from langchain_core.tools import StructuredTool

   async def _summarize(text: str) -> str:
       '''Summarize text. The model reads this docstring, so be specific.'''
       ...

   TOOL = StructuredTool.from_function(coroutine=_summarize, name="summarize")
   ```

Nothing else changes: `discover_tools()` walks this package, and the pipeline's
AI step passes whatever it finds to the agent. See `tools/fetch_url.py` for a
worked example.

Rules discovery follows:

- Modules are visited in sorted order, so the tool list — and therefore the
  prompt — is reproducible.
- A module with no `TOOL` is a plain helper module and is skipped.
- Private modules (leading underscore) and subpackages are not visited.
- A module that fails to import, or whose `TOOL` is not a `BaseTool`, raises
  `ToolRegistryError` naming the module. A broken tool is never skipped
  silently: that would mean an agent quietly running with fewer tools.
"""

from __future__ import annotations

import importlib
import pkgutil
import sys
from types import ModuleType

from langchain_core.tools import BaseTool

__all__ = ["ToolRegistryError", "discover_tools"]


class ToolRegistryError(Exception):
    """A module in the tools package could not contribute its `TOOL`."""


def discover_tools(package: ModuleType | None = None) -> list[BaseTool]:
    """Collect every `TOOL` defined in `package` (this package by default).

    Args:
        package: Package to scan. Defaults to `tools`; tests pass a fixture
            package.

    Returns:
        The tools, ordered by module name.

    Raises:
        ToolRegistryError: a module failed to import, or exposed a `TOOL` that
            is not a `BaseTool`.
    """
    package = package or sys.modules[__name__]
    tools: list[BaseTool] = []

    for info in sorted(pkgutil.iter_modules(package.__path__), key=lambda i: i.name):
        if info.ispkg or info.name.startswith("_"):
            continue

        module_name = f"{package.__name__}.{info.name}"
        try:
            module = importlib.import_module(module_name)
        except Exception as exc:
            raise ToolRegistryError(f"tool module {module_name!r} failed to import: {exc}") from exc

        tool = getattr(module, "TOOL", None)
        if tool is None:
            continue
        if not isinstance(tool, BaseTool):
            raise ToolRegistryError(
                f"tool module {module_name!r} exposes TOOL of type "
                f"{type(tool).__name__}; expected a langchain BaseTool"
            )
        tools.append(tool)

    return tools
