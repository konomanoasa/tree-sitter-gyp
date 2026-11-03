#include "tree_sitter/parser.h"
#include <stdint.h>
#include <stdlib.h>

enum Token {
  STRING_PREFIX,
  STRING_START,
  STRING_END,
  STRING_CONTENT,
  ESCAPE_SEQUENCE,
  RAW_ESCAPE,
  ESCAPE_FRAGMENT,
  COMMENT_START,
  COMMENT_CONTENT,
  COMMENT_END,
  LINE_CONTINUATION_START,
  LINE_CONTINUATION_END,
  LINE_CONTINUATION_RECOVERY_END,
  DIGITS,
  INVALID_VALUE,
  UNEXPECTED_TOKEN,
  INVALID_CHARACTER,
  INVALID_ENCODING,
  INVALID_INTEGER,
  INVALID_PREFIX,
  INVALID_ESCAPE,
  INCOMPLETE_ESCAPE,
  INVALID_UNICODE_ESCAPE,
  MISSING_DICTIONARY,
  MISSING_KEY,
  MISSING_COLON,
  EOF_COLON,
  MISSING_VALUE,
  EOF_VALUE,
  MISSING_DIGITS,
  EOF_DIGITS,
  MISSING_DICTIONARY_CLOSE,
  EOF_DICTIONARY_CLOSE,
  MISSING_LIST_CLOSE,
  EOF_LIST_CLOSE,
  MISSING_STRING_CLOSE,
  EOF_STRING_CLOSE,
  MISSING_COMMA,
  EOF_COMMA,
  EOF_STRING_OPEN,
  INVALID_LINE_CONTINUATION,
  EOF_LINE_CONTINUATION,
  COLON,
  LAYOUT,
  INVALID_INDENTATION,
  EOF_INDENTATION,
  ROOT_BEGIN,
  ROOT_END,
  TERMINAL_CONTINUATION_NEWLINE,
  EOF_CONTINUATION_CONTENT,
  DICTIONARY_BAD_RUN,
  KEY_BAD_RUN,
  ERROR_SENTINEL
};

enum StringMode { STRING_ESCAPED, STRING_RAW, STRING_OPAQUE };
enum LineTail { LINE_UNKNOWN, LINE_BLANK, LINE_INCOMPLETE, LINE_CONTENT };
enum Next { NEXT_OTHER, NEXT_LITERAL, NEXT_INTEGER_PART, NEXT_EOF_JOIN };
enum RunEnd { RUN_COLON, RUN_EOF, RUN_OTHER };

typedef struct {
  uint8_t quote;
  bool triple;
  enum StringMode mode;
  bool comment;
  bool started;
  bool implicit_join;
  bool active_line;
  enum LineTail line_tail;
  enum Next next;
} Scanner;

typedef struct {
  unsigned count;
  int32_t first;
  int32_t second;
  bool ascii;
} Word;

static void advance(TSLexer *lexer) {
  lexer->advance(lexer, false);
}
static bool newline(int32_t c) {
  return c == '\n' || c == '\r';
}
static bool horizontal_space(int32_t c) {
  return c == ' ' || c == '\t' || c == '\f';
}
static bool space(int32_t c) {
  return horizontal_space(c) || newline(c);
}
static bool digit(int32_t c) {
  return c >= '0' && c <= '9';
}
static bool number_start(int32_t first, int32_t second) {
  return digit(first) || (first == '.' && digit(second));
}
static bool letter(int32_t c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_';
}
static bool quote(int32_t c) {
  return c == '\'' || c == '"';
}
static bool invalid_encoding(int32_t c) {
  return c < 0 || (c >= 0xd800 && c <= 0xdfff);
}
static bool bad_character(int32_t c) {
  return c == 0 || invalid_encoding(c);
}
static bool word_start(int32_t c) {
  return letter(c) || (c > 0x7f && c != 0xfeff && !invalid_encoding(c));
}
static bool value_start(int32_t c, bool number) {
  return number ||
    quote(c) ||
    word_start(c) ||
    c == '{' ||
    c == '[' ||
    c == '+' ||
    c == '-';
}
static bool literal_boundary(int32_t c) {
  return space(c) ||
    quote(c) ||
    c == 0xfeff ||
    c == '{' ||
    c == '}' ||
    c == '[' ||
    c == ']' ||
    c == ':' ||
    c == ',' ||
    c == '#' ||
    c == '+' ||
    c == '-' ||
    c == '\\' ||
    bad_character(c);
}
static bool unexpected_character(int32_t c) {
  return (!literal_boundary(c) || c == 0xfeff) && !digit(c) && !word_start(c);
}
static int hex(int32_t c) {
  if (digit(c)) return (int)(c - '0');
  if (c >= 'a' && c <= 'f') return (int)(c - 'a' + 10);
  if (c >= 'A' && c <= 'F') return (int)(c - 'A' + 10);
  return -1;
}

