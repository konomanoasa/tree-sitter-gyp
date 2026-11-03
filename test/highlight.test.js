import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createTreeSitter, packageName, root } from "../scripts/tree-sitter.js";

const commandTimeoutMs = 60_000;
const firstCaptureColor = 17;
const newlineByte = 0x0a;

function decodeEntities(text) {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

function renderedCaptures(html, source) {
  const start = html.indexOf("<pre><code>");
  const end = html.indexOf("</code></pre>");
  assert.ok(start >= 0 && end >= start, html);
  const content = html.slice(start + "<pre><code>".length, end);
  const stack = [];
  const captures = [];
  let text = "";
  for (const part of content.matchAll(
    /<span class='([^']*)'>|<[/]span>|([^<]+)/g,
  )) {
    if (part[1] !== undefined) stack.push(part[1].replaceAll(" ", "."));
    else if (part[0] === "</span>") assert.notEqual(stack.pop(), undefined);
    else {
      const decoded = decodeEntities(part[2]);
      text += decoded;
      captures.push(
        ...Array(Buffer.byteLength(decoded)).fill(stack.at(-1) ?? ""),
      );
    }
  }
  assert.equal(stack.length, 0, "unclosed highlight span");
  assert.equal(
    text.replace(/\n$/, ""),
    source.replace(/\n$/, ""),
    "rendered source differs from the input",
  );
  return captures;
}

function createHighlighter({ directory, root, run, captureNames }) {
  const parserDirectory = join(directory, "parsers");
  mkdirSync(parserDirectory);
  symlinkSync(root, join(parserDirectory, "tree-sitter-test"), "junction");
  const configPath = join(directory, "highlight.json");
  const capturePath = join(directory, "captures.txt");
  writeFileSync(
    configPath,
    JSON.stringify({
      "parser-directories": [parserDirectory],
      theme: Object.fromEntries(
        captureNames.map((name, index) => [name, index + firstCaptureColor]),
      ),
    }),
  );
  writeFileSync(capturePath, `${captureNames.join("\n")}\n`);

  return (scope, source) => {
    const path = join(directory, "highlight.txt");
    writeFileSync(path, source);
    const captures = renderedCaptures(
      run([
        "highlight",
        "--check",
        "--captures-path",
        capturePath,
        "--config-path",
        configPath,
        "--html",
        "--layout",
        "fragment",
        "--style",
        "classes",
        "--scope",
        scope,
        path,
      ]),
      source,
    );
    for (const capture of captures) {
      assert.ok(
        capture === "" || captureNames.includes(capture),
        `unexpected final capture: ${capture}`,
      );
    }
    return captures;
  };
}

function assertCaptures(source, actual, ranges) {
  const bytes = Buffer.from(source);
  const expected = Array(bytes.length).fill("");
  let previousEnd = 0;
  for (const [start, end, capture] of ranges) {
    assert.ok(
      Number.isSafeInteger(start) && start >= previousEnd,
      "expected ranges must be ordered and disjoint",
    );
    assert.ok(
      Number.isSafeInteger(end) && end > start && end <= bytes.length,
      "expected range exceeds source bytes",
    );
    expected.fill(capture, start, end);
    previousEnd = end;
  }
  for (const [index, byte] of bytes.entries()) {
    if (byte !== newlineByte)
      assert.equal(
        actual[index],
        expected[index],
        `byte ${index} in ${JSON.stringify(source)}`,
      );
  }
}

const captureNames = [
  "comment",
  "number",
  "operator",
  "punctuation.bracket",
  "punctuation.delimiter",
  "punctuation.special",
  "string",
  "string.escape",
];
let highlight;

