import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:fastvibe_mobile/i18n/zh.dart';
import 'package:fastvibe_mobile/i18n/en.dart';

void main() {
  test('every literal product translation exists in both languages', () {
    final pattern = RegExp(r"\bt\('([^'\$]+)'");
    for (final file
        in Directory('lib')
            .listSync(recursive: true)
            .whereType<File>()
            .where((f) => f.path.endsWith('.dart'))) {
      for (final match in pattern.allMatches(file.readAsStringSync())) {
        final key = match.group(1)!;
        expect(zh.containsKey(key), isTrue, reason: '${file.path}: $key (zh)');
        expect(en.containsKey(key), isTrue, reason: '${file.path}: $key (en)');
      }
    }
  });
}
