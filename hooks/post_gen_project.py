#!/usr/bin/env python3
"""Post-generation hook for cookiecutter template.

Runs after the project is generated to:
- Replace __PLACEHOLDER__ strings in files that skip Jinja2 rendering (.ts/.tsx,
  the Ansible tree) or that carry a value derived here (the deploy account)
- Remove optional features based on cookiecutter choices
"""

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
        "magic-link": magic_link,
        # RESEND_API_KEY serves both magic link and the contact form.
        "resend": magic_link or extras,
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
    scripts = ["scripts/migrate.sh", "setup.sh"]
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
