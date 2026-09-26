#!/usr/bin/env python3
"""Check the CI flag matrix covers every choice value in cookiecutter.json.

Choice variables are the list-valued entries in cookiecutter.json. The matrix
is the `include:` list of the `flag-matrix` job in the CI workflow. Fails if any
value of any choice is never exercised. Also prints pairwise coverage (informational).

Usage: python scripts/check_ci_matrix.py   (needs PyYAML)
"""

import itertools
import json
import pathlib
import sys

import yaml

ROOT = pathlib.Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github" / "workflows" / "generate-and-build.yml"
JOB = "flag-matrix"


def main():
    choices = {
        k: v for k, v in json.loads((ROOT / "cookiecutter.json").read_text()).items()
        if isinstance(v, list) and not k.startswith("_")
    }
    rows = yaml.safe_load(WORKFLOW.read_text())["jobs"][JOB]["strategy"]["matrix"]["include"]
    failed = False

    names = [r.get("name") for r in rows]
    if len(set(names)) != len(names) or not all(names):
        print("Every matrix entry needs a unique name")
        failed = True

    for row in rows:
        for key, value in row.items():
            if key != "name" and (key not in choices or value not in choices[key]):
                print(f"{row.get('name')}: {key}={value} is not a valid choice")
                failed = True

    for key, values in choices.items():
        missing = [v for v in values if not any(r.get(key) == v for r in rows)]
        if missing:
            print(f"Uncovered values for {key}: {missing}")
            failed = True

    pairs = {
        ((a, x), (b, y))
        for a, b in itertools.combinations(choices, 2)
        for x in choices[a] for y in choices[b]
    }
    seen = {
        ((a, r.get(a)), (b, r.get(b)))
        for r in rows for a, b in itertools.combinations(choices, 2)
    }
    print(f"{len(rows)} combinations; every value covered: {'NO' if failed else 'yes'}; "
          f"pairs covered: {len(pairs & seen)}/{len(pairs)}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
