import assert from "node:assert/strict";

export function readTrees(output) {
  const roots = [];
  const stack = [];
  for (const line of output.split("\n")) {
    const position = /^([0-9]+):([0-9]+) +- +([0-9]+):([0-9]+) +/.exec(line);
    if (!position) continue;
    const [location, startRow, startColumn, endRow, endColumn] = position;
    const body = line.slice(location.length);
    // Multiline leaf text is displayed on extra lines without a node type.
    if (body.startsWith("`")) continue;
    const match =
      /^(•)?(([a-z_0-9]+): )?([a-z_A-Z0-9]+|"([^"\\]|\\.)*")( |$)/.exec(body);
    assert.ok(match, line);
    const [, error, , field, kind] = match;
    const named = !kind.startsWith('"');
    const node = {
      type: named ? kind : JSON.parse(kind),
      named,
      field: field ?? null,
      start: [Number(startRow), Number(startColumn)],
      end: [Number(endRow), Number(endColumn)],
      hasError: Boolean(error),
      children: [],
    };
    const depth = location.length + (error ? 1 : 0);
    if (node.type === "source_file" && node.field === null) stack.length = 0;
    while (stack.length && stack.at(-1).depth >= depth) stack.pop();
    const parent = stack.at(-1)?.node;
    (parent ? parent.children : roots).push(node);
    stack.push({ node, depth });
  }
  return roots;
}

export function* walk(node) {
  yield node;
  for (const child of node.children) yield* walk(child);
}

export function issues(tree) {
  return [...walk(tree)]
    .filter((node) => node.type === "syntax_issue")
    .map((node) => ({
      outcome: node.children[0].type,
      reason: node.children[0].children[0].type,
      start: node.start,
      end: node.end,
    }));
}
