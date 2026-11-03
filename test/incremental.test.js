import assert from "node:assert/strict";
import test from "node:test";
import { parse, parseMany } from "./support/cli.js";

const histories = [
  {
    name: "key gap becomes a value prefix when its colon is removed across comments and continuations",
    source: "{'a' @ #c\n @\\\n : 1}",
    edits: [
      { start: 15, deleted: 1, inserted: "" },
      { start: 15, deleted: 0, inserted: ":" },
      { start: 15, deleted: 3, inserted: "" },
      { start: 15, deleted: 0, inserted: ": 1" },
      { start: 15, deleted: 1, inserted: ", 'b':" },
    ],
  },
  {
    name: "EOF appends resolve or invalidate the colon missing before a bad source run",
    source: "{'a' @",
    edits: [
      { start: 6, deleted: 0, inserted: " #c\n: 1}" },
      { start: 6, deleted: 8, inserted: "" },
      { start: 6, deleted: 0, inserted: "}" },
      { start: 6, deleted: 1, inserted: " 1}" },
      { start: 6, deleted: 3, inserted: "" },
      { start: 6, deleted: 0, inserted: "@ : 1}" },
      { start: 8, deleted: 2, inserted: "" },
    ],
  },
  {
    name: "EOF appends resolve or invalidate the separator missing before a bare word, also after its string is reused",
    source: "{'a' abc",
    edits: [
      { start: 8, deleted: 0, inserted: "''" },
      { start: 8, deleted: 2, inserted: "" },
      { start: 4, deleted: 0, inserted: ": 'b'" },
      { start: 2, deleted: 0, inserted: "z" },
      { start: 2, deleted: 1, inserted: "" },
      { start: 13, deleted: 0, inserted: " " },
      { start: 13, deleted: 1, inserted: "" },
      { start: 13, deleted: 0, inserted: "''}" },
      { start: 13, deleted: 3, inserted: "" },
      { start: 10, deleted: 3, inserted: "abé" },
    ],
  },
  {
    name: "a multibyte value after a key gap changes its boundary when a continuation byte breaks",
    source: Buffer.concat([
      Buffer.from("{'a' @ "),
      Buffer.from([0xff]),
      Buffer.from(": 1}"),
    ]),
    edits: [
      { start: 7, deleted: 1, inserted: "é" },
      { start: 8, deleted: 1, inserted: "@" },
      { start: 7, deleted: 2, inserted: "é" },
      { start: 7, deleted: 2, inserted: "" },
    ],
  },
  {
    name: "value recovery changes ownership only when a value or comma is inserted",
    source: "{'a': @ : 2}",
    edits: [
      { start: 6, deleted: 0, inserted: "1 " },
      { start: 6, deleted: 2, inserted: "" },
      { start: 8, deleted: 0, inserted: "," },
      { start: 8, deleted: 1, inserted: "" },
      { start: 6, deleted: 1, inserted: ":" },
      { start: 6, deleted: 1, inserted: "@" },
      { start: 10, deleted: 1, inserted: "" },
      { start: 10, deleted: 0, inserted: "2" },
      { start: 8, deleted: 0, inserted: "#c\n" },
      { start: 12, deleted: 2, inserted: "\\\n, 'b': 3" },
      { start: 14, deleted: 0, inserted: ":" },
      { start: 14, deleted: 1, inserted: "#d\n2" },
    ],
  },
  {
    name: "bad key source changes owner when the confirming colon or comma is edited",
    source: "{'a':1 @ @ :2}",
    edits: [
      { start: 10, deleted: 1, inserted: "" },
      { start: 10, deleted: 0, inserted: ":" },
      { start: 6, deleted: 0, inserted: "," },
      { start: 6, deleted: 1, inserted: "" },
      { start: 8, deleted: 0, inserted: "#c\n" },
      { start: 8, deleted: 3, inserted: "" },
      { start: 9, deleted: 1, inserted: "'k'" },
    ],
  },
  {
    name: "continued indentation changes between incomplete invalid and blank after EOF edits",
    source: "{}\n \\\n\t",
    edits: [
      { start: 7, deleted: 0, inserted: "{}" },
      { start: 7, deleted: 2, inserted: "" },
      { start: 7, deleted: 0, inserted: "#c" },
      { start: 7, deleted: 2, inserted: "\\" },
      { start: 8, deleted: 0, inserted: "\n" },
      { start: 9, deleted: 0, inserted: "\n" },
      { start: 9, deleted: 1, inserted: "" },
    ],
  },
  {
    name: "root scalar joins change when containers or explicit continuations are added and removed",
    source: "'a'\n 'b'",
    edits: [
      { start: 3, deleted: 0, inserted: "\\" },
      { start: 3, deleted: 1, inserted: "" },
      { start: 8, deleted: 0, inserted: "]" },
      { start: 0, deleted: 0, inserted: "[" },
      { start: 0, deleted: 1, inserted: "" },
    ],
  },
  {
    name: "root strings rejoin when a continuation loses or regains its newline",
    source: "'a' \\\n'b'",
    edits: [
      { start: 5, deleted: 1, inserted: " " },
      { start: 5, deleted: 1, inserted: "" },
      { start: 5, deleted: 0, inserted: "\n\n" },
      { start: 6, deleted: 1, inserted: "" },
    ],
  },
  {
    name: "damaged root integer digits follow logical-line edits after the invalid byte",
    source: Buffer.concat([
      Buffer.from("-"),
      Buffer.from([0xff]),
      Buffer.from(" 12"),
    ]),
    edits: [
      { start: 2, deleted: 0, inserted: "\n" },
      { start: 2, deleted: 1, inserted: "\\\n" },
      { start: 2, deleted: 2, inserted: "\\" },
      { start: 2, deleted: 1, inserted: "#" },
      { start: 2, deleted: 1, inserted: "@" },
      { start: 2, deleted: 1, inserted: "" },
    ],
  },
  {
    name: "root sign and missing digits respond to logical-line and container edits",
    source: "-\n 1",
    edits: [
      { start: 1, deleted: 0, inserted: "\\" },
      { start: 1, deleted: 1, inserted: "" },
      { start: 4, deleted: 0, inserted: "]" },
      { start: 0, deleted: 0, inserted: "[" },
      { start: 0, deleted: 1, inserted: "" },
      { start: 1, deleted: 0, inserted: "# c" },
    ],
  },
  {
    name: "root layout changes after initial newline, form feed and blank-line edits",
    source: " {}\n ",
    edits: [
      { start: 0, deleted: 0, inserted: "\n" },
      { start: 2, deleted: 0, inserted: "\f" },
      { start: 7, deleted: 0, inserted: "\n" },
      { start: 2, deleted: 1, inserted: "" },
      { start: 0, deleted: 1, inserted: "" },
    ],
  },
  {
    name: "continued indentation is reclassified when a distant blank line becomes a value",
    source: "\n \\\n\f# c\n{}",
    edits: [
      { start: 5, deleted: 4, inserted: "" },
      { start: 5, deleted: 0, inserted: "\n" },
      { start: 5, deleted: 1, inserted: "# c\n" },
      { start: 2, deleted: 2, inserted: "" },
    ],
  },
  {
    name: "continued indentation follows a backslash losing and regaining its newline",
    source: Buffer.concat([
      Buffer.from("#c\n \\"),
      Buffer.from([0xff]),
      Buffer.from("\n {}"),
    ]),
    edits: [
      { start: 8, deleted: 2, inserted: "#d" },
      { start: 5, deleted: 1, inserted: "" },
      { start: 5, deleted: 0, inserted: "#" },
      { start: 5, deleted: 1, inserted: " " },
      { start: 8, deleted: 2, inserted: "{}" },
    ],
  },
  {
    name: "root string end is reclassified when a following literal appears or disappears",
    source: "{} 'a'\n {}",
    edits: [
      { start: 8, deleted: 0, inserted: "'b'" },
      { start: 8, deleted: 3, inserted: "" },
      { start: 6, deleted: 0, inserted: " #c" },
      { start: 10, deleted: 3, inserted: "r'x'" },
      { start: 11, deleted: 3, inserted: "" },
      { start: 10, deleted: 1, inserted: "x" },
    ],
  },
  {
    name: "terminal continuation content appears and disappears at EOF",
    source: "{}\\\r\n",
    edits: [
      { start: 5, deleted: 0, inserted: " " },
      { start: 5, deleted: 1, inserted: "" },
      { start: 5, deleted: 0, inserted: "\n " },
      { start: 3, deleted: 2, inserted: "\n" },
    ],
  },
  {
    name: "prefix edits switch between ordinary, raw and uninterpreted bodies without leaking state",
    source: String.raw`{'': br'\x1' '\x1'}`,
    edits: [
      { start: 5, deleted: 1, inserted: "" },
      { start: 5, deleted: 1, inserted: "u" },
      { start: 5, deleted: 1, inserted: "fr" },
      { start: 5, deleted: 2, inserted: "rr" },
      { start: 5, deleted: 2, inserted: "rF" },
      { start: 5, deleted: 2, inserted: "" },
    ],
  },
  {
    name: "unknown prefix body retains protected quotes and newlines across edits",
    source: String.raw`{'': rr'a\'b'}`,
    edits: [
      { start: 5, deleted: 2, inserted: "br" },
      { start: 5, deleted: 2, inserted: "ur" },
      { start: 10, deleted: 1, inserted: "\n" },
      { start: 9, deleted: 1, inserted: "" },
      { start: 9, deleted: 0, inserted: "\\" },
    ],
  },
  {
    name: "non-ASCII literal suffixes broken, restored and reclassified by their first character",
    source: "{'': [aé, 1é, é]}",
    edits: [
      { start: 8, deleted: 1, inserted: "x" },
      { start: 7, deleted: 2, inserted: "é" },
      { start: 6, deleted: 1, inserted: "1" },
      { start: 7, deleted: 2, inserted: "" },
      { start: 7, deleted: 0, inserted: "é" },
    ],
  },
  {
    name: "inserting a list ancestor changes a stray close into a structural boundary",
    source: "{'a':{'b':1], 'c':2}}",
    edits: [
      { start: 5, deleted: 0, inserted: "[" },
      { start: 5, deleted: 1, inserted: "" },
      { start: 11, deleted: 1, inserted: "" },
    ],
  },
  {
    name: "inserting a dictionary ancestor changes a stray close in nested lists",
    source: "[[1},2],3]",
    edits: [
      { start: 0, deleted: 0, inserted: "{'a':" },
      { start: 0, deleted: 5, inserted: "" },
      { start: 3, deleted: 1, inserted: "" },
    ],
  },
  {
    name: "extra dictionary and list colons repaired without losing surrounding structure",
    source: "{'a'::[1:2], 'b':3}",
    edits: [
      { start: 5, deleted: 1, inserted: "" },
      { start: 7, deleted: 1, inserted: "," },
      { start: 5, deleted: 0, inserted: ":" },
    ],
  },
  {
    name: "invalid byte after prefix lookahead removed in two edits",
    source: Buffer.concat([
      Buffer.from("{'a' abc"),
      Buffer.from([0xff]),
      Buffer.from(":1}"),
    ]),
    edits: [
      { start: 5, deleted: 3, inserted: "" },
      { start: 5, deleted: 1, inserted: "" },
    ],
  },
  {
    name: "damaged signed integer digits repaired after removing the invalid byte",
    source: Buffer.concat([
      Buffer.from("{'': -"),
      Buffer.from([0xff]),
      Buffer.from("12}"),
    ]),
    edits: [
      { start: 6, deleted: 1, inserted: "" },
      { start: 5, deleted: 1, inserted: "+" },
    ],
  },
  {
    name: "damaged line continuation repaired before newline deletion and reinsertion",
    source: Buffer.concat([
      Buffer.from("{}\\"),
      Buffer.from([0xff]),
      Buffer.from("\n"),
    ]),
    edits: [
      { start: 3, deleted: 1, inserted: "" },
      { start: 3, deleted: 1, inserted: "" },
      { start: 3, deleted: 0, inserted: "\n" },
    ],
  },
  {
    name: "list punctuation deletion, repair and EOF truncation",
    source: "{'k': [1, 2]}",
    edits: [
      { start: 8, deleted: 1, inserted: "" },
      { start: 8, deleted: 0, inserted: "," },
      { start: 11, deleted: 2, inserted: "" },
      { start: 11, deleted: 0, inserted: "]}" },
    ],
  },
  {
    name: "raw prefix insertion, escape repair and quote replacement",
    source: String.raw`{'k': '\x1'}`,
    edits: [
      { start: 6, deleted: 0, inserted: "r" },
      { start: 6, deleted: 1, inserted: "" },
      { start: 10, deleted: 0, inserted: "2" },
      { start: 6, deleted: 1, inserted: "'''" },
      { start: 13, deleted: 1, inserted: "'''" },
    ],
  },
  {
    name: "comment boundaries, line continuation and multibyte replacement",
    source: "{'k': '日', # tail\n'b': 2}",
    edits: [
      { start: 13, deleted: 1, inserted: "" },
      { start: 13, deleted: 0, inserted: "#" },
      { start: 7, deleted: 3, inserted: "🙂" },
      { start: 14, deleted: 0, inserted: "\\\n" },
      { start: 15, deleted: 1, inserted: "" },
      { start: 15, deleted: 0, inserted: "\n" },
    ],
  },
  {
    name: "multibyte characters broken after invalid bytes, escapes, signs and line continuations",
    source: Buffer.concat([
      Buffer.from("{'a': '"),
      Buffer.from([0xff]),
      Buffer.from("日', 'b': '\\x1é', 'c': -é}\\é\n"),
    ]),
    edits: [
      { start: 10, deleted: 1, inserted: "x" },
      { start: 24, deleted: 1, inserted: "x" },
      { start: 35, deleted: 1, inserted: "x" },
      { start: 39, deleted: 1, inserted: "x" },
    ],
  },
  {
    name: "literals and bad source continued after comments and line continuations",
    source: Buffer.concat([
      Buffer.from(
        "{'k' #c\n: 1, 'v': 'a' \\\n, 'w': @ #c\n, 'u': 'b\n#c\n, 's': -",
      ),
      Buffer.from([0xff]),
      Buffer.from(" #c\n, 'z': 1}"),
    ]),
    edits: [
      { start: 62, deleted: 0, inserted: "1" },
      { start: 49, deleted: 1, inserted: "'c'" },
      { start: 36, deleted: 0, inserted: "1" },
      { start: 24, deleted: 1, inserted: "'y'" },
      { start: 8, deleted: 1, inserted: "'x'" },
    ],
  },
];

