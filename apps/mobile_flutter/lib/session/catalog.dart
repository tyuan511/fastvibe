/// The desktop App Server may expose projects and conversations reached through its SSH
/// bindings. They use the shared `remote:<server>:<local>` shape, but they are still
/// ordinary selectable rows for a mobile client because calls are routed by that desktop
/// App Server. The validators stay structural so malformed catalog rows are ignored.
library;

bool isRemoteCatalogReference(Object? value) => value is String && value.startsWith('remote:');

class CatalogProject {
  const CatalogProject({required this.cwd, required this.name});

  final String cwd;
  final String name;
}

class CatalogConversation {
  const CatalogConversation({
    required this.id,
    required this.title,
    this.preview,
    this.project,
    required this.createdAt,
    required this.updatedAt,
    this.kind,
  });

  final String id;
  final String title;
  final String? preview;
  final String? project;
  final int createdAt;
  final int updatedAt;
  final String? kind;
}

CatalogProject? parseProject(Object? value) {
  if (value is! Map) return null;
  final cwd = value['cwd'];
  final name = value['name'];
  if (cwd is! String || name is! String) return null;
  return CatalogProject(cwd: cwd, name: name);
}

CatalogConversation? parseConversation(Object? value, {required String untitled}) {
  if (value is! Map) return null;
  final id = value['id'];
  if (id is! String) return null;
  final title = value['title'];
  final preview = value['preview'];
  final project = value['project'];
  final kind = value['kind'];
  return CatalogConversation(
    id: id,
    title: title is String && title.isNotEmpty ? title : untitled,
    preview: preview is String ? preview : null,
    project: project is String ? project : null,
    createdAt: value['createdAt'] is num ? (value['createdAt'] as num).toInt() : 0,
    updatedAt: value['updatedAt'] is num ? (value['updatedAt'] as num).toInt() : 0,
    kind: kind is String ? kind : null,
  );
}

/// Keep the server's order for projects that have never had a usable chat.
List<CatalogProject> orderProjectsByRecentUse(
  List<CatalogProject> projects,
  List<CatalogConversation> conversations,
) {
  final recent = <String, int>{};
  for (final conversation in conversations) {
    final project = conversation.project;
    if (project == null || project.isEmpty || conversation.kind == 'side-chat') continue;
    final usedAt = conversation.updatedAt > conversation.createdAt ? conversation.updatedAt : conversation.createdAt;
    final current = recent[project] ?? 0;
    if (usedAt > current) recent[project] = usedAt;
  }
  final indexed = <({CatalogProject project, int index})>[
    for (var index = 0; index < projects.length; index++) (project: projects[index], index: index),
  ];
  indexed.sort((left, right) {
    final leftUsedAt = recent[left.project.cwd];
    final rightUsedAt = recent[right.project.cwd];
    if (leftUsedAt == null && rightUsedAt == null) return left.index - right.index;
    if (leftUsedAt == null) return 1;
    if (rightUsedAt == null) return -1;
    final byTime = rightUsedAt.compareTo(leftUsedAt);
    return byTime != 0 ? byTime : left.index - right.index;
  });
  return indexed.map((item) => item.project).toList();
}

/// The rows the conversation list shows, in the order it shows them.
///
/// A chat with no preview is a chat nothing has been sent to yet; it appears only while
/// it is running, so an empty draft created by 新对话 does not sit in the list until its
/// first prompt lands.
List<CatalogConversation> visibleConversations({
  required List<CatalogConversation> conversations,
  required Set<String> archivedIds,
  required Set<String> running,
  String? project,
  String? query,
  Set<String>? bodyHits,
}) {
  final needle = query?.trim().toLowerCase();
  final rows = conversations.where((item) {
    if (item.kind == 'side-chat') return false;
    if (archivedIds.contains(item.id)) return false;
    if (project != null && item.project != project) return false;
    if ((item.preview == null || item.preview!.isEmpty) && running.contains(item.id) == false) return false;
    if (needle != null && needle.isNotEmpty) {
      final inBody = bodyHits?.contains(item.id) ?? false;
      final inText = item.title.toLowerCase().contains(needle) ||
          (item.preview ?? '').toLowerCase().contains(needle) ||
          (item.project ?? '').toLowerCase().contains(needle);
      if (!inBody && !inText) return false;
    }
    return true;
  }).toList();
  rows.sort((a, b) {
    final byUpdated = b.updatedAt.compareTo(a.updatedAt);
    if (byUpdated != 0) return byUpdated;
    final byCreated = b.createdAt.compareTo(a.createdAt);
    return byCreated != 0 ? byCreated : a.id.compareTo(b.id);
  });
  return rows;
}
