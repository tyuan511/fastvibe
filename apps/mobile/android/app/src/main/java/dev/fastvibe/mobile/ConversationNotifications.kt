package dev.fastvibe.mobile

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONArray

internal class ConversationNotifications(context: Context) {
    private val context = context.applicationContext
    private val manager = NotificationManagerCompat.from(this.context)
    private val notified = mutableMapOf<String, Int>()

    init {
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL, "等待操作", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "电脑上的会话正在等待你的回答。"
                },
            )
        }
    }

    fun update(pendingUi: JSONArray, activeConversationId: String?, foreground: Boolean) {
        val requests = (0 until pendingUi.length()).mapNotNull(pendingUi::optJSONObject)
            .filter { it.optString("method") in setOf("confirm", "select", "input", "editor", "questions") }
        val currentIds = requests.map { it.optString("id") }.filter(String::isNotBlank).toSet()
        notified.keys.toList().filterNot(currentIds::contains).forEach { id ->
            notified.remove(id)?.let(manager::cancel)
        }
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        if (!manager.areNotificationsEnabled()) return
        requests.forEach { request ->
            val id = request.optString("id").takeIf(String::isNotBlank) ?: return@forEach
            val conversationId = request.optString("conversationId").takeIf(String::isNotBlank) ?: return@forEach
            if (id in notified || (foreground && activeConversationId == conversationId)) return@forEach
            val number = id.hashCode() and Int.MAX_VALUE
            val intent = Intent(context, MainActivity::class.java)
                .setAction("dev.fastvibe.mobile.OPEN_CONVERSATION")
                .putExtra("conversationId", conversationId)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            val pending = PendingIntent.getActivity(context, number, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val notice = NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("会话正在等待你的操作")
                .setContentText("点按打开会话并回答。")
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setContentIntent(pending)
                .setAutoCancel(true)
                .build()
            try {
                manager.notify(number, notice)
                notified[id] = number
            } catch (_: SecurityException) {
                // Notification permission can be revoked between the check and delivery.
            }
        }
    }

    fun clear() {
        notified.values.forEach(manager::cancel)
        notified.clear()
    }

    private companion object { const val CHANNEL = "fastvibe-pending-ui" }
}
