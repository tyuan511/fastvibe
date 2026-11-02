package dev.fastvibe.mobile

import android.content.Context
import android.os.Build
import android.provider.Settings

/** No Bluetooth access: the system setting is optional on vendor Android builds. */
internal fun mobileDeviceName(context: Context): String = resolveMobileDeviceName(
    readSystemName = { Settings.Global.getString(context.contentResolver, "device_name") },
    model = Build.MODEL,
)

internal fun resolveMobileDeviceName(readSystemName: () -> String?, model: String?): String =
    runCatching(readSystemName).getOrNull()?.trim()?.takeIf(String::isNotEmpty)
        ?: model?.trim()?.takeIf { it.isNotEmpty() && !it.equals("unknown", ignoreCase = true) }
        ?: "Android device"
