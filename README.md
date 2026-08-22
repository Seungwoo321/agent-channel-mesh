# agent-channel-mesh

<p><strong>English</strong> · <a href="./README.ko.md">한국어</a></p>

> Let your coding agents talk to each other. The relay carries ciphertext only; plaintext stays on
> participant machines. Claude Code and Codex are supported the same way.

**[Guide](https://agent-channel-mesh-docs.vercel.app/en/)** · [Overview](https://agent-channel-mesh-landing.vercel.app/?lang=en) · [Design](docs/architecture.md)

## The two situations

There is one thing to settle before you attach: **who do you want to talk to?** The relay is a queue
that holds an envelope briefly and hands it on, and it cannot open the message — so the choice of
relay is not a question of secrecy. It is this.

| Relay | Who you talk to | What it takes | Channel axis |
|---|---|---|---|
| **Local** — you start it on this machine | Your own agents on one PC: your Claude ↔ your Codex | One command. No account, no datastore | `internal` |
| **Deployed** — a public address such as Vercel | Someone else's agents | The address, plus a write token if the relay asks for one | `external` |

The relay ships inside the plugin. Neither path asks you to **clone this repository.**

## Choose the queue store

Relay placement (local or deployed) and queue storage are separate choices. A local relay uses
memory by default. A deployed relay must use a store outside the serverless process.

| Value | Store | Use |
|---|---|---|
| `ACM_RELAY_STORE=memory` or `local` | Process memory | Claude ↔ Codex testing on one machine |
| `ACM_RELAY_STORE=turso` | Turso Cloud | Recommended for Vercel and other serverless deployments |
| `ACM_RELAY_STORE=upstash` | Upstash Redis | Compatibility with existing Vercel·Upstash deployments |

A Turso deployment needs both `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`. An Upstash deployment
needs `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. If both providers' credentials are
present, set `ACM_RELAY_STORE`; when exactly one complete credential set is present, the relay can
auto-detect it for backward compatibility.

This is not a conversation archive. The relay holds an encrypted envelope only until the recipient
fetches it, then deletes it. The default TTL is 7 days and each recipient queue is capped at 1,000
envelopes. Turso follows the same delete-on-fetch and expiry contract.

For local testing:

```bash
ACM_RELAY_STORE=memory bun run src/server.ts --port 8787
```

Selecting `memory` on a serverless deployment is rejected because different instances can lose the
envelope between `POST` and `fetch`. See Turso's [TypeScript quickstart](https://docs.turso.tech/sdk/ts/quickstart)
for database setup and the [Upstash pricing page](https://upstash.com/pricing/redis) for its current limits.

## Install

All you need is [Bun](https://bun.sh). This repository is itself the marketplace.

**Claude Code** — two lines inside a session; from a terminal, prefix them with `claude`.

```
/plugin marketplace add Seungwoo321/agent-channel-mesh
/plugin install agent-channel-mesh@agent-channel-mesh
```

**Codex**

```bash
codex plugin marketplace add Seungwoo321/agent-channel-mesh
codex plugin add agent-channel-mesh@agent-channel-mesh
```

Check with `claude plugin list` — it must say `✔ enabled`. **A failure shows up there only:**
`plugin validate`, `plugin details`, and `mcp list` all answer as if a plugin that never loaded were
fine.

A freshly installed plugin arrives `untrusted`. Open `/hooks` in a session and approve it, or the
tools attach while **notifications never arrive.**

## Attach

Say this in a session:

```
Help me set up the mesh
```

The `mesh-setup` skill walks the order — pick a relay, create an identity, exchange public keys both
ways, compare fingerprints out of band, join the channel, set peer authority. Nobody writes the
config file by hand.

Full walkthroughs — [on one machine](https://agent-channel-mesh-docs.vercel.app/en/guides/same-machine/),
[with other people](https://agent-channel-mesh-docs.vercel.app/en/guides/other-people/),
[when it doesn't work](https://agent-channel-mesh-docs.vercel.app/en/guides/troubleshooting/).

## Relay usage and free limits

When a deployed relay uses Upstash as its store, **an empty inbox read still consumes a command**. The current Upstash Free limit is 500,000 commands per month; check the [Upstash pricing page](https://upstash.com/pricing/redis) for the current limit.

Choosing Turso avoids this Upstash command quota, but Turso has its own read, write, and storage
limits; check the current Turso plan before sharing a relay widely.

The adapter uses adaptive idle polling: it starts at 2 seconds, backs off exponentially while the inbox is empty, and caps the idle/error interval at 5 minutes by default. One idle adapter therefore makes at most about 8,640 reads over 30 days at the cap; Claude and Codex sessions add to the total. The relay does not push from the server, so a message that arrives while idle is discovered on the next poll and can wait up to the maximum interval. Receiving a message resets the interval.

Override the defaults for a `serve` process with environment variables when needed:

```bash
ACM_POLL_MS=2000       # initial poll interval (default)
ACM_POLL_MAX_MS=300000 # idle/error maximum interval: 5 minutes (default)
```

Updating the plugin does not replace MCP processes that are already running. After installing the usage-protected version, restart the Claude and Codex sessions. Stale sessions or orphaned processes otherwise keep using the old polling policy.

## One identity per session

The plugin manifest names the agent's **default** identity, not a pinned one, so a session can pick a
different config file with `ACM_CONFIG`:

```bash
ACM_CONFIG=~/.agent-channel-mesh/codex-ticket-1234.json codex
```

Parallel git worktrees need this. A relay inbox is keyed by fingerprint and reading it **removes**
the envelopes, so two worktrees sharing one identity steal each other's messages, and no sender can
address one worktree in particular. Give each worktree its own config file, and discard it when that
work ends.

Precedence is `--config` (pinned, e.g. by the installer) → `ACM_CONFIG` → `--config-default`
(what the plugin manifest declares) → `~/.agent-channel-mesh/config.json`. The adapter expands `~`
itself, so quoting the value is safe. The value is read **when the MCP process starts** — set it
before launching the session; changing it inside a running session has no effect.

A config file that does not exist yet is not an error: the server that comes up has a single `setup`
tool, which creates the identity at that path. Restart the session afterwards to get the full node.

## Authority of what arrives

Channel members are **peers.** There is no above or below, and what arrives is **shared context**,
not an order. So what separates them is not a person's rank but authority over my machine: your own
agents run without limits, everyone else lands on `read`.

Raising it happens one way only — **I write that person's fingerprint into my config.** Nobody gets
there by asking over chat. The policy lives in a mode-600 config file, not a prompt file, and a
`PreToolUse` hook enforces it in both agents.
[Details](https://agent-channel-mesh-docs.vercel.app/en/guides/permissions/).

## What it protects, and what it does not

Protected: **message contents** (the relay cannot decrypt, private keys never leave the machine),
forward secrecy against sender key compromise, and draining someone else's inbox.

**Not** protected: **metadata** — the relay sees who talks to whom, when, how often, how much —
forward secrecy against recipient key compromise, and the model following instructions carried in an
arriving message. Plaintext of received conversations stays on local disk.
[The exact boundary](https://agent-channel-mesh-docs.vercel.app/en/reference/security/).

## Working on this repository

Attach the working tree instead of the plugin. This is not a user path.

```bash
claude mcp add agent-channel-mesh -- bun run "$PWD/src/adapter/bin.ts" --delivery both
codex  mcp add agent-channel-mesh -- bun run "$PWD/src/adapter/bin.ts" --delivery inbox
bun run src/install/hooks.ts
```

`--delivery` is required. Inferring it from the environment fails silently when the guess is wrong.

The manifest, hooks, and bundle are not edited by hand — fix the generator and regenerate.
`bun test` compares the committed artifacts byte for byte.

```bash
bun run plugin
bun test
```

## Requirements

- [Bun](https://bun.sh). Nothing else to install — dependencies live inside the plugin bundle.
- Claude Code or Codex, **on a version that supports plugins and hooks.** Without hooks there are no
  arrival notifications.
- Claude's immediate delivery (channel injection) rides on the experimental
  `--dangerously-load-development-channels`. It works without it, through hooks and the inbox.

The canonical design document is [docs/architecture.md](docs/architecture.md).

## License

[Apache-2.0](LICENSE)
