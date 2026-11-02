package dev.fastvibe.mobile

/** The project value used by the catalog filter for conversations without a project. */
internal const val UNASSIGNED_CONVERSATION_PROJECT = "__unassigned__"

internal data class ConversationCatalogFilter(
    val status: String = "all",
    val projectId: String? = null,
)

/**
 * Builds the flat conversation list shown by the mobile catalog.
 *
 * The desktop catalog can expose the same conversation in the workspace list and in a
 * project's nested list. The top-level value wins when both contain an id; nested-only
 * values are still included. Project association is resolved by project id or cwd.
 */
internal fun selectConversationCatalog(
    workspace: WorkspaceView,
    filter: ConversationCatalogFilter = ConversationCatalogFilter(),
    query: String = "",
): List<ConversationView> {
    val projectsByKey = buildMap {
        workspace.projects.forEach { project ->
            put(project.id, project)
            project.cwd?.takeIf { it.isNotBlank() }?.let { put(it, project) }
        }
    }

    val nestedProjectByConversationId = buildMap {
        workspace.projects.forEach { project ->
            project.conversations.forEach { conversation ->
                putIfAbsent(conversation.id, project)
            }
        }
    }

    val merged = linkedMapOf<String, ConversationView>()
    workspace.conversations.forEach { conversation ->
        merged.putIfAbsent(conversation.id, conversation)
    }
    workspace.projects.forEach { project ->
        project.conversations.forEach { conversation ->
            merged.putIfAbsent(conversation.id, conversation)
        }
    }

    val needle = query.trim()
    return merged.values
        .map { conversation ->
            val nestedProject = nestedProjectByConversationId[conversation.id]
            val project = conversation.projectId
                ?.takeUnless { it == UNASSIGNED_CONVERSATION_PROJECT }
                ?.let(projectsByKey::get)
                ?: nestedProject?.takeUnless { it.id == UNASSIGNED_CONVERSATION_PROJECT }
            when {
                conversation.projectId == UNASSIGNED_CONVERSATION_PROJECT || nestedProject?.id == UNASSIGNED_CONVERSATION_PROJECT -> {
                    conversation.copy(projectId = null, projectName = "未归属项目")
                }
                project == null -> conversation
                else -> conversation.copy(projectId = project.id, projectName = project.name)
            }
        }
        .asSequence()
        .filter { conversation -> matchesCatalogStatus(conversation, filter.status) }
        .filter { conversation ->
            filter.projectId == null ||
                if (filter.projectId == UNASSIGNED_CONVERSATION_PROJECT) {
                    conversation.projectId.isNullOrBlank()
                } else {
                    conversation.projectId == filter.projectId
                }
        }
        .filter { conversation ->
            needle.isBlank() || listOf(
                conversation.title,
                conversation.subtitle,
                conversation.projectName.orEmpty(),
            ).any { it.contains(needle, ignoreCase = true) }
        }
        .sortedWith(
            compareByDescending<ConversationView> { it.updatedAt ?: Long.MIN_VALUE }
                .thenBy { it.id },
        )
        .toList()
}

private fun matchesCatalogStatus(conversation: ConversationView, status: String): Boolean = when (status) {
    "running" -> !conversation.archived && conversation.running
    "waiting" -> !conversation.archived && conversation.waiting
    "unread" -> !conversation.archived && conversation.unread
    "archived" -> conversation.archived
    else -> !conversation.archived
}

internal fun conversationCatalogProjectName(
    workspace: WorkspaceView,
    projectId: String?,
): String? {
    if (projectId.isNullOrBlank() || projectId == UNASSIGNED_CONVERSATION_PROJECT) return null
    return workspace.projects.firstOrNull { it.id == projectId || it.cwd == projectId }?.name
}
