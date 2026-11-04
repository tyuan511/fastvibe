package dev.fastvibe.mobile

import android.content.Context
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Read-only bridge from the former native host. Flutter owns migration completion. */
internal class NativeStateMigration(context: Context) {
    private val preferences = context.applicationContext
        .getSharedPreferences("fastvibe-secure", Context.MODE_PRIVATE)

    fun read(): Map<String, Any> {
        // Snapshot presence and ciphertext together; never generate a missing Keystore key.
        val saved = preferences.all
        val fields = mapOf(
            "token" to "token", "origin" to "tokenOrigin",
            "user" to "accountUser", "identity" to "identity",
        )
        val present = fields.values.any(saved::containsKey) ||
            saved["flutterAccountMigrationComplete"] == true
        val result = mutableMapOf<String, Any>("present" to present)
        if (fields.values.none(saved::containsKey)) return result
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val key = store.getKey("fastvibe.mobile.aes", null) as? SecretKey
            ?: error("Native credential key is unavailable")
        for ((output, input) in fields) {
            if (!saved.containsKey(input)) continue
            val encoded = saved[input] as? String ?: error("Invalid native credential value")
            val bytes = Base64.decode(encoded, Base64.NO_WRAP)
            require(bytes.size >= 28) { "Invalid native credential ciphertext" }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            result[output] = String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
        }
        return result
    }
}
