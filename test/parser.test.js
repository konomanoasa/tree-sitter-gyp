import assert from "node:assert/strict";
import test from "node:test";
import { parse, parseMany } from "./support/cli.js";
import { issues, walk } from "./support/cst.js";

test("top-level layout follows physical and logical line boundaries for every newline form", () => {
  const cases = [
    [" {}", true],
    ["\t{}", true],
    ["\n {}", false],
    ["# comment\n\t{}", false],
    ["\n \f{}", true],
    ["\f {}", false],
    ["\n \t# comment\n{}", true],
    ["\n \t\n{}", true],
    ["{}\n ", false],
    ["{}\n \n", true],
    ["{}\n # comment", true],
    ["\\\n {}", false],
    ["\n \\\n\f{}", false],
    ["\n \\\n\n{}", true],
    ["\n \\\n# comment\n{}", true],
    ["{}\\\n ", true],
    ["{}\\\n", false],
    ["{}\n \\\n\\\n\n", true],
    ["{}\n \\\n\f", false],
    ["{\n \t'a': [\n 1\n ]\n }", true],
  ];
  const examples = ["\n", "\r\n", "\r"].flatMap((newline) =>
    cases.map(([source, accepted]) => ({
      source: String(source).replaceAll("\n", newline),
      accepted,
    })),
  );
  for (const [index, tree] of parseMany(
    examples.map(({ source }) => source),
  ).entries()) {
    const { source, accepted } = examples[index];
    assert.equal(
      [...walk(tree)].some((node) => node.type === "ERROR"),
      false,
      JSON.stringify(source),
    );
    assert.equal(issues(tree).length === 0, accepted, JSON.stringify(source));
    assert.equal(
      tree.children.filter((node) => node.field === "body").length,
      1,
      JSON.stringify(source),
    );
  }
});

test("root scalars join only within a logical line while container elements allow ordinary newlines", () => {
  const separators = [
    { text: " ", joined: true, indented: false },
    { text: "\n", joined: false, indented: false },
    { text: "\n ", joined: false, indented: true },
    { text: " #c\n ", joined: false, indented: true },
    { text: " #c\\\n ", joined: false, indented: true },
    { text: "\\\n ", joined: true, indented: false },
    { text: " \\ ", joined: true, indented: false },
    { text: "\\\n \\\n ", joined: true, indented: false },
    { text: "\\\n\n ", joined: false, indented: true },
    { text: "\\\n#c\n ", joined: false, indented: true },
    { text: "\n \f", joined: false, indented: false },
  ];
  const scalars = [
    { left: "'a'", right: "r'b'", type: "string" },
    { left: "'''a\nb'''", right: "u'b'", type: "string" },
    { left: "-", right: "1", type: "integer" },
    { left: "+", right: "1", type: "integer" },
  ];
  for (const newline of ["\n", "\r\n", "\r"]) {
    for (const scalar of scalars) {
      const examples = separators.flatMap(({ text, joined, indented }) => {
        const expression = `${scalar.left}${text}${scalar.right}`.replaceAll(
          "\n",
          newline,
        );
        return [
          { source: expression, joined, indented },
          { source: `{} ${expression}`, joined, indented },
          { source: `{'x':${expression}}`, joined: true, indented: false },
          { source: `[${expression}]`, joined: true, indented: false },
        ];
      });
      for (const [i, tree] of parseMany(
        examples.map(({ source }) => source),
      ).entries()) {
        const example = examples[i];
        const message = JSON.stringify(example.source);
        const nodes = [...walk(tree)];
        assert.ok(
          nodes.every((node) => node.type !== "ERROR"),
          message,
        );
        const values = nodes.filter(
          (node) => node.type === scalar.type && node.field !== "key",
        );
        assert.equal(values.length, example.joined ? 1 : 2, message);
        const reasons = issues(tree).map(({ reason }) => reason);
        assert.equal(
          reasons.includes("invalid_indentation"),
          example.indented,
          message,
        );
        assert.equal(
          reasons.includes("missing_digits"),
          scalar.type === "integer" && !example.joined,
          message,
        );
        if (scalar.type === "string") {
          assert.deepEqual(
            values.map(
              (node) =>
                node.children.filter((child) => child.field === "literal")
                  .length,
            ),
            example.joined ? [2] : [1, 1],
            message,
          );
        }
      }
    }
  }
});

