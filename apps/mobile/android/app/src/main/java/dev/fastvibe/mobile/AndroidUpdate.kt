package dev.fastvibe.mobile

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URI
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit

internal data class UpdateState(
    val phase: String = "idle",
    val version: String? = null,
    val progress: Float? = null,
    val message: String? = null,
    val pageUrl: String? = null,
)

internal enum class UpdateChannel(
    val key: String,
    val label: String,
    private val proxyPrefix: String?,
) {
    GITHUB("github", "GitHub 官方", null),
    GHFAST("ghfast", "ghfast.top", "https://ghfast.top/"),
    GH_PROXY("gh-proxy", "gh-proxy.com", "https://gh-proxy.com/"),

    ;

    fun url(path: String): String = "${proxyPrefix ?: ""}https://github.com/$path"

    companion object {
        fun fromKey(key: String?): UpdateChannel = entries.firstOrNull { it.key == key } ?: GITHUB
    }
}

private const val UPDATE_REPOSITORY = "tyuan511/fastvibe"

/**
 * Android's native updater for the public FastVibe arm64 release.
 *
 * The controller deliberately does not install anything automatically. A check only finds
 * an update, a download only writes to the app cache, and install() only opens Android's
 * package installer after the APK has passed the same validation again.
 */
internal class AndroidUpdateController(context: Context) {
    private val appContext = context.applicationContext ?: context
    private val mainHandler = Handler(Looper.getMainLooper())
    private val executor: ExecutorService = Executors.newSingleThreadExecutor { task ->
        Thread(task, "fastvibe-android-update").apply { isDaemon = true }
    }
    private val preferences = appContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
    private val lock = Any()
    private val updateDirectory = File(File(appContext.cacheDir, "shared"), "updates")

    private var closed = false
    private var generation = 0L
    private var activeJob: Future<*>? = null
    @Volatile private var activeConnection: HttpURLConnection? = null
    private var release: ReleaseCandidate? = null

    var channel by mutableStateOf(UpdateChannel.fromKey(preferences.getString(KEY_CHANNEL, null)))
        private set

    var state by mutableStateOf(UpdateState())
        private set

    init {
        activeJob = executor.submit { restoreDownloadedCache() }
    }

    /** Select a source, discard source-specific cache, and immediately check it. */
    fun selectChannel(next: UpdateChannel) {
        synchronized(lock) {
            if (closed || channel == next) return
            generation += 1
            activeJob?.cancel(true)
            activeConnection?.disconnect()
            activeConnection = null
            release = null
            channel = next
        }
        preferences.edit()
            .putString(KEY_CHANNEL, next.key)
            .remove(KEY_CHECKED_AT)
            .remove(KEY_CHECK_HAS_RELEASE)
            .remove(KEY_CHECK_VERSION)
            .remove(KEY_CHECK_URL)
            .remove(KEY_CHECK_BYTES)
            .remove(KEY_BACKOFF_UNTIL)
            .remove(KEY_DOWNLOAD_VERSION)
            .remove(KEY_DOWNLOAD_NAME)
            .remove(KEY_DOWNLOAD_URL)
            .remove(KEY_DOWNLOAD_BYTES)
            .apply()
        updateDirectory.listFiles()?.forEach { file ->
            if (file.isFile && (file.extension.equals("apk", ignoreCase = true) || file.name.endsWith(".part"))) {
                file.delete()
            }
        }
        postStateAny { UpdateState() }
        check(true)
    }

