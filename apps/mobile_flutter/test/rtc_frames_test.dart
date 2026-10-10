import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:fastvibe_mobile/protocol/rtc_frames.dart';

/// The wire format between the phone and the desktop. The desktop's copy
/// (`test/rtc-frames.test.ts`) pins the very same bytes, so a change that is not mirrored
/// fails in one of the two suites.
void main() {
  IncomingFrame roundTrip(List<int> data, {required bool binary}) {
    final assembler = FrameAssembler(32 * 1024 * 1024);
    Incoming? out;
    for (final message in splitFrame(data, binary: binary)) {
      expect(message.length <= maxMessageBytes, isTrue, reason: 'a fragment must fit the interoperable size');
      out = assembler.push(message);
    }
    return out! as IncomingFrame;
  }

  test('a small frame is one fragment, marked last', () {
    final messages = splitFrame(utf8.encode('hi'), binary: false);
    expect(messages.length, 1);
    expect(messages.first, <int>[fragLast, 0x68, 0x69]);
  });

  test('the binary flag rides on every fragment', () {
    final messages = splitFrame(Uint8List(maxMessageBytes * 2 + 5), binary: true);
    expect(messages.map((m) => m[0]).toList(), <int>[fragBinary, fragBinary, fragBinary | fragLast]);
  });

  test('frames of every size survive the split', () {
    for (final size in <int>[0, 1, maxMessageBytes - 2, maxMessageBytes - 1, maxMessageBytes, 3 * maxMessageBytes, 1000003]) {
      final data = Uint8List.fromList(List<int>.generate(size, (i) => i % 251));
      for (final binary in <bool>[false, true]) {
        final out = roundTrip(data, binary: binary);
        expect(out.binary, binary, reason: 'size $size');
        expect(out.data, data, reason: 'size $size');
      }
    }
  });

  test('a frame is not delivered until its last fragment', () {
    final assembler = FrameAssembler(1 << 20);
    final parts = splitFrame(Uint8List(maxMessageBytes), binary: false);
    expect(assembler.push(parts[0]), isA<IncomingPartial>());
    expect(assembler.push(parts[1]), isA<IncomingFrame>());
  });

  test('controls may fall between the fragments of a frame', () {
    final assembler = FrameAssembler(1 << 20);
    final parts = splitFrame(Uint8List(maxMessageBytes), binary: false);
    assembler.push(parts[0]);
    expect(assembler.push(controlMessage(fragPing)), isA<IncomingPing>());
    expect(assembler.push(controlMessage(fragPong)), isA<IncomingPong>());
    final out = assembler.push(parts[1]);
    expect(out, isA<IncomingFrame>());
    expect((out as IncomingFrame).data.length, maxMessageBytes);
  });

  test('a close message carries its code and reason', () {
    final assembler = FrameAssembler(1 << 20);
    final close = assembler.push(closeMessage(4004, 'backpressure')) as IncomingClose;
    expect(close.code, 4004);
    expect(close.reason, 'backpressure');
    final plain = assembler.push(closeMessage(1000)) as IncomingClose;
    expect(plain.code, 1000);
    expect(plain.reason, '');
  });

  test('what the format does not allow is refused', () {
    FrameAssembler fresh() => FrameAssembler(1 << 20);
    expect(() => fresh().push(Uint8List(0)), throwsA(isA<FrameError>()));
    expect(() => fresh().push(Uint8List.fromList(<int>[0x40, 1])), throwsA(isA<FrameError>()));
    expect(() => fresh().push(Uint8List.fromList(<int>[0x10, 0])), throwsA(isA<FrameError>()));
    final mixed = fresh()..push(Uint8List.fromList(<int>[0x00, 1]));
    expect(() => mixed.push(Uint8List.fromList(<int>[fragBinary | fragLast, 1])), throwsA(isA<FrameError>()));
  });

  test('a frame past the limit is refused while it is still arriving', () {
    final assembler = FrameAssembler(maxMessageBytes);
    final parts = splitFrame(Uint8List(maxMessageBytes + 100), binary: false);
    assembler.push(parts[0]);
    expect(() => assembler.push(parts[1]), throwsA(isA<FrameError>()));
  });

  test('the bytes are the contract', () {
    // The same arrays the desktop's suite asserts.
    expect(splitFrame(utf8.encode('{"a":1}'), binary: false).first, <int>[1, 123, 34, 97, 34, 58, 49, 125]);
    expect(controlMessage(fragPing), <int>[4]);
    expect(controlMessage(fragPong), <int>[8]);
    expect(closeMessage(4001, 'no'), <int>[16, 15, 161, 110, 111]);
  });

  group('deflate', () {
    final json = jsonEncode(<String, Object?>{
      'messages': List<Object?>.generate(400, (i) => <String, Object?>{'id': i, 'text': 'hello world ' * 8}),
    });

    test('a compressed frame survives the split and comes back inflated', () {
      final data = utf8.encode(json);
      final packed = compressFrame(data)!;
      expect(packed.length < data.length ~/ 4, isTrue, reason: 'JSON compresses well');
      final messages = splitFrame(packed, binary: false, deflated: true);
      expect(messages.every((m) => m[0] & fragDeflate != 0), isTrue, reason: 'every fragment says so');
      final assembler = FrameAssembler(32 * 1024 * 1024);
      Incoming? out;
      for (final message in messages) {
        out = assembler.push(message);
      }
      expect((out! as IncomingFrame).data, data);
    });

    test('a frame too short, or that does not shrink, is not compressed', () {
      expect(compressFrame(utf8.encode('short')), isNull);
      final noise = Uint8List.fromList(List<int>.generate(compressMinBytes * 4, (i) => (i * 2654435761 >> 7) & 0xff));
      // Pseudo-random enough that deflate cannot make it smaller than itself plus framing.
      final packed = compressFrame(noise);
      expect(packed == null || packed.length < noise.length, isTrue);
    });

    test('a compressed frame cannot inflate past the frame limit', () {
      final bomb = compressFrame(Uint8List(4 * 1024 * 1024))!;
      expect(bomb.length < 64 * 1024, isTrue, reason: 'a tiny input that inflates to megabytes');
      final assembler = FrameAssembler(1024 * 1024);
      expect(() {
        for (final message in splitFrame(bomb, binary: false, deflated: true)) {
          assembler.push(message);
        }
      }, throwsA(isA<FrameError>()));
    });

    test('garbage marked compressed, and mixed fragments, are refused', () {
      expect(
        () => FrameAssembler(1 << 20).push(Uint8List.fromList(<int>[fragLast | fragDeflate, 0x07, 0xff, 0xff])),
        throwsA(isA<FrameError>()),
      );
      final mixed = FrameAssembler(1 << 20)..push(Uint8List.fromList(<int>[fragDeflate, 0, 0, 0]));
      expect(() => mixed.push(Uint8List.fromList(<int>[fragLast, 0, 0])), throwsA(isA<FrameError>()));
    });

    // Produced by the desktop's `deflateRawSync(..., { level: 3 })`: the two sides must agree
    // on the bytes, not only on each other's round trip.
    test('reads what the desktop wrote', () {
      const wire = <int>[0xab, 0x56, 0xca, 0x48, 0xcd, 0xc9, 0xc9, 0x57, 0xb2, 0x52, 0x4a, 0x4b, 0x2c, 0x2e, 0x29, 0xcb, 0x4c, 0x4a, 0x55, 0x48, 0x2b, 0x4a, 0xcc, 0x4d, 0x2d, 0x56, 0xd2, 0x51, 0xca, 0x53, 0xb2, 0x8a, 0x36, 0xd4, 0x31, 0xd2, 0x31, 0xd6, 0x31, 0xd1, 0x31, 0xd5, 0x31, 0xd3, 0x31, 0xd7, 0xb1, 0xd0, 0xb1, 0xd4, 0x31, 0x34, 0x88, 0xad, 0x05, 0x00];
      final out = FrameAssembler(1 << 20).push(Uint8List.fromList(<int>[fragLast | fragDeflate, ...wire])) as IncomingFrame;
      expect(utf8.decode(out.data), '{"hello":"fastvibe frames","n":[1,2,3,4,5,6,7,8,9,10]}');
    });
  });
}
