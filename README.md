# pi-todo-panel

A right-hand to-do panel for [Pi](https://pi.dev). The model plans its work as an ordered list of
steps, the panel shows it while you watch, and the steps get checked off as the model actually
does them — in list order.

```
╭─ TODO ─ 4/7 ────────────────────────╮
│▓▓▓▓▓▓░░░░ 4/7 done                  │
│[✓] 1. Read the extension docs       │
│[✓] 2. Write the panel component     │
│  [✓] 3. Design the overlay options  │
│  [s] 4. Sideways layout spike       │
│[-] 5. Wire the todo tool            │
│[ ] 6. Smoke test the panel          │
│[×] 7. Publish to npm (no access)    │
╰─────────────────────────────────────╯
```

## States

| Bracket | Name | Meaning |
|---|---|---|
| `[ ]` | pending | not started |
| `[-]` | in_progress | the one step being worked on right now |
| `[✓]` | completed | finished successfully |
| `[×]` | blocked | cannot be completed (needs access, a decision, an outside change) |
| `[s]` | skipped | no longer relevant, or the user asked to skip it |

`[×]` and `[s]` clear the way: once an obstacle is marked blocked or skipped, the steps behind it
can be worked on. Put the reason in `note` and the panel shows it in parentheses.

## Ordering rules the tool enforces

* **One step in progress at a time.** A parent step may share `[-]` with its own active sub-step.
* **Work strictly in order.** Starting or completing a step while an earlier step is still open is
  rejected with an explanation. If work really belongs earlier — a dependency you just discovered —
  put it in the right place first with `add` (`before`/`after`/`parent`) or `move`, then do it. The
  list always reads in the order work was actually done, so completed steps never sit behind steps
  that were done later.
* **Reposition, don't jump.** Reopening a finished step also refuses to re-complete it until you
  move it to where the redo actually belongs.
* **Late insertions are respected.** Adding a pending step in front of the active step drops the
  active step back to `[ ]` and tells the model to work the new order.
* **Two levels maximum.** Top-level steps, plus sub-steps (`sub: true`) rendered two spaces in.
* **Parents follow their sub-steps.** A parent goes `[-]` when a sub-step starts, and `[✓]` when all
  sub-steps complete. If some sub-steps were blocked or skipped you decide the parent's fate.

The system-prompt rules that go with this: use the tool for anything with two or more steps, never
write to-do lists as prose or markdown checklists in replies, mark a step `[-]` right before doing
it and `[✓]` the moment it is genuinely done, and don't finish while steps remain open. When a run
would end with open steps, the extension injects one reminder and asks for one more turn.

## Panel

* Drawn as a non-capturing overlay anchored top-right, 30% of the terminal width (minimum 28
  columns), so the transcript keeps keyboard focus and keeps its own width.
* Appears when the list has steps and the terminal is at least 96x14; otherwise it stays out of the
  way. Resize smaller and it disappears, resize back and it returns.
* Long lists scroll to the active step with `↑ n earlier` / `↓ n later` markers.
* `alt+t` toggles it; `/todo hide`, `/todo show`, `/todo toggle` do the same.
* The footer carries a compact `todo 4/7` status, which is also what you get in non-TUI modes.

## `todo` tool

| Action | Purpose | Key parameters |
|---|---|---|
| `plan` | Set the whole ordered list (replaces it; `items: []` clears) | `items` |
| `add` | Insert new steps — appended unless positioned | `items`, `before`, `after`, `parent` |
| `status` | Change step states, reword, attach notes | `changes: [{ id, status, text, note }]` |
| `move` | Reposition a step (its sub-steps travel with it) | `id`, `before`, `after`, `parent` |
| `remove` | Delete steps and their sub-steps | `ids` |
| `list` | Show the current list | — |

`plan` items look like `{ text, status?, sub?, note?, id? }`. Ids are assigned by the tool and never
reused; pass `id` in a `plan` only to pin a step you are keeping. When you omit it, the tool matches
on the step text so an unchanged open step keeps its id across a replan.

New steps normally land at the end. A dependency discovered late is inserted where it belongs:

```json
{ "action": "add", "before": 4, "items": [{ "text": "Fix the failing fixture the spike revealed" }] }
```

## User commands

```
/todo                        show the list
/todo add <step>             append a step
/todo ins <id> <step>        insert a step before <id>
/todo done|progress|skip|block|open <id…>   set states
/todo drop <id…>             delete steps
/todo clear                  empty the list
/todo hide | show | toggle   panel visibility
/todo help
```

User edits skip the in-order claim rules (you own the list) but still keep it well-formed.

## State and persistence

The list is stored in the tool result `details` of every `todo` call, and user edits are appended as
`todo-state` session entries, then rebuilt from the active branch. `/resume`, `/tree`, `/fork` and
`/reload` all bring back the list as it was at that point in history.

## Prompt contributions

Everything the model is told about this extension is defined in `todo-panel.ts`, so it is version
controlled and travels with the repository:

| Source | Where it lands | Included when |
|---|---|---|
| `description` on `registerTool` | the tool schema | the tool is active |
| `promptSnippet` | one line in the `<tools>` section | the tool is active |
| `promptGuidelines` (6 bullets) | appended flat to `<rules>` | the tool is active |
| `agent_before_settle` reminder | an injected `todo-reminder` message mid-run | a run ends with open steps |
| rejection text from `todo` | tool results | an ordering rule is violated |

The guideline bullets are appended flat with no tool-name prefix, which is why each one names `todo`
out loud. Nothing outside the file is involved: there are no `prompts/` or `skills/` resources, no
prompt text in `settings.json`, and no absolute paths in any tracked file.

## Install

Install it as a package from the repository, and Pi keeps the code and its prompt instructions in step
with the remote:

```bash
pi install git:github.com/<you>/pi-todo
pi list                   # show configured packages
pi update --extensions    # reconcile now instead of at next start
```

That writes one line into `~/.pi/agent/settings.json`, which is the only thing to reproduce on a new
machine. Pi clones the source and, on every start and `/reload`, fetches it and resets to the remote
branch, so a fresh computer runs what the remote holds. Pin a ref with
`git:github.com/<you>/pi-todo@v1.0.0` if you would rather it stop tracking the branch tip —
`pi update --extensions` still reconciles the checkout but does not move a configured ref.
`pi remove git:github.com/<you>/pi-todo` undoes the install.

Other ways to run it:

```bash
pi -e ./todo-panel.ts                                  # this invocation only
pi install ./pi-todo --local                          # .pi/settings.json, loaded after project trust
cp todo-panel.ts ~/.pi/agent/extensions/todo-panel.ts # plain global copy
ln -s "$PWD/todo-panel.ts" ~/.pi/agent/extensions/todo-panel.ts  # symlink into a clone
```

`package.json` lists `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`,
`@earendil-works/pi-tui` and `typebox` as optional peer dependencies: Pi provides all four, so they
must not be bundled as real dependencies. `npm test` resolves them from the local Pi install.

### Which install method keeps the prompts correct

| Method | Freshness of the prompt text |
|---|---|
| `pi install git:<repo>` | follows the remote; re-fetched at start and on `/reload` |
| symlink into a clone | follows the clone; as fresh as your last `git pull` |
| `cp` into `~/.pi/agent/extensions/` | frozen at copy time, silently |

A copied file is the one to avoid: nothing updates it, so a new machine — or this one in three months —
can be running an older `<rules>` block with no signal anywhere. If you do copy it, re-copy on every
change. `/reload` picks up a file that has changed in place.

Confirm what a machine is actually running by hashing the loaded file against the repo:

```bash
shasum -a 256 todo-panel.ts
find ~/.pi/agent -name todo-panel.ts -not -path '*/sessions/*' -print0 | xargs -0 shasum -a 256
```

Matching hashes mean that machine is running the copy you have checked out.

## Test

```bash
npm test        # node test/run.mjs
```

`test/run.mjs` loads the extension with jiti (Pi's own TypeScript loader), hands it a stand-in
`ExtensionAPI`, and exercises the plan/status/move rules, parent derivation, dependency insertion,
panel rendering and scrolling, user commands, the toggle shortcut, and the settle reminder. It needs
the `pi` binary on `PATH`, or `PI_ROOT` pointing at a `pi-coding-agent` package directory.

## Implementation notes

* The panel is a persistent `tui.showOverlay()` component with `nonCapturing: true`, which is the
  documented way to draw alongside the interface without stealing input. The live `TUI` handle comes
  from an invisible widget below the editor: it renders zero lines (and Pi adds no spacer below the
  editor), and disposing it removes the overlay, so `/reload` and session swaps start clean.
* Terminal size is captured from the overlay's `visible(cols, rows)` hook, which runs before every
  render — that is what lets the panel size its own scroll window instead of being sliced.
* Everything else is plain state in a closure plus session entries; no files are written.
