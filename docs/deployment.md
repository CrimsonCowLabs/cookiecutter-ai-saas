# Deployment guide

This covers taking a generated project from a fresh VPS to a running, backed-up
production instance: provisioning the host, deploying the stack, how secrets
are managed, how TLS is obtained, and how database backups work. For
environment variables, the Docker services, and everything about developing
the generated project day to day, see [README.md](../README.md).

## Provisioning

Deploying assumes a host that already has a deploy account, a firewall and a
container runtime. `ansible/provision.yml` is what puts them there. It is
separate from `ansible/deploy.yml` on purpose: it runs when a server is new and
almost never again, so a routine deploy never re-runs apt and firewall tasks.

```bash
pipx install ansible          # or pip install ansible
# put the server's address in ansible/inventory.ini, then:
ansible-playbook -i ansible/inventory.ini ansible/provision.yml
```

That is the whole procedure, and running it again is a no-op — CI asserts a
second run reports zero changes, so it is safe to re-run after editing a value
rather than applying the difference by hand.

The host needs to be Debian-family (Ubuntu LTS is what CI exercises) and to
answer as root over SSH with your key the first time — a stock cloud image does.
The playbook refuses to run against anything else rather than half-provisioning
it.

| Concern | What the playbook leaves |
|---------|--------------------------|
| Deploy account | A user named from `author_name`, key-only, passwordless sudo, in the `docker` group — the account `ansible/deploy.yml` logs in as |
| SSH | Key-only, no root login, no passwords, in `/etc/ssh/sshd_config.d/00-hardening.conf` |
| Firewall | `ufw`, governing every inbound port — containers' included: inbound denied by default; SSH, `80/tcp`, `443/tcp` and `443/udp` (HTTP/3) open; forwarding and NAT for container networks (see [The firewall and Docker](#the-firewall-and-docker)) |
| Intrusion banning | `fail2ban`'s sshd jail, reading the journal |
| Security updates | `unattended-upgrades`, restricted to security origins, no automatic reboot |
| Log rotation | `logrotate.timer`, the journal capped at 500M, Docker's json-file logs capped |
| Container runtime | Docker Engine and the compose plugin, from Docker's apt repository, with its iptables management off |
| Where deploys land | `/app/<project_slug>`, owned by the deploy account |

Everything adjustable is in `ansible/group_vars/all.yml` — the account name, the
open ports, the ban thresholds, the log caps — or overridable for one run with
`-e`.

### One command, before and after hardening

A fresh VPS answers as root; a provisioned one refuses to. The playbook probes
the host before connecting and uses whichever account currently answers, so the
command does not change between the first run and the tenth.

The order inside the run matters for the same reason: the deploy user is
created, given the key, and **observed logging in** before root's ability to log
in is removed. A wrong key fails while root still answers. That check is the one
thing you can turn off (`-e deploy_login_check=false`), and it exists to make
lockout hard.

### What it deliberately leaves alone

