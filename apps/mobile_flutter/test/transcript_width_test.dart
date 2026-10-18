import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:fastvibe_mobile/chat/message.dart';
import 'package:fastvibe_mobile/i18n/core.dart';
import 'package:fastvibe_mobile/main.dart';
import 'package:fastvibe_mobile/screens/transcript.dart';
import 'package:fastvibe_mobile/theme/theme.dart';
import 'package:fastvibe_mobile/ui/feedback.dart';
import 'package:fastvibe_mobile/ui/kit.dart';

void main() {
  setUpAll(() async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    await I18n.instance.setPreference(LanguagePreference.en);
  });

  testWidgets('the transcript spans the same 10 px margins as the composer card', (tester) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final long = List.filled(40, 'word').join(' ');
    await tester.pumpWidget(
      MaterialApp(
        theme: buildTheme(light),
        home: PaletteScope(
          palette: light,
          child: ToastHost(
            child: Scaffold(
              body: TranscriptView(
                messages: <ChatMessage>[
                  ChatMessage(id: 'a', role: 'assistant', text: 'REPLY $long', lastId: 'a'),
                  ChatMessage(id: 'u', role: 'user', text: 'ASK $long'),
                ],
                footers: const {},
                running: false,
                waiting: false,
                workingSince: null,
                onLongPress: (_) {},
                onOlder: () {},
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 300));
    final reply = tester.getRect(find.textContaining('REPLY', findRichText: true).first);
    final ask = tester.getRect(find.textContaining('ASK', findRichText: true).first);
    // Text sits inside a card/bubble with its own padding; the outer edges are what match.
    expect(reply.left, lessThanOrEqualTo(10 + 1));
    expect(reply.right, greaterThanOrEqualTo(390 - 10 - 1));
    expect(ask.right, lessThanOrEqualTo(390 - 10));
  });
}
