import 'package:flutter/material.dart';

import '../i18n/core.dart';
import '../protocol/diagnostics.dart';
import '../ui/kit.dart';

class ConnectionDiagnosticsView extends StatelessWidget {
  const ConnectionDiagnosticsView({super.key, required this.summary, required this.onCopy});
  final ConnectionDiagnosticSummary summary;
  final VoidCallback onCopy;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    return SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: <Widget>[
        Text(t('diagnostics.title', context: context), style: TextStyle(color: palette.text, fontSize: 20, fontWeight: FontWeight.w600)),
        const SizedBox(height: 16),
        Text(t('diagnostics.${summary.state}', context: context), style: TextStyle(color: palette.text, fontSize: 16, fontWeight: FontWeight.w500)),
        const SizedBox(height: 8),
        Text(t('diagnostics.${summary.state}Hint', context: context), style: TextStyle(color: palette.muted, fontSize: 14, height: 1.5)),
        if (summary.at != null) ...<Widget>[
          const SizedBox(height: 12),
          Text(t('diagnostics.observed', vars: <String, Object?>{'time': DateTime.parse(summary.at!).toLocal().toString().split('.').first}, context: context), style: TextStyle(color: palette.subtle, fontSize: 12)),
        ],
        for (final timing in summary.timings.entries) Padding(
          padding: const EdgeInsets.only(top: 12),
          child: Row(children: <Widget>[
            Expanded(child: Text(t('diagnostics.metric.${timing.key}', context: context), style: TextStyle(color: palette.muted, fontSize: 14))),
            Text('${timing.value} ms', style: TextStyle(color: palette.text, fontSize: 14)),
          ]),
        ),
        const SizedBox(height: 16),
        TextButton(onPressed: onCopy, child: Text(t('diagnostics.copy', context: context))),
        const SafeArea(top: false, child: SizedBox(height: 12)),
      ]),
    );
  }
}
