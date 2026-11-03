package dev.fastvibe.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidUpdateTest {
    @Test
    fun parsesStrictVersionsAndComparesNumerically() {
        assertEquals(UpdateVersion(1, 2, 3), parseVersion("v1.2.3"))
        assertEquals(UpdateVersion(10, 0, 4), parseVersion("10.0.4"))
        assertNull(parseVersion("1.2"))
        assertNull(parseVersion("1.2.3-rc1"))
        assertTrue(compareVersions("0.10.0", "0.9.99") > 0)
        assertEquals(0, compareVersions("v1.2.3", "1.2.3"))
        assertTrue(compareVersions("1.2.3-rc1", "1.2.3") < 0)
    }

    @Test
    fun findsOnlyPublishedAppTagsAndSortsNewestFirst() {
        val advertisement = """
            0032abc refs/tags/app-v0.5.0
            0033abc refs/tags/app-v0.10.0
            0030abc refs/tags/v1.0.0
            0038abc refs/tags/app-v0.6.0-rc1
            0040abc refs/tags/app-v0.5.0^{}
        """.trimIndent()

        assertEquals(listOf("0.10.0", "0.5.0"), versionsFromAdvertisement(advertisement))
    }

    @Test
    fun signingPolicyAcceptsSameKeyAndAValidatedRotation() {
        assertTrue(signingCertificatesCompatible(setOf("old"), setOf("old"), setOf("old")))
        assertTrue(signingCertificatesCompatible(setOf("old"), setOf("new"), setOf("old", "new")))
        assertFalse(signingCertificatesCompatible(setOf("old"), setOf("new"), setOf("new")))
        assertFalse(signingCertificatesCompatible(setOf("old"), setOf("new"), emptySet()))
    }

    @Test
    fun signingPolicyRequiresExactSignerSetForMultiSignerPackages() {
        assertTrue(signingCertificatesCompatible(setOf("a", "b"), setOf("a", "b"), emptySet()))
        assertFalse(signingCertificatesCompatible(setOf("a", "b"), setOf("a", "c"), setOf("a", "b", "c")))
        assertFalse(signingCertificatesCompatible(emptySet(), setOf("a"), setOf("a")))
    }

    @Test
    fun releaseRefsRequireTheExactStableTagShape() {
        assertEquals("0.5.12", versionFromRef("refs/tags/app-v0.5.12"))
        assertNull(versionFromRef("refs/tags/app-v0.5.12^{}"))
        assertNull(versionFromRef("refs/tags/app-v0.5.12-rc1"))
        assertNull(versionFromRef("refs/tags/app-v0.5.12/evil"))
    }
    @Test
    fun buildsUpdateUrlsForEachChannel() {
        val version = "0.5.12"
        val name = apkAssetName(version)
        assertEquals(
            "https://github.com/tyuan511/fastvibe.git/info/refs?service=git-upload-pack",
            refsUrl(UpdateChannel.GITHUB),
        )
        assertEquals(
            "https://ghfast.top/https://github.com/tyuan511/fastvibe/releases/download/app-v$version/$name",
            apkDownloadUrl(version, name, UpdateChannel.GHFAST),
        )
        assertEquals(
            "https://gh-proxy.com/https://github.com/tyuan511/fastvibe/releases/tag/app-v$version",
            releasePageUrl(version, UpdateChannel.GH_PROXY),
        )
    }

    @Test
    fun unknownUpdateChannelFallsBackToOfficial() {
        assertEquals(UpdateChannel.GITHUB, UpdateChannel.fromKey("missing"))
        assertEquals(UpdateChannel.GITHUB, UpdateChannel.fromKey(null))
    }

    @Test
    fun buildsLegacyCompatibleArm64ReleaseUrls() {
        val version = "0.5.12"
        val name = "FastVibe-app-v0.5.12-arm64-v8a.apk"
        assertEquals(name, apkAssetName(version))
        assertEquals(
            "https://github.com/tyuan511/fastvibe/releases/download/app-v0.5.12/$name",
            apkDownloadUrl(version),
        )
        assertEquals(
            "https://github.com/tyuan511/fastvibe/releases/tag/app-v0.5.12",
            releasePageUrl(version),
        )
    }
}
