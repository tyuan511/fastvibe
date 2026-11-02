package dev.fastvibe.mobile

import org.junit.Assert.assertEquals
import org.junit.Test

class ConversationCatalogSelectionTest {
    @Test
    fun mergesProjectsWithoutDuplicatesAndOrdersRecentConversations() {
        val first = ConversationView("a", "older", projectId = "/one", updatedAt = 10)
        val second = ConversationView("b", "newer", projectId = "/two", updatedAt = 20)
        val unassigned = ConversationView("c", "unassigned", updatedAt = 15)
        val workspace = WorkspaceView(
            projects = listOf(ProjectView("one", "项目一", "/one", listOf(first)), ProjectView("two", "项目二", "/two", listOf(second)), ProjectView(UNASSIGNED_CONVERSATION_PROJECT, "未归属项目", conversations = listOf(unassigned))),
            conversations = listOf(first, second),
        )
        val result = selectConversationCatalog(workspace)
        assertEquals(listOf("b", "c", "a"), result.map { it.id })
        assertEquals(listOf("项目二", "未归属项目", "项目一"), result.map { it.projectName })
        assertEquals(listOf("c"), selectConversationCatalog(workspace, ConversationCatalogFilter(projectId = UNASSIGNED_CONVERSATION_PROJECT)).map { it.id })
        assertEquals(listOf("a"), selectConversationCatalog(workspace, query = "项目一").map { it.id })
    }

    @Test
    fun combinesSearchStatusAndProjectWithoutShowingArchivedByDefault() {
        val workspace = WorkspaceView(conversations = listOf(
            ConversationView("a", "Matching", projectId = "p", updatedAt = 10, running = true),
            ConversationView("b", "Matching", projectId = "p", updatedAt = 20, waiting = true),
            ConversationView("c", "Matching", projectId = "p", updatedAt = 30, unread = true),
            ConversationView("d", "Matching", projectId = "p", updatedAt = 40, archived = true),
        ))
        assertEquals(listOf("c", "b", "a"), selectConversationCatalog(workspace).map { it.id })
        assertEquals(listOf("a"), selectConversationCatalog(workspace, ConversationCatalogFilter("running", "p"), "match").map { it.id })
        assertEquals(listOf("b"), selectConversationCatalog(workspace, ConversationCatalogFilter("waiting")).map { it.id })
        assertEquals(listOf("c"), selectConversationCatalog(workspace, ConversationCatalogFilter("unread")).map { it.id })
        assertEquals(listOf("d"), selectConversationCatalog(workspace, ConversationCatalogFilter("archived")).map { it.id })
        assertEquals(emptyList<String>(), selectConversationCatalog(workspace, ConversationCatalogFilter("running", "other")).map { it.id })
    }
}
