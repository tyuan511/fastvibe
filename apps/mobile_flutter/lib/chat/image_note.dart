/// The note the engine appends to a prompt after it resizes an attached image
/// (`formatDimensionNote` in pi-coding-agent). It tells the *model* how to map
/// coordinates back to the original photo; it is not something the reader typed,
/// so every place that shows a user message has to drop it.
///
/// Anchored to the end, one line per image, so a prompt that merely quotes the
/// sentence mid-text is left alone.
final RegExp imageDimensionNote = RegExp(
  r'(?:\n{2}\[Image: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by [\d.]+ to map to original image\.\])+\s*$',
);

/// The prompt text as the reader should see it: the engine's image note removed,
/// the rest untouched (including whitespace the user typed).
String stripImageDimensionNote(String text) {
  if (!text.contains('[Image: original ')) return text;
  final stripped = text.replaceFirst(imageDimensionNote, '');
  return stripped == text ? text : stripped.trimRight();
}
