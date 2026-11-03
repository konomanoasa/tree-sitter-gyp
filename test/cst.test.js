import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { issues, readTrees, walk } from "./support/cst.js";
import { parse, parseMany } from "./support/parser.js";

test("empty source exposes the required dictionary at EOF", () => {
  assert.deepEqual(issues(parse("")), [
    {
      outcome: "incomplete_syntax",
      reason: "missing_dictionary",
      start: [0, 0],
      end: [0, 0],
    },
  ]);
});

test("invalid UTF-8 and NUL stay inside their string or comment without duplicate escape issues", () => {
  const cases = [];
  for (const { bytes, reason } of [
    { bytes: Buffer.from([0xff]), reason: "invalid_encoding" },
    { bytes: Buffer.from([0]), reason: "invalid_character" },
  ]) {
    for (const [prefix, suffix, owner] of [
      ["{'': '", "'}", "string_literal"],
      ["{'': '\\", "'}", "string_literal"],
      ["{'': '\\x1", "'}", "string_literal"],
      ["{'': '\\N{A", "'}", "string_literal"],
      ["{'': r'\\", "'}", "string_literal"],
      ["{# ", "\n}", "comment"],
    ]) {
      cases.push({
        source: Buffer.concat([
          Buffer.from(prefix),
          bytes,
          Buffer.from(suffix),
        ]),
        reason,
        owner,
        offset: prefix.length,
      });
    }
  }
  for (const [index, tree] of parseMany(
    cases.map((entry) => entry.source),
  ).entries()) {
    const { reason, owner, offset } = cases[index];
    assert.deepEqual(issues(tree), [
      {
        outcome: "invalid_syntax",
        reason,
        start: [0, offset],
        end: [0, offset + 1],
      },
    ]);
    const parent = [...walk(tree)].find((node) =>
      node.children.some((child) => child.type === "syntax_issue"),
    );
    assert.equal(parent.type, owner);
    assert.ok([...walk(tree)].every((node) => node.type !== "ERROR"));
  }
});

test("Unicode text, a literal replacement character and interior BOM retain UTF-8 byte ranges", () => {
  const tree = parse("{'日': '🙂�﻿'}");
  assert.deepEqual(issues(tree), []);
  const content = [...walk(tree)].filter(
    (node) => node.type === "string_content",
  );
  assert.deepEqual(
    content.map((node) => [node.start, node.end]),
    [
      [
        [0, 2],
        [0, 5],
      ],
      [
        [0, 9],
        [0, 19],
      ],
    ],
  );
});

test("metadata makes issue classifications singular and retains the recognized escape", () => {
  const metadata = JSON.parse(
    readFileSync(new URL("../src/node-types.json", import.meta.url), "utf8"),
  );
  for (const type of [
    "syntax_issue",
    "invalid_syntax",
    "incomplete_syntax",
    "invalid_unicode_escape",
  ]) {
    const node = metadata.find((entry) => entry.type === type && entry.named);
    assert.equal(node.children.required, true, type);
    assert.equal(node.children.multiple, false, type);
  }
  const tree = parse(String.raw`{'': '\U00110000'}`);
  const reason = [...walk(tree)].find(
    (node) => node.type === "invalid_unicode_escape",
  );
  assert.equal(reason.children[0].type, "escape_sequence");
  assert.deepEqual(reason.children[0].start, reason.start);
  assert.deepEqual(reason.children[0].end, reason.end);
});

test("issues are directly owned, share their classification range and retain ordered children", () => {
  const tree = parse("{'a' 1, 'b': [2 3}, 'c': '\\x1'}");
  for (const node of walk(tree)) {
    assert.notEqual(node.type, "ERROR");
    if (node.type === "syntax_issue") {
      assert.equal(node.field, "issue");
      assert.equal(node.children.length, 1);
      const outcome = node.children[0];
      assert.equal(outcome.children.length, 1);
      for (const classified of [outcome, outcome.children[0]]) {
        assert.deepEqual(classified.start, node.start);
        assert.deepEqual(classified.end, node.end);
      }
    }
  }
});

test("public metadata exposes issue classifications without internal scanner symbols", () => {
  const metadata = JSON.parse(
    readFileSync(new URL("../src/node-types.json", import.meta.url), "utf8"),
  );
  for (const entry of metadata)
    assert.ok(!entry.type.startsWith("_"), entry.type);
  for (const type of [
    "syntax_issue",
    "invalid_syntax",
    "incomplete_syntax",
    "dictionary",
    "list",
    "entry",
  ]) {
    assert.ok(
      metadata.some((entry) => entry.type === type && entry.named),
      type,
    );
  }
});

