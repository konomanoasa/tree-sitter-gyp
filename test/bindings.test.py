import unittest
from types import CapsuleType

import tree_sitter_gyp

from tree_sitter import Language, Parser, Query, QueryCursor


class BindingsTest(unittest.TestCase):
    def test_language_capsule_parses_source(self):
        capsule = tree_sitter_gyp.language()
        self.assertIsInstance(capsule, CapsuleType)
        language = Language(capsule)
        self.assertEqual(language.name, "gyp")
        source = b'{"a":[1,"x"]}'
        tree = Parser(language).parse(source)
        self.assertEqual(tree.root_node.type, "source_file")
        self.assertFalse(tree.root_node.has_error)
        self.assertEqual(tree.root_node.text, source)

    def test_packaged_highlights_capture_number(self):
        language = Language(tree_sitter_gyp.language())
        tree = Parser(language).parse(b'{"a":1}')
        query = Query(language, tree_sitter_gyp.HIGHLIGHTS_QUERY)
        captures = QueryCursor(query).captures(tree.root_node)
        self.assertEqual([node.text for node in captures["number"]], [b"1"])


if __name__ == "__main__":
    unittest.main()
