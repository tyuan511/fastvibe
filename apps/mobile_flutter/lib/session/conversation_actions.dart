import '../i18n/core.dart';
import '../ui/feedback.dart' show toastError, toastSuccess;
import 'connection.dart';

/// What can be done to a conversation from the phone — the list's long-press menu and
/// the chat header's ⋯ share these. Each reports its own outcome as a toast; the
/// catalog push is what updates the list afterwards.

bool _fail(String title, Object error) {
  final message = error is StateError ? error.message : '$error';
  toastError(message.isNotEmpty ? t('toast.failedWith', <String, Object?>{'title': title, 'message': message}) : title);
  return false;
}

bool _done(String message) {
  toastSuccess(message);
  return true;
}

Future<void> _settingsQueue = Future<void>.value();

Future<T> _enqueueSettingsMutation<T>(Future<T> Function() operation) {
  final next = _settingsQueue.then((_) => operation(), onError: (_) => operation());
  _settingsQueue = next.then((_) {}, onError: (_) {});
  return next;
}

Future<bool> renameConversation(String id, String title) async {
  final remote = Connection.instance.client;
  if (remote == null) return false;
  try {
    await remote.call('conversations:rename', <String, Object?>{'id': id, 'title': title});
    return _done(t('toast.renamed'));
  } catch (error) {
    return _fail(t('actions.renameFailed'), error);
  }
}

/// Read the machine's archive list before writing it, so another client's archived
/// conversations are never overwritten by this phone's older copy.
Future<void> _writeArchived(List<String> Function(List<String> previous) change) {
  return _enqueueSettingsMutation(() async {
    final remote = Connection.instance.client;
    if (remote == null) throw StateError(t('conn.notConnected'));
    final settings = await remote.call('settings:get');
    final previous = archivedIdsFrom(settings);
    final next = change(previous);
    await remote.call('settings:set', <String, Object?>{'archivedConversations': next});
    Connection.instance.setArchivedIds(next);
  });
}

/// Archiving a running chat stops it, as on the desktop.
Future<bool> archiveConversation(String id, {required bool running}) async {
  try {
    await _writeArchived((previous) => <String>{...previous, id}.toList());
    if (running) {
      await Connection.instance.client?.call('engine:abort', <String, Object?>{'conversationId': id});
    }
    return _done(t('toast.archived'));
  } catch (error) {
    return _fail(t('actions.archiveFailed'), error);
  }
}

Future<bool> unarchiveConversation(String id) async {
  try {
    await _writeArchived((previous) => previous.where((item) => item != id).toList());
    return _done(t('toast.restored'));
  } catch (error) {
    return _fail(t('actions.restoreFailed'), error);
  }
}

Future<bool> deleteConversation(String id) async {
  final remote = Connection.instance.client;
  if (remote == null) return false;
  try {
    await remote.call('conversations:delete', <String, Object?>{'id': id});
    return _done(t('toast.deleted'));
  } catch (error) {
    return _fail(t('actions.deleteFailed'), error);
  }
}
