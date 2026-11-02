package dev.fastvibe.mobile

import android.content.Context
import android.content.ContextWrapper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.SecureRandom
import java.security.spec.MGF1ParameterSpec
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource
import javax.crypto.spec.SecretKeySpec

@RunWith(AndroidJUnit4::class)
class SecureStoreMigrationTest {
    private lateinit var context: Context
    private lateinit var store: SecureStore
    private lateinit var rsaAlias: String
    private val preferenceFiles = mutableSetOf<String>()

    @Before
    fun setUp() {
        val base = ApplicationProvider.getApplicationContext<Context>()
        val suffix = UUID.randomUUID().toString().replace("-", "")
        context = object : ContextWrapper(base) {
            override fun getApplicationContext(): Context = this
            override fun getPackageName(): String = "dev.fastvibe.mobile.test.$suffix"
            override fun getSharedPreferences(name: String, mode: Int): android.content.SharedPreferences {
                val testName = "migration-test-$suffix-$name"
                preferenceFiles.add(testName)
                return base.getSharedPreferences(testName, mode)
            }
        }
        store = SecureStore(context)
        rsaAlias = "${context.packageName}.FlutterSecureStoragePluginKeyOAEP"
    }

    @After
    fun tearDown() {
        val base = ApplicationProvider.getApplicationContext<Context>()
        preferenceFiles.forEach { base.deleteSharedPreferences(it) }
        KeyStore.getInstance("AndroidKeyStore").apply {
            load(null)
            if (containsAlias(rsaAlias)) deleteEntry(rsaAlias)
        }
    }

    private fun writeFlutterAccount(origin: String = "https://example.invalid", metadata: Boolean = true): String {
        val token = "test-only-token-${UUID.randomUUID()}"
        val pair = KeyPairGenerator.getInstance("RSA", "AndroidKeyStore").apply {
            initialize(
                KeyGenParameterSpec.Builder(rsaAlias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setDigests(KeyProperties.DIGEST_SHA256)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_RSA_OAEP)
                    .build(),
            )
        }.generateKeyPair()
        val aesKey = SecretKeySpec(ByteArray(16).also { SecureRandom().nextBytes(it) }, "AES")
        val rsa = Cipher.getInstance("RSA/ECB/OAEPPadding").apply {
            init(Cipher.WRAP_MODE, pair.public, OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA1, PSource.PSpecified.DEFAULT))
        }
        val encodedKeyName = "AES" + Base64.encodeToString(
            "This is the key for a secure storage AES Key\n".toByteArray(), Base64.NO_WRAP,
        ).trimEnd('=')
        context.getSharedPreferences("FlutterSecureKeyStorage", Context.MODE_PRIVATE).edit()
            .putString(encodedKeyName, Base64.encodeToString(rsa.wrap(aesKey), Base64.DEFAULT)).commit()
        val aes = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, aesKey) }
        val prefix = Base64.encodeToString("This is the prefix for a secure storage\n".toByteArray(), Base64.NO_WRAP).trimEnd('=')
        context.getSharedPreferences("FlutterSecureStorage", Context.MODE_PRIVATE).edit()
            .putString("${prefix}_fv.account.token", Base64.encodeToString(aes.iv + aes.doFinal(token.toByteArray()), Base64.DEFAULT)).commit()
        if (metadata) {
            val meta = JSONObject().put("origin", origin)
                .put("user", JSONObject().put("id", "test-user").put("login", "test-login"))
            context.getSharedPreferences("FlutterSharedPreferences", Context.MODE_PRIVATE).edit()
                .putString("flutter.fastvibe.account.v1", meta.toString()).commit()
        }
        return token
    }

    @Test
    fun migratesActualFlutterCipherFormatAndKeepsOldFiles() {
        val token = writeFlutterAccount()
        val old = context.getSharedPreferences("FlutterSecureStorage", Context.MODE_PRIVATE).all.toMap()
        assertTrue(store.migrateFlutterAccount())
        assertEquals(token, store.get("token"))
        assertEquals("https://example.invalid", store.get("tokenOrigin"))
        assertEquals("test-login", JSONObject(store.get("accountUser")!!).getString("login"))
        assertEquals(old, context.getSharedPreferences("FlutterSecureStorage", Context.MODE_PRIVATE).all)
        assertFalse(context.getSharedPreferences("fastvibe-secure", Context.MODE_PRIVATE).all.values.contains(token))
    }

    @Test
    fun neverSendsTokenToAssumedOriginWhenMetadataMissing() {
        writeFlutterAccount(metadata = false)
        assertFalse(store.migrateFlutterAccount())
        assertNull(store.get("token"))
        assertNull(store.get("tokenOrigin"))
    }

    @Test
    fun logoutCannotResurrectOldFlutterAccount() {
        writeFlutterAccount()
        assertTrue(store.migrateFlutterAccount())
        store.clearAccount()
        assertFalse(SecureStore(context).migrateFlutterAccount())
        assertNull(store.get("token"))
        assertNull(store.get("tokenOrigin"))
    }

    @Test
    fun invalidIssuerDoesNotPartiallyWriteToken() {
        writeFlutterAccount(origin = "https://example.invalid/path?unexpected=1")
        assertFalse(store.migrateFlutterAccount())
        assertNull(store.get("token"))
        assertNull(store.get("tokenOrigin"))
    }

    @Test
    fun rejectsLookalikeLegacyTokenKey() {
        writeFlutterAccount()
        val old = context.getSharedPreferences("FlutterSecureStorage", Context.MODE_PRIVATE)
        val entry = old.all.entries.single()
        old.edit().remove(entry.key).putString("unexpected_fv.account.token", entry.value as String).commit()
        assertFalse(store.migrateFlutterAccount())
        assertNull(store.get("token"))
    }

    @Test
    fun corruptionIsDistinctFromSignedOutAndPreservesBytes() {
        val prefs = context.getSharedPreferences("fastvibe-secure", Context.MODE_PRIVATE)
        prefs.edit().putString("token", "not-an-encrypted-token").commit()
        assertNull(store.get("token"))
        assertNotNull(store.readFailure)
        assertEquals("not-an-encrypted-token", prefs.getString("token", null))
    }

    @Test
    fun newAccountAtomicallyReplacesIdentity() {
        writeFlutterAccount()
        assertTrue(store.migrateFlutterAccount())
        store.saveAccount("replacement-test-token", "https://another.invalid")
        assertEquals("replacement-test-token", store.get("token"))
        assertEquals("https://another.invalid", store.get("tokenOrigin"))
        assertNull(store.get("accountUser"))
    }
}
