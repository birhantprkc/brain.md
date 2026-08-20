import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "brain.mjs");
const HOOK_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "brain-setup", "hooks", "session-start");
const HOOK_COMMAND = "${CLAUDE_PROJECT_DIR}/.claude/hooks/brain-session-start";

function makeEmptyProject(t) {
  const originalCwd = process.cwd();
  const project = mkdtempSync(join(tmpdir(), "brain-hooks-"));
  t.after(() => {
    process.chdir(originalCwd);
    rmSync(project, { recursive: true, force: true });
  });
  return project;
}

function runBrain(project, args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: project,
    encoding: "utf8",
    input: opts.input,
    env: { ...process.env, ...(opts.env || {}) },
  });
}

function runHook(project, opts = {}) {
  const hook = opts.hookPath || join(project, ".claude", "hooks", "brain-session-start");
  return spawnSync("sh", [hook], {
    cwd: project,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: opts.home || join(project, "no-such-home"),
      CLAUDE_PROJECT_DIR: opts.claudeProjectDir === undefined ? project : opts.claudeProjectDir,
      BRAIN_CLI: opts.brainCli || "",
      PATH: opts.path || process.env.PATH,
      ...(opts.env || {}),
    },
  });
}

function writeMockCli(project, { populated = true, listPages = "demo-id\tDemo title\tdecision\tactive\n", failDir = false, failList = false } = {}) {
  const mock = join(project, "mock-brain.mjs");
  const log = join(project, "mock-brain.log");
  writeFileSync(
    mock,
    [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      `const log = ${JSON.stringify(log)};`,
      "appendFileSync(log, process.argv.slice(2).join(' ') + '\\n');",
      "const sub = process.argv[2];",
      `if (sub === 'brain-dir') {`,
      failDir ? "  process.exit(1);" : "",
      "  console.log('/tmp/fake-brain');",
      "  console.log('(default ./brain)');",
      "  console.log('source: default');",
      "  console.log('exists: true');",
      `  console.log('populated: ${populated ? "true" : "false"}');`,
      "  process.exit(0);",
      "}",
      `if (sub === 'list-pages') {`,
      failList ? "  process.exit(1);" : "",
      `  process.stdout.write(${JSON.stringify(listPages)});`,
      "  process.exit(0);",
      "}",
      "process.exit(1);",
      "",
    ].join("\n"),
  );
  chmodSync(mock, 0o755);
  writeFileSync(log, "");
  return { mock, log };
}

function settingsPath(project) {
  return join(project, ".claude", "settings.json");
}

function readSettings(project) {
  return JSON.parse(readFileSync(settingsPath(project), "utf8"));
}

function countOurHooks(settings) {
  const groups = settings?.hooks?.SessionStart || [];
  let n = 0;
  for (const g of groups) {
    for (const h of g.hooks || []) {
      if (typeof h.command === "string" && h.command.includes("brain-session-start")) n += 1;
    }
  }
  return n;
}

test("install-hooks writes project-local SessionStart command and copies the script", (t) => {
  const project = makeEmptyProject(t);
  const home = join(project, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });

  const r = runBrain(project, ["install-hooks"], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /installed Claude Code SessionStart hook/);
  assert.match(r.stdout, /project-local/);

  assert.ok(existsSync(join(project, ".claude", "hooks", "brain-session-start")));
  const settings = readSettings(project);
  assert.equal(countOurHooks(settings), 1);
  assert.equal(settings.hooks.SessionStart[0].hooks[0].type, "command");
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, HOOK_COMMAND);

  assert.ok(!existsSync(join(home, ".claude", "settings.json")));
});

