# 3. The fetch tool treats every URL as hostile

**Status:** Accepted. Issue [#15](https://github.com/CrimsonCowLabs/cookiecutter-ai-saas/issues/15). Follow-up open in [#114](https://github.com/CrimsonCowLabs/cookiecutter-ai-saas/issues/114).

## Context

The example agent ([ADR-0002](0002-bounded-tool-calling-agent.md)) fetches a URL
that an end user typed into the dashboard. The model can also call the same
tool with a URL of its own choosing. The worker that makes the request shares a
Docker network with Postgres and Redis and can reach the host's loopback
interface.

A fetch tool that requests whatever it is given is a server-side request
forgery (SSRF) hole. Any signed-in user could make the worker probe internal
services and read the responses back in the job report. Checking only the first
URL is the usual way such a defence gets bypassed, because a public URL can
redirect to an internal one.

## Decision

`workers/app/tools/fetch_url.py` refuses anything it can't show is safe:

- Only `http` and `https` are allowed.
- The host is resolved and refused if any address is loopback, private,
  link-local, reserved or otherwise not globally routable
  (`_classify_address`).
- Redirects are followed by hand, at most `MAX_REDIRECTS` (3) hops, and every
  hop is validated again.
- The response is capped while it is read (`MAX_RESPONSE_BYTES`), not after.
  Only text content types are accepted, there is a timeout, and extracted text
  is truncated (`MAX_TEXT_CHARS`) so one page can't flood the prompt.
- The tool needs no API key, so the first run still requires only a model
  provider.

## Consequences

- The tool can't fetch internal or intranet pages, by design. A project that
  needs that should write a separate, narrower tool.
- DNS rebinding isn't covered. The address that is checked and the address
  that is connected to come from separate lookups, so a record that changes
  between them gets through. The module says so in its docstring rather than
  implying coverage it lacks.
- Error messages and progress streams can still reveal more about refused
  addresses than they need to. [#114](https://github.com/CrimsonCowLabs/cookiecutter-ai-saas/issues/114)
  tracks tightening that.
