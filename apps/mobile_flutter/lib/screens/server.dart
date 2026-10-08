import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:hugeicons/hugeicons.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';

import '../chat/draft_storage.dart';
import '../chat/option_sheet.dart';
import '../chat/turn_meta.dart';
import '../i18n/core.dart';
import '../session/catalog.dart';
import '../session/connection.dart';
import '../session/conversation_actions.dart';
import '../storage/servers.dart';
import '../theme/theme.dart';
import '../ui/feedback.dart';
import '../ui/glass_screen.dart';
import '../ui/icons.dart';
import '../ui/kit.dart';
import '../ui/preferences.dart';

/// The sheet's value for 「no project filter」; a cwd can never be empty.
const String _allProjects = '';

/// One machine's conversations: 等你处理, 运行中, 最近, plus search, a project filter,
/// the archive list and 新对话.
class ServerScreen extends StatefulWidget {
  const ServerScreen({super.key, required this.serverId});

  final String serverId;

  @override
  State<ServerScreen> createState() => _ServerScreenState();
}

class _ServerScreenState extends State<ServerScreen> {
  final TextEditingController _query = TextEditingController();
  SavedServer? _server;
  bool _loaded = false;
  String _password = '';
  Map<String, String?> _hits = <String, String?>{};
  String? _project;
  bool _creating = false;
  Timer? _searchTimer;

  @override
  void initState() {
    super.initState();
    _query.addListener(_onQueryChanged);
    Connection.instance.addListener(_onConnection);
    _load();
  }

  @override
  void dispose() {
    _query.removeListener(_onQueryChanged);
    _query.dispose();
    Connection.instance.removeListener(_onConnection);
    _searchTimer?.cancel();
    super.dispose();
  }

  void _onConnection() {
    if (mounted) setState(() {});
  }

  Future<void> _load() async {
    setState(() => _loaded = false);
    try {
      final servers = await ServerStore.instance.load();
      if (!mounted) return;
      final found = servers.where((item) => item.id == widget.serverId).firstOrNull;
      setState(() {
        _server = found;
        _loaded = true;
      });
      if (found == null) return;
      final connection = Connection.instance;
      if (connection.server?.id == found.id &&
          (connection.status == ConnectionStatus.ready || connection.status == ConnectionStatus.connecting)) {
        return;
      }
      await connection.connectSaved(found);
    } catch (error) {
      if (!mounted) return;
      setState(() => _loaded = true);
      toastFailure(error, t('devices.loadFailed'));
    }
  }

  /// Titles and previews match on the phone; the transcript itself is searched on the
  /// machine, which is the only place that holds it.
  void _onQueryChanged() {
    setState(() {});
    _searchTimer?.cancel();
    final needle = _query.text.trim();
    if (needle.length < 2 || !_ready) {
      setState(() => _hits = <String, String?>{});
      return;
    }
    _searchTimer = Timer(const Duration(milliseconds: 280), () async {
      final remote = Connection.instance.client;
      if (remote == null) return;
      try {
        final result = await remote.call('conversations:search', <String, Object?>{'query': needle});
        if (!mounted || result is! List) return;
        final next = <String, String?>{};
        for (final hit in result) {
          if (hit is! Map || hit['id'] is! String) continue;
          next[hit['id'] as String] = hit['snippet'] is String ? hit['snippet'] as String : null;
        }
        setState(() => _hits = next);
      } catch (_) {
        // A failed search leaves the local matches, which is what the phone can see.
      }
    });
  }

  bool get _ready => Connection.instance.status == ConnectionStatus.ready &&
      Connection.instance.server?.id == widget.serverId;

  List<CatalogConversation> get _listed => visibleConversations(
        conversations: Connection.instance.conversations,
        archivedIds: Connection.instance.archivedIds.toSet(),
        running: Connection.instance.running.keys.toSet(),
      );