static void consume_character(TSLexer *lexer) {
  const int32_t first = lexer->lookahead;
  advance(lexer);
  if (first == '\r' && lexer->lookahead == '\n') advance(lexer);
}

static unsigned
consume_quotes(TSLexer *lexer, int32_t delimiter, unsigned limit) {
  unsigned count = 0;
  for (; count < limit && lexer->lookahead == delimiter; count++)
    advance(lexer);
  return count;
}

static bool emit(TSLexer *lexer, const bool *valid, enum Token token) {
  if (!valid[token]) return false;
  lexer->result_symbol = (TSSymbol)token;
  if (lexer->lookahead > 0x7f && !invalid_encoding(lexer->lookahead))
    advance(lexer);
  return true;
}

static bool
emit_character(TSLexer *lexer, const bool *valid, enum Token token) {
  advance(lexer);
  lexer->mark_end(lexer);
  return emit(lexer, valid, token);
}

static Word read_word(TSLexer *lexer) {
  Word word = {0, lexer->lookahead, 0, letter(lexer->lookahead)};
  for (; !literal_boundary(lexer->lookahead); word.count++) {
    if (word.count == 1) word.second = lexer->lookahead;
    word.ascii =
      word.ascii && (letter(lexer->lookahead) || digit(lexer->lookahead));
    advance(lexer);
  }
  return word;
}

static bool raw_letter(int32_t c) {
  return c == 'r' || c == 'R';
}
static bool raw_partner(int32_t c) {
  return c == 'b' || c == 'B' || c == 'f' || c == 'F';
}

static bool string_prefix(const Word *word) {
  return word->count == 1 &&
    (raw_letter(word->first) || word->first == 'u' || word->first == 'U');
}

static enum StringMode prefix_mode(const Word *word) {
  if (string_prefix(word))
    return raw_letter(word->first) ? STRING_RAW : STRING_ESCAPED;
  const bool raw_pair = word->count == 2 &&
    ((raw_letter(word->first) && raw_partner(word->second)) ||
      (raw_letter(word->second) && raw_partner(word->first)));
  return raw_pair ? STRING_RAW : STRING_OPAQUE;
}

static bool starts_literal(const Word *word, TSLexer *lexer) {
  return (word->ascii && quote(lexer->lookahead)) ||
    (string_prefix(word) && lexer->eof(lexer));
}

static void skip_backslash(TSLexer *lexer) {
  do advance(lexer);
  while (!lexer->eof(lexer) && bad_character(lexer->lookahead));
}

static bool skip_layout(TSLexer *lexer, bool implicit_join) {
  for (;;) {
    while (space(lexer->lookahead)) {
      if (!implicit_join && newline(lexer->lookahead)) return false;
      advance(lexer);
    }
    if (lexer->lookahead == '#') {
      if (!implicit_join) return false;
      while (!lexer->eof(lexer) && !newline(lexer->lookahead)) advance(lexer);
    } else if (lexer->lookahead == '\\') {
      skip_backslash(lexer);
      if (newline(lexer->lookahead)) consume_character(lexer);
    } else {
      break;
    }
  }
  return true;
}

