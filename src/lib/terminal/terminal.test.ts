import { describe, expect, it } from "vitest";
import { stripAnsi } from "./ansi";
import { compile, formatJson, parseJsonStream, type Json } from "./jq";
import { fuzzyFilter } from "./fuzzy";
import { parse } from "./parser";
import { replayLesson, LessonSession } from "./session";
import { Shell } from "./shell";
import type { EnvironmentSpecInput, StepDefinition } from "./types";
import { normalizeCommand } from "./validation";

const ENV: EnvironmentSpecInput = {
  cwd: "~/project",
  files: {
    "~/project/.git/": null,
    "~/project/.gitignore": "node_modules/\n*.log\n",
    "~/project/README.md": "# Demo\n\nTODO: write docs\n",
    "~/project/src/app.ts": 'import { log } from "./log";\n\n// TODO: handle errors\nexport function main() {\n  log("hello");\n}\n',
    "~/project/src/log.ts": "export function log(msg: string) {\n  console.log(msg);\n}\n",
    "~/project/node_modules/lib/index.js": "// TODO inside dependency\n",
    "~/project/debug.log": "TODO this is ignored\n",
    "~/project/data/users.json": JSON.stringify({
      users: [
        { name: "ada", role: "admin", active: true, age: 36 },
        { name: "linus", role: "dev", active: false, age: 28 },
        { name: "grace", role: "dev", active: true, age: 45 },
      ],
    }),
    "~/project/.env": "SECRET=1\n",
  },
};

async function run(shell: Shell, input: string) {
  const r = await shell.execute(input);
  return { ...r, out: stripAnsi(r.stdout), err: stripAnsi(r.stderr) };
}

describe("parser", () => {
  it("handles quotes, pipes, lists and redirects", () => {
    const list = parse(`echo "a b" 'c' | grep a && ls > out.txt 2>&1; echo $HOME`);
    expect(list.items).toHaveLength(3);
    expect(list.items[0].pipeline.commands).toHaveLength(2);
    expect(list.items[0].next).toBe("&&");
    expect(list.items[1].pipeline.commands[0].redirects.map((r) => r.op)).toEqual([">", "dup"]);
  });

  it("rejects unterminated quotes", () => {
    expect(() => parse(`echo "oops`)).toThrow(/matching/);
  });
});

