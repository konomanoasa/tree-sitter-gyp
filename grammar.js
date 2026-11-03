const lexicalIssues = [
  ["eof_indentation", "incomplete_syntax", "invalid_indentation"],
  ["invalid_indentation", "invalid_syntax", "invalid_indentation"],
  [
    "eof_continuation_content",
    "incomplete_syntax",
    "missing_line_continuation_content",
  ],
  ["invalid_value", "invalid_syntax", "invalid_value"],
  ["unexpected_token", "invalid_syntax", "unexpected_token"],
  ["invalid_character", "invalid_syntax", "invalid_character"],
  ["invalid_encoding", "invalid_syntax", "invalid_encoding"],
  ["invalid_integer", "invalid_syntax", "invalid_integer"],
  ["invalid_prefix", "invalid_syntax", "invalid_string_prefix"],
  ["invalid_escape", "invalid_syntax", "invalid_escape"],
  ["incomplete_escape", "incomplete_syntax", "invalid_escape"],
  ["eof_string_open", "incomplete_syntax", "missing_string_open"],
  [
    "invalid_line_continuation",
    "invalid_syntax",
    "missing_line_continuation_newline",
  ],
  [
    "eof_line_continuation",
    "incomplete_syntax",
    "missing_line_continuation_newline",
  ],
  ["missing_dictionary", "incomplete_syntax", "missing_dictionary"],
  ["missing_key", "invalid_syntax", "missing_key"],
  ...[
    "colon",
    "value",
    "digits",
    "dictionary_close",
    "list_close",
    "string_close",
    "comma",
  ].flatMap((part) => [
    [`missing_${part}`, "invalid_syntax", `missing_${part}`],
    [`eof_${part}`, "incomplete_syntax", `missing_${part}`],
  ]),
];

const structuralIssues = {
  invalid_unicode_escape: {
    reason: "invalid_unicode_escape",
    body: ($) => alias($._invalid_unicode_escape, $.escape_sequence),
  },
  non_dictionary_root: {
    reason: "non_dictionary_root",
    body: ($) => choice(container($, "list", "root"), $.string, $.integer),
  },
  extra_root_value: { reason: "extra_root_value", body: ($) => $._value_root },
  stray_list_close: { reason: "unexpected_token", body: () => "]" },
  stray_dictionary_close: { reason: "unexpected_token", body: () => "}" },
  unexpected_comma: { reason: "unexpected_comma", body: () => "," },
  root_delimiter: {
    reason: "unexpected_token",
    body: () => choice("}", "]", ":", ","),
  },
  unexpected_colon: {
    reason: "unexpected_token",
    body: ($) => alias($._colon, ":"),
  },
  ...Object.fromEntries(
    ["dictionary", "both"].map((context) => [
      `non_string_key_${context}`,
      {
        reason: "non_string_key",
        body: ($) =>
          choice(
            container($, "dictionary", context),
            container($, "list", context),
            $.integer,
          ),
      },
    ]),
  ),
};

function issueRulesFor(id, outcome, reason, source) {
  return [
    [`_issue_${id}`, ($) => alias($[`_outcome_${id}`], $.syntax_issue)],
    [`_outcome_${id}`, ($) => alias($[`_reason_${id}`], $[outcome])],
    [`_reason_${id}`, ($) => alias(source($), $[reason])],
  ];
}

const issueRules = Object.fromEntries([
  ...lexicalIssues.flatMap(([id, outcome, reason]) =>
    issueRulesFor(id, outcome, reason, ($) => $[`_${id}`]),
  ),
  ...Object.entries(structuralIssues).flatMap(([id, { reason, body }]) => [
    ...issueRulesFor(id, "invalid_syntax", reason, ($) => $[`_body_${id}`]),
    [`_body_${id}`, body],
  ]),
]);

const issue = ($, ...names) =>
  field("issue", choice(...names.map((name) => $[`_issue_${name}`])));
const absent = ($, name) => issue($, `missing_${name}`, `eof_${name}`);
const value = ($, name, context) =>
  choice(field(name, $[`_value_${context}`]), issue($, "invalid_value"));
const containerContext = (kind, context) =>
  context === "root" || context === kind ? kind : "both";
const container = ($, kind, context) =>
  alias($[`_${kind}_${containerContext(kind, context)}`], $[kind]);
const entry = ($, rule, context) =>
  field("entry", alias($[`_${rule}_${context}`], $.entry));
const closing = ($, kind, context) =>
  choice(
    field("closing", kind === "dictionary" ? "}" : "]"),
    issue($, `eof_${kind}_close`),
    ...(context === "both" ? [issue($, `missing_${kind}_close`)] : []),
  );
