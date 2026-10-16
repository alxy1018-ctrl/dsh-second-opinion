# dsh-second-opinion

English | [中文](README.md)

A **second opinion** for coding work: analyze before touching anything, have that analysis looked at by another brain, then review once more after the code is written and once more after verification. On multi-module tasks the two sides write their own files and cross-check each other.

A DeepSeek Harness plugin. **You decide who the reviewer is** — a subagent, any OpenAI-compatible endpoint, or a command you wrote yourself. The plugin binds no vendor and ships no vendor defaults.

> Note: the discipline text this plugin injects is in Chinese (this is a Chinese-authored plugin). The reviewer slot and all configuration are language-neutral; the YAML comments below keep the original Chinese and add English glosses.

- Discipline (injected every turn): `lib/index.js`
- Practice (a skill, loaded on demand): the skill text in the same file
- Contract (how to plug in your own reviewer): [`docs/reviewer-contract.md`](docs/reviewer-contract.md)
- Reference adapters: [`adapters/http.mjs`](adapters/http.mjs), [`adapters/exec.mjs`](adapters/exec.mjs)

---

## What it solves

When an agent is asked to "change something", the most common failure is not that it cannot write the code — it is that it **starts too early**: misreads half the requirement, refactors on the side, adds a dependency nobody needs, handles only the happy path. You will not catch these yourself; while writing, everything feels correct.

So this plugin does exactly three things:

1. **Analyze first, do not touch the code**: the real problem, the acceptance criteria, the blast radius, the existing conventions that must be kept, the open questions.
2. **Demand a second opinion**: hand the original request plus your analysis to a separate reviewer whose only job is to find what is wrong with it.
3. **Cross-check at the end**: review once after the code is written and once after verification; on multi-module work, you check what it wrote and it checks what you wrote.

## What one real run looks like

```
You: change module X to support bulk import

agent: analysis first (real problem / acceptance criteria / blast radius / existing conventions / open questions)
       → requirement review → merge the feedback → implement
       → code review (key hunks of the diff) → fix real defects
       → run verification → test review → report the result
```

Review notes stay internal. The internal discussion is **not** pasted back at you — you get the result and the reasoning behind it.

## Install

```powershell
dsh plugin --profile desktop add github:alxy1018-ctrl/dsh-second-opinion
```

> ⚠️ Installing from GitHub needs `git` present **and DSH started after git was installed**.
> Install git without restarting DSH and you get `'git' 不是内部或外部命令`. The hint DSH prints
> ("go look at allowBuilds") is misleading — **just restart**.

## Configuration

Put this in your profile patch. Only `reviewer` needs thought; everything else has a default:

```yaml
- id: second-opinion
  name: 'dsh-second-opinion'
  config:
    defaultMode: code          # code | always | off
    reviewer:
      kind: subagent           # subagent | http | command | none
      provider: <your route>
      model: <your model>
      label: 我的评审方          # optional; display only
```

The mode can also be overridden by an environment variable (priority: environment variable > `defaultMode` in config): `SECOND_OPINION_MODE=off`.
⚠️ Environment variables are **process-wide**. In a long-running DSH they affect every later session (the slash command, by contrast, is per-session) — switch with `/second-opinion` day to day, not with environment variables.

### The four reviewer kinds

| kind | In one line | Who it is for |
|---|---|---|
| `subagent` (default) | Reuse a subagent route the host already has | You already route another model and want it as the reviewer |
| `http` | Any OpenAI-compatible endpoint | A self-hosted gateway, local inference, or a cloud API |
| `command` | Your own command: JSON on stdin, answer on stdout | You want a rule base, a script, or another CLI as the reviewer |
| `none` | No reviewer | You want the discipline without the second opinion |

**`subagent` (default)** — no vendor bound; you supply the route:

```yaml
    reviewer:
      kind: subagent
      provider: your-provider-id
      model: your-model-id
```

**`http`** — endpoint, model and the key's variable name all come from you:

```yaml
    reviewer:
      kind: http
      baseURL: https://api.example.com/v1
      model: your-model
      apiKeyEnv: YOUR_API_KEY     # a **variable name**, not the key itself
      timeoutSeconds: 180
```

**`command`** — contract JSON on stdin, read its stdout:

```yaml
    reviewer:
      kind: command
      command: node D:/tools/my-reviewer.mjs --json
```

**`none`** — analysis and cross-checking still happen; nothing is sent out for review.

**Swap in anything you like**: the contract (what is sent, what comes back, how failure is expressed) lives in
[`docs/reviewer-contract.md`](docs/reviewer-contract.md). Implement one adapter against it, in any language.
The two reference implementations in this repo are meant to be copied (`adapters/http.mjs`, `adapters/exec.mjs`).

## Commands