- **No reverse proxy.** Caddy runs inside the production stack (see
  [HTTPS and TLS](#https-and-tls)), so provisioning's part is to leave 80 and
  443 open and unoccupied. The playbook fails if a host nginx or Apache is
  running on them, rather than letting Caddy fail to bind on the first deploy.
- **No application.** Provisioning ends at a ready host; `ansible/deploy.yml`
  takes it from there.

### The firewall and Docker

ufw is the only thing deciding what the outside world can reach. That is not
Docker's default: left alone, Docker publishes a container's port by writing
its own iptables rules ahead of ufw's, so a published port is open to the
internet whatever ufw says. The playbook turns that off — `"iptables": false`
and `"ip6tables": false` in `/etc/docker/daemon.json`, written before Docker is
first started — so a port a container publishes is an ordinary listener
(`docker-proxy`) that ufw filters like any other. Publish a port in the compose
file and it is reachable from outside only once a ufw rule allows it.

Docker's rules also did two jobs the containers still need, so ufw does them
instead:

| Job | How ufw does it |
|-----|-----------------|
| Forwarding traffic out of container networks | `ufw route allow in on br-+` (every compose network) and `in on docker0` (the default bridge). Traffic *from* a container may go anywhere; traffic *to* one is forwarded only as a reply. Routed traffic is otherwise denied |
| NAT for containers talking to the internet | `/etc/ufw/after.init`, which ufw runs on every start, reload and stop. It masquerades traffic from `docker_address_pool` (in `group_vars/all.yml`, pinned in `daemon.json` so the two agree) that leaves the host, and leaves traffic between containers untranslated |
| The kernel forwarding at all | `net/ipv4/ip_forward=1` in `/etc/ufw/sysctl.conf` |

`ufw status verbose` shows the inbound rules and the two forwarding rules; the
NAT rule is in `iptables -t nat -S ufw-docker-postrouting`.

A host provisioned before this — where Docker did manage iptables — still
carries the rules Docker wrote, because Docker does not remove them when told to
stop. Re-running `provision.yml` removes them, leaving ufw's and fail2ban's
rules in place. CI checks both the fresh host and that upgrade: no Docker rule
in `iptables-save` or `ip6tables-save`, a container's published port refused
from outside while it answers on the host, containers reaching each other by
name and the internet over HTTPS — and a second run that changes nothing.

Two things follow for the stack, both in `docker-compose.prod.yml`:

- **Caddy runs on the host's network.** A published port now goes through
  `docker-proxy`, which would make every client arrive from the same Docker
  gateway address — one bucket for the contact form's per-IP rate limit, and
  nothing worth banning. On the host's network Caddy binds 80, 443 and 443/udp
  itself, sees each client's own address, and passes it to the app in
  `X-Forwarded-For`.
- **The app publishes its port on loopback** (`127.0.0.1:3000`), which is where
  Caddy proxies to. Nothing outside the host can reach it.

## Deploying

`ansible/deploy.yml` builds the images, ships them, runs the migrations and
switches the stack over — one command, reading the host out of the same
inventory provisioning used:

```bash
cp ansible/vault.yml.example ansible/vault.yml
$EDITOR ansible/vault.yml                    # every secret the stack needs
ansible-vault encrypt ansible/vault.yml      # asks for a vault password
git add ansible/vault.yml                    # committed, encrypted

ansible-playbook -i ansible/inventory.ini ansible/deploy.yml --ask-vault-pass
```

There is no address to fill in and no `.env-production` to copy: the address is
in the inventory and the env file is rendered on the host from the vault. Both
of those were how the shell script this replaces leaked secrets into shell
history.

| Instead of | Now |
|------------|-----|
| `./scripts/deploy.sh full` | `ansible-playbook -i ansible/inventory.ini ansible/deploy.yml` |
| `./scripts/deploy.sh app` | `... -e deploy_targets=app` |
| `./scripts/deploy.sh worker db-writer` | `... -e deploy_targets=worker,db-writer` |
| `./scripts/deploy.sh env` | `... -e deploy_targets=none` |
| — | `... --tags preflight` — check the vault and DNS, deploy nothing |

`migrator` is added to any non-empty `deploy_targets`, because the migrator
image already on the host belongs to the *previous* release: shipping new app
code and running the previous release's migrations against it is the failure
the ordering below exists to prevent. `-e run_migrations=false` skips running
them; nothing skips shipping the right image.

### The DNS pre-flight

Before anything is built, the playbook resolves the name the certificate will
be for (the domain, or `site_address` where that is set) and compares it with
the host the inventory points at. A mismatch aborts, saying what resolved, what
was expected and what to do.

That check is there because the certificate authority rate-limits **failed**
challenges, and Caddy asks for a certificate the moment it starts. Deploying
before a record propagates therefore does not cost one failed attempt — it can
lock issuance for that name for hours, on a host where nothing else is wrong.

It handles the cases that are not mistakes honestly:

- **The generation-time default** (`myapp.example.com`) aborts naming RFC 2606:
  no record can point it here and no CA will issue for it.
- **`site_address=https://localhost`** — smoke-testing the stack — skips the
  check and says so, because no public record covers a loopback name.
- **A record that is deliberately not the host** — proxied through a CDN, where
  the answer is the proxy's address — cannot be told apart from a record nobody
  updated. So the check says what it saw and stops, rather than claiming to
  have verified something: `-e dns_check=false` proceeds, and the message says
  what the proxy then has to pass through.

### Why the order is the guarantee

"A failed deployment leaves the previous version serving" is a property of
ordering, not of a rollback step. Everything that can fail happens before
anything changes what is serving:

1. **Pre-flight** — the vault, the record. Nothing built.
2. **Build, on the control machine.** A $5 VPS running the database has no
   business also running `next build`, and the host never needs the source.
3. **Ship** the compose file, the `Caddyfile`, the rendered env file and the
   new images — under a **release tag**, not `:latest`. The running containers
   hold their own images and their own copy of the env file, so none of this
   touches them. `template` replaces a file by renaming over it, which is why
   the running containers keep reading the copy they opened.
4. **Migrate**, from this release's migrator image, with Postgres and Redis up
   but the app not switched. A failing migration stops the deploy here.
5. **Switch**: move each `:latest` tag and bring the stack up. If the
   switched-over stack does not answer, put the previous release's images back,
   restart on them, and fail loudly.

The release name defaults to a digest of the image ids rather than a timestamp,
so deploying unchanged code twice produces the same release instead of shipping
byte-identical images under a new name — which is what lets a re-run transfer
nothing and report no changes at all. `-e deploy_release=v1.4.0` names one
yourself.

Two things this does not claim. The switch is `docker compose up -d`, which
stops a container before starting its replacement, so a release that cannot
start costs the seconds between the recreate and the rollback — the guarantee
is the end state, not zero downtime. And the health gate proves the app boots
and answers on the host's loopback, not that TLS works: a certificate
arrives from an asynchronous ACME exchange that has not necessarily finished on
a first deploy, which is what the DNS pre-flight protects instead.

| Concern | Where it lives |
|---------|----------------|
| Secrets | `ansible/vault.yml`, encrypted; `ansible/vault.yml.example` documents every name |
| Non-secret settings | `ansible/group_vars/all.yml` |
| The production env file | `ansible/templates/env-production.j2`, rendered to `/app/<slug>/.env-production` on the host, `0600` |
| What is deployed | `/app/<slug>/RELEASE` on the host |
| Previous releases | still on the host, tagged `<slug>-<image>:<release>` |

`scripts/check_deploy.sh` is CI's end-to-end run of all of this against a
throwaway host, including deploying a deliberately broken release on top of a
working one and asserting the working one still answers.

## Secrets

`ansible/vault.yml` holds every production secret, encrypted with
`ansible-vault`, and is committed that way. `.gitignore` excludes the vault
*password* file (`.vault-pass`) and never the vault. Every variable in it is
prefixed `vault_`, so a secret is recognisable wherever it is used. Change one
with `ansible-vault edit ansible/vault.yml`, which never writes plaintext to
disk.

The playbook refuses to run if the vault's first line is not `$ANSIBLE_VAULT` —
an operator who copies the example and forgets the encrypt step gets a refusal,
not a successful deploy and a plaintext secret in a commit.

Be clear about what this buys, because it is not "the secrets never leave the
vault": `ansible-vault` decrypts on the **control machine**, in memory, and the
rendered `.env-production` lands on the host at mode `0600` owned by the deploy
account. Nothing is at rest in plaintext anywhere else — not in the repository,
not in a shell history, not in a file on your laptop. The machine running the
deploy still holds the password and sees the values while it runs; it has to.

Non-secret settings — the domain, the origin NextAuth builds callbacks from,
feature flags — are in `ansible/group_vars/all.yml` and in
`ansible/templates/env-production.j2`, in the clear, where they can be read in
a diff.

## HTTPS and TLS

TLS needs no step of its own. The stack runs its own Caddy, generated from the
`domain_name` you answered, which obtains a certificate from Let's Encrypt on
first boot, renews it, and redirects HTTP to HTTPS — so once the stack is up,
HTTPS is up. There is no external proxy to stand up and no network to create by
hand.

Bringing the stack up still means what it did before: `docker-compose.prod.yml`
has no build context, so `ansible/deploy.yml` builds the images and ships them,
and `.env-production` has to exist next to the compose file or compose aborts —
which is why the playbook renders it there. Nothing about the proxy changes that.

Two prerequisites for the certificate, and neither is optional:

- **Point the domain's A/AAAA record at the host before the first deploy.**
  Issuance is a challenge against that name, so it fails until DNS resolves and
  ports 80 and 443 reach the host. Caddy retries with a backoff, so fixing
  DNS afterwards recovers without intervention — but Let's Encrypt rate-limits
  failures, so the record is cheaper to get in first.
- **Set `NEXTAUTH_URL=https://<your domain>` in `.env-production`**, and register
  that origin's OAuth callback URLs with your providers. Caddy sets
  `X-Forwarded-Proto`, which is what lets NextAuth (`trustHost: true`) build
  `https://` callbacks — but the configured origin still has to match.

| Concern | Where it lives |
|---------|----------------|
| Proxy config | `Caddyfile`, rendered from `domain_name` at generation time |
| Certificates | the `caddydata` volume — keep it across deploys, or every boot re-issues into a rate limit |
| Expiry warnings | mailed to `author_email`, unless that is at a reserved example domain (see below) |
| Listening ports | `80`, `443`, `443/udp` (HTTP/3), bound by `caddy` on the host's network; the app's `3000` on `127.0.0.1` only, for Caddy |

Postgres and Redis publish no port, and nothing from outside is forwarded to a
container, so they are reachable only from the host and from inside the stack.
That is less isolation than there used to be: Caddy once sat on a network of its
own with the app, with no route to the database, and on the host's network it
has the host's routes, which reach every container's address. A compromised
Caddy could connect to Postgres (which still wants its password) and Redis
(which has none). Host networking is the price of Caddy seeing clients' real
addresses — see [The firewall and Docker](#the-firewall-and-docker).

The same goes for other compose projects on the same host. Docker used to keep
its networks apart with isolation chains of its own; with its iptables
management off, `ufw route allow in on br-+` forwards from any container network
to any destination, the other networks' containers included. On a host that runs
only this stack that changes nothing. If you add unrelated stacks, give Redis a
password, or keep them on another host.

Responses are not compressed at the proxy. Next.js already compresses its own
output, and compressing a stream is how the SSE job-progress endpoint stops
arriving live.

### Smoke-testing before DNS exists

`SITE_ADDRESS` overrides the name Caddy serves. Set it to `https://localhost` and
Caddy issues from its own local CA instead of asking Let's Encrypt for a name
that does not resolve yet:

```bash
SITE_ADDRESS=https://localhost docker compose -f docker-compose.prod.yml up -d
curl -k https://localhost/
```

Everything else — the redirect, TLS termination, the proxy hop — is the
production path; only the issuer differs, so this proves the wiring and not the
ACME exchange. CI's `tls-stack` job runs exactly this, via
`scripts/check_tls_stack.sh`.

### If `author_email` is at a reserved example domain

The ACME account address comes from `author_email`. A certificate authority can
reject an address it cannot deliver to, so a project generated with an address no
mail can reach ships **no** `email` directive at all. Certificates are still
issued; the account is just anonymous, which means nobody is told when renewal
starts failing.

"Unreachable" is the set RFC 2606 reserves: the `example.com`, `example.org` and
`example.net` domains, and the `.test`, `.invalid`, `.localhost` and `.example`
TLDs. It is the mail domain that is tested, not a suffix, so a real domain like
`acme-example.com` keeps its account. Add a global block to the `Caddyfile` once
you have a real address:

```caddyfile
{
    email you@your-real-domain.com
}
```

## Database backups

**Restore is not automated.** There is no `restore.sh` and no playbook that puts
a dump back. What this ships is the half that has to happen unattended — dumps
taken on a schedule, copied somewhere the host is not, pruned on a policy, and
loud when they fail. Putting one back is a handful of commands you run
deliberately, with the site down, having decided which dump to use:

```bash
# 1. Fetch the dump you want. `rclone lsl backup:<bucket>/<prefix>` lists them,
#    newest last; the name is the UTC time it was taken.
sudo rclone --config /etc/<slug>-db-backup/rclone.conf \
  copyto backup:<bucket>/<prefix>/db-20250104T033012Z.dump /tmp/restore.dump

# 2. Stop everything that writes. A restore into a live database is how you get
#    a database that is neither the old one nor the new one.
cd /app/<slug> && docker compose -f docker-compose.prod.yml \
  --env-file .env-production stop app worker db-writer

# 3. Restore. --clean --if-exists drops what is there first, so this is a
#    replacement and not a merge.
docker exec -i <slug>-postgres-1 pg_restore \
  --clean --if-exists --no-owner -U postgres -d <slug_with_underscores> \
  < /tmp/restore.dump

# 4. Bring the stack back, and check the data before you let traffic in.
docker compose -f docker-compose.prod.yml --env-file .env-production up -d
```

The reason that is four commands in a README rather than a script is that an
untested restore script is worse than none: it reads as a guarantee, and the day
you find out it does not work is the day you needed it. Run the steps above
against a throwaway database once, before you need them.

### Setting them up

```bash
cp ansible/vault.yml.example ansible/vault.yml
$EDITOR ansible/vault.yml            # where the dumps go, and where alerts go
ansible-vault encrypt ansible/vault.yml
ansible-playbook -i ansible/inventory.ini ansible/backup.yml
sudo systemctl start <slug>-db-backup.service    # on the host: take the first one now
```

Run it after the stack is up — the dump comes out of the running Postgres
container, so a schedule installed against a stack that has never existed is a
schedule that fails. Running it again is a no-op; CI asserts that a second run
reports zero changes.

Commit the encrypted `ansible/vault.yml`. It is ciphertext, and keeping it in
the repository is what stops the only copy of those credentials from living on
whichever laptop ran the playbook last. The password that opens it goes in
`ansible/.vault-pass`, which `.gitignore` already excludes; point Ansible at it
with `export ANSIBLE_VAULT_PASSWORD_FILE=ansible/.vault-pass`, or pass
`--ask-vault-pass`. The playbook refuses to run against a `vault.yml` that is
not encrypted, rather than quietly reading your storage credentials out of a
plaintext file nobody has noticed yet.

Two values are required, and the playbook refuses to install a schedule without
either:

- **`vault_backup_remote` and `vault_backup_remote_path`** — where the dumps go.
  A dump that only ever lands on the machine being backed up is not a backup, so
  "unconfigured" is a refusal and not a quiet fall back to local-only.
- **`vault_backup_alert_url`** — where a failure goes. Without it the only
  record of a broken backup is a journal entry on the broken host, which nobody
  reads. See [When they break](#when-they-break).

Two more refusals happen before the host is touched, because both failures
otherwise present as a nightly alert rather than as a mistake to fix now. A
destination that cannot outlive the host — rclone's `local`, `alias` or `memory`
backends, or an endpoint on the loopback — is rejected, which is a floor rather
than a guarantee: an endpoint naming a host that happens to resolve back is
indistinguishable from a real one at install time, and the playbook says so. And
the *source* is verified as well as the destination: if no running Postgres
container carries the stack's Compose label, the playbook refuses rather than
installing a schedule that fails every night from the first one.

### What gets installed

| Concern | What the playbook leaves |
|---------|--------------------------|
| The dump | `pg_dump --format=custom`, run **inside** the Postgres container — the only client on the host that cannot be older than the server, and the database publishes no port for anything else to connect to |
| Schedule | `<slug>-db-backup.timer`, daily at 03:30 UTC with up to 45 minutes of jitter, `Persistent=true` so a missed run happens at the next boot |
| Off-host copy | `rclone` to whatever `vault_backup_remote` names — any S3-compatible bucket, or any other rclone backend, without the playbook changing |
| Verification | The archive has to parse as one (`pg_restore --list`), and the destination has to read back at the same size, before anything is pruned |
| Retention | 7 dumps locally, 30 at the destination |
| Failure | `OnFailure=` → a POST to `vault_backup_alert_url`, a journal entry at priority `err`, and a marker file at `/var/lib/<slug>-backup/FAILED` |
| Staleness | `<slug>-db-backup-watch.timer`, every six hours, failing (and so alerting) when the last success is more than 30 hours old |
| Credentials | `/etc/<slug>-db-backup/rclone.conf`, mode 0600, root-owned |
| Dumps | `/var/backups/<slug>`, mode 0700 — a dump is the whole database, including every token in it |

Everything adjustable is in `ansible/group_vars/all.yml` — the schedule, the
retention numbers, the staleness limit, the alert payload's shape — or
overridable for one run with `-e`.

`rclone` comes from the distribution's package rather than a binary fetched at
install time, so it receives security updates through the `unattended-upgrades`
that [provisioning](#provisioning) already configured, and no version is
pinned in this template to go stale. The trade is a release that lags
upstream; if you need a backend or a flag it does not have, install a newer
`rclone` by hand and the playbook will leave it alone.

### The retention policy

**7 local, 30 remote.** The local copy is a convenience — it makes a same-day
restore fast and survives nothing — so it is deliberately shorter than the
destination's, which is the copy that outlives the host. At a dump a day that is
a week on the box and a month off it.

Two rules make the policy safe rather than merely small:

- **Nothing is pruned until a backup has been verified at the destination.** The
  upload has to have happened and the object has to read back at the right size.
  A run that fails deletes nothing — a half-working backup that still prunes is
  how a retention policy comes to eat the last good copy.
- **The newest dump can never be pruned.** Dumps are named for the UTC second
  they were taken, so sorting the names sorts by time, and the prune only ever
  looks past the newest *N*. The playbook additionally refuses to install a
  policy of zero, and the script refuses to run under one.

Both ends of that are asserted in CI against a real destination: an old dump is
deleted, the newest is not, locally and remotely.

### When they break

A systemd timer whose service fails writes to the journal and stops there, and
the journal is a complete record that nobody reads unprompted — which is why a
timer that has been failing for a month looks exactly like one that has never
failed. So a failure is reported three ways, with different failure modes:

1. **A POST to `vault_backup_alert_url`**, the only one of the three that
   reaches somebody who was not already looking. Anything that accepts a POST
   works — a Slack, Discord or Mattermost incoming webhook, or an ntfy.sh topic.
   `backup_alert_payload` in `group_vars/all.yml` is the body, with `%MESSAGE%`
   substituted; the default shape is Slack's.
2. **A journal entry at priority `err`**, so `journalctl -t <slug>-db-backup -p err`
   finds it without your having to know which unit to ask about.
3. **A marker file**, `/var/lib/<slug>-backup/FAILED`, removed by the next
   successful backup — so its presence means "broken now", not "broke once".

And separately, the case none of that catches: backups that simply stopped.
Nothing failed, so nothing reported. `<slug>-db-backup-watch.timer` runs every
six hours, fails when the last success is more than 30 hours old, and routes to
the same alert. It is a dead-man's switch, so while backups are stale you will
hear about it four times a day, deliberately — a nag is how an alert survives a
busy week.

To see the state by hand:

```bash
cat /var/lib/<slug>-backup/last-success      # when, which dump, how big
systemctl list-timers '<slug>-db-backup*'    # when next, when last
journalctl -u <slug>-db-backup.service -n 50
```

Set `vault_backup_heartbeat_url` as well if you want the one thing an on-host
check cannot give you. It is pinged after every successful backup, for a
dead-man's-switch service (healthchecks.io, Cronitor, an Uptime Kuma push
monitor) that alerts when the pings stop. The staleness timer covers a schedule
that stopped firing; it cannot report a host that is powered off, out of disk or
destroyed, because by then nothing on it runs.

### What this does not cover

- **Restore, as above.** Practise it before you need it.
- **Anything but Postgres.** Redis holds the job queue and the `caddydata`
  volume holds certificates. Losing the queue costs in-flight jobs; losing the
  certificates costs a re-issue, and Let's Encrypt rate-limits those.
- **Encryption at rest beyond the destination's own.** The dump is uploaded as
  `pg_dump` wrote it, so what protects it is the bucket's access control and the
  provider's server-side encryption. If you need the destination unable to read
  it, add an `rclone` crypt remote — and then keep that key somewhere other than
  the host it encrypts, or the backup is unreadable in exactly the case it
  exists for.
- **A credential that cannot delete.** Pruning needs delete, so the credential
  on the host has it, which means a compromised host can empty the bucket. Scope
  the credential to that one bucket, and turn on object lock or versioning if
  your provider offers it.

## Operating a deployed instance

Every generated project ships `opsctl`, a small CLI so that running a deployed
instance is not a matter of remembering `docker compose` invocations over SSH.
It reads the host out of `ansible/inventory.ini` and
`ansible/group_vars/all.yml` — the files provisioning and deploying already
read — so there is exactly one place the host is configured, and it
authenticates by shelling out to your own `ssh`: your `~/.ssh/config`, your
agent and your `known_hosts`, not a key or identity the CLI manages itself.

```bash
npm ci        # builds the CLI as a side effect (the `prepare` script)
npm link      # optional: puts `opsctl` on PATH
opsctl        # no arguments: lists every command
```

| Command | What it does |
|---------|--------------|
| `opsctl config` | First-run check: is a host configured, is the vault encrypted, does it answer over SSH. Observes only |
| `opsctl status` | Container status on the host (`docker compose ps`) |
| `opsctl logs <service>` | Logs from the host; arguments pass straight through, so `-f` follows |
| `opsctl shell <service>` | An interactive shell in a running service (`docker compose exec -it`) |

Those four are read-only, by design. The rest change the host, by wrapping the
same playbooks documented above rather than reimplementing them — there is
still exactly one deployment code path, whether a human types the
`ansible-playbook` command or `opsctl` does:

| Command | What it does |
|---------|--------------|
| `opsctl provision [-- ansible args]` | [Provisions](#provisioning) the host (`ansible-playbook ansible/provision.yml`); everything after `--` passes through, e.g. `-e deploy_public_key_file=...` |
| `opsctl deploy [targets...] [--no-migrate]` | [Deploys](#deploying) (`ansible-playbook ansible/deploy.yml`); `opsctl deploy` ships everything, `opsctl deploy app worker` ships a subset, `--no-migrate` is `-e run_migrations=false` |
| `opsctl migrate` | Runs pending migrations and ships nothing else (`-e deploy_targets=migrator`) — deploy.yml's own way to ship one image, aimed at the one that runs migrations |
| `opsctl secrets edit` | `ansible-vault edit ansible/vault.yml`, interactively, in your own `$EDITOR` — never decrypted to disk |
| `opsctl backup` | Takes a backup right now: `systemctl start <slug>-db-backup.service` on the host, the schedule [already installed](#database-backups) |
| `opsctl preflight` | `opsctl config`'s checks, then `ansible-playbook ansible/deploy.yml --tags preflight` — catches unresolved DNS, an unreachable host and missing configuration before a deploy does |

`opsctl provision`, `deploy`, `migrate` and `preflight` all run on the control
machine, exactly like typing the `ansible-playbook` command by hand — only
`backup` connects over SSH, because it starts something the playbooks already
put on the host rather than running a playbook itself. Extra `ansible-playbook`
arguments to `deploy` or `migrate` go after a literal `--` (`opsctl deploy app
-- -e dns_check=false`), so a flag's own value can never be mistaken for a
deploy target.

There is no `restore` command, deliberately: `opsctl restore` says so and
points at [Database backups](#database-backups)'s restore steps, which are a
manual procedure and stay one — see that section for why.

Full usage docs live in the generated project's own README (under "The CLI"),
since that is where the CLI actually runs — this is the template's side of the
same feature.
