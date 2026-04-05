# Contributing to Paseo

Thanks for taking the time to contribute.

## Before you start

Please read these first:

- [README.md](README.md)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
- [docs/CODING_STANDARDS.md](docs/CODING_STANDARDS.md)
- [docs/TESTING.md](docs/TESTING.md)
- [CLAUDE.md](CLAUDE.md)

## What is most helpful

The highest-signal contributions right now are:

- bug fixes
- regression fixes
- docs improvements
- packaging / platform fixes
- focused UX improvements that fit the existing product direction
- tests that lock down important behavior

## Discuss large changes first

If you want to add a major feature, change core UX, introduce a new surface, or bring in a new architectural concept, please open an issue or start a conversation first.

Even if the code is good, large unsolicited PRs are unlikely to be merged if they set product direction without prior alignment.

In short:

- small, focused PRs: great
- large product-shaping PRs without discussion: probably not

## Scope expectations

Please keep PRs narrow.

Good:

- fix one bug
- improve one flow
- add one focused panel or command
- tighten one piece of UI

Bad:

- combine multiple product ideas in one PR
- bundle unrelated refactors with a feature
- sneak in roadmap decisions

If a contribution contains multiple ideas, split it up.

## Product fit matters

Paseo is an opinionated product.

When reviewing contributions, the bar is not just:

- is this useful?
- is this well implemented?

It is also:

- does this fit Paseo?
- does this preserve the product's current direction?
- does this increase long-term complexity in a way that is worth it?

## Development setup

### Prerequisites

- Node.js matching `.tool-versions`
- npm workspaces

### Start local development

```bash
npm run dev
```

Useful commands:

```bash
npm run dev:server
npm run dev:app
npm run dev:desktop
npm run dev:website
npm run cli -- ls -a -g
```

Read [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for build-sync gotchas, local state, ports, and daemon details.

## Testing and verification

At minimum, run the checks relevant to your change.

Common checks:

```bash
npm run typecheck
npm run test --workspaces --if-present
```

Important rules:

- always run `npm run typecheck` after changes
- tests should be deterministic
- prefer real dependencies over mocks when possible
- do not make breaking WebSocket / protocol changes
- app and daemon versions in the wild lag each other, so compatibility matters

If you touch protocol or shared client/server behavior, read the compatibility notes in [CLAUDE.md](CLAUDE.md).

## Coding standards

Paseo has explicit standards. Please follow them.

Highlights:

- keep complexity low
- avoid "while I'm at it" cleanup
- no `any`
- prefer object parameters over positional argument lists
- preserve behavior unless the change is explicitly meant to change behavior
- collocate tests with implementation

The full guide lives in [docs/CODING_STANDARDS.md](docs/CODING_STANDARDS.md).

## PR checklist

Before opening a PR, make sure:

- the change is focused
- the PR description explains what changed and why
- relevant docs were updated if needed
- typecheck passes
- tests pass, or you clearly explain what could not be run
- the change does not accidentally bundle unrelated product ideas

## Communication

If you are unsure whether something fits, ask first.

That is especially true for:

- new core UX
- naming / terminology changes
- new extension points
- new orchestration models
- anything that would be hard to remove later

Early alignment is much better than a large PR that is expensive for everyone to unwind.

## Forks are fine

If you want to explore a different product direction, a fork is completely fine.

Paseo is open source on purpose. Not every idea needs to land in the main repo to be valuable.