test("Unicode escape prefixes that cannot complete within U+10FFFF stay invalid at EOF and before NUL", () => {
  const [eof, nul, completable] = parseMany([
    "{'': '\\U0011",
    "{'': '\\U0011\0'}",
    "{'': '\\U0010",
  ]);
  const prefix = { reason: "invalid_escape", start: [0, 6], end: [0, 12] };
  assert.deepEqual(issues(eof), [
    { outcome: "invalid_syntax", ...prefix },
    {
      outcome: "incomplete_syntax",
      reason: "missing_string_close",
      start: [0, 12],
      end: [0, 12],
    },
    {
      outcome: "incomplete_syntax",
      reason: "missing_dictionary_close",
      start: [0, 12],
      end: [0, 12],
    },
  ]);
  assert.deepEqual(issues(nul), [
    { outcome: "invalid_syntax", ...prefix },
    {
      outcome: "invalid_syntax",
      reason: "invalid_character",
      start: [0, 12],
      end: [0, 13],
    },
  ]);
  assert.deepEqual(issues(completable)[0], {
    outcome: "incomplete_syntax",
    ...prefix,
  });
});

test("decoding failures between entry components do not fabricate missing separators or values", () => {
  const contexts = [
    { prefix: "{", suffix: ":1}", offset: 1 },
    { prefix: "{'k'", suffix: ":1}", offset: 4 },
    { prefix: "{'k':", suffix: "1}", offset: 5 },
    { prefix: "{'k':", suffix: "}", offset: 5 },
  ];
  const sources = contexts.map(({ prefix, suffix }) =>
    Buffer.concat([
      Buffer.from(prefix),
      Buffer.from([0xff]),
      Buffer.from(suffix),
    ]),
  );
  for (const [index, tree] of parseMany(sources).entries()) {
    const { offset } = contexts[index];
    assert.deepEqual(issues(tree), [
      {
        outcome: "invalid_syntax",
        reason: "invalid_encoding",
        start: [0, offset],
        end: [0, offset + 1],
      },
    ]);
    const entry = [...walk(tree)].find((node) => node.type === "entry");
    assert.ok(entry.children.some((node) => node.type === "syntax_issue"));
  }
});

test("failed prefix lookahead keeps the following invalid byte separate from the bare word", () => {
  for (const { bytes, reason } of [
    { bytes: Buffer.from([0xff]), reason: "invalid_encoding" },
    { bytes: Buffer.from([0]), reason: "invalid_character" },
  ]) {
    const contexts = [
      { prefix: "{'a' abc", suffix: ":1}", wordStart: 5, invalidStart: 8 },
      {
        prefix: "{'': ['a' abc",
        suffix: "]}",
        wordStart: 10,
        invalidStart: 13,
      },
    ];
    const sources = contexts.map(({ prefix, suffix }) =>
      Buffer.concat([Buffer.from(prefix), bytes, Buffer.from(suffix)]),
    );
    for (const [index, tree] of parseMany(sources).entries()) {
      const { wordStart, invalidStart } = contexts[index];
      assert.deepEqual(
        issues(tree).filter((issue) =>
          ["invalid_value", reason].includes(issue.reason),
        ),
        [
          {
            outcome: "invalid_syntax",
            reason: "invalid_value",
            start: [0, wordStart],
            end: [0, invalidStart],
          },
          {
            outcome: "invalid_syntax",
            reason,
            start: [0, invalidStart],
            end: [0, invalidStart + 1],
          },
        ],
      );
      assert.ok([...walk(tree)].every((node) => node.type !== "ERROR"));
    }
  }
});

