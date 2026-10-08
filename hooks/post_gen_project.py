#!/usr/bin/env python3
"""Post-generation hook for cookiecutter template.

Runs after the project is generated to:
- Replace __PLACEHOLDER__ strings in files that skip Jinja2 rendering (.ts/.tsx,
  the Ansible tree) or that carry a value derived here (the deploy account)
- Remove optional features based on cookiecutter choices
"""

import copy
import json
import os
import re
import shutil

# Cookiecutter variables (resolved at generation time)
PROJECT_NAME = "{{ cookiecutter.project_name }}"
PROJECT_SLUG = "{{ cookiecutter.project_slug }}"
PROJECT_DESCRIPTION = "{{ cookiecutter.project_description }}"
DOMAIN_NAME = "{{ cookiecutter.domain_name }}"
PRIMARY_COLOR = "{{ cookiecutter.primary_color }}"
AUTHOR_NAME = "{{ cookiecutter.author_name }}"
AUTHOR_EMAIL = "{{ cookiecutter.author_email }}"
INCLUDE_STRIPE = "{{ cookiecutter.include_stripe }}"
INCLUDE_MARKETING_EXTRAS = "{{ cookiecutter.include_marketing_extras }}"
AUTH_PROVIDERS = "{{ cookiecutter.auth_providers }}"
INCLUDE_MAGIC_LINK = "{{ cookiecutter.include_magic_link }}"
DAISYUI_THEME = "{{ cookiecutter.daisyui_theme }}"
LLM_PROVIDER = "{{ cookiecutter.llm_provider }}"
PYTHON_VERSION = "{{ cookiecutter.python_version }}"
ANALYTICS = "{{ cookiecutter.analytics }}"
# Python floor that workers/app/pyproject.toml and poetry.lock ship with (the
# cookiecutter.json default). Keep in sync with both.
LOCKED_PYTHON_VERSION = "3.14"

def linux_username(name, fallback="deploy"):
    """Turn a person's name into a Linux account name.

    `useradd` accepts `[a-z_][a-z0-9_-]*` up to 32 characters, so a name like
    "O'Brien Smith" has to lose more than its spaces. provision.yml creates the
    account and deploy.yml logs in as it, both reading it out of
    ansible/group_vars/all.yml, so whatever this returns is the one name in
    play — the alternative is a playbook that creates an account the deploy
    never logs in as.
    """
    cleaned = "".join(c for c in name.lower() if c.isascii() and (c.isalnum() or c in "_-"))
    cleaned = cleaned.lstrip("0123456789-")[:32]
    return cleaned or fallback


def daisyui_themes_list(chosen):
    """DaisyUI 5 `themes:` value: chosen theme is default; light and dark stay
    available, with dark as the prefers-color-scheme theme. No name is listed twice."""
    if chosen == "dark":
        return "dark --default --prefersdark, light"
    if chosen == "light":
        return "light --default, dark --prefersdark"
    return f"{chosen} --default, light, dark --prefersdark"


DAISYUI_THEMES = daisyui_themes_list(DAISYUI_THEME)
DEPLOY_USER = linux_username(AUTHOR_NAME)

# Placeholder → actual value mapping
REPLACEMENTS = {
    "__PROJECT_NAME__": PROJECT_NAME,
    "__PROJECT_SLUG__": PROJECT_SLUG,
    "__PROJECT_DESCRIPTION__": PROJECT_DESCRIPTION,
    "__DOMAIN_NAME__": DOMAIN_NAME,
    "__PRIMARY_COLOR__": PRIMARY_COLOR,
    "__DAISYUI_THEME__": DAISYUI_THEME,
    "__DAISYUI_THEMES__": DAISYUI_THEMES,
    "__AUTHOR_NAME__": AUTHOR_NAME,
    "__AUTHOR_EMAIL__": AUTHOR_EMAIL,
    # The Linux account provision.yml creates and deploy.yml logs in as.
    "__DEPLOY_USER__": DEPLOY_USER,
    # The model provider .env-production is rendered with. The Ansible tree
    # skips Jinja rendering, so the answer has to arrive as a placeholder.
    "__LLM_PROVIDER__": LLM_PROVIDER,
}

