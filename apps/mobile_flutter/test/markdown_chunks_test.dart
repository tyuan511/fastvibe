import 'package:flutter_test/flutter_test.dart';
import 'package:fastvibe_mobile/chat/markdown_chunks.dart';

/// A reply is one list row, so a long one used to be parsed and laid out whole — on every
/// streamed frame, and again every time the list rebuilt the row. `MarkdownChunker` cuts it
/// at Markdown block boundaries so the list lays out only what is on screen. What has to
/// hold: nothing is lost or reordered, a settled chunk never changes once emitted, and a
/// structure that may legally contain a blank line is never cut in half.
void main() {
  String repeat(String unit, int times) => List<String>.filled(times, unit).join();

  test('a text under the chunk size is left whole', () {
    final chunker = MarkdownChunker(chunkChars: 100)
      ..update('Short answer.\n\nSecond paragraph.\n\nThird.');
    expect(chunker.isSplit, isFalse);
    expect(chunker.chunks, isEmpty);
    expect(chunker.tail, 'Short answer.\n\nSecond paragraph.\n\nThird.');
  });

  test('a long text is cut at block boundaries and the pieces rebuild it exactly', () {
    final text = <String>[
      for (var index = 0; index < 40; index++) 'Paragraph $index. ${repeat('x', 40)}',
    ].join('\n\n');
    final chunker = MarkdownChunker(chunkChars: 200)..update(text);
    expect(chunker.isSplit, isTrue);
    expect(chunker.chunks.length, greaterThan(1));
    expect(chunker.chunks.join() + chunker.tail, text);
    // Every chunk but the tail is at least a chunk's worth of text.
    for (final chunk in chunker.chunks) {
      expect(chunk.length, greaterThanOrEqualTo(200));
    }
  });

  test('a settled chunk never changes while the reply streams', () {
    final chunker = MarkdownChunker(chunkChars: 100);
    var text = <String>[
      for (var index = 0; index < 8; index++) 'Paragraph $index. ${repeat('x', 40)}',
    ].join('\n\n');
    chunker.update(text);
    final settled = List<String>.from(chunker.chunks);
    expect(settled, isNotEmpty);
    for (var index = 0; index < 5; index++) {
      text = '$text and more of the last paragraph.';
      chunker.update(text);
      expect(chunker.chunks.take(settled.length), settled);
      expect(chunker.chunks.join() + chunker.tail, text);
    }
  });

  test('a fenced code block containing blank lines is never cut in half', () {
    final fence = '```dart\n${repeat('final a = 1;\n', 30)}\n\n${repeat('final b = 2;\n', 30)}```\n\n';
    final text = '$fence${repeat('After the fence. ', 40)}';
    final chunker = MarkdownChunker(chunkChars: 100, maxChars: 2000)..update(text);
    expect(chunker.isSplit, isTrue);
    // No boundary exists inside the fence, so the first chunk is the code block whole.
    expect(chunker.chunks.first, fence);
  });

  test('a loose list is one chunk, so its numbering cannot restart', () {
    final list = repeat('1. first\n\n2. second\n\n', 20);
    final text = '$list${repeat('Done. ', 200)}';
    final chunker = MarkdownChunker(chunkChars: 100, maxChars: 2000)..update(text);
    expect(chunker.chunks.first, list);
  });

  test('a text that is replaced rather than extended starts over', () {
    final chunker = MarkdownChunker(chunkChars: 100)
      ..update(<String>[
        for (var index = 0; index < 8; index++) 'Paragraph $index. ${repeat('x', 40)}',
      ].join('\n\n'));
    expect(chunker.isSplit, isTrue);
    chunker.update('A different, shorter reply.');
    expect(chunker.isSplit, isFalse);
    expect(chunker.tail, 'A different, shorter reply.');
  });

  test('a reply written as one endless line is still cut, and the pieces rebuild it', () {
    final text = repeat('x', 500);
    final chunker = MarkdownChunker(chunkChars: 50, maxChars: 100)..update(text);
    expect(chunker.isSplit, isTrue);
    expect(chunker.chunks.join() + chunker.tail, text);
    for (final chunk in chunker.chunks) {
      expect(chunk.length, lessThanOrEqualTo(100));
    }
  });

  test('a forced cut closes an open fence, and the next chunk re-opens it', () {
    final text = '```dart\n${repeat('x', 500)}';
    final chunker = MarkdownChunker(chunkChars: 50, maxChars: 100)..update(text);
    expect(chunker.isSplit, isTrue);
    expect(chunker.chunks.first.endsWith('\n```'), isTrue);
    expect(chunker.chunks[1].startsWith('```dart\n'), isTrue);
    // Every chunk renders as a code block of its own.
    for (final chunk in chunker.chunks.skip(1)) {
      expect(chunk.startsWith('```dart\n'), isTrue);
    }
  });

  test('plain text is cut at lines, and the pieces rebuild it exactly', () {
    final text = repeat('a line of thinking\n', 200);
    final chunks = chunkPlainText(text, chunkChars: 100);
    expect(chunks.length, greaterThan(1));
    expect(chunks.join(), text);
    for (final chunk in chunks) {
      expect(chunk.length, lessThanOrEqualTo(100));
    }
    // Every chunk but the last ends where a line did.
    for (final chunk in chunks.take(chunks.length - 1)) {
      expect(chunk.endsWith('\n'), isTrue);
    }
  });
}