test("invalid bytes after an integer sign preserve digits of the same logical line without derived issues", () => {
  const issue = (outcome, reason, start, end) => ({
    outcome,
    reason,
    start,
    end,
  });
  const cases = [
    {
      source: Buffer.from([0x2d, 0, 0xff, 0x31, 0x32]),
      expected: [
        issue("invalid_syntax", "non_dictionary_root", [0, 0], [0, 5]),
        issue("invalid_syntax", "invalid_character", [0, 1], [0, 2]),
        issue("invalid_syntax", "invalid_encoding", [0, 2], [0, 3]),
      ],
      digits: [
        [
          [0, 3],
          [0, 5],
        ],
      ],
    },
  ];
  for (const { byte, reason } of [
    { byte: 0xff, reason: "invalid_encoding" },
    { byte: 0, reason: "invalid_character" },
  ]) {
    const source = (prefix, suffix) =>
      Buffer.concat([
        Buffer.from(prefix),
        Buffer.from([byte]),
        Buffer.from(suffix),
      ]);
    const invalid = (row, column) =>
      issue("invalid_syntax", reason, [row, column], [row, column + 1]);
    cases.push(
      {
        source: source("{'': -", "12}"),
        expected: [invalid(0, 6)],
        digits: [
          [
            [0, 7],
            [0, 9],
          ],
        ],
      },
      {
        source: Buffer.concat([
          source("{'': -", " "),
          Buffer.from([byte]),
          Buffer.from("12}"),
        ]),
        expected: [invalid(0, 6), invalid(0, 8)],
        digits: [
          [
            [0, 9],
            [0, 11],
          ],
        ],
      },
      {
        source: source("{'': -", "}"),
        expected: [invalid(0, 6)],
        digits: [],
      },
      {
        source: source("{'': -", ""),
        expected: [
          invalid(0, 6),
          issue(
            "incomplete_syntax",
            "missing_dictionary_close",
            [0, 7],
            [0, 7],
          ),
        ],
        digits: [],
      },
      {
        source: source("-", " 12"),
        expected: [
          issue("invalid_syntax", "non_dictionary_root", [0, 0], [0, 5]),
          invalid(0, 1),
        ],
        digits: [
          [
            [0, 3],
            [0, 5],
          ],
        ],
      },
      {
        source: source("-", "\\\n12"),
        expected: [
          issue("invalid_syntax", "non_dictionary_root", [0, 0], [1, 2]),
          invalid(0, 1),
        ],
        digits: [
          [
            [1, 0],
            [1, 2],
          ],
        ],
      },
      {
        source: source("-", "\n12"),
        expected: [
          issue("invalid_syntax", "non_dictionary_root", [0, 0], [0, 2]),
          invalid(0, 1),
          issue("invalid_syntax", "extra_root_value", [1, 0], [1, 2]),
        ],
        digits: [],
      },
    );
  }
  for (const [index, tree] of parseMany(
    cases.map(({ source }) => source),
  ).entries()) {
    const { source, expected, digits } = cases[index];
    const message = JSON.stringify(source.toString("latin1"));
    assert.deepEqual(issues(tree), expected, message);
    const integer = [...walk(tree)].find((node) => node.type === "integer");
    assert.equal(
      integer.children.find((node) => node.named)?.type,
      "syntax_issue",
      message,
    );
    assert.deepEqual(
      integer.children
        .filter((node) => node.type === "integer_digits")
        .map((node) => [node.start, node.end]),
      digits,
      message,
    );
    assert.ok(
      [...walk(tree)].every((node) => node.type !== "ERROR"),
      message,
    );
  }
});

test("invalid bytes after a line continuation marker do not duplicate missing newline or indentation issues", () => {
  const contexts = [
    {
      prefix: "{}\\",
      suffix: "\n",
      invalid: [0, 3],
      continuation: [
        [0, 2],
        [1, 0],
      ],
      trailing: [
        {
          outcome: "incomplete_syntax",
          reason: "missing_line_continuation_content",
          start: [1, 0],
          end: [1, 0],
        },
      ],
    },
    {
      prefix: "{}\\",
      suffix: "",
      invalid: [0, 3],
      continuation: [
        [0, 2],
        [0, 4],
      ],
      trailing: [],
    },
    {
      prefix: "{}\n \\",
      suffix: "\n\n",
      invalid: [1, 2],
      continuation: [
        [1, 1],
        [2, 0],
      ],
      trailing: [],
    },
  ];
  for (const { bytes, reason } of [
    { bytes: Buffer.from([0xff]), reason: "invalid_encoding" },
    { bytes: Buffer.from([0]), reason: "invalid_character" },
  ]) {
    const sources = contexts.map(({ prefix, suffix }) =>
      Buffer.concat([Buffer.from(prefix), bytes, Buffer.from(suffix)]),
    );
    for (const [index, tree] of parseMany(sources).entries()) {
      const { invalid, continuation, trailing } = contexts[index];
      assert.deepEqual(issues(tree), [
        {
          outcome: "invalid_syntax",
          reason,
          start: invalid,
          end: [invalid[0], invalid[1] + 1],
        },
        ...trailing,
      ]);
      const node = [...walk(tree)].find(
        (node) => node.type === "line_continuation",
      );
      assert.equal(
        node.children.find((child) => child.named)?.type,
        "syntax_issue",
      );
      assert.deepEqual([node.start, node.end], continuation);
      assert.ok([...walk(tree)].every((node) => node.type !== "ERROR"));
    }
  }
});