describe("shell basics", () => {
  it("navigates and lists", async () => {
    const shell = Shell.fromSpec(ENV);
    expect((await run(shell, "pwd")).out).toBe("/home/learner/project\n");
    await run(shell, "cd src");
    expect(shell.cwd).toBe("/home/learner/project/src");
    expect((await run(shell, "ls")).out.split(/\s+/).filter(Boolean)).toEqual(["app.ts", "log.ts"]);
    await run(shell, "cd ..");
    const ls = await run(shell, "ls -a | head -3");
    expect(ls.out).toBe(".\n..\ndata\n");
    const missing = await run(shell, "cd nope");
    expect(missing.exitCode).toBe(1);
    expect(missing.err).toContain("No such file or directory");
    await run(shell, "cd -");
    await run(shell, "cd");
    expect(shell.cwd).toBe("/home/learner");
  });

  it("supports mkdir -p, brace expansion, redirects and cat", async () => {
    const shell = Shell.fromSpec(ENV);
    await run(shell, "mkdir -p app/{src,tests}/unit");
    expect(shell.fs.isDirectory(shell.resolve("app/src/unit"))).toBe(true);
    expect(shell.fs.isDirectory(shell.resolve("app/tests/unit"))).toBe(true);
    await run(shell, "echo first > notes.txt && echo second >> notes.txt");
    expect((await run(shell, "cat notes.txt")).out).toBe("first\nsecond\n");
    expect((await run(shell, "cat -n notes.txt")).out).toBe("     1\tfirst\n     2\tsecond\n");
    expect((await run(shell, "cat missing.txt")).exitCode).toBe(1);
  });

  it("expands globs, variables and command substitution", async () => {
    const shell = Shell.fromSpec(ENV);
    expect((await run(shell, "echo src/*.ts")).out).toBe("src/app.ts src/log.ts\n");
    expect((await run(shell, "export NAME=world; echo \"hello $NAME\"")).out).toBe("hello world\n");
    expect((await run(shell, "echo $(ls src | wc -l)")).out).toBe("2\n");
    expect((await run(shell, "false || echo recovered")).out).toBe("recovered\n");
    expect((await run(shell, "echo $?")).out).toBe("0\n");
    expect((await run(shell, "nosuchcmd")).exitCode).toBe(127);
  });

  it("supports aliases and scripts", async () => {
    const shell = Shell.fromSpec({ ...ENV, files: { ...ENV.files, "~/project/hello.sh": "#!/bin/bash\necho \"hi $1\"\n" } });
    await run(shell, "alias ll='ls -la'");
    expect((await run(shell, "ll src")).out).toContain("app.ts");
    expect((await run(shell, "./hello.sh there")).out).toBe("hi there\n");
  });

  it("text pipelines work", async () => {
    const shell = Shell.fromSpec(ENV);
    expect((await run(shell, "printf 'b\\na\\nb\\n' | sort | uniq -c")).out).toBe("      1 a\n      2 b\n");
    expect((await run(shell, "grep -rn TODO src")).out).toBe("src/app.ts:3:// TODO: handle errors\n");
    expect((await run(shell, "echo hello | tr a-z A-Z")).out).toBe("HELLO\n");
    expect((await run(shell, "find . -name '*.ts' -type f")).out).toBe("./src/app.ts\n./src/log.ts\n");
    expect((await run(shell, "ls src | xargs -I {} echo file:{}")).out).toBe("file:app.ts\nfile:log.ts\n");
  });
});

describe("rg", () => {
  it("respects .gitignore and hidden files", async () => {
    const shell = Shell.fromSpec(ENV);
    const r = await run(shell, "rg TODO | cat");
    expect(r.out).toBe("README.md:TODO: write docs\nsrc/app.ts:// TODO: handle errors\n");
    const all = await run(shell, "rg -l --no-ignore TODO | cat");
    expect(all.out).toContain("node_modules/lib/index.js");
    expect(all.out).toContain("debug.log");
  });

  it("formats tty output with headings and line numbers", async () => {
    const shell = Shell.fromSpec(ENV);
    const r = await run(shell, "rg -t ts TODO");
    expect(r.out).toBe("src/app.ts\n3:// TODO: handle errors\n");
    expect(r.stdout).toContain("\x1b[");
  });

  it("supports counting, files, -o, -i and exit codes", async () => {
    const shell = Shell.fromSpec(ENV);
    expect((await run(shell, "rg -c log src | cat")).out).toBe("src/app.ts:2\nsrc/log.ts:2\n");
    expect((await run(shell, "rg --files | cat")).out).toBe("data/users.json\nREADME.md\nsrc/app.ts\nsrc/log.ts\n");
    expect((await run(shell, "rg -o 'TO\\w+' README.md")).out).toBe("1:TODO\n".replace("1:", "3:"));
    expect((await run(shell, "rg nothingmatches")).exitCode).toBe(1);
    expect((await run(shell, "echo Hello | rg -i hello")).out).toBe("Hello\n");
  });
});

