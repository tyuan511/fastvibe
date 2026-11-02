package dev.fastvibe.mobile

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.util.Base64

class OutputDownloadTest {
    private val directories = mutableListOf<File>()

    @After
    fun cleanUp() {
        directories.asReversed().forEach(::deleteRecursively)
    }

    @Test
    fun assemblesMoreThanTwoChunksAndPreservesSafeUnicodeName() {
        val directory = temporaryDirectory()
        val bytes = "你好, FastVibe — output\n第二行".toByteArray(Charsets.UTF_8)
        val first = bytes.copyOfRange(0, 5)
        val second = bytes.copyOfRange(5, 14)
        val third = bytes.copyOfRange(14, bytes.size)
        val download = OutputDownload(directory, "结果/报告\u0000.txt")

        assertFalse(download.append(response(bytes.size.toLong(), 123.456, 0L, first, false), 0L))
        assertEquals(first.size.toLong(), download.offset)
        assertFalse(download.append(response(bytes.size.toLong(), 123.456, first.size.toLong(), second, false), download.offset))
        assertTrue(download.append(response(bytes.size.toLong(), 123.456, (first.size + second.size).toLong(), third, true), download.offset))

        val finished = download.finish()
        assertArrayEquals(bytes, finished.readBytes())
        assertTrue(finished.name.contains("结果"))
        assertFalse(finished.name.contains('/'))
        assertFalse(finished.name.contains('\\'))
        assertFalse(finished.name.contains('\u0000'))
    }

    @Test
    fun changedServerFileCancelsAndDeletesPartialOutput() {
        val directory = temporaryDirectory()
        val download = OutputDownload(directory, "report.txt")
        val response = response(6L, 10.123, 0L, "abc".toByteArray(), false)

        download.append(response, 0L)
        assertTrue(download.target.exists())
        val failure = assertThrows<IOException> {
            download.append(response(6L, 10.124, 3L, "def".toByteArray(), true), 3L)
        }

        assertTrue(failure.message.orEmpty().contains("changed"))
        assertFalse(download.target.exists())
    }

    @Test
    fun rejectsInvalidOffsetsAndRemovesPartialOutput() {
        val directory = temporaryDirectory()
        val download = OutputDownload(directory, "offset.bin")

        val failure = assertThrows<IOException> {
            download.append(response(3L, 1L, 1L, byteArrayOf(1), false), 0L)
        }

        assertTrue(failure.message.orEmpty().contains("offset"))
        assertFalse(download.target.exists())
    }

    @Test
    fun rejectsSizeAbove256MiB() {
        val download = OutputDownload(temporaryDirectory(), "large.bin")
        val tooLarge = 256L * 1024L * 1024L + 1L

        val failure = assertThrows<IOException> {
            download.append(response(tooLarge, 1L, 0L, byteArrayOf(), false), 0L)
        }

        assertTrue(failure.message.orEmpty().contains("256 MiB"))
        assertFalse(download.target.exists())
    }

    @Test
    fun rejectsChunkAbove512KiBAndDataBeyondDeclaredSize() {
        val largeChunkDownload = OutputDownload(temporaryDirectory(), "chunk.bin")
        val largeChunk = ByteArray(512 * 1024 + 1)
        val chunkFailure = assertThrows<IOException> {
            largeChunkDownload.append(response(largeChunk.size.toLong(), 1L, 0L, largeChunk, false), 0L)
        }
        assertTrue(chunkFailure.message.orEmpty().contains("512 KiB"))
        assertFalse(largeChunkDownload.target.exists())

        val oversizedDataDownload = OutputDownload(temporaryDirectory(), "data.bin")
        val dataFailure = assertThrows<IOException> {
            oversizedDataDownload.append(response(2L, 1L, 0L, byteArrayOf(1, 2, 3), true), 0L)
        }
        assertTrue(dataFailure.message.orEmpty().contains("declared file size"))
        assertFalse(oversizedDataDownload.target.exists())
    }