test("unsupported prefix bodies retain decoding failures without derived escape issues", () => {
  for (const { byte, reason } of [
    { byte: 0, reason: "invalid_character" },
    { byte: 0xff, reason: "invalid_encoding" },
  ]) {
    const sources = ["br", "rr"].map((prefix) =>
      Buffer.concat([
        Buffer.from(`{'': ${prefix}'\\`),
        Buffer.from([byte]),
        Buffer.from("é'}"),
      ]),
    );
    for (const tree of parseMany(sources)) {
      assert.deepEqual(issues(tree), [
        {
          outcome: "invalid_syntax",
          reason: "invalid_string_prefix",
          start: [0, 5],
          end: [0, 7],
        },
        { outcome: "invalid_syntax", reason, start: [0, 9], end: [0, 10] },
      ]);
      const literal = [...walk(tree)].find(
        (node) =>
          node.type === "string_literal" &&
          node.children.some((child) => child.type === "syntax_issue"),
      );
      assert.equal(
        literal.children.filter((node) => node.field === "issue").length,
        2,
      );
      assert.deepEqual(
        literal.children.find((node) => node.field === "closing").start,
        [0, 12],
      );
      assert.ok([...walk(tree)].every((node) => node.type !== "ERROR"));
    }
  }
});

test("root sign ends before an ordinary newline or comment and leaves following digits independent", () => {
  const cases = [
    { source: "-\n 1", boundary: [0, 1] },
    { source: "+ #c\n 1", boundary: [0, 2] },
  ];
  for (const [i, tree] of parseMany(
    cases.map(({ source }) => source),
  ).entries()) {
    const { source, boundary } = cases[i];
    const found = issues(tree);
    assert.deepEqual(
      found.map(({ reason }) => reason),
      [
        "non_dictionary_root",
        "missing_digits",
        "invalid_indentation",
        "extra_root_value",
      ],
      source,
    );
    assert.deepEqual(
      found[1],
      {
        reason: "missing_digits",
        outcome: "invalid_syntax",
        start: boundary,
        end: boundary,
      },
      source,
    );
    const integers = [...walk(tree)].filter((node) => node.type === "integer");
    assert.deepEqual(integers[0].end, boundary);
    assert.deepEqual(integers[1].start, [1, 1]);
    assert.equal(
      integers[0].children.some((node) => node.type === "integer_digits"),
      false,
    );
    assert.equal(integers[1].children[0].type, "integer_digits");
    if (source.includes("#"))
      assert.ok(tree.children.some((node) => node.type === "comment"));
  }
});

test("indentation outcomes depend on whether EOF additions can resolve the logical line", () => {
  const prefixes = [
    { source: "{}\n ", columns: [[1, 0, 1]] },
    {
      source: "{}\n \\\n\t",
      columns: [
        [1, 0, 1],
        [2, 0, 1],
      ],
    },
    { source: "{}\n \\\n\f", columns: [[1, 0, 1]] },
  ];
  const tails = [
    { text: "", outcome: "incomplete_syntax" },
    { text: "\\", outcome: "incomplete_syntax" },
    { text: "\\\n", outcome: "incomplete_syntax" },
    { text: "{}", outcome: "invalid_syntax" },
    { text: "@", outcome: "invalid_syntax" },
    { text: "\\x", outcome: "invalid_syntax" },
    { text: "\n", outcome: null },
    { text: "#c", outcome: null },
    { text: "\\\n\n", outcome: null },
  ];
  for (const newline of ["\n", "\r\n", "\r"]) {
    const examples = prefixes.flatMap(({ source, columns }) =>
      tails.map(({ text, outcome }) => ({
        source: (source + text).replaceAll("\n", newline),
        columns,
        outcome,
      })),
    );
    for (const [i, tree] of parseMany(
      examples.map(({ source }) => source),
    ).entries()) {
      const { source, columns, outcome } = examples[i];
      const expected =
        outcome === null
          ? []
          : columns.map(([row, start, end]) => {
              const offset =
                newline === "\r"
                  ? source
                      .split("\r")
                      .slice(0, row)
                      .reduce((n, line) => n + line.length + 1, 0)
                  : 0;
              return {
                outcome,
                reason: "invalid_indentation",
                start: [newline === "\r" ? 0 : row, offset + start],
                end: [newline === "\r" ? 0 : row, offset + end],
              };
            });
      assert.deepEqual(
        issues(tree).filter(({ reason }) => reason === "invalid_indentation"),
        expected,
        JSON.stringify(source),
      );
      assert.ok(
        [...walk(tree)].every((node) => node.type !== "ERROR"),
        JSON.stringify(source),
      );
    }
  }
});

