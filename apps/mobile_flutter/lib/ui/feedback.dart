import 'dart:async';

import 'package:flutter/cupertino.dart' show showCupertinoDialog;
import 'package:flutter/material.dart';
import 'package:hugeicons/hugeicons.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';

import '../i18n/core.dart';
import '../theme/theme.dart';
import 'icons.dart';
import 'kit.dart';

/// The outcome of an action — 已复制, 已归档, 重命名失败.
///
/// One toast at a time: a new one replaces whatever is on screen rather than stacking,
/// which is what the Expo client does and what keeps a burst of results readable.
class ToastHost extends StatefulWidget {
  const ToastHost({super.key, required this.child});

  final Widget child;

  static final List<_ToastHostState> _hosts = [];

  /// Show a toast from anywhere. The host is mounted by the app root, and again inside
  /// every modal, because a modal is its own route and would cover a toast drawn only by
  /// the root.
  static void show(String message, {ToastKind kind = ToastKind.info}) {
    if (message.isEmpty) return;
    if (_hosts.isNotEmpty) _hosts.last._present(message, kind);
  }

  @override
  State<ToastHost> createState() => _ToastHostState();
}

enum ToastKind { success, error, info }

void toastSuccess(String message) =>
    ToastHost.show(message, kind: ToastKind.success);

void toastError(String message) =>
    ToastHost.show(message, kind: ToastKind.error);

void toastInfo(String message) => ToastHost.show(message, kind: ToastKind.info);

/// `toast.failure(error, fallback)` — the error's own message when it has one.
void toastFailure(Object error, String fallback) {
  final message = error is StateError && error.message.isNotEmpty
      ? error.message
      : '';
  ToastHost.show(
    message.isNotEmpty ? message : fallback,
    kind: ToastKind.error,
  );
}

