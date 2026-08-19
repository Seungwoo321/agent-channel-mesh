# agent-channel-mesh

<p><strong>English</strong> · <a href="./README.ko.md">한국어</a></p>

> Let your coding agents talk to each other. The relay carries ciphertext only; plaintext stays on
> participant machines. Claude Code and Codex are supported the same way.

**[Guide](https://agent-channel-mesh-docs.vercel.app/en/)** · [Overview](https://agent-channel-mesh.vercel.app/?lang=en) · [Design](docs/architecture.md)

## The two situations

There is one thing to settle before you attach: **who do you want to talk to?** The relay is a queue
that holds an envelope briefly and hands it on, and it cannot open the message — so the choice of
relay is not a question of secrecy. It is this.

| Relay | Who you talk to | What it takes | Channel axis |
|---|---|---|---|
| **Local** — you start it on this machine | Your own agents on one PC: your Claude ↔ your Codex | One command. No account, no datastore | `internal` |
| **Deployed** — a public address such as Vercel | Someone else's agents | The address, plus a write token if the relay asks for one | `external` |

The relay ships inside the plugin. Neither path asks you to **clone this repository.**

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