test("a colon assigns bad key source to the next entry with or without its comma", () => {
  const runs = [
    { text: "@", reasons: ["unexpected_token"] },
    {
      text: "@ #c\n @\\\n @",
      reasons: ["unexpected_token", "unexpected_token", "unexpected_token"],
    },
    { text: ".", reasons: ["unexpected_token"] },
    { text: "\uFEFF", reasons: ["unexpected_token"] },
    {
      text: Buffer.from([0, 0xff, 0x20, 0x40]),
      reasons: ["invalid_character", "invalid_encoding", "unexpected_token"],
    },
  ];
  const examples = [];
  for (const value of ["1", "'v'", "[]", "{}", "bare"]) {
    for (const wrapper of [
      { open: "", close: "" },
      { open: "{'x':", close: "}" },
      { open: "{'x':[", close: "]}" },
    ]) {
      for (const comma of ["", ","]) {
        for (const run of runs) {
          const prefix = Buffer.from(`${wrapper.open}{'a':${value}${comma} `);
          examples.push({
            source: Buffer.concat([
              prefix,
              Buffer.from(run.text),
              Buffer.from(` : 2}${wrapper.close}`),
            ]),
            start: prefix.length,
            missing: comma === "",
            reasons: run.reasons,
          });
        }
      }
    }
  }
  for (const [i, tree] of parseMany(
    examples.map(({ source }) => source),
  ).entries()) {
    const { source, start, missing, reasons } = examples[i];
    const message = JSON.stringify(source.toString("latin1"));
    const owner = [...walk(tree)].find(
      (node) =>
        node.type === "dictionary" &&
        node.children.filter((child) => child.type === "entry").length === 2,
    );
    assert.ok(owner, message);
    const entries = owner.children.filter((node) => node.type === "entry");
    assert.deepEqual(
      issues(entries[1]).map(({ reason }) => reason),
      reasons,
      message,
    );
    assert.deepEqual(entries[1].start, [0, start], message);
    assert.equal(
      entries[1].children.find((node) => node.field === "value").type,
      "integer",
      message,
    );
    const direct = owner.children
      .filter((node) => node.type === "syntax_issue")
      .flatMap(issues);
    assert.deepEqual(
      direct,
      missing
        ? [
            {
              outcome: "invalid_syntax",
              reason: "missing_comma",
              start: [0, start],
              end: [0, start],
            },
          ]
        : [],
      message,
    );
    assert.ok(
      [...walk(tree)].every((node) => node.type !== "ERROR"),
      message,
    );
  }
});

test("bad source after a complete entry stays with the dictionary until a colon confirms a new entry", () => {
  const cases = [
    {
      source: "{'a':1 @ @}",
      dictionary: ["unexpected_token", "unexpected_token"],
      entries: [[]],
    },
    {
      source: "{'a':1 @",
      dictionary: ["unexpected_token", "missing_dictionary_close"],
      entries: [[]],
    },
    {
      source: "{'a':1 @ 'b':2}",
      dictionary: ["unexpected_token", "missing_comma"],
      entries: [[], []],
    },
    {
      source: "{'a':1 @ 2:3}",
      dictionary: ["unexpected_token", "missing_comma"],
      entries: [[], ["non_string_key"]],
    },
    {
      source: "{'a':1 @ .1:3}",
      dictionary: ["unexpected_token", "missing_comma"],
      entries: [[], ["non_string_key", "invalid_integer"]],
    },
    {
      source: "{'a':1 @, :2}",
      dictionary: ["unexpected_token"],
      entries: [[], ["missing_key"]],
    },
    {
      source: "{'a':1 @ ] :2}",
      dictionary: ["unexpected_token", "unexpected_token", "missing_comma"],
      entries: [[], ["missing_key"]],
    },
    {
      source: "{'a':1 @ :}",
      dictionary: ["missing_comma"],
      entries: [[], ["unexpected_token", "missing_value"]],
    },
    {
      source: "{'a':1 @ :",
      dictionary: ["missing_comma", "missing_dictionary_close"],
      entries: [[], ["unexpected_token", "missing_value"]],
    },
  ];
  for (const [i, tree] of parseMany(
    cases.map(({ source }) => source),
  ).entries()) {
    const expected = cases[i];
    const dictionary = tree.children.find((node) => node.type === "dictionary");
    assert.deepEqual(
      dictionary.children
        .filter((node) => node.type === "syntax_issue")
        .flatMap(issues)
        .map(({ reason }) => reason),
      expected.dictionary,
      expected.source,
    );
    assert.deepEqual(
      dictionary.children
        .filter((node) => node.type === "entry")
        .map((node) => issues(node).map(({ reason }) => reason)),
      expected.entries,
      expected.source,
    );
    assert.ok(
      [...walk(tree)].every((node) => node.type !== "ERROR"),
      expected.source,
    );
  }
});

