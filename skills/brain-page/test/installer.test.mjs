import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  lstatSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const INSTALLER = join(ROOT, "bin", "brain.mjs");

function makeSandbox(t) {
  const base = mkdtempSync(join(tmpdir(), "brain-installer-"));
  const home = join(base, "home");
  const state = join(base, "state");
  mkdirSync(home, { recursive: true });
  mkdirSync(state, { recursive: true });
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, home, state };
}

function runInstaller(args, { home, state, cwd = ROOT }) {
  return spawnSync(process.execPath, [INSTALLER, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      XDG_STATE_HOME: state,
    },
  });
}

function manifestPath(state) {
  return join(state, "brain.md", "installed-links");
}

test("setup detects and installs into Cursor and Pi runtimes", (t) => {
  const sandbox = makeSandbox(t);
  mkdirSync(join(sandbox.home, ".cursor"), { recursive: true });
  mkdirSync(join(sandbox.home, ".pi", "agent"), { recursive: true });

  const r = runInstaller(["setup", "-y"], sandbox);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /\[found\]\s+Cursor/);
  assert.match(r.stdout, /\[found\]\s+Pi/);

  assert.ok(existsSync(join(sandbox.home, ".cursor", "skills", "brain-page", "SKILL.md")));
  assert.ok(existsSync(join(sandbox.home, ".pi", "agent", "skills", "brain-page", "SKILL.md")));

  const manifest = readFileSync(join(sandbox.state, "brain.md", "installed-links"), "utf8");
  assert.match(manifest, /\.cursor\/skills\/brain-page/);
  assert.match(manifest, /\.pi\/agent\/skills\/brain-page/);
});

test("setup replaces a dangling symlink with a fresh copy (no crash)", (t) => {
  const sandbox = makeSandbox(t);
  const skillsDir = join(sandbox.home, ".claude", "skills");
  mkdirSync(skillsDir, { recursive: true });
  // Leftover from a source repo that has since moved: symlink to nowhere.
  symlinkSync(
    join(sandbox.home, "no-such-repo", "skills", "brain-page"),
    join(skillsDir, "brain-page"),
  );

  const r = runInstaller(["setup", "-y"], sandbox);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /copied .*brain-page/);

  const target = join(skillsDir, "brain-page");
  assert.ok(!lstatSync(target).isSymbolicLink());
  assert.ok(existsSync(join(target, "SKILL.md")));
  assert.ok(existsSync(join(target, ".brain-md-installed")));
});

test("setup success message points at brain init", (t) => {
  const sandbox = makeSandbox(t);
  mkdirSync(join(sandbox.home, ".claude"), { recursive: true });

  const r = runInstaller(["setup", "-y"], sandbox);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /brain init/);
  assert.doesNotMatch(r.stdout, /run the brain-setup skill inside a project to scaffold/);
});

test("top-level help mentions toolchain setup/uninstall", (t) => {
  const sandbox = makeSandbox(t);
  for (const args of [[], ["help"], ["--help"]]) {
    const r = runInstaller(args, sandbox);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /brain setup/);
    assert.match(r.stdout, /brain uninstall/);
  }
});

test("uninstall removes our copies and clears the manifest", (t) => {
  const sandbox = makeSandbox(t);
  mkdirSync(join(sandbox.home, ".claude"), { recursive: true });

  let r = runInstaller(["setup", "-y"], sandbox);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const skill = join(sandbox.home, ".claude", "skills", "brain-page");
  assert.ok(existsSync(join(skill, "SKILL.md")));
  assert.ok(existsSync(manifestPath(sandbox.state)));

  r = runInstaller(["uninstall", "-y"], sandbox);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.ok(!existsSync(skill));
  assert.ok(!existsSync(manifestPath(sandbox.state)));
  assert.match(r.stdout, /removed manifest/);
});

test("uninstall drops missing targets from the manifest and restores backup", (t) => {
  const sandbox = makeSandbox(t);
  mkdirSync(join(sandbox.home, ".claude"), { recursive: true });

  let r = runInstaller(["setup", "-y"], sandbox);
  assert.equal(r.status, 0, r.stderr || r.stdout);

  const skill = join(sandbox.home, ".claude", "skills", "brain-page");
  const backup = `${skill}.pre-brain.bak`;
  // Simulate a pre-existing skill dir that setup would have backed up, then
  // a user who deleted the installed copy by hand before uninstall.
  mkdirSync(backup, { recursive: true });
  writeFileSync(join(backup, "SKILL.md"), "# prior skill\n");
  rmSync(skill, { recursive: true, force: true });
  assert.ok(!existsSync(skill));

  r = runInstaller(["uninstall", "-y"], sandbox);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /already absent/);
  assert.match(r.stdout, /restored/);
  assert.ok(existsSync(join(skill, "SKILL.md")));
  assert.match(readFileSync(join(skill, "SKILL.md"), "utf8"), /prior skill/);
  assert.ok(!existsSync(backup));
  assert.ok(!existsSync(manifestPath(sandbox.state)));
});

test("uninstall accepts legacy bare-path manifest lines as mode=link", (t) => {
  const sandbox = makeSandbox(t);
  const skillsDir = join(sandbox.home, ".claude", "skills");
  mkdirSync(skillsDir, { recursive: true });
  const target = join(skillsDir, "brain-page");
  // Point at the real skill bundle in the checkout so the link is not dangling
  // in a way that confuses "is symlink" checks — uninstall only needs the link.
  symlinkSync(join(ROOT, "skills", "brain-page"), target);

  mkdirSync(dirname(manifestPath(sandbox.state)), { recursive: true });
  writeFileSync(manifestPath(sandbox.state), `${target}\n`); // legacy: no mode\t

  const r = runInstaller(["uninstall", "-y"], sandbox);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.ok(!existsSync(target));
  assert.ok(!existsSync(manifestPath(sandbox.state)));
});

test("uninstall keeps entries for runtimes the user declines", (t) => {
  const sandbox = makeSandbox(t);
  mkdirSync(join(sandbox.home, ".claude"), { recursive: true });
  mkdirSync(join(sandbox.home, ".cursor"), { recursive: true });

  let r = runInstaller(["setup", "-y"], sandbox);
  assert.equal(r.status, 0, r.stderr || r.stdout);

  // Answer "n" for the first runtime prompt, "y" for the rest (stdin).
  r = spawnSync(process.execPath, [INSTALLER, "uninstall"], {
    cwd: ROOT,
    encoding: "utf8",
    input: "n\ny\n",
    env: {
      ...process.env,
      HOME: sandbox.home,
      XDG_STATE_HOME: sandbox.state,
    },
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /kept/);
  assert.ok(existsSync(manifestPath(sandbox.state)));
  const manifest = readFileSync(manifestPath(sandbox.state), "utf8");
  // At least one runtime's entries remain; not fully cleared.
  assert.match(manifest, /skills\/brain-page/);
});