static enum Next
examine_next_token(TSLexer *lexer, bool implicit_join, bool string_end) {
  if (!skip_layout(lexer, implicit_join)) return NEXT_OTHER;
  if (lexer->eof(lexer)) return NEXT_OTHER;
  if (bad_character(lexer->lookahead)) return NEXT_INTEGER_PART;
  if (quote(lexer->lookahead)) return NEXT_LITERAL;
  const Word word = read_word(lexer);
  if (starts_literal(&word, lexer)) return NEXT_LITERAL;
  // A quote appended at EOF would join the word to the string.
  if (string_end && word.ascii && lexer->eof(lexer)) return NEXT_EOF_JOIN;
  return number_start(word.first, word.second) ? NEXT_INTEGER_PART : NEXT_OTHER;
}

static bool emit_examining_next(
  Scanner *scanner,
  TSLexer *lexer,
  const bool *valid,
  enum Token token
) {
  scanner->next = examine_next_token(lexer, scanner->implicit_join, false);
  return emit(lexer, valid, token);
}

static enum RunEnd bad_run_end(TSLexer *lexer) {
  for (;;) {
    skip_layout(lexer, true);
    const int32_t c = lexer->lookahead;
    if (lexer->eof(lexer)) return RUN_EOF;
    if (!bad_character(c) && !unexpected_character(c))
      return c == ':' ? RUN_COLON : RUN_OTHER;
    advance(lexer);
    if (number_start(c, lexer->lookahead)) return RUN_OTHER;
  }
}

static bool scan_bad_character(
  Scanner *scanner,
  TSLexer *lexer,
  const bool *valid,
  bool bad_source
) {
  const int32_t first = lexer->lookahead;
  if (lexer->eof(lexer) || !bad_character(first)) return false;
  const enum Token token = first == 0 ? INVALID_CHARACTER : INVALID_ENCODING;
  if (!valid[token]) return false;
  do advance(lexer);
  while (
    !lexer->eof(lexer) &&
    (first == 0 ? lexer->lookahead == 0 : invalid_encoding(lexer->lookahead))
  );
  lexer->mark_end(lexer);
  return bad_source ? emit_examining_next(scanner, lexer, valid, token)
                    : emit(lexer, valid, token);
}

static enum Token escape_failure(TSLexer *lexer) {
  if (lexer->eof(lexer)) return INCOMPLETE_ESCAPE;
  if (bad_character(lexer->lookahead)) return ESCAPE_FRAGMENT;
  return INVALID_ESCAPE;
}

static enum Token scan_hex_escape(TSLexer *lexer, int32_t kind) {
  const unsigned count = kind == 'x' ? 2 : kind == 'u' ? 4 : 8;
  uint32_t value = 0;
  unsigned consumed = 0;
  advance(lexer);
  for (; consumed < count && hex(lexer->lookahead) >= 0; consumed++) {
    value = value * 16 + (uint32_t)hex(lexer->lookahead);
    advance(lexer);
  }
  const bool overflow =
    kind == 'U' && ((uint64_t)value << 4 * (count - consumed)) > 0x10ffff;
  if (consumed < count)
    return overflow ? INVALID_ESCAPE : escape_failure(lexer);
  return overflow ? INVALID_UNICODE_ESCAPE : ESCAPE_SEQUENCE;
}

static enum Token scan_name(const Scanner *scanner, TSLexer *lexer) {
  bool empty = true;
  advance(lexer);
  for (;;) {
    lexer->mark_end(lexer);
    const int32_t c = lexer->lookahead;
    if (c == '}') {
      advance(lexer);
      lexer->mark_end(lexer);
      return empty ? INVALID_ESCAPE : ESCAPE_SEQUENCE;
    }
    if (
      bad_character(c) ||
      (!scanner->triple && (c == scanner->quote || newline(c)))
    )
      return escape_failure(lexer);
    if (c == scanner->quote) {
      if (consume_quotes(lexer, c, 3) == 3) return INVALID_ESCAPE;
    } else {
      advance(lexer);
      if (
        c == '\\' && lexer->lookahead != '}' && !bad_character(lexer->lookahead)
      )
        consume_character(lexer);
    }
    empty = false;
  }
}

