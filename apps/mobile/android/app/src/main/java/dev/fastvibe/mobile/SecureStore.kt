package dev.fastvibe.mobile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.net.URI
import java.security.KeyStore
import java.security.PrivateKey
import java.security.spec.MGF1ParameterSpec
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource

internal class SecureStore(context: Context) {
    private val context = context.applicationContext
    private val preferences = this.context.getSharedPreferences("fastvibe-secure", Context.MODE_PRIVATE)
    private val alias = "fastvibe.mobile.aes"

    private fun key(): javax.crypto.SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (!store.containsAlias(alias)) {
            KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
                init(
                    KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .setUserAuthenticationRequired(false)
                        .build(),
                )
                generateKey()
            }
        }
        return (store.getEntry(alias, null) as KeyStore.SecretKeyEntry).secretKey
    }

    private fun encrypt(value: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        return Base64.encodeToString(cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
    }

    fun put(name: String, value: String) {
        check(preferences.edit().putString(name, encrypt(value)).commit()) { "无法保存登录信息，请重试。" }
    }

    var readFailure: String? = null
        private set

    fun get(name: String): String? {
        if (!preferences.contains(name)) return null
        return try {
            val encoded = preferences.getString(name, null) ?: error("stored value missing")
            val bytes = Base64.decode(encoded, Base64.NO_WRAP)
            require(bytes.size >= 28)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
        } catch (_: Exception) {
            readFailure = "无法读取已保存的登录信息，请重新登录。旧数据已保留。"
            null
        }
    }

    fun remove(name: String) {
        check(preferences.edit().remove(name).commit()) { "无法保存设置，请重试。" }
    }

    fun saveAccount(token: String, origin: String, user: String? = null) {
        require(token.isNotBlank())
        require(isAccountOrigin(origin)) { "账号服务地址无效。" }
        val editor = preferences.edit()
            .putString("token", encrypt(token))
            .putString("tokenOrigin", encrypt(origin))
            .putBoolean("flutterAccountMigrationComplete", true)
        if (user != null) editor.putString("accountUser", encrypt(user))
        else editor.remove("accountUser")
        check(editor.commit()) { "无法保存登录信息，请重试。" }
        readFailure = null
    }

    fun clearAccount() {
        // Keeping this marker prevents an old Flutter credential from restoring a signed-out account.
        check(
            preferences.edit().remove("token").remove("tokenOrigin").remove("accountUser")
                .putBoolean("flutterAccountMigrationComplete", true).commit(),
        ) { "无法退出登录，请重试。" }
    }

    fun migrateFlutterAccount(): Boolean {
        if (get("token") != null && get("tokenOrigin") != null) return true
        if (preferences.getBoolean("flutterAccountMigrationComplete", false)) return false
        val metadata = context.getSharedPreferences("FlutterSharedPreferences", Context.MODE_PRIVATE)
            .getString("flutter.fastvibe.account.v1", null) ?: return false
        return runCatching {
            val meta = JSONObject(metadata)
            val origin = meta.optString("origin")
            require(isAccountOrigin(origin))
            val oldPreferences = context.getSharedPreferences("FlutterSecureStorage", Context.MODE_PRIVATE)
            val encryptedToken = oldPreferences.getString(flutterAccountTokenKey, null) ?: return false
            val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            val privateKey = store.getKey("${context.packageName}.FlutterSecureStoragePluginKeyOAEP", null)
                as? PrivateKey ?: return false
            val keyPreferences = context.getSharedPreferences("FlutterSecureKeyStorage", Context.MODE_PRIVATE)
            val wrappedKey = keyPreferences.getString(flutterWrappedKeyName, null) ?: return false
            val rsa = Cipher.getInstance("RSA/ECB/OAEPPadding", "AndroidKeyStoreBCWorkaround")
            rsa.init(
                Cipher.UNWRAP_MODE, privateKey,
                OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA1, PSource.PSpecified.DEFAULT),
            )
            val aesKey = rsa.unwrap(Base64.decode(wrappedKey, Base64.DEFAULT), "AES", Cipher.SECRET_KEY)
            val bytes = Base64.decode(encryptedToken, Base64.DEFAULT)
            require(bytes.size >= 28)
            val decryptor = Cipher.getInstance("AES/GCM/NoPadding")
            decryptor.init(Cipher.DECRYPT_MODE, aesKey, GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            val token = String(decryptor.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
            saveAccount(token, origin, meta.optJSONObject("user")?.toString())
            true
        }.getOrElse {
            readFailure = "无法迁移旧版的登录信息，请重新登录。旧数据已保留。"
            false
        }
    }

    companion object {
        private val flutterAccountTokenKey = Base64.encodeToString(
            "This is the prefix for a secure storage\n".toByteArray(Charsets.UTF_8), Base64.NO_WRAP,
        ).trimEnd('=') + "_fv.account.token"
        private val flutterWrappedKeyName = "AES" + Base64.encodeToString(
            "This is the key for a secure storage AES Key\n".toByteArray(Charsets.UTF_8), Base64.NO_WRAP,
        ).trimEnd('=')

        private fun isAccountOrigin(raw: String): Boolean = runCatching {
            val uri = URI(raw)
            (uri.scheme == "https" || (uri.scheme == "http" && uri.host in setOf("localhost", "127.0.0.1", "::1"))) &&
                !uri.host.isNullOrBlank() && uri.rawUserInfo == null && uri.rawQuery == null &&
                uri.rawFragment == null && uri.path in setOf("", "/")
        }.getOrDefault(false)
    }
}