class _ToastHostState extends State<ToastHost> {
  String? _message;
  ToastKind _kind = ToastKind.info;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    ToastHost._hosts.add(this);
  }

  @override
  void dispose() {
    _timer?.cancel();
    ToastHost._hosts.remove(this);
    super.dispose();
  }

  void _present(String message, ToastKind kind) {
    if (!mounted) return;
    setState(() {
      _message = message;
      _kind = kind;
    });
    _timer?.cancel();
    _timer = Timer(
      Duration(milliseconds: kind == ToastKind.error ? 4000 : 2200),
      () {
        if (mounted) setState(() => _message = null);
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    return Stack(
      children: <Widget>[
        widget.child,
        if (_message != null)
          Positioned(
            top: MediaQuery.paddingOf(context).top + 8,
            left: 16,
            right: 16,
            child: SafeArea(
              bottom: false,
              child: Center(
                child: _ToastBody(
                  message: _message!,
                  kind: _kind,
                  palette: palette,
                ),
              ),
            ),
          ),
      ],
    );
  }
}

class _ToastBody extends StatelessWidget {
  const _ToastBody({
    required this.message,
    required this.kind,
    required this.palette,
  });

  final String message;
  final ToastKind kind;
  final Palette palette;

  @override
  Widget build(BuildContext context) {
    final (icon, tint, _) = switch (kind) {
      ToastKind.success => (
        AppIcons.checkCircle,
        palette.success,
        palette.successSoft,
      ),
      ToastKind.error => (AppIcons.alert, palette.danger, palette.dangerSoft),
      ToastKind.info => (
        AppIcons.information,
        palette.accent,
        palette.accentSoft,
      ),
    };
    return TweenAnimationBuilder<double>(
      key: ValueKey<String>(message),
      tween: Tween<double>(begin: 0, end: 1),
      duration: const Duration(milliseconds: 220),
      curve: Curves.easeOutBack,
      builder: (context, value, child) => Transform.translate(
        offset: Offset(0, -24 * (1 - value)),
        child: Opacity(opacity: value.clamp(0, 1), child: child),
      ),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 440),
        child: GlassContainer(
          useOwnLayer: true,
          shape: const LiquidRoundedSuperellipse(borderRadius: 26),
          padding: const EdgeInsets.fromLTRB(16, 13, 20, 13),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              // iOS's own HUD capsule: a tinted glyph, no disc behind it.
              HugeIcon(icon: icon, color: tint, size: 20, strokeWidth: 2),
              const SizedBox(width: 8),
              Flexible(
                child: Text(
                  message,
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: palette.text,
                    fontSize: 15,
                    fontWeight: FontWeight.w500,
                    height: 20 / 15,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A confirmation, a notice, or a text prompt. Drawn as a liquid-glass dialog.
///
/// Never `AlertDialog`: a confirmation, a notice and a text prompt all have one look
/// here, and the typed text must survive an outside press — a modal backdrop covers the
/// whole window, so one stray tap would otherwise throw away an answer that took a while
/// to write.
/// `GlassDialog.show` is `showCupertinoDialog` around the package's dialog, and a
/// Cupertino route has no `Material` above it: every `Text` in the dialog then falls
/// back to the framework's debug style — the yellow double underline. The route also
/// ran the full refractive shader (own layer, plus one per action button) over the page
/// behind it, which is what made opening one stutter. So the dialog is built here:
/// a `Material` for the text style, and `GlassQuality.minimal` — the same frosted card
/// from a plain backdrop blur, no shader pass.
Future<void> _showGlassDialog({
  required BuildContext context,
  required List<GlassDialogAction> actions,
  String? title,
  String? message,
  Widget? content,
}) {
  final p = paletteOf(context);
  return showCupertinoDialog<void>(
    context: context,
    useRootNavigator: true,
    builder: (dialogContext) => Material(
      type: MaterialType.transparency,
      child: GlassDialog(
        title: title,
        message: message,
        content: content,
        actions: actions,
        quality: GlassQuality.minimal,
        settings: LiquidGlassSettings(
          glassColor: p.card.withValues(alpha: p.dark ? 0.72 : 0.82),
          blur: 22,
          thickness: 14,
        ),
      ),
    ),
  );
}

class AppDialog {
  const AppDialog._();

  static Future<void> alert(
    BuildContext context, {
    required String title,
    String? message,
  }) {
    return _showGlassDialog(
      context: context,
      title: title,
      message: message,
      actions: <GlassDialogAction>[
        GlassDialogAction(
          label: t('common.ok'),
          onPressed: () => Navigator.of(context, rootNavigator: true).pop(),
        ),
      ],
    );
  }

  static Future<bool> confirm(
    BuildContext context, {
    required String title,
    String? message,
    String? confirmLabel,
    bool destructive = false,
  }) async {
    var confirmed = false;
    await _showGlassDialog(
      context: context,
      title: title,
      message: message,
      actions: <GlassDialogAction>[
        GlassDialogAction(
          label: t('common.cancel'),
          onPressed: () => Navigator.of(context, rootNavigator: true).pop(),
        ),
        GlassDialogAction(
          label: confirmLabel ?? t('common.ok'),
          isDestructive: destructive,
          onPressed: () {
            confirmed = true;
            Navigator.of(context, rootNavigator: true).pop();
          },
        ),
      ],
    );
    return confirmed;
  }

  /// A single-line answer. Returns null when it was cancelled.
  static Future<String?> prompt(
    BuildContext context, {
    required String title,
    String? message,
    String? initial,
    String? placeholder,
    String? submitLabel,
  }) async {
    // The text is read from `typed`, not from a controller held here: the dialog is still
    // animating out after `show` returns, and its field keeps listening to its controller
    // until the route is gone. A controller disposed at that point throws "used after
    // being disposed", so the field owns its own (`_PromptField`).
    var typed = initial ?? '';
    String? value;
    final palette = paletteOf(context);
    await _showGlassDialog(
      context: context,
      title: title,
      message: message,
      content: _PromptField(
        initial: initial ?? '',
        placeholder: placeholder,
        palette: palette,
        onChanged: (text) => typed = text,
      ),
      actions: [
        GlassDialogAction(
          label: t('common.cancel'),
          onPressed: () => Navigator.of(context, rootNavigator: true).pop(),
        ),
        GlassDialogAction(
          label: submitLabel ?? t('common.save'),
          onPressed: () {
            value = typed.trim();
            Navigator.of(context, rootNavigator: true).pop();
          },
        ),
      ],
    );
    return value;
  }
}

/// The prompt's input. A widget of its own so the controller lives and dies with the
/// field rather than with the call that opened the dialog.
class _PromptField extends StatefulWidget {
  const _PromptField({
    required this.initial,
    required this.placeholder,
    required this.palette,
    required this.onChanged,
  });

  final String initial;
  final String? placeholder;
  final Palette palette;
  final ValueChanged<String> onChanged;

  @override
  State<_PromptField> createState() => _PromptFieldState();
}

class _PromptFieldState extends State<_PromptField> {
  late final TextEditingController _controller = TextEditingController(
    text: widget.initial,
  );

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final palette = widget.palette;
    return Material(
      type: MaterialType.transparency,
      child: TextField(
        controller: _controller,
        autofocus: true,
        selectAllOnFocus: true,
        onChanged: widget.onChanged,
        style: TextStyle(color: palette.text, fontSize: 16),
        decoration: InputDecoration(
          hintText: widget.placeholder,
          filled: true,
          fillColor: palette.field,
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(Radii.md),
            borderSide: BorderSide.none,
          ),
        ),
      ),
    );
  }
}
