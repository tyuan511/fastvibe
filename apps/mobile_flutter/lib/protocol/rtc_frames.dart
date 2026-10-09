/// How one App Protocol frame travels over a WebRTC data channel.
///
/// A byte-for-byte twin of the desktop's `src/main/rtc/frames.ts`; change one and the other
/// stops understanding it. The protocol is whole JSON text frames up to 24 MiB, a data channel
/// is a message pipe with a small ceiling, so a frame is cut into fragments of at most 16 KiB
/// and put back together on the far side.
///
/// Every data channel message is one fragment: a one-byte header, then payload.
///
///   header bit 0x01  LAST    final fragment of a frame (a frame of any length ends with one)
///   header bit 0x02  BINARY  the frame is binary rather than UTF-8 text; set on every fragment
///   header bit 0x04  PING    control, no payload; the peer answers PONG
///   header bit 0x08  PONG    control, no payload
///   header bit 0x10  CLOSE   control; payload is a big-endian u16 close code, then a UTF-8 reason
///
/// The channel is reliable and ordered, which is what lets fragments carry no sequence number:
/// a sender never interleaves two frames, so every fragment up to the next LAST belongs to one
/// frame. Control messages may fall between the fragments of a frame.
library;

import 'dart:convert';
import 'dart:typed_data';

const int fragLast = 0x01;
const int fragBinary = 0x02;
const int fragPing = 0x04;
const int fragPong = 0x08;
const int fragClose = 0x10;

/// Largest data channel message sent, header included.
const int maxMessageBytes = 16 * 1024;
const int _maxPayloadBytes = maxMessageBytes - 1;
const int _maxReasonBytes = 123;

class FrameError implements Exception {
  FrameError(this.message);

  final String message;

  @override
  String toString() => 'FrameError: $message';
}

/// Cut one frame into data channel messages. An empty frame is a single empty LAST fragment.
List<Uint8List> splitFrame(List<int> data, {required bool binary}) {
  final flag = binary ? fragBinary : 0;
  if (data.isEmpty) return <Uint8List>[Uint8List.fromList(<int>[fragLast | flag])];
  final out = <Uint8List>[];
  for (var offset = 0; offset < data.length; offset += _maxPayloadBytes) {
    final end = offset + _maxPayloadBytes < data.length ? offset + _maxPayloadBytes : data.length;
    final message = Uint8List(1 + end - offset);
    message[0] = flag | (end == data.length ? fragLast : 0);
    message.setRange(1, message.length, data, offset);
    out.add(message);
  }
  return out;
}

Uint8List controlMessage(int kind) => Uint8List.fromList(<int>[kind]);

Uint8List closeMessage(int code, [String reason = '']) {
  var text = utf8.encode(reason);
  if (text.length > _maxReasonBytes) text = text.sublist(0, _maxReasonBytes);
  final message = Uint8List(3 + text.length);
  message[0] = fragClose;
  message[1] = (code >> 8) & 0xff;
  message[2] = code & 0xff;
  message.setRange(3, message.length, text);
  return message;
}

sealed class Incoming {
  const Incoming();
}

class IncomingFrame extends Incoming {
  const IncomingFrame(this.data, {required this.binary});

  final Uint8List data;
  final bool binary;
}

class IncomingPing extends Incoming {
  const IncomingPing();
}

class IncomingPong extends Incoming {
  const IncomingPong();
}

class IncomingClose extends Incoming {
  const IncomingClose(this.code, this.reason);

  final int code;
  final String reason;
}

class IncomingPartial extends Incoming {
  const IncomingPartial();
}

/// Puts fragments back together. One per channel.
class FrameAssembler {
  FrameAssembler(this.maxFrameBytes);

  final int maxFrameBytes;
  final List<Uint8List> _parts = <Uint8List>[];
  int _bytes = 0;
  bool _binary = false;

  /// Throws [FrameError] for anything the format does not allow; the channel is then not trusted.
  Incoming push(Uint8List message) {
    if (message.isEmpty) throw FrameError('empty message');
    final header = message[0];
    if (header & fragPing != 0) return const IncomingPing();
    if (header & fragPong != 0) return const IncomingPong();
    if (header & fragClose != 0) {
      if (message.length < 3) throw FrameError('close message too short');
      final code = (message[1] << 8) | message[2];
      return IncomingClose(code, utf8.decode(message.sublist(3), allowMalformed: true));
    }
    if (header & ~(fragLast | fragBinary) != 0) throw FrameError('unknown header bits');

    final binary = header & fragBinary != 0;
    if (_parts.isNotEmpty && binary != _binary) throw FrameError('fragment kind changed mid-frame');
    _binary = binary;
    final payload = Uint8List.sublistView(message, 1);
    _bytes += payload.length;
    if (_bytes > maxFrameBytes) throw FrameError('frame too large');
    _parts.add(payload);
    if (header & fragLast == 0) return const IncomingPartial();

    final Uint8List data;
    if (_parts.length == 1) {
      data = _parts.first;
    } else {
      data = Uint8List(_bytes);
      var at = 0;
      for (final part in _parts) {
        data.setRange(at, at + part.length, part);
        at += part.length;
      }
    }
    _parts.clear();
    _bytes = 0;
    return IncomingFrame(data, binary: binary);
  }
}
