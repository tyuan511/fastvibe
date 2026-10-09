import 'package:flutter/material.dart';
import 'package:hugeicons/hugeicons.dart';

import '../i18n/core.dart';
import '../session/connection.dart';
import '../theme/theme.dart';
import '../ui/icons.dart';
import '../ui/kit.dart';
import '../ui/preferences.dart';

/// The blocking prompt: a question from the agent or a plugin that has parked a tool call
/// until somebody answers.
///
/// It sits in the composer's slot rather than above it, because it is what the next
/// message would be — answering it *is* the next thing that happens in this chat. The
/// five shapes are the five methods the engine can ask with, and each builds the exact
/// payload `engine:permission-respond` expects.
class PromptCard extends StatefulWidget {
  const PromptCard({
    super.key,
    required this.prompt,
    required this.busy,
    required this.onRespond,
  });

  final BlockingPrompt prompt;
  final bool busy;
  final void Function(Map<String, Object?> payload) onRespond;

  @override
  State<PromptCard> createState() => _PromptCardState();
}

class _PromptCardState extends State<PromptCard> {
  late final TextEditingController _text = TextEditingController();
  late List<String?> _answers;

  @override
  void initState() {
    super.initState();
    _answers = List<String?>.filled(widget.prompt.questions?.length ?? 0, null);
  }

  @override
  void didUpdateWidget(PromptCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    // A different prompt at the same position: the screen keys this widget by prompt id,
    // but a stale answer list is a crash (`_answers[index]` past its end) rather than a
    // wrong label, so the component does not rely on its caller for it.
    if (oldWidget.prompt.id == widget.prompt.id) return;
    _text.clear();
    _answers = List<String?>.filled(widget.prompt.questions?.length ?? 0, null);
  }

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  void _answer(Object? value) {
    Haptic.tap();
    widget.onRespond(<String, Object?>{'id': widget.prompt.id, 'value': value});
  }

  void _confirm(bool confirmed) {
    Haptic.tap();
    widget.onRespond(<String, Object?>{
      'id': widget.prompt.id,
      'confirmed': confirmed,
    });
  }

  void _submitText() {
    final value = _text.text.trim();
    if (value.isEmpty) return;
    Haptic.tap();
    widget.onRespond(<String, Object?>{'id': widget.prompt.id, 'value': value});
  }

  void _submitQuestions() {
    Haptic.tap();
    widget.onRespond(<String, Object?>{
      'id': widget.prompt.id,
      'answers': _answers,
    });
  }

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    final prompt = widget.prompt;
    final isConfirm = prompt.method == 'confirm';
    final title = prompt.title ?? prompt.message ?? '';
    final questions = prompt.questions ?? const <PromptQuestion>[];
    final answered = _answers
        .where((answer) => answer != null && answer.trim().isNotEmpty)
        .length;

    return Container(
      decoration: BoxDecoration(
        color: palette.card,
        borderRadius: BorderRadius.circular(Radii.xl),
        border: Border.all(color: palette.border, width: 0.5),
      ),
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(
                  color: palette.accentSoft,
                  borderRadius: BorderRadius.circular(11),
                ),
                child: Center(
                  child: HugeIcon(
                    icon: AppIcons.messageQuestion,
                    size: 18,
                    color: palette.accent,
                    strokeWidth: 2,
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      isConfirm ? t('prompt.confirm', context: context) : t('prompt.answer', context: context),
                      style: TextStyle(
                        color: palette.accent,
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 0.3,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      title,
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: palette.text,
                        fontSize: 16,
                        fontWeight: FontWeight.w700,
                        height: 21 / 16,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 320),
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  if (prompt.message != null && prompt.title != null)
                    _MessageBlock(
                      text: prompt.message!,
                      mono: isConfirm,
                      palette: palette,
                    ),
                  if (prompt.method == 'select' &&
                      (prompt.options?.isNotEmpty ?? false))
                    _SelectOptions(
                      options: prompt.options!,
                      palette: palette,
                      onPick: _answer,
                    ),
                  if ((prompt.method == 'input' || prompt.method == 'editor') &&
                      prompt.message == null)
                    _TextField(
                      controller: _text,
                      palette: palette,
                      multiline: prompt.method == 'editor',
                      hint: prompt.placeholder,
                    ),
                  if (questions.isNotEmpty)
                    for (var index = 0; index < questions.length; index++)
                      Padding(
                        padding: EdgeInsets.only(top: index == 0 ? 0 : 10),
                        child: _Question(
                          question: questions[index],
                          index: index,
                          value: _answers[index],
                          palette: palette,
                          onChanged: (value) =>
                              setState(() => _answers[index] = value),
                        ),
                      ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),
          if (isConfirm)
            Row(
              children: <Widget>[
                Expanded(
                  child: _Button(
                    label: t('prompt.no', context: context),
                    palette: palette,
                    onTap: widget.busy ? null : () => _confirm(false),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: _Button(
                    label: t('prompt.yes', context: context),
                    palette: palette,
                    primary: true,
                    onTap: widget.busy ? null : () => _confirm(true),
                  ),
                ),
              ],
            )
          else if (prompt.method == 'input' || prompt.method == 'editor')
            _Button(
              label: t('prompt.submit', context: context),
              palette: palette,
              primary: true,
              onTap: widget.busy || _text.text.trim().isEmpty
                  ? null
                  : _submitText,
            )
          else if (questions.isNotEmpty)
            _Button(
              label: t('prompt.submitCount', vars: <String, Object?>{
                'done': answered,
                'total': questions.length,
              }, context: context),
              palette: palette,
              primary: true,
              onTap: widget.busy || answered < questions.length
                  ? null
                  : _submitQuestions,
            ),
        ],
      ),
    );
  }
}

