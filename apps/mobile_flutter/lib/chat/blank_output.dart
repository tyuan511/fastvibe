/// Output that takes up room and says nothing.
///
/// The Flutter port of the desktop's `src/renderer/src/lib/blank-output.ts`, and the reason
/// it has to exist twice is that the two ends parse Markdown with different engines. Measured
/// on this app's own renderer (`test/blank_output_test.dart`), a reply of 前文 + 40 blank
/// things + 后文 costs:
///
/// ```text
///                       before   after   the shape that causes it
///   plain \n ×40            66      66     —      both engines collapse it
///   <br> ×40              1120     106     the markup is honoured as a hard break
///   &nbsp; ×40            1120      66     each entity becomes a line of its own
///   U+200B ×20             866      66     a zero-width character is content, not a blank line
///   U+3000 ×20              66      66     —      gpt_markdown calls it blank (remark does not)
///   \u00a0 ×40 on one line   66      66     —
/// ```
///
/// (66 is what 「前文 + 后文」 costs with nothing between them; 106 is two `<br>`s sitting
/// between two paragraph breaks, which is the floor every collapsed run now lands on. Two
/// quirks of this engine are worth recording beside those numbers: it breaks a line at a
/// *soft* newline, and it drops an inline `<br>` that has no newline after it — so a blank
/// line is what a `<br>` run needs to hurt, and a lone `<br>` is neither a hazard nor a
/// guarantee here.)
///
/// So the wall a reader sees is never the newlines: it is `<br>`, `&nbsp;` and the zero-width
/// family — content to the parser and invisible to the eye. The rules below are written for
/// the shapes that cost something on *either* engine, which is why they cover cases this
/// renderer does not currently need: keeping the two files in step is worth more than
/// trimming a rule, and a future `gpt_markdown` that stops collapsing U+3000 would otherwise
/// walk straight back into the bug.
///
/// Two rules, both conservative:
///
/// 1. a stretch of prose with nothing to read takes no row ([blankTakesRow]), and
/// 2. a pathological run of breaks or invisible characters is *shortened*, never deleted
///    ([collapseBlankRuns]) — one `<br>` is the spacing the model meant, forty is the
///    degenerate case, and a README that really does use a couple of them keeps them.
library;

/// Code points that hold no ink but are not treated as blank by every Markdown engine: NBSP,
/// the zero-width family, the BOM, and the ideographic space. Written out rather than left to
/// `\s`, whose coverage differs between engines and between Unicode modes.
const String _invisible =
    '\u00a0\u200b\u200c\u200d\u2060\ufeff\u3000';

final RegExp _blankChars = RegExp('[ \\t\\r\\n\\u000B\\u000C$_invisible]+');

/// A line break written as markup — the shape a model reaches for when it wants space.
final RegExp _htmlBreak = RegExp('<(?:br|wbr)\\s*/?>', caseSensitive: false);

/// The same space as an entity, which is what a model copies out of HTML it was shown.
final RegExp _spaceEntity = RegExp('&(?:nbsp|#160|#x0*a0);', caseSensitive: false);

/// Three or more `&nbsp;` in a row. A single one means "do not break the line here", so only
/// the run is a symptom — and it becomes one space, not nothing, so the words stay words.
final RegExp _spaceEntityRun = RegExp(
  '&(?:nbsp|#160|#x0*a0);(?:[ \\t\\r\\n]*&(?:nbsp|#160|#x0*a0);){2,}',
  caseSensitive: false,
);

/// Three or more `<br>`s with only spaces and newlines between them.
final RegExp _breakRun = RegExp(
  '<(?:br|wbr)\\s*/?>(?:[ \\t\\r\\n]*<(?:br|wbr)\\s*/?>){2,}',
  caseSensitive: false,
);

/// A line whose only content is invisible characters.
final RegExp _invisibleOnlyLine = RegExp(
  '^[ \\t]*(?:[$_invisible][ \\t\\r]*)+[ \\t\\r]*\$',
  multiLine: true,
);

/// A long run of invisible characters on one line, which wraps into many blank lines.
final RegExp _invisibleRun = RegExp('[$_invisible]{3,}');

/// Is there anything in this text for a reader to see?
bool isBlankOutput(String text) =>
    text
        .replaceAll(_htmlBreak, '')
        .replaceAll(_spaceEntity, '')
        .replaceAll(_blankChars, '')
        .isEmpty;

/// Blank output still takes a row while it is the reply's live tail.
///
/// A model opening its answer with newlines is the normal case, not a defect, and the empty
/// bubble with the streaming indicator on it is the reader's sign that the run is still
/// writing. Once the part has ended there is nothing left for the row to say.
bool blankTakesRow(String text, bool live) => live || !isBlankOutput(text);

/// Shorten the pathological runs, keeping one gap where there were many.
String collapseBlankRuns(String text) {
  if (text.isEmpty) return text;
  // The entity first: `&nbsp;&nbsp;&nbsp;` is three invisible characters written as text, and
  // after it becomes a space the ordinary rules below see it.
  var out = text.replaceAll(_spaceEntityRun, ' ').replaceAll(_invisibleRun, ' ');
  // A line of invisible characters is a paragraph to a parser that does not call it blank, so
  // twenty of them are twenty blank lines. Making them ASCII-blank instead hands them to the
  // engine's own rule, which is why the paragraph break on either side survives without this
  // having to reason about it. Three is the floor: one or two are spacing someone meant.
  if (_invisibleOnlyLine.allMatches(out).length >= 3) {
    out = out.replaceAll(_invisibleOnlyLine, '');
  }
  return out.replaceAll(_breakRun, '<br><br>');
}
