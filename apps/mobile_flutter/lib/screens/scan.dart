import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../chat/option_sheet.dart';
import '../i18n/core.dart';
import '../theme/theme.dart';
import '../ui/icons.dart';
import '../ui/kit.dart';

/// Scans the QR code from 设置 → 远程访问. The address goes back through
/// `setScannedAddress`, not through the route.
class ScanScreen extends StatefulWidget {
  const ScanScreen({super.key});

  @override
  State<ScanScreen> createState() => _ScanScreenState();
}

class _ScanScreenState extends State<ScanScreen> {
  final MobileScannerController _controller = MobileScannerController(
    formats: const <BarcodeFormat>[BarcodeFormat.qrCode],
  );
  bool _done = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _handle(BarcodeCapture capture) {
    if (_done) return;
    for (final barcode in capture.barcodes) {
      final value = barcode.rawValue;
      if (value == null || value.isEmpty) continue;
      _done = true;
      setScannedAddress(value);
      context.pop();
      return;
    }
  }

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        title: Text(t('nav.scan'), style: const TextStyle(fontWeight: FontWeight.w700)),
      ),
      body: ValueListenableBuilder<MobileScannerState>(
        valueListenable: _controller,
        builder: (context, state, _) {
          if (state.error != null) {
            return _PermissionRequest(
              palette: palette,
              onAllow: () => _controller.start(),
              denied: state.error!.errorCode == MobileScannerErrorCode.permissionDenied,
            );
          }
          if (!state.isInitialized && state.isRunning == false) {
            return const Center(
              child: Text('', style: TextStyle(color: Colors.white)),
            );
          }
          return Stack(
            fit: StackFit.expand,
            children: <Widget>[
              MobileScanner(controller: _controller, onDetect: _handle),
              const _ScanFrame(),
            ],
          );
        },
      ),
    );
  }
}

class _PermissionRequest extends StatelessWidget {
  const _PermissionRequest({required this.palette, required this.onAllow, required this.denied});

  final Palette palette;
  final VoidCallback onAllow;
  final bool denied;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: palette.background,
      child: EmptyState(
        icon: AppIcons.qrCode,
        title: denied ? t('scan.permissionTitle') : t('scan.requesting'),
        body: denied ? t('scan.permissionBody') : null,
        children: <Widget>[
          if (denied) ...<Widget>[
            const SizedBox(height: 20),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 320),
              child: PrimaryButton(label: t('scan.allow'), onPressed: onAllow),
            ),
          ],
        ],
      ),
    );
  }
}

/// The scanner's viewfinder: four corners and a sweeping line. Guidance only — the
/// scanner reads a code anywhere on screen.
class _ScanFrame extends StatefulWidget {
  const _ScanFrame();

  @override
  State<_ScanFrame> createState() => _ScanFrameState();
}

class _ScanFrameState extends State<_ScanFrame> with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1800),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    final width = MediaQuery.sizeOf(context).width;
    final size = math.min(width * 0.68, 280.0);
    return LayoutBuilder(
      builder: (context, constraints) => Stack(
        children: <Widget>[
          Positioned.fill(
            child: IgnorePointer(
              child: CustomPaint(painter: _MaskPainter(size: size)),
            ),
          ),
          Positioned(
            left: (constraints.maxWidth - size) / 2,
            top: (constraints.maxHeight - size) / 2,
            child: SizedBox(
              width: size,
              height: size,
              child: AnimatedBuilder(
                animation: _controller,
                builder: (context, _) => Stack(
                  children: <Widget>[
                    ..._corners(size),
                    Positioned(
                      left: 12,
                      right: 12,
                      top: 12 + (size - 24) * _controller.value,
                      child: Container(
                        height: 2,
                        decoration: BoxDecoration(
                          color: palette.accent.withValues(alpha: 0.9),
                          borderRadius: BorderRadius.circular(1),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
          Positioned(
            left: 0,
            right: 0,
            top: (constraints.maxHeight + size) / 2,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 32),
              child: Column(
                children: <Widget>[
                  Text(
                    t('scan.hint'),
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    t('scan.hintBody'),
                    textAlign: TextAlign.center,
                    style: TextStyle(color: Colors.white.withValues(alpha: 0.75), fontSize: 13, height: 19 / 13),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  List<Widget> _corners(double size) {
    const arm = 28.0;
    Widget corner(Alignment alignment, BorderRadius radius) => Align(
          alignment: alignment,
          child: Container(
            width: arm,
            height: arm,
            decoration: BoxDecoration(
              border: Border(
                top: alignment.y < 0 ? const BorderSide(color: Colors.white, width: 4) : BorderSide.none,
                bottom: alignment.y > 0 ? const BorderSide(color: Colors.white, width: 4) : BorderSide.none,
                left: alignment.x < 0 ? const BorderSide(color: Colors.white, width: 4) : BorderSide.none,
                right: alignment.x > 0 ? const BorderSide(color: Colors.white, width: 4) : BorderSide.none,
              ),
              borderRadius: radius,
            ),
          ),
        );
    return <Widget>[
      corner(Alignment.topLeft, const BorderRadius.only(topLeft: Radius.circular(6))),
      corner(Alignment.topRight, const BorderRadius.only(topRight: Radius.circular(6))),
      corner(Alignment.bottomLeft, const BorderRadius.only(bottomLeft: Radius.circular(6))),
      corner(Alignment.bottomRight, const BorderRadius.only(bottomRight: Radius.circular(6))),
    ];
  }
}

class _MaskPainter extends CustomPainter {
  _MaskPainter({required this.size});

  final double size;

  @override
  void paint(Canvas canvas, Size canvasSize) {
    final rect = Offset.zero & canvasSize;
    final hole = Rect.fromCenter(
      center: rect.center,
      width: size,
      height: size,
    );
    final path = Path.combine(
      PathOperation.difference,
      Path()..addRect(rect),
      Path()..addRRect(RRect.fromRectAndRadius(hole, const Radius.circular(16))),
    );
    canvas.drawPath(path, Paint()..color = const Color(0x8C000000));
  }

  @override
  bool shouldRepaint(_MaskPainter oldDelegate) => oldDelegate.size != size;
}