test("non-ASCII invalid literals retain their complete byte range and following entry", () => {
  const cases = [
    { token: "é", reason: "invalid_value", owner: "entry", start: 5, end: 7 },
    {
      token: "a日🙂",
      reason: "invalid_value",
      owner: "entry",
      start: 5,
      end: 13,
    },
    { token: "a@é", reason: "invalid_value", owner: "entry", start: 5, end: 9 },
    {
      token: "1é",
      reason: "invalid_integer",
      owner: "integer",
      start: 5,
      end: 8,
    },
    {
      token: "1日🙂",
      reason: "invalid_integer",
      owner: "integer",
      start: 5,
      end: 13,
    },
    {
      token: "1@é",
      reason: "invalid_integer",
      owner: "integer",
      start: 5,
      end: 9,
    },
    {
      token: "1e+é",
      reason: "invalid_integer",
      owner: "integer",
      start: 5,
      end: 10,
    },
    {
      token: "-1é",
      reason: "invalid_integer",
      owner: "integer",
      start: 6,
      end: 9,
    },
  ];
  const sources = cases.map(({ token }) => `{'': ${token}, 'ok': 2}`);
  for (const [index, tree] of parseMany(sources).entries()) {
    const { reason, owner, start, end } = cases[index];
    assert.deepEqual(
      issues(tree),
      [
        {
          outcome: "invalid_syntax",
          reason,
          start: [0, start],
          end: [0, end],
        },
      ],
      sources[index],
    );
    const parent = [...walk(tree)].find((node) =>
      node.children.some((child) => child.type === "syntax_issue"),
    );
    assert.equal(parent.type, owner, sources[index]);
    const dictionary = tree.children.find((node) => node.type === "dictionary");
    assert.equal(
      dictionary.children.filter((node) => node.type === "entry").length,
      2,
      sources[index],
    );
    assert.ok(
      [...walk(tree)].every((node) => node.type !== "ERROR"),
      sources[index],
    );
  }
});

test("CST reader preserves anonymous leaves, fields, error markers and separate roots", () => {
  const output = `0:0 - 0:2   source_file
0:0 - 0:2     body: dictionary
0:0 - 0:1       "{"
0:1 - 0:2       "}"
0:0  - 0:12  •source_file
0:11 - 0:12     ERROR
0:11 - 0:12       ":"
`;
  assert.deepEqual(readTrees(output), [
    {
      type: "source_file",
      named: true,
      field: null,
      start: [0, 0],
      end: [0, 2],
      hasError: false,
      children: [
        {
          type: "dictionary",
          named: true,
          field: "body",
          start: [0, 0],
          end: [0, 2],
          hasError: false,
          children: [
            {
              type: "{",
              named: false,
              field: null,
              start: [0, 0],
              end: [0, 1],
              hasError: false,
              children: [],
            },
            {
              type: "}",
              named: false,
              field: null,
              start: [0, 1],
              end: [0, 2],
              hasError: false,
              children: [],
            },
          ],
        },
      ],
    },
    {
      type: "source_file",
      named: true,
      field: null,
      start: [0, 0],
      end: [0, 12],
      hasError: true,
      children: [
        {
          type: "ERROR",
          named: true,
          field: null,
          start: [0, 11],
          end: [0, 12],
          hasError: false,
          children: [
            {
              type: ":",
              named: false,
              field: null,
              start: [0, 11],
              end: [0, 12],
              hasError: false,
              children: [],
            },
          ],
        },
      ],
    },
  ]);
  assert.throws(() => readTrees("0:0 - 0:1   ???"), assert.AssertionError);
});

test("CST reader treats multiline leaf displays as text rather than child nodes", () => {
  const [tree] = readTrees(`0:0 - 1:1   source_file
0:0 - 1:1     content: string_content
0:0 - 0:2       \`a\\n\`
1:0 - 1:1       \`b\`
`);
  assert.deepEqual(tree.children, [
    {
      type: "string_content",
      named: true,
      field: "content",
      start: [0, 0],
      end: [1, 1],
      hasError: false,
      children: [],
    },
  ]);
});

