package dev.fastvibe.mobile

import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.util.Base64

/**
 * Validates and appends the chunks returned by workspace:read-file.
 *
 * The target is reserved when the download starts, so an existing cache entry is never
 * overwritten. It remains a partial file until [finish] is called and is removed by [cancel].
 */
internal class OutputDownload(
    directory: File,
    suggestedName: String,
) {
    val target: File

    val offset: Long
        get() = currentOffset

    private var currentOffset = 0L
    private var expectedSize: Long? = null
    private var expectedMtimeMs: Double? = null
    private var status = Status.OPEN

    init {
        target = reserveTarget(directory, suggestedName)
    }

    /**
     * Validate and append one server response. Returns true only for the final chunk.
     *
     * A malformed response makes this download unusable and removes its partial file. The
     * caller should report the exception and not request another chunk.
     */
    fun append(response: JSONObject, expectedOffset: Long): Boolean {
        ensureCanAppend()
        try {
            return appendChecked(response, expectedOffset)
        } catch (error: IOException) {
            cancelSilently()
            throw error
        } catch (error: RuntimeException) {
            cancelSilently()
            throw IOException(
                error.message?.takeIf { it.isNotBlank() }
                    ?: "The server returned an invalid file response.",
                error,
            )
        }
    }

    /** Finish and return the stable, complete output file. */
    fun finish(): File {
        when (status) {
            Status.CANCELLED -> throw IllegalStateException("The file download was cancelled.")
            Status.FINISHED -> return target
            Status.OPEN -> throw IOException("The file download is incomplete: no data was received.")
            Status.COMPLETE -> Unit
        }

        val size = expectedSize ?: throw IOException("The server did not provide a file size.")
        if (!target.isFile || target.length() != size || currentOffset != size) {
            cancelSilently()
            throw IOException("The downloaded file is incomplete.")
        }
        status = Status.FINISHED
        return target
    }

    /** Cancel this download and remove its partial output. */
    fun cancel() {
        if (status == Status.FINISHED || status == Status.CANCELLED) return
        status = Status.CANCELLED
        if (target.exists() && !target.delete() && target.exists()) {
            throw IOException("Could not remove the incomplete downloaded file.")
        }
    }

    private fun appendChecked(response: JSONObject, expectedOffset: Long): Boolean {
        if (expectedOffset < 0L) {
            throw IOException("The requested file offset cannot be negative.")
        }
        if (expectedOffset != currentOffset) {
            throw IOException(
                "The file download is out of order: expected offset $currentOffset, " +
                    "but the caller supplied $expectedOffset.",
            )
        }

        val responseOffset = requiredLong(response, "offset", "file offset")
        if (responseOffset != expectedOffset) {
            throw IOException(
                "The server returned offset $responseOffset, but offset $expectedOffset was expected.",
            )
        }
        if (responseOffset < 0L) {
            throw IOException("The server returned a negative file offset.")
        }

        val size = requiredLong(response, "size", "file size")
        if (size < 0L || size > MAX_DOWNLOAD_BYTES) {
            throw IOException("The server returned an unsupported file size; files must be 256 MiB or smaller.")
        }
        expectedSize?.let { knownSize ->
            if (knownSize != size) {
                throw IOException("The file changed while it was being downloaded (its size changed).")
            }
        }

        val mtimeMs = requiredFiniteDouble(response, "mtimeMs", "file modification time")
        expectedMtimeMs?.let { knownMtimeMs ->
            if (knownMtimeMs != mtimeMs) {
                throw IOException("The file changed while it was being downloaded (its modification time changed).")
            }
        }

        if (responseOffset > size) {
            throw IOException("The server returned an offset beyond the file size.")
        }

        val encoded = requiredString(response, "data", "file data")
        if (encoded.length > MAX_BASE64_CHARS) {
            throw IOException("The server returned a file chunk larger than 512 KiB.")
        }
        val decoded = try {
            Base64.getDecoder().decode(encoded)
        } catch (error: IllegalArgumentException) {
            throw IOException("The server returned invalid base64 file data.", error)
        }
        if (decoded.size > MAX_CHUNK_BYTES) {
            throw IOException("The server returned a file chunk larger than 512 KiB.")
        }

        val remaining = size - responseOffset
        if (decoded.size.toLong() > remaining) {
            throw IOException("The server returned more data than the declared file size.")
        }
        val nextOffset = responseOffset + decoded.size.toLong()
        val reachesEnd = nextOffset == size
        val eof = requiredBoolean(response, "eof")
        if (decoded.isEmpty() && !reachesEnd) {
            throw IOException("The server returned an empty chunk before the file was complete.")
        }
        if (eof != reachesEnd) {
            throw IOException("The server returned an invalid end-of-file marker.")
        }

        if (!target.isFile || target.length() != currentOffset) {
            throw IOException("The local output file changed while it was being downloaded.")
        }
        if (decoded.isNotEmpty()) {
            try {
                FileOutputStream(target, true).use { output -> output.write(decoded) }
            } catch (error: IOException) {
                throw IOException("Could not write the downloaded file.", error)
            }
        }
        if (target.length() != nextOffset) {
            throw IOException("The downloaded file could not be written completely.")
        }

        if (expectedSize == null) expectedSize = size
        if (expectedMtimeMs == null) expectedMtimeMs = mtimeMs
        currentOffset = nextOffset
        if (reachesEnd) status = Status.COMPLETE
        return reachesEnd
    }

    private fun ensureCanAppend() {
        when (status) {
            Status.OPEN -> Unit
            Status.COMPLETE -> throw IllegalStateException("The file download has already reached the end.")
            Status.FINISHED -> throw IllegalStateException("The file download has already been finished.")
            Status.CANCELLED -> throw IllegalStateException("The file download was cancelled.")
        }
    }

    private fun cancelSilently() {
        if (status == Status.FINISHED) return
        status = Status.CANCELLED
        runCatching { if (target.exists()) target.delete() }
    }

    private enum class Status {
        OPEN,
        COMPLETE,
        FINISHED,
        CANCELLED,
    }

    companion object {
        private const val MAX_DOWNLOAD_BYTES = 256L * 1024L * 1024L
        private const val MAX_CHUNK_BYTES = 512 * 1024
        private const val MAX_FILENAME_BYTES = 240
        private const val MAX_BASE64_CHARS = ((MAX_CHUNK_BYTES + 2) / 3) * 4
        private const val MAX_NAME_ATTEMPTS = 100_000

        private fun requiredLong(response: JSONObject, key: String, label: String): Long {
            if (!response.has(key) || response.isNull(key)) {
                throw IOException("The server response is missing the $label.")
            }
            val raw = try {
                response.get(key)
            } catch (error: RuntimeException) {
                throw IOException("The server returned an invalid $label.", error)
            }
            val value = when (raw) {
                is Byte -> raw.toLong()
                is Short -> raw.toLong()
                is Int -> raw.toLong()
                is Long -> raw
                is Float -> raw.toLong().takeIf {
                    raw.isFinite() && raw >= Long.MIN_VALUE.toFloat() && raw <= Long.MAX_VALUE.toFloat() &&
                        raw == it.toFloat()
                }
                is Double -> raw.toLong().takeIf {
                    raw.isFinite() && raw >= Long.MIN_VALUE.toDouble() && raw <= Long.MAX_VALUE.toDouble() &&
                        raw == it.toDouble()
                }
                else -> null
            } ?: throw IOException("The server returned an invalid $label.")
            return value
        }

        private fun requiredFiniteDouble(response: JSONObject, key: String, label: String): Double {
            if (!response.has(key) || response.isNull(key)) {
                throw IOException("The server response is missing the $label.")
            }
            val value = try {
                response.getDouble(key)
            } catch (error: RuntimeException) {
                throw IOException("The server returned an invalid $label.", error)
            }
            if (!value.isFinite()) {
                throw IOException("The server returned an invalid $label.")
            }
            return value
        }

        private fun requiredString(response: JSONObject, key: String, label: String): String {
            if (!response.has(key) || response.isNull(key)) {
                throw IOException("The server response is missing the $label.")
            }
            return try {
                response.getString(key)
            } catch (error: RuntimeException) {
                throw IOException("The server returned invalid $label.", error)
            }
        }

        private fun requiredBoolean(response: JSONObject, key: String): Boolean {
            if (!response.has(key) || response.isNull(key)) {
                throw IOException("The server response is missing the end-of-file marker.")
            }
            return try {
                response.getBoolean(key)
            } catch (error: RuntimeException) {
                throw IOException("The server returned an invalid end-of-file marker.", error)
            }
        }

        private fun reserveTarget(directory: File, suggestedName: String): File {
            if (!directory.exists() && !directory.mkdirs() && !directory.exists()) {
                throw IOException("Could not create the file download directory.")
            }
            if (!directory.isDirectory) {
                throw IOException("The file download location is not a directory.")
            }

            val safeName = sanitizeName(suggestedName)
            for (attempt in 1..MAX_NAME_ATTEMPTS) {
                val name = numberedName(safeName, attempt)
                val candidate = File(directory, name)
                try {
                    if (candidate.createNewFile()) return candidate
                } catch (error: IOException) {
                    throw IOException("Could not reserve a file for the download.", error)
                }
            }
            throw IOException("Could not choose a unique name for the downloaded file.")
        }

        private fun sanitizeName(value: String): String {
            val builder = StringBuilder(value.length)
            var index = 0
            while (index < value.length) {
                val codePoint = value.codePointAt(index)
                val count = Character.charCount(codePoint)
                val unsafe = codePoint == '/'.code ||
                    codePoint == '\\'.code ||
                    Character.isISOControl(codePoint) ||
                    Character.getType(codePoint) == Character.FORMAT.toInt() ||
                    Character.getType(codePoint) == Character.LINE_SEPARATOR.toInt() ||
                    Character.getType(codePoint) == Character.PARAGRAPH_SEPARATOR.toInt()
                if (unsafe) builder.append('_') else builder.appendCodePoint(codePoint)
                index += count
            }
            return builder.toString().ifBlank { "output" }.let { name ->
                if (name == "." || name == "..") "output" else name
            }
        }

        private fun numberedName(safeName: String, attempt: Int): String {
            val suffix = if (attempt == 1) "" else " ($attempt)"
            val dot = safeName.lastIndexOf('.')
            val hasExtension = dot > 0 && dot < safeName.lastIndex
            val stem = if (hasExtension) safeName.substring(0, dot) else safeName
            val extension = if (hasExtension) safeName.substring(dot) else ""
            val availableStemBytes = MAX_FILENAME_BYTES -
                utf8Bytes(suffix) - utf8Bytes(extension)
            val limitedStem = truncateUtf8(stem, availableStemBytes.coerceAtLeast(0))
            return truncateUtf8(limitedStem + suffix + extension, MAX_FILENAME_BYTES)
                .ifBlank { "output$suffix" }
        }

        private fun utf8Bytes(value: String): Int = value.toByteArray(StandardCharsets.UTF_8).size

        private fun truncateUtf8(value: String, maxBytes: Int): String {
            if (maxBytes <= 0) return ""
            if (utf8Bytes(value) <= maxBytes) return value
            val builder = StringBuilder()
            var used = 0
            var index = 0
            while (index < value.length) {
                val count = Character.charCount(value.codePointAt(index))
                val part = value.substring(index, index + count)
                val partBytes = utf8Bytes(part)
                if (used + partBytes > maxBytes) break
                builder.append(part)
                used += partBytes
                index += count
            }
            return builder.toString()
        }
    }
}