# File extensions to process for placeholder replacement. .sh, .yml, .ini, .j2,
# .example and .md are here for the Ansible tree and the README, which name the
# deploy account, the domain and the model provider; the Ansible files
# additionally skip Jinja rendering (see _copy_without_render), which is what
# keeps their own Jinja — Ansible's, not cookiecutter's — intact through
# generation, and is why they take values as placeholders at all.
EXTENSIONS = {
    ".ts",
    ".tsx",
    ".mjs",
    ".js",
    ".py",
    ".json",
    ".css",
    ".toml",
    ".sh",
    ".yml",
    ".ini",
    ".j2",
    ".example",
    ".md",
}


def replace_placeholders_in_file(filepath):
    """Replace all __PLACEHOLDER__ strings in a single file."""
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()
    except (UnicodeDecodeError, IOError):
        return

    original = content
    for placeholder, value in REPLACEMENTS.items():
        content = content.replace(placeholder, value)

    if content != original:
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(content)
        print(f"  Updated: {filepath}")


def process_all_files():
    """Walk through all files and replace placeholders in supported extensions."""
    print("Replacing placeholders...")
    for root, _dirs, files in os.walk("."):
        # Skip node_modules and .next
        if "node_modules" in root or ".next" in root:
            continue
        for filename in files:
            _, ext = os.path.splitext(filename)
            if ext in EXTENSIONS:
                filepath = os.path.join(root, filename)
                replace_placeholders_in_file(filepath)


def apply_python_version():
    """Apply a non-default python_version to the worker's Poetry project.

    poetry.lock is resolved for LOCKED_PYTHON_VERSION and its content-hash covers the
    `python` constraint, so changing the floor makes the shipped lock stale. In that
    case drop the lock rather than ship one that fails `poetry install`; the user
    must run `poetry lock` once (Dockerfile.worker is frozen and will fail until then).
    """
    if PYTHON_VERSION == LOCKED_PYTHON_VERSION:
        return
    pyproject = "workers/app/pyproject.toml"
    old = f'python = ">={LOCKED_PYTHON_VERSION},<4"'
    with open(pyproject, "r", encoding="utf-8") as f:
        content = f.read()
    with open(pyproject, "w", encoding="utf-8") as f:
        f.write(content.replace(old, f'python = ">={PYTHON_VERSION},<4"'))
    remove_file("workers/app/poetry.lock")
    print(f"  NOTE: python_version={PYTHON_VERSION} differs from the locked {LOCKED_PYTHON_VERSION};")
    print("        run `cd workers/app && poetry lock` and commit workers/app/poetry.lock.")


def remove_directory(path):
    """Remove a directory if it exists."""
    if os.path.exists(path):
        shutil.rmtree(path)
        print(f"  Removed: {path}")


def remove_file(path):
    """Remove a file if it exists."""
    if os.path.exists(path):
        os.remove(path)
        print(f"  Removed: {path}")


def handle_stripe():
    """Remove Stripe-related files if not included."""
    if INCLUDE_STRIPE == "no":
        print("Removing Stripe files...")
        remove_file("lib/stripe.ts")
        # lib/plans.ts stays: app/actions/jobs.ts reads plan limits to rate
        # limit job submission, which has nothing to do with billing.
        remove_directory("app/api/webhook/stripe")
        remove_directory("app/(main)/dashboard/settings")
        remove_file("app/actions/billing.ts")
        # Imports app/actions/billing.ts; the cc:begin/cc:end stripe markers in
        # dashboard/layout.tsx strip the reference to it, but the file itself
        # would otherwise survive as an orphan that still fails `tsc` (it's
        # covered by tsconfig's **/*.tsx include regardless of whether
        # anything imports it).
        remove_file("components/dashboard/resume-pending-plan.tsx")
        # Automatic-renewal terms: a project without billing sells no
        # subscriptions, so it makes no claims about them either.
        remove_file("lib/renewal-terms.ts")
        remove_directory("components/billing")
        remove_directory("app/(main)/legal/subscriptions")
        remove_file("tests/compliance/renewal-terms.test.mjs")
        remove_file("tests/compliance/fake-stripe.mjs")
        remove_file("lib/subscription-acknowledgment.ts")
        remove_file("tests/compliance/subscription-acknowledgment.test.mjs")


