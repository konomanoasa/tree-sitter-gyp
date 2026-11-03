use konomanoasa_tree_sitter_gyp as grammar;
use tree_sitter::{Parser, Query, QueryCursor, StreamingIterator};

#[test]
fn parses_valid_source() {
  let language = grammar::LANGUAGE.into();
  let mut parser = Parser::new();
  parser.set_language(&language).unwrap();
  let source = br#"{"a":[1,"x"]}"#;
  let tree = parser.parse(source, None).unwrap();
  let root = tree.root_node();
  assert_eq!(root.kind(), "source_file");
  assert_eq!(root.byte_range(), 0..source.len());
  assert!(!root.has_error());
  assert!(grammar::NODE_TYPES.contains("\"source_file\""));
  let query = Query::new(&language, grammar::HIGHLIGHTS_QUERY).unwrap();
  let mut cursor = QueryCursor::new();
  let mut captures = cursor.captures(&query, root, source.as_slice());
  let mut numbers = Vec::new();
  while let Some((matched, index)) = captures.next() {
    let capture = matched.captures()[*index];
    if query.capture_names()[capture.index as usize] == "number" {
      numbers.push(capture.node.utf8_text(source).unwrap());
    }
  }
  assert_eq!(numbers, ["1"]);
}