test("install-hooks is idempotent and preserves unrelated settings", (t) => {
  const project = makeEmptyProject(t);
  mkdirSync(join(project, ".claude"), { recursive: true });
  writeFileSync(
    settingsPath(project),
    JSON.stringify(
      {
        permissions: { allow: ["Bash"] },
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo other" }] }],
          SessionStart: [{ hooks: [{ type: "command", command: "echo already-there" }] }],
        },
      },
      null,
      2,
    ) + "\n",
  );

  let r = runBrain(project, ["install-hooks"]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  r = runBrain(project, ["install-hooks"]);
  assert.equal(r.status, 0, r.stderr || r.stdout);

  const settings = readSettings(project);
  assert.deepEqual(settings.permissions, { allow: ["Bash"] });
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, "echo other");
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, "echo already-there");
  assert.equal(countOurHooks(settings), 1);
  assert.equal(readFileSync(settingsPath(project), "utf8"), JSON.stringify(readSettings(project), null, 2) + "\n");
});

test("uninstall-hooks is idempotent and leaves other hooks in place", (t) => {
  const project = makeEmptyProject(t);
  mkdirSync(join(project, ".claude"), { recursive: true });
  writeFileSync(
    settingsPath(project),
    JSON.stringify(
      {
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "echo keep-me" }] }],
        },
      },
      null,
      2,
    ) + "\n",
  );

  let r = runBrain(project, ["install-hooks"]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  r = runBrain(project, ["uninstall-hooks"]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /removed Claude Code SessionStart hook/);

  const settings = readSettings(project);
  assert.equal(countOurHooks(settings), 0);
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, "echo keep-me");
  assert.ok(!existsSync(join(project, ".claude", "hooks", "brain-session-start")));

  r = runBrain(project, ["uninstall-hooks"]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /not installed/);
  assert.equal(readSettings(project).hooks.SessionStart[0].hooks[0].command, "echo keep-me");
});

test("uninstall-hooks removes an empty settings file it emptied", (t) => {
  const project = makeEmptyProject(t);
  const r1 = runBrain(project, ["install-hooks"]);
  assert.equal(r1.status, 0, r1.stderr || r1.stdout);
  const r2 = runBrain(project, ["uninstall-hooks"]);
  assert.equal(r2.status, 0, r2.stderr || r2.stdout);
  assert.ok(!existsSync(settingsPath(project)));
});

