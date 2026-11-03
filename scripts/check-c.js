import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { packageName, root } from "./tree-sitter.js";

const commandTimeoutMs = 60000;
const commandOutputLimitBytes = 64 * 1024 * 1024;
const sources = ["src/scanner.c", "test/scanner.test.c"];
const warnings = ["-Wall", "-Wextra", "-Werror", "-pedantic"];
function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: root,
    encoding: "utf8",
    timeout: commandTimeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: commandOutputLimitBytes,
    stdio: "inherit",
    ...options,
  });
  if (result.error) {
    throw new Error(
      `${command} ${arguments_.join(" ")}: ${result.error.message}`,
      { cause: result.error },
    );
  }
  if (result.status !== 0) {
    const diagnostics = (result.stderr || result.stdout || "").trim();
    const outcome = result.signal
      ? `terminated by ${result.signal}`
      : `failed with status ${result.status}`;
    throw new Error(
      `${command} ${arguments_.join(" ")} ${outcome}${diagnostics ? `\n${diagnostics}` : ""}`,
    );
  }
  return result;
}

function executableCandidates(name) {
  if (process.platform !== "win32") return [name];
  const extensions = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT")
    .split(";")
    .filter(Boolean)
    .map((extension) => extension.toLowerCase());
  if (extensions.some((extension) => name.toLowerCase().endsWith(extension)))
    return [name];
  return [name, ...extensions.map((extension) => name + extension)];
}

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function findExecutable(name, directories) {
  if (isAbsolute(name) || name.includes("/") || name.includes("\\")) {
    if (isExecutable(name)) return name;
    throw new Error(`Cannot execute ${name}.`);
  }
  for (const directory of directories) {
    for (const candidate of executableCandidates(name)) {
      const path = join(directory, candidate);
      if (isExecutable(path)) return path;
    }
  }
  throw new Error(`Cannot find ${name} on PATH.`);
}

function versionMajor(command) {
  const version = run(command, ["--version"], { stdio: "pipe" }).stdout;
  const match = version.match(/version ([0-9]+)/);
  if (match === null)
    throw new Error(`Cannot determine the version of ${command}.`);
  return Number(match[1]);
}

function llvmCommands() {
  if (process.platform === "darwin") {
    const directory = "/opt/homebrew/opt/llvm/bin";
    return {
      clang: findExecutable(join(directory, "clang"), []),
      clangd: findExecutable(join(directory, "clangd"), []),
      clangFormat: findExecutable(join(directory, "clang-format"), []),
    };
  }
  const directories = (process.env.PATH ?? "").split(delimiter);
  const clangFormat = findExecutable(
    process.env.CLANG_FORMAT ?? "clang-format",
    directories,
  );
  const directory = dirname(realpathSync(clangFormat));
  return {
    clang: findExecutable(
      process.env.CLANG ?? "clang",
      process.env.CLANG === undefined ? [directory] : directories,
    ),
    clangd: findExecutable(
      process.env.CLANGD ?? "clangd",
      process.env.CLANGD === undefined ? [directory] : directories,
    ),
    clangFormat,
  };
}

function main(args) {
  if (
    args.length > 1 ||
    (args.length && !["--write", "--test", "--sanitize"].includes(args[0]))
  ) {
    throw new Error(
      "Usage: node scripts/check-c.js [--write | --test | --sanitize]",
    );
  }
  const testing = ["--test", "--sanitize"].includes(args[0]);
  const { clang, clangd, clangFormat } = testing
    ? {
        clang: findExecutable(
          process.env.CC ?? "cc",
          (process.env.PATH ?? "").split(delimiter),
        ),
        clangd: "",
        clangFormat: "",
      }
    : llvmCommands();
  if (
    !testing &&
    new Set([clang, clangd, clangFormat].map(versionMajor)).size !== 1
  )
    throw new Error(
      "clang, clangd, and clang-format must use the same LLVM major version.",
    );

  if (args[0] === "--write") {
    run(clangFormat, ["-i", ...sources]);
    return;
  }
  if (!testing) {
    for (const source of sources) {
      run(clang, ["-std=c17", ...warnings, "-Isrc", "-fsyntax-only", source]);
      run(clangd, [
        "--log=error",
        "--tweaks=",
        `--check=${join(root, source)}`,
      ]);
    }
    run(clangFormat, ["--dry-run", "--Werror", ...sources]);
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), `${packageName}-scanner-`));
  try {
    const sanitizers =
      args[0] === "--sanitize"
        ? [
            "-fsanitize=address,undefined",
            "-fno-sanitize-recover=undefined",
            "-fno-omit-frame-pointer",
            "-g",
          ]
        : [];
    for (const standard of ["c99", "c17"]) {
      const binary = join(
        directory,
        `scanner-${standard}${process.platform === "win32" ? ".exe" : ""}`,
      );
      run(clang, [
        `-std=${standard}`,
        ...sanitizers,
        "-Isrc",
        "test/scanner.test.c",
        "-o",
        binary,
      ]);
      run(binary, []);
      console.log(`gyp: scanner tests passed (${standard.toUpperCase()})`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