test("bad source and extra colons keep the following value in its entry", () => {
  const patterns = [
    { text: ": ", reasons: ["unexpected_token"] },
    { text: "@ : ", reasons: ["unexpected_token", "unexpected_token"] },
    {
      text: ": @ : ",
      reasons: ["unexpected_token", "unexpected_token", "unexpected_token"],
    },
    {
      text: "@:@: ",
      reasons: [
        "unexpected_token",
        "unexpected_token",
        "unexpected_token",
        "unexpected_token",
      ],
    },
    {
      text: "@ #c\n :\\\n @ : ",
      reasons: [
        "unexpected_token",
        "unexpected_token",
        "unexpected_token",
        "unexpected_token",
      ],
    },
    { text: "\0 : ", reasons: ["invalid_character", "unexpected_token"] },
    {
      text: Buffer.from([0xff, 0x3a, 0, 0x3a, 0x20]),
      reasons: [
        "invalid_encoding",
        "unexpected_token",
        "invalid_character",
        "unexpected_token",
      ],
    },
  ];
  const values = [
    { text: "2", type: "integer", reasons: [] },
    { text: "-2", type: "integer", reasons: [] },
    { text: "[]", type: "list", reasons: [] },
    { text: "{}", type: "dictionary", reasons: [] },
    { text: "'v'", type: "string", reasons: [] },
    { text: "bare", type: undefined, reasons: ["invalid_value"] },
    { text: "01", type: "integer", reasons: ["invalid_integer"] },
  ];
  const examples = [];
  for (const wrapper of [
    { open: "", close: "" },
    { open: "{'x':", close: "}" },
    { open: "{'x':[", close: "]}" },
  ]) {
    for (const pattern of patterns) {
      for (const value of values) {
        examples.push({
          source: Buffer.concat([
            Buffer.from(`${wrapper.open}{'a': `),
            Buffer.from(pattern.text),
            Buffer.from(`${value.text}}${wrapper.close}`),
          ]),
          start: wrapper.open.length + 1,
          reasons: [...pattern.reasons, ...value.reasons],
          type: value.type,
        });
      }
    }
  }
  for (const [i, tree] of parseMany(
    examples.map(({ source }) => source),
  ).entries()) {
    const { source, start, reasons, type } = examples[i];
    const message = JSON.stringify(source.toString("latin1"));
    const entries = [...walk(tree)].filter(
      (node) =>
        node.type === "entry" && node.start[0] === 0 && node.start[1] === start,
    );
    assert.equal(entries.length, 1, message);
    assert.deepEqual(
      issues(tree).map(({ reason }) => reason),
      reasons,
      message,
    );
    assert.equal(
      entries[0].children.find((node) => node.field === "value")?.type,
      type,
      message,
    );
    assert.deepEqual(issues(entries[0]), issues(tree), message);
    assert.ok(
      [...walk(tree)].every((node) => node.type !== "ERROR"),
      message,
    );
  }
});

test("value recovery stops at separators and closes and preserves an already recognized value", () => {
  const cases = [
    {
      source: "{'a': @ :}",
      entries: [["unexpected_token", "unexpected_token"]],
      outer: [],
    },
    {
      source: "{'a': : @ :",
      entries: [["unexpected_token", "unexpected_token", "unexpected_token"]],
      outer: ["missing_dictionary_close"],
    },
    {
      source: "{'a': : :}",
      entries: [["unexpected_token", "unexpected_token", "missing_value"]],
      outer: [],
    },
    {
      source: "{'a': @ : ,'b':3}",
      entries: [["unexpected_token", "unexpected_token"], []],
      outer: [],
    },
    {
      source: "{'a': : : ,'b':3}",
      entries: [["unexpected_token", "unexpected_token", "missing_value"], []],
      outer: [],
    },
    {
      source: "{'a': @ : ] :2}",
      entries: [["unexpected_token", "unexpected_token"], ["missing_key"]],
      outer: ["unexpected_token", "missing_comma"],
    },
    {
      source: "{'a': 1 @ : 2}",
      entries: [[], ["unexpected_token"]],
      outer: ["missing_comma"],
    },
    {
      source: "{'a': bare @ : 2}",
      entries: [["invalid_value"], ["unexpected_token"]],
      outer: ["missing_comma"],
    },
  ];
  for (const [i, tree] of parseMany(
    cases.map(({ source }) => source),
  ).entries()) {
    const { source, entries, outer } = cases[i];
    const dictionary = tree.children.find((node) => node.type === "dictionary");
    assert.deepEqual(
      dictionary.children
        .filter((node) => node.type === "entry")
        .map((node) => issues(node).map(({ reason }) => reason)),
      entries,
      source,
    );
    assert.deepEqual(
      dictionary.children
        .filter((node) => node.type === "syntax_issue")
        .flatMap(issues)
        .map(({ reason }) => reason),
      outer,
      source,
    );
    assert.ok(
      [...walk(tree)].every((node) => node.type !== "ERROR"),
      source,
    );
  }
});