    @Test
    fun rejectsFractionalSizeAndOffset() {
        val fractionalOffset = OutputDownload(temporaryDirectory(), "fractional-offset.bin")
        val offsetFailure = assertThrows<IOException> {
            fractionalOffset.append(
                JSONObject()
                    .put("size", 1L)
                    .put("mtimeMs", 1.25)
                    .put("offset", 0.5)
                    .put("data", Base64.getEncoder().encodeToString(byteArrayOf()))
                    .put("eof", false),
                0L,
            )
        }
        assertTrue(offsetFailure.message.orEmpty().contains("file offset"))
        assertFalse(fractionalOffset.target.exists())

        val fractionalSize = OutputDownload(temporaryDirectory(), "fractional-size.bin")
        val sizeFailure = assertThrows<IOException> {
            fractionalSize.append(
                JSONObject()
                    .put("size", 1.5)
                    .put("mtimeMs", 1.25)
                    .put("offset", 0L)
                    .put("data", Base64.getEncoder().encodeToString(byteArrayOf()))
                    .put("eof", false),
                0L,
            )
        }
        assertTrue(sizeFailure.message.orEmpty().contains("file size"))
        assertFalse(fractionalSize.target.exists())
    }

    @Test
    fun rejectsInvalidBase64AndNonEofZeroProgress() {
        val invalidBase64Download = OutputDownload(temporaryDirectory(), "base64.bin")
        val base64Failure = assertThrows<IOException> {
            invalidBase64Download.append(
                JSONObject()
                    .put("size", 1L)
                    .put("mtimeMs", 1L)
                    .put("offset", 0L)
                    .put("data", "not base64!")
                    .put("eof", true),
                0L,
            )
        }
        assertTrue(base64Failure.message.orEmpty().contains("base64"))
        assertFalse(invalidBase64Download.target.exists())

        val zeroProgressDownload = OutputDownload(temporaryDirectory(), "empty.bin")
        val zeroProgressFailure = assertThrows<IOException> {
            zeroProgressDownload.append(response(1L, 1L, 0L, byteArrayOf(), false), 0L)
        }
        assertTrue(zeroProgressFailure.message.orEmpty().contains("empty chunk"))
        assertFalse(zeroProgressDownload.target.exists())
    }

    @Test
    fun doesNotOverwriteAnExistingCacheFile() {
        val directory = temporaryDirectory()
        val existing = File(directory, "report.txt").apply { writeText("keep me") }
        val download = OutputDownload(directory, "report.txt")

        assertNotEquals(existing.absolutePath, download.target.absolutePath)
        assertEquals("report (2).txt", download.target.name)
        assertTrue(download.append(response(3L, 1L, 0L, "new".toByteArray(), true), 0L))
        download.finish()

        assertEquals("keep me", existing.readText())
        assertEquals("new", download.target.readText())
    }

    @Test
    fun cancelDeletesPartialOutputAndEmptyFileCanFinish() {
        val directory = temporaryDirectory()
        val download = OutputDownload(directory, "cancel.bin")
        download.append(response(2L, 1L, 0L, byteArrayOf(1), false), 0L)
        download.cancel()
        assertFalse(download.target.exists())

        val empty = OutputDownload(directory, "empty.bin")
        assertTrue(empty.append(response(0L, 1L, 0L, byteArrayOf(), true), 0L))
        assertEquals(empty.target, empty.finish())
        assertTrue(empty.target.exists())
        assertEquals(0L, empty.target.length())
    }

    private fun temporaryDirectory(): File = Files.createTempDirectory("fastvibe-output-download").toFile().also(directories::add)

    private fun response(size: Long, mtimeMs: Number, offset: Long, data: ByteArray, eof: Boolean): JSONObject = JSONObject()
        .put("size", size)
        .put("mtimeMs", mtimeMs)
        .put("offset", offset)
        .put("data", Base64.getEncoder().encodeToString(data))
        .put("eof", eof)

    private fun deleteRecursively(file: File) {
        if (file.isDirectory) file.listFiles()?.forEach(::deleteRecursively)
        file.delete()
    }

    private inline fun <reified T : Throwable> assertThrows(block: () -> Unit): T {
        try {
            block()
        } catch (error: Throwable) {
            if (error is T) return error
            throw AssertionError("Expected ${T::class.java.name}, got ${error::class.java.name}", error)
        }
        throw AssertionError("Expected ${T::class.java.name}")
    }
}
