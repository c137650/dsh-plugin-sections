# dsh-plugin-sections

Rewrite DeepSeek Harness's own system-prompt sections with your own text.

The system prompt is assembled from named sections every request. Registering a section with an existing **name** shadows that section — the built-in text is replaced, not appended. That is the whole mechanism.

## Why two layers

DSH registers its sections in two different places, and a section can only be shadowed from the same layer:

- **Global** — `app:web-surface`, `harness:source`. One same-name registration on the root context replaces them.
- **Per agent** — `team:policy`, `ui:deliverable-file-references`, `deployment:persona-prefix`. These belong to each agent's own system-prompt instance, so the root context only sees an empty placeholder for them. They can only be replaced by registering through that agent's `ctx`, which is what this plugin does on `agent/created`.

An agent that already existed before this plugin loaded never fires `agent/created` again. For those, call the manual endpoint once with the session id.

## The text file

`prompts/dsh-sections-zh.txt`, one block per section, headed by `【<section name> · <anything you like>】`:

```
【app:web-surface · the interface I talk through】

<the text that should replace the built-in section>

【harness:source · where to look up DSH itself】

<...>
```

The token before `·` must be the exact section name. Blocks whose name is not in the table below are reported as `skipped` and do nothing.

| Section | Order | Layer |
| --- | --- | --- |
| `deployment:persona-prefix` | 0 | agent (blanked) |
| `team:policy` | 600 | agent |
| `ui:deliverable-file-references` | 9000 | agent |
| `harness:source` | 10000 | global |
| `app:web-surface` | 10100 | global |

Orders are copied from DSH's own `SECTION_ORDERS`, so a replaced section keeps its position.

## HTTP

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/dsh-sec/state` | what applied, what failed, what was skipped |
| `GET` | `/dsh-sec/state?reload=1` | re-read the file and re-register the global sections |
| `GET` | `/dsh-sec/apply-agent?sid=<session id>` | hang the agent-level sections on one live session |

`deployment:persona-prefix` is always registered blank — that is how the deployment's own "you are a coding agent powered by …" line is removed.

## Install

```bash
pnpm add link:/path/to/dsh-plugin-sections
```

Then add `dsh-plugin-sections` to `dsh.profile.bundles` in the profile's `package.json`, next to your other plugins, and restart DSH.

## Limits

- An empty result is not the same as no section: a blanked section still occupies its order in the assembly. That is intended — the built-in text is what matters, not the slot.
- Tool descriptions are **not** sections. They travel as schemas in the request's `tools` field; nothing here can change them.
- If a name in the file does not match a registered section, the registration simply adds a new section with that name — check `/dsh-sec/state` and compare with `/dsh-mp/sections` in `dsh-plugin-masterprompt`, which lists the assembly order.

## License

MIT
