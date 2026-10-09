# Design record

The decisions that shape this template, why each one was made, and what it
costs. One file per decision, numbered in the order they were taken.

This template began as a copy of a private template. "The inherited template"
in these records means that starting point, before the changes they describe.

The records were written after the work they describe had landed. The
reasoning comes from the issues that asked for each change and the comments
left in the code that carries it out. Each record links its issue so
you can read the original argument.

| ADR | Decision |
| --- | --- |
| [0001](0001-small-flag-set-pairwise-ci.md) | Keep the generation-time choices few, and test them pairwise |
| [0002](0002-bounded-tool-calling-agent.md) | The AI step is a tool-calling agent with a hard tool-call limit |
| [0003](0003-fetch-tool-treats-urls-as-hostile.md) | The fetch tool treats every URL as hostile |
| [0004](0004-escape-json-ld.md) | JSON-LD is serialized through one escaping helper |
| [0005](0005-tls-in-stack-ufw-only-firewall.md) | TLS terminates in the stack, and ufw is the only firewall |
| [0006](0006-provision-deploy-cli.md) | Provisioning, deploy and the CLI are separate layers, and there is no restore yet |
| [0007](0007-no-documentation-site.md) | Documentation is a README and focused guides, not a docs site |

## Writing a new one

Copy the shape of an existing record: **Status**, **Context**, **Decision**,
**Consequences**. Use the next number. When a decision is reversed, don't
delete the old record. Mark it `Superseded by ADR-NNNN` and write the new one.
