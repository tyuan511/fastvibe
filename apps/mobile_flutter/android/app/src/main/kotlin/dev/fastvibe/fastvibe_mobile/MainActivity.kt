package dev.fastvibe.fastvibe_mobile

import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.ByteArrayOutputStream

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "dev.fastvibe.mobile/device")
            .setMethodCallHandler { call, result ->
                if (call.method == "openSettings") {
                    try {
                        startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
                        result.success(true)
                    } catch (_: Exception) { result.success(false) }
                    return@setMethodCallHandler
                }
                if (call.method == "deviceId") {
                    // ANDROID_ID: stable across reinstalls of an app signed with the same key,
                    // and the nearest thing to a device id an app is allowed to read.
                    result.success(Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID))
                    return@setMethodCallHandler
                }
                if (call.method != "readImage") {
                    result.notImplemented()
                    return@setMethodCallHandler
                }
                // Clipboard access happens only on the user's explicit Paste image action.
                val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                val clip = clipboard.primaryClip
                val uri = if (clip != null && clip.itemCount > 0) clip.getItemAt(0).uri else null
                if (uri == null || uri.scheme != "content") {
                    result.success(null)
                    return@setMethodCallHandler
                }
                Thread {
                    try {
                        if (contentResolver.getType(uri)?.startsWith("image/") != true) {
                            runOnUiThread { result.success(null) }
                            return@Thread
                        }
                        val bytes = contentResolver.openInputStream(uri)?.use { input ->
                            val output = ByteArrayOutputStream()
                            val buffer = ByteArray(8192)
                            while (true) {
                                val count = input.read(buffer)
                                if (count < 0) break
                                if (output.size() + count > 20 * 1024 * 1024) {
                                    throw IllegalArgumentException("image-too-large")
                                }
                                output.write(buffer, 0, count)
                            }
                            output.toByteArray()
                        }
                        runOnUiThread { result.success(bytes) }
                    } catch (_: Exception) {
                        runOnUiThread { result.error("image-unavailable", null, null) }
                    }
                }.start()
            }
    }
}