test("bad source after a recognized key is a value prefix unless a colon follows", () => {
  const cases = [];
  for (const wrapper of [
    { open: "", close: "" },
    { open: "{'outer':[", close: "]}" },
  ]) {
    for (const key of [
      { text: "'a'", reasons: [] },
      { text: "1", reasons: ["non_string_key"] },
      { text: "{}", reasons: ["non_string_key"] },
      { text: "[]", reasons: ["non_string_key"] },
      { text: "bare", reasons: ["invalid_value"] },
    ]) {
      for (const run of [
        { text: "@", reasons: ["unexpected_token"] },
        {
          text: ". #c\n @\\\n",
          reasons: ["unexpected_token", "unexpected_token"],
        },
        { text: "\0", reasons: ["invalid_character"] },
        { text: Buffer.from([0xff]), reasons: ["invalid_encoding"] },
        {
          text: Buffer.from([0x40, 0, 0xff]),
          reasons: [
            "unexpected_token",
            "invalid_character",
            "invalid_encoding",
          ],
        },
      ]) {
        for (const tail of [
          { text: " : 1", missing: false, value: "integer" },
          { text: " 1", missing: true, value: "integer" },
          { text: "", missing: true, value: undefined },
        ]) {
          const prefix = `${wrapper.open}{${key.text} `;
          cases.push({
            source: Buffer.concat([
              Buffer.from(prefix),
              Buffer.from(run.text),
              Buffer.from(`${tail.text}}${wrapper.close}`),
            ]),
            entryStart: wrapper.open.length + 1,
            missingAt: prefix.length,
            missing: tail.missing,
            value: tail.value,
            reasons: [
              ...key.reasons,
              ...(tail.missing ? ["missing_colon"] : []),
              ...run.reasons,
            ],
          });
        }
      }
    }
  }
  for (const [i, tree] of parseMany(
    cases.map(({ source }) => source),
  ).entries()) {
    const { source, entryStart, missingAt, missing, value, reasons } = cases[i];
    const message = JSON.stringify(source.toString("latin1"));
    const entry = [...walk(tree)].find(
      (node) => node.type === "entry" && node.start[1] === entryStart,
    );
    assert.deepEqual(
      issues(tree).map(({ reason }) => reason),
      reasons,
      message,
    );
    assert.deepEqual(issues(entry), issues(tree), message);
    assert.equal(
      entry.children.find((node) => node.field === "value")?.type,
      value,
      message,
    );
    if (missing) {
      assert.deepEqual(
        issues(entry).find(({ reason }) => reason === "missing_colon"),
        {
          outcome: "invalid_syntax",
          reason: "missing_colon",
          start: [0, missingAt],
          end: [0, missingAt],
        },
        message,
      );
    }
    assert.ok(
      [...walk(tree)].every((node) => node.type !== "ERROR"),
      message,
    );
  }
});

test("a missing colon before bad source is incomplete only while the run can gain a colon at EOF", () => {
  const cases = [
    {
      source: "{'a' @",
      outcome: "incomplete_syntax",
      tail: ["missing_dictionary_close"],
    },
    {
      source: "{'a' @ #c",
      outcome: "incomplete_syntax",
      tail: ["missing_dictionary_close"],
    },
    {
      source: "{'a' @\\\n\t",
      outcome: "incomplete_syntax",
      tail: ["missing_dictionary_close"],
    },
    {
      source: "{'a' @\\",
      outcome: "incomplete_syntax",
      tail: ["missing_line_continuation_newline", "missing_dictionary_close"],
    },
    {
      source: "{'a' @ 1",
      outcome: "invalid_syntax",
      tail: ["missing_dictionary_close"],
    },
    { source: "{'a' @, 'b':2}", outcome: "invalid_syntax", tail: [] },
    {
      source: "{'a' @]}",
      outcome: "invalid_syntax",
      tail: ["unexpected_token"],
    },
    {
      source: "{'a' @x:2}",
      outcome: "invalid_syntax",
      tail: ["invalid_value", "missing_comma", "missing_key"],
    },
    {
      source: "{'a' @.1:2}",
      outcome: "invalid_syntax",
      tail: ["invalid_integer", "missing_comma", "missing_key"],
    },
    {
      source: "{'a' @'v':2}",
      outcome: "invalid_syntax",
      tail: ["missing_comma", "missing_key"],
    },
  ];
  for (const [i, tree] of parseMany(
    cases.map(({ source }) => source),
  ).entries()) {
    const { source, outcome, tail } = cases[i];
    const found = issues(tree);
    assert.deepEqual(
      found.slice(0, 2),
      [
        { outcome, reason: "missing_colon", start: [0, 5], end: [0, 5] },
        {
          outcome: "invalid_syntax",
          reason: "unexpected_token",
          start: [0, 5],
          end: [0, 6],
        },
      ],
      source,
    );
    assert.deepEqual(
      found.slice(2).map(({ reason }) => reason),
      tail,
      source,
    );
    assert.ok(
      [...walk(tree)].every((node) => node.type !== "ERROR"),
      source,
    );
  }
});

