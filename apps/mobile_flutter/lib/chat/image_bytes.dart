import 'dart:convert';
import 'dart:typed_data';

/// Decoded bytes of a `data:` image URL, remembered so a widget that rebuilds
/// does not decode the same base64 again.
///
/// Decoding is the expensive part, and it used to happen inside `build`: the
/// composer's thumbnail re-decoded on every keystroke (the draft listener
/// rebuilds the composer), and a message image re-decoded on every streamed
/// token (the transcript rebuilds per frame). Both read as a flicker. The cache
/// is keyed by the URL itself, so an unchanged photo is decoded exactly once.
///
/// Bounded, because one photo is a few megabytes and a long chat must not keep
/// every image it ever showed. Least-recently-used, and only the *bytes* are
/// kept — the image codec's own cache is what stops the decode-to-pixels step
/// from repeating, which is why callers must keep a stable key (the attachment
/// id) on the `Image` widget.
const int _maxEntries = 16;

final Map<String, Uint8List> _bytes = <String, Uint8List>{};

/// The base64 payload of a `data:` URL, decoded once. Returns null for anything
/// that is not one, so the caller can fall back to a network image.
Uint8List? imageBytesOf(String url) {
  final payload = _payload(url);
  if (payload == null) return null;
  return _decoded(url, payload);
}

/// Bytes of a photo the composer is holding, which stores the base64 payload
/// and its `data:` URL separately. Keyed by the URL, so the thumbnail and the
/// message it becomes share one decode.
Uint8List imageBytesOfPayload(String dataUrl, String payload) =>
    _decoded(dataUrl, payload);

Uint8List _decoded(String key, String payload) {
  final cached = _take(key);
  if (cached != null) return cached;
  return _remember(key, base64Decode(payload));
}

String? _payload(String url) {
  final comma = url.indexOf(',');
  if (!url.startsWith('data:') || comma < 0 || comma + 1 >= url.length) {
    return null;
  }
  if (!url.substring(0, comma).contains(';base64')) return null;
  return url.substring(comma + 1);
}

Uint8List? _take(String key) {
  final cached = _bytes.remove(key);
  if (cached == null) return null;
  _bytes[key] = cached;
  return cached;
}

Uint8List _remember(String key, Uint8List bytes) {
  _bytes[key] = bytes;
  while (_bytes.length > _maxEntries) {
    _bytes.remove(_bytes.keys.first);
  }
  return bytes;
}

/// Drop everything remembered. Tests use this; a running app never needs to.
void clearImageBytes() => _bytes.clear();
