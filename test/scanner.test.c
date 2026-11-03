#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../src/tree_sitter/parser.h"

typedef struct {
  TSLexer lexer;
  const int32_t *input;
  size_t length;
  size_t position;
  size_t end;
} Input;

static void refresh(Input *input) {
  input->lexer.lookahead =
    input->position < input->length ? input->input[input->position] : 0;
}

static void move(TSLexer *lexer, bool skip) {
  Input *input = (Input *)lexer;
  (void)skip;
  assert(input->position < input->length);
  input->position++;
  refresh(input);
}

static void mark(TSLexer *lexer) {
  Input *input = (Input *)lexer;
  input->end = input->position;
}

static bool at_end(const TSLexer *lexer) {
  const Input *input = (const Input *)lexer;
  return input->position == input->length;
}

static Input input(const int32_t *source, size_t length) {
  Input result = {
    .lexer = {.advance = move, .mark_end = mark, .eof = at_end},
    .input = source,
    .length = length
  };
  refresh(&result);
  return result;
}

#include "../src/scanner.c"

static void
take(void *scanner, Input *source, enum Token expected, size_t end) {
  bool valid[ERROR_SENTINEL + 1] = {false};
  valid[expected] = true;
  valid[LAYOUT] = true;
  do {
    source->position = source->end;
    refresh(source);
    assert(
      tree_sitter_gyp_external_scanner_scan(scanner, &source->lexer, valid)
    );
  } while (expected != LAYOUT && source->lexer.result_symbol == LAYOUT);
  assert(source->lexer.result_symbol == expected);
  assert(source->end == end);
  char saved[TREE_SITTER_SERIALIZATION_BUFFER_SIZE] = {0};
  char restored[TREE_SITTER_SERIALIZATION_BUFFER_SIZE] = {0};
  const unsigned length =
    tree_sitter_gyp_external_scanner_serialize(scanner, saved);
  assert(length == 9);
  tree_sitter_gyp_external_scanner_deserialize(scanner, NULL, 0);
  tree_sitter_gyp_external_scanner_deserialize(scanner, saved, length);
  assert(
    tree_sitter_gyp_external_scanner_serialize(scanner, restored) == length
  );
  assert(memcmp(saved, restored, length) == 0);
}

static void raw_quote_protection_survives_serialization(void) {
  const int32_t text[] = {'r', '\'', '\\', '\'', 'x', '\''};
  Input source = input(text, sizeof(text) / sizeof(text[0]));
  void *scanner = tree_sitter_gyp_external_scanner_create();
  assert(scanner);
  take(scanner, &source, STRING_PREFIX, 1);
  take(scanner, &source, STRING_START, 2);
  take(scanner, &source, RAW_ESCAPE, 4);
  take(scanner, &source, STRING_CONTENT, 5);
  take(scanner, &source, STRING_END, 6);
  char state[9];
  assert(tree_sitter_gyp_external_scanner_serialize(scanner, state) == 9);
  assert(memcmp(state, "\0\0\0\0", 4) == 0);
  tree_sitter_gyp_external_scanner_destroy(scanner);
}

static void unsupported_prefix_modes_survive_serialization_and_reset(void) {
  const struct {
    const char *prefix;
    bool raw;
  } cases[] = {
    {"br", true},
    {"rb", true},
    {"fr", true},
    {"rf", true},
    {"bR", true},
    {"Rb", true},
    {"Fr", true},
    {"RF", true},
    {"b", false},
    {"f", false},
    {"rr", false},
    {"ur", false},
    {"brf", false},
    {"qr", false},
  };
  for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
    int32_t text[32];
    const size_t prefix_length = strlen(cases[i].prefix);
    const char *tail = "'\\x1' '\\x1'";
    const size_t length = prefix_length + strlen(tail);
    assert(length <= sizeof(text) / sizeof(text[0]));
    for (size_t j = 0; j < prefix_length; j++) text[j] = cases[i].prefix[j];
    for (size_t j = 0; j < strlen(tail); j++) text[prefix_length + j] = tail[j];
    Input source = input(text, length);
    void *scanner = tree_sitter_gyp_external_scanner_create();
    assert(scanner);
    take(scanner, &source, INVALID_PREFIX, prefix_length);
    take(scanner, &source, STRING_START, prefix_length + 1);
    if (cases[i].raw) take(scanner, &source, RAW_ESCAPE, prefix_length + 3);
    take(scanner, &source, STRING_CONTENT, prefix_length + 4);
    take(scanner, &source, STRING_END, prefix_length + 5);
    take(scanner, &source, STRING_START, prefix_length + 7);
    take(scanner, &source, INVALID_ESCAPE, prefix_length + 10);
    take(scanner, &source, STRING_END, prefix_length + 11);
    tree_sitter_gyp_external_scanner_destroy(scanner);
  }
}

static void quote_lookahead_keeps_empty_literal_boundary(void) {
  const int32_t text[] = {'\'', '\''};
  Input source = input(text, sizeof(text) / sizeof(text[0]));
  void *scanner = tree_sitter_gyp_external_scanner_create();
  assert(scanner);
  take(scanner, &source, STRING_START, 1);
  assert(source.position == 2);
  take(scanner, &source, STRING_END, 2);
  tree_sitter_gyp_external_scanner_destroy(scanner);
}

