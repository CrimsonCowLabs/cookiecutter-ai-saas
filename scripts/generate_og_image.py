#!/usr/bin/env python3
"""Render site/og-image.svg to site/og-image.png (issue #36).

The PNG is what ships in the og:image / twitter:image tags; the SVG next to
it is the tracked source so the preview card can be regenerated rather than
hand-edited as an opaque binary. This script is a dev-time tool, not a page
dependency: nothing in site/ references it at serve time, and
scripts/check_site.py does not run it. See "Regenerating the preview image"
in docs/public-site.md.

It shells out to a headless Chromium/Chrome to rasterize the SVG, because
that is the one renderer guaranteed to agree with how the SVG's CSS (system
font stacks, in particular) actually looks in a browser. That is a one-time
local tool, not a runtime dependency of the page itself — nothing it
produces requires Chrome to be present again until the source changes.

Usage:
    python scripts/generate_og_image.py

Needs a Chrome/Chromium binary. If none of the usual install locations are
found, set CHROME_PATH, e.g.:

    CHROME_PATH=/path/to/chrome python scripts/generate_og_image.py

One way to get a throwaway Chrome for Testing binary with no system install:

    npx --yes @puppeteer/browsers install chrome@stable --path /tmp/chrome-for-og
    CHROME_PATH=$(find /tmp/chrome-for-og -name chrome -type f) \\
        python scripts/generate_og_image.py
"""

import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SVG = ROOT / "site" / "og-image.svg"
PNG = ROOT / "site" / "og-image.png"

# The standard Open Graph size. Duplicated, by necessity, in
# scripts/check_site.py's OG_IMAGE_WIDTH/OG_IMAGE_HEIGHT and in the literal
# og:image:width/og:image:height content in site/index.html — change all
# three together, or check_site.py will (correctly) start failing the moment
# this script is next run.
WIDTH = 1200
HEIGHT = 630

CANDIDATES = [
    "google-chrome-stable",
    "google-chrome",
    "chromium",
    "chromium-browser",
    "chrome",
]


def find_chrome():
    env = os.environ.get("CHROME_PATH")
    if env:
        return env
    for name in CANDIDATES:
        path = shutil.which(name)
        if path:
            return path
    return None


def main():
    if not SVG.is_file():
        print(f"no such file: {SVG}", file=sys.stderr)
        return 1

    chrome = find_chrome()
    if not chrome:
        print(
            "no Chrome/Chromium binary found on PATH and CHROME_PATH is unset.\n"
            "See the module docstring for a one-off way to get one.",
            file=sys.stderr,
        )
        return 1

    # A thin HTML wrapper rather than screenshotting the SVG file directly: it
    # pins the SVG to exactly WIDTH x HEIGHT with no page margin, so the
    # screenshot has no border or scrollbar to crop out afterwards.
    html = (
        "<!doctype html><html><head><meta charset='utf-8'/>"
        f"<style>html,body{{margin:0;padding:0;background:#100d0c;}}"
        f"svg{{display:block;width:{WIDTH}px;height:{HEIGHT}px;}}</style></head>"
        f"<body>{SVG.read_text()}</body></html>"
    )

    with tempfile.TemporaryDirectory() as tmp:
        html_path = pathlib.Path(tmp) / "og-image.html"
        html_path.write_text(html)

        cmd = [
            chrome,
            "--headless=new",
            "--disable-gpu",
            # This tool runs on a throwaway local or CI sandbox to produce a
            # static asset, never as a long-lived process serving anything,
            # so the usual reason to keep Chrome's own sandbox (an attacker
            # reaching untrusted web content through it) does not apply —
            # and plenty of container/CI setups cannot grant it anyway.
            "--no-sandbox",
            "--hide-scrollbars",
            "--force-color-profile=srgb",
            f"--window-size={WIDTH},{HEIGHT}",
            f"--screenshot={PNG}",
            "--default-background-color=00000000",
            html_path.as_uri(),
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            print(result.stdout, file=sys.stderr)
            print(result.stderr, file=sys.stderr)
            return 1

    print(f"wrote {PNG}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