class _MessageBlock extends StatelessWidget {
  const _MessageBlock({
    required this.text,
    required this.mono,
    required this.palette,
  });

  final String text;
  final bool mono;
  final Palette palette;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
    decoration: BoxDecoration(
      color: palette.field,
      borderRadius: BorderRadius.circular(Radii.md),
    ),
    child: SelectableText(
      text,
      style: TextStyle(
        color: palette.text,
        fontSize: mono ? 13 : 14,
        height: 20 / 14,
        fontFamily: mono ? 'monospace' : null,
      ),
    ),
  );
}

class _SelectOptions extends StatelessWidget {
  const _SelectOptions({
    required this.options,
    required this.palette,
    required this.onPick,
  });

  final List<String> options;
  final Palette palette;
  final void Function(String option) onPick;

  @override
  Widget build(BuildContext context) => Container(
    decoration: BoxDecoration(
      color: palette.background,
      borderRadius: BorderRadius.circular(Radii.md),
    ),
    clipBehavior: Clip.antiAlias,
    child: Column(
      children: <Widget>[
        for (var index = 0; index < options.length; index++)
          InkWell(
            onTap: () => onPick(options[index]),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
              child: Row(
                children: <Widget>[
                  Container(
                    width: 24,
                    height: 24,
                    decoration: BoxDecoration(
                      color: palette.accentSoft,
                      borderRadius: BorderRadius.circular(7),
                    ),
                    alignment: Alignment.center,
                    child: Text(
                      '${index + 1}',
                      style: TextStyle(
                        color: palette.accent,
                        fontSize: 12,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      options[index],
                      style: TextStyle(color: palette.text, fontSize: 15),
                    ),
                  ),
                ],
              ),
            ),
          ),
      ],
    ),
  );
}

class _TextField extends StatelessWidget {
  const _TextField({
    required this.controller,
    required this.palette,
    required this.multiline,
    this.hint,
  });

  final TextEditingController controller;
  final Palette palette;
  final bool multiline;
  final String? hint;

  @override
  Widget build(BuildContext context) => TextField(
    controller: controller,
    maxLines: multiline ? null : 1,
    minLines: multiline ? 4 : 1,
    style: TextStyle(color: palette.text, fontSize: 16),
    decoration: InputDecoration(
      hintText: hint,
      hintStyle: TextStyle(color: palette.subtle, fontSize: 16),
      filled: true,
      fillColor: palette.field,
      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(Radii.md),
        borderSide: BorderSide.none,
      ),
    ),
  );
}

class _Question extends StatelessWidget {
  const _Question({
    required this.question,
    required this.index,
    required this.value,
    required this.palette,
    required this.onChanged,
  });

  final PromptQuestion question;
  final int index;
  final String? value;
  final Palette palette;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    final options = question.options;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        if (question.header != null)
          Text(
            question.header!,
            style: TextStyle(
              color: palette.accent,
              fontSize: 12,
              fontWeight: FontWeight.w700,
            ),
          ),
        Text(
          question.question,
          style: TextStyle(
            color: palette.text,
            fontSize: 15,
            height: 21 / 15,
            fontWeight: FontWeight.w500,
          ),
        ),
        const SizedBox(height: 8),
        if (options != null && options.isNotEmpty)
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: <Widget>[
              for (final option in options)
                GestureDetector(
                  onTap: () {
                    Haptic.select();
                    onChanged(option);
                  },
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 8,
                    ),
                    decoration: BoxDecoration(
                      color: value == option
                          ? palette.accentSoft
                          : palette.background,
                      borderRadius: BorderRadius.circular(Radii.pill),
                      border: Border.all(
                        color: value == option
                            ? palette.accent
                            : palette.border,
                        width: 0.5,
                      ),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                        if (value == option) ...<Widget>[
                          HugeIcon(
                            icon: AppIcons.tick,
                            size: 14,
                            color: palette.accent,
                            strokeWidth: 2.6,
                          ),
                          const SizedBox(width: 5),
                        ],
                        Text(
                          option,
                          style: TextStyle(
                            color: value == option
                                ? palette.accent
                                : palette.text,
                            fontSize: 14,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
            ],
          )
        else
          TextField(
            onChanged: onChanged,
            maxLines: null,
            style: TextStyle(color: palette.text, fontSize: 15),
            decoration: InputDecoration(
              hintText: question.header,
              hintStyle: TextStyle(color: palette.subtle, fontSize: 15),
              filled: true,
              fillColor: palette.field,
              contentPadding: const EdgeInsets.symmetric(
                horizontal: 12,
                vertical: 10,
              ),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(Radii.md),
                borderSide: BorderSide.none,
              ),
            ),
          ),
      ],
    );
  }
}

class _Button extends StatelessWidget {
  const _Button({
    required this.label,
    required this.palette,
    this.primary = false,
    this.onTap,
  });

  final String label;
  final Palette palette;
  final bool primary;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final disabled = onTap == null;
    return Opacity(
      opacity: disabled ? 0.45 : 1,
      child: GestureDetector(
        onTap: onTap,
        child: Container(
          height: 46,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: primary ? null : palette.field,
            gradient: primary
                ? LinearGradient(
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                    colors: palette.brand,
                  )
                : null,
            borderRadius: BorderRadius.circular(Radii.md),
          ),
          child: Text(
            label,
            style: TextStyle(
              color: primary ? Colors.white : palette.text,
              fontSize: 15,
              fontWeight: FontWeight.w700,
            ),
          ),
        ),
      ),
    );
  }
}