    /** Start a check. force=true always asks the selected source; force=false uses the short-lived result cache. */
    fun check(force: Boolean = true) {
        val token: Long
        synchronized(lock) {
            if (closed) return
            generation += 1
            token = generation
            activeJob?.cancel(true)
            release = null
        }
        postState(token) { it.copy(phase = "checking", version = null, progress = null, message = null, pageUrl = null) }
        activeJob = executor.submit {
            try {
                val candidate = if (!force) cachedCheck() ?: findReleaseAndRemember(token) else findReleaseAndRemember(token)
                if (!isCurrent(token)) return@submit
                if (candidate == null) {
                    synchronized(lock) {
                        if (isCurrentLocked(token)) release = null
                    }
                    postState(token) { UpdateState() }
                    return@submit
                }
                val cachedFile = validCachedApk(candidate)
                synchronized(lock) {
                    if (isCurrentLocked(token)) release = candidate
                }
                if (cachedFile != null) {
                    postState(token) {
                        UpdateState(
                            phase = "downloaded",
                            version = candidate.version,
                            message = null,
                            pageUrl = candidate.pageUrl,
                        )
                    }
                } else {
                    postState(token) {
                        UpdateState(
                            phase = "available",
                            version = candidate.version,
                            message = null,
                            pageUrl = candidate.pageUrl,
                        )
                    }
                }
            } catch (cancelled: InterruptedException) {
                Thread.currentThread().interrupt()
            } catch (error: Throwable) {
                if (!isCurrent(token)) return@submit
                if (error is UpdateHttpException && (error.status == 403 || error.status == 429)) {
                    rememberBackoff()
                }
                postState(token) {
                    UpdateState(
                        phase = "error",
                        message = describeUpdateError(error),
                    )
                }
            }
        }
    }

    /** Download the currently offered APK. The archive is validated before it is retained. */
    fun download() {
        val token: Long
        val candidate: ReleaseCandidate
        synchronized(lock) {
            if (closed) return
            val current = release ?: return
            generation += 1
            token = generation
            activeJob?.cancel(true)
            candidate = current
        }
        postState(token) {
            UpdateState(
                phase = "downloading",
                version = candidate.version,
                progress = null,
                pageUrl = candidate.pageUrl,
            )
        }
        activeJob = executor.submit {
            val part = File(updateDirectory, "${candidate.apkName}.part")
            try {
                val target = downloadCandidate(candidate, token, part)
                if (!isCurrent(token)) return@submit
                writeDownloadedMetadata(candidate)
                synchronized(lock) {
                    if (isCurrentLocked(token)) release = candidate
                }
                postState(token) {
                    UpdateState(
                        phase = "downloaded",
                        version = candidate.version,
                        pageUrl = candidate.pageUrl,
                    )
                }
                target
            } catch (cancelled: InterruptedException) {
                part.delete()
                Thread.currentThread().interrupt()
            } catch (error: Throwable) {
                part.delete()
                if (!isCurrent(token)) return@submit
                postState(token) {
                    UpdateState(
                        phase = "error",
                        version = candidate.version,
                        message = describeUpdateError(error),
                        pageUrl = candidate.pageUrl,
                    )
                }
            }
        }
    }

    /**
     * Revalidate the cached archive and open Android's package installer.
     * On API 26+, the system settings page is opened first when this source is not trusted.
     */
    fun install() {
        val token: Long
        val candidate: ReleaseCandidate
        synchronized(lock) {
            if (closed) return
            val current = release ?: cachedCandidateFromMetadata() ?: return
            generation += 1
            token = generation
            activeJob?.cancel(true)
            candidate = current
            release = current
        }
        postState(token) {
            UpdateState(
                phase = "downloaded",
                version = candidate.version,
                message = "Preparing the installer…",
                pageUrl = candidate.pageUrl,
            )
        }
        activeJob = executor.submit {
            try {
                val file = validCachedApk(candidate)
                    ?: throw IOException("The downloaded update is incomplete or invalid.")
                if (!isCurrent(token)) return@submit
                mainHandler.post {
                    if (!isCurrent(token)) return@post
                    try {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                            !appContext.packageManager.canRequestPackageInstalls()
                        ) {
                            val settingsIntent = Intent(
                                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                Uri.parse("package:${appContext.packageName}"),
                            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            appContext.startActivity(settingsIntent)
                            state = UpdateState(
                                phase = "downloaded",
                                version = candidate.version,
                                message = "Allow installs from this source, then tap Install again.",
                                pageUrl = candidate.pageUrl,
                            )
                        } else {
                            val contentUri = FileProvider.getUriForFile(
                                appContext,
                                "${appContext.packageName}.files",
                                file,
                            )
                            val installIntent = Intent(Intent.ACTION_INSTALL_PACKAGE).apply {
                                setDataAndType(contentUri, APK_MIME_TYPE)
                                clipData = ClipData.newRawUri("FastVibe update", contentUri)
                                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                            }
                            appContext.startActivity(installIntent)
                            state = UpdateState(
                                phase = "downloaded",
                                version = candidate.version,
                                message = "Opening the Android installer…",
                                pageUrl = candidate.pageUrl,
                            )
                        }
                    } catch (error: Throwable) {
                        state = UpdateState(
                            phase = "error",
                            version = candidate.version,
                            message = describeUpdateError(error),
                            pageUrl = candidate.pageUrl,
                        )
                    }
                }
            } catch (cancelled: InterruptedException) {
                Thread.currentThread().interrupt()
            } catch (error: Throwable) {
                if (isCurrent(token)) {
                    postState(token) {
                        UpdateState(
                            phase = "error",
                            version = candidate.version,
                            message = describeUpdateError(error),
                            pageUrl = candidate.pageUrl,
                        )
                    }
                }
            }
        }
    }

