import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:fastvibe_mobile/chat/blank_output.dart';
import 'package:fastvibe_mobile/chat/markdown_view.dart';
import 'package:fastvibe_mobile/main.dart';
import 'package:fastvibe_mobile/theme/theme.dart';
import 'package:fastvibe_mobile/ui/kit.dart';

import 'support/plain.dart';

void main() {
  group('what is blank', () {
    test('breaks and invisible space say nothing', () {
      expect(isBlankOutput(''), isTrue);
      expect(isBlankOutput('  \n\t '), isTrue);
      expect(isBlankOutput('\u00a0\u00a0\u00a0'), isTrue);
      expect(isBlankOutput('\u3000'), isTrue);
      expect(isBlankOutput('\u200b'), isTrue);
      expect(isBlankOutput('\ufeff'), isTrue);
      expect(isBlankOutput('<br>\n<br/>'), isTrue);
      expect(isBlankOutput('&nbsp;&nbsp;'), isTrue);
    });

    test('what draws something is not blank', () {
      // A thematic break, a rule and a picture all take room *and* mean something.
      expect(isBlankOutput('---'), isFalse);
      expect(isBlankOutput('<hr>'), isFalse);
      expect(isBlankOutput('<img src="https://example.com/a.png">'), isFalse);
      expect(isBlankOutput('一个字'), isFalse);
    });

    test('a blank part takes no row once the run has moved on', () {
      expect(blankTakesRow('正文', false), isTrue);
      expect(blankTakesRow('<br><br><br>', false), isFalse);
      // The live tail keeps its row: the caret on an empty bubble is the proof of life.
      expect(blankTakesRow('\n\n', true), isTrue);
    });
  });

  group('collapsing the pathological runs', () {
    test('a run of <br> is shortened, not deleted', () {
      expect(collapseBlankRuns('<br>' * 40), '<br><br>');
      expect(collapseBlankRuns('<br>\n<br />\n<br><br>'), '<br><br>');
      expect(collapseBlankRuns('a<br>b'), 'a<br>b');
      expect(collapseBlankRuns('a<br><br>b'), 'a<br><br>b');
      // The collapsed run still ends at a break, so the paragraph after it is not swallowed.
      expect(collapseBlankRuns('<br><br><br>\n\n后文'), '<br><br>\n\n后文');
    });

    test('invisible space stops being a paragraph each', () {
      expect(collapseBlankRuns('前文\u00a0\u00a0\u00a0\u00a0\u00a0后文'), '前文 后文');
      expect(collapseBlankRuns('a\u00a0\u00a0b'), 'a\u00a0\u00a0b');
      expect(collapseBlankRuns('前文\n\n${'\u200b\n' * 9}\n后文'), isNot(contains('\u200b')));
    });

    test('one &nbsp; is a word’s non-breaking space, not padding', () {
      expect(collapseBlankRuns('5&nbsp;GB × 4'), '5&nbsp;GB × 4');
      expect(collapseBlankRuns('a&nbsp;&nbsp;b'), 'a&nbsp;&nbsp;b');
      expect(collapseBlankRuns('a&nbsp;&nbsp;&nbsp;&nbsp;b'), 'a b');
    });

    test('the reply keeps both of its real paragraphs', () {
      final out = collapseBlankRuns('表单已完成。\n\n${'<br>\n' * 60}${'\u3000\n\n' * 20}审查中发现一个问题。');
      expect(out, startsWith('表单已完成。\n\n'));
      expect(out, endsWith('审查中发现一个问题。'));
      expect('<br>'.allMatches(out).length, 2);
    });
  });

  group('what the renderer actually costs', () {
    setUpAll(() async {
      SharedPreferences.setMockInitialValues({});
    });

    Future<double> height(WidgetTester tester, String text) async {
      await tester.binding.setSurfaceSize(const Size(390, 2400));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      const palette = dark;
      await tester.pumpWidget(
        plain(
          child: MaterialApp(
            theme: buildTheme(palette),
            builder: (_, child) => PaletteScope(palette: palette, child: child!),
            home: Scaffold(
              body: SingleChildScrollView(
                child: SizedBox(
                  width: 360,
                  child: MarkdownView(text: text, palette: palette),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 300));
      return tester.getSize(find.byType(MarkdownView)).height;
    }

    testWidgets('plain newlines were never the problem', (tester) async {
      // Pinned first, because it is the shape everyone guesses at: `gpt_markdown` collapses a
      // run of blank lines on its own, so the wall in a transcript is not this.
      final plain = await height(tester, '前文\n\n后文');
      final padded = await height(tester, '前文\n\n${'\n' * 40}\n后文');
      expect(padded, plain);
    });

    testWidgets('the shapes that used to fill the screen are bounded', (tester) async {
      // `ref` is the same text with the run replaced by what the rule leaves behind: two
      // `<br>`s between two paragraph breaks. Nothing pathological may cost more than that;
      // the invisible-space shapes cost less, because they collapse to a plain blank line.
      final ref = await height(tester, '前文\n\n<br><br>\n\n后文');
      for (final shape in {
        'br ×40': '前文\n\n${'<br>\n' * 40}\n后文',
        'entity ×40': '前文\n\n${'&nbsp;\n' * 40}\n后文',
        'entity ×40 loose': '前文\n\n${'&nbsp;\n\n' * 40}后文',
        'zwsp ×20': '前文\n\n${'\u200b\n\n' * 20}后文',
        'ideographic ×20': '前文\n\n${'\u3000\n\n' * 20}后文',
      }.entries) {
        final h = await height(tester, shape.value);
        expect(h, lessThanOrEqualTo(ref), reason: shape.key);
      }
      // …and the guard is what does it: without the collapse these measured 1120 / 1120 /
      // 1666 / 866 / 66. The last one is the engine's own doing — `gpt_markdown` calls
      // U+3000 blank, `remark-parse` does not, which is why the two ports carry the same rule.
    });

    testWidgets('a real paragraph break is still a real paragraph break', (tester) async {
      // Collapsing must not flatten the structure the reply asked for.
      final one = await height(tester, '前文\n\n后文');
      final two = await height(tester, '前文\n\n中段\n\n后文');
      expect(two, greaterThan(one));
    });
  });
}