static bool
scan_escape(const Scanner *scanner, TSLexer *lexer, const bool *valid) {
  advance(lexer);
  const int32_t kind = lexer->lookahead;
  enum Token token = scanner->mode == STRING_RAW ? RAW_ESCAPE : ESCAPE_SEQUENCE;
  if (bad_character(kind)) {
    token = escape_failure(lexer);
  } else if (scanner->mode == STRING_RAW) {
    consume_character(lexer);
  } else if (kind == 'x' || kind == 'u' || kind == 'U') {
    token = scan_hex_escape(lexer, kind);
  } else if (kind == 'N') {
    advance(lexer);
    if (lexer->lookahead == '{')
      return emit(lexer, valid, scan_name(scanner, lexer));
    token = escape_failure(lexer);
  } else if (kind >= '0' && kind <= '7') {
    for (
      unsigned i = 0;
      i < 3 && lexer->lookahead >= '0' && lexer->lookahead <= '7';
      i++
    )
      advance(lexer);
  } else {
    consume_character(lexer);
  }
  lexer->mark_end(lexer);
  return emit(lexer, valid, token);
}

static bool end_string(
  Scanner *scanner,
  TSLexer *lexer,
  const bool *valid,
  enum Token token
) {
  if (!valid[token]) return false;
  lexer->mark_end(lexer);
  scanner->quote = 0;
  scanner->triple = false;
  scanner->mode = STRING_ESCAPED;
  scanner->next = examine_next_token(lexer, scanner->implicit_join, true);
  return emit(lexer, valid, token);
}

static bool scan_string(Scanner *scanner, TSLexer *lexer, const bool *valid) {
  if (lexer->eof(lexer))
    return end_string(scanner, lexer, valid, EOF_STRING_CLOSE);
  if (!scanner->triple && newline(lexer->lookahead))
    return end_string(scanner, lexer, valid, MISSING_STRING_CLOSE);
  if (scan_bad_character(scanner, lexer, valid, false)) return true;
  if (lexer->lookahead == '\\' && scanner->mode != STRING_OPAQUE)
    return scan_escape(scanner, lexer, valid);
  if (lexer->lookahead == scanner->quote) {
    const unsigned count = scanner->triple ? 3 : 1;
    if (consume_quotes(lexer, scanner->quote, count) == count)
      return end_string(scanner, lexer, valid, STRING_END);
  } else {
    while (
      !bad_character(lexer->lookahead) &&
      lexer->lookahead != scanner->quote &&
      (lexer->lookahead != '\\' || scanner->mode == STRING_OPAQUE) &&
      (scanner->triple || !newline(lexer->lookahead))
    ) {
      const bool protects_next =
        scanner->mode == STRING_OPAQUE && lexer->lookahead == '\\';
      advance(lexer);
      if (protects_next && !bad_character(lexer->lookahead))
        consume_character(lexer);
    }
  }
  lexer->mark_end(lexer);
  return emit(lexer, valid, STRING_CONTENT);
}

static bool scan_comment(Scanner *scanner, TSLexer *lexer, const bool *valid) {
  if (lexer->eof(lexer) || newline(lexer->lookahead)) {
    if (!valid[COMMENT_END]) return false;
    scanner->comment = false;
    lexer->mark_end(lexer);
    return emit(lexer, valid, COMMENT_END);
  }
  if (scan_bad_character(scanner, lexer, valid, false)) return true;
  while (!bad_character(lexer->lookahead) && !newline(lexer->lookahead))
    advance(lexer);
  lexer->mark_end(lexer);
  return emit(lexer, valid, COMMENT_CONTENT);
}

static bool scan_line_continuation_end(
  Scanner *scanner,
  TSLexer *lexer,
  const bool *valid
) {
  if (scan_bad_character(scanner, lexer, valid, false)) return true;
  if (newline(lexer->lookahead)) {
    consume_character(lexer);
    lexer->mark_end(lexer);
    return emit(
      lexer,
      valid,
      lexer->eof(lexer) ? TERMINAL_CONTINUATION_NEWLINE : LINE_CONTINUATION_END
    );
  }
  lexer->mark_end(lexer);
  if (!scanner->implicit_join) scanner->active_line = true;
  if (valid[LINE_CONTINUATION_RECOVERY_END])
    return emit(lexer, valid, LINE_CONTINUATION_RECOVERY_END);
  return emit(
    lexer,
    valid,
    lexer->eof(lexer) ? EOF_LINE_CONTINUATION : INVALID_LINE_CONTINUATION
  );
}

