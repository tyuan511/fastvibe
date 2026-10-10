import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:hugeicons/hugeicons.dart';
import 'package:liquid_glass_widgets/liquid_glass_widgets.dart';

import '../account/account.dart';
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
import '../ui/dock.dart';
import '../ui/icons.dart';
import '../ui/kit.dart';
import '../ui/sheet.dart';
import '../ui/preferences.dart';
import '../ui/context_menu.dart';

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

  /// Drives the large 会话 title's collapse into the bar, and owns the list's scroll controller.
  final GlassLargeTitleController _title = GlassLargeTitleController();
  SavedServer? _server;
  bool _loaded = false;
  String _password = '';
  Map<String, String?> _hits = <String, String?>{};
  String? _project;
  bool _creating = false;
  Timer? _searchTimer;
  int _queryRevision = 0;
  int _activity = 0;
  int _loadGeneration = 0;

  @override
  void initState() {
    super.initState();
    _query.addListener(_onQueryChanged);
    Connection.instance.addListener(_onConnection);
    _load();
  }

  @override
  void didUpdateWidget(ServerScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.serverId == widget.serverId) return;
    _query.clear();
    _project = null;
    _activity = 0;
    _password = '';
    _load();
  }

  @override
  void dispose() {
    _query.removeListener(_onQueryChanged);
    _query.dispose();
    _title.dispose();
    Connection.instance.removeListener(_onConnection);
    _searchTimer?.cancel();
    super.dispose();
  }

  void _onConnection() {
    if (mounted) setState(() {});
  }

  Future<void> _load() async {
    final generation = ++_loadGeneration;
    final serverId = widget.serverId;
    setState(() => _loaded = false);
    try {
      final servers = await ServerStore.instance.load();
      if (!mounted || generation != _loadGeneration) return;
      final found = servers.where((item) => item.id == serverId).firstOrNull;
      setState(() {
        _server = found;
        _loaded = true;
      });
      if (found == null) return;
      final connection = Connection.instance;
      if (connection.server?.id == found.id &&
          (connection.status == ConnectionStatus.ready ||
              connection.status == ConnectionStatus.connecting)) {
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
    final revision = ++_queryRevision;
    setState(() => _hits = {});
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
        final result = await remote.call(
          'conversations:search',
          <String, Object?>{'query': needle},
        );
        if (!mounted ||
            revision != _queryRevision ||
            Connection.instance.client != remote ||
            result is! List) {
          return;
        }
        final next = <String, String?>{};
        for (final hit in result) {
          if (hit is! Map || hit['id'] is! String) continue;
          next[hit['id'] as String] = hit['snippet'] is String
              ? hit['snippet'] as String
              : null;
        }
        setState(() => _hits = next);
      } catch (_) {
        // A failed search leaves the local matches, which is what the phone can see.
      }
    });
  }

  bool get _ready =>
      Connection.instance.status == ConnectionStatus.ready &&
      Connection.instance.server?.id == widget.serverId;

  List<CatalogConversation> get _listed => visibleConversations(
    conversations: Connection.instance.conversations,
    archivedIds: Connection.instance.archivedIds.toSet(),
    running: Connection.instance.running.keys.toSet(),
  );

  List<CatalogConversation> get _archived {
    final archivedIds = Connection.instance.archivedIds.toSet();
    final rows = Connection.instance.conversations
        .where(
          (item) => item.kind != 'side-chat' && archivedIds.contains(item.id),
        )
        .toList();
    rows.sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
    return rows;
  }

  /// The pages that have no large title of their own and so keep the bar's.
  bool get _showsBarTitle {
    if (!_loaded) return false;
    if (_server == null) return true;
    final connection = Connection.instance;
    return connection.server?.id == widget.serverId &&
        connection.status == ConnectionStatus.error;
  }

  /// How many of the visible chats each project holds — the filter's rows.
  Map<String, int> get _projectCounts {
    final names = _projectNames;
    final counts = <String, int>{};
    for (final chat in _listed) {
      final project = chat.project;
      if (project == null || !names.containsKey(project)) continue;
      counts[project] = (counts[project] ?? 0) + 1;
    }
    return counts;
  }

  Map<String, String> get _projectNames => <String, String>{
    for (final project in Connection.instance.projects)
      project.cwd: project.name,
  };

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
          if (chat != null &&
              (chat.preview == null || chat.preview!.isEmpty) &&
              (chat.project ?? '') == selectedProject) {
            if (mounted) context.push('/chat/${draft.conversationId}');
            return;
          }
        }
      }
      final result = await remote.call(
        'conversations:create',
        <String, Object?>{
          'project': selectedProject.isEmpty ? null : selectedProject,
          'activate': false,
          'reuseEmpty': false,
        },
      );
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
    final projects = orderProjectsByRecentUse(
      Connection.instance.projects,
      Connection.instance.conversations,
    );
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

  void _pickProject() {
    Haptic.tap();
    showOptionSheet(
      context,
      title: t('server.projectFilter', context: context),
      value: _project ?? _allProjects,
      options: <SheetOption>[
        SheetOption(
          value: _allProjects,
          label: t('server.allProjects', context: context),
          description: t('common.chatCount', vars: <String, Object?>{
            'count': _listed.length,
          }, context: context),
          icon: AppIcons.folder,
          onSelect: () => setState(() => _project = null),
        ),
        for (final entry in _projectCounts.entries)
          SheetOption(
            value: entry.key,
            label: _projectNames[entry.key] ?? entry.key,
            description: t('common.chatCount', vars: <String, Object?>{
              'count': entry.value,
            }, context: context),
            avatar: _projectNames[entry.key] ?? entry.key,
            onSelect: () => setState(() => _project = entry.key),
          ),
      ],
    );
  }

  void _openMenu(CatalogConversation chat) {
    // A long press opens the iOS context menu where the finger is.
    showContextMenu(
      context,
      contextMenuItems(<SheetOption>[
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
          onSelect: () => archiveConversation(
            chat.id,
            running: Connection.instance.running[chat.id] == true,
          ),
        ),
        SheetOption(
          value: 'delete',
          label: t('common.delete'),
          icon: AppIcons.delete,
          destructive: true,
          onSelect: () => _confirmDelete(chat),
        ),
      ]),
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
      message: t('server.deleteChatBody', vars: <String, Object?>{
        'title': chat.title,
      }),
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
    }
  }

  void _openArchiveSheet() {
    Haptic.tap();
    final names = _projectNames;
    showAppSheet<void>(
      context: context,
      height: 130.0 + _archived.length.clamp(1, 7) * 76,
      builder: (sheetContext) {
        final palette = paletteOf(sheetContext);
        final rows = _archived;
        return Padding(
          padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
          child: SafeArea(
            top: false,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                AppSheetHeader(
                  title: t('server.archived'),
                  subtitle: t('common.chatCount', vars: {'count': rows.length}),
                ),
                Flexible(
                  child: rows.isEmpty
                      ? Padding(
                          padding: const EdgeInsets.symmetric(vertical: 24),
                          child: Center(
                            child: Text(
                              t('server.noArchived'),
                              style: TextStyle(color: palette.muted),
                            ),
                          ),
                        )
                      : ListView.separated(
                          shrinkWrap: true,
                          itemCount: rows.length,
                          separatorBuilder: (_, _) => const SizedBox(height: 8),
                          itemBuilder: (context, index) {
                            final chat = rows[index];
                            final project = chat.project != null
                                ? names[chat.project]
                                : null;
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
                                        crossAxisAlignment:
                                            CrossAxisAlignment.start,
                                        children: <Widget>[
                                          Text(
                                            chat.title,
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                            style: TextStyle(
                                              color: palette.text,
                                              fontSize: 15,
                                              fontWeight: FontWeight.w600,
                                            ),
                                          ),
                                          const SizedBox(height: 2),
                                          Text(
                                            <String>[
                                              ?project,
                                              relativeTime(chat.updatedAt),
                                            ].join(' · '),
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                            style: TextStyle(
                                              color: palette.muted,
                                              fontSize: 12,
                                            ),
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
                                      padding: const EdgeInsets.symmetric(
                                        horizontal: 11,
                                        vertical: 7,
                                      ),
                                      decoration: BoxDecoration(
                                        color: palette.accentSoft,
                                        borderRadius: BorderRadius.circular(
                                          Radii.pill,
                                        ),
                                      ),
                                      child: Row(
                                        children: <Widget>[
                                          HugeIcon(
                                            icon: AppIcons.archiveRestore,
                                            size: 15,
                                            color: palette.accent,
                                          ),
                                          const SizedBox(width: 4),
                                          Text(
                                            t('common.restore'),
                                            style: TextStyle(
                                              color: palette.accent,
                                              fontSize: 13,
                                              fontWeight: FontWeight.w700,
                                            ),
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

  /// The connection's state as (label, colour, soft colour), or null when this machine is
  /// not the one the app is connected to.
  (String, Color, Color)? _statusLine(Palette palette) {
    final connection = Connection.instance;
    return connection.server?.id != widget.serverId
        ? null
        : switch (connection.status) {
            ConnectionStatus.connecting => (
              t('server.statusConnecting'),
              palette.warning,
              palette.warningSoft,
            ),
            ConnectionStatus.error => (
              t('server.statusOffline'),
              palette.danger,
              palette.dangerSoft,
            ),
            ConnectionStatus.ready when connection.reconnecting => (
              t('server.statusReconnecting'),
              palette.warning,
              palette.warningSoft,
            ),
            ConnectionStatus.ready => (
              t('server.statusConnected'),
              palette.success,
              palette.successSoft,
            ),
            _ => null,
          };
  }

  @override
  Widget build(BuildContext context) {
    final palette = paletteOf(context);
    final status = _statusLine(palette);

    return GlassScreen(
      title: _server?.alias ?? t('common.device', context: context),
      // The connection state belongs in the bar: it is the answer to the question a
      // failed call raises, and a row of its own would be read after the error.
      subtitle: status?.$1,
      statusColor: status?.$2,
      // Held from the first frame, loading included: the bar's own title is the one the
      // large 会话 title hands over to on scroll, so attaching the controller only once
      // the list was ready showed 「设备名 · 已连接」 in the bar for the loading moment
      // and then hid it again — a flash on every entry. Only the two pages with no large
      // title (a machine not found, a connection that failed) keep the bar title.
      largeTitleController: _showsBarTitle ? null : _title,
      actions: [
        if (_loaded &&
            _server != null &&
            _ready &&
            (_projectCounts.isNotEmpty || _project != null))
          // A sheet, not a pull-down: the menu grows from the bar and the package
          // clipped a long project list with no way to reach the rest. The sheet
          // scrolls and searches, like the project picker for a new chat.
          GlassAction(
            icon: AppIcons.folder,
            tooltip: t('server.projectFilter', context: context),
            active: _project != null,
            onPressed: _pickProject,
          ),
      ],
      body: _body(palette),
      bottomBar: _ready
          ? ConversationDock(
              selected: _activity,
              onSelect: (value) {
                Haptic.select();
                setState(() => _activity = value);
              },
              onCreate: _startChat,
              creating: _creating,
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
      return EmptyState(
        icon: AppIcons.alert,
        title: t('server.notFound'),
        body: t('server.notFoundBody'),
      );
    }
    if (connection.status == ConnectionStatus.connecting &&
        connection.server?.id == widget.serverId) {
      return BrandLoading(
        message: t('server.connectingTo', vars: <String, Object?>{
          'host': _server!.alias,
        }),
      );
    }
    if (connection.server?.id == widget.serverId &&
        connection.status == ConnectionStatus.error) {
      return _Failure(
        palette: palette,
        server: _server!,
        password: _password,
        onPassword: (value) => setState(() => _password = value),
      );
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
      if (_activity == 1 && connection.running[item.id] != true) return false;
      if (_activity == 2 && connection.waiting[item.id] != true) return false;
      if (_project != null && (item.project ?? '') != _project) return false;
      if (needle.isEmpty) return true;
      if (_hits.containsKey(item.id)) return true;
      final haystack =
          '${item.title} ${item.preview ?? ''} ${names[item.project ?? ''] ?? ''}'
              .toLowerCase();
      return haystack.contains(needle);
    }).toList();

    final projectCounts = <String, int>{};
    for (final chat in listed) {
      final project = chat.project;
      if (project == null || !names.containsKey(project)) continue;
      projectCounts[project] = (projectCounts[project] ?? 0) + 1;
    }

    final waiting = visible
        .where((item) => connection.waiting[item.id] == true)
        .toList();
    final running = visible
        .where(
          (item) =>
              connection.waiting[item.id] != true &&
              connection.running[item.id] == true,
        )
        .toList();
    final recent = visible
        .where(
          (item) =>
              connection.waiting[item.id] != true &&
              connection.running[item.id] != true,
        )
        .toList();

    return Builder(
      builder: (context) => CustomScrollView(
        controller: _title.scrollController,
        slivers: <Widget>[
          iosRefreshControl(
            onRefresh: _refresh,
            topInset: GlassInsets.pad(context).top,
          ),
          SliverToBoxAdapter(
            child: SizedBox(height: GlassInsets.pad(context).top),
          ),
          // The iOS large title and its search field: they scroll away with the list
          // (the title first, then the field) and the bar's own title fades in as they go.
          GlassLargeTitle(
            text: t('server.workspaceTitle'),
            controller: _title,
            searchBar: GlassSearchBar(
              controller: _query,
              placeholder: t('server.searchPlaceholder'),
              height: 40,
            ),
          ),
          SliverPadding(
            padding: EdgeInsets.only(
              bottom: GlassInsets.pad(
                context,
                const EdgeInsets.only(bottom: 4),
              ).bottom,
            ),
            sliver: SliverList(
              delegate: SliverChildListDelegate(<Widget>[
                // Connected is the normal state, so it is not announced here (the bar's title
                // carries it once the large one has scrolled away); only a filter that is
                // narrowing the list is, because otherwise the list looks short for no reason.
                if (_project != null)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(20, 4, 20, 8),
                    child: Align(
                      alignment: Alignment.centerLeft,
                      child: GestureDetector(
                        onTap: () => setState(() => _project = null),
                        child: Pill(
                          label: '${names[_project] ?? _project!}  ✕',
                          tone: PillTone.accent,
                          icon: AppIcons.folder,
                        ),
                      ),
                    ),
                  ),
                if (connection.reconnecting)
                  Container(
                    margin: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                    padding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 8,
                    ),
                    decoration: BoxDecoration(
                      color: palette.warningSoft,
                      borderRadius: BorderRadius.circular(Radii.md),
                    ),
                    child: Row(
                      children: <Widget>[
                        DesktopSpinner(size: 14, color: palette.warning),
                        const SizedBox(width: 8),
                        Text(
                          t('server.dropped'),
                          style: TextStyle(
                            color: palette.warning,
                            fontSize: 13,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ],
                    ),
                  ),
                if (listed.isEmpty) ...<Widget>[
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
                ] else ...<Widget>[
                  for (final section
                      in <(String, List<CatalogConversation>, bool, bool)>[
                        (t('server.waiting'), waiting, true, false),
                        (t('server.running'), running, false, true),
                        (
                          needle.isEmpty
                              ? t('server.recent')
                              : t('server.results'),
                          recent,
                          false,
                          false,
                        ),
                      ])
                    if (section.$2.isNotEmpty) ...<Widget>[
                      SectionLabel(title: section.$1),
                      for (final chat in section.$2)
                        Padding(
                          padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
                          child: _row(
                            chat,
                            palette,
                            names,
                            waiting: section.$3,
                            running: section.$4,
                          ),
                        ),
                    ],
                  if (visible.isEmpty)
                    EmptyState(
                      icon: AppIcons.bubbleChat,
                      title: t('server.noMatchTitle'),
                      body: needle.isNotEmpty
                          ? t('server.noMatchQuery', vars: <String, Object?>{
                              'query': _query.text.trim(),
                            })
                          : t('server.noChatsInProject'),
                    ),
                  // Archived chats are a place to go, like Mail's folders: a row of their own.
                  if (_archived.isNotEmpty && needle.isEmpty)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 24, 16, 0),
                      child: SettingsCard(
                        children: <Widget>[
                          SettingsRow(
                            icon: AppIcons.archive,
                            label: t('server.archived'),
                            value: '${_archived.length}',
                            onTap: _openArchiveSheet,
                          ),
                        ],
                      ),
                    ),
                ],
                if (listed.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(20, 16, 20, 4),
                    child: Text(
                      t('common.chatCount', vars: <String, Object?>{
                        'count': listed.length,
                      }),
                      textAlign: TextAlign.center,
                      style: TextStyle(color: palette.subtle, fontSize: 13),
                    ),
                  ),
              ]),
            ),
          ),
        ],
      ),
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
      projectName: _project == null && chat.project != null
          ? names[chat.project]
          : null,
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
    // One card per conversation: the leading mark, the title with the time trailing it,
    // one line of preview cut with an ellipsis, and the project on a line of its own.
    // Which section the card sits in already says waiting / running, so the card says it
    // only with its leading mark. A press dims the card, as iOS does; no ripple.
    final Widget leading = waiting
        ? _LeadingMark(
            background: palette.warningSoft,
            child: HugeIcon(
              icon: AppIcons.alert,
              size: 20,
              color: palette.warning,
            ),
          )
        : running
        ? _LeadingMark(
            background: palette.accentSoft,
            child: DesktopSpinner(size: 18, color: palette.accent),
          )
        : projectName != null
        ? Avatar(name: projectName!, size: 40, borderRadius: 10)
        : _LeadingMark(
            background: palette.field,
            child: HugeIcon(
              icon: AppIcons.bubbleChat,
              size: 20,
              color: palette.muted,
            ),
          );
    final preview = snippet ?? conversation.preview ?? t('server.noPreview', context: context);
    return Material(
      color: palette.card,
      borderRadius: BorderRadius.circular(Radii.card),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        onLongPress: onLongPress,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 16, 12),
          child: Row(
            children: <Widget>[
              leading,
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.baseline,
                      textBaseline: TextBaseline.alphabetic,
                      children: <Widget>[
                        Expanded(
                          child: Text(
                            conversation.title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              color: palette.text,
                              fontSize: 17,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Text(
                          relativeTime(conversation.updatedAt),
                          style: TextStyle(color: palette.subtle, fontSize: 12),
                        ),
                      ],
                    ),
                    const SizedBox(height: 3),
                    Text(
                      preview,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: palette.muted, fontSize: 15),
                    ),
                    if (projectName != null) ...<Widget>[
                      const SizedBox(height: 4),
                      Row(
                        children: <Widget>[
                          HugeIcon(
                            icon: AppIcons.folder,
                            size: 13,
                            color: palette.subtle,
                          ),
                          const SizedBox(width: 4),
                          Flexible(
                            child: Text(
                              projectName!,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                color: palette.subtle,
                                fontSize: 13,
                              ),
                            ),
                          ),
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

/// A 40pt rounded tile behind a row's leading glyph.
class _LeadingMark extends StatelessWidget {
  const _LeadingMark({required this.background, required this.child});

  final Color background;
  final Widget child;

  @override
  Widget build(BuildContext context) => Container(
    width: 40,
    height: 40,
    decoration: BoxDecoration(
      color: background,
      borderRadius: BorderRadius.circular(10),
    ),
    child: Center(child: child),
  );
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
    final needsAccount = connection.needsAccount;
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
                color: needsPassword || needsAccount ? palette.accentSoft : palette.dangerSoft,
                borderRadius: BorderRadius.circular(22),
              ),
              child: Center(
                child: HugeIcon(
                  icon: needsPassword || needsAccount
                      ? AppIcons.lockPassword
                      : AppIcons.wifiDisconnected,
                  size: 30,
                  color: needsPassword || needsAccount ? palette.accent : palette.danger,
                ),
              ),
            ),
            const SizedBox(height: 8),
            Text(
              needsAccount
                  ? t('account.signedOutTitle', context: context)
                  : needsPassword
                  ? t('server.needLogin', context: context)
                  : t('server.cannotConnect', vars: <String, Object?>{
                      'name': widget.server.alias,
                    }, context: context),
              textAlign: TextAlign.center,
              style: TextStyle(
                color: palette.text,
                fontSize: 19,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 8),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 320),
              child: Text(
                needsPassword || needsAccount
                    ? (connection.error ?? '')
                    : t(
                        // An account computer has no address: its `host` is the platform name,
                        // which read as 「手机能访问 darwin」.
                        widget.server.isOfficial ? 'server.cannotConnectOfficialBody' : 'server.cannotConnectBody',
                        vars: <String, Object?>{
                          'error': (connection.error ?? t('server.connectFailed', context: context))
                              .replaceAll(RegExp(r'[。.]$'), ''),
                          'host': widget.server.host,
                        },
                        context: context,
                      ),
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: palette.muted,
                  fontSize: 14,
                  height: 21 / 14,
                ),
              ),
            ),
            const SizedBox(height: 24),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 320),
              child: Column(
                children: <Widget>[
                  if (needsAccount)
                    SizedBox(
                      width: double.infinity,
                      child: PrimaryButton(
                        label: t('account.signIn', context: context),
                        icon: AppIcons.login,
                        onPressed: () async {
                          await AccountService.instance.login();
                          if (AccountService.instance.signedIn) {
                            await Connection.instance.connectSaved(widget.server);
                          }
                        },
                      ),
                    )
                  else if (needsPassword) ...<Widget>[
                    TextField(
                      onChanged: widget.onPassword,
                      obscureText: true,
                      style: TextStyle(color: palette.text, fontSize: 16),
                      decoration: InputDecoration(
                        hintText: t('add.passwordPlaceholder', context: context),
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
                        label: t('server.connect', context: context),
                        enabled: widget.password.isNotEmpty,
                        onPressed: () => Connection.instance.loginSaved(
                          widget.server,
                          widget.password,
                        ),
                      ),
                    ),
                  ] else
                    SizedBox(
                      width: double.infinity,
                      child: PrimaryButton(
                        label: t('server.reconnect', context: context),
                        icon: AppIcons.refresh,
                        onPressed: () =>
                            Connection.instance.connectSaved(widget.server),
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
