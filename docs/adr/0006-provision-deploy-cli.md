# 6. Provisioning, deploy and the CLI are separate layers, and there is no restore yet

**Status:** Accepted. Issues [#18](https://github.com/CrimsonCowLabs/cookiecutter-ai-saas/issues/18), [#19](https://github.com/CrimsonCowLabs/cookiecutter-ai-saas/issues/19), [#20](https://github.com/CrimsonCowLabs/cookiecutter-ai-saas/issues/20), [#21](https://github.com/CrimsonCowLabs/cookiecutter-ai-saas/issues/21) and [#22](https://github.com/CrimsonCowLabs/cookiecutter-ai-saas/issues/22). Restore is tracked in [#41](https://github.com/CrimsonCowLabs/cookiecutter-ai-saas/issues/41).

## Context

The inherited deployment assumed a host that was already set up, and shipped no
playbooks. Getting a fresh VPS to a safe state means a non-root user, key-only
SSH, a firewall, fail2ban, unattended upgrades and log rotation. That work is
slow, changes rarely and is risky to re-run casually. Deploying a new version
is quick, frequent and should be boring.

## Decision

- `ansible/provision.yml` takes a fresh VPS to a ready state. It is run rarely
  and is idempotent: CI asserts a second run changes nothing.
- `ansible/deploy.yml` ships the stack. Secrets come from an Ansible Vault
  file, and DNS is checked before any change is made. Routine deploys never
  re-run firewall or package tasks.
- `ansible/backup.yml` backs the database up on a schedule, copies it off the
  host, and fails loudly.
- `opsctl`, the generated CLI, wraps those playbooks and never reimplements
  them, so there is exactly one deployment code path. Its `preflight` verb
  catches unresolved DNS, unreachable hosts and missing configuration before
  they become a failed deploy.
- There is no restore verb. An untested restore path is worse than none,
  because it gives false confidence. `opsctl restore` prints a note saying so
  rather than pretending.

## Consequences

- Recovering from a backup is a manual job until restore is automated and
  rehearsed ([#41](https://github.com/CrimsonCowLabs/cookiecutter-ai-saas/issues/41)).
- Changing firewall or package configuration means re-running provisioning
  deliberately. A deploy won't pick it up.
- Real-host behaviour is covered by CI against a throwaway host
  (`scripts/check_provisioning.sh`, `check_deploy.sh`, `check_backups.sh`),
  not by the unit tests.