let directory;
let runner;
before(() => {
  directory = mkdtempSync(join(tmpdir(), `${packageName}-highlight-`));
  runner = createTreeSitter();
  highlight = createHighlighter({
    directory,
    root,
    run: assertCommand,
    captureNames,
  });
});
after(() => {
  try {
    runner?.close();
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

function assertCommand(arguments_) {
  const result = runner.run(arguments_, {
    timeout: commandTimeoutMs,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stderr, /Non-standard highlight captures/);
  return result.stdout;
}

const finalCaptureCases = [
  {
    name: "punctuation, literals, comments and line continuation",
    source: "{'a': -2} #x\n\\\n",
    captures: [
      [0, 1, "punctuation.bracket"],
      [1, 4, "string"],
      [4, 5, "punctuation.delimiter"],
      [6, 7, "operator"],
      [7, 8, "number"],
      [8, 9, "punctuation.bracket"],
      [10, 12, "comment"],
      [13, 14, "punctuation.special"],
    ],
  },
  {
    name: "malformed escape remains uncolored",
    source: String.raw`{'': '\x1'}`,
    captures: [
      [0, 1, "punctuation.bracket"],
      [1, 3, "string"],
      [3, 4, "punctuation.delimiter"],
      [5, 6, "string"],
      [9, 10, "string"],
      [10, 11, "punctuation.bracket"],
    ],
  },
  {
    name: "unfinished malformed escape remains uncolored",
    source: String.raw`{'': '\x1`,
    captures: [
      [0, 1, "punctuation.bracket"],
      [1, 3, "string"],
      [3, 4, "punctuation.delimiter"],
      [5, 6, "string"],
    ],
  },
  {
    name: "recognized out of range Unicode escape",
    source: String.raw`{'': '\U00110000'}`,
    captures: [
      [0, 1, "punctuation.bracket"],
      [1, 3, "string"],
      [3, 4, "punctuation.delimiter"],
      [5, 6, "string"],
      [6, 16, "string.escape"],
      [16, 17, "string"],
      [17, 18, "punctuation.bracket"],
    ],
  },
  {
    name: "colon inside an entry issue",
    source: "{'a': @ : 2}",
    captures: [
      [0, 1, "punctuation.bracket"],
      [1, 4, "string"],
      [4, 5, "punctuation.delimiter"],
      [8, 9, "punctuation.delimiter"],
      [10, 11, "number"],
      [11, 12, "punctuation.bracket"],
    ],
  },
  {
    name: "colons inside entry and list issues",
    source: "{'a'::[1:2]}",
    captures: [
      [0, 1, "punctuation.bracket"],
      [1, 4, "string"],
      [4, 6, "punctuation.delimiter"],
      [6, 7, "punctuation.bracket"],
      [7, 8, "number"],
      [8, 9, "punctuation.delimiter"],
      [9, 10, "number"],
      [10, 12, "punctuation.bracket"],
    ],
  },
  {
    name: "colon outside an entry remains uncolored",
    source: "{}:",
    captures: [[0, 2, "punctuation.bracket"]],
  },
  {
    name: "raw recovery retains its escape",
    source: String.raw`{'': br'\x1'}`,
    captures: [
      [0, 1, "punctuation.bracket"],
      [1, 3, "string"],
      [3, 4, "punctuation.delimiter"],
      [7, 8, "string"],
      [8, 10, "string.escape"],
      [10, 12, "string"],
      [12, 13, "punctuation.bracket"],
    ],
  },
  {
    name: "unknown prefix body stays string content",
    source: String.raw`{'': rr'\x1'}`,
    captures: [
      [0, 1, "punctuation.bracket"],
      [1, 3, "string"],
      [3, 4, "punctuation.delimiter"],
      [7, 12, "string"],
      [12, 13, "punctuation.bracket"],
    ],
  },
  ...["{}\\", "{}\\ "].map((source) => ({
    name: `continuation only colors its marker in ${JSON.stringify(source)}`,
    source,
    captures: [
      [0, 2, "punctuation.bracket"],
      [2, 3, "punctuation.special"],
    ],
  })),
];

for (const { name, source, captures } of finalCaptureCases) {
  test(`gyp: ${name}`, () => {
    assertCaptures(source, highlight("source.gyp", source), captures);
  });
}

function captures(source) {
  const path = join(directory, "invalid.gyp");
  writeFileSync(path, source);
  return assertCommand([
    "query",
    "--scope",
    "source.gyp",
    "--captures",
    join(root, "queries/highlights.scm"),
    path,
  ])
    .split("\n")
    .flatMap((line) => {
      const match = line.match(
        /capture: [0-9]+ - ([a-z.]+), start: \(([0-9]+), ([0-9]+)\), end: \(([0-9]+), ([0-9]+)\)/,
      );
      return match
        ? [
            {
              name: match[1],
              start: [Number(match[2]), Number(match[3])],
              end: [Number(match[4]), Number(match[5])],
            },
          ]
        : [];
    });
}

test("CRLF continuation captures exclude both newline bytes", () => {
  assert.deepEqual(
    captures("{}\\\r\n").filter(({ name }) => name === "punctuation.special"),
    [{ name: "punctuation.special", start: [0, 2], end: [0, 3] }],
  );
});

test("escape fragments highlight up to decoding failures and NUL without capturing the invalid byte", () => {
  for (const invalid of [Buffer.from([0]), Buffer.from([0xff])]) {
    for (const fragment of ["\\", "\\x4", "\\u123", "\\U0001", "\\N{LATIN"]) {
      const prefix = Buffer.from("{'': 'a");
      const source = Buffer.concat([
        prefix,
        Buffer.from(fragment),
        invalid,
        Buffer.from("b'}"),
      ]);
      const end = prefix.length + fragment.length;
      const result = captures(source);
      assert.deepEqual(
        result.filter(({ name }) => name === "string.escape"),
        [{ name: "string.escape", start: [0, prefix.length], end: [0, end] }],
      );
      assert.ok(
        result.every(
          (capture) => capture.end[1] <= end || capture.start[1] > end,
        ),
      );
      assert.ok(
        result.some(
          (capture) =>
            capture.name === "string" &&
            capture.start[1] === end + 1 &&
            capture.end[1] === end + 2,
        ),
      );
    }
  }
});