    /** Hide the current prompt while leaving a completed APK in cache for a later retry. */
    fun dismiss() {
        synchronized(lock) {
            if (closed) return
            generation += 1
            activeJob?.cancel(true)
            release = null
        }
        postStateAny { UpdateState() }
    }

    /** Stop network and worker activity. A cached APK is intentionally retained. */
    fun close() {
        synchronized(lock) {
            if (closed) return
            closed = true
            generation += 1
            activeJob?.cancel(true)
            activeConnection?.disconnect()
            activeConnection = null
            release = null
        }
        executor.shutdownNow()
        mainHandler.removeCallbacksAndMessages(null)
    }

    private fun restoreDownloadedCache() {
        try {
            val candidate = cachedCandidateFromMetadata() ?: return
            if (compareVersions(candidate.version, CURRENT_VERSION) <= 0) return
            if (validCachedApk(candidate) == null) {
                clearDownloadedMetadata(candidate)
                return
            }
            synchronized(lock) {
                if (!closed && generation == 0L) release = candidate
            }
            postState(0L) {
                UpdateState(
                    phase = "downloaded",
                    version = candidate.version,
                    pageUrl = candidate.pageUrl,
                )
            }
        } catch (_: Throwable) {
            // A cache is an optimisation; a later explicit check can recover from it.
        }
    }

    private fun findReleaseAndRemember(token: Long): ReleaseCandidate? {
        if (!isCurrent(token)) return null
        val selectedChannel = channel
        val refs = requestText(refsUrl(selectedChannel), REQUEST_TIMEOUT_MS)
        val newerVersions = versionsFromAdvertisement(refs)
            .filter { compareVersions(it, CURRENT_VERSION) > 0 }
        var found: ReleaseCandidate? = null
        for (version in newerVersions.take(MAX_TAGS_TRIED)) {
            if (!isCurrent(token)) return null
            val name = apkAssetName(version)
            val url = apkDownloadUrl(version, name, selectedChannel)
            val head = head(url, REQUEST_TIMEOUT_MS)
            if (head.status == HttpURLConnection.HTTP_NOT_FOUND) continue
            if (head.status !in 200..299) throw UpdateHttpException(head.status, url)
            found = ReleaseCandidate(
                version = version,
                apkName = name,
                apkUrl = url,
                pageUrl = releasePageUrl(version, selectedChannel),
                expectedBytes = head.contentLength,
            )
            break
        }
        writeCheckCache(found)
        return found
    }

    private fun cachedCheck(): ReleaseCandidate? {
        val now = System.currentTimeMillis()
        val backoffUntil = preferences.getLong(KEY_BACKOFF_UNTIL, 0L)
        if (backoffUntil > now) throw UpdateHttpException(429, refsUrl(channel))
        val checkedAt = preferences.getLong(KEY_CHECKED_AT, 0L)
        if (checkedAt <= 0L || now - checkedAt >= CHECK_FRESH_MS) {
            return findReleaseAndRemember(currentGeneration())
        }
        if (!preferences.getBoolean(KEY_CHECK_HAS_RELEASE, false)) return null
        return cachedCandidateFromCheck()
    }

