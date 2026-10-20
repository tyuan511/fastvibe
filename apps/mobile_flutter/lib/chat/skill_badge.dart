import 'package:flutter/material.dart';

import '../i18n/core.dart';
import '../ui/icons.dart';
import '../ui/kit.dart';
import 'skill_invocation.dart';

class SkillBadge extends StatelessWidget {
  const SkillBadge({super.key, required this.skill});

  final SkillMark skill;

  @override
  Widget build(BuildContext context) => Pill(
    label: '${t('tool.skill', context: context)} ${skill.name}',
    tone: PillTone.warning,
    icon: AppIcons.magicWand,
  );
}
