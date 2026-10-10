package dev.fastvibe.fastvibe_mobile

import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.view.Surface
import android.view.SurfaceHolder
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.android.FlutterSurfaceView
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.ByteArrayOutputStream

class MainActivity : FlutterActivity() {
    // Xiaomi, OPPO, vivo and Samsung leave a third-party window on 60Hz until it
    // names a faster mode. Flutter then reads that 60 and schedules every scroll
    // frame against it, so the list and the transcript never leave 60.
    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        applyHighRefreshRate()
        super.onCreate(savedInstanceState)
        applyHighRefreshRate()
    }

    override fun onResume() {
        super.onResume()
        // Some skins drop the window back to 60 while it is in the background.
        applyHighRefreshRate()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) applyHighRefreshRate()
    }

    override fun onFlutterSurfaceViewCreated(flutterSurfaceView: FlutterSurfaceView) {
        super.onFlutterSurfaceViewCreated(flutterSurfaceView)
        val holder = flutterSurfaceView.holder
        holder.addCallback(surfaceFrameRateCallback)
        if (holder.surface?.isValid == true) requestSurfaceFrameRate(holder)
    }

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

    private val surfaceFrameRateCallback = object : SurfaceHolder.Callback {
        override fun surfaceCreated(holder: SurfaceHolder) = requestSurfaceFrameRate(holder)
        override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) =
            requestSurfaceFrameRate(holder)
        override fun surfaceDestroyed(holder: SurfaceHolder) {}
    }

    private fun applyHighRefreshRate() {
        try {
            val screen = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                this.display
            } else {
                @Suppress("DEPRECATION")
                windowManager.defaultDisplay
            } ?: return
            val current = screen.mode
            val best = screen.supportedModes
                .filter {
                    it.physicalWidth == current.physicalWidth &&
                        it.physicalHeight == current.physicalHeight
                }
                .maxByOrNull { it.refreshRate } ?: return
            val params = window.attributes
            if (params.preferredDisplayModeId == best.modeId &&
                best.refreshRate <= current.refreshRate + 0.5f
            ) {
                return
            }
            params.preferredDisplayModeId = best.modeId
            // Older skins still read this and ignore preferredDisplayModeId on its own.
            @Suppress("DEPRECATION")
            params.preferredRefreshRate = best.refreshRate
            window.attributes = params
        } catch (_: Exception) {
        }
    }

    private fun requestSurfaceFrameRate(holder: SurfaceHolder) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        val surface = holder.surface
        if (surface == null || !surface.isValid) return
        val rate = try {
            val screen = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                this.display
            } else {
                @Suppress("DEPRECATION")
                windowManager.defaultDisplay
            } ?: return
            screen.supportedModes
                .filter {
                    it.physicalWidth == screen.mode.physicalWidth &&
                        it.physicalHeight == screen.mode.physicalHeight
                }
                .maxOfOrNull { it.refreshRate } ?: return
        } catch (_: Exception) {
            return
        }
        if (rate <= 60.5f) return
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                surface.setFrameRate(
                    rate,
                    Surface.FRAME_RATE_COMPATIBILITY_DEFAULT,
                    Surface.CHANGE_FRAME_RATE_ALWAYS,
                )
            } else {
                surface.setFrameRate(rate, Surface.FRAME_RATE_COMPATIBILITY_DEFAULT)
            }
        } catch (_: Exception) {
        }
    }
}