    private fun cachedCandidateFromCheck(): ReleaseCandidate? {
        val version = preferences.getString(KEY_CHECK_VERSION, null) ?: return null
        parseVersion(version) ?: return null
        if (compareVersions(version, CURRENT_VERSION) <= 0) return null
        val name = apkAssetName(version)
        val url = apkDownloadUrl(version, name, channel)
        val storedUrl = preferences.getString(KEY_CHECK_URL, null)
        if (storedUrl != null && storedUrl != url) return null
        return ReleaseCandidate(
            version = version,
            apkName = name,
            apkUrl = url,
            pageUrl = releasePageUrl(version, channel),
            expectedBytes = preferences.getLong(KEY_CHECK_BYTES, 0L).coerceAtLeast(0L),
        )
    }

    private fun cachedCandidateFromMetadata(): ReleaseCandidate? {
        val version = preferences.getString(KEY_DOWNLOAD_VERSION, null) ?: return null
        if (parseVersion(version) == null || compareVersions(version, CURRENT_VERSION) <= 0) return null
        val name = apkAssetName(version)
        val url = apkDownloadUrl(version, name, channel)
        val storedName = preferences.getString(KEY_DOWNLOAD_NAME, null)
        val storedUrl = preferences.getString(KEY_DOWNLOAD_URL, null)
        if (storedName != null && storedName != name) return null
        if (storedUrl != null && storedUrl != url) return null
        return ReleaseCandidate(
            version = version,
            apkName = name,
            apkUrl = url,
            pageUrl = releasePageUrl(version, channel),
            expectedBytes = preferences.getLong(KEY_DOWNLOAD_BYTES, 0L).coerceAtLeast(0L),
        )
    }

    private fun validCachedApk(candidate: ReleaseCandidate): File? {
        val file = File(updateDirectory, candidate.apkName)
        if (!file.isFile) return null
        val error = validateApk(file, candidate.version, candidate.expectedBytes)
        if (error != null) return null
        return file
    }

    private fun downloadCandidate(
        candidate: ReleaseCandidate,
        token: Long,
        part: File,
    ): File {
        if (candidate.expectedBytes > MAX_APK_BYTES) {
            throw IOException("The update archive is too large.")
        }
        updateDirectory.mkdirs()
        val deadline = deadlineAfter(DOWNLOAD_TIMEOUT_MS)
        val connection = openConnection(candidate.apkUrl, "GET", deadline)
        try {
            val status = connection.responseCode
            if (status !in 200..299) throw UpdateHttpException(status, candidate.apkUrl)
            val responseLength = connection.contentLengthLong
            if (responseLength > MAX_APK_BYTES) throw IOException("The update archive is too large.")
            if (candidate.expectedBytes > 0L && responseLength > 0L && responseLength != candidate.expectedBytes) {
                throw IOException("The update archive changed while downloading.")
            }
            val target = File(updateDirectory, candidate.apkName)
            val temp = part
            temp.delete()
            var received = 0L
            var lastProgressAt = 0L
            connection.readTimeout = remainingMillis(deadline).toInt().coerceAtLeast(1)
            connection.inputStream.use { input ->
                FileOutputStream(temp).use { output ->
                    val buffer = ByteArray(DOWNLOAD_BUFFER_BYTES)
                    while (true) {
                        if (!isCurrent(token)) throw InterruptedException()
                        val remaining = remainingMillis(deadline)
                        if (remaining <= 0L) throw SocketTimeoutException("download timed out")
                        connection.readTimeout = remaining.toInt().coerceAtMost(Int.MAX_VALUE).coerceAtLeast(1)
                        val count = input.read(buffer)
                        if (count < 0) break
                        if (count == 0) continue
                        received += count.toLong()
                        if (received > MAX_APK_BYTES) throw IOException("The update archive is too large.")
                        output.write(buffer, 0, count)
                        val now = System.nanoTime()
                        if (now - lastProgressAt >= PROGRESS_INTERVAL_NS) {
                            lastProgressAt = now
                            val total = when {
                                candidate.expectedBytes > 0L -> candidate.expectedBytes
                                responseLength > 0L -> responseLength
                                else -> 0L
                            }
                            val progress = if (total > 0L) (received.toFloat() / total).coerceIn(0f, 1f) else null
                            postState(token) { it.copy(progress = progress) }
                        }
                    }
                    output.fd.sync()
                }
            }
            val expected = when {
                candidate.expectedBytes > 0L -> candidate.expectedBytes
                responseLength > 0L -> responseLength
                else -> 0L
            }
            if (received <= 0L || (expected > 0L && received != expected)) {
                throw IOException("The update archive was truncated.")
            }
            if (!temp.renameTo(target)) throw IOException("Could not save the downloaded update.")
            val validationError = validateApk(target, candidate.version, expected)
            if (validationError != null) {
                target.delete()
                throw IOException(validationError)
            }
            removeOtherApks(target)
            return target
        } finally {
            clearActiveConnection(connection)
            connection.disconnect()
        }
    }

