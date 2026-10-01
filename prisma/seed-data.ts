/**
 * Launch content for the "Linux Shell Mastery" track.
 * Kept separate from seed.ts so tests can verify that every step's reference
 * solution really passes in the terminal simulator (src/lib/terminal/seed.test.ts).
 */

import type { EnvironmentSpecInput, ValidationRule } from "../src/lib/terminal/types";

export interface SeedStep {
  key: string;
  title: string;
  instruction: string;
  hint?: string;
  solution: string;
  successMessage?: string;
  validations: ValidationRule[];
}

export interface SeedLesson {
  slug: string;
  title: string;
  summary: string;
  estimatedMinutes: number;
  difficulty: "BEGINNER" | "INTERMEDIATE" | "ADVANCED";
  tags: string[];
  body: string;
  environment: EnvironmentSpecInput;
  steps: SeedStep[];
}

export interface SeedModule {
  slug: string;
  title: string;
  summary: string;
  lessons: SeedLesson[];
}

export interface SeedTrack {
  slug: string;
  title: string;
  summary: string;
  description: string;
  difficulty: "BEGINNER" | "INTERMEDIATE" | "ADVANCED";
  tags: string[];
  modules: SeedModule[];
}

const WEBSHOP_FILES: Record<string, string | null> = {
  "~/projects/webshop/.git/": null,
  "~/projects/webshop/.gitignore": "node_modules/\ndist/\n*.log\n.env\n",
  "~/projects/webshop/.env": "DATABASE_URL=postgres://shop:secret@localhost/shop\nSTRIPE_KEY=sk_test_123\n",
  "~/projects/webshop/README.md": "# Webshop\n\nA tiny demo shop used in the shell lessons.\n\n## Scripts\n\n- `npm run dev` — start the dev server\n- `npm test` — run the tests\n\nTODO: document the deployment process\n",
  "~/projects/webshop/package.json": JSON.stringify(
    {
      name: "webshop",
      version: "1.4.2",
      private: true,
      scripts: { dev: "vite", build: "vite build", test: "vitest run" },
      dependencies: { express: "^4.19.2", zod: "^3.23.8" },
      devDependencies: { vite: "^5.4.0", vitest: "^2.0.5" },
    },
    null,
    2,
  ) + "\n",
  "~/projects/webshop/src/server.ts":
    'import express from "express";\nimport { listProducts } from "./products";\nimport { logger } from "./utils/logger";\n\nconst app = express();\nconst PORT = Number(process.env.PORT ?? 3000);\n\napp.get("/api/products", async (_req, res) => {\n  // TODO: add pagination\n  res.json(await listProducts());\n});\n\napp.listen(PORT, () => logger.info(`listening on ${PORT}`));\n',
  "~/projects/webshop/src/products.ts":
    'export interface Product {\n  id: number;\n  name: string;\n  price: number;\n  inStock: boolean;\n}\n\nconst PRODUCTS: Product[] = [\n  { id: 1, name: "Mechanical Keyboard", price: 129, inStock: true },\n  { id: 2, name: "USB-C Hub", price: 49, inStock: false },\n];\n\nexport async function listProducts(): Promise<Product[]> {\n  // FIXME: load from the database instead of a constant\n  return PRODUCTS;\n}\n',
  "~/projects/webshop/src/utils/logger.ts":
    'type Level = "info" | "warn" | "error";\n\nfunction log(level: Level, message: string) {\n  console.log(`[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`);\n}\n\nexport const logger = {\n  info: (m: string) => log("info", m),\n  warn: (m: string) => log("warn", m),\n  error: (m: string) => log("error", m),\n};\n',
  "~/projects/webshop/src/utils/format.ts": "export const formatPrice = (cents: number) => `€${(cents / 100).toFixed(2)}`;\n",
  "~/projects/webshop/tests/products.test.ts":
    'import { describe, expect, it } from "vitest";\nimport { listProducts } from "../src/products";\n\ndescribe("listProducts", () => {\n  it("returns products", async () => {\n    expect((await listProducts()).length).toBeGreaterThan(0);\n  });\n});\n',
  "~/projects/webshop/scripts/deploy.sh": "#!/usr/bin/env bash\nset -euo pipefail\n\n# TODO: replace with a proper CI pipeline\nnpm run build\nrsync -av dist/ deploy@shop.example.com:/srv/webshop/\necho \"deployed $(date)\"\n",
  "~/projects/webshop/node_modules/express/index.js": "// TODO: this is vendored code — rg should skip it\nmodule.exports = function express() {};\n",
  "~/projects/webshop/dist/bundle.js": "// TODO: generated file\n",
  "~/projects/webshop/server.log": "[info] TODO: rotate logs\n[error] connection refused\n",
};

