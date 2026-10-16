#!/usr/bin/env python3
"""Check no workflow step has a bare negated command before its last line.

Actions runs `run:` scripts with `bash -e`, which does not stop on a negated
command (`! cmd`) that fails, so such a line checks nothing unless it is the
script's last line (whose status is the step's). That holds whether the `!`
starts the line or a command after `&&` or `;` on it. A negation inside an
`if`/`elif`/`while`/`until` condition, followed by `|| ...` or ending a `case`
branch (`;;`) is fine. Fails naming the workflow, job, step and line of each
bare negation.

Usage: python scripts/check_ci_negations.py   (needs PyYAML)
"""

import collections
import pathlib
import re
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


# `!` plus whitespace starting the line or a command after `&&` or `;`.
NEGATION = re.compile(r"(?:^|&&|;)\s*!\s+(\S.*)")
CONDITION = re.compile(r"(?:if|elif|while|until)\s")


def negated_command(line):
    """The command a bare negation on this line negates, else None.

    Lines that start an `if`/`elif`/`while`/`until` condition, contain `||`
    or end a `case` branch with `;;` (whose last status is the branch's) are
    exempt.
    """
    if "||" in line or CONDITION.match(line) or line.endswith(";;"):
        return None
    match = NEGATION.search(line)
    return match.group(1) if match else None


def is_bare_negation(line):
    return negated_command(line) is not None


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
    cmd = negated_command(f.text)
    where = f"{path}:{f.line}" if f.in_file else f"{path} (script line {f.line})"
    return (f"{where}: job {f.job}, step \"{f.step}\": `{f.text}` can never fail the step "
            f"(bash -e ignores a failing negated command). Rewrite `! {cmd}` as "
            f"`if {cmd}; then echo \"...\" >&2; exit 1; fi`.")


def workflow_paths(directory=WORKFLOWS):
    """Every `.yml` and `.yaml` workflow in the directory, sorted."""
    return sorted([*directory.glob("*.yml"), *directory.glob("*.yaml")])


def main():
    failed = False
    paths = workflow_paths()
    for path in paths:
        for f in find_bare_negations(path.read_text()):
            print(message(path.relative_to(ROOT), f))
            failed = True
    print(f"{len(paths)} workflows; bare negations before a step's last line: {'FOUND' if failed else 'none'}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