  List<CatalogConversation> get _archived {
    final archivedIds = Connection.instance.archivedIds.toSet();
    final rows = Connection.instance.conversations
        .where((item) => item.kind != 'side-chat' && archivedIds.contains(item.id))
        .toList();
    rows.sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
    return rows;
  }

  Map<String, String> get _projectNames =>
      <String, String>{for (final project in Connection.instance.projects) project.cwd: project.name};

  Future<void> _createChat(String selectedProject) async {
    final remote = Connection.instance.client;
    if (remote == null || _creating) return;
    setState(() => _creating = true);
    try {
      // Match the desktop draft rule: if this project already has an empty chat with text
      // typed into it, 新对话 returns to that chat instead of losing the draft.
      final serverId = Connection.instance.server?.id;
      if (serverId != null) {
        final drafts = await listDrafts(serverId);
        for (final draft in drafts) {
          CatalogConversation? chat;
          for (final item in Connection.instance.conversations) {
            if (item.id == draft.conversationId) {
              chat = item;
              break;
            }
          }
          if (chat != null && (chat.preview == null || chat.preview!.isEmpty) && (chat.project ?? '') == selectedProject) {
            if (mounted) context.push('/chat/${draft.conversationId}');
            return;
          }
        }
      }
      final result = await remote.call('conversations:create', <String, Object?>{
        'project': selectedProject.isEmpty ? null : selectedProject,
        'activate': false,
        'reuseEmpty': false,
      });
      if (result is Map && result['conversation'] is Map) {
        final id = (result['conversation'] as Map)['id'];
        if (id is String && mounted) context.push('/chat/$id');
      }
    } catch (error) {
      toastFailure(error, t('server.createFailed'));
    } finally {
      if (mounted) setState(() => _creating = false);
    }
  }

  void _startChat() {
    Haptic.tap();
    // Nothing to choose between: go straight to the chat.
    if (Connection.instance.projects.isEmpty) {
      unawaited(_createChat(_allProjects));
      return;
    }
    final projects = orderProjectsByRecentUse(Connection.instance.projects, Connection.instance.conversations);
    showOptionSheet(
      context,
      title: t('common.newChat'),
      subtitle: t('server.whichProject'),
      value: _project ?? _allProjects,
      options: <SheetOption>[
        SheetOption(
          value: _allProjects,
          label: t('common.noProject'),
          description: t('common.useScratchWorkspace'),
          icon: AppIcons.bubbleChat,
          onSelect: () => _createChat(_allProjects),
        ),
        for (final project in projects)
          SheetOption(
            value: project.cwd,
            label: project.name,
            description: project.cwd,
            avatar: project.name,
            onSelect: () => _createChat(project.cwd),
          ),
      ],
    );
  }

