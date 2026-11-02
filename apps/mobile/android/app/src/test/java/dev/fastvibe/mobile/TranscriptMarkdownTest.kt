package dev.fastvibe.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TranscriptMarkdownTest {
    @Test
    fun decodesWorkspacePathLinksWithoutTreatingPlusAsSpace() {
        assertEquals(
            MarkdownLink.File("out/结果 + 1.md"),
            classifyMarkdownLink("fvpath:out%2F%E7%BB%93%E6%9E%9C%20%2B%201.md"),
        )
    }

    @Test
    fun acceptsAbsoluteRelativeAndLocalFilePaths() {
        assertEquals(MarkdownLink.File("/tmp/report.md"), classifyMarkdownLink("/tmp/report.md"))
        assertEquals(MarkdownLink.File("out/report.md"), classifyMarkdownLink("out/report.md"))
        assertEquals(MarkdownLink.File("/tmp/report.md"), classifyMarkdownLink("file:///tmp/report.md"))
        assertEquals(MarkdownLink.File("/tmp/report.md"), classifyMarkdownLink("file://localhost/tmp/report.md"))
        assertEquals(MarkdownLink.File("C:\\work\\report.md"), classifyMarkdownLink("C:\\work\\report.md"))
    }

    @Test
    fun sendsOnlyHttpAndHttpsToBrowser() {
        assertEquals(
            MarkdownLink.Browser("https://example.com/report"),
            classifyMarkdownLink("https://example.com/report"),
        )
        assertEquals(
            MarkdownLink.Browser("http://localhost:3000/"),
            classifyMarkdownLink("http://localhost:3000/"),
        )
    }

    @Test
    fun rejectsArbitrarySchemesAndRemoteFileHosts() {
        val rejected = listOf(
            "javascript:alert(1)",
            "intent://settings/#Intent;scheme=android-app;end",
            "mailto:someone@example.com",
            "tel:+123456789",
            "custom://host/path",
            "file://other-machine/tmp/report.md",
            "https://",
            "#section",
        )

        rejected.forEach { destination ->
            assertTrue("Expected ignored link: $destination", classifyMarkdownLink(destination) is MarkdownLink.Ignored)
        }
    }
}
