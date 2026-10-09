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
    expect(() => fresh().push(Uint8List.fromList(<int>[0x20, 1])), throwsA(isA<FrameError>()));
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
}