test("public leaves preserve source bytes and sibling ranges across syntax and decoding failures", () => {
  const sources = [
    Buffer.from("{'日': [-2, r'a', {'b': 'é'}]} # c\r\n"),
    Buffer.from("{'x': @ : 2, 'y': [1 2}"),
    Buffer.from("{'x': '''a\nb'''}"),
    Buffer.from("{'x': '\\x1"),
    Buffer.concat([
      Buffer.from("{'x': '"),
      Buffer.from([0xff, 0]),
      Buffer.from("é'}"),
    ]),
  ];
  for (const [index, tree] of parseMany(sources).entries()) {
    const source = sources[index];
    const starts = [0];
    for (let byte = 0; byte < source.length; byte++) {
      if (source[byte] === 0x0a) starts.push(byte + 1);
    }
    const offset = ([row, column]) => starts[row] + column;
    assert.equal(offset(tree.end), source.length);
    const covered = new Uint8Array(source.length);
    for (const node of walk(tree)) {
      assert.equal(node.hasError, false);
      assert.ok(!["ERROR", "MISSING"].includes(node.type));
      const start = offset(node.start);
      const end = offset(node.end);
      assert.ok(start >= 0 && start <= end && end <= source.length);
      let previous = start;
      for (const child of node.children) {
        assert.ok(offset(child.start) >= previous);
        assert.ok(offset(child.end) <= end);
        previous = offset(child.end);
      }
      if (node.children.length === 0) {
        for (let byte = start; byte < end; byte++) {
          assert.equal(covered[byte], 0, `overlapping leaf at byte ${byte}`);
          covered[byte] = 1;
        }
      }
    }
    for (let byte = 0; byte < source.length; byte++) {
      if (!covered[byte]) {
        assert.ok(
          [0x09, 0x0a, 0x0c, 0x0d, 0x20].includes(source[byte]),
          `uncovered byte ${byte} in input ${index}`,
        );
      }
    }
  }
});

test("every prefix of valid nested literals can be completed without an invalid issue", () => {
  const complete = [
    String.raw`{'key': [r'raw\text', u'\x12\u1234\U00012345\N{LATIN CAPITAL LETTER A}', -123], 'b': '''line
2''', 'e': {}}`,
    "{# comment\r\n'a' \\\n: + \\\n2, 'b': ['a' # join\n'b']}",
  ];
  const sources = complete.flatMap((source) =>
    Array.from({ length: source.length + 1 }, (_, length) =>
      source.slice(0, length),
    ),
  );
  const trees = parseMany(sources);
  for (const [index, tree] of trees.entries()) {
    assert.equal(tree.type, "source_file", sources[index]);
    assert.ok(
      [...walk(tree)].every((node) => node.type !== "ERROR"),
      sources[index],
    );
    assert.ok(
      issues(tree).every((issue) => issue.outcome === "incomplete_syntax"),
      sources[index],
    );
  }
  for (const tree of parseMany(complete)) assert.deepEqual(issues(tree), []);
});

test("layout between container tokens preserves values and ownership", () => {
  const layouts = [
    " ",
    "\t",
    "\f",
    "\n",
    "\r",
    "\r\n",
    "# comment\n",
    "\\\n",
    "\\\r\n",
  ];
  const tokens = ["{", "'key'", ":", "[", "+", "12", ",", "{", "}", "]", "}"];
  const sources = layouts.map((layout) => tokens.join(layout));
  for (const tree of parseMany(sources)) {
    assert.deepEqual(issues(tree), []);
    const semantic = [...walk(tree)].filter((node) =>
      ["dictionary", "entry", "list", "integer"].includes(node.type),
    );
    assert.deepEqual(
      semantic.map((node) => [node.type, node.field]),
      [
        ["dictionary", "body"],
        ["entry", "entry"],
        ["list", "value"],
        ["integer", "element"],
        ["dictionary", "element"],
      ],
    );
  }
});

test("single token insertions keep supported recovery inside public syntax issues", () => {
  const source = "{'a':[1,'x',{'b':2}]}";
  const insertions = [
    ":",
    ",",
    "}",
    "]",
    "{",
    "[",
    "'",
    '"',
    "r",
    "-",
    "#",
    "\\",
    "\0",
    "@",
  ];
  const sources = [
    ...new Set(
      insertions.flatMap((inserted) =>
        Array.from(
          { length: source.length + 1 },
          (_, index) => source.slice(0, index) + inserted + source.slice(index),
        ),
      ),
    ),
  ];
  const sourcesPerBatch = 64;
  for (let offset = 0; offset < sources.length; offset += sourcesPerBatch) {
    const batch = sources.slice(offset, offset + sourcesPerBatch);
    for (const [index, tree] of parseMany(batch).entries()) {
      assert.equal(tree.type, "source_file", batch[index]);
      assert.ok(
        [...walk(tree)].every((node) => node.type !== "ERROR"),
        batch[index],
      );
    }
  }
});