const ORDERS_JSON = JSON.stringify(
  {
    generatedAt: "2026-09-01T08:00:00Z",
    orders: [
      { id: "A-1001", customer: { name: "Ada Lovelace", email: "ada@example.com" }, status: "shipped", total: 129.0, items: [{ sku: "KB-01", qty: 1 }] },
      { id: "A-1002", customer: { name: "Linus Torvalds", email: "linus@example.com" }, status: "pending", total: 49.5, items: [{ sku: "HUB-02", qty: 1 }] },
      { id: "A-1003", customer: { name: "Grace Hopper", email: "grace@example.com" }, status: "shipped", total: 312.25, items: [{ sku: "KB-01", qty: 2 }, { sku: "MS-07", qty: 1 }] },
      { id: "A-1004", customer: { name: "Ken Thompson", email: "ken@example.com" }, status: "cancelled", total: 18.99, items: [{ sku: "CB-11", qty: 3 }] },
    ],
  },
  null,
  2,
);

const K8S_PODS_JSON = JSON.stringify({
  items: [
    { metadata: { name: "api-7d9f", namespace: "shop" }, status: { phase: "Running", restartCount: 0 } },
    { metadata: { name: "worker-5c2a", namespace: "shop" }, status: { phase: "CrashLoopBackOff", restartCount: 14 } },
    { metadata: { name: "db-0", namespace: "data" }, status: { phase: "Running", restartCount: 1 } },
  ],
});