const stray = ($, kind, context) =>
  context === "both"
    ? []
    : [
        issue(
          $,
          kind === "dictionary" ? "stray_list_close" : "stray_dictionary_close",
        ),
      ];
const containerRules = {};
for (const context of ["root", "dictionary", "list", "both"]) {
  containerRules[`_value_${context}`] = ($) =>
    choice(
      container($, "dictionary", context),
      container($, "list", context),
      $.string,
      $.integer,
    );
}
for (const context of ["dictionary", "both"]) {
  containerRules[`_dictionary_${context}`] = ($) =>
    seq(
      field("opening", "{"),
      optional($[`_dictionary_start_${context}`]),
      closing($, "dictionary", context),
    );
  containerRules[`_dictionary_start_${context}`] = ($) =>
    choice(
      $[`_dictionary_resume_${context}`],
      seq(
        entry($, "bad_key_entry", context),
        optional($[`_dictionary_after_${context}`]),
      ),
      seq($._bad_run, optional($[`_dictionary_resume_${context}`])),
    );
  containerRules[`_dictionary_resume_${context}`] = ($) =>
    choice(
      seq(
        entry($, "entry", context),
        optional($[`_dictionary_after_${context}`]),
      ),
      seq(
        choice(
          issue($, "unexpected_comma"),
          ...stray($, "dictionary", context),
        ),
        optional($[`_dictionary_start_${context}`]),
      ),
    );
  containerRules[`_dictionary_after_${context}`] = ($) =>
    choice(
      $[`_dictionary_after_run_${context}`],
      seq(
        issue($, "missing_comma"),
        entry($, "bad_key_entry", context),
        optional($[`_dictionary_after_${context}`]),
      ),
      seq(
        $._dictionary_bad_run,
        $._bad_run,
        optional($[`_dictionary_after_run_${context}`]),
      ),
    );
  containerRules[`_dictionary_after_run_${context}`] = ($) =>
    choice(
      seq(",", optional($[`_dictionary_start_${context}`])),
      seq(
        absent($, "comma"),
        entry($, "entry", context),
        optional($[`_dictionary_after_${context}`]),
      ),
      ...stray($, "dictionary", context).map((token) =>
        seq(token, optional($[`_dictionary_after_${context}`])),
      ),
    );
  containerRules[`_entry_${context}`] = ($) =>
    seq(
      choice(
        field("key", $.string),
        issue($, `non_string_key_${context}`, "invalid_value", "missing_key"),
      ),
      choice(
        seq(
          optional(seq($._key_bad_run, $._bad_run)),
          field("separator", alias($._colon, ":")),
        ),
        absent($, "colon"),
      ),
      $[`_entry_value_${context}`],
    );
  containerRules[`_bad_key_entry_${context}`] = ($) =>
    seq(
      $._bad_run,
      field("separator", alias($._colon, ":")),
      $[`_entry_value_${context}`],
    );
  containerRules[`_entry_value_${context}`] = ($) =>
    seq(
      repeat(issue($, "unexpected_colon")),
      choice(
        value($, "value", context),
        prec.right(
          seq(
            $._bad_source,
            repeat(choice($._bad_source, issue($, "unexpected_colon"))),
            optional(value($, "value", context)),
          ),
        ),
        absent($, "value"),
      ),
    );
}
for (const context of ["list", "both"]) {
  containerRules[`_list_${context}`] = ($) =>
    seq(
      field("opening", "["),
      optional($[`_list_start_${context}`]),
      closing($, "list", context),
    );
  containerRules[`_list_start_${context}`] = ($) =>
    choice(
      seq(value($, "element", context), optional($[`_list_after_${context}`])),
      seq(
        choice(
          issue($, "unexpected_comma", "unexpected_colon"),
          $._bad_source,
          ...stray($, "list", context),
        ),
        optional($[`_list_start_${context}`]),
      ),
    );
  containerRules[`_list_after_${context}`] = ($) =>
    choice(
      seq(
        choice(",", issue($, "unexpected_colon")),
        optional($[`_list_start_${context}`]),
      ),
      seq(
        absent($, "comma"),
        value($, "element", context),
        optional($[`_list_after_${context}`]),
      ),
      seq(
        choice($._bad_source, ...stray($, "list", context)),
        optional($[`_list_after_${context}`]),
      ),
    );
}
const digits = ($) =>
  choice(
    field("digits", alias($._digits, $.integer_digits)),
    issue($, "invalid_integer"),
  );
