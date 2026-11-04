/// Cutting a reply into pieces a list can lay out one at a time.
library;

/// How much of a reply one list row carries.
///
/// A reply is one list row, which is what keeps a streamed run from remounting a card the
/// reader opened — but it also means the whole reply is parsed and laid out at once.
/// `gpt_markdown` re-parses its source whenever the text changes and lays out every
/// paragraph it produces, so a model looping on its own output (376 KB in one assistant
/// message) cost a full re-parse per streamed frame and seconds of layout in a single row.
///
/// Splitting at Markdown block boundaries fixes the shape of that cost: `ListView.builder`
/// only builds and lays out the rows on screen, a settled chunk never changes so it is
/// never parsed again, and only the tail being written into is live. 6,000 characters is
/// several screens of text, and a reply is only ever split once it passes that.
const int kMarkdownChunkChars = 6000;

/// A fence a chunk boundary must not land inside.
class _Fence {
  const _Fence(this.marker, this.length, this.math);

  final String marker;
  final int length;
  final bool math;

  String get close => marker * length;
}

final RegExp _codeFence = RegExp(r'^ {0,3}(`{3,}|~{3,})');
final RegExp _codeFenceClose = RegExp(r'^ {0,3}(`{3,}|~{3,})\s*$');
final RegExp _indented = RegExp(r'^(?: {4,}|\t)');
final RegExp _bullet = RegExp(r'^[-*+][ \t]');
final RegExp _ordered = RegExp(r'^\d+[.)][ \t]');
final RegExp _definition = RegExp(r'^\[[^\]]+\]:');

/// The fence this line opens, if a boundary must not land inside what follows.
_Fence? _openFence(String line) {
  final code = _codeFence.firstMatch(line);
  if (code != null) {
    final marker = code.group(1)!;
    return _Fence(marker[0], marker.length, false);
  }
  final trimmed = line.trim();
  if (!trimmed.startsWith(r'$$')) return null;
  // `$$…$$` on one line is already closed.
  if (trimmed.length > 2 && trimmed.endsWith(r'$$')) return null;
  return const _Fence(r'$', 2, true);
}

bool _closesFence(String line, _Fence fence) {
  if (fence.math) return line.contains(r'$$');
  final close = _codeFenceClose.firstMatch(line);
  return close != null &&
      close.group(1)![0] == fence.marker &&
      close.group(1)!.length >= fence.length;
}

/// Can a new block start at this line, or does it continue the structure above it?
///
/// Only prose, headings, fences and thematic breaks begin one. Everything a blank line
/// can appear *inside* — list items, quotes, tables, indented code, definitions —
/// answers no, so a loose list keeps its numbering when two chunks are cut apart.
bool _startsBlock(String line) {
  if (_indented.hasMatch(line)) return false;
  final text = line.trimLeft();
  if (text.startsWith('>')) return false;
  if (text.startsWith('|')) return false;
  if (_bullet.hasMatch(text)) return false;
  if (_ordered.hasMatch(text)) return false;
  if (_definition.hasMatch(text)) return false;
  return true;
}

/// Splits one growing Markdown text into chunks, keeping the part still being written in
/// [tail].
///
/// It is fed the whole text on every frame and only reads the lines that arrived since the
/// last one, so a streamed reply costs the tail alone rather than the whole reply — and a
/// chunk already emitted never changes, so its row is not rebuilt and not re-parsed.
class MarkdownChunker {
  MarkdownChunker({this.chunkChars = kMarkdownChunkChars, int? maxChars})
    : maxChars = maxChars ?? chunkChars * 2;

  /// The size a chunk is allowed to grow to before the next block boundary closes it.
  final int chunkChars;

  /// The size a chunk is closed at even with no boundary in sight — a reply written as one
  /// endless line, where a paragraph cut is the lesser evil against an unbounded row. A
  /// fence left open is closed here and re-opened in the next chunk, so every chunk is a
  /// document that renders on its own.
  final int maxChars;

  final List<String> _chunks = <String>[];
  String _source = '';
  String _carry = '';
  int _line = 0;
  int _start = 0;
  _Fence? _fence;
  String _fenceLine = '';
  var _content = false;
  var _blank = false;

  /// The chunks before [tail], each ending where a new Markdown block could begin.
  List<String> get chunks => _chunks;

  /// The text [chunks] and [tail] were last taken from, by identity — a caller can skip
  /// feeding the same string again.
  String get source => _source;

  /// Whether the text was long enough to be split at all.
  bool get isSplit => _chunks.isNotEmpty;

  /// The part after the last chunk — still being written, so still re-parsed per frame.
  String get tail =>
      _start >= _source.length ? _carry : '$_carry${_source.substring(_start)}';

  /// Feeds the text as it stands now. A text that is not an extension of the last one
  /// (a retry, a branch switch) starts over.
  void update(String text) {
    if (!text.startsWith(_source)) _reset();
    _source = text;
    while (_line < text.length) {
      final end = text.indexOf('\n', _line);
      final lineEnd = end < 0 ? text.length : end;
      // The fence this line starts inside, which a cut here has to account for.
      final open = _fence;
      final openLine = _fenceLine;
      if (lineEnd - _line >= maxChars) {
        // One line longer than a whole chunk: it has to be cut inside.
        _emit(text, _start + maxChars, open, openLine);
        _line = _start;
        continue;
      }
      final boundary = _scan(text.substring(_line, lineEnd));
      final pending = _line - _start;
      // A boundary is only worth cutting at once the chunk is big enough to be a row of
      // its own; a paragraph each would make the list thousands of rows long. Past
      // [maxChars] the cut is forced even with no boundary in sight. A boundary is never
      // inside a fence, so an open one here only ever belongs to the forced cut.
      if (pending >= maxChars || (pending >= chunkChars && boundary)) {
        _emit(text, _line, open, openLine);
      }
      _line = lineEnd + 1;
    }
  }

  void _emit(String text, int cut, _Fence? open, String openLine) {
    _chunks.add('$_carry${text.substring(_start, cut)}${open == null ? '' : '\n${open.close}'}');
    _start = cut;
    _carry = open == null ? '' : '$openLine\n';
  }

  void _reset() {
    _chunks.clear();
    _carry = '';
    _line = 0;
    _start = 0;
    _fence = null;
    _fenceLine = '';
    _content = false;
    _blank = false;
  }

  /// Reads one line into the fence/blank state; true when a new block begins here.
  bool _scan(String line) {
    if (_fence != null) {
      if (_closesFence(line, _fence!)) {
        _fence = null;
        _fenceLine = '';
      }
      return false;
    }
    if (line.trim().isEmpty) {
      // Only a blank line that follows real content can end a block; leading blanks
      // belong to the block they introduce.
      _blank = _content;
      return false;
    }
    final boundary = _blank && _startsBlock(line);
    _blank = false;
    final opened = _openFence(line);
    if (opened != null) {
      _fence = opened;
      _fenceLine = line;
    }
    _content = true;
    return boundary;
  }
}

/// Cuts plain text (an expanded thinking block) into list rows at line boundaries.
List<String> chunkPlainText(String text, {int chunkChars = 1200}) {
  if (text.length <= chunkChars) return <String>[text];
  final chunks = <String>[];
  var start = 0;
  while (start < text.length) {
    var end = start + chunkChars;
    if (end >= text.length) {
      end = text.length;
    } else {
      final line = text.lastIndexOf('\n', end);
      if (line > start) end = line + 1;
    }
    chunks.add(text.substring(start, end));
    start = end;
  }
  return chunks;
}
