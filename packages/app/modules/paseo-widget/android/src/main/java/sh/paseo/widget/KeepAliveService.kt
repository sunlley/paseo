package sh.paseo.widget

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * Keeps the app process at foreground priority while a widget is on the home screen. Xiaomi's
 * SmartPower freezes a backgrounded app within seconds, which drops the daemon socket and leaves
 * the widgets on stale data. The service does no work itself; its only job is to exist.
 *
 * Android 12+ refuses to start it from the background, so the app starts it while in front
 * (usePadWidgetSync); removing the last widget stops it.
 */
class KeepAliveService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val notification = buildNotification(this)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    // Restarted without the app it would keep nothing alive; the app starts it again when it opens.
    return START_NOT_STICKY
  }

  companion object {
    private const val CHANNEL_ID = "paseo_widget_board"
    private const val NOTIFICATION_ID = 7301

    fun start(context: Context): Boolean = runCatching {
      context.startForegroundService(Intent(context, KeepAliveService::class.java))
    }.isSuccess

    fun stop(context: Context) {
      context.stopService(Intent(context, KeepAliveService::class.java))
    }

    private fun buildNotification(context: Context): Notification {
      val manager = context.getSystemService(NotificationManager::class.java)
      if (manager.getNotificationChannel(CHANNEL_ID) == null) {
        manager.createNotificationChannel(
          NotificationChannel(CHANNEL_ID, context.s(R.string.paseo_widget_channel), NotificationManager.IMPORTANCE_MIN).apply {
            setShowBadge(false)
          },
        )
      }
      val open = PendingIntent.getActivity(
        context, 0, PaseoWidgets.openApp(context),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      return Notification.Builder(context, CHANNEL_ID)
        .setSmallIcon(context.applicationInfo.icon)
        .setContentTitle(context.s(R.string.paseo_widget_keepalive_title))
        .setContentText(context.s(R.string.paseo_widget_keepalive_text))
        .setContentIntent(open)
        .setOngoing(true)
        .setShowWhen(false)
        .build()
    }
  }
}
