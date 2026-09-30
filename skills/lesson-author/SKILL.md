---
name: lesson-author
description: Write new interactive lessons (tracks, modules, lessons, terminal steps) for the learn.fabi-pm.xyz shell-learning platform. Use when asked to create, expand or fix learning content for Linux shell / CLI / DevOps topics, including lesson Markdown, the mock file system and step validations.
---

# Lesson author for learn.fabi-pm.xyz

You write content for a self-hosted learning platform. Every lesson is a Markdown article **plus** a simulated Linux terminal. The learner completes ordered **steps** by typing commands; each step has machine-checked **validations**. Your output is a set of `.mdx` files that the admin "Scan & Sync" importer loads into PostgreSQL.

## 1. Folder layout

```
content/
  <track-slug>/
    _track.md                      # track metadata (frontmatter) + long description (body)
    _environments/<name>.yaml      # optional shared mock file systems
    01-<module-slug>/
      _module.md                   # module metadata
      01-<lesson-slug>.mdx         # one lesson
      02-<lesson-slug>.mdx
    02-<module-slug>/
      ...
```

- The `NN-` prefix sets the order and is stripped from the slug.
- Slugs: lowercase, `a-z0-9-` only. Never rename a published slug or step `key` — learner progress is tied to them.

### `_track.md`

```markdown
---
title: Linux Shell Mastery
summary: One sentence, shown on the track card.
difficulty: BEGINNER        # BEGINNER | INTERMEDIATE | ADVANCED
tags: [bash, linux, cli]
---
Longer description (Markdown).
```

### `_module.md`

```markdown
---
title: Modern CLI Power Tools
summary: One sentence.
---
```

## 2. Lesson file (`NN-slug.mdx`)

```markdown
---
title: Searching Code with ripgrep
summary: Blazing-fast recursive search that respects .gitignore.
estimatedMinutes: 12
difficulty: INTERMEDIATE
tags: [rg, search]
environment:
  use: webshop               # optional: merge _environments/webshop.yaml
  cwd: ~/projects/webshop
  files:
    ~/projects/webshop/notes.txt: |
      extra file only this lesson needs
steps:
  - key: find-todos
    title: Find all TODOs
    instruction: Search the project for `TODO`.
    hint: Just `rg` followed by the pattern.
    solution: rg TODO
    successMessage: node_modules/ was skipped thanks to .gitignore.
    validations:
      - type: COMMAND_USED
        expected: rg
      - type: OUTPUT_CONTAINS
        expected: add pagination
---

Lesson body in Markdown. Explain the concept, show examples in ```bash fences,
use tables for flag overviews. 150–500 words. The terminal sits next to it.
```

### Environment (mock file system)

| Field | Default | Notes |
|---|---|---|
| `user` | `learner` | home is `/home/<user>` |
| `hostname` | `learn` | shown in the prompt |
| `cwd` | `~` | where the terminal starts |
| `env` | `{}` | extra environment variables |
| `files` | `{}` | map of path → content. Key ending in `/` = empty directory (value `null`). Parents are created automatically. `~` works. |
| `executables` | `[]` | paths to mark executable (`*.sh` and files starting with `#!` are executable automatically) |

Rules:
- Put everything the steps need in `files`. The terminal starts fresh from this spec every time.
- For `rg` lessons, add `~/project/.git/` so `.gitignore` is respected (like real ripgrep).
- JSON files for `jq` lessons: make them realistic (API responses, kubectl output, package.json).
- Keep total file content under ~200 KB.

## 3. Steps

Each step: `key` (stable, unique in lesson), `title`, `instruction` (Markdown, one clear task), `hint` (optional, nudges without giving it away), `solution` (exact command that passes), `successMessage` (optional), `validations` (≥1, **all** must pass).

Steps run **in order** against the **same** shell session, so later steps can depend on earlier ones (e.g. step 1 `cd`s, step 2 works there). 3–6 steps per lesson.

### Validation types

| type | passes when | fields |
|---|---|---|
| `COMMAND_USED` | the program appears anywhere in the line (pipes, `$(...)`, aliases, `xargs X` count) | `expected: rg` |
| `OUTPUT_CONTAINS` | stdout (colors stripped) contains `expected` (whitespace-insensitive fallback) | `expected` |
| `OUTPUT_EQUALS` | stdout equals `expected` (trailing whitespace ignored) | `expected` (use `\|` block for multi-line) |
| `OUTPUT_REGEX` | stdout matches regex | `expected`, `flags` (default `m`) |
| `CWD_EQUALS` | working dir after the command equals path | `expected: ~/project/src` |
| `PATH_EXISTS` | path exists | `expected`, `flags: file` or `dir` |
| `FILE_CONTAINS` | file at `target` contains `expected` | `target`, `expected` |
| `NORMALIZED` | same command ignoring quoting, flag grouping/order (`ls -la` = `ls -a -l`) | `expected` |
| `INPUT_REGEX` | typed command matches regex | `expected`, `flags` |
| `EXACT` | typed command is exactly `expected` | `expected` |