```
/second-opinion status     current mode and reviewer
/second-opinion check      self-check: print the effective reviewer and exactly how it will be called, and name what is missing
/second-opinion code       only for code-producing requests (default)
/second-opinion always     analyze before acting, always
/second-opinion off        off for this session
```

Mode switching is **per-session** in-process state. It is not written to the session log and resets on restart.

## Boundaries (read this first, so you do not get burned)

- **The reviewer is a reference, not a gate.** It may misread, offer pure style preference, or ask for things you do not need — reject it, and note the reason to yourself.
- **Failing to get a review does not block anything.** If the reviewer times out, errors, is unconfigured, or is not authorized, the agent continues on its own analysis and tells you why in one line. **It will not resend the same payload over and over to get a review** — that is the most expensive way to waste time and tokens.
- **The discipline text is injected into root sessions only.** Subagents do not receive it. Why: a subagent receiving it would run a review it cannot perform (the host caps subagents at depth 1), and every turn would carry an extra block of context.
- **The plugin makes no calls in-process.** It only writes discipline and calling conventions into the context; the actual review is issued by the agent using the host's existing facilities (subagent / HTTP / local command). Issuing HTTP from inside the plugin would mean managing credentials there too, dragging in timeouts, sandbox ACLs and fragile credential resolution — not this plugin's job.
- **Zero external dependencies.** Only `node:` built-ins: the plugin lives in the profile, where no `node_modules` can be resolved upward.
- **Secrets are read from environment variables only.** What you write in the config is a **variable name**. Command-line arguments get printed into error messages and session logs; that has burned people for real.

## How changes take effect

| What you changed | How it takes effect |
|---|---|
| The discipline text in `lib/index.js` | **Restart the client** (the plugin itself is not reloaded) |
| The skill text (the reviewer config is rendered into it) | Same — it is generated once at plugin load |
| The config in your profile | Follows the two rows above |

Measured: after editing the file, a newly opened session still receives the **old** text. Always restart, then confirm in a new session.

## Self-check

No network, no DSH install, no dependencies:

```powershell
node test/run.mjs      # or npm test
```

It covers two layers: the **plugin layer** (calling `apply()` with a fake Cordis context to check what got registered, what the generated text looks like for each of the four reviewer kinds, and whether invalid config is rejected) and the **adapter layer** (a local fake endpoint for the HTTP adapter, a real subprocess for the exec adapter).
It proves the code itself is correct. It **cannot** prove the injected behaviour in a live host — that needs the plugin installed in DSH, a restart, and a real run.

## How it is aligned with the host

"Does the plugin code work" and "does the plugin work inside DSH" are two different things. Here is how far the alignment goes:

- **Injection** goes through `ctx.systemPrompt.section({ text })`. The `context.agent` the `text` callback receives is **the agent currently being assembled** — in the host that is `systemPrompt.assemble(assembleContextFor(agent, signal))`, and `assembleContextFor` is literally `return { agent, scope: agent, ... }`.
- **"Is this a root session"** is decided from `parentSession` / `origin` on `agent.session.header`; both fields are defined in the host's `SessionHeader` interface. The on-disk records of 60+ sessions on this machine agree: subagents always have `origin="subagent"` plus a `parentSession`; sessions a user opens directly have neither.
- **A subagent cannot spawn a subagent** (the host defaults to `maxDepth = 1`), so what "no discipline text for subagents" saves is a wasted review run and one block of context per turn — not protection against infinite recursion.

The above was checked against the **DSH 0.2.0-rc.2** implementation, not guessed. If the host renames a field, the one-shot warning in `lib/index.js` points at the exact place.

**None of this means it runs once installed** — see the next section.

## Relation to dsh-code-review-gate

Another plugin by the same author, [dsh-code-review-gate](https://github.com/alxy1018-ctrl/dsh-code-review-gate), nails "review before acting" into every turn's context, but its reviewer is hard-wired to one kind. This repository is a rework of that idea:

- Kept: analyze → act → cross-check; a missing review never blocks; root sessions only; exclusive file ownership during parallel work.
- Changed: **the reviewer went from hard-wired to pluggable** — a contract plus reference adapters, with no vendor bound by the plugin.
- Also: "no review at this stage" went from a global downgrade to a **per-stage** one; the discipline still applies.

## Known gaps

- **Has not been run end-to-end inside a real DSH instance.** Verification here is in-process stub tests plus local adapter tests; the path "install into a profile, restart, actually get a second opinion" has not been walked once. On first install, watch the output of `/second-opinion check`.
- **The `subagent` kind depends on the host offering a subagent tool**, and on those model routes being authorized in settings. If they are not authorized it does not fall back to another kind; it just tells you no review was obtained.
- **Only two reference adapters** (HTTP / local command). Other kinds (gRPC, message queues, other agent frameworks) are yours to write — the contract is in `docs/reviewer-contract.md`.

## License

MIT
