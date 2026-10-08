import 'dart:convert';
import 'dart:io';

import 'package:flutter/painting.dart';
import 'package:flutter_image_compress/flutter_image_compress.dart';
import 'package:image_picker/image_picker.dart';

import 'queue.dart';

/// A picked photo, already bounded and re-encoded.
///
/// The picker can hand back a 12 MP HEIC straight from the camera, and base64 of that is
/// several megabytes put into one WebSocket frame over a tunnel. So a photo is decoded,
/// scaled to 2048px on the long side and re-encoded as JPEG *before* it is base64'd — the
/// order matters, because quality alone cannot shrink a 4000px image enough.
const int maxComposerImages = 4;
const int maxImageLongSide = 2048;

/// Keep one prompt comfortably below the server's frame and memory limits.
const int maxImageBase64Length = 5500000;

class ComposerImage {
  const ComposerImage({
    required this.id,
    required this.data,
    required this.mimeType,
    required this.uri,
    required this.width,
    required this.height,
  });

  final String id;

  /// Base64, without the data-URL prefix.
  final String data;
  final String mimeType;

  /// A `data:` URL, for the thumbnail.
  final String uri;
  final int width;
  final int height;
}

int _nextImageId = 0;

String _imageId() {
  _nextImageId = (_nextImageId + 1) % 1000000;
  return 'image-${DateTime.now().microsecondsSinceEpoch}-$_nextImageId';
}

/// Rebuild an image from a `data:` URL — an attachment that arrived from the machine.
ComposerImage? fromDataUrl(String dataUrl, int width, int height, [String fallbackMimeType = 'image/jpeg']) {
  final match = RegExp(r'^data:([^;,]+);base64,(.+)$', dotAll: true).firstMatch(dataUrl);
  if (match == null) return null;
  final data = match.group(2)!;
  if (data.length > maxImageBase64Length) return null;
  return ComposerImage(
    id: _imageId(),
    data: data,
    mimeType: match.group(1) ?? fallbackMimeType,
    uri: dataUrl,
    width: width,
    height: height,
  );
}

/// Pick photos and prepare each one. Returns an empty list when the picker was dismissed.
Future<List<ComposerImage>> pickImages({required int limit}) async {
  if (limit <= 0) return <ComposerImage>[];
  final picked = await ImagePicker().pickMultiImage(
    limit: limit,
    imageQuality: 80,
  );
  final images = <ComposerImage>[];
  for (final file in picked) {
    images.add(await preparePickedImage(file));
  }
  return images;
}

/// Decode, scale to [maxImageLongSide], re-encode as JPEG and base64 it.
///
/// Throws `StateError('image-too-large')` when even the bounded JPEG is over the frame
/// budget, and `StateError('image-encoding-failed')` when the platform codec refused.
Future<ComposerImage> preparePickedImage(XFile file) async {
  final bytes = await File(file.path).readAsBytes();
  var width = 0;
  var height = 0;
  try {
    final decoded = await decodeImageFromList(bytes);
    width = decoded.width;
    height = decoded.height;
  } catch (_) {
    // A format the decoder will not open is handed to the compressor anyway; if that
    // fails too the error below is the useful one.
  }

  int? targetWidth;
  int? targetHeight;
  final longSide = width > height ? width : height;
  if (longSide > maxImageLongSide && width > 0 && height > 0) {
    final scale = maxImageLongSide / longSide;
    targetWidth = (width * scale).round().clamp(1, maxImageLongSide);
    targetHeight = (height * scale).round().clamp(1, maxImageLongSide);
  }

  final result = await FlutterImageCompress.compressWithList(
    bytes,
    quality: 78,
    minWidth: targetWidth ?? width,
    minHeight: targetHeight ?? height,
    format: CompressFormat.jpeg,
  );
  if (result.isEmpty) throw StateError('image-encoding-failed');
  final base64Data = base64Encode(result);
  if (base64Data.length > maxImageBase64Length) throw StateError('image-too-large');
  return ComposerImage(
    id: _imageId(),
    data: base64Data,
    mimeType: 'image/jpeg',
    uri: 'data:image/jpeg;base64,$base64Data',
    width: targetWidth ?? width,
    height: targetHeight ?? height,
  );
}

PromptImage promptImage(ComposerImage image) => PromptImage(data: image.data, mimeType: image.mimeType);
