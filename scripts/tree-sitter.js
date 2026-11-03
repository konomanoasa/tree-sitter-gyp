import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "..");
const packageName = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  .name.split("/")
  .at(-1);
const configuration = JSON.parse(
  readFileSync(join(root, "tree-sitter.json"), "utf8"),
);
if (
  configuration.grammars.length !== 1 ||
  configuration.grammars[0].name !== "gyp"
) {
  throw new Error("tree-sitter.json must define only the gyp grammar.");
}
const commandOutputLimitBytes = 256 * 1024 * 1024;
const fuzzOutputLimitBytes = 16 * 1024 * 1024;
const fuzzTimeoutMs = 600_000;
const queryTimeoutMs = 60_000;
const missingCliMessage = "Tree-sitter CLI is missing; run npm ci.";

function treeSitterExecutable() {
  try {
    return join(
      dirname(
        fileURLToPath(import.meta.resolve("tree-sitter-cli/package.json")),
      ),
      process.platform === "win32" ? "tree-sitter.exe" : "tree-sitter",
    );
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ERR_MODULE_NOT_FOUND"
    ) {
      throw new Error(missingCliMessage, { cause: error });
    }
    throw error;
  }
}

function copyFiles(paths, destinationRoot) {
  for (const path of new Set(paths)) {
    const destination = join(destinationRoot, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(root, path), destination, { recursive: true });
  }
}

function resultStatus(result) {
  if (result.error) throw result.error;
  if (result.signal) {
    process.stderr.write(`Tree-sitter CLI terminated by ${result.signal}.\n`);
    return 1;
  }
  return result.status ?? 1;
}

function createTreeSitter() {
  const directory = mkdtempSync(join(tmpdir(), `${packageName}-`));
  const cacheDirectory = join(root, "node_modules", ".cache", packageName);
  const configDirectory = join(directory, "config");
  const libraryDirectory = join(directory, "lib");
  const treeSitterConfigDirectory = join(configDirectory, "tree-sitter");
  const parserDirectory = join(directory, "parsers");
  try {
    mkdirSync(cacheDirectory, { recursive: true });
    mkdirSync(libraryDirectory);
    mkdirSync(treeSitterConfigDirectory, { recursive: true });
    copyFiles(
      ["tree-sitter.json", "src", "queries"],
      join(parserDirectory, packageName),
    );
    writeFileSync(
      join(treeSitterConfigDirectory, "config.json"),
      `${JSON.stringify({ "parser-directories": [parserDirectory] }, null, 2)}\n`,
    );
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  let closed = false;
  return Object.freeze({
    directory,
    configPath: join(treeSitterConfigDirectory, "config.json"),
    close() {
      if (!closed) {
        closed = true;
        rmSync(directory, { recursive: true, force: true });
      }
    },
    run(arguments_, options = {}) {
      if (closed) throw new Error("Tree-sitter runner is closed.");
      return spawnSync(treeSitterExecutable(), arguments_, {
        cwd: root,
        encoding: "utf8",
        maxBuffer: commandOutputLimitBytes,
        windowsHide: true,
        killSignal: "SIGKILL",
        ...options,
        env: {
          ...process.env,
          ...(process.platform === "darwin"
            ? { CC: process.env.CC ?? "/opt/homebrew/opt/llvm/bin/clang" }
            : {}),
          APPDATA: configDirectory,
          LOCALAPPDATA: cacheDirectory,
          NO_COLOR: "1",
          TREE_SITTER_DIR: treeSitterConfigDirectory,
          TREE_SITTER_LIBDIR: libraryDirectory,
          TREE_SITTER_SEED: process.env.TREE_SITTER_SEED ?? "1",
          XDG_CACHE_HOME: cacheDirectory,
          XDG_CONFIG_HOME: configDirectory,
        },
      });
    },
  });
}

function generateParser(outputRoot = root) {
  const output = join(outputRoot, "src");
  mkdirSync(output, { recursive: true });
  return resultStatus(
    spawnSync(
      treeSitterExecutable(),
      [
        "generate",
        join(root, "grammar.js"),
        "--abi",
        "latest",
        "--output",
        output,
      ],
      { cwd: root, windowsHide: true, stdio: "inherit" },
    ),
  );
}

function testCorpus(arguments_) {
  if (
    arguments_.some(
      (argument) =>
        ["--update", "--debug-graph", "--open-log"].includes(argument) ||
        /^-[d0rh]*[uD]/.test(argument),
    )
  ) {
    throw new Error(
      "test-corpus deletes its isolated copy; --update, --debug-graph, and --open-log would lose their output.",
    );
  }
  const directory = mkdtempSync(join(tmpdir(), `${packageName}-test-`));
  let runner;
  try {
    copyFiles(
      [
        "package.json",
        "grammar.js",
        "src",
        "queries",
        "test/corpus",
        "tree-sitter.json",
      ],
      directory,
    );
    runner = createTreeSitter();
    return resultStatus(
      runner.run(["test", ...arguments_], { cwd: directory, stdio: "inherit" }),
    );
  } finally {
    runner?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function fuzzParser(runner, arguments_) {
  const directory = mkdtempSync(join(tmpdir(), `${packageName}-fuzz-`));
  try {
    const library = join(
      directory,
      process.platform === "win32" ? "gyp.dll" : "gyp.so",
    );
    const built = resultStatus(
      runner.run(["build", root, "--output", library], { stdio: "inherit" }),
    );
    if (built !== 0) return built;
    const result = runner.run(
      ["fuzz", "--lib-path", library, "--lang-name", "gyp", ...arguments_],
      {
        maxBuffer: fuzzOutputLimitBytes,
        timeout: fuzzTimeoutMs,
      },
    );
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    const status = resultStatus(result);
    if (status !== 0) return status;
    return /^[1-9][0-9]* .+ corpus tests failed fuzzing$/m.test(
      result.stdout + result.stderr,
    )
      ? 1
      : 0;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function checkQueries() {
  const result = spawnSync("ts_query_ls", ["check", "--format", "queries"], {
    cwd: root,
    encoding: "utf8",
    timeout: queryTimeoutMs,
    killSignal: "SIGKILL",
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  return resultStatus(result);
}

function main(arguments_) {
  const [command, ...rest] = arguments_;
  if (
    ["generate", "build", "check-queries"].includes(command) &&
    rest.length !== 0
  ) {
    throw new Error(`Usage: node scripts/tree-sitter.js ${command}`);
  }
  if (command === "generate") return generateParser();
  if (command === "check-queries") return checkQueries();
  if (command === "test-corpus") return testCorpus(rest);
  const runner = createTreeSitter();
  try {
    if (command === "build") {
      mkdirSync(join(root, "build"), { recursive: true });
      const library = join(
        root,
        "build",
        process.platform === "win32" ? "gyp.dll" : "gyp.so",
      );
      return resultStatus(
        runner.run(["build", root, "--output", library], { stdio: "inherit" }),
      );
    }
    if (command === "fuzz") return fuzzParser(runner, rest);
    return resultStatus(runner.run(arguments_, { stdio: "inherit" }));
  } finally {
    runner.close();
  }
}

if (import.meta.main === undefined)
  throw new Error("Node.js 24.21.0 or later is required.");
if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export { copyFiles, createTreeSitter, generateParser, packageName, root };