    private fun validateApk(file: File, expectedVersion: String, expectedBytes: Long): String? {
        if (!file.isFile || file.length() <= 0L) return "The downloaded update is incomplete."
        if (expectedBytes > 0L && file.length() != expectedBytes) return "The downloaded update is truncated."
        val packageManager = appContext.packageManager
        val archive = archivePackageInfo(packageManager, file)
            ?: return "Android could not read the downloaded APK."
        if (archive.packageName != appContext.packageName) return "The downloaded APK is for a different app."
        if (archive.versionName != expectedVersion) return "The downloaded APK version does not match its release tag."
        val installed = try {
            installedPackageInfo(packageManager)
        } catch (_: PackageManager.NameNotFoundException) {
            return "The installed app package could not be read."
        }
        if (archiveVersionCode(archive) <= installedVersionCode(installed)) {
            return "The downloaded APK is not newer than this app."
        }
        val installedSigners = signingCertificates(installed)
        val archiveSigners = signingCertificates(archive)
        if (!signingCertificatesCompatible(
                installedCurrent = installedSigners.current,
                archiveCurrent = archiveSigners.current,
                archiveHistory = archiveSigners.history,
            )
        ) {
            return "The downloaded APK is not signed by the installed app."
        }
        return null
    }

    @Suppress("DEPRECATION")
    private fun archivePackageInfo(packageManager: PackageManager, file: File): PackageInfo? {
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            PackageManager.GET_SIGNING_CERTIFICATES
        } else {
            PackageManager.GET_SIGNATURES
        }
        return packageManager.getPackageArchiveInfo(file.absolutePath, flags)
    }

    @Suppress("DEPRECATION")
    private fun installedPackageInfo(packageManager: PackageManager): PackageInfo {
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            PackageManager.GET_SIGNING_CERTIFICATES
        } else {
            PackageManager.GET_SIGNATURES
        }
        return packageManager.getPackageInfo(appContext.packageName, flags)
    }

    private data class SigningCertificates(
        val current: Set<String>,
        val history: Set<String>,
    )

    private fun signingCertificates(packageInfo: PackageInfo): SigningCertificates {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val signingInfo = packageInfo.signingInfo ?: return SigningCertificates(emptySet(), emptySet())
            val current = signingInfo.apkContentsSigners
                .orEmpty()
                .map { it.toByteArray().sha256Hex() }
                .toSet()
            val history = if (signingInfo.hasMultipleSigners()) {
                emptySet()
            } else {
                signingInfo.signingCertificateHistory
                    .orEmpty()
                    .map { it.toByteArray().sha256Hex() }
                    .toSet()
            }
            return SigningCertificates(current, history)
        }
        @Suppress("DEPRECATION")
        val current = packageInfo.signatures
            .orEmpty()
            .map { it.toByteArray().sha256Hex() }
            .toSet()
        return SigningCertificates(current, current)
    }

    private fun ByteArray.sha256Hex(): String =
        MessageDigest.getInstance("SHA-256").digest(this).toHex()

    private fun writeDownloadedMetadata(candidate: ReleaseCandidate) {
        preferences.edit()
            .putString(KEY_DOWNLOAD_VERSION, candidate.version)
            .putString(KEY_DOWNLOAD_NAME, candidate.apkName)
            .putString(KEY_DOWNLOAD_URL, candidate.apkUrl)
            .putLong(KEY_DOWNLOAD_BYTES, candidate.expectedBytes)
            .apply()
    }

    private fun clearDownloadedMetadata(candidate: ReleaseCandidate) {
        val stored = preferences.getString(KEY_DOWNLOAD_VERSION, null)
        if (stored == null || stored == candidate.version) {
            preferences.edit()
                .remove(KEY_DOWNLOAD_VERSION)
                .remove(KEY_DOWNLOAD_NAME)
                .remove(KEY_DOWNLOAD_URL)
                .remove(KEY_DOWNLOAD_BYTES)
                .apply()
        }
    }

    private fun writeCheckCache(candidate: ReleaseCandidate?) {
        val editor = preferences.edit().putLong(KEY_CHECKED_AT, System.currentTimeMillis())
        if (candidate == null) {
            editor.putBoolean(KEY_CHECK_HAS_RELEASE, false)
                .remove(KEY_CHECK_VERSION)
                .remove(KEY_CHECK_URL)
                .remove(KEY_CHECK_BYTES)
        } else {
            editor.putBoolean(KEY_CHECK_HAS_RELEASE, true)
                .putString(KEY_CHECK_VERSION, candidate.version)
                .putString(KEY_CHECK_URL, candidate.apkUrl)
                .putLong(KEY_CHECK_BYTES, candidate.expectedBytes)
        }
        editor.apply()
    }

    private fun rememberBackoff() {
        preferences.edit()
            .putLong(KEY_BACKOFF_UNTIL, System.currentTimeMillis() + BACKOFF_MS)
            .apply()
    }

    private fun removeOtherApks(current: File) {
        updateDirectory.listFiles()?.forEach { file ->
            if (file.isFile && file.extension.equals("apk", ignoreCase = true) && file != current) file.delete()
        }
    }

    private fun requestText(url: String, timeoutMs: Long): String {
        val deadline = deadlineAfter(timeoutMs)
        val connection = openConnection(url, "GET", deadline)
        try {
            val status = connection.responseCode
            if (status !in 200..299) throw UpdateHttpException(status, url)
            val bytes = connection.inputStream.use { input -> readAtMost(input, MAX_REFS_BYTES, deadline, connection) }
            return bytes.toString(Charsets.ISO_8859_1)
        } finally {
            clearActiveConnection(connection)
            connection.disconnect()
        }
    }

    private fun head(url: String, timeoutMs: Long): HeadResponse {
        val deadline = deadlineAfter(timeoutMs)
        val connection = openConnection(url, "HEAD", deadline)
        try {
            return HeadResponse(connection.responseCode, connection.contentLengthLong.coerceAtLeast(0L))
        } finally {
            clearActiveConnection(connection)
            connection.disconnect()
        }
    }

    private fun openConnection(url: String, method: String, deadline: Long): HttpURLConnection {
        var next = URI(url).toURL()
        repeat(MAX_REDIRECTS + 1) { redirectNumber ->
            if (next.protocol != HTTPS_SCHEME) throw IOException("Update URL must use HTTPS.")
            val remaining = remainingMillis(deadline)
            if (remaining <= 0L) throw SocketTimeoutException("request timed out")
            val connection = (next.openConnection() as? HttpURLConnection)
                ?: throw IOException("Unsupported update connection.")
            connection.instanceFollowRedirects = false
            connection.requestMethod = method
            connection.connectTimeout = remaining.toInt().coerceAtMost(Int.MAX_VALUE).coerceAtLeast(1)
            connection.readTimeout = remaining.toInt().coerceAtMost(Int.MAX_VALUE).coerceAtLeast(1)
            connection.setRequestProperty("User-Agent", "FastVibe/$CURRENT_VERSION")
            connection.setRequestProperty("Accept-Encoding", "identity")
            synchronized(lock) {
                if (closed) {
                    connection.disconnect()
                    throw InterruptedException()
                }
                activeConnection = connection
            }
            val status = connection.responseCode
            if (status !in REDIRECT_STATUSES) return connection
            val location = connection.getHeaderField("Location")
            clearActiveConnection(connection)
            connection.disconnect()
            if (location.isNullOrBlank()) throw IOException("Update server returned an invalid redirect.")
            if (redirectNumber == MAX_REDIRECTS) throw IOException("Too many update redirects.")
            next = URI(next.toString()).resolve(location).toURL()
        }
        throw IOException("Too many update redirects.")
    }

    private fun readAtMost(
        input: InputStream,
        maximum: Int,
        deadline: Long,
        connection: HttpURLConnection,
    ): ByteArray {
        val output = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(DOWNLOAD_BUFFER_BYTES)
        var total = 0
        while (true) {
            val remaining = remainingMillis(deadline)
            if (remaining <= 0L) throw SocketTimeoutException("request timed out")
            connection.readTimeout = remaining.toInt().coerceAtMost(Int.MAX_VALUE).coerceAtLeast(1)
            val count = input.read(buffer)
            if (count < 0) break
            if (count == 0) continue
            total += count
            if (total > maximum) throw IOException("The update ref advertisement is too large.")
            output.write(buffer, 0, count)
        }
        return output.toByteArray()
    }

    private fun deadlineAfter(timeoutMs: Long): Long =
        System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)

    private fun remainingMillis(deadline: Long): Long {
        val nanos = deadline - System.nanoTime()
        return if (nanos <= 0L) 0L else TimeUnit.NANOSECONDS.toMillis(nanos).coerceAtLeast(1L)
    }

    private fun clearActiveConnection(connection: HttpURLConnection) {
        synchronized(lock) {
            if (activeConnection === connection) activeConnection = null
        }
    }

    private fun currentGeneration(): Long = synchronized(lock) { generation }

    private fun isCurrent(token: Long): Boolean = synchronized(lock) { isCurrentLocked(token) }

    private fun isCurrentLocked(token: Long): Boolean = !closed && generation == token

    private fun postState(token: Long, transform: (UpdateState) -> UpdateState) {
        mainHandler.post {
            if (!isCurrent(token)) return@post
            state = transform(state)
        }
    }

    private fun postStateAny(transform: () -> UpdateState) {
        mainHandler.post {
            synchronized(lock) {
                if (closed) return@post
            }
            state = transform()
        }
    }

    private fun describeUpdateError(error: Throwable): String = when (error) {
        is SocketTimeoutException -> "The update check or download timed out."
        is UpdateHttpException -> when (error.status) {
            403, 429 -> "GitHub temporarily rate limited update checks. Try again later."
            404 -> "The update package is not published yet."
            else -> "GitHub returned HTTP ${error.status}."
        }
        is InterruptedException -> "Update cancelled."
        else -> error.message?.takeIf { it.isNotBlank() } ?: "Could not complete the update."
    }

    private data class ReleaseCandidate(
        val version: String,
        val apkName: String,
        val apkUrl: String,
        val pageUrl: String,
        val expectedBytes: Long,
    )

    private data class HeadResponse(val status: Int, val contentLength: Long)

    private class UpdateHttpException(val status: Int, url: String) : IOException("HTTP $status from $url")

    private companion object {
        private const val HTTPS_SCHEME = "https"
        private const val APK_MIME_TYPE = "application/vnd.android.package-archive"
        private const val PREFERENCES_NAME = "fastvibe.android.update.v1"
        private const val KEY_CHANNEL = "channel"
        private const val KEY_CHECKED_AT = "checkedAt"
        private const val KEY_CHECK_HAS_RELEASE = "checkHasRelease"
        private const val KEY_CHECK_VERSION = "checkVersion"
        private const val KEY_CHECK_URL = "checkUrl"
        private const val KEY_CHECK_BYTES = "checkBytes"
        private const val KEY_BACKOFF_UNTIL = "backoffUntil"
        private const val KEY_DOWNLOAD_VERSION = "downloadVersion"
        private const val KEY_DOWNLOAD_NAME = "downloadName"
        private const val KEY_DOWNLOAD_URL = "downloadUrl"
        private const val KEY_DOWNLOAD_BYTES = "downloadBytes"
        private const val CHECK_FRESH_MS = 10 * 60 * 1000L
        private const val BACKOFF_MS = 30 * 60 * 1000L
        private const val REQUEST_TIMEOUT_MS = 15_000L
        private const val DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000L
        private const val MAX_REFS_BYTES = 4 * 1024 * 1024
        private const val MAX_REDIRECTS = 5
        private const val MAX_TAGS_TRIED = 3
        private const val MAX_APK_BYTES = 512L * 1024L * 1024L
        private const val DOWNLOAD_BUFFER_BYTES = 64 * 1024
        private const val PROGRESS_INTERVAL_NS = 100_000_000L
        private val REDIRECT_STATUSES = setOf(301, 302, 303, 307, 308)
        private val CURRENT_VERSION = BuildConfig.VERSION_NAME
    }
}

