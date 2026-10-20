/// The small skill marker carried by a mapped user message.
class SkillMark {
  const SkillMark({required this.name, this.location});

  static SkillMark? fromJson(Object? value) {
    if (value is! Map ||
        value['name'] is! String ||
        (value['name'] as String).isEmpty) {
      return null;
    }
    return SkillMark(
      name: value['name'] as String,
      location: value['location'] is String
          ? value['location'] as String
          : null,
    );
  }

  final String name;
  final String? location;
}

// Same two wire forms as src/shared/skill-invocation.ts. Older hosts send the
// expanded block; local optimistic rows still carry the command.
final _block = RegExp(
  r'^<skill name="([^"]+)" location="([^"]*)">\n([\s\S]*?)\n</skill>(?:\n\n([\s\S]+))?$',
);
final _command = RegExp(r'^/skill:([^\s]+)(?:\s+([\s\S]*))?$');

({String text, SkillMark? skill}) skillDisplayOf(String text) {
  final trimmed = text.trim();
  final block = _block.firstMatch(trimmed);
  if (block != null) {
    return (
      text: (block[4] ?? '').trim(),
      skill: SkillMark(
        name: block[1]!,
        location: block[2]!.isEmpty ? null : block[2],
      ),
    );
  }
  final command = _command.firstMatch(trimmed);
  if (command == null) return (text: text, skill: null);
  return (text: (command[2] ?? '').trim(), skill: SkillMark(name: command[1]!));
}

/// Copy/reuse reconstructs a command, never the hidden instruction sheet.
String skillCommandOf(SkillMark? skill, String text) {
  if (skill == null) return text;
  return text.trim().isEmpty
      ? '/skill:${skill.name}'
      : '/skill:${skill.name} $text';
}