static void triple_quoted_state_survives_newlines(void) {
  const int32_t text[] = {'"', '"', '"', 'a', '\n', 'b', '"', '"', '"'};
  Input source = input(text, sizeof(text) / sizeof(text[0]));
  void *scanner = tree_sitter_gyp_external_scanner_create();
  assert(scanner);
  take(scanner, &source, STRING_START, 3);
  take(scanner, &source, STRING_CONTENT, 6);
  take(scanner, &source, STRING_END, 9);
  tree_sitter_gyp_external_scanner_destroy(scanner);
}

static void incomplete_escape_and_zero_width_close_clear_state(void) {
  const int32_t text[] = {'\'', '\\', 'x'};
  Input source = input(text, sizeof(text) / sizeof(text[0]));
  void *scanner = tree_sitter_gyp_external_scanner_create();
  assert(scanner);
  take(scanner, &source, STRING_START, 1);
  take(scanner, &source, INCOMPLETE_ESCAPE, 3);
  take(scanner, &source, EOF_STRING_CLOSE, 3);
  char state[9];
  tree_sitter_gyp_external_scanner_serialize(scanner, state);
  assert(memcmp(state, "\0\0\0\0", 4) == 0);
  tree_sitter_gyp_external_scanner_destroy(scanner);
}

static void invalid_encoding_does_not_consume_escape_or_quote(void) {
  const int32_t text[] = {'\'', '\\', -1, '\''};
  Input source = input(text, sizeof(text) / sizeof(text[0]));
  void *scanner = tree_sitter_gyp_external_scanner_create();
  assert(scanner);
  take(scanner, &source, STRING_START, 1);
  take(scanner, &source, ESCAPE_FRAGMENT, 2);
  take(scanner, &source, INVALID_ENCODING, 3);
  take(scanner, &source, STRING_END, 4);
  tree_sitter_gyp_external_scanner_destroy(scanner);
}

static void comment_ends_before_crlf_and_releases_state(void) {
  const int32_t text[] = {'#', 'a', '\r', '\n'};
  Input source = input(text, sizeof(text) / sizeof(text[0]));
  void *scanner = tree_sitter_gyp_external_scanner_create();
  assert(scanner);
  take(scanner, &source, COMMENT_START, 1);
  take(scanner, &source, COMMENT_CONTENT, 2);
  take(scanner, &source, COMMENT_END, 2);
  char state[9];
  tree_sitter_gyp_external_scanner_serialize(scanner, state);
  assert(memcmp(state, "\0\0\0\0", 4) == 0);
  tree_sitter_gyp_external_scanner_destroy(scanner);
}

static void nul_is_distinct_from_eof(void) {
  const int32_t text[] = {0, 0, '}'};
  Input source = input(text, sizeof(text) / sizeof(text[0]));
  void *scanner = tree_sitter_gyp_external_scanner_create();
  assert(scanner);
  take(scanner, &source, INVALID_CHARACTER, 2);
  take(scanner, &source, MISSING_VALUE, 2);
  assert(source.lexer.lookahead == '}');
  tree_sitter_gyp_external_scanner_destroy(scanner);
}

static void line_continuation_recovery_keeps_the_following_token(void) {
  const int32_t text[] = {'x'};
  Input source = input(text, sizeof(text) / sizeof(text[0]));
  bool valid[ERROR_SENTINEL + 1] = {false};
  valid[LINE_CONTINUATION_END] = true;
  valid[LINE_CONTINUATION_RECOVERY_END] = true;
  void *scanner = tree_sitter_gyp_external_scanner_create();
  assert(scanner);
  assert(tree_sitter_gyp_external_scanner_scan(scanner, &source.lexer, valid));
  assert(source.lexer.result_symbol == LINE_CONTINUATION_RECOVERY_END);
  assert(source.position == 0);
  assert(source.end == 0);
  assert(source.lexer.lookahead == 'x');
  tree_sitter_gyp_external_scanner_destroy(scanner);
}

static void error_recovery_and_absent_payload_do_not_read_input(void) {
  const int32_t text[] = {'\''};
  Input source = input(text, sizeof(text) / sizeof(text[0]));
  bool valid[ERROR_SENTINEL + 1];
  for (size_t i = 0; i < sizeof(valid) / sizeof(valid[0]); i++) valid[i] = true;
  void *scanner = tree_sitter_gyp_external_scanner_create();
  assert(scanner);
  assert(!tree_sitter_gyp_external_scanner_scan(scanner, &source.lexer, valid));
  assert(source.position == 0);
  assert(!tree_sitter_gyp_external_scanner_scan(NULL, &source.lexer, valid));
  char state[9];
  assert(tree_sitter_gyp_external_scanner_serialize(NULL, state) == 0);
  tree_sitter_gyp_external_scanner_deserialize(NULL, NULL, 0);
  tree_sitter_gyp_external_scanner_destroy(NULL);
  tree_sitter_gyp_external_scanner_destroy(scanner);
}

int main(void) {
  raw_quote_protection_survives_serialization();
  unsupported_prefix_modes_survive_serialization_and_reset();
  quote_lookahead_keeps_empty_literal_boundary();
  triple_quoted_state_survives_newlines();
  incomplete_escape_and_zero_width_close_clear_state();
  invalid_encoding_does_not_consume_escape_or_quote();
  comment_ends_before_crlf_and_releases_state();
  nul_is_distinct_from_eof();
  line_continuation_recovery_keeps_the_following_token();
  error_recovery_and_absent_payload_do_not_read_input();
  puts("10 scanner tests passed");
  return 0;
}