internal data class UpdateVersion(val major: Int, val minor: Int, val patch: Int)

internal fun signingCertificatesCompatible(
    installedCurrent: Set<String>,
    archiveCurrent: Set<String>,
    archiveHistory: Set<String>,
): Boolean {
    if (installedCurrent.isEmpty() || archiveCurrent.isEmpty()) return false
    if (installedCurrent.size != 1 || archiveCurrent.size != 1) return installedCurrent == archiveCurrent
    val installed = installedCurrent.single()
    val archive = archiveCurrent.single()
    return installed == archive || installed in archiveHistory
}

private const val RELEASE_TAG_PREFIX = "app-v"

internal fun parseVersion(raw: String): UpdateVersion? {
    val match = Regex("^v?(\\d+)\\.(\\d+)\\.(\\d+)$").matchEntire(raw.trim()) ?: return null
    return try {
        UpdateVersion(match.groupValues[1].toInt(), match.groupValues[2].toInt(), match.groupValues[3].toInt())
    } catch (_: NumberFormatException) {
        null
    }
}

internal fun compareVersions(leftRaw: String, rightRaw: String): Int {
    val left = parseVersion(leftRaw)
    val right = parseVersion(rightRaw)
    if (left == null || right == null) return if (left != null) 1 else if (right != null) -1 else 0
    return compareValuesBy(left, right, { it.major }, { it.minor }, { it.patch })
}

