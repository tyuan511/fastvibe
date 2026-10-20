import 'package:flutter_test/flutter_test.dart';
import 'package:fastvibe_mobile/chat/message.dart';
import 'package:fastvibe_mobile/chat/skill_invocation.dart';

void main() {
  const expanded =
      '<skill name="office" location="/skills/office/SKILL.md">\nInstructions for the model\n</skill>';

  test('mapped skill-only messages survive decoding and copy/reuse', () {
    final row = ChatMessage.fromJson({
      'id': 'u1',
      'role': 'user',
      'text': '',
      'parts': [],
      'skill': {'name': 'office', 'location': '/skills/office/SKILL.md'},
    });
    expect(row.skill?.name, 'office');
    expect(row.skill?.location, '/skills/office/SKILL.md');
    expect(row.hasContent, isTrue);
    expect(row.copy().skill?.name, 'office');
    expect(row.copy().promptText, '/skill:office');
  });

  test(
    'raw commands and expanded blocks have the same display and resend text',
    () {
      for (final text in ['/skill:office 写周报', '$expanded\n\n写周报']) {
        final row = ChatMessage.fromJson({
          'id': 'u1',
          'role': 'user',
          'text': text,
          'parts': [
            {'kind': 'text', 'text': text},
          ],
        });
        expect(row.text, '写周报');
        expect(row.skill?.name, 'office');
        expect((row.parts!.single as TextPart).text, '写周报');
        expect(row.promptText, '/skill:office 写周报');
      }
      expect(skillDisplayOf(expanded).text, '');
      expect(skillDisplayOf('/skill:office').skill?.name, 'office');
    },
  );

  test('already mapped words are not parsed as a second invocation', () {
    final row = ChatMessage.fromJson({
      'id': 'u1',
      'role': 'user',
      'text': '/skill:pdf 说明这个命令',
      'skill': {'name': 'office'},
    });
    expect(row.text, '/skill:pdf 说明这个命令');
    expect(row.promptText, '/skill:office /skill:pdf 说明这个命令');
  });

  test('assistant examples and ordinary messages stay intact', () {
    final row = ChatMessage.fromJson({
      'id': 'a1',
      'role': 'assistant',
      'text': expanded,
    });
    expect(row.text, expanded);
    expect(row.skill, isNull);
    expect(skillDisplayOf('看看这个：$expanded').skill, isNull);
    expect(skillCommandOf(null, 'ordinary text'), 'ordinary text');
  });
}
