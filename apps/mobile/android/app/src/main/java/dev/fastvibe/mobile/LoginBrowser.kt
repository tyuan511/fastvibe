package dev.fastvibe.mobile

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri

internal fun openLoginBrowser(context: Context, url: String) {
    val uri = Uri.parse(url)
    require(uri.scheme in setOf("https", "http") && !uri.host.isNullOrBlank()) { "登录地址无效。" }
    val intent = Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)
    if (context !is Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    context.startActivity(intent)
}
