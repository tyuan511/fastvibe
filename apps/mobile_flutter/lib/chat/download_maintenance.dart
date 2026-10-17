import 'dart:io';

import 'package:path_provider/path_provider.dart';

import 'file_transfer.dart';

/// Best-effort cache maintenance must never hold up the first frame.
Future<void> cleanupSavedDownloads() async {
  try {
    final root = await getApplicationDocumentsDirectory();
    await FileTransfer.cleanupCheckpoints(Directory('${root.path}/Downloads'));
  } catch (_) {
    // Platform storage may not yet be available. The next download sweeps again.
  }
}
