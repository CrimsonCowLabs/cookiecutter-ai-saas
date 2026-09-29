"""Tests for the auto-discovering tool registry.

The point of the registry is that adding a tool is one new file, so the tests
prove exactly that: a module written into a package is picked up with no other
change, and a broken one fails loudly instead of quietly shrinking the toolset.
"""

import importlib
import sys
import textwrap
from pathlib import Path

import pytest
from langchain_core.tools import BaseTool

import tools
from tools import ToolRegistryError, discover_tools

TOOL_MODULE = '''
    from langchain_core.tools import StructuredTool

    async def _run(text: str) -> str:
        """Echo text back."""
        return text

    TOOL = StructuredTool.from_function(coroutine=_run, name="{name}")
'''


@pytest.fixture
def tool_package(tmp_path, monkeypatch):
    """An importable throwaway package that `discover_tools` can be pointed at.

    Returns `add(filename, source)`, so a test can drop in a module file the way
    a developer would and nothing else.
    """
    package_name = f"fixture_tools_{abs(hash(tmp_path)) % 10**8}"
    package_dir = tmp_path / package_name
    package_dir.mkdir()
    (package_dir / "__init__.py").write_text("")
    monkeypatch.syspath_prepend(str(tmp_path))

    def add(filename: str, source: str) -> None:
        (package_dir / filename).write_text(textwrap.dedent(source).strip() + "\n")
        # New files on disk are invisible to an already-warm import cache.
        importlib.invalidate_caches()

    importlib.invalidate_caches()
    package = importlib.import_module(package_name)
    package.add = add
    yield package

    for name in [n for n in sys.modules if n == package_name or n.startswith(package_name + ".")]:
        del sys.modules[name]


# --------------------------------------------------------------------------
# The shipped package
# --------------------------------------------------------------------------


def test_the_shipped_fetch_tool_is_discovered():
    names = [tool.name for tool in discover_tools()]

    assert "fetch_url" in names


def test_every_discovered_tool_is_a_langchain_tool():
    found = discover_tools()

    assert found
    assert all(isinstance(tool, BaseTool) for tool in found)


def test_discovery_is_deterministic():
    assert [t.name for t in discover_tools()] == [t.name for t in discover_tools()]


def test_discovery_defaults_to_the_tools_package():
    assert discover_tools() == discover_tools(tools)


# --------------------------------------------------------------------------
# One new file is the whole change
# --------------------------------------------------------------------------


def test_a_single_new_file_adds_a_tool(tool_package):
    assert discover_tools(tool_package) == []

    tool_package.add("summarize.py", TOOL_MODULE.format(name="summarize"))

    assert [tool.name for tool in discover_tools(tool_package)] == ["summarize"]


def test_tools_are_ordered_by_module_name(tool_package):
    for filename, name in [("zeta.py", "zeta"), ("alpha.py", "alpha"), ("mid.py", "mid")]:
        tool_package.add(filename, TOOL_MODULE.format(name=name))

    assert [tool.name for tool in discover_tools(tool_package)] == ["alpha", "mid", "zeta"]


def test_modules_without_a_tool_are_plain_helpers(tool_package):
    tool_package.add("helpers.py", "CONSTANT = 1\n")
    tool_package.add("real.py", TOOL_MODULE.format(name="real"))

    assert [tool.name for tool in discover_tools(tool_package)] == ["real"]


def test_private_modules_are_not_visited(tool_package):
    tool_package.add("_draft.py", "raise RuntimeError('a private module must not be imported')\n")

    assert discover_tools(tool_package) == []


def test_subpackages_are_not_recursed_into(tool_package):
    nested = Path(tool_package.__path__[0]) / "nested"
    nested.mkdir()
    (nested / "__init__.py").write_text("")
    (nested / "deep.py").write_text(textwrap.dedent(TOOL_MODULE.format(name="deep")))
    importlib.invalidate_caches()

    assert discover_tools(tool_package) == []


# --------------------------------------------------------------------------
# Loud failure
# --------------------------------------------------------------------------


def test_a_module_that_fails_to_import_is_loud(tool_package):
    tool_package.add("broken.py", "import a_module_that_does_not_exist\n")

    with pytest.raises(ToolRegistryError) as exc_info:
        discover_tools(tool_package)

    message = str(exc_info.value)
    assert "broken" in message
    assert "failed to import" in message


def test_a_module_that_raises_at_import_time_is_loud(tool_package):
    tool_package.add("explodes.py", "raise ValueError('bad config')\n")

    with pytest.raises(ToolRegistryError, match="explodes"):
        discover_tools(tool_package)


@pytest.mark.parametrize("value", ["'not a tool'", "42", "lambda x: x", "None or object()"])
def test_a_tool_of_the_wrong_type_is_loud(tool_package, value):
    tool_package.add("wrong.py", f"TOOL = {value}\n")

    with pytest.raises(ToolRegistryError) as exc_info:
        discover_tools(tool_package)

    assert "wrong" in str(exc_info.value)
    assert "expected a langchain BaseTool" in str(exc_info.value)


def test_a_broken_module_is_never_silently_skipped(tool_package):
    """A quietly shrinking toolset is the failure mode this guards against."""
    tool_package.add("aaa_broken.py", "import nope_not_here\n")
    tool_package.add("zzz_fine.py", TOOL_MODULE.format(name="fine"))

    with pytest.raises(ToolRegistryError):
        discover_tools(tool_package)