test("a missing separator before a bare word is incomplete only while an appended quote can join the word to its string", () => {
  const cases = [
    {
      source: "['a' abc",
      reason: "missing_comma",
      outcome: "incomplete_syntax",
      word: [5, 8],
    },
    {
      source: "{'a' abc",
      reason: "missing_colon",
      outcome: "incomplete_syntax",
      word: [5, 8],
    },
    {
      source: "{'a': 'b' rb",
      reason: "missing_comma",
      outcome: "incomplete_syntax",
      word: [10, 12],
    },
    {
      source: "['a' \\ _",
      reason: "missing_comma",
      outcome: "incomplete_syntax",
      word: [7, 8],
    },
    {
      source: "[1 abc",
      reason: "missing_comma",
      outcome: "invalid_syntax",
      word: [3, 6],
    },
    {
      source: "{1 abc",
      reason: "missing_colon",
      outcome: "invalid_syntax",
      word: [3, 6],
    },
    {
      source: "['a' abc ",
      reason: "missing_comma",
      outcome: "invalid_syntax",
      word: [5, 8],
    },
    {
      source: "['a' abé",
      reason: "missing_comma",
      outcome: "invalid_syntax",
      word: [5, 9],
    },
    {
      source: "['a' abc]",
      reason: "missing_comma",
      outcome: "invalid_syntax",
      word: [5, 8],
    },
  ];
  for (const [i, tree] of parseMany(
    cases.map(({ source }) => source),
  ).entries()) {
    const { source, reason, outcome, word } = cases[i];
    assert.deepEqual(
      issues(tree).filter(
        ({ start }) => start[0] === 0 && start[1] === word[0],
      ),
      [
        { outcome, reason, start: [0, word[0]], end: [0, word[0]] },
        {
          outcome: "invalid_syntax",
          reason: "invalid_value",
          start: [0, word[0]],
          end: [0, word[1]],
        },
      ],
      source,
    );
    assert.ok(
      [...walk(tree)].every((node) => node.type !== "ERROR"),
      source,
    );
  }
});

test("root indentation owns only its physical whitespace and continuation EOF owns an empty range", () => {
  const cases = [
    {
      source: "\n \t{}",
      expected: [
        {
          outcome: "invalid_syntax",
          reason: "invalid_indentation",
          start: [1, 0],
          end: [1, 2],
        },
      ],
    },
    {
      source: "\f {}",
      expected: [
        {
          outcome: "invalid_syntax",
          reason: "invalid_indentation",
          start: [0, 0],
          end: [0, 2],
        },
      ],
    },
    {
      source: "{}\n ",
      expected: [
        {
          outcome: "incomplete_syntax",
          reason: "invalid_indentation",
          start: [1, 0],
          end: [1, 1],
        },
      ],
    },
    {
      source: "\n \\\n\f{}",
      expected: [
        {
          outcome: "invalid_syntax",
          reason: "invalid_indentation",
          start: [1, 0],
          end: [1, 1],
        },
      ],
    },
    {
      source: "{}\\\n",
      expected: [
        {
          outcome: "incomplete_syntax",
          reason: "missing_line_continuation_content",
          start: [1, 0],
          end: [1, 0],
        },
      ],
    },
  ];
  for (const [index, tree] of parseMany(
    cases.map(({ source }) => source),
  ).entries()) {
    const { source, expected } = cases[index];
    assert.deepEqual(issues(tree), expected, source);
    const owner =
      expected[0].reason === "invalid_indentation"
        ? tree
        : [...walk(tree)].find((node) => node.type === "line_continuation");
    assert.ok(
      owner.children.some(
        (node) => node.type === "syntax_issue" && node.field === "issue",
      ),
    );
  }
});

test("bad source and colon issues occupy separate exact ranges in the same entry", () => {
  const tree = parse("{'a': @ : 2}");
  assert.deepEqual(issues(tree), [
    {
      outcome: "invalid_syntax",
      reason: "unexpected_token",
      start: [0, 6],
      end: [0, 7],
    },
    {
      outcome: "invalid_syntax",
      reason: "unexpected_token",
      start: [0, 8],
      end: [0, 9],
    },
  ]);
  const entry = [...walk(tree)].find((node) => node.type === "entry");
  assert.deepEqual(
    entry.children
      .filter((node) => node.type === "syntax_issue")
      .flatMap(issues),
    issues(tree),
  );
  assert.deepEqual(
    entry.children.find((node) => node.field === "value").start,
    [0, 10],
  );
});