describe("jq", () => {
  const evalJq = (program: string, input: Json) => [...compile(program).run(input)];
  const data = { users: [{ name: "a", age: 3, tags: ["x"] }, { name: "b", age: 1, tags: [] }] };

  it("evaluates paths and pipes", () => {
    expect(evalJq(".users[0].name", data)).toEqual(["a"]);
    expect(evalJq(".users[].name", data)).toEqual(["a", "b"]);
    expect(evalJq("[.users[] | select(.age > 2) | .name]", data)).toEqual([["a"]]);
    expect(evalJq(".users | map(.age) | add", data)).toEqual([4]);
    expect(evalJq(".users | sort_by(.age) | map(.name)", data)).toEqual([["b", "a"]]);
    expect(evalJq("{n: .users | length}", data)).toEqual([{ n: 2 }]);
    expect(evalJq('.users[] | "\\(.name) is \\(.age)"', data)).toEqual(["a is 3", "b is 1"]);
    expect(evalJq(".missing // \"default\"", data)).toEqual(["default"]);
    expect(evalJq(".users[0] | keys", data)).toEqual([["age", "name", "tags"]]);
    expect(evalJq("[.users[] | .tags | length] | max", data)).toEqual([1]);
    expect(evalJq("if .users then \"yes\" else \"no\" end", data)).toEqual(["yes"]);
    expect(evalJq("reduce .users[] as $u (0; . + $u.age)", data)).toEqual([4]);
    expect(evalJq(".users | group_by(.age > 2) | length", data)).toEqual([2]);
    expect(evalJq("to_entries | map(.key)", { a: 1, b: 2 })).toEqual([["a", "b"]]);
    expect(evalJq("[.[] | tostring]", [1, "a", null])).toEqual([["1", "a", "null"]]);
    expect(evalJq("def double: . * 2; map(double)", [1, 2])).toEqual([[2, 4]]);
    expect(evalJq('.[] | select(test("^a"; "i"))', ["Apple", "banana"])).toEqual(["Apple"]);
    expect(evalJq('gsub("o"; "0")', "foo")).toEqual(["f00"]);
    expect(evalJq("@csv", [1, "a,b"])).toEqual(['1,"a,b"']);
  });

  it("supports assignment and deletion", () => {
    expect(evalJq(".a.b = 1", {})).toEqual([{ a: { b: 1 } }]);
    expect(evalJq(".users[].age |= . + 1 | .users | map(.age)", data)).toEqual([[4, 2]]);
    expect(evalJq("del(.users[0]) | .users | length", data)).toEqual([1]);
    expect(evalJq("[paths]", { a: [1] })).toEqual([[["a"], ["a", 0]]]);
  });

  it("raises readable errors", () => {
    expect(() => evalJq(".[0]", { a: 1 })).toThrow("Cannot index object with number");
    expect(() => compile(".a |")).toThrow();
  });

  it("parses JSON streams and formats output", () => {
    expect(parseJsonStream('{"a":1}\n{"a":2} 3 "x"')).toEqual([{ a: 1 }, { a: 2 }, 3, "x"]);
    expect(formatJson({ a: [1, { b: null }] }, { indent: 2, compact: false, color: false, sortKeys: false, tab: false })).toBe('{\n  "a": [\n    1,\n    {\n      "b": null\n    }\n  ]\n}');
  });

  it("works as a command", async () => {
    const shell = Shell.fromSpec(ENV);
    const r = await run(shell, "jq -r '.users[] | select(.active) | .name' data/users.json");
    expect(r.out).toBe("ada\ngrace\n");
    const c = await run(shell, "cat data/users.json | jq -c '[.users[].age] | sort'");
    expect(c.out).toBe("[28,36,45]\n");
    const err = await run(shell, "jq '.users[' data/users.json");
    expect(err.exitCode).toBe(3);
  });
});

