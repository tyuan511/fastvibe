import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:fastvibe_mobile/protocol/native_rtc.dart';

void main() {
  test(
    'native RTC binary stream matches Rust tag0 LF wire across fragments',
    () {
      final text = '{"text":"${'界' * 20000}"}';
      final frames = nativeRtcEncode(text);
      expect(frames.length, greaterThan(1));
      expect(
        frames.every((frame) => frame[0] == 0 && frame.length <= 16384),
        isTrue,
      );
      final decoder = NativeRtcDecoder();
      final output = <String>[];
      for (final frame in frames) {
        output.addAll(decoder.push(frame));
      }
      expect(output, <String>[text]);
      expect(decoder.push(Uint8List.fromList(<int>[1])), isEmpty);
      expect(decoder.push(Uint8List.fromList(<int>[2])), isEmpty);
      expect(
        () => decoder.push(Uint8List.fromList(<int>[1, 0])),
        throwsFormatException,
      );
      expect(
        () => decoder.push(Uint8List.fromList(<int>[0x20, 1])),
        throwsFormatException,
      );
    },
  );
}
