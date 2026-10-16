#!/usr/bin/env python3
"""Check no workflow step has a bare negated command before its last line.

Actions runs `run:` scripts with `bash -e`, which does not stop on a negated
command (`! cmd`) that fails, so such a line checks nothing unless it is the
script's last line (whose status is the step's). A negation inside an `if`/
`while` condition or followed by `|| ...` is fine. Fails naming the workflow,
job, step and line of each bare negation.

Usage: python scripts/check_ci_negations.py   (needs PyYAML)
"""

import collections
import pathlib
import sys

import yaml

ROOT = pathlib.Path(__file__).resolve().parent.parent
WORKFLOWS = ROOT / ".github" / "workflows"

# `line` is 1-based in the workflow file when `in_file`, else within the script.
Finding = collections.namedtuple("Finding", "job step line text in_file")


def logical_lines(script):
    """(index of first physical line, joined text) per effective line of a script.

    Blank lines and full-line comments are dropped; backslash continuations are
    joined into the line they continue.
    """
    out, pending = [], None
    for i, raw in enumerate(script.splitlines()):
        line = raw.strip()
        if pending is None and (not line or line.startswith("#")):
            continue
        start, text = pending or (i, "")
        body = line.removesuffix("\\")
        pending = (start, f"{text} {body}".strip())
        if not line.endswith("\\"):
            out.append(pending)
            pending = None
    if pending is not None:
        out.append(pending)
    return out


def is_bare_negation(line):
    return line[:1] == "!" and line[1:2].isspace() and "||" not in line


def find_bare_negations(text):
    """Findings for every bare negation that is not its step's last line.

    A literal (`|`) script maps line for line onto the file; for any other
    multi-line style the line is reported within the script.
    """
    findings = []
    jobs = dict_of(dict_of(yaml.compose(text)).get("jobs"))
    for job, node in jobs.items():
        steps = dict_of(node).get("steps")
        for index, step_node in enumerate(steps.value if isinstance(steps, yaml.SequenceNode) else [], 1):
            step = dict_of(step_node)
            run = step.get("run")
            if not isinstance(run, yaml.ScalarNode):
                continue
            lines = logical_lines(run.value)
            name = step["name"].value if "name" in step else f"step {index} ({lines[0][1] if lines else ''})"
            literal = run.style == "|"
            first = run.start_mark.line + 2 if literal else 1
            for i, line in lines[:-1]:
                if is_bare_negation(line):
                    findings.append(Finding(job, name, first + i, line, literal))
    return findings


def dict_of(node):
    """A mapping node as {key: value node}; anything else as {}."""
    if not isinstance(node, yaml.MappingNode):
        return {}
    return {k.value: v for k, v in node.value}


def message(path, f):
    where = f"{path}:{f.line}" if f.in_file else f"{path} (script line {f.line})"
    return (f"{where}: job {f.job}, step \"{f.step}\": `{f.text}` can never fail the step "
            "(bash -e ignores a failing negated command). Write "
            f"`if {f.text[1:].strip()}; then echo \"...\" >&2; exit 1; fi` instead.")


def main():
    failed = False
    paths = sorted(WORKFLOWS.glob("*.yml"))
    for path in paths:
        for f in find_bare_negations(path.read_text()):
            print(message(path.relative_to(ROOT), f))
            failed = True
    print(f"{len(paths)} workflows; bare negations before a step's last line: {'FOUND' if failed else 'none'}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
