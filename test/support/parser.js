import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before } from "node:test";
import { createTreeSitter, root } from "../../scripts/tree-sitter.js";
import { readTrees } from "./cst.js";

let runner;
let library;
const buildTimeoutMs = 60000;

before(() => {
  runner = createTreeSitter();
  library = join(
    runner.directory,
    process.platform === "win32" ? "gyp.dll" : "gyp.so",
  );
  const built = runner.run(["build", root, "--output", library], {
    timeout: buildTimeoutMs,
  });
  assert.ifError(built.error);
  assert.equal(built.status, 0, built.stdout + built.stderr);
});

after(() => runner?.close());

const timeoutMs = 10000;
const maxOutputBytes = 32 * 1024 * 1024;

function run(args, cwd = root, allowedStatuses = [0]) {
  const result = runner.run(args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: maxOutputBytes,
  });
  assert.ifError(result.error);
  assert.ok(result.status !== null);
  assert.ok(
    allowedStatuses.includes(result.status),
    `${args[0]} exited ${result.status}\n${result.stderr}\n${result.stdout.slice(-4000)}`,
  );
  return result.stdout;
}

function fixture(source, use) {
  const directory = mkdtempSync(join(runner.directory, "test-"));
  const path = join(directory, "input.gyp");
  writeFileSync(path, source);
  try {
    return use(path, directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function parse(source, edits = []) {
  return fixture(source, (path) => {
    const args = [
      "parse",
      "--cst",
      "--encoding",
      "utf8",
      "--lib-path",
      library,
      "--lang-name",
      "gyp",
      path,
    ];
    if (edits.length) args.push("--edits", ...edits);
    const trees = readTrees(run(args, root, [0, 1]));
    assert.equal(trees.length, 1);
    assert.equal(trees[0].type, "source_file");
    return trees[0];
  });
}

export function parseMany(sources) {
  return fixture("", (_path, directory) => {
    const paths = sources.map((source, index) => {
      const path = join(directory, `${index}.gyp`);
      writeFileSync(path, source);
      return path;
    });
    const trees = readTrees(
      run(
        [
          "parse",
          "--cst",
          "--encoding",
          "utf8",
          "--lib-path",
          library,
          "--lang-name",
          "gyp",
          ...paths,
        ],
        root,
        [0, 1],
      ),
    );
    assert.equal(trees.length, sources.length);
    return trees;
  });
}