internal fun versionFromRef(ref: String): String? {
    val prefix = "refs/tags/$RELEASE_TAG_PREFIX"
    if (!ref.startsWith(prefix)) return null
    val version = ref.removePrefix(prefix)
    return version.takeIf { parseVersion(it) != null }
}

/** Extract strict app-v tags from Git's pkt-line advertisement, newest first. */
internal fun versionsFromAdvertisement(body: String): List<String> {
    val versions = Regex("refs/tags/([^\\s\\u0000]+)")
        .findAll(body)
        .mapNotNull { versionFromRef(it.groupValues[0]) }
        .toSet()
        .toList()
    return versions.sortedWith { left, right -> compareVersions(right, left) }
}

internal fun apkAssetName(version: String): String = "FastVibe-app-v$version-arm64-v8a.apk"

internal fun refsUrl(channel: UpdateChannel = UpdateChannel.GITHUB): String =
    channel.url("$UPDATE_REPOSITORY.git/info/refs?service=git-upload-pack")

internal fun apkDownloadUrl(
    version: String,
    name: String = apkAssetName(version),
    channel: UpdateChannel = UpdateChannel.GITHUB,
): String = channel.url("$UPDATE_REPOSITORY/releases/download/app-v$version/$name")

internal fun releasePageUrl(version: String, channel: UpdateChannel = UpdateChannel.GITHUB): String =
    channel.url("$UPDATE_REPOSITORY/releases/tag/app-v$version")

private fun PackageInfo.versionCodeForUpdate(): Long =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) longVersionCode else versionCode.toLong()

private fun ByteArray.toHex(): String = buildString(size * 2) {
    for (byte in this@toHex) append("%02X".format(Locale.US, byte.toInt() and 0xff))
}

private fun archiveVersionCode(packageInfo: PackageInfo): Long = packageInfo.versionCodeForUpdate()
private fun installedVersionCode(packageInfo: PackageInfo): Long = packageInfo.versionCodeForUpdate()