static enum LineTail scan_line_tail(TSLexer *lexer) {
  while (lexer->lookahead == '\\') {
    skip_backslash(lexer);
    if (!newline(lexer->lookahead))
      return lexer->eof(lexer) ? LINE_INCOMPLETE : LINE_CONTENT;
    consume_character(lexer);
    while (horizontal_space(lexer->lookahead)) advance(lexer);
  }
  if (lexer->eof(lexer)) return LINE_INCOMPLETE;
  return newline(lexer->lookahead) || lexer->lookahead == '#' ? LINE_BLANK
                                                              : LINE_CONTENT;
}

static bool scan_layout(Scanner *scanner, TSLexer *lexer, const bool *valid) {
  if (!space(lexer->lookahead) || !valid[LAYOUT]) return false;
  if (newline(lexer->lookahead)) {
    consume_character(lexer);
    lexer->mark_end(lexer);
    scanner->started = true;
    if (!scanner->implicit_join) scanner->active_line = false;
    scanner->line_tail = LINE_UNKNOWN;
    return emit(lexer, valid, LAYOUT);
  }
  bool indented = false;
  bool initial_run = !scanner->started;
  while (horizontal_space(lexer->lookahead)) {
    if (lexer->lookahead == '\f') {
      initial_run = false;
      indented = false;
    } else if (!initial_run) {
      indented = true;
    }
    advance(lexer);
  }
  lexer->mark_end(lexer);
  scanner->started = true;
  if (
    !scanner->implicit_join &&
    !scanner->active_line &&
    indented &&
    (valid[INVALID_INDENTATION] || valid[EOF_INDENTATION])
  ) {
    if (scanner->line_tail == LINE_UNKNOWN)
      scanner->line_tail = scan_line_tail(lexer);
    if (scanner->line_tail == LINE_INCOMPLETE)
      return emit(lexer, valid, EOF_INDENTATION);
    if (scanner->line_tail == LINE_CONTENT)
      return emit(lexer, valid, INVALID_INDENTATION);
  }
  return emit(lexer, valid, LAYOUT);
}

static bool root_value_continues(const Scanner *scanner, const bool *valid) {
  if (valid[STRING_START]) return scanner->next == NEXT_LITERAL;
  return valid[DIGITS] && scanner->next == NEXT_INTEGER_PART;
}

static bool end_root(Scanner *scanner, TSLexer *lexer, const bool *valid) {
  scanner->line_tail = LINE_UNKNOWN;
  scanner->implicit_join = false;
  scanner->active_line = true;
  return emit(lexer, valid, ROOT_END);
}

static bool
scan_unexpected_token(Scanner *scanner, TSLexer *lexer, const bool *valid) {
  for (;;) {
    lexer->mark_end(lexer);
    const int32_t c = lexer->lookahead;
    if (!unexpected_character(c)) break;
    advance(lexer);
    if (number_start(c, lexer->lookahead)) break;
  }
  return emit_examining_next(scanner, lexer, valid, UNEXPECTED_TOKEN);
}

static bool scan_string_start(
  Scanner *scanner,
  TSLexer *lexer,
  const bool *valid,
  int32_t first
) {
  advance(lexer);
  lexer->mark_end(lexer);
  scanner->quote = (uint8_t)first;
  scanner->triple = consume_quotes(lexer, first, 2) == 2;
  scanner->next = NEXT_OTHER;
  if (scanner->triple) lexer->mark_end(lexer);
  return emit(lexer, valid, STRING_START);
}

static bool scan_word(Scanner *scanner, TSLexer *lexer, const bool *valid) {
  const Word word = read_word(lexer);
  const enum Token prefix =
    string_prefix(&word) ? STRING_PREFIX : INVALID_PREFIX;
  const bool literal = starts_literal(&word, lexer) && valid[prefix];
  const enum Token token = literal ? prefix : INVALID_VALUE;
  if (!valid[token]) return false;
  if (literal) {
    scanner->mode = prefix_mode(&word);
    scanner->next = NEXT_OTHER;
  }
  lexer->mark_end(lexer);
  return emit(lexer, valid, token);
}