const continuationNewline = ($) =>
  choice(
    $._line_continuation_end,
    seq($._terminal_continuation_newline, issue($, "eof_continuation_content")),
  );

export default grammar({
  name: "gyp",

  extras: ($) => [$._layout, $.comment, $.line_continuation],

  externals: ($) => [
    $.string_prefix,
    $._string_start,
    $._string_end,
    $.string_content,
    $.escape_sequence,
    $.raw_escape,
    $.escape_fragment,
    $._comment_start,
    $.comment_content,
    $._comment_end,
    $._line_continuation_start,
    $._line_continuation_end,
    $._line_continuation_recovery_end,
    $._digits,
    $._invalid_value,
    $._unexpected_token,
    $._invalid_character,
    $._invalid_encoding,
    $._invalid_integer,
    $._invalid_prefix,
    $._invalid_escape,
    $._incomplete_escape,
    $._invalid_unicode_escape,
    $._missing_dictionary,
    $._missing_key,
    $._missing_colon,
    $._eof_colon,
    $._missing_value,
    $._eof_value,
    $._missing_digits,
    $._eof_digits,
    $._missing_dictionary_close,
    $._eof_dictionary_close,
    $._missing_list_close,
    $._eof_list_close,
    $._missing_string_close,
    $._eof_string_close,
    $._missing_comma,
    $._eof_comma,
    $._eof_string_open,
    $._invalid_line_continuation,
    $._eof_line_continuation,
    $._colon,
    $._layout,
    $._invalid_indentation,
    $._eof_indentation,
    $._root_begin,
    $._root_end,
    $._terminal_continuation_newline,
    $._eof_continuation_content,
    $._dictionary_bad_run,
    $._key_bad_run,
    $._error_sentinel,
  ],

  rules: {
    source_file: ($) =>
      seq(
        repeat($._root_junk),
        choice(
          seq(
            $._root_begin,
            choice(
              field("body", container($, "dictionary", "root")),
              issue($, "non_dictionary_root", "invalid_value"),
            ),
            $._root_end,
          ),
          issue($, "missing_dictionary"),
        ),
        repeat(
          choice(
            seq(
              $._root_begin,
              issue($, "extra_root_value", "invalid_value"),
              $._root_end,
            ),
            $._root_junk,
          ),
        ),
      ),
    _root_junk: ($) =>
      choice(
        issue($, "invalid_indentation", "eof_indentation"),
        seq(choice(issue($, "root_delimiter"), $._bad_source), $._root_end),
      ),
    _bad_source: ($) =>
      issue($, "unexpected_token", "invalid_character", "invalid_encoding"),
    _bad_run: ($) => repeat1($._bad_source),
    string: ($) => prec.right(repeat1(field("literal", $.string_literal))),
    string_literal: ($) =>
      choice(
        $._string_body,
        seq(
          field("prefix", $.string_prefix),
          choice($._string_body, issue($, "eof_string_open")),
        ),
        seq(issue($, "invalid_prefix"), $._string_body),
      ),
    _string_body: ($) =>
      seq(
        field("opening", alias($._string_start, $.string_delimiter)),
        repeat(
          choice(
            field(
              "content",
              choice(
                $.string_content,
                $.escape_sequence,
                $.raw_escape,
                $.escape_fragment,
              ),
            ),
            issue(
              $,
              "invalid_escape",
              "incomplete_escape",
              "invalid_unicode_escape",
              "invalid_character",
              "invalid_encoding",
            ),
          ),
        ),
        choice(
          field("closing", alias($._string_end, $.string_delimiter)),
          absent($, "string_close"),
        ),
      ),
    integer: ($) =>
      choice(
        digits($),
        seq(
          field("sign", choice("+", "-")),
          choice(
            digits($),
            prec.right(
              seq(
                repeat1(issue($, "invalid_character", "invalid_encoding")),
                optional(digits($)),
              ),
            ),
            absent($, "digits"),
          ),
        ),
      ),
    comment: ($) =>
      seq(
        alias($._comment_start, "#"),
        repeat(
          choice(
            $.comment_content,
            issue($, "invalid_character", "invalid_encoding"),
          ),
        ),
        $._comment_end,
      ),
    line_continuation: ($) =>
      seq(
        alias($._line_continuation_start, "\\"),
        choice(
          continuationNewline($),
          seq(
            repeat1(issue($, "invalid_character", "invalid_encoding")),
            choice(continuationNewline($), $._line_continuation_recovery_end),
          ),
          issue($, "invalid_line_continuation", "eof_line_continuation"),
        ),
      ),
    ...containerRules,
    ...issueRules,
  },
});
