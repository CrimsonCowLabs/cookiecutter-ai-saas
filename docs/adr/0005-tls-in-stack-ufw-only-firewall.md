# 5. TLS terminates in the stack, and ufw is the only firewall

**Status:** Accepted. Issues [#17](https://github.com/CrimsonCowLabs/cookiecutter-ai-saas/issues/17), [#18](https://github.com/CrimsonCowLabs/cookiecutter-ai-saas/issues/18) and [#97](https://github.com/CrimsonCowLabs/cookiecutter-ai-saas/issues/97).

## Context

The inherited production compose file joined an external reverse-proxy network,
but no proxy configuration shipped anywhere. Following the deployment
instructions gave you a stack that couldn't serve HTTPS.

Separately, Docker by default publishes a container's port by writing its own
iptables rules ahead of the host firewall's. On a ufw host, a port published in
a compose file is open to the internet whatever ufw says. People reading a
firewall config expect it to decide what is exposed, so this default is easy to
miss.

## Decision

- Caddy runs inside the production stack (`docker-compose.prod.yml`) with a
  Caddyfile generated from `domain_name`. Bringing the stack up is enough to
  get a certificate, serve HTTPS and redirect HTTP.
- Caddy uses the host's network and binds 80/tcp, 443/tcp and 443/udp itself.
  The app publishes its port on `127.0.0.1` only. Postgres and Redis publish
  nothing.
- `ansible/provision.yml` configures the Docker daemon with iptables and
  ip6tables management turned off. It does this before Docker is installed,
  because a daemon that starts even once with iptables management on leaves
  rules behind. ufw denies inbound traffic by default and carries the NAT and
  forwarding rules Docker used to write.

## Consequences

- Publishing a port in a compose file exposes nothing until a ufw rule allows
  it. Opening a port is always a firewall change.
- Containers need ufw's forwarding and NAT rules to reach the internet and
  each other. A host provisioned by hand rather than by the playbook won't have
  them.
- Caddy can't be scaled or moved separately from the app host. For a
  single-VPS template that is the intended trade.
