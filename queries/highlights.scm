(string_content) @string

(string_prefix) @string

(string_delimiter) @string

(escape_sequence) @string.escape

(raw_escape) @string.escape

(escape_fragment) @string.escape

(integer_digits) @number

(comment_content) @comment

(comment
  "#" @comment)

(dictionary
  [
    "{"
    "}"
  ] @punctuation.bracket)

(list
  [
    "["
    "]"
  ] @punctuation.bracket)

(entry
  ":" @punctuation.delimiter)

(entry
  (syntax_issue
    (invalid_syntax
      (unexpected_token
        ":" @punctuation.delimiter))))

(list
  (syntax_issue
    (invalid_syntax
      (unexpected_token
        ":" @punctuation.delimiter))))

(dictionary
  "," @punctuation.delimiter)

(list
  "," @punctuation.delimiter)

(unexpected_comma
  "," @punctuation.delimiter)

(integer
  sign: _ @operator)

(line_continuation
  "\\" @punctuation.special)
