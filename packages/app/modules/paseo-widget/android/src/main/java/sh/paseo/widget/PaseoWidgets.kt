package sh.paseo.widget

import android.content.BroadcastReceiver
import android.content.Context
import android.content.IntentFilter
import android.os.Build
import android.content.Intent
import android.net.Uri
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.state.updateAppWidgetState
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File

/** The app pushes a JSON snapshot; every placed widget redraws from it. Widgets never fetch anything. */
object PaseoWidgets {
  val KEY = stringPreferencesKey("snapshot")
  private val lock = Mutex()

  private fun file(context: Context) = File(context.filesDir, "paseo-widget.json")

  fun read(context: Context): String? = runCatching { file(context).readText() }.getOrNull()

  private val kinds: List<Pair<Class<out GlanceAppWidget>, () -> GlanceAppWidget>> = listOf(
    StatusWidget::class.java to { StatusWidget() },
    FocusWidget::class.java to { FocusWidget() },
    ListWidget::class.java to { ListWidget() },
    SummaryWidget::class.java to { SummaryWidget() },
  )

  suspend fun isPlaced(context: Context): Boolean {
    val manager = GlanceAppWidgetManager(context)
    return kinds.any { (cls, _) -> manager.getGlanceIds(cls).isNotEmpty() }
  }

  /** Saves [text] for widgets placed later, then redraws the ones on the home screen. */
  suspend fun write(context: Context, text: String?) = lock.withLock {
    if (text != null) file(context).writeText(text)
    val stored = text ?: read(context) ?: return@withLock
    val manager = GlanceAppWidgetManager(context)
    for ((cls, make) in kinds) for (id in manager.getGlanceIds(cls)) runCatching {
      updateAppWidgetState(context, id) { it[KEY] = stored }
      make().update(context, id)
    }
  }

  fun openApp(context: Context): Intent =
    (context.packageManager.getLaunchIntentForPackage(context.packageName) ?: Intent())
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

  /** The stable agent URL; the app routes it on a cold start too (docs/expo-router.md, Agent Targets). */
  fun openAgent(context: Context, agent: WAgent): Intent =
    Intent(Intent.ACTION_VIEW, Uri.parse("paseo://h/${Uri.encode(agent.serverId)}/agent/${Uri.encode(agent.id)}"))
      .setPackage(context.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
}

/** A widget was just placed: draw the last snapshot the app saved. */
abstract class PaseoWidgetReceiver : GlanceAppWidgetReceiver() {
  override fun onUpdate(context: Context, manager: android.appwidget.AppWidgetManager, ids: IntArray) {
    super.onUpdate(context, manager, ids)
    // Glance's onUpdate already took goAsync(), so redraw on our own scope.
    CoroutineScope(Dispatchers.Default).launch { PaseoWidgets.write(context, null) }
  }

  override fun onDeleted(context: Context, appWidgetIds: IntArray) {
    super.onDeleted(context, appWidgetIds)
    stopKeepAliveIfUnused(context)
  }
}

/** The last widget left the home screen: nothing needs the connection any more. */
private fun stopKeepAliveIfUnused(context: Context) {
  CoroutineScope(Dispatchers.Default).launch {
    // The launcher's removal can still be in Glance's id list for a moment.
    delay(1_000)
    if (!PaseoWidgets.isPlaced(context)) KeepAliveService.stop(context)
  }
}

class StatusWidgetReceiver : PaseoWidgetReceiver() { override val glanceAppWidget: GlanceAppWidget = StatusWidget() }
class FocusWidgetReceiver : PaseoWidgetReceiver() { override val glanceAppWidget: GlanceAppWidget = FocusWidget() }
class ListWidgetReceiver : PaseoWidgetReceiver() { override val glanceAppWidget: GlanceAppWidget = ListWidget() }
class SummaryWidgetReceiver : PaseoWidgetReceiver() { override val glanceAppWidget: GlanceAppWidget = SummaryWidget() }

/**
 * React Native pauses JS timers when the activity pauses, unless a headless JS task is running
 * (JavaTimerManager.onHostPause). Without timers the daemon client stops pinging, and the daemon
 * closes the socket once its 45 s application lease expires. While widgets are placed we hold one
 * never-ending task (registered in use-pad-widget-sync.android.ts) so timers keep firing. Unlike
 * HeadlessJsTaskService this takes no wake lock: with the screen off the CPU still sleeps.
 */
internal object KeepAliveTask {
  const val KEY = "PaseoWidgetKeepAlive"
  private var taskId: Int? = null

  fun start(context: ReactContext) = UiThreadUtil.runOnUiThread {
    if (taskId != null) return@runOnUiThread
    taskId = runCatching {
      HeadlessJsTaskContext.getInstance(context)
        .startTask(HeadlessJsTaskConfig(KEY, Arguments.createMap(), 0, true))
    }.getOrNull()
  }

  fun stop(context: ReactContext) = UiThreadUtil.runOnUiThread {
    val id = taskId ?: return@runOnUiThread
    taskId = null
    runCatching { HeadlessJsTaskContext.getInstance(context).finishTask(id) }
  }
}

class PaseoWidgetModule : Module() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
  private var screenReceiver: BroadcastReceiver? = null

  /**
   * The socket drops while the screen is off (Xiaomi cuts background networking), and the
   * client's reconnect backoff has grown by the time it comes back on. Telling JS on screen-on
   * lets it reconnect at once, so the widgets are current when someone can see them.
   */
  private fun observeScreen(context: Context) {
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context, intent: Intent) {
        sendEvent("onScreenOn", emptyMap<String, Any>())
      }
    }
    val filter = IntentFilter().apply {
      addAction(Intent.ACTION_SCREEN_ON)
      addAction(Intent.ACTION_USER_PRESENT)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      context.registerReceiver(receiver, filter)
    }
    screenReceiver = receiver
  }

  override fun definition() = ModuleDefinition {
    Name("PaseoWidget")
    Events("onScreenOn")

    OnCreate {
      appContext.reactContext?.applicationContext?.let { observeScreen(it) }
    }

    OnDestroy {
      val receiver = screenReceiver ?: return@OnDestroy
      screenReceiver = null
      runCatching { appContext.reactContext?.applicationContext?.unregisterReceiver(receiver) }
    }

    AsyncFunction("isPlaced") Coroutine { ->
      val context = appContext.reactContext?.applicationContext ?: return@Coroutine false
      PaseoWidgets.isPlaced(context)
    }

    // Only callable while the app is in front: Android 12+ blocks starting it from the background.
    Function("startKeepAlive") { ->
      val react = appContext.reactContext as? ReactContext ?: return@Function false
      KeepAliveTask.start(react)
      KeepAliveService.start(react.applicationContext)
    }

    Function("stopKeepAlive") { ->
      val react = appContext.reactContext as? ReactContext ?: return@Function Unit
      KeepAliveTask.stop(react)
      KeepAliveService.stop(react.applicationContext)
    }

    Function("setSnapshot") { json: String ->
      val context = appContext.reactContext?.applicationContext ?: return@Function
      scope.launch { PaseoWidgets.write(context, json) }
    }
  }
}
