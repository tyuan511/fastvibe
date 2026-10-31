import 'dart:async';
import 'dart:convert';

import 'package:fastvibe_mobile/chat/file_sheet.dart';
import 'package:fastvibe_mobile/chat/file_transfer.dart';
import 'package:fastvibe_mobile/chat/native_output_files.dart';
import 'package:fastvibe_mobile/chat/output_files.dart';
import 'package:fastvibe_mobile/i18n/core.dart';
import 'package:fastvibe_mobile/main.dart' show buildTheme;
import 'package:fastvibe_mobile/theme/theme.dart';
import 'package:fastvibe_mobile/ui/feedback.dart';
import 'package:fastvibe_mobile/ui/kit.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gpt_markdown/gpt_markdown.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  setUpAll(() async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    await i18n.setPreference(LanguagePreference.en);
  });
  test(
    'successful native tool and file changes retain actual destinations only',
    () {
      final patch = <String, Object?>{
        'type': 'toolCall',
        'name': 'apply_patch',
        'output': 'success',
        'arguments': <String, Object?>{
          'input': '*** Begin Patch\n*** Add File: out/a.md\n+x\n*** Update File: old.txt\n*** Move to: out/new name.txt\n@@\n-x\n+y\n*** Delete File: gone.txt\n*** End Patch',
        },
      };
      expect(nativeOutputPaths(patch), <String>[
        'out/a.md',
        'out/new name.txt',
      ]);
      expect(
        nativeOutputPaths(<String, Object?>{...patch, 'output': null}),
        isEmpty,
      );
      expect(
        nativeOutputPaths(<String, Object?>{...patch, 'isError': true}),
        isEmpty,
      );
      expect(
        nativeOutputPaths(<String, Object?>{
          'type': 'fileChange',
          'changes': <Object?>[
            <String, Object?>{'path': 'out/data.csv', 'kind': 'add'},
            <String, Object?>{'path': 'gone', 'kind': 'delete'},
          ],
        }),
        <String>['out/data.csv'],
      );
      expect(
        nativeMarkdownPath('fvpath:%2Ftmp%2Freport%20one.md#L2'),
        '/tmp/report one.md',
      );
      expect(nativeMarkdownPath('out/report%20one.md#L2'), 'out/report one.md');
      expect(nativeMarkdownPath('https://example.com/a.md'), isNull);
      expect(nativeMarkdownPath('file://another-host/a.md'), isNull);
      expect(nativeMarkdownPath('#heading'), isNull);
    },
  );

  for (final palette in <Palette>[light, dark]) {
    testWidgets(
      'native output rows and markdown links carry the exact owning path ${palette.dark}',
      (tester) async {
        final actions = <(String, bool)>[];
        await tester.pumpWidget(
          MaterialApp(
            theme: buildTheme(palette),
            home: PaletteScope(
              palette: palette,
              child: Material(
                child: Column(
                  children: <Widget>[
                    NativeTranscriptItem(
                      item: <String, Object?>{
                        'type': 'toolCall',
                        'name': 'write_file',
                        'arguments': <String, Object?>{
                          'path': 'out/report one.md',
                        },
                        'output': 'ok',
                      },
                      onFile: (path, {required download}) =>
                          actions.add((path, download)),
                    ),
                    NativeTranscriptItem(
                      item: <String, Object?>{
                        'type': 'fileChange',
                        'path': 'out/chart.png',
                      },
                      onFile: (path, {required download}) =>
                          actions.add((path, download)),
                    ),
                    NativeTranscriptItem(
                      item: <String, Object?>{
                        'type': 'agentMessage',
                        'text': '[Read report](out/report%20one.md#L3)',
                      },
                      onFile: (path, {required download}) =>
                          actions.add((path, download)),
                    ),
                  ],
                ),
              ),
            ),
          ),
        );
        await tester.tap(find.text('out/report one.md'));
        await tester.tap(find.text(t('file.download')).first);
        await tester.tap(find.text('out/chart.png'));
        // Exercise the renderer's link callback, with the exact URL the markdown parser passes.
        tester.widget<GptMarkdown>(find.byType(GptMarkdown)).onLinkTap!(
          'out/report%20one.md#L3',
          'Read report',
        );
        expect(actions, <(String, bool)>[
          ('out/report one.md', false),
          ('out/report one.md', true),
          ('out/chart.png', false),
          ('out/report one.md', false),
        ]);
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets(
    'native path action previews through bounded thread-scoped read RPC',
    (tester) async {
      final requests = <Map<String, Object?>>[];
      final transfer = FileTransfer(
        conversationId: 'child-thread',
        serverId: 'native-device',
        readMethod: 'workspace/readFile',
        threadField: 'threadId',
        call: (method, payload, timeout) async {
          expect(method, 'workspace/readFile');
          requests.add((payload as Map).cast<String, Object?>());
          return <String, Object?>{
            'size': 13,
            'mtimeMs': 1,
            'offset': 0,
            'data': base64Encode(utf8.encode('Native report')),
            'eof': true,
          };
        },
      );
      await tester.pumpWidget(
        MaterialApp(
          theme: buildTheme(light),
          home: PaletteScope(
            palette: light,
            child: ToastHost(
              child: Builder(
                builder: (context) => Material(
                  child: NativeTranscriptItem(
                    item: <String, Object?>{
                      'type': 'fileChange',
                      'path': 'out/report.txt',
                    },
                    onFile: (path, {required download}) {
                      unawaited(
                        showOutputFile(
                          context,
                          file: OutputFile(
                            path: path,
                            name: 'report.txt',
                            kind: OutputFileKind.text,
                            created: true,
                          ),
                          transfer: transfer,
                        ),
                      );
                    },
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('out/report.txt'));
      await tester.pumpAndSettle();
      expect(find.text('Native report'), findsOneWidget);
      expect(find.text(t('file.download')), findsWidgets);
      expect(requests.single['threadId'], 'child-thread');
      expect(requests.single['path'], 'out/report.txt');
      expect(requests.single['length'], lessThanOrEqualTo(512 * 1024));
      expect(requests.single.containsKey('conversationId'), isFalse);
      expect(tester.takeException(), isNull);
    },
  );
}