def sends_email():
    """Whether anything in the project sends email, and so ships Resend:
    magic link, the contact form or the subscription acknowledgment."""
    return INCLUDE_MAGIC_LINK == "yes" or INCLUDE_MARKETING_EXTRAS == "yes" or INCLUDE_STRIPE == "yes"


def handle_resend():
    """Remove marketing email and unsubscribing if nothing sends email."""
    if not sends_email():
        print("Removing marketing email files...")
        # The email_suppressions table and the middleware's public paths for
        # these go with the "resend" markers.
        remove_file("lib/marketing-email.ts")
        remove_file("lib/unsubscribe.ts")
        remove_directory("app/(main)/unsubscribe")
        remove_directory("app/api/unsubscribe")
        remove_directory("app/(main)/legal/email-preferences")
        remove_file("tests/compliance/marketing-email.test.mjs")
        remove_file("tests/compliance/unsubscribe.test.mjs")
        remove_file("tests/compliance/fake-resend.mjs")


def dump_npm_json(data):
    """Serialise the way npm writes package.json and package-lock.json: two
    spaces, non-ASCII left as is, a trailing newline."""
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"


def resolve_lock_path(packages, from_path, name):
    """The `packages` key a dependency `name` of the package at `from_path`
    resolves to, by node's lookup: its own node_modules first, then each
    enclosing one up to the root's. None if no copy is installed."""
    base = from_path
    while True:
        candidate = f"{base}/node_modules/{name}" if base else f"node_modules/{name}"
        if candidate in packages:
            return candidate
        if not base:
            return None
        cut = base.rfind("/node_modules/")
        base = base[:cut] if cut >= 0 else ""


def _lock_edges(packages, path, is_root):
    """(target path, dev?, optional?) for each installed dependency of `path`."""
    meta = packages[path]
    kinds = {}
    # Later kinds win, so a name listed in two places takes npm's precedence:
    # optional over prod, prod over peer.
    peer_meta = meta.get("peerDependenciesMeta", {})
    for name in meta.get("peerDependencies", {}):
        kinds[name] = (False, peer_meta.get(name, {}).get("optional", False))
    for name in meta.get("dependencies", {}):
        kinds[name] = (False, False)
    for name in meta.get("optionalDependencies", {}):
        kinds[name] = (False, True)
    if is_root:
        for name in meta.get("devDependencies", {}):
            kinds.setdefault(name, (True, False))
    edges = []
    for name, (dev, optional) in kinds.items():
        target = resolve_lock_path(packages, path, name)
        if target is not None:
            if packages[target].get("link") and "resolved" in packages[target]:
                target = packages[target]["resolved"]
            if target in packages:
                edges.append((target, dev, optional))
    return edges


def _reachable(packages, follow):
    """Paths reachable from the root along the edges `follow(dev, optional)` admits."""
    seen, stack = {""}, [""]
    while stack:
        path = stack.pop()
        for target, dev, optional in _lock_edges(packages, path, path == ""):
            if target not in seen and follow(dev, optional):
                seen.add(target)
                stack.append(target)
    return seen


def _set_lock_flag(meta, key, wanted):
    """Add or drop a boolean flag on a lockfile entry, placing a new one where
    npm would: in the alphabetical run of keys that follows version, resolved
    and integrity."""
    if not wanted:
        meta.pop(key, None)
        return
    if key in meta:
        return
    keys = list(meta)
    start = 0
    while start < len(keys) and keys[start] in ("name", "version", "resolved", "integrity", "link"):
        start += 1
    i = start
    while i < len(keys) and keys[i] < key and (i == start or keys[i] >= keys[i - 1]):
        i += 1
    items = list(meta.items())
    items.insert(i, (key, True))
    meta.clear()
    meta.update(items)


