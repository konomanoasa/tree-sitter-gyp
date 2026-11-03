import assert from "node:assert/strict";
import { test } from "node:test";
import GYP from "@konomanoasa/tree-sitter-gyp";
import Parser from "tree-sitter";

test("Node.js language parses GYP with the scanner and exposes node metadata", () => {
  const parser = new Parser();
  parser.setLanguage(GYP);
  const source = '{"a":[1,"x"]}';
  const tree = parser.parse(source);
  assert.equal(tree.rootNode.type, "source_file");
  assert.equal(tree.rootNode.hasError, false);
  assert.equal(tree.rootNode.text, source);
  assert.equal(tree.rootNode.descendantsOfType("syntax_issue").length, 0);
  assert.ok(
    GYP.nodeTypeInfo.some((node) => node.type === "source_file" && node.named),
  );
});

test("Node.js packaged highlights capture GYP integer digits", () => {
  const parser = new Parser();
  parser.setLanguage(GYP);
  const tree = parser.parse('{"a":1}');
  const query = new Parser.Query(GYP, GYP.HIGHLIGHTS_QUERY);
  assert.deepEqual(
    query
      .captures(tree.rootNode)
      .filter(({ name }) => name === "number")
      .map(({ name, node }) => [name, node.text]),
    [["number", "1"]],
  );
});
