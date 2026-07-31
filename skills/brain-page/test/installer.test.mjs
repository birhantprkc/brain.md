import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, lstatSync } from "node:fs";
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
  return { home, state };
}

function runInstaller(args, { home, state }) {
  return spawnSync(process.execPath, [INSTALLER, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      XDG_STATE_HOME: state,
    },
  });
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