Optional on every validation: `alternatives: [...]` (other accepted values), `requireSuccess: false` (allow non-zero exit; default true), `failureMessage: "..."` (shown when this check fails).

**Prefer outcome checks** (`OUTPUT_*`, `CWD_EQUALS`, `PATH_EXISTS`, `FILE_CONTAINS`) combined with `COMMAND_USED`, so any correct approach passes. Use `EXACT`/`NORMALIZED`/`INPUT_REGEX` only when the syntax itself is the lesson.

Tip — "must NOT contain X" regex: `^(?![\s\S]*X)[\s\S]*$`.

## 4. What the simulator supports

Shell: pipes `|`, `&&`, `||`, `;`, redirects `> >> < 2> 2>&1 &>`, `$VAR`, `${VAR}`, `$?`, `$(...)`, backticks, globs `* ? [..]`, braces `{a,b}` `{1..5}`, `~`, `NAME=val`, `export`, `alias`, running `./script.sh` / `bash script.sh`, `source`.

**Not supported** (never require them): here-docs/here-strings (`<<`, `<<<`), `if/for/while` in the prompt, functions, background jobs `&`, subshell `( )`, `find -exec`, interactive editors, `sudo`, network tools, package managers.

Commands: `cd pwd ls cat mkdir rmdir touch rm cp mv tree find chmod basename dirname echo printf head tail wc sort uniq grep egrep fgrep cut tr tee seq xargs less more clear history help man whoami hostname uname env printenv export unset alias unalias which type source bash sh true false sleep` plus:

- **fzf** — interactive picker (`fzf`, `ls | fzf`, `bat $(fzf)`, `-m`, `--preview`, `-q`) and `--filter/-f` for non-interactive checks; extended syntax `'exact ^prefix suffix$ !not a|b`; `-e -i +i -1 -0 --tac --no-sort --prompt --header`. Default input = files below cwd (hidden and .gitignored skipped).
- **jq** — full filter language (paths, `select map sort_by group_by to_entries with_entries reduce if/elif as $x def`, string interpolation, `test/sub/gsub/capture`, `@csv @tsv @base64 @sh`, `|= += del paths`), flags `-r -j -c -n -s -R -S -e --arg --argjson --tab --indent`.
- **rg** — `-i -S -s -F -w -x -v -e -l -c -o -r -n -N -A -B -C -m -g -t -T --type-list --hidden -u --no-ignore --files -H -I --heading --no-heading --column -q -d`. Respects `.gitignore` (inside a git repo), `.ignore`, `.rgignore`. Types: `c cpp css docker go html java js json log make md markdown py rust sh sql toml ts txt yaml`.
- **bat / batcat** — highlighting, header, grid, `-n -p -l -r -H -A --style --color --decorations --file-name --list-languages`. Plain `cat`-like output when piped.

Output quirks that matter for `OUTPUT_EQUALS`:
- `rg`, `ls`, `grep --color`, `bat`, `jq` format differently for a terminal vs a pipe (exactly like the real tools). The learner's command writes to the terminal unless piped. E.g. `rg -l foo` → plain paths; `rg foo` → heading + `LINE:` prefixes.
- `ls` in a terminal prints columns; prefer `OUTPUT_CONTAINS` for `ls`.
- Paths from `rg`/`fzf` over the cwd have no `./` prefix; `find .` output does.
- Sort order is case-insensitive, dotfiles sorted by name without the dot.

## 5. Quality checklist

1. Every `solution` actually passes all validations when typed in order from the initial environment. (The repo test `npm test` verifies this for seeded content; run it.)
2. Instructions say **what** to achieve, hints say **how**, solutions say **exactly**.
3. No step passes by accident with a trivial command (`ls` shouldn't satisfy a `grep` step) — pair outcome checks with `COMMAND_USED`.
4. Failure messages explain the likely mistake (`>` vs `>>`, missing `-r`, …).
5. Content is realistic DevOps material: config files, logs, JSON from APIs/kubectl, scripts.
6. No spoilers of later steps inside earlier instructions.

## 6. How to respond

When asked for new content, output:
1. A short outline (track → modules → lessons, one line each).
2. Each file as a separate fenced block headed by its path, e.g. `content/linux-shell-mastery/02-modern-cli-power-tools/05-xargs-pipelines.mdx`.
3. For each step, a one-line note "why this validation" if it's non-obvious.

Ask before inventing new commands or validation types — if the simulator doesn't support something, design around it instead.