def prune_lock(lock):
    """Drop every package the root no longer reaches and recompute the dev,
    optional and devOptional flags of the rest, as npm's calc-dep-flags does.
    Mutates and returns `lock`."""
    packages = lock["packages"]
    everything = _reachable(packages, lambda dev, optional: True)
    for path in [p for p in packages if p not in everything]:
        del packages[path]
    not_dev = _reachable(packages, lambda dev, optional: not dev)
    not_optional = _reachable(packages, lambda dev, optional: not optional)
    required = _reachable(packages, lambda dev, optional: not dev and not optional)
    for path, meta in packages.items():
        if path == "":
            continue
        dev = path not in not_dev
        optional = path not in not_optional
        _set_lock_flag(meta, "dev", dev)
        _set_lock_flag(meta, "optional", optional)
        _set_lock_flag(meta, "devOptional", path not in required and not dev and not optional)
    return lock


def remove_dependency_entry(manifest, name):
    """Delete `name` from every dependency field of a package.json, or of a
    lock's root entry, dropping a field it leaves empty the way npm does."""
    for field in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
        if name in manifest.get(field, {}):
            del manifest[field][name]
            if not manifest[field]:
                del manifest[field]


def drop_npm_dependency_from_lock(lock, name):
    """A copy of `lock` without the root's dependency on `name` and without
    every package only it needed."""
    lock = copy.deepcopy(lock)
    remove_dependency_entry(lock["packages"][""], name)
    return prune_lock(lock)


def drop_npm_dependency(name, directory="."):
    """Remove `name` from package.json and prune package-lock.json to match,
    so `npm ci` still installs exactly the locked tree, minus that package."""
    pkg_path = os.path.join(directory, "package.json")
    lock_path = os.path.join(directory, "package-lock.json")
    with open(pkg_path, "r", encoding="utf-8") as f:
        pkg = json.load(f)
    remove_dependency_entry(pkg, name)
    with open(pkg_path, "w", encoding="utf-8") as f:
        f.write(dump_npm_json(pkg))
    with open(lock_path, "r", encoding="utf-8") as f:
        lock = json.load(f)
    with open(lock_path, "w", encoding="utf-8") as f:
        f.write(dump_npm_json(drop_npm_dependency_from_lock(lock, name)))
    print(f"  Removed npm dependency: {name}")


def handle_analytics():
    """Remove the consent banner, consent module, analytics loader, proxy and
    their tests, and the posthog-js dependency, if analytics is not included."""
    if ANALYTICS == "none":
        print("Removing analytics files...")
        # The /legal/analytics page stays and says nothing is tracked; its
        # PostHog wording, the footer's "Privacy choices" link and the
        # middleware's /ingest prefix go with the "analytics" markers.
        remove_file("lib/consent.ts")
        remove_file("lib/analytics.ts")
        remove_directory("components/consent")
        remove_directory("app/ingest")
        remove_file("tests/compliance/analytics-consent.test.mjs")
        remove_file("tests/compliance/fake-posthog.mjs")
        drop_npm_dependency("posthog-js")


def handle_magic_link():
    """Remove the email sign-in page and form if magic link is not included."""
    if INCLUDE_MAGIC_LINK == "no":
        print("Removing magic link files...")
        remove_directory("app/(main)/(auth)/magic-link")
        remove_file("components/auth/magic-link-form.tsx")


def handle_marketing_extras():
    """Remove the blog and the contact form if marketing extras are not included."""
    if INCLUDE_MARKETING_EXTRAS == "no":
        print("Removing blog and contact form files...")
        remove_directory("app/(main)/blog")
        remove_directory("components/blog")
        remove_directory("app/(main)/contact")
        remove_directory("app/api/contact")
        remove_file("app/actions/contact.ts")
        remove_file("components/ContactForm.tsx")


# Which marker names each auth_providers choice keeps.
AUTH_PROVIDER_MARKERS = {
    "google_only": {"google"},
    "microsoft_only": {"microsoft"},
    "google_microsoft": {"google", "microsoft"},
}

# Files that may carry cc: markers. .j2 and ansible/vault.yml.example are the
# production env file and the secrets it is rendered from: which keys either
# one carries follows the same answers the app's own code does.
MARKER_EXTENSIONS = {".ts", ".tsx", ".mjs", ".js", ".css", ".py", ".toml", ".j2"}
MARKER_FILENAMES = {".env.example", "vault.yml.example"}