test("install-hooks fails loudly on damaged settings JSON", (t) => {
  const project = makeEmptyProject(t);
  mkdirSync(join(project, ".claude"), { recursive: true });
  writeFileSync(settingsPath(project), "{ not json");
  const r = runBrain(project, ["install-hooks"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not valid JSON/);
  assert.equal(readFileSync(settingsPath(project), "utf8"), "{ not json");
});

test("hook no-ops without a populated brain (real CLI)", (t) => {
  const project = makeEmptyProject(t);
  const rInstall = runBrain(project, ["install-hooks"]);
  assert.equal(rInstall.status, 0, rInstall.stderr || rInstall.stdout);

  const r = runHook(project, { brainCli: CLI });
  assert.equal(r.status, 0, r.stderr);
  assert.equal((r.stdout || "").trim(), "");
});

test("hook injects list-pages snapshot when the brain is populated", (t) => {
  const project = makeEmptyProject(t);
  let r = runBrain(project, ["init", "--no-wire"]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  r = runBrain(project, [
    "create-page",
    "--id",
    "store-as-markdown",
    "--category",
    "decision",
    "--title",
    "Store config as Markdown",
  ]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  r = runBrain(
    project,
    ["update-truth", "--id", "store-as-markdown", "--summary", "capture secret body"],
    { input: "SECRET_BODY_MUST_NOT_LEAK_INTO_THE_HOOK\n" },
  );
  assert.equal(r.status, 0, r.stderr || r.stdout);

  r = runBrain(project, ["install-hooks"]);
  assert.equal(r.status, 0, r.stderr || r.stdout);

  const hook = runHook(project, { brainCli: CLI });
  assert.equal(hook.status, 0, hook.stderr);
  assert.match(hook.stdout, /brain list-pages/);
  assert.match(hook.stdout, /store-as-markdown/);
  assert.doesNotMatch(hook.stdout, /SECRET_BODY_MUST_NOT_LEAK_INTO_THE_HOOK/);
});

test("hook no-ops when brain-dir reports not populated (mock CLI)", (t) => {
  const project = makeEmptyProject(t);
  const rInstall = runBrain(project, ["install-hooks"]);
  assert.equal(rInstall.status, 0, rInstall.stderr || rInstall.stdout);
  const { mock, log } = writeMockCli(project, { populated: false, listPages: "should-not-run\n" });

  const r = runHook(project, { brainCli: mock });
  assert.equal(r.status, 0, r.stderr);
  assert.equal((r.stdout || "").trim(), "");
  const invoked = readFileSync(log, "utf8");
  assert.match(invoked, /brain-dir/);
  assert.doesNotMatch(invoked, /list-pages/);
});

test("hook failure-opens: missing CLI, failing brain-dir, failing list-pages", (t) => {
  const project = makeEmptyProject(t);
  const rInstall = runBrain(project, ["install-hooks"]);
  assert.equal(rInstall.status, 0, rInstall.stderr || rInstall.stdout);

  const missing = runHook(project, { brainCli: join(project, "no-such-cli.mjs"), path: "/usr/bin:/bin" });
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal((missing.stdout || "").trim(), "");

  const { mock: failDir } = writeMockCli(project, { failDir: true });
  const dirFail = runHook(project, { brainCli: failDir });
  assert.equal(dirFail.status, 0, dirFail.stderr);
  assert.equal((dirFail.stdout || "").trim(), "");

  const { mock: failList } = writeMockCli(project, { populated: true, failList: true });
  const listFail = runHook(project, { brainCli: failList });
  assert.equal(listFail.status, 0, listFail.stderr);
  assert.equal((listFail.stdout || "").trim(), "");
});

test("hook shells out to the CLI and never touches brain files itself", (t) => {
  const src = readFileSync(HOOK_SRC, "utf8");
  assert.match(src, /\bbrain-dir\b/);
  assert.match(src, /\blist-pages\b/);
  assert.doesNotMatch(src, /brain\/pages/);
  assert.doesNotMatch(src, /index\.md/);
  assert.doesNotMatch(src, /\bcat\b/);
  assert.doesNotMatch(src, /readFile|writeFile|open\(/);

  const project = makeEmptyProject(t);
  const rInstall = runBrain(project, ["install-hooks"]);
  assert.equal(rInstall.status, 0, rInstall.stderr || rInstall.stdout);

  mkdirSync(join(project, "brain", "pages"), { recursive: true });
  writeFileSync(join(project, "brain", "pages", "secret.md"), "SECRET_FROM_FILE_NOT_CLI\n");

  const { mock, log } = writeMockCli(project, {
    populated: true,
    listPages: "from-cli\tFrom CLI\tdecision\tactive\n",
  });
  const r = runHook(project, { brainCli: mock });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /from-cli/);
  assert.doesNotMatch(r.stdout, /SECRET_FROM_FILE_NOT_CLI/);
  assert.match(readFileSync(log, "utf8"), /brain-dir[\s\S]*list-pages/);

  const installed = readFileSync(join(project, ".claude", "hooks", "brain-session-start"), "utf8");
  assert.equal(installed, src);
  const settings = readSettings(project);
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, HOOK_COMMAND);
});

test("help lists install-hooks and uninstall-hooks as project-local", (t) => {
  const project = makeEmptyProject(t);
  const r = runBrain(project, ["help"]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /install-hooks/);
  assert.match(r.stdout, /uninstall-hooks/);
  assert.match(r.stdout, /project-local/);
});

test("init does not install the SessionStart hook (opt-in)", (t) => {
  const project = makeEmptyProject(t);
  const r = runBrain(project, ["init", "--no-wire"]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /install-hooks/);
  assert.ok(!existsSync(settingsPath(project)));
});