export const TRACKS: SeedTrack[] = [
  {
    slug: "linux-shell-mastery",
    title: "Linux Shell Mastery",
    summary: "From `cd` to fuzzy-finding your way through codebases with fzf, jq, ripgrep and bat.",
    description:
      "Start with the fundamentals every engineer uses daily, then add the modern CLI tools that make DevOps work fast: ripgrep for searching, jq for JSON, fzf for fuzzy selection and bat for reading code.",
    difficulty: "BEGINNER",
    tags: ["bash", "linux", "cli", "devops"],
    modules: [
      {
        slug: "shell-basics",
        title: "Shell Basics",
        summary: "Move around the file system and create, read and combine files.",
        lessons: [
          {
            slug: "navigating-the-filesystem",
            title: "Navigating the File System",
            summary: "pwd, ls and cd — knowing where you are and getting where you want to be.",
            estimatedMinutes: 8,
            difficulty: "BEGINNER",
            tags: ["pwd", "ls", "cd"],
            environment: { cwd: "~", files: WEBSHOP_FILES },
            body: `Every shell session has a **current working directory**. Commands that take relative paths resolve them from there.

## Where am I?

\`pwd\` (*print working directory*) prints the absolute path of the current directory:

\`\`\`bash
$ pwd
/home/learner
\`\`\`

\`~\` is shorthand for your home directory, so \`~/projects\` means \`/home/learner/projects\`.

## What's here?

\`ls\` lists a directory. The most useful flags:

| Flag | Meaning |
| ---- | ------- |
| \`-l\` | long format: permissions, size, modification time |
| \`-a\` | include hidden "dotfiles" such as \`.gitignore\` |
| \`-h\` | human-readable sizes (with \`-l\`) |

Flags can be combined: \`ls -la\` is the same as \`ls -l -a\`.

## Moving around

\`cd PATH\` changes directory. A few special paths:

- \`cd ..\` — one level up
- \`cd\` or \`cd ~\` — home
- \`cd -\` — back to the previous directory

> **Tip:** press `Tab` to complete file and directory names. Press it twice to see all candidates.`,
            steps: [
              {
                key: "print-cwd",
                title: "Find out where you are",
                instruction: "Print the absolute path of your current working directory.",
                hint: "The command is an abbreviation of *print working directory*.",
                solution: "pwd",
                validations: [{ type: "COMMAND_USED", expected: "pwd" }, { type: "OUTPUT_CONTAINS", expected: "/home/learner" }],
              },
              {
                key: "enter-project",
                title: "Enter the webshop project",
                instruction: "Change into `~/projects/webshop`.",
                hint: "`cd` accepts a path relative to where you are, or one starting with `~`.",
                solution: "cd ~/projects/webshop",
                successMessage: "You're in the project now.",
                validations: [{ type: "CWD_EQUALS", expected: "~/projects/webshop" }],
              },
              {
                key: "list-hidden",
                title: "Reveal hidden files",
                instruction: "List **all** files in the project in long format, including dotfiles like `.gitignore` and `.env`.",
                hint: "Combine the long-format flag with the flag that shows entries starting with a dot.",
                solution: "ls -la",
                validations: [
                  { type: "COMMAND_USED", expected: "ls" },
                  { type: "OUTPUT_CONTAINS", expected: ".gitignore" },
                  { type: "OUTPUT_REGEX", expected: "^[-d]rw", flags: "m", failureMessage: "Use the long listing format so permissions are shown." },
                ],
              },
              {
                key: "go-utils",
                title: "Dive into a nested directory",
                instruction: "Change into the `src/utils` directory of the project.",
                solution: "cd src/utils",
                validations: [{ type: "CWD_EQUALS", expected: "~/projects/webshop/src/utils" }],
              },
              {
                key: "up-two",
                title: "Climb back up",
                instruction: "Go **two levels up** in a single command so you're back in the project root.",
                hint: "`..` means \"parent directory\" and can be chained with `/`.",
                solution: "cd ../..",
                validations: [{ type: "CWD_EQUALS", expected: "~/projects/webshop" }, { type: "INPUT_REGEX", expected: "\\.\\./\\.\\.", failureMessage: "Use a relative path with `..` twice." }],
              },
            ],
          },
          {
            slug: "creating-and-combining-files",
            title: "Creating & Combining Files",
            summary: "mkdir, echo, redirection, cat and your first pipelines.",
            estimatedMinutes: 10,
            difficulty: "BEGINNER",
            tags: ["mkdir", "echo", "cat", "pipes"],
            environment: { cwd: "~/projects/webshop", files: WEBSHOP_FILES },
            body: `## Directories

\`mkdir DIR\` creates a directory. With \`-p\` it also creates missing parents and doesn't complain if the directory exists. Brace expansion creates several at once:

\`\`\`bash
mkdir -p docs/{guides,api}
\`\`\`

## Writing files with redirection

The shell can send a command's output into a file instead of the terminal:

- \`>\` **overwrites** the file (creating it if needed)
- \`>>\` **appends** to the file

\`\`\`bash
echo "# Changelog" > CHANGELOG.md
echo "- initial release" >> CHANGELOG.md
\`\`\`

## Reading files

\`cat FILE\` prints a file. \`cat -n\` adds line numbers.

## Pipes

The pipe \`|\` feeds one command's output into the next command's input. This is the core idea of the Unix philosophy: small tools, combined.

\`\`\`bash
ls src | wc -l        # how many entries are in src?
cat README.md | grep TODO
\`\`\``,
            steps: [
              {
                key: "mkdir-docs",
                title: "Create a docs tree",
                instruction: "Create both `docs/guides` and `docs/api` with a **single** command.",
                hint: "`mkdir -p` plus brace expansion: `{a,b}`.",
                solution: "mkdir -p docs/{guides,api}",
                validations: [
                  { type: "PATH_EXISTS", expected: "~/projects/webshop/docs/guides", flags: "dir" },
                  { type: "PATH_EXISTS", expected: "~/projects/webshop/docs/api", flags: "dir" },
                ],
              },
              {
                key: "write-changelog",
                title: "Start a changelog",
                instruction: "Create `CHANGELOG.md` containing the line `# Changelog`.",
                solution: 'echo "# Changelog" > CHANGELOG.md',
                validations: [{ type: "FILE_CONTAINS", target: "~/projects/webshop/CHANGELOG.md", expected: "# Changelog" }],
              },
              {
                key: "append-entry",
                title: "Append an entry",
                instruction: "Append the line `- v1.4.2: first release` to `CHANGELOG.md` **without** overwriting the heading.",
                hint: "One `>` overwrites, two append.",
                solution: 'echo "- v1.4.2: first release" >> CHANGELOG.md',
                validations: [
                  { type: "FILE_CONTAINS", target: "~/projects/webshop/CHANGELOG.md", expected: "# Changelog" , failureMessage: "The heading is gone — did you use `>` instead of `>>`? Recreate it and append again." },
                  { type: "FILE_CONTAINS", target: "~/projects/webshop/CHANGELOG.md", expected: "- v1.4.2: first release" },
                ],
              },
              {
                key: "cat-numbered",
                title: "Read it back with line numbers",
                instruction: "Print `CHANGELOG.md` with line numbers.",
                solution: "cat -n CHANGELOG.md",
                validations: [{ type: "COMMAND_USED", expected: "cat" }, { type: "OUTPUT_REGEX", expected: "^\\s+2\\s+- v1\\.4\\.2", flags: "m" }],
              },
              {
                key: "count-src",
                title: "Your first pipeline",
                instruction: "Count how many `.ts` files live directly in `src` by piping `ls` into `wc -l`.",
                hint: "`ls src/*.ts | wc -l`",
                solution: "ls src/*.ts | wc -l",
                validations: [{ type: "COMMAND_USED", expected: "wc" }, { type: "OUTPUT_EQUALS", expected: "2" }],
              },
            ],
          },
        ],
      },
      {
        slug: "modern-cli-power-tools",
        title: "Modern CLI Power Tools",
        summary: "ripgrep, jq, fzf and bat — the tools that make working in a terminal fast.",
        lessons: [
          {
            slug: "ripgrep-search",
            title: "Searching Code with ripgrep",
            summary: "Blazing-fast recursive search that respects .gitignore.",
            estimatedMinutes: 12,
            difficulty: "INTERMEDIATE",
            tags: ["rg", "ripgrep", "search"],
            environment: { cwd: "~/projects/webshop", files: WEBSHOP_FILES },
            body: `\`rg\` (ripgrep) searches recursively from the current directory by default. Compared with \`grep -r\` it is:

- **smart about noise** — it skips hidden files and everything listed in \`.gitignore\` (inside a git repository), so \`node_modules/\`, build output and logs don't drown your results;
- **fast** and colorful, grouping matches by file with line numbers.

\`\`\`bash
rg TODO                 # search everything (minus ignored files)
rg -i "todo|fixme"      # case-insensitive, regex alternation
rg -t ts listProducts   # only TypeScript files (see: rg --type-list)
rg -l TODO              # only the names of matching files
rg -c TODO              # match counts per file
rg -g '!tests' TODO     # exclude paths with a glob
rg --no-ignore TODO     # include ignored files too
\`\`\`

When \`rg\` writes to a pipe it switches to a grep-like \`path:line\` format — perfect for further processing.`,
            steps: [
              {
                key: "find-todos",
                title: "Find all TODOs",
                instruction: "Search the project for `TODO`. Notice which files are **not** in the results.",
                solution: "rg TODO",
                validations: [
                  { type: "COMMAND_USED", expected: "rg" },
                  { type: "OUTPUT_CONTAINS", expected: "add pagination" },
                  { type: "OUTPUT_CONTAINS", expected: "document the deployment" },
                ],
                successMessage: "node_modules/, dist/ and *.log were skipped thanks to .gitignore.",
              },
              {
                key: "case-insensitive",
                title: "TODO or FIXME, any case",
                instruction: "Find lines containing `todo` **or** `fixme` in any letter case.",
                hint: "Use `-i` and a regex alternation in quotes: `\"todo|fixme\"`.",
                solution: 'rg -i "todo|fixme"',
                validations: [{ type: "COMMAND_USED", expected: "rg" }, { type: "OUTPUT_CONTAINS", expected: "FIXME: load from the database" }, { type: "OUTPUT_CONTAINS", expected: "add pagination" }],
              },
              {
                key: "files-only",
                title: "Just the file names",
                instruction: "List only the **paths** of TypeScript files that mention `listProducts`.",
                hint: "Combine `-l` with `-t ts`.",
                solution: "rg -l -t ts listProducts",
                validations: [
                  { type: "COMMAND_USED", expected: "rg" },
                  { type: "OUTPUT_EQUALS", expected: "src/products.ts\nsrc/server.ts\ntests/products.test.ts" },
                ],
              },
              {
                key: "no-ignore",
                title: "Include ignored files",
                instruction: "Count TODOs per file **including** files ignored by `.gitignore`.",
                hint: "`-c` counts, `--no-ignore` disables ignore files.",
                solution: "rg -c --no-ignore TODO",
                validations: [{ type: "COMMAND_USED", expected: "rg" }, { type: "OUTPUT_CONTAINS", expected: "node_modules/express/index.js:1" }],
              },
            ],
          },
          {
            slug: "jq-json-processing",
            title: "Slicing JSON with jq",
            summary: "Pretty-print, filter and reshape JSON from APIs and tools like kubectl.",
            estimatedMinutes: 15,
            difficulty: "INTERMEDIATE",
            tags: ["jq", "json"],
            environment: {
              cwd: "~/data",
              files: { "~/data/orders.json": ORDERS_JSON + "\n", "~/data/pods.json": K8S_PODS_JSON + "\n" },
            },
            body: `\`jq\` is \`sed\` for JSON. A jq program is a **filter**: it takes JSON in and produces JSON out.

\`\`\`bash
jq . orders.json                      # pretty-print (identity filter)
jq '.orders[0].id' orders.json        # navigate into objects and arrays
jq '.orders[].customer.name' orders.json   # [] iterates over an array
\`\`\`

Filters chain with \`|\`, just like shell pipes:

\`\`\`bash
jq '.orders[] | select(.status == "shipped") | .id' orders.json
jq '[.orders[].total] | add' orders.json
jq '.orders | map({id, email: .customer.email})' orders.json
\`\`\`

Useful flags:

- \`-r\` — raw output: print strings without quotes (great for piping into other tools)
- \`-c\` — compact, one JSON value per line
- \`--arg name value\` — pass a shell value into the program as \`$name\``,
            steps: [
              {
                key: "pretty",
                title: "Pretty-print",
                instruction: "Pretty-print `pods.json` (it's minified).",
                solution: "jq . pods.json",
                validations: [{ type: "COMMAND_USED", expected: "jq" }, { type: "OUTPUT_CONTAINS", expected: '"name": "worker-5c2a"' }],
              },
              {
                key: "customer-names",
                title: "Extract a field from every element",
                instruction: "Print the name of every customer in `orders.json` as **raw** strings (no quotes).",
                hint: "`.orders[]` iterates, `.customer.name` navigates, `-r` removes quotes.",
                solution: "jq -r '.orders[].customer.name' orders.json",
                validations: [
                  { type: "COMMAND_USED", expected: "jq" },
                  { type: "OUTPUT_EQUALS", expected: "Ada Lovelace\nLinus Torvalds\nGrace Hopper\nKen Thompson" },
                ],
              },
              {
                key: "select-shipped",
                title: "Filter with select",
                instruction: "Print the `id` of every order whose `status` is `shipped` (raw output).",
                solution: "jq -r '.orders[] | select(.status == \"shipped\") | .id' orders.json",
                validations: [{ type: "COMMAND_USED", expected: "jq" }, { type: "OUTPUT_EQUALS", expected: "A-1001\nA-1003" }],
              },
              {
                key: "sum-totals",
                title: "Aggregate",
                instruction: "Compute the sum of all order `total`s.",
                hint: "Collect the totals into an array with `[...]`, then pipe to `add`.",
                solution: "jq '[.orders[].total] | add' orders.json",
                validations: [{ type: "COMMAND_USED", expected: "jq" }, { type: "OUTPUT_EQUALS", expected: "509.74" }],
              },
              {
                key: "crashing-pods",
                title: "Real-world: find crashing pods",
                instruction: "From `pods.json`, print the names of pods that are **not** `Running` (raw output).",
                hint: "`.items[] | select(.status.phase != \"Running\") | .metadata.name`",
                solution: "jq -r '.items[] | select(.status.phase != \"Running\") | .metadata.name' pods.json",
                validations: [{ type: "COMMAND_USED", expected: "jq" }, { type: "OUTPUT_EQUALS", expected: "worker-5c2a" }],
              },
            ],
          },
          {
            slug: "fzf-fuzzy-finding",
            title: "Fuzzy Finding with fzf",
            summary: "Interactively pick files, commands and anything line-based.",
            estimatedMinutes: 12,
            difficulty: "INTERMEDIATE",
            tags: ["fzf", "fuzzy"],
            environment: { cwd: "~/projects/webshop", files: WEBSHOP_FILES },
            body: `\`fzf\` reads lines (from stdin, or the files below the current directory), lets you **type a fuzzy query**, and prints what you select. It's a building block: combine it with anything.

\`\`\`bash
fzf                         # pick a file below the current directory
ls | fzf                    # pick from any list
bat $(fzf)                  # open the picked file with bat
fzf --preview 'bat --color=always {}'
\`\`\`

In the finder: type to filter, `↑`/`↓` to move, `Enter` to accept, `Esc` to cancel.

## Search syntax

| Token | Match type |
| ----- | ---------- |
| \`sbtrkt\` | fuzzy match (letters in order, gaps allowed) |
| \`'wild\` | exact substring |
| \`^src\` | prefix |
| \`.ts$\` | suffix |
| \`!test\` | exclude |

Space-separated terms are combined with AND.

## Scripting

\`fzf --filter QUERY\` (\`-f\`) skips the UI and prints the ranked matches — handy in scripts and for checking what a query matches.`,
            steps: [
              {
                key: "filter-mode",
                title: "Non-interactive filtering",
                instruction: "Use fzf's filter mode to print every file matching the fuzzy query `logger`.",
                solution: "fzf --filter logger",
                validations: [{ type: "COMMAND_USED", expected: "fzf" }, { type: "OUTPUT_CONTAINS", expected: "src/utils/logger.ts" }],
              },
              {
                key: "extended-syntax",
                title: "Extended search syntax",
                instruction: "Filter for files that **end in `.ts`** but do **not** contain `test`.",
                hint: "`fzf -f '.ts$ !test'`",
                solution: "fzf -f '.ts$ !test'",
                validations: [
                  { type: "COMMAND_USED", expected: "fzf" },
                  { type: "OUTPUT_CONTAINS", expected: "src/server.ts" },
                  { type: "OUTPUT_REGEX", expected: "^(?![\\s\\S]*test)[\\s\\S]*$", failureMessage: "Test files are still in the results — exclude them with `!test`." },
                ],
              },
              {
                key: "pick-and-view",
                title: "Pick a file interactively",
                instruction: "Run `bat $(fzf)` and pick `src/products.ts` in the finder (try typing `prod`).",
                hint: "Type a few letters of the file name, then press Enter.",
                solution: "bat $(fzf)",
                validations: [{ type: "COMMAND_USED", expected: "fzf" }, { type: "OUTPUT_CONTAINS", expected: "export interface Product" }],
              },
              {
                key: "pipe-list",
                title: "fzf on any list",
                instruction: "Pipe the script names from `package.json` into fzf in filter mode and keep only `test`: use `jq -r '.scripts | keys[]' package.json | fzf -f test`.",
                solution: "jq -r '.scripts | keys[]' package.json | fzf -f test",
                validations: [{ type: "COMMAND_USED", expected: "fzf" }, { type: "COMMAND_USED", expected: "jq" }, { type: "OUTPUT_EQUALS", expected: "test" }],
              },
            ],
          },
          {
            slug: "bat-reading-code",
            title: "Reading Code with bat",
            summary: "A cat clone with syntax highlighting, line numbers and ranges.",
            estimatedMinutes: 8,
            difficulty: "BEGINNER",
            tags: ["bat", "syntax-highlighting"],
            environment: { cwd: "~/projects/webshop", files: WEBSHOP_FILES },
            body: `\`bat\` works like \`cat\` but adds syntax highlighting, line numbers and a header — when it writes to a terminal. When piped, it behaves exactly like \`cat\`, so it's safe in scripts.

\`\`\`bash
bat src/server.ts              # highlighted, with a grid and line numbers
bat -n src/server.ts           # numbers only, no grid/header
bat -p src/server.ts           # plain: highlighting only
bat -r 5:9 src/server.ts       # only lines 5–9
echo '{"a":1}' | bat -l json  # force a language
bat --list-languages
\`\`\`

On Debian/Ubuntu the binary is called \`batcat\`; many people add \`alias bat=batcat\`.`,
            steps: [
              {
                key: "view-file",
                title: "Highlight a file",
                instruction: "Display `src/server.ts` with bat.",
                solution: "bat src/server.ts",
                validations: [{ type: "COMMAND_USED", expected: "bat" }, { type: "OUTPUT_CONTAINS", expected: "File: src/server.ts" }],
              },
              {
                key: "line-range",
                title: "Only the lines you need",
                instruction: "Show only lines **8 to 11** of `src/server.ts` (the route handler).",
                hint: "`-r START:END`",
                solution: "bat -r 8:11 src/server.ts",
                validations: [
                  { type: "COMMAND_USED", expected: "bat" },
                  { type: "OUTPUT_CONTAINS", expected: "app.get(" },
                  { type: "OUTPUT_REGEX", expected: "^(?![\\s\\S]*import express)[\\s\\S]*$", failureMessage: "Line 1 is still shown — restrict the range with -r." },
                ],
              },
              {
                key: "json-language",
                title: "Force a language",
                instruction: "Pipe `package.json` through `jq -c .` and into `bat` with the language forced to JSON and **plain** style.",
                hint: "`jq -c . package.json | bat -p -l json`",
                solution: "jq -c . package.json | bat -p -l json",
                validations: [{ type: "COMMAND_USED", expected: "bat" }, { type: "INPUT_REGEX", expected: "-l\\s*json|--language[= ]json" }, { type: "OUTPUT_CONTAINS", expected: '"name":"webshop"' }],
              },
            ],
          },
        ],
      },
    ],
  },
];
