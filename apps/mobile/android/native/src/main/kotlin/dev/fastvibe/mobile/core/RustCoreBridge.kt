package dev.fastvibe.mobile.core

import org.json.JSONObject

/**
 * JNI boundary for FastVibe's Rust mobile core.
 *
 * The native library is loaded from this AAR's jni/<abi> directory. Missing native
 * code is a configuration/build error, so calls fail with the build task that fixes it.
 * JSON is kept as the stable runtime API; JSONObject helpers are convenience only.
 */
class RustCoreBridge {
    companion object {
        private const val JNI_LIBRARY = "fastvibe_core_jni"
        private val loadFailure: UnsatisfiedLinkError?

        init {
            loadFailure = try {
                System.loadLibrary(JNI_LIBRARY)
                null
            } catch (error: UnsatisfiedLinkError) {
                error
            }
        }

        @JvmStatic
        private external fun nativeVersion(): String?

        @JvmStatic
        private external fun nativeApplyJson(input: String): String?

        @JvmStatic
        private external fun nativeCommandJson(input: String): String?

        /** Creates a command envelope consumed by the Rust runtime. */
        @JvmStatic
        fun commandRequestJson(method: String, payloadJson: String? = null): String = buildString {
            append("{\"action\":")
            append(quoteJson(method))
            if (payloadJson != null) {
                val payload = payloadJson.trim()
                require(payload.startsWith("{") && payload.endsWith("}")) { "payloadJson must be a JSON object" }
                val fields = payload.substring(1, payload.length - 1).trim()
                if (fields.isNotEmpty()) append(',').append(fields)
            }
            append('}')
        }

        private fun quoteJson(value: String): String = buildString {
            append('"')
            value.forEach { character ->
                when (character) {
                    '\\' -> append("\\\\")
                    '"' -> append("\\\"")
                    '\n' -> append("\\n")
                    '\r' -> append("\\r")
                    '\t' -> append("\\t")
                    else -> append(character)
                }
            }
            append('"')
        }
        @JvmStatic
        fun commandRequest(method: String, payload: JSONObject? = null): JSONObject =
            JSONObject(commandRequestJson(method, payload?.toString()))
    }

    private fun requireLoaded() {
        loadFailure?.let { error ->
            throw IllegalStateException(
                "FastVibe Rust core is unavailable. Run :native:buildRustAndroid " +
                    "and ensure the resulting AAR is packaged for this device ABI.",
                error,
            )
        }
    }

    /** Returns the Rust core version string. */
    fun version(): String {
        requireLoaded()
        return nativeVersion() ?: error("FastVibe Rust core returned no version")
    }

    /** Applies a snapshot or engine event and returns the bounded JSON state. */
    fun applyJson(input: String): String {
        requireLoaded()
        return nativeApplyJson(input)
            ?: error("FastVibe Rust core rejected invalid JSON input")
    }

    fun apply(input: String): JSONObject = JSONObject(applyJson(input))

    /** Applies a runtime command envelope through the same native JSON boundary. */
    fun commandJson(command: String): String {
        requireLoaded()
        return nativeCommandJson(command)
            ?: error("FastVibe Rust core rejected invalid command JSON")
    }

    fun command(method: String, payload: JSONObject? = null): JSONObject =
        JSONObject(commandJson(commandRequestJson(method, payload?.toString())))
}
