import 'dart:async';

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

  static _ToastHostState? _current;

  /// Show a toast from anywhere. The host is mounted by the app root, and again inside
  /// every modal, because a modal is its own route and would cover a toast drawn only by
  /// the root.
  static void show(String message, {ToastKind kind = ToastKind.info}) {
    if (message.isEmpty) return;
    _current?._present(message, kind);
  }

  @override
  State<ToastHost> createState() => _ToastHostState();
}

enum ToastKind { success, error, info }

void toastSuccess(String message) => ToastHost.show(message, kind: ToastKind.success);

void toastError(String message) => ToastHost.show(message, kind: ToastKind.error);

void toastInfo(String message) => ToastHost.show(message, kind: ToastKind.info);

/// `toast.failure(error, fallback)` — the error's own message when it has one.
void toastFailure(Object error, String fallback) {
  final message = error is StateError && error.message.isNotEmpty ? error.message : '';
  ToastHost.show(message.isNotEmpty ? message : fallback, kind: ToastKind.error);
}

class _ToastHostState extends State<ToastHost> {
  String? _message;
  ToastKind _kind = ToastKind.info;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    ToastHost._current = this;
  }

  @override
  void dispose() {
    _timer?.cancel();
    if (identical(ToastHost._current, this)) ToastHost._current = null;
    super.dispose();
  }

  void _present(String message, ToastKind kind) {
    if (!mounted) return;
    setState(() {
      _message = message;
      _kind = kind;
    });
    _timer?.cancel();
    _timer = Timer(Duration(milliseconds: kind == ToastKind.error ? 4000 : 2200), () {
      if (mounted) setState(() => _message = null);
    });
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
                child: _ToastBody(message: _message!, kind: _kind, palette: palette),
              ),
            ),
          ),
      ],
    );
  }
}

class _ToastBody extends StatelessWidget {
  const _ToastBody({required this.message, required this.kind, required this.palette});

  final String message;
  final ToastKind kind;
  final Palette palette;

  @override
  Widget build(BuildContext context) {
    final (icon, tint, soft) = switch (kind) {
      ToastKind.success => (AppIcons.checkCircle, palette.success, palette.successSoft),
      ToastKind.error => (AppIcons.alert, palette.danger, palette.dangerSoft),
      ToastKind.info => (AppIcons.information, palette.accent, palette.accentSoft),
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
        child: Container(
          padding: const EdgeInsets.fromLTRB(8, 8, 16, 8),
          decoration: BoxDecoration(
            color: palette.card,
            borderRadius: BorderRadius.circular(Radii.pill),
            border: Border.all(color: palette.border, width: 0.5),
            boxShadow: elevation(palette, 2),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Container(
                width: 26,
                height: 26,
                decoration: BoxDecoration(color: soft, shape: BoxShape.circle),
                child: Center(child: HugeIcon(icon: icon, color: tint, size: 15, strokeWidth: 2.2)),
              ),
              const SizedBox(width: 10),
              Flexible(
                child: Text(
                  message,
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: palette.text, fontSize: 14, fontWeight: FontWeight.w600, height: 19 / 14),
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
class AppDialog {
  const AppDialog._();

  static Future<void> alert(BuildContext context, {required String title, String? message}) {
    return GlassDialog.show<void>(
      context: context,
      title: title,
      message: message,
      actions: <GlassDialogAction>[
        GlassDialogAction(label: t('common.ok'), onPressed: () => Navigator.of(context).pop()),
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
    await GlassDialog.show<void>(
      context: context,
      title: title,
      message: message,
      actions: <GlassDialogAction>[
        GlassDialogAction(label: t('common.cancel'), onPressed: () => Navigator.of(context).pop()),
        GlassDialogAction(
          label: confirmLabel ?? t('common.ok'),
          isDestructive: destructive,
          onPressed: () {
            confirmed = true;
            Navigator.of(context).pop();
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
    final controller = TextEditingController(text: initial ?? '');
    String? value;
    await showDialog<void>(
      context: context,
      builder: (dialogContext) {
        final palette = paletteOf(dialogContext);
        return AlertDialog(
          backgroundColor: palette.card,
          title: Text(title, style: TextStyle(color: palette.text, fontSize: 18, fontWeight: FontWeight.w700)),
          content: TextField(
            controller: controller,
            autofocus: true,
            selectAllOnFocus: true,
            style: TextStyle(color: palette.text, fontSize: 16),
            decoration: InputDecoration(
              hintText: placeholder,
              filled: true,
              fillColor: palette.field,
              border: OutlineInputBorder(borderRadius: BorderRadius.circular(Radii.md), borderSide: BorderSide.none),
            ),
          ),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: Text(t('common.cancel')),
            ),
            TextButton(
              onPressed: () {
                value = controller.text.trim();
                Navigator.of(dialogContext).pop();
              },
              child: Text(submitLabel ?? t('common.save')),
            ),
          ],
        );
      },
    );
    controller.dispose();
    return value;
  }
}

