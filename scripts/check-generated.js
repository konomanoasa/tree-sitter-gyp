import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateParser, packageName, root } from "./tree-sitter.js";

const generatedFiles = [
  "grammar.json",
  "node-types.json",
  "parser.c",
  "tree_sitter/alloc.h",
  "tree_sitter/array.h",
  "tree_sitter/parser.h",
];

function main(args) {
  if (args.length) throw new Error("Usage: node scripts/check-generated.js");
  const directory = mkdtempSync(join(tmpdir(), `${packageName}-generated-`));
  try {
    const status = generateParser(directory);
    if (status !== 0) return status;
    const stale = [];
    for (const file of generatedFiles) {
      try {
        if (
          readFileSync(join(directory, "src", file)).equals(
            readFileSync(join(root, "src", file)),
          )
        )
          continue;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ENOENT"
        )
          throw error;
      }
      stale.push(`src/${file}`);
    }
    if (stale.length) {
      console.error(
        `Generated parser files are stale or missing:\n${stale.join("\n")}\nRun npm run generate and review the results.`,
      );
      return 1;
    }
    return 0;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