describe("fzf", () => {
  it("ranks fuzzy matches", () => {
    const ranked = fuzzyFilter(["src/app.ts", "src/log.ts", "README.md", "application.yaml"], "appts");
    expect(ranked[0].item).toBe("src/app.ts");
    expect(ranked.map((r) => r.item)).not.toContain("README.md");
    expect(fuzzyFilter(["a.ts", "b.md"], "!.md").map((r) => r.item)).toEqual(["a.ts"]);
    expect(fuzzyFilter(["a.ts", "b.md", "c.ts"], ".ts$").map((r) => r.item)).toEqual(["a.ts", "c.ts"]);
  });

  it("runs --filter mode and interactive mode via handler", async () => {
    const shell = Shell.fromSpec(ENV);
    expect((await run(shell, "fzf --filter log")).out).toBe("src/log.ts\n");
    shell.interactive = { fzf: async (req) => [req.items.find((i) => i.endsWith("app.ts")) as string] };
    const r = await run(shell, "cat $(fzf)");
    expect(r.out).toContain("export function main");
    expect(r.interactions).toEqual([["src/app.ts"]]);
    shell.interactive = { fzf: async () => null };
    expect((await run(shell, "fzf")).exitCode).toBe(130);
  });
});

describe("bat", () => {
  it("decorates on a tty and acts like cat when piped", async () => {
    const shell = Shell.fromSpec(ENV);
    const tty = await run(shell, "bat src/log.ts");
    expect(tty.out).toContain("File: src/log.ts");
    expect(tty.out).toContain("   1   │ export function log");
    expect(tty.stdout).toContain("\x1b[38;2;");
    const piped = await run(shell, "bat src/log.ts | cat");
    expect(piped.out).toBe(shell.fs.readFile(shell.resolve("src/log.ts")));
    const range = await run(shell, "bat -p -r 2:2 src/log.ts");
    expect(range.out).toBe("  console.log(msg);\n");
    expect((await run(shell, "bat missing.ts")).exitCode).toBe(1);
  });
});

describe("validation + replay", () => {
  const steps: StepDefinition[] = [
    {
      id: "s1",
      key: "enter-src",
      order: 1,
      title: "Enter src",
      instruction: "cd into src",
      solution: "cd src",
      validations: [{ type: "CWD_EQUALS", expected: "~/project/src" }],
    },
    {
      id: "s2",
      key: "find-todo",
      order: 2,
      title: "Find TODOs",
      instruction: "Use rg to find TODO",
      solution: "rg TODO",
      validations: [
        { type: "COMMAND_USED", expected: "rg" },
        { type: "OUTPUT_CONTAINS", expected: "handle errors" },
      ],
    },
    {
      id: "s3",
      key: "pick",
      order: 3,
      title: "Pick with fzf",
      instruction: "Open a file with fzf",
      solution: "bat $(fzf)",
      validations: [
        { type: "COMMAND_USED", expected: "fzf" },
        { type: "OUTPUT_CONTAINS", expected: "console.log" },
      ],
    },
  ];

  it("normalizes flags and quoting", () => {
    expect(normalizeCommand("ls -la /tmp")).toBe(normalizeCommand("ls -a -l '/tmp'"));
    expect(normalizeCommand("ls -la")).not.toBe(normalizeCommand("ls -l"));
  });

  it("completes steps in order and replays deterministically", async () => {
    const session = new LessonSession({
      environment: ENV,
      steps,
      interactive: { fzf: async (req) => [req.items.find((i) => i === "log.ts") as string] },
    });
    expect((await session.run("rg TODO")).evaluation?.outcome.passed).toBe(false);
    expect((await session.run("cd src")).evaluation?.outcome.passed).toBe(true);
    expect((await session.run("rg TODO")).evaluation?.outcome.passed).toBe(true);
    expect((await session.run("bat $(fzf)")).evaluation?.outcome.passed).toBe(true);
    expect(session.isComplete).toBe(true);

    const replay = await replayLesson({ environment: ENV, steps, history: session.history });
    expect(replay.completedStepIds.sort()).toEqual(["s1", "s2", "s3"]);
    expect(replay.lessonComplete).toBe(true);

    const tampered = session.history.map((h) => (h.input === "cd src" ? { ...h, input: "pwd" } : h));
    const bad = await replayLesson({ environment: ENV, steps, history: tampered });
    expect(bad.completedStepIds).toEqual([]);
  });
});