static bool scan_number(TSLexer *lexer, const bool *valid, bool plain) {
  const bool leading_zero = lexer->lookahead == '0';
  bool nonzero = false;
  int32_t previous = 0;
  while (
    !literal_boundary(lexer->lookahead) ||
    ((previous == 'e' || previous == 'E') &&
      (lexer->lookahead == '+' || lexer->lookahead == '-'))
  ) {
    previous = lexer->lookahead;
    plain = plain && digit(previous);
    nonzero = nonzero || (digit(previous) && previous != '0');
    advance(lexer);
  }
  lexer->mark_end(lexer);
  return emit(
    lexer,
    valid,
    plain && !(leading_zero && nonzero) ? DIGITS : INVALID_INTEGER
  );
}

static bool scan_missing(
  Scanner *scanner,
  TSLexer *lexer,
  const bool *valid,
  int32_t first,
  bool eof,
  bool number
) {
  // The string end records the join because reusing the string changes `valid`.
  const bool join = scanner->next == NEXT_EOF_JOIN;
  const enum Token colon = eof || join ? EOF_COLON : MISSING_COLON;
  if (valid[colon] && first != ':') return emit(lexer, valid, colon);
  const enum Token digits = eof ? EOF_DIGITS : MISSING_DIGITS;
  if (valid[digits] && !number) return emit(lexer, valid, digits);
  if (eof) {
    if (valid[EOF_STRING_OPEN]) {
      scanner->mode = STRING_ESCAPED;
      return emit(lexer, valid, EOF_STRING_OPEN);
    }
    const enum Token candidates[] = {
      EOF_VALUE,
      EOF_DICTIONARY_CLOSE,
      EOF_LIST_CLOSE,
      MISSING_DICTIONARY,
    };
    for (unsigned i = 0; i < sizeof(candidates) / sizeof(candidates[0]); i++)
      if (emit(lexer, valid, candidates[i])) return true;
    return false;
  }
  if ((first == ',' || first == ']' || first == '}') && valid[MISSING_VALUE])
    return emit(lexer, valid, MISSING_VALUE);
  if (first == ':' && valid[MISSING_KEY])
    return emit(lexer, valid, MISSING_KEY);
  if (first == ']' && valid[MISSING_DICTIONARY_CLOSE])
    return emit(lexer, valid, MISSING_DICTIONARY_CLOSE);
  if (first == '}' && valid[MISSING_LIST_CLOSE])
    return emit(lexer, valid, MISSING_LIST_CLOSE);
  // Where a value may still start, its bracket or sign is not a new element.
  if (
    (first == ':' || (value_start(first, number) && !valid[INVALID_VALUE])) &&
    valid[MISSING_COMMA]
  )
    return emit(lexer, valid, join ? EOF_COMMA : MISSING_COMMA);
  return false;
}

void *tree_sitter_gyp_external_scanner_create(void) {
  return calloc(1, sizeof(Scanner));
}
void tree_sitter_gyp_external_scanner_destroy(void *payload) {
  free(payload);
}
unsigned
tree_sitter_gyp_external_scanner_serialize(void *payload, char *buffer) {
  const Scanner *scanner = payload;
  if (!scanner) return 0;
  buffer[0] = (char)scanner->quote;
  buffer[1] = (char)scanner->triple;
  buffer[2] = (char)scanner->mode;
  buffer[3] = (char)scanner->comment;
  buffer[4] = (char)scanner->started;
  buffer[5] = (char)scanner->implicit_join;
  buffer[6] = (char)scanner->active_line;
  buffer[7] = (char)scanner->line_tail;
  buffer[8] = (char)scanner->next;
  return 9;
}
void tree_sitter_gyp_external_scanner_deserialize(
  void *payload,
  const char *buffer,
  unsigned length
) {
  Scanner *scanner = payload;
  if (!scanner) return;
  *scanner = (Scanner){0};
  if (length == 9) {
    scanner->quote = (uint8_t)buffer[0];
    scanner->triple = buffer[1] != 0;
    scanner->mode = (uint8_t)buffer[2] <= STRING_OPAQUE
      ? (enum StringMode)(uint8_t)buffer[2]
      : STRING_ESCAPED;
    scanner->comment = buffer[3] != 0;
    scanner->started = buffer[4] != 0;
    scanner->implicit_join = buffer[5] != 0;
    scanner->active_line = buffer[6] != 0;
    scanner->line_tail = (uint8_t)buffer[7] <= LINE_CONTENT
      ? (enum LineTail)(uint8_t)buffer[7]
      : LINE_UNKNOWN;
    scanner->next = (uint8_t)buffer[8] <= NEXT_EOF_JOIN
      ? (enum Next)(uint8_t)buffer[8]
      : NEXT_OTHER;
  }
}

