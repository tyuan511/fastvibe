import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';
import 'package:hugeicons/hugeicons.dart';

import '../chat/composer.dart';
import '../chat/dag_data.dart';
import '../chat/dag_panel.dart';
import '../chat/draft_storage.dart';
import '../chat/history_pager.dart';
import '../chat/image_note.dart';
import '../chat/images.dart';
import '../chat/live_events.dart';
import '../chat/message.dart';
import '../chat/option_sheet.dart';
import '../chat/prompt_card.dart';
import '../chat/queue.dart';
import '../chat/queue_panel.dart';
import '../chat/snapshot_sync.dart';
import '../chat/turn_meta.dart';
import '../i18n/core.dart';
import '../protocol/client.dart';
import '../protocol/diagnostics.dart';
import '../session/catalog.dart';
import '../session/connection.dart';
import '../session/conversation_actions.dart';
import '../theme/theme.dart';
import '../ui/feedback.dart';
import '../ui/glass_screen.dart';
import '../ui/icons.dart';
import '../ui/kit.dart';
import '../ui/preferences.dart';
import 'transcript.dart';
import '../ui/context_menu.dart';

/// One conversation.
///
/// The shape of this screen is the hard part, so it is worth stating plainly:
///
/// - **Subscribe, then snapshot, then drop by `seq`.** `SnapshotSync` holds every event
///   that arrives while the snapshot is in flight and merges them by *server sequence*,
///   never by arrival time — the wildcard subscription can deliver a live frame before
///   the named replay is requested.
/// - **The transcript is not re-read on every boundary.** A `message_end` asks for a
///   refresh, which is coalesced: one read in flight, at most one queued behind it. A
///   tool finishing does not: its execution event already updated the row.
/// - **Streaming events are reduced in place**, at most once per frame-sized interval, so
///   a fast model does not repaint the list once per token.
/// - **Older history has its own flight**, so scrolling back never blocks the live path.
class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key, required this.conversationId});

  final String conversationId;

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  /// Height of the footer (banner, queue, prompt/composer) drawn over the bottom of the
  /// transcript. The transcript scrolls underneath it, so it pads its end by this much.
  double _footerHeight = 0;

  final List<ChatMessage> _messages = <ChatMessage>[];
  final Map<ChatMessage, ({ChatMessage previous, ChatMessage merged})>
  _replyCache = <ChatMessage, ({ChatMessage previous, ChatMessage merged})>{};
  Timer? _paintTimer;
  bool _paintScheduled = false;

  final TextEditingController _draft = TextEditingController();
  List<ComposerImage> _images = <ComposerImage>[];
  bool _draftHydrated = false;
  bool _draftTouched = false;
  Timer? _draftTimer;

  bool _loading = true;
  bool _sending = false;
  bool _responding = false;
  Object? _submitting;
  late QueueState _queue;
  bool _restored = false;

  SnapshotSync? _sync;
  HistoryPager<ChatMessage>? _pager;
  String? _historyCursor;
  SyncCheckpoint? _checkpoint;
  Map<String, TurnMeta> _footers = <String, TurnMeta>{};
  bool _fullRead = false;
  DagWatcher? _dag;
  Timer? _clock;
  int _now = DateTime.now().millisecondsSinceEpoch;

  String get _conversationId => widget.conversationId;

  RemoteClient? get _remote => Connection.instance.client;

  String? get _serverId => Connection.instance.server?.id;

  bool get _running => Connection.instance.running[_conversationId] == true;

  BlockingPrompt? get _prompt {
    for (final item in Connection.instance.pending) {
      if (item.conversationId == _conversationId) return item;
    }
    return null;
  }

  CatalogConversation? get _chat {
    for (final item in Connection.instance.conversations) {
      if (item.id == _conversationId) return item;
    }
    return null;
  }

  String? get _projectName {
    final project = _chat?.project;
    if (project == null) return null;
    for (final item in Connection.instance.projects) {
      if (item.cwd == project) return item.name;
    }
    return null;
  }

  bool get _connected => _remote != null && _restored;

  @override
  void initState() {
    super.initState();
    _queue = emptyQueue(widget.conversationId);
    Connection.instance.addListener(_onConnection);
    _draft.addListener(_onDraftChanged);
    _dag = DagWatcher(_conversationId);
    _clock = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && _running) {
        setState(() => _now = DateTime.now().millisecondsSinceEpoch);
      }
    });
    _hydrateDraft();
    _startSync();
  }

  @override
  void didUpdateWidget(ChatScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.conversationId == widget.conversationId) return;
    _flushDraft();
    _draftTimer?.cancel();
    _teardownSync();
    _dag?.dispose();
    _dag = DagWatcher(widget.conversationId);
    _resetForConversation();
    _hydrateDraft();
    _startSync();
  }

  @override
  void dispose() {
    Connection.instance.removeListener(_onConnection);
    _draft.removeListener(_onDraftChanged);
    _draftTimer?.cancel();
    _paintTimer?.cancel();
    _clock?.cancel();
    _teardownSync();
    _dag?.dispose();
    _flushDraft();
    _draft.dispose();
    super.dispose();
  }

  void _onConnection() {
    if (!mounted) return;
    // A scope may first mount before a socket is ready. Retire the old listener even
    // while disconnected; a new socket must restore its own queue before Send enables.
    if (!identical(_syncScopeRemote, _remote)) {
      _teardownSync();
      _restored = false;
      if (_remote != null) _startSync();
    }
    if (_draftServerId != _serverId) {
      _flushDraft();
      _hydrateDraft();
    }
    setState(() {});
  }

  RemoteClient? _syncScopeRemote;
  String? _syncConversationId;
  void Function(Map<String, Object?>, EventMeta?)? _eventListener;
  VoidCallback? _cancelScope;
  String? _draftServerId;
  String? _draftConversationId;
  int _draftGeneration = 0;

  void _resetForConversation() {
    _messages.clear();
    _replyCache.clear();
    _queue = emptyQueue(widget.conversationId);
    _historyCursor = null;
    _checkpoint = null;
    _loading = true;
    _restored = false;
    _images = [];
    _sending = false;
    _submitting = null;
  }

  // ---- draft ---------------------------------------------------------------------

  Future<void> _hydrateDraft() async {
    final generation = ++_draftGeneration;
    final serverId = _serverId;
    final conversationId = _conversationId;
    _draftTimer?.cancel();
    _draftHydrated = false;
    _draftServerId = serverId;
    _draftConversationId = conversationId;
    _draft.text = '';
    _draftTouched = false;
    if (serverId == null) return;
    final saved = await readDraft(serverId, conversationId);
    if (!mounted || generation != _draftGeneration) return;
    if (!_draftTouched) _draft.text = saved?.text ?? '';
    setState(() => _draftHydrated = true);
  }

  void _onDraftChanged() {
    _draftTouched = true;
    if (!_draftHydrated) return;
    _draftTimer?.cancel();
    _draftTimer = Timer(const Duration(milliseconds: 350), _flushDraft);
    if (mounted) setState(() {});
  }

  void _flushDraft() {
    final serverId = _draftServerId;
    final conversationId = _draftConversationId;
    if (serverId != null &&
        conversationId != null &&
        (_draftHydrated || _draftTouched)) {
      unawaited(writeDraft(serverId, conversationId, _draft.text));
    }
  }

  // ---- transcript ------------------------------------------------------------------

  /// Every event is reduced in order, but the list is painted at most once per
  /// frame-sized interval. A fast model otherwise repaints per token.
  void _setMessages(List<ChatMessage> next) {
    if (!mounted || identical(next, _messages)) return;
    _messages
      ..clear()
      ..addAll(next);
    if (_paintScheduled) return;
    _paintScheduled = true;
    _paintTimer = Timer(const Duration(milliseconds: 16), () {
      _paintTimer = null;
      _paintScheduled = false;
      if (mounted) setState(() {});
    });
  }

  void _startSync() {
    final remote = _remote;
    if (remote == null) {
      setState(() => _loading = false);
      return;
    }
    _syncScopeRemote = remote;
    final conversationId = _conversationId;
    _syncConversationId = conversationId;
    _restored = false;
    final serverId = _serverId;
    final started = DateTime.now().millisecondsSinceEpoch;
    var cancelled = false;
    _cancelScope = () => cancelled = true;

    void applyEvent(Map<String, Object?> event) {
      if (cancelled || !mounted) return;
      if (event['conversationId'] != conversationId) return;
      Connection.instance.applyChatEvent(remote, event);
      if (event['type'] == 'queue_changed') {
        _applyQueue(event['queue']);
        return;
      }
      if (event['type'] == 'queue_error') {
        toastError(
          event['message'] is String
              ? event['message'] as String
              : t('chat.queueFailed'),
        );
      }
      if (event['type'] == 'message_start') {
        _setMessages(
          applyMessageStart(List<ChatMessage>.from(_messages), event),
        );
      }
      final nested = nestedParent(event) != null;
      if (event['type'] == 'message_update' ||
          event['type'] == 'tool_execution_start' ||
          event['type'] == 'tool_execution_update' ||
          event['type'] == 'tool_execution_end') {
        // A call a `codemode` script made itself is the script card's, not a row of its
        // own — and each such call ends with an event of its own, which must not cost a
        // reload apiece.
        if (!nested) {
          _setMessages(
            applyLiveEngineEvent(List<ChatMessage>.from(_messages), event),
          );
        }
      }
      // A tool finishing is already on screen: the execution event above updated its
      // row. Re-reading the transcript there pulled the tail of the chat once per call,
      // which on a direct connection cost more than the event itself. The reply's own
      // end still reconciles, which is where a call's recorded result can differ.
      if (event['type'] == 'queue_delivered' ||
          event['type'] == 'agent_settled' ||
          event['type'] == 'message_end') {
        _reload(event['seq'] is int ? event['seq'] as int : null);
      }
    }

    late final SnapshotSync sync;
    late HistoryPager<ChatMessage> pager;
    sync = SnapshotSync(
      SnapshotSyncOptions(
        isCurrent: () => mounted && !cancelled && identical(_sync, sync),
        subscribe: (cursor) => remote.subscribeConversation(
          'conversation:$conversationId',
          cursor,
        ),
        load: () async {
          final anchorEntryId = !_fullRead
              ? _messages
                    .lastWhere(
                      (message) =>
                          message.role == 'user' &&
                          !message.id.startsWith('local-'),
                      orElse: () => ChatMessage(id: '', role: 'user'),
                    )
                    .id
              : null;
          final result = await remote.call(
            'engine:get-snapshot',
            <String, Object?>{
              'conversationId': conversationId,
              // The phone only renders compact tool rows. Keep large arguments and
              // results out of snapshots so a relayed connection does not carry UI
              // data that can never be displayed here.
              'toolDetail': 'summary',
              if (anchorEntryId != null && anchorEntryId.isNotEmpty)
                'fromEntryId': anchorEntryId,
              if (!_fullRead &&
                  _messages.isEmpty &&
                  remote.supportsHistoryPaging)
                'historyLimit': 12,
            },
          );
          final map = result is Map
              ? result.cast<String, Object?>()
              : <String, Object?>{};
          return Snapshot(
            seq: map['seq'] is int ? map['seq'] as int : 0,
            messages: map['messages'] is List ? map['messages'] as List : null,
            queue: map['queue'],
            messageMode: map['messageMode'] is String
                ? map['messageMode'] as String
                : null,
            messageAnchorId: map['messageAnchorId'] is String
                ? map['messageAnchorId'] as String
                : null,
            running: map['running'] is bool ? map['running'] as bool : null,
            pendingUi: map['pendingUi'] is List
                ? map['pendingUi'] as List
                : null,
            historyBeforeEntryId:
                map['history'] is Map &&
                    (map['history'] as Map)['beforeEntryId'] is String
                ? (map['history'] as Map)['beforeEntryId'] as String
                : null,
          );
        },
        onSnapshot: (snapshot) {
          Connection.instance.applyChatSnapshot(
            remote,
            conversationId,
            seq: snapshot.seq,
            running: snapshot.running,
            pendingUi: snapshot.pendingUi,
          );
          final next = <ChatMessage>[];
          for (final value in snapshot.messages ?? const <Object?>[]) {
            next.add(ChatMessage.fromJson(value));
          }
          if (snapshot.messageMode == 'tail' &&
              snapshot.messageAnchorId != null) {
            final merged = mergeMessageTail(
              List<ChatMessage>.from(_messages),
              next,
              snapshot.messageAnchorId!,
            );
            _setMessages(merged ?? next);
          } else {
            _setMessages(next);
          }
          if (snapshot.messageMode != 'tail') {
            pager.replace(snapshot.historyBeforeEntryId);
            _fullRead = false;
            // Warm the adjacent page after first paint; further pages are fetched before
            // they enter view, with no extra controls or rows in the transcript.
            if (pager.cursor != null) {
              Timer(const Duration(milliseconds: 300), pager.prefetch);
            }
          }
          _applyQueue(snapshot.queue);
          _restored = true;
        },
        onEvent: applyEvent,
        onError: (error) {
          if (!cancelled) toastFailure(error, t('chat.loadFailed'));
        },
        onRestored: (replayed) {
          _restored = true;
          recordConnectionDiagnostic(
            Diagnostic.metric(
              'resume',
              elapsedMs: DateTime.now().millisecondsSinceEpoch - started,
              outcome: replayed ? 'replay' : 'snapshot',
            ),
          );
        },
      ),
    );

    pager = HistoryPager<ChatMessage>(
      HistoryPagerOptions<ChatMessage>(
        cursor: _historyCursor,
        load: (beforeEntryId) async {
          final page = await remote.call(
            'engine:get-messages-page',
            <String, Object?>{
              'conversationId': conversationId,
              'beforeEntryId': beforeEntryId,
              'turnLimit': 12,
              'toolDetail': 'summary',
            },
          );
          if (page is! Map ||
              page['conversationId'] != conversationId ||
              page['messages'] is! List ||
              page['reset'] is! bool) {
            throw StateError(t('chat.loadFailed'));
          }
          return HistoryPage<ChatMessage>(
            messages: <ChatMessage>[
              for (final value in page['messages'] as List)
                ChatMessage.fromJson(value),
            ],
            beforeEntryId: beforeEntryId,
            nextBeforeEntryId: page['nextBeforeEntryId'] is String
                ? page['nextBeforeEntryId'] as String
                : null,
            reset: page['reset'] as bool,
          );
        },
        prepend: (older, cursor) {
          final merged = prependHistory(
            List<ChatMessage>.from(_messages),
            older,
            cursor,
          );
          if (merged == null) return false;
          _setMessages(merged);
          return true;
        },
        cursorChanged: (cursor) => _historyCursor = cursor,
        reset: () async {
          _fullRead = true;
          await sync.refresh();
        },
      ),
    );

    _pager = pager;
    _sync = sync;

    _eventListener = (event, meta) {
      if (!cancelled && event['conversationId'] == conversationId) {
        sync.receive(event, meta);
      }
    };
    Connection.instance.onEngineEvent(_eventListener!);

    final seed = _checkpoint;
    final usableSeed =
        !conversationId.startsWith('remote:') &&
            remote.supportsConversationResume &&
            seed != null &&
            seed.cursor.epoch == remote.epoch
        ? seed
        : null;
    sync
        .restore(usableSeed)
        .catchError((Object error) {
          if (!cancelled) toastFailure(error, t('chat.loadFailed'));
        })
        .whenComplete(() {
          if (!cancelled && mounted) setState(() => _loading = false);
        });
    _syncServerId = serverId;
  }

  String? _syncServerId;

  void _teardownSync() {
    final sync = _sync;
    final pager = _pager;
    if (sync != null && _syncServerId != null) {
      _checkpoint = sync.checkpoint();
    }
    sync?.dispose();
    pager?.dispose();
    _cancelScope?.call();
    _cancelScope = null;
    if (_eventListener != null) {
      Connection.instance.offEngineEvent(_eventListener!);
    }
    _eventListener = null;
    if (_syncConversationId != null) {
      _syncScopeRemote?.unsubscribe(['conversation:$_syncConversationId']);
    }
    _syncScopeRemote = null;
    _syncConversationId = null;
    _sync = null;
    _pager = null;
  }

  Future<void> _reload([int? afterSeq]) async {
    final sync = _sync;
    if (sync == null) return;
    try {
      await sync.refresh(afterSeq);
    } catch (_) {
      // A failed refresh leaves what is on screen; the banner says we are reconnecting.
    }
  }

  void _applyQueue(Object? value) {
    if (!mounted) return;
    final next = mergeQueue(_queue, value);
    if (identical(next, _queue)) return;
    setState(() => _queue = next);
  }

  // ---- actions ---------------------------------------------------------------------

  Future<void> _send() async {
    final text = _draft.text.trim();
    final selected = _images;
    final remote = _remote;
    final queueLoading = _queue.revision < 0 || !_restored;
    if ((text.isEmpty && selected.isEmpty) ||
        remote == null ||
        shouldHoldSend(
          sending: _submitting != null,
          queueLoading: queueLoading,
        )) {
      return;
    }
    // Captured before the first await: a Stop during record-prompt must keep this send
    // queued, and the decision cannot be re-read afterwards.
    final enqueue = shouldQueueMessage(_running, _queue);
    final conversationId = _conversationId;
    final reservation = Object();
    bool current() =>
        mounted &&
        _conversationId == conversationId &&
        identical(_submitting, reservation);
    _submitting = reservation;
    final localId = 'local-${DateTime.now().microsecondsSinceEpoch}';
    setState(() => _sending = true);
    _draftTouched = true;
    _draft.text = '';
    final images = _images;
    setState(() => _images = <ComposerImage>[]);
    final serverId = _serverId;
    if (serverId != null) writeDraft(serverId, _conversationId, '');
    try {
      final next = await submitMessage(
        remote,
        conversationId: _conversationId,
        text: text,
        images: selected.map(promptImage).toList(),
        enqueue: enqueue,
        previous: _chat == null
            ? null
            : (title: _chat!.title, preview: _chat!.preview),
        onPrompt: () {
          if (!current()) return;
          _setMessages(<ChatMessage>[
            ..._messages,
            ChatMessage(
              id: localId,
              role: 'user',
              text: text,
              parts: <MessagePart>[TextPart(text)],
              attachments: <ChatAttachment>[
                for (var index = 0; index < selected.length; index++)
                  ChatAttachment(
                    id: selected[index].id,
                    kind: 'image',
                    name: 'image-${index + 1}',
                    mimeType: selected[index].mimeType,
                    dataUrl: selected[index].uri,
                  ),
              ],
            ),
          ]);
        },
      );
      if (current() && next != null) _applyQueue(next);
    } catch (error) {
      if (!current()) return;
      if (error is! SubmissionUncertainError) {
        _setMessages(_messages.where((item) => item.id != localId).toList());
        _draft.text = _draft.text.isEmpty ? text : '$text\n\n${_draft.text}';
        setState(
          () => _images = [
            ...images,
            ..._images,
          ].take(maxComposerImages).toList(),
        );
      } else {
        // The outcome is unknown, not a refusal: keep the row and re-read.
        await _reload();
      }
      if (error is SubmissionUncertainError) {
        toastError(error.message);
      } else {
        toastFailure(error, t('chat.sendFailed'));
      }
    } finally {
      if (current()) {
        _submitting = null;
        setState(() => _sending = false);
      }
    }
  }

  Future<void> _runAction(String method) async {
    if (!_connected) return;
    try {
      await _remote?.call(method, {'conversationId': _conversationId});
    } catch (error) {
      toastFailure(error, t('common.operationFailed'));
    }
  }

  Future<void> _changeQueue(String method, [String? id]) async {
    final remote = _remote;
    if (remote == null) return;
    try {
      final next = await remote.call(
        method,
        id != null
            ? <String, Object?>{'id': id}
            : <String, Object?>{'conversationId': _conversationId},
      );
      if (next != null) _applyQueue(next);
    } catch (error) {
      toastFailure(error, t('chat.queueUpdateFailed'));
    }
  }

  Future<void> _respond(Map<String, Object?> payload) async {
    final remote = _remote;
    if (remote == null || !_restored) return;
    setState(() => _responding = true);
    try {
      await remote.call('engine:permission-respond', payload);
      final id = payload['id'];
      if (id is String) Connection.instance.resolvePendingPrompt(id);
    } catch (error) {
      toastFailure(error, t('chat.respondFailed'));
    } finally {
      if (mounted) setState(() => _responding = false);
    }
  }

  /// The chat's actions, as the bar's ⋯ pull-down menu (`UIBarButtonItem.menu`).
  List<Widget> _menuItems(CatalogConversation chat) {
    Widget item(
      String label,
      List<List<dynamic>> icon,
      VoidCallback onTap, {
      bool destructive = false,
    }) => GlassMenuItem(
      title: label,
      icon: HugeIcon(icon: icon, size: 18),
      isDestructive: destructive,
      onTap: onTap,
    );
    return <Widget>[
      item(t('common.rename'), AppIcons.pencilEdit, () => _rename(chat)),
      item(t('chat.copyAll'), AppIcons.copy, _copyAll),
      item(t('common.archive'), AppIcons.archive, () async {
        final done = await archiveConversation(chat.id, running: _running);
        if (done && mounted) context.pop();
      }),
      const GlassMenuDivider(),
      item(
        t('common.delete'),
        AppIcons.delete,
        () => _confirmDelete(chat),
        destructive: true,
      ),
    ];
  }

  Future<void> _rename(CatalogConversation chat) async {
    final next = await AppDialog.prompt(
      context,
      title: t('common.renameChat'),
      initial: chat.title,
    );
    if (next == null) return;
    final title = next.trim();
    if (title.isEmpty || title == chat.title) return;
    await renameConversation(chat.id, title);
  }

  Future<void> _confirmDelete(CatalogConversation chat) async {
    final confirmed = await AppDialog.confirm(
      context,
      title: t('server.deleteChatTitle'),
      message: t(
        'server.deleteChatBody',
        vars: <String, Object?>{'title': chat.title},
      ),
      confirmLabel: t('common.delete'),
      destructive: true,
    );
    if (!confirmed) return;
    final done = await deleteConversation(chat.id);
    if (done && mounted) context.pop();
  }

  /// Copy All must never silently copy just the visible history window, so the pager is
  /// drained first.
  Future<void> _copyAll() async {
    try {
      if (_loading && _messages.isEmpty) await _reload();
      if (_historyCursor != null) await _pager?.loadAll();
      final transcript = _messages
          .where(
            (message) =>
                message.kind != 'compact' &&
                stripImageDimensionNote(message.text).trim().isNotEmpty,
          )
          .map(
            (message) =>
                '${message.role == 'user' ? t('common.me') : 'FastVibe'}:\n${stripImageDimensionNote(message.text).trim()}',
          )
          .join('\n\n');
      await copyToClipboard(transcript);
      toastSuccess(t('toast.chatCopied'));
    } catch (error) {
      toastFailure(error, t('chat.loadFailed'));
    }
  }

  /// A long press on a message: the iOS context menu where the finger is.
  Future<void> _messageAction(ChatMessage message) async {
    showContextMenu(
      context,
      contextMenuItems(<SheetOption>[
        SheetOption(
          value: 'copy',
          label: t('common.copy'),
          icon: AppIcons.copy,
          onSelect: () async {
            await copyToClipboard(stripImageDimensionNote(message.text).trim());
            toastSuccess(t('toast.copied'));
          },
        ),
        if (message.role == 'user')
          SheetOption(
            value: 'reuse',
            label: t('chat.reuse'),
            icon: AppIcons.pencilEdit,
            onSelect: () =>
                _draft.text = stripImageDimensionNote(message.text).trim(),
          ),
      ]),
    );
  }

  @override
  Widget build(BuildContext context) {
    final connection = Connection.instance;
    final chat = _chat;
    final prompt = _prompt;
    final running = _running;
    final workingSince =
        currentRunStartedAt(_messages) ??
        connection.runningSince[_conversationId];
    _footers = completedTurnFooters(_messages, running, _footers);
    final merged = mergeReplies(
      List<ChatMessage>.from(_messages),
      _replyCache,
    ).reversed.toList();
    final last = _messages.isEmpty ? null : _messages.last;
    final canContinue =
        !running &&
        (last?.error != null ||
            last?.stop == 'aborted' ||
            last?.stop == 'length');
    final empty = !_loading && _messages.isEmpty && !running;

    return GlassScreen(
      title: chat?.title ?? t('common.conversation', context: context),
      subtitle: _projectName,
      actions: <Widget>[
        if (chat != null)
          GlassMenuAction(
            icon: AppIcons.moreHorizontal,
            tooltip: t('server.chatActions', context: context),
            items: _menuItems(chat),
          ),
      ],
      // The transcript runs under the glass bar and under the footer, dissolving into the
      // page at both (a scroll view under an iOS 26 bar and a floating input), rather than
      // being cut off at their edges. It pads itself by how far each reaches.
      fadeBottom: false,
      topScrim: false,
      body: Builder(
        builder: (context) {
          final insets = GlassInsets.maybeOf(context);
          final top = insets?.top ?? 0;
          return LayoutBuilder(
            builder: (context, constraints) => Stack(
              children: <Widget>[
                Positioned.fill(
                  child: Column(
                    children: <Widget>[
                      if (_dag != null)
                        Padding(
                          padding: EdgeInsets.only(top: top),
                          child: MobileDagSummary(watcher: _dag!),
                        ),
                      Expanded(
                        child: _loading
                            ? BrandLoading(
                                message: t('chat.loading', context: context),
                              )
                            : empty
                            ? _Welcome(
                                projectName: _projectName,
                                topInset: _dag != null ? 0 : top,
                                bottomInset: _footerHeight,
                                onPick: (text) => _draft.text = text,
                              )
                            : TranscriptView(
                                messages: merged,
                                footers: _footers,
                                running: running,
                                waiting: prompt != null,
                                workingSince: workingSince,
                                now: _now,
                                topInset: _dag != null ? 0 : top,
                                bottomInset: _footerHeight,
                                onLongPress: _messageAction,
                                onOlder: () => _pager?.prefetch(),
                                dagWatcher: _dag,
                              ),
                      ),
                    ],
                  ),
                ),
                Positioned(
                  left: 0,
                  right: 0,
                  bottom: 0,
                  child: _FooterFrame(
                    palette: paletteOf(context),
                    onHeight: (height) {
                      if ((height - _footerHeight).abs() > 0.5) {
                        setState(() => _footerHeight = height);
                      }
                    },
                    child: ConstrainedBox(
                      constraints: BoxConstraints(
                        maxHeight: constraints.maxHeight * 0.68,
                      ),
                      child: SingleChildScrollView(
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            if (connection.reconnecting ||
                                (!_loading && !_connected))
                              _ReconnectBanner(
                                onRetry: () {
                                  Haptic.tap();
                                  if (_remote != null) {
                                    _reload();
                                  } else {
                                    connection.reconnectNow();
                                  }
                                },
                              ),
                            if (_queue.items.isNotEmpty)
                              QueuePanel(
                                queue: _queue,
                                disabled: !_connected,
                                onCancel: (id) =>
                                    _changeQueue('engine:queue-cancel', id),
                                onResume: () =>
                                    _changeQueue('engine:queue-resume'),
                              ),
                            if (prompt != null)
                              Padding(
                                padding: EdgeInsets.fromLTRB(
                                  10,
                                  4,
                                  10,
                                  MediaQuery.paddingOf(context).bottom + 8,
                                ),
                                child: PromptCard(
                                  key: ValueKey<String>(prompt.id),
                                  prompt: prompt,
                                  busy: _responding,
                                  onRespond: _respond,
                                ),
                              )
                            else
                              Composer(
                                conversationId: _conversationId,
                                running: running,
                                sending: _sending,
                                queueing: running || _queue.items.isNotEmpty,
                                disabled: !_connected || _queue.revision < 0,
                                draft: _draft,
                                images: _images,
                                onImagesChange: (value) =>
                                    setState(() => _images = value),
                                onDraftChange: (_) => setState(() {}),
                                onSend: _send,
                                onAbort: () => _runAction('engine:abort'),
                                onContinue: () => _runAction('engine:continue'),
                                canContinue: canContinue,
                              ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}

/// The footer over the transcript: a soft scrim so text scrolling beneath does not show
/// through the gaps around the composer, and a report of its own height so the transcript
/// can pad its end by exactly that.
class _FooterFrame extends StatefulWidget {
  const _FooterFrame({
    required this.palette,
    required this.onHeight,
    required this.child,
  });

  final Palette palette;
  final ValueChanged<double> onHeight;
  final Widget child;

  @override
  State<_FooterFrame> createState() => _FooterFrameState();
}

class _FooterFrameState extends State<_FooterFrame> {
  final GlobalKey _key = GlobalKey();

  void _report() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final box = _key.currentContext?.findRenderObject();
      if (!mounted || box is! RenderBox || !box.hasSize) return;
      widget.onHeight(box.size.height);
    });
  }

  @override
  Widget build(BuildContext context) {
    _report();
    final background = widget.palette.background;
    return Stack(
      clipBehavior: Clip.none,
      children: <Widget>[
        // Reaches above the footer so the fade starts before the composer's edge.
        Positioned(
          left: 0,
          right: 0,
          top: -28,
          bottom: 0,
          child: IgnorePointer(
            child: DecoratedBox(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  stops: const <double>[0, 0.4, 1],
                  colors: <Color>[
                    background.withValues(alpha: 0),
                    background.withValues(alpha: 0.86),
                    background.withValues(alpha: 0.96),
                  ],
                ),
              ),
            ),
          ),
        ),
        KeyedSubtree(key: _key, child: widget.child),
      ],
    );
  }
}

/// The empty state: the mark, a question, and four things worth trying.
class _Welcome extends StatelessWidget {
  const _Welcome({
    required this.projectName,
    required this.onPick,
    this.topInset = 0,
    this.bottomInset = 0,
  });

  final String? projectName;
  final double topInset;
  final double bottomInset;
  final ValueChanged<String> onPick;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    final suggestions = <(List<List<dynamic>>, String)>[
      (AppIcons.idea, t('chat.suggest1', context: context)),
      (AppIcons.bug, t('chat.suggest2', context: context)),
      (AppIcons.testTube, t('chat.suggest3', context: context)),
      (AppIcons.code, t('chat.suggest4', context: context)),
    ];
    return SingleChildScrollView(
      padding: EdgeInsets.fromLTRB(24, 32 + topInset, 24, 32 + bottomInset),
      child: Column(
        children: <Widget>[
          const SizedBox(height: 24),
          const BrandLogo(size: 64),
          const SizedBox(height: 10),
          Text(
            t('chat.welcomeTitle', context: context),
            textAlign: TextAlign.center,
            style: TextStyle(
              color: palette.text,
              fontSize: 22,
              fontWeight: FontWeight.w800,
              letterSpacing: -0.4,
            ),
          ),
          const SizedBox(height: 8),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 300),
            child: Text(
              '${projectName != null ? t('chat.welcomeInProject', vars: <String, Object?>{'project': projectName}, context: context) : ''}${t('chat.welcomeBody', context: context)}',
              textAlign: TextAlign.center,
              style: TextStyle(
                color: palette.muted,
                fontSize: 14,
                height: 21 / 14,
              ),
            ),
          ),
          const SizedBox(height: 18),
          for (final suggestion in suggestions)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Material(
                color: palette.card,
                borderRadius: BorderRadius.circular(Radii.lg),
                child: InkWell(
                  onTap: () {
                    Haptic.select();
                    onPick(suggestion.$2);
                  },
                  borderRadius: BorderRadius.circular(Radii.lg),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 12,
                    ),
                    child: Row(
                      children: <Widget>[
                        Container(
                          width: 32,
                          height: 32,
                          decoration: BoxDecoration(
                            color: palette.accentSoft,
                            borderRadius: BorderRadius.circular(10),
                          ),
                          child: Center(
                            child: HugeIcon(
                              icon: suggestion.$1,
                              size: 16,
                              color: palette.accent,
                              strokeWidth: 2,
                            ),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Text(
                            suggestion.$2,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              color: palette.text,
                              fontSize: 15,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _ReconnectBanner extends StatelessWidget {
  const _ReconnectBanner({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    return Container(
      margin: const EdgeInsets.fromLTRB(10, 0, 10, 6),
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 8),
      decoration: BoxDecoration(
        color: palette.warningSoft,
        borderRadius: BorderRadius.circular(Radii.md),
        border: Border.all(color: palette.warning, width: 0.5),
      ),
      child: Row(
        children: <Widget>[
          DesktopSpinner(size: 14, color: palette.warning),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              t('chat.reconnecting', context: context),
              style: TextStyle(
                color: palette.text,
                fontSize: 13,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          GestureDetector(
            onTap: onRetry,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 3),
              child: Text(
                t('chat.reconnect', context: context),
                style: TextStyle(
                  color: palette.warning,
                  fontSize: 13,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
