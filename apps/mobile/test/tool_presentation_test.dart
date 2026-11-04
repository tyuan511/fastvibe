import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hugeicons/hugeicons.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:fastvibe_mobile/chat/composer.dart';
import 'package:fastvibe_mobile/chat/message.dart';
import 'package:fastvibe_mobile/chat/tool_card.dart';
import 'package:fastvibe_mobile/chat/tool_details.dart';
import 'package:fastvibe_mobile/i18n/core.dart';
import 'package:fastvibe_mobile/screens/transcript.dart';
import 'package:fastvibe_mobile/theme/theme.dart';
import 'package:fastvibe_mobile/ui/app_screen.dart';
import 'package:fastvibe_mobile/ui/icons.dart';
import 'package:fastvibe_mobile/ui/kit.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() async {
    final path = Platform.environment['FASTVIBE_UI_FONT'];
    if (path == null) return;
    final data = ByteData.sublistView(File(path).readAsBytesSync());
    for (final family in [
      'Roboto',
      '.SF UI Text',
      '.SF UI Display',
      'monospace',
    ]) {
      await (FontLoader(family)..addFont(Future.value(data))).load();
    }
  });

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    await i18n.setPreference(LanguagePreference.zh);
  });

  testWidgets('ordinary tool reveals selectable parameters and output on tap', (
    tester,
  ) async {
    final tool = ToolBlock(
      id: 'command',
      name: 'bash',
      status: 'done',
      args: {'command': 'flutter analyze --no-pub'},
      result: 'No issues found! 检查完成。',
    );
    await _pumpCard(tester, tool);
    expect(find.text('参数'), findsNothing);
    expect(find.text('输出'), findsNothing);
    expect(find.text(tool.result!), findsNothing);

    await _tapTool(tester);
    expect(find.text('参数'), findsOneWidget);
    expect(find.text('输出'), findsOneWidget);
    expect(find.text(tool.result!), findsOneWidget);
    expect(
      find.byWidgetPredicate(
        (widget) => widget is SelectableText && widget.data == tool.result,
      ),
      findsOneWidget,
    );

    await _tapTool(tester);
    expect(find.text(tool.result!), findsNothing);
    expect(find.text('参数'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'failed tool previews two error lines and opens full details on tap',
    (tester) async {
      final tool = ToolBlock(
        id: 'failed',
        name: 'bash',
        status: 'error',
        args: {'command': 'flutter test test/missing_test.dart'},
        result: '测试文件不存在，请检查文件路径。\n请确认测试文件已保存。\n完整诊断信息：test/missing_test.dart',
      );
      final preview = find.byWidgetPredicate(
        (widget) =>
            widget is Text &&
            widget.data == tool.result &&
            widget.maxLines == 2,
      );
      final fullError = find.byWidgetPredicate(
        (widget) => widget is SelectableText && widget.data == tool.result,
      );
      await _pumpCard(tester, tool);
      expect(preview, findsOneWidget);
      expect(fullError, findsNothing);
      expect(find.text('参数'), findsNothing);
      expect(find.text('错误'), findsNothing);
      await _tapTool(tester);
      expect(find.text('错误'), findsOneWidget);
      expect(find.text('参数'), findsOneWidget);
      expect(find.text('输出'), findsNothing);
      expect(fullError, findsOneWidget);
      await _tapTool(tester);
      expect(preview, findsOneWidget);
      expect(fullError, findsNothing);
      expect(find.text('参数'), findsNothing);
      expect(find.text('错误'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('running read preserves its family icon', (tester) async {
    await _pumpCard(
      tester,
      ToolBlock(
        id: 'running',
        name: 'read',
        status: 'running',
        args: {'path': 'apps/mobile/lib/chat/tool_card.dart'},
      ),
      live: true,
    );
    expect(
      find.byWidgetPredicate(
        (widget) => widget is HugeIcon && widget.icon == AppIcons.fileText,
      ),
      findsOneWidget,
    );
    expect(
      find.byWidgetPredicate(
        (widget) => widget.runtimeType.toString() == 'DesktopSpinner',
      ),
      findsNothing,
    );
    final activity = find.byType(ToolActivityLabel);
    expect(activity, findsOneWidget);
    expect(MediaQuery.disableAnimationsOf(tester.element(activity)), isTrue);
    final fade = find.descendant(
      of: activity,
      matching: find.byType(FadeTransition),
    );
    expect(fade, findsNothing);
    await tester.pump(const Duration(milliseconds: 1200));
    expect(fade, findsNothing);
    expect(tester.binding.hasScheduledFrame, isFalse);
    expect(tester.takeException(), isNull);
  });

  testWidgets('activity pulses only when motion is enabled', (tester) async {
    Widget label(bool reducedMotion) => _surface(
      light,
      const Scaffold(
        body: ToolActivityLabel(active: true, child: Text('正在读取')),
      ),
      disableAnimations: reducedMotion,
    );
    await tester.pumpWidget(label(false));
    final fade = find.descendant(
      of: find.byType(ToolActivityLabel),
      matching: find.byType(FadeTransition),
    );
    final initial = tester.widget<FadeTransition>(fade).opacity.value;
    await tester.pump(const Duration(milliseconds: 400));
    expect(
      tester.widget<FadeTransition>(fade).opacity.value,
      lessThan(initial),
    );
    await tester.pumpWidget(label(true));
    await tester.pump(const Duration(milliseconds: 1200));
    expect(tester.widget<FadeTransition>(fade).opacity.value, 1);
    expect(tester.binding.hasScheduledFrame, isFalse);
    expect(tester.takeException(), isNull);
  });

  testWidgets('long path is below the subject at 320px with enlarged text', (
    tester,
  ) async {
    _viewport(tester, const Size(320, 844));
    const directory =
        'apps/mobile/lib/chat/a_very_long_directory_name/another_nested_directory';
    await _pumpCard(
      tester,
      ToolBlock(
        id: 'long-path',
        name: 'read',
        status: 'done',
        args: {'path': '$directory/tool_presentation.dart'},
        result: '文件内容',
      ),
      textScale: 1.4,
    );
    final subject = find.text('tool_presentation.dart');
    final context = find.text(directory);
    expect(subject, findsOneWidget);
    expect(context, findsOneWidget);
    expect(
      tester.getTopLeft(context).dy,
      greaterThanOrEqualTo(tester.getBottomLeft(subject).dy),
    );
    expect(tester.takeException(), isNull);
    await _tapTool(tester);
    expect(find.text('文件内容'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('large output scrolls inside a bounded details area', (
    tester,
  ) async {
    _viewport(tester, const Size(320, 844));
    final output = List.generate(500, (index) => '检查第 $index 项：通过').join('\n');
    await _pumpCard(
      tester,
      ToolBlock(
        id: 'large',
        name: 'bash',
        status: 'done',
        args: {'command': 'flutter test'},
        result: output,
      ),
      textScale: 1.4,
    );
    expect(output.length, greaterThan(4000));
    expect(find.text(output), findsNothing);
    await _tapTool(tester);
    final beginning = find.byWidgetPredicate(
      (widget) =>
          widget is SelectableText &&
          (widget.data?.contains('检查第 0 项：通过') ?? false),
    );
    final ending = find.byWidgetPredicate(
      (widget) =>
          widget is SelectableText &&
          (widget.data?.contains('检查第 499 项：通过') ?? false),
    );
    expect(beginning, findsOneWidget);
    expect(ending, findsNothing);
    final detailsList = find.descendant(
      of: find.byType(ToolDetails),
      matching: find.byType(ListView),
    );
    expect(detailsList, findsOneWidget);
    expect(tester.getSize(detailsList).height, lessThanOrEqualTo(260));
    final viewport = tester.getRect(detailsList);
    expect(
      tester.getRect(beginning).top,
      inInclusiveRange(viewport.top, viewport.bottom),
    );
    final scrollable = find
        .descendant(
          of: detailsList,
          matching: find.byWidgetPredicate(
            (widget) =>
                widget is Scrollable &&
                widget.axisDirection == AxisDirection.down,
          ),
        )
        .first;
    await tester.scrollUntilVisible(
      ending,
      220,
      scrollable: scrollable,
      maxScrolls: 150,
    );
    await tester.pump();
    final position = tester.state<ScrollableState>(scrollable).position;
    position.jumpTo(position.maxScrollExtent);
    await tester.pump();
    expect(ending, findsOneWidget);
    expect(tester.getRect(ending).overlaps(viewport), isTrue);
    expect(position.extentAfter, 0);
    expect(tester.takeException(), isNull);
  });

  testWidgets('todo disclosure retains completed and pending checklist items', (
    tester,
  ) async {
    await _pumpCard(
      tester,
      ToolBlock(
        id: 'todo',
        name: 'todo',
        status: 'done',
        details: {
          'todos': [
            {'content': '核对工具行布局', 'status': 'completed'},
            {'content': '验证手机窄屏', 'status': 'in_progress'},
            {'content': '导出浅深色预览', 'status': 'pending'},
          ],
        },
      ),
    );
    expect(find.text('核对工具行布局'), findsNothing);
    await _tapTool(tester);
    expect(find.text('核对工具行布局'), findsOneWidget);
    expect(find.text('导出浅深色预览'), findsOneWidget);
    await _tapTool(tester);
    expect(find.text('核对工具行布局'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  for (final palette in [light, dark]) {
    testWidgets(
      'Chinese tool transcript preview ${palette.dark ? 'dark' : 'light'}',
      (tester) async {
        _viewport(tester, const Size(390, 844));
        final boundary = GlobalKey();
        final draft = TextEditingController();
        addTearDown(draft.dispose);
        final tools = [
          ToolBlock(
            id: 'read',
            name: 'read',
            status: 'done',
            args: {'path': 'lib/chat/tool_card.dart'},
            result: '已读取工具行与折叠详情的实现。',
          ),
          ToolBlock(
            id: 'write',
            name: 'write',
            status: 'done',
            args: {'path': 'test/tool_presentation_test.dart'},
            result: '已写入交互与窄屏回归测试。',
          ),
          ToolBlock(
            id: 'command',
            name: 'bash',
            status: 'done',
            args: {'command': 'flutter analyze --no-pub'},
            result: 'No issues found! 检查完成。',
          ),
          ToolBlock(
            id: 'error',
            name: 'read',
            status: 'error',
            args: {'path': 'test/missing.dart'},
            result: '文件不存在，请核对路径后重试。',
          ),
          ToolBlock(
            id: 'running',
            name: 'read',
            status: 'running',
            args: {'path': 'lib/chat/process_group.dart'},
          ),
        ];
        await tester.pumpWidget(
          _surface(
            palette,
            RepaintBoundary(
              key: boundary,
              child: AppScreen(
                title: '优化手机工具展示',
                showBack: false,
                bottomBar: Composer(
                  conversationId: 'tool-preview',
                  running: false,
                  draft: draft,
                  images: const [],
                  onImagesChange: (_) {},
                  onSend: () async {},
                  onAbort: () {},
                  onContinue: () {},
                  canContinue: false,
                  deferSessionRead: true,
                ),
                body: TranscriptView(
                  messages: [
                    ChatMessage(
                      id: 'assistant',
                      role: 'assistant',
                      tools: tools,
                      text: '点按工具行，查看参数与输出。',
                    ),
                    ChatMessage(
                      id: 'user',
                      role: 'user',
                      text: '请检查工具展示，并补充手机端验证。',
                    ),
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
        );
        await tester.runAsync(
          () => precacheImage(
            const AssetImage('assets/icon.png'),
            tester.element(find.byType(AppScreen)),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('请检查工具展示，并补充手机端验证。'), findsOneWidget);
        await _capture(
          tester,
          boundary,
          'tools-${palette.dark ? 'dark' : 'light'}.png',
        );
        final commandCard = find.byWidgetPredicate(
          (widget) => widget is ToolCard && widget.tool.id == 'command',
        );
        await tester.tap(
          find
              .descendant(of: commandCard, matching: find.byType(InkWell))
              .first,
        );
        await tester.pumpAndSettle();
        expect(find.text(tools[2].result!), findsOneWidget);
        expect(find.text(tools[3].result!), findsOneWidget);
        expect(find.byType(Composer), findsOneWidget);
        expect(tester.takeException(), isNull);
        await _capture(
          tester,
          boundary,
          'tools-command-expanded-${palette.dark ? 'dark' : 'light'}.png',
        );
      },
    );
  }
}

void _viewport(WidgetTester tester, Size size) {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

Future<void> _pumpCard(
  WidgetTester tester,
  ToolBlock tool, {
  bool live = false,
  double textScale = 1,
}) async {
  await tester.pumpWidget(
    _surface(
      light,
      Scaffold(
        body: Align(
          alignment: Alignment.topCenter,
          child: ToolCard(tool: tool, palette: light, live: live),
        ),
      ),
      textScale: textScale,
    ),
  );
  await tester.pump();
}

Future<void> _tapTool(WidgetTester tester) async {
  await tester.tap(
    find
        .descendant(of: find.byType(ToolCard), matching: find.byType(InkWell))
        .first,
  );
  await tester.pumpAndSettle();
}

Widget _surface(
  Palette palette,
  Widget child, {
  double textScale = 1,
  bool disableAnimations = true,
}) => MaterialApp(
  theme: ThemeData(
    brightness: palette.dark ? Brightness.dark : Brightness.light,
    scaffoldBackgroundColor: palette.background,
    colorScheme: ColorScheme.fromSeed(
      seedColor: palette.accent,
      brightness: palette.dark ? Brightness.dark : Brightness.light,
    ),
    fontFamily: 'Roboto',
  ),
  builder: (context, child) => MediaQuery(
    data: MediaQuery.of(context).copyWith(
      textScaler: TextScaler.linear(textScale),
      disableAnimations: disableAnimations,
    ),
    child: child!,
  ),
  home: LanguageScope(
    language: i18n.language,
    child: PaletteScope(
      palette: palette,
      child: DefaultTextStyle(
        style: TextStyle(
          color: palette.text,
          fontFamily: 'Roboto',
          decoration: TextDecoration.none,
        ),
        child: child,
      ),
    ),
  ),
);

Future<void> _capture(WidgetTester tester, GlobalKey key, String name) async {
  final directory = Platform.environment['FASTVIBE_UI_CAPTURE_DIR'];
  if (directory == null) return;
  await tester.runAsync(() async {
    final boundary =
        key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    final image = await boundary.toImage(pixelRatio: 1);
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    Directory(directory).createSync(recursive: true);
    File('$directory/$name').writeAsBytesSync(data!.buffer.asUint8List());
    image.dispose();
  });
}