bool tree_sitter_gyp_external_scanner_scan(
  void *payload,
  TSLexer *lexer,
  const bool *valid
) {
  Scanner *scanner = payload;
  if (!scanner || valid[ERROR_SENTINEL]) return false;
  if (scanner->quote) return scan_string(scanner, lexer, valid);
  if (scanner->comment) return scan_comment(scanner, lexer, valid);
  lexer->mark_end(lexer);
  if (valid[EOF_CONTINUATION_CONTENT])
    return emit(lexer, valid, EOF_CONTINUATION_CONTENT);
  if (valid[LINE_CONTINUATION_END])
    return scan_line_continuation_end(scanner, lexer, valid);
  if (valid[ROOT_END] && !root_value_continues(scanner, valid))
    return end_root(scanner, lexer, valid);
  if (
    !scanner->implicit_join &&
    valid[MISSING_DIGITS] &&
    (newline(lexer->lookahead) || lexer->lookahead == '#')
  )
    return emit(lexer, valid, MISSING_DIGITS);
  if (scan_layout(scanner, lexer, valid)) return true;
  const int32_t first = lexer->lookahead;
  const bool eof = lexer->eof(lexer);
  if (!eof) scanner->started = true;
  if (scan_bad_character(scanner, lexer, valid, true)) return true;
  if (first == '.') advance(lexer);
  const bool number = number_start(first, lexer->lookahead);
  const bool unexpected = !eof && unexpected_character(first) && !number;
  if (unexpected && valid[UNEXPECTED_TOKEN])
    return scan_unexpected_token(scanner, lexer, valid);
  if (
    (valid[DICTIONARY_BAD_RUN] || valid[KEY_BAD_RUN]) &&
    (unexpected || (!eof && bad_character(first)))
  ) {
    const enum RunEnd end = bad_run_end(lexer);
    if (valid[KEY_BAD_RUN])
      return emit(
        lexer,
        valid,
        end == RUN_COLON ? KEY_BAD_RUN
                         : (end == RUN_EOF ? EOF_COLON : MISSING_COLON)
      );
    return emit(
      lexer,
      valid,
      end == RUN_COLON ? MISSING_COMMA : DICTIONARY_BAD_RUN
    );
  }
  if (valid[ROOT_BEGIN] && value_start(first, number)) {
    scanner->implicit_join = first == '{' || first == '[';
    scanner->active_line = true;
    scanner->line_tail = LINE_UNKNOWN;
    return emit(lexer, valid, ROOT_BEGIN);
  }
  if (first == ':' && valid[COLON]) {
    advance(lexer);
    lexer->mark_end(lexer);
    return emit_examining_next(scanner, lexer, valid, COLON);
  }
  if (first == '#' && valid[COMMENT_START]) {
    scanner->line_tail = LINE_UNKNOWN;
    scanner->comment = true;
    return emit_character(lexer, valid, COMMENT_START);
  }
  if (quote(first) && valid[STRING_START])
    return scan_string_start(scanner, lexer, valid, first);
  if (
    word_start(first) &&
    (valid[STRING_PREFIX] || valid[INVALID_PREFIX] || valid[INVALID_VALUE]) &&
    scan_word(scanner, lexer, valid)
  )
    return true;
  if (number && (valid[DIGITS] || valid[INVALID_INTEGER]))
    return scan_number(lexer, valid, first != '.');
  if (first == '\\' && valid[LINE_CONTINUATION_START])
    return emit_character(lexer, valid, LINE_CONTINUATION_START);
  return scan_missing(scanner, lexer, valid, first, eof, number);
}