for (const history of histories) {
  test(`${history.name} matches fresh CST after every edit`, () => {
    let source = Buffer.from(history.source);
    const edits = [];
    for (const { start, deleted, inserted } of history.edits) {
      source = Buffer.concat([
        source.subarray(0, start),
        Buffer.from(inserted),
        source.subarray(start + deleted),
      ]);
      edits.push(`${start} ${deleted} ${inserted}`);
      const incremental = parse(history.source, edits);
      const fresh = parse(source);
      const message = `${history.name}: edit ${edits.length}`;
      assert.equal(incremental.hasError, false, message);
      assert.equal(fresh.hasError, false, message);
      assert.deepEqual(incremental, fresh, message);
    }
  });
}

test("fixed insertion and removal histories across every token boundary match fresh CST", () => {
  const source = "{'k': [r'a', -2, {'b': '''c'''}]}";
  const insertion = "#\n";
  const sources = Array.from(
    { length: source.length + 1 },
    (_, index) => source.slice(0, index) + insertion + source.slice(index),
  );
  const fresh = parseMany(sources);
  const original = parse(source);
  for (let index = 0; index < sources.length; index++) {
    const edit = `${index} 0 ${insertion}`;
    assert.deepEqual(
      parse(source, [edit]),
      fresh[index],
      `insertion at ${index}`,
    );
    assert.deepEqual(
      parse(source, [edit, `${index} ${insertion.length} `]),
      original,
      `repair at ${index}`,
    );
  }
});
