"""Tests for hooks/post_gen_project.py that need no generation.

The hook is itself a cookiecutter template (its constants are `{{ ... }}`
strings until generation), but it is valid Python as it stands, so the pure
functions in it can be imported and exercised here.

Run: python -m unittest discover -s hooks/tests
"""

import importlib.util
import json
import os
import pathlib
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
TEMPLATE = ROOT / "{{cookiecutter.project_slug}}"

_spec = importlib.util.spec_from_file_location("post_gen_project", ROOT / "hooks" / "post_gen_project.py")
hook = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hook)


def entry(version, **extra):
    """A lockfile `packages` entry in the order npm writes the common keys."""
    out = {
        "version": version,
        "resolved": f"https://registry.npmjs.org/x/-/x-{version}.tgz",
        "integrity": "sha512-x",
    }
    out.update(extra)
    return out


def fixture_lock():
    """A tiny lockfile in which `ph` (the dependency to drop) shares some of its
    tree with the rest of the project and owns the rest outright."""
    return {
        "name": "app",
        "version": "0.1.0",
        "lockfileVersion": 3,
        "requires": True,
        "packages": {
            "": {
                "name": "app",
                "version": "0.1.0",
                "dependencies": {"keep": "^1.0.0", "ph": "^1.0.0"},
                "devDependencies": {"devtool": "^1.0.0"},
            },
            "node_modules/@ph/core": entry("1.0.0", license="MIT"),
            # Also needed by `keep`: survives.
            "node_modules/shared": entry("1.0.0", license="MIT"),
            # Root-level copy belongs to `keep`; `ph`'s own nested copy goes.
            "node_modules/conflict": entry("2.0.0", license="MIT"),
            # Needed by `ph` (prod) and by `devtool`: survives, but is dev-only afterwards.
            "node_modules/dev-shared": entry("1.0.0", license="MIT"),
            "node_modules/devtool": entry("1.0.0", dev=True, license="MIT", dependencies={"dev-shared": "^1.0.0"}),
            "node_modules/keep": entry("1.0.0", license="MIT", dependencies={"conflict": "^2.0.0", "shared": "^1.0.0"}),
            "node_modules/only-ph": entry("1.0.0", license="MIT", dependencies={"deep-only": "^1.0.0"}),
            "node_modules/deep-only": entry("1.0.0", license="MIT"),
            "node_modules/opt-thing": entry("1.0.0", license="MIT", optional=True),
            "node_modules/ph": entry(
                "1.0.0",
                license="MIT",
                dependencies={
                    "@ph/core": "^1.0.0",
                    "conflict": "^1.0.0",
                    "dev-shared": "^1.0.0",
                    "only-ph": "^1.0.0",
                    "shared": "^1.0.0",
                },
                optionalDependencies={"opt-thing": "^1.0.0"},
            ),
            "node_modules/ph/node_modules/conflict": entry("1.0.0", license="MIT", dependencies={"deep-only": "^1.0.0"}),
        },
    }


class PruneLockfileTests(unittest.TestCase):
    def setUp(self):
        self.pruned = hook.drop_npm_dependency_from_lock(fixture_lock(), "ph")
        self.packages = self.pruned["packages"]

    def test_root_no_longer_depends_on_it(self):
        self.assertEqual(self.packages[""]["dependencies"], {"keep": "^1.0.0"})

    def test_exclusive_packages_are_removed(self):
        for path in ("node_modules/ph", "node_modules/@ph/core", "node_modules/only-ph",
                     "node_modules/deep-only", "node_modules/opt-thing"):
            self.assertNotIn(path, self.packages)

    def test_nested_copy_is_removed_and_root_copy_kept(self):
        self.assertNotIn("node_modules/ph/node_modules/conflict", self.packages)
        self.assertEqual(self.packages["node_modules/conflict"]["version"], "2.0.0")

    def test_shared_packages_survive_unchanged(self):
        self.assertEqual(self.packages["node_modules/shared"], fixture_lock()["packages"]["node_modules/shared"])
        self.assertIn("node_modules/keep", self.packages)

    def test_a_package_left_only_to_dev_becomes_dev(self):
        self.assertTrue(self.packages["node_modules/dev-shared"].get("dev"))
        # Inserted where npm sorts it, ahead of "license".
        self.assertEqual(list(self.packages["node_modules/dev-shared"]),
                         ["version", "resolved", "integrity", "dev", "license"])

    def test_dropping_an_absent_dependency_changes_nothing(self):
        self.assertEqual(hook.drop_npm_dependency_from_lock(fixture_lock(), "absent"), fixture_lock())

    def test_nested_resolution_prefers_the_closest_copy(self):
        lock = fixture_lock()
        packages = lock["packages"]
        self.assertEqual(hook.resolve_lock_path(packages, "node_modules/ph", "conflict"),
                         "node_modules/ph/node_modules/conflict")
        self.assertEqual(hook.resolve_lock_path(packages, "node_modules/keep", "conflict"),
                         "node_modules/conflict")
        # Walks up out of a nested package to the root's copy.
        self.assertEqual(hook.resolve_lock_path(packages, "node_modules/ph/node_modules/conflict", "deep-only"),
                         "node_modules/deep-only")
        self.assertEqual(hook.resolve_lock_path(packages, "node_modules/@ph/core", "shared"),
                         "node_modules/shared")
        self.assertIsNone(hook.resolve_lock_path(packages, "", "missing"))


class TemplateLockTests(unittest.TestCase):
    """The template's own lockfile: what the hook computes must agree with what
    npm wrote, or pruning would rewrite packages it never meant to touch."""

    def test_flags_recomputed_on_the_template_lock_change_nothing(self):
        text = (TEMPLATE / "package-lock.json").read_text(encoding="utf-8")
        lock = json.loads(text)
        self.assertEqual(hook.dump_npm_json(hook.prune_lock(lock)), text)

    def test_json_is_written_the_way_npm_writes_it(self):
        for name in ("package.json", "package-lock.json"):
            text = (TEMPLATE / name).read_text(encoding="utf-8")
            self.assertEqual(hook.dump_npm_json(json.loads(text)), text, name)


class DropNpmDependencyTests(unittest.TestCase):
    def test_removes_from_package_json_and_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            pkg = {"name": "app", "dependencies": {"keep": "^1.0.0", "ph": "^1.0.0"}}
            with open(os.path.join(tmp, "package.json"), "w", encoding="utf-8") as f:
                f.write(hook.dump_npm_json(pkg))
            with open(os.path.join(tmp, "package-lock.json"), "w", encoding="utf-8") as f:
                f.write(hook.dump_npm_json(fixture_lock()))

            hook.drop_npm_dependency("ph", tmp)

            with open(os.path.join(tmp, "package.json"), encoding="utf-8") as f:
                text = f.read()
            self.assertEqual(json.loads(text)["dependencies"], {"keep": "^1.0.0"})
            self.assertTrue(text.endswith("}\n"))
            with open(os.path.join(tmp, "package-lock.json"), encoding="utf-8") as f:
                lock_text = f.read()
            self.assertNotIn('"ph"', lock_text)
            self.assertNotIn("node_modules/ph", lock_text)


if __name__ == "__main__":
    unittest.main()