def marker_decisions():
    """marker name -> keep it?

    Conditional content lives in the .ts/.tsx/.env files as
    `cc:begin <name>` .. `cc:end <name>` regions. Those files skip Jinja
    rendering (see _copy_without_render), so the choice is applied here.
    """
    oauth = AUTH_PROVIDER_MARKERS.get(AUTH_PROVIDERS, {"google", "microsoft"})
    google = "google" in oauth
    microsoft = "microsoft" in oauth
    extras = INCLUDE_MARKETING_EXTRAS == "yes"
    stripe = INCLUDE_STRIPE == "yes"
    magic_link = INCLUDE_MAGIC_LINK == "yes"
    return {
        "google": google,
        "google-import": google,
        "microsoft": microsoft,
        "microsoft-import": microsoft,
        "blog": extras,
        "contact": extras,
        "no-contact": not extras,
        "stripe": stripe,
        "no-stripe": not stripe,
        "magic-link": magic_link,
        # RESEND_API_KEY serves magic link, the contact form, the
        # subscription acknowledgment email and marketing email.
        "resend": sends_email(),
        # Consent-gated analytics: the banner, the consent module, the loader
        # and the first-party proxy ship only with a provider.
        "analytics": ANALYTICS == "posthog",
        "no-analytics": ANALYTICS == "none",
        # One provider is answered and only that one's variables ship. The
        # worker's settings.py still reads all four, with defaults, the way
        # lib/plans.ts survives include_stripe=no: it is provider-agnostic code,
        # and what the answer decides is which credentials a project is asked
        # for — not which code it carries.
        **{f"llm-{name}": LLM_PROVIDER == name
           for name in ("ollama", "openai", "anthropic", "openrouter")},
    }


def apply_markers():
    """Strip cc: marked regions the project did not ask for, tree-wide.

    Every marker comment is removed afterwards, so generated projects carry no
    scaffolding residue.
    """
    decisions = marker_decisions()
    print("Applying conditional blocks...")

    for root, dirs, files in os.walk("."):
        dirs[:] = [d for d in dirs if d not in {"node_modules", ".next", ".git"}]
        for filename in files:
            _, ext = os.path.splitext(filename)
            if ext not in MARKER_EXTENSIONS and filename not in MARKER_FILENAMES:
                continue
            path = os.path.join(root, filename)
            try:
                with open(path, "r", encoding="utf-8") as f:
                    lines = f.readlines()
            except (UnicodeDecodeError, IOError):
                continue

            if not any("cc:begin " in l or "cc:end " in l for l in lines):
                continue

            kept, skip_depth, changed = [], 0, False
            for line in lines:
                begin = re.search(r"cc:begin ([A-Za-z0-9_-]+)", line)
                end = re.search(r"cc:end ([A-Za-z0-9_-]+)", line)
                if begin:
                    changed = True
                    if skip_depth or not decisions.get(begin.group(1), True):
                        skip_depth += 1
                    continue
                if end:
                    changed = True
                    if skip_depth:
                        skip_depth -= 1
                    continue
                if not skip_depth:
                    kept.append(line)

            if changed:
                with open(path, "w", encoding="utf-8") as f:
                    f.writelines(kept)
                print(f"  Resolved markers: {path}")


def make_scripts_executable():
    """Make shell scripts executable."""
    scripts = ["scripts/migrate.sh", "scripts/check_compliance.sh", "setup.sh"]
    for script in scripts:
        if os.path.exists(script):
            os.chmod(script, 0o755)
            print(f"  Executable: {script}")


def main():
    print(f"\n{'='*60}")
    print(f"Setting up {PROJECT_NAME}...")
    print(f"{'='*60}\n")

    process_all_files()
    apply_python_version()
    handle_stripe()
    handle_marketing_extras()
    handle_magic_link()
    handle_resend()
    handle_analytics()
    apply_markers()
    make_scripts_executable()

    print(f"\n{'='*60}")
    print(f"{PROJECT_NAME} is ready!")
    print(f"{'='*60}")
    print(f"\nNext steps:")
    print(f"  cd {PROJECT_SLUG}")
    print(f"  ./setup.sh")
    print()


if __name__ == "__main__":
    main()
