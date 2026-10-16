"""Tests for scripts/check_ci_negations.py.

Run: python -m unittest discover -s scripts/tests
"""

import importlib.util
import pathlib
import textwrap
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]

_spec = importlib.util.spec_from_file_location("check_ci_negations", ROOT / "scripts" / "check_ci_negations.py")
check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check)


def workflow(steps):
    """A one-job workflow whose steps are the given YAML, indented under `steps:`."""
    return "on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n" + textwrap.indent(
        textwrap.dedent(steps), "      "
    )


class FindBareNegations(unittest.TestCase):
    def test_flags_a_bare_negation_before_the_last_line(self):
        text = workflow("""\
            - name: No secrets ship
              run: |
                ! grep -q secret out.txt
                echo done
            """)
        [finding] = check.find_bare_negations(text)
        self.assertEqual(finding.job, "build")
        self.assertEqual(finding.step, "No secrets ship")
        self.assertEqual(finding.line, 8)
        self.assertEqual(finding.text, "! grep -q secret out.txt")

    def test_passes_a_negation_on_the_last_line(self):
        text = workflow("""\
            - run: |
                grep -q present out.txt
                ! grep -q secret out.txt
            """)
        self.assertEqual(check.find_bare_negations(text), [])

    def test_passes_a_negation_in_an_if_condition(self):
        text = workflow("""\
            - run: |
                if ! grep -q present out.txt; then exit 1; fi
                while ! test -e ready; do sleep 1; done
                echo done
            """)
        self.assertEqual(check.find_bare_negations(text), [])

    def test_passes_a_negation_followed_by_or(self):
        text = workflow("""\
            - run: |
                ! grep -q secret out.txt || { echo "secret shipped" >&2; exit 1; }
                echo done
            """)
        self.assertEqual(check.find_bare_negations(text), [])

    def test_trailing_blank_and_comment_lines_do_not_count_as_the_last_line(self):
        text = workflow("""\
            - run: |
                grep -q present out.txt
                ! grep -q secret out.txt

                # nothing after this
            """)
        self.assertEqual(check.find_bare_negations(text), [])

    def test_a_continued_negation_is_one_line_reported_where_it_starts(self):
        text = workflow("""\
            - run: |
                echo start
                ! grep -q secret \\
                  out.txt
                echo done
            """)
        [finding] = check.find_bare_negations(text)
        self.assertEqual(finding.line, 8)
        self.assertEqual(finding.text, "! grep -q secret out.txt")

    def test_a_continued_last_line_is_still_the_last_line(self):
        text = workflow("""\
            - run: |
                echo start
                ! grep -q secret \\
                  out.txt
            """)
        self.assertEqual(check.find_bare_negations(text), [])

    def test_steps_without_run_are_ignored(self):
        text = workflow("""\
            - uses: actions/checkout@v4
            - name: Unnamed one follows
              uses: actions/setup-python@v5
              with:
                python-version: "3.14"
            """)
        self.assertEqual(check.find_bare_negations(text), [])

    def test_an_unnamed_step_is_named_by_its_index_and_first_line(self):
        text = workflow("""\
            - uses: actions/checkout@v4
            - run: |
                ! grep -q secret out.txt
                echo done
            """)
        [finding] = check.find_bare_negations(text)
        self.assertEqual(finding.step, "step 2 (! grep -q secret out.txt)")

    def test_message_names_file_job_step_line_and_the_fix(self):
        msg = check.message("ci.yml", check.Finding("build", "No secrets ship", 8, "! grep -q secret out.txt", True))
        for part in ("ci.yml:8", "build", "No secrets ship", "! grep -q secret out.txt", "if grep", "exit 1; fi"):
            self.assertIn(part, msg)

    def test_a_folded_script_reports_the_line_within_the_script(self):
        # Folding turns each blank line into the newline, so bash sees 3 lines.
        text = workflow("""\
            - name: Folded
              run: >-
                echo start

                ! grep -q secret out.txt

                echo done
            """)
        [finding] = check.find_bare_negations(text)
        self.assertEqual((finding.line, finding.in_file), (2, False))
        self.assertIn("script line 2", check.message("ci.yml", finding))


if __name__ == "__main__":
    unittest.main()