  void _openMenu(CatalogConversation chat) {
    Haptic.press();
    final names = _projectNames;
    showOptionSheet(
      context,
      title: chat.title,
      subtitle: chat.project != null ? names[chat.project] : null,
      options: <SheetOption>[
        SheetOption(
          value: 'rename',
          label: t('common.rename'),
          icon: AppIcons.pencilEdit,
          onSelect: () => _rename(chat),
        ),
        SheetOption(
          value: 'archive',
          label: t('common.archive'),
          icon: AppIcons.archive,
          onSelect: () => archiveConversation(chat.id, running: Connection.instance.running[chat.id] == true),
        ),
        SheetOption(
          value: 'delete',
          label: t('common.delete'),
          icon: AppIcons.delete,
          destructive: true,
          onSelect: () => _confirmDelete(chat),
        ),
      ],
    );
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
      message: t('server.deleteChatBody', <String, Object?>{'title': chat.title}),
      confirmLabel: t('common.delete'),
      destructive: true,
    );
    if (!confirmed) return;
    await deleteConversation(chat.id);
  }

  Future<void> _refresh() async {
    try {
      await Connection.instance.refreshConnection();
    } catch (_) {
      // A failed refresh leaves the last list; the header says whether we are connected.
    } finally {

    }
  }

  void _openArchiveSheet() {
    Haptic.tap();
    final names = _projectNames;
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: Colors.transparent,
      builder: (sheetContext) {
        final palette = paletteOf(sheetContext);
        final rows = _archived;
        return Container(
          decoration: BoxDecoration(
            color: palette.card,
            borderRadius: const BorderRadius.vertical(top: Radius.circular(Radii.xl)),
          ),
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
          child: SafeArea(
            top: false,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  t('server.archived'),
                  style: TextStyle(color: palette.text, fontSize: 18, fontWeight: FontWeight.w700, letterSpacing: -0.3),
                ),
                const SizedBox(height: 2),
                Text(
                  t('common.chatCount', <String, Object?>{'count': rows.length}),
                  style: TextStyle(color: palette.muted, fontSize: 13),
                ),
                const SizedBox(height: 12),
                Flexible(
                  child: rows.isEmpty
                      ? Padding(
                          padding: const EdgeInsets.symmetric(vertical: 24),
                          child: Center(child: Text(t('server.noArchived'), style: TextStyle(color: palette.muted))),
                        )
                      : ListView.separated(
                          shrinkWrap: true,
                          itemCount: rows.length,
                          separatorBuilder: (_, _) => const SizedBox(height: 8),
                          itemBuilder: (context, index) {
                            final chat = rows[index];
                            final project = chat.project != null ? names[chat.project] : null;
                            return Container(
                              padding: const EdgeInsets.fromLTRB(14, 10, 8, 10),
                              decoration: BoxDecoration(
                                color: palette.background,
                                borderRadius: BorderRadius.circular(Radii.md),
                              ),
                              child: Row(
                                children: <Widget>[
                                  Expanded(
                                    child: GestureDetector(
                                      onTap: () {
                                        Navigator.of(sheetContext).pop();
                                        context.push('/chat/${chat.id}');
                                      },
                                      behavior: HitTestBehavior.opaque,
                                      child: Column(
                                        crossAxisAlignment: CrossAxisAlignment.start,
                                        children: <Widget>[
                                          Text(
                                            chat.title,
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                            style: TextStyle(color: palette.text, fontSize: 15, fontWeight: FontWeight.w600),
                                          ),
                                          const SizedBox(height: 2),
                                          Text(
                                            <String>[
                                              ?project,
                                              relativeTime(chat.updatedAt),
                                            ].join(' · '),
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                            style: TextStyle(color: palette.muted, fontSize: 12),
                                          ),
                                        ],
                                      ),
                                    ),
                                  ),
                                  GestureDetector(
                                    onTap: () async {
                                      Navigator.of(sheetContext).pop();
                                      await unarchiveConversation(chat.id);
                                    },
                                    child: Container(
                                      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 7),
                                      decoration: BoxDecoration(
                                        color: palette.accentSoft,
                                        borderRadius: BorderRadius.circular(Radii.pill),
                                      ),
                                      child: Row(
                                        children: <Widget>[
                                          HugeIcon(icon: AppIcons.archiveRestore, size: 15, color: palette.accent),
                                          const SizedBox(width: 4),
                                          Text(
                                            t('common.restore'),
                                            style: TextStyle(color: palette.accent, fontSize: 13, fontWeight: FontWeight.w700),
                                          ),
                                        ],
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            );
                          },
                        ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    final connection = Connection.instance;
    final status = connection.server?.id != widget.serverId
        ? null
        : switch (connection.status) {
            ConnectionStatus.connecting => (t('server.statusConnecting'), palette.warning, palette.warningSoft),
            ConnectionStatus.error => (t('server.statusOffline'), palette.danger, palette.dangerSoft),
            ConnectionStatus.ready when connection.reconnecting =>
              (t('server.statusReconnecting'), palette.warning, palette.warningSoft),
            ConnectionStatus.ready => (t('server.statusConnected'), palette.success, palette.successSoft),
            _ => null,
          };

    return GlassScreen(
      title: _server?.alias ?? t('common.device'),
      // The connection state belongs in the bar: it is the answer to the question a
      // failed call raises, and a row of its own would be read after the error.
      subtitle: status?.$1,
      actions: <Widget>[
        if (status != null)
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: Container(
              width: 9,
              height: 9,
              decoration: BoxDecoration(color: status.$2, shape: BoxShape.circle),
            ),
          ),
      ],
      body: _body(palette),
      floatingAction: _ready
          ? GlassButton.custom(
              onTap: _creating ? () {} : _startChat,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    if (_creating)
                      const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                    else
                      HugeIcon(icon: AppIcons.chatAdd, size: 20, color: palette.text),
                    const SizedBox(width: 8),
                    Text(
                      t('common.newChat'),
                      style: TextStyle(color: palette.text, fontSize: 16, fontWeight: FontWeight.w700),
                    ),
                  ],
                ),
              ),
            )
          : null,
    );
  }

  Widget _body(Palette palette) {
    final connection = Connection.instance;
    if (!_loaded) {
      return BrandLoading(message: t('server.loadingDevice'));
    }
    if (_server == null) {
      return EmptyState(icon: AppIcons.alert, title: t('server.notFound'), body: t('server.notFoundBody'));
    }
    if (connection.status == ConnectionStatus.connecting && connection.server?.id == widget.serverId) {
      return BrandLoading(message: t('server.connectingTo', <String, Object?>{'host': _server!.host}));
    }
    if (connection.server?.id == widget.serverId && connection.status == ConnectionStatus.error) {
      return _Failure(palette: palette, server: _server!, password: _password, onPassword: (value) => setState(() => _password = value));
    }
    if (!_ready) return const SizedBox.shrink();
    return _readyBody(palette);
  }

  Widget _readyBody(Palette palette) {
    final connection = Connection.instance;
    final names = _projectNames;
    final listed = _listed;
    final needle = _query.text.trim().toLowerCase();
    final visible = listed.where((item) {
      if (_project != null && (item.project ?? '') != _project) return false;
      if (needle.isEmpty) return true;
      if (_hits.containsKey(item.id)) return true;
      final haystack = '${item.title} ${item.preview ?? ''} ${names[item.project ?? ''] ?? ''}'.toLowerCase();
      return haystack.contains(needle);
    }).toList();

    final projectCounts = <String, int>{};
    for (final chat in listed) {
      final project = chat.project;
      if (project == null || !names.containsKey(project)) continue;
      projectCounts[project] = (projectCounts[project] ?? 0) + 1;
    }

    final waiting = visible.where((item) => connection.waiting[item.id] == true).toList();
    final running = visible
        .where((item) => connection.waiting[item.id] != true && connection.running[item.id] == true)
        .toList();
    final recent = visible
        .where((item) => connection.waiting[item.id] != true && connection.running[item.id] != true)
        .toList();

    return Column(
      children: <Widget>[
        if (connection.reconnecting)
          Container(
            margin: const EdgeInsets.fromLTRB(16, 6, 16, 0),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(color: palette.warningSoft, borderRadius: BorderRadius.circular(Radii.md)),
            child: Row(
              children: <Widget>[
                DesktopSpinner(size: 14, color: palette.warning),
                const SizedBox(width: 8),
                Text(t('server.dropped'), style: TextStyle(color: palette.warning, fontSize: 13, fontWeight: FontWeight.w600)),
              ],
            ),
          ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 2),
          child: Row(
            children: <Widget>[
              Expanded(child: SearchField(controller: _query, placeholder: t('server.searchPlaceholder'))),
              if (projectCounts.isNotEmpty || _project != null) ...<Widget>[
                const SizedBox(width: 8),
                _ProjectFilter(
                  label: _project == null ? t('server.projectFilter') : (names[_project] ?? _project!),
                  active: _project != null,
                  palette: palette,
                  onPress: () => _pickProject(projectCounts, names),
                  onClear: () => setState(() => _project = null),
                ),
              ],
            ],
          ),
        ),
        Expanded(
          child: RefreshIndicator(
            onRefresh: _refresh,
            color: palette.accent,
            child: listed.isEmpty
                ? ListView(
                    children: <Widget>[
                      SizedBox(height: MediaQuery.sizeOf(context).height * 0.12),
                      EmptyState(
                        icon: AppIcons.bubbleChat,
                        title: t('server.emptyTitle'),
                        body: t('server.emptyBody'),
                        children: <Widget>[
                          const SizedBox(height: 14),
                          PrimaryButton(
                            label: t('server.startChat'),
                            icon: AppIcons.chatAdd,
                            busy: _creating,
                            onPressed: _startChat,
                          ),
                        ],
                      ),
                    ],
                  )
                : ListView(
                    padding: const EdgeInsets.fromLTRB(16, 2, 16, 96),
                    children: <Widget>[
                      if (waiting.isNotEmpty) ...<Widget>[
                        SectionLabel(title: t('server.waiting'), count: waiting.length),
                        for (final chat in waiting)
                          Padding(padding: const EdgeInsets.only(bottom: 8), child: _row(chat, palette, names, waiting: true)),
                      ],
                      if (running.isNotEmpty) ...<Widget>[
                        SectionLabel(title: t('server.running'), count: running.length),
                        for (final chat in running)
                          Padding(padding: const EdgeInsets.only(bottom: 8), child: _row(chat, palette, names, running: true)),
                      ],
                      if (recent.isNotEmpty) ...<Widget>[
                        SectionLabel(title: needle.isEmpty ? t('server.recent') : t('server.results'), count: recent.length),
                        for (final chat in recent)
                          Padding(padding: const EdgeInsets.only(bottom: 8), child: _row(chat, palette, names)),
                      ],
                      if (visible.isEmpty)
                        EmptyState(
                          icon: AppIcons.bubbleChat,
                          title: t('server.noMatchTitle'),
                          body: needle.isNotEmpty
                              ? t('server.noMatchQuery', <String, Object?>{'query': _query.text.trim()})
                              : t('server.noChatsInProject'),
                        ),
                      if (_archived.isNotEmpty && needle.isEmpty)
                        InkWell(
                          onTap: _openArchiveSheet,
                          child: Padding(
                            padding: const EdgeInsets.symmetric(vertical: 18, horizontal: 4),
                            child: Row(
                              children: <Widget>[
                                HugeIcon(icon: AppIcons.archive, size: 16, color: palette.muted),
                                const SizedBox(width: 6),
                                Text(
                                  t('server.archivedCount', <String, Object?>{'count': _archived.length}),
                                  style: TextStyle(color: palette.muted, fontSize: 14, fontWeight: FontWeight.w600),
                                ),
                                const SizedBox(width: 6),
                                HugeIcon(icon: AppIcons.arrowRight, size: 14, color: palette.subtle),
                              ],
                            ),
                          ),
                        ),
                    ],
                  ),
          ),
        ),
      ],
    );
  }

  void _pickProject(Map<String, int> projectCounts, Map<String, String> names) {
    showOptionSheet(
      context,
      title: t('server.filterByProject'),
      value: _project ?? _allProjects,
      options: <SheetOption>[
        SheetOption(
          value: _allProjects,
          label: t('server.allProjects'),
          description: t('common.chatCount', <String, Object?>{'count': _listed.length}),
          icon: AppIcons.folder,
          onSelect: () => setState(() => _project = null),
        ),
        for (final entry in projectCounts.entries)
          SheetOption(
            value: entry.key,
            label: names[entry.key] ?? entry.key,
            description: t('common.chatCount', <String, Object?>{'count': entry.value}),
            avatar: names[entry.key] ?? entry.key,
            onSelect: () => setState(() => _project = entry.key),
          ),
      ],
    );
  }

  Widget _row(
    CatalogConversation chat,
    Palette palette,
    Map<String, String> names, {
    bool waiting = false,
    bool running = false,
  }) {
    return _ConversationRow(
      conversation: chat,
      projectName: _project == null && chat.project != null ? names[chat.project] : null,
      snippet: _hits[chat.id],
      waiting: waiting,
      running: running,
      onTap: () {
        Haptic.tap();
        context.push('/chat/${chat.id}');
      },
      onLongPress: () => _openMenu(chat),
    );
  }
}

class _ConversationRow extends StatelessWidget {
  const _ConversationRow({
    required this.conversation,
    required this.projectName,
    required this.snippet,
    required this.waiting,
    required this.running,
    required this.onTap,
    required this.onLongPress,
  });

  final CatalogConversation conversation;

  /// Where a transcript search matched, shown in place of the preview.
  final String? snippet;
  final String? projectName;
  final bool waiting;
  final bool running;
  final VoidCallback onTap;
  final VoidCallback onLongPress;

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    return Material(
      color: palette.card,
      borderRadius: BorderRadius.circular(Radii.lg),
      child: InkWell(
        onTap: onTap,
        onLongPress: onLongPress,
        borderRadius: BorderRadius.circular(Radii.lg),
        child: Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(Radii.lg),
            border: Border.all(color: waiting ? palette.warning : Colors.transparent),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              if (waiting)
                Container(
                  width: 42,
                  height: 42,
                  decoration: BoxDecoration(color: palette.warningSoft, borderRadius: BorderRadius.circular(13)),
                  child: Center(child: HugeIcon(icon: AppIcons.alert, size: 20, color: palette.warning)),
                )
              else if (running)
                Container(
                  width: 42,
                  height: 42,
                  decoration: BoxDecoration(color: palette.accentSoft, borderRadius: BorderRadius.circular(13)),
                  child: Center(child: DesktopSpinner(size: 20, color: palette.accent)),
                )
              else if (projectName != null)
                Avatar(name: projectName!, size: 42, borderRadius: 13)
              else
                Container(
                  width: 42,
                  height: 42,
                  decoration: BoxDecoration(color: palette.field, borderRadius: BorderRadius.circular(13)),
                  child: Center(child: HugeIcon(icon: AppIcons.bubbleChat, size: 20, color: palette.muted)),
                ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Row(
                      children: <Widget>[
                        Expanded(
                          child: Text(
                            conversation.title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              color: palette.text,
                              fontSize: 16,
                              fontWeight: FontWeight.w700,
                              letterSpacing: -0.2,
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Text(
                          relativeTime(conversation.updatedAt),
                          style: TextStyle(color: palette.subtle, fontSize: 12, fontWeight: FontWeight.w500),
                        ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(
                      snippet ?? conversation.preview ?? t('server.noPreview'),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: palette.muted, fontSize: 14, height: 20 / 14),
                    ),
                    if (waiting || running || projectName != null) ...<Widget>[
                      const SizedBox(height: 6),
                      Wrap(
                        spacing: 6,
                        runSpacing: 4,
                        children: <Widget>[
                          if (waiting) Pill(label: t('server.waiting'), tone: PillTone.warning),
                          if (running) Pill(label: t('server.running'), tone: PillTone.accent),
                          if (projectName != null) Pill(label: projectName!, icon: AppIcons.folder),
                        ],
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The toolbar's project filter: one pill that opens a sheet, instead of a row of every
/// project.
class _ProjectFilter extends StatelessWidget {
  const _ProjectFilter({
    required this.label,
    required this.active,
    required this.palette,
    required this.onPress,
    required this.onClear,
  });

  final String label;
  final bool active;
  final Palette palette;
  final VoidCallback onPress;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    final tint = active ? palette.accent : palette.muted;
    return Container(
      width: 124,
      height: 40,
      padding: const EdgeInsets.symmetric(horizontal: 11),
      decoration: BoxDecoration(
        color: active ? palette.accentSoft : palette.field,
        borderRadius: BorderRadius.circular(Radii.md),
      ),
      child: Row(
        children: <Widget>[
          Expanded(
            child: GestureDetector(
              onTap: onPress,
              behavior: HitTestBehavior.opaque,
              child: Row(
                children: <Widget>[
                  HugeIcon(icon: AppIcons.folder, size: 16, color: tint),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: active ? palette.accent : palette.text, fontSize: 14, fontWeight: FontWeight.w600),
                    ),
                  ),
                  if (!active) HugeIcon(icon: AppIcons.arrowDown, size: 14, color: tint),
                ],
              ),
            ),
          ),
          if (active)
            GestureDetector(
              onTap: onClear,
              child: Padding(
                padding: const EdgeInsets.only(left: 4),
                child: HugeIcon(icon: AppIcons.cancel, size: 14, color: tint),
              ),
            ),
        ],
      ),
    );
  }
}

/// 需要重新登录 / 无法连接: the two ways a machine can fail to answer.
class _Failure extends StatefulWidget {
  const _Failure({
    required this.palette,
    required this.server,
    required this.password,
    required this.onPassword,
  });

  final Palette palette;
  final SavedServer server;
  final String password;
  final ValueChanged<String> onPassword;

  @override
  State<_Failure> createState() => _FailureState();
}

class _FailureState extends State<_Failure> {
  @override
  Widget build(BuildContext context) {
    final palette = widget.palette;
    final connection = Connection.instance;
    final needsPassword = connection.needsPassword;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Container(
              width: 68,
              height: 68,
              decoration: BoxDecoration(
                color: needsPassword ? palette.accentSoft : palette.dangerSoft,
                borderRadius: BorderRadius.circular(22),
              ),
              child: Center(
                child: HugeIcon(
                  icon: needsPassword ? AppIcons.lockPassword : AppIcons.wifiDisconnected,
                  size: 30,
                  color: needsPassword ? palette.accent : palette.danger,
                ),
              ),
            ),
            const SizedBox(height: 8),
            Text(
              needsPassword
                  ? t('server.needLogin')
                  : t('server.cannotConnect', <String, Object?>{'name': widget.server.alias}),
              textAlign: TextAlign.center,
              style: TextStyle(color: palette.text, fontSize: 19, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 8),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 320),
              child: Text(
                needsPassword
                    ? (connection.error ?? '')
                    : t('server.cannotConnectBody', <String, Object?>{
                        'error': (connection.error ?? t('server.connectFailed')).replaceAll(RegExp(r'[。.]$'), ''),
                        'host': widget.server.host,
                      }),
                textAlign: TextAlign.center,
                style: TextStyle(color: palette.muted, fontSize: 14, height: 21 / 14),
              ),
            ),
            const SizedBox(height: 24),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 320),
              child: Column(
                children: <Widget>[
                  if (needsPassword) ...<Widget>[
                    TextField(
                      onChanged: widget.onPassword,
                      obscureText: true,
                      style: TextStyle(color: palette.text, fontSize: 16),
                      decoration: InputDecoration(
                        hintText: t('add.passwordPlaceholder'),
                        filled: true,
                        fillColor: palette.card,
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(Radii.md),
                          borderSide: BorderSide.none,
                        ),
                      ),
                    ),
                    const SizedBox(height: 10),
                    SizedBox(
                      width: double.infinity,
                      child: PrimaryButton(
                        label: t('server.connect'),
                        enabled: widget.password.isNotEmpty,
                        onPressed: () => Connection.instance.loginSaved(widget.server, widget.password),
                      ),
                    ),
                  ] else
                    SizedBox(
                      width: double.infinity,
                      child: PrimaryButton(
                        label: t('server.reconnect'),
                        icon: AppIcons.refresh,
                        onPressed: () => Connection.instance.connectSaved(widget.server),
                      ),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
