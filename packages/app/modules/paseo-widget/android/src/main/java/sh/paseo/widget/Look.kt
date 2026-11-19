package sh.paseo.widget

import android.content.Context
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.action.clickable
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.background
import androidx.glance.color.ColorProvider
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.text.FontFamily
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextAlign
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider as GlanceColor

// Colors are the app's Paseo light / Paseo dark tokens (packages/app/src/styles/theme.ts).
internal object P {
  val surface = ColorProvider(Color(0xFFFFFFFF), Color(0xFF181B1A))
  val surface1 = ColorProvider(Color(0xFFFAFAFA), Color(0xFF1E2120))
  val surface2 = ColorProvider(Color(0xFFF4F4F5), Color(0xFF272A29))
  val fg = ColorProvider(Color(0xFF1A1A1E), Color(0xFFFAFAFA))
  val muted = ColorProvider(Color(0xFF71717A), Color(0xFFA1A5A4))
  val xmuted = ColorProvider(Color(0xFFA1A1AA), Color(0xFF717574))
  val line = ColorProvider(Color(0x14111113), Color(0x14FFFFFF))
  val run = ColorProvider(Color(0xFF299F51), Color(0xFF35C264))
  val wait = ColorProvider(Color(0xFFB37824), Color(0xFFDB932E))
  val err = ColorProvider(Color(0xFFF12E2F), Color(0xFFF7796D))
  val done = ColorProvider(Color(0xFF3B82C4), Color(0xFF6AA8E0))
  val runTint = ColorProvider(Color(0x1A299F51), Color(0x1A35C264))
  val waitTint = ColorProvider(Color(0x1AB37824), Color(0x21DB932E))
  val errTint = ColorProvider(Color(0x14F12E2F), Color(0x1CF7796D))
  val doneTint = ColorProvider(Color(0x1A3B82C4), Color(0x1C6AA8E0))

  // The same tokens as raw ARGB, for the bitmaps Glance cannot draw itself (rings).
  fun raw(context: Context, lightArgb: Long, darkArgb: Long): Int = (if (dark(context)) darkArgb else lightArgb).toInt()
  fun runRaw(c: Context) = raw(c, 0xFF299F51, 0xFF35C264)
  fun waitRaw(c: Context) = raw(c, 0xFFB37824, 0xFFDB932E)
  fun errRaw(c: Context) = raw(c, 0xFFF12E2F, 0xFFF7796D)
  fun doneRaw(c: Context) = raw(c, 0xFF3B82C4, 0xFF6AA8E0)
  fun trackRaw(c: Context) = raw(c, 0xFFE4E4E7, 0xFF434645)
  fun fgRaw(c: Context) = raw(c, 0xFF1A1A1E, 0xFFFAFAFA)
}

/** Without a heartbeat for this long the app is gone and the numbers are old. */
internal const val STALE_MS = 5 * 60_000L

internal fun dark(context: Context) =
  context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES

internal fun Context.s(id: Int, vararg args: Any): String = getString(id, *args)

internal fun style(
  size: TextUnit,
  color: GlanceColor,
  weight: FontWeight = FontWeight.Normal,
  mono: Boolean = false,
  align: TextAlign? = null,
) = TextStyle(fontSize = size, color = color, fontWeight = weight, fontFamily = if (mono) FontFamily.Monospace else null, textAlign = align)

/** "12 min", "3 h": how long since [from]. */
internal fun since(context: Context, from: Long?, now: Long = System.currentTimeMillis()): String {
  if (from == null) return "—"
  val minutes = (now - from).coerceAtLeast(0) / 60_000
  return when {
    minutes < 1 -> context.s(R.string.paseo_widget_just_now)
    minutes < 60 -> context.s(R.string.paseo_widget_minutes, minutes.toInt())
    minutes < 1440 -> context.s(R.string.paseo_widget_hours, (minutes / 60).toInt())
    else -> context.s(R.string.paseo_widget_days, (minutes / 1440).toInt())
  }
}

internal fun money(usd: Double?): String = if (usd == null) "—" else "$" + String.format("%.2f", usd)

internal fun count(n: Long?): String = when {
  n == null -> "—"
  n >= 1_000_000 -> String.format("%.1fM", n / 1_000_000.0).replace(".0M", "M")
  n >= 1_000 -> "${n / 1_000}k"
  else -> n.toString()
}

internal fun bucketColor(bucket: String): GlanceColor = when (bucket) {
  "needs_input" -> P.wait
  "failed" -> P.err
  "attention" -> P.done
  else -> P.run
}

internal fun bucketTint(bucket: String): GlanceColor? = when (bucket) {
  "needs_input" -> P.waitTint
  "failed" -> P.errTint
  else -> null
}

internal fun bucketWord(context: Context, bucket: String): String = context.s(
  when (bucket) {
    "needs_input" -> R.string.paseo_widget_needs_input
    "failed" -> R.string.paseo_widget_failed
    "attention" -> R.string.paseo_widget_finished
    else -> R.string.paseo_widget_running
  },
)

internal fun connection(context: Context, host: WHost): String {
  if (!host.online) return context.s(R.string.paseo_widget_offline)
  return context.s(
    when (host.connection) {
      "relay" -> R.string.paseo_widget_conn_relay
      "remoteSsh" -> R.string.paseo_widget_conn_ssh
      "directSocket", "directPipe" -> R.string.paseo_widget_conn_local
      "routed" -> R.string.paseo_widget_conn_routed
      else -> R.string.paseo_widget_conn_direct
    },
  )
}

/** What the agent is doing or asking, in one line. */
internal fun detail(context: Context, agent: WAgent): String = when {
  agent.request != null -> agent.request.command ?: agent.request.title ?: agent.request.tool
  agent.error != null -> agent.error
  agent.subagentsRunning > 0 -> context.s(R.string.paseo_widget_subagents_running, agent.subagentsRunning)
  else -> listOfNotNull(agent.model, agent.hostLabel).joinToString(" · ")
}

internal fun providerLine(agent: WAgent): String = listOfNotNull(agent.provider, agent.model, agent.hostLabel).joinToString(" · ")

/** Segments in the sidebar's order: waiting, failed, running, finished. An empty fleet draws a plain track. */
internal fun donut(context: Context, s: WSnapshot, sizeDp: Float, strokeDp: Float): Bitmap {
  val density = context.resources.displayMetrics.density
  val px = (sizeDp * density).toInt()
  val stroke = strokeDp * density
  val bitmap = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888)
  val canvas = Canvas(bitmap)
  val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = stroke; strokeCap = Paint.Cap.BUTT }
  val oval = RectF(stroke / 2, stroke / 2, px - stroke / 2, px - stroke / 2)
  val parts = listOf(
    s.needsInput to P.waitRaw(context), s.failed to P.errRaw(context),
    s.running to P.runRaw(context), s.finished to P.doneRaw(context),
  ).filter { it.first > 0 }
  val total = parts.sumOf { it.first }
  if (total == 0) {
    paint.color = P.trackRaw(context)
    canvas.drawArc(oval, 0f, 360f, false, paint)
    return bitmap
  }
  val gap = if (parts.size > 1) 4f else 0f
  var start = -90f
  for ((value, color) in parts) {
    val sweep = 360f * value / total
    paint.color = color
    canvas.drawArc(oval, start + gap / 2, (sweep - gap).coerceAtLeast(1f), false, paint)
    start += sweep
  }
  return bitmap
}

/** The context-window ring next to a running agent. */
internal fun contextRing(context: Context, percent: Int, sizeDp: Float, strokeDp: Float): Bitmap {
  val density = context.resources.displayMetrics.density
  val px = (sizeDp * density).toInt()
  val stroke = strokeDp * density
  val bitmap = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888)
  val canvas = Canvas(bitmap)
  val oval = RectF(stroke / 2, stroke / 2, px - stroke / 2, px - stroke / 2)
  val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = stroke }
  paint.color = P.trackRaw(context)
  canvas.drawArc(oval, 0f, 360f, false, paint)
  paint.color = if (percent >= 80) P.waitRaw(context) else P.fgRaw(context)
  canvas.drawArc(oval, -90f, 360f * percent.coerceIn(0, 100) / 100f, false, paint)
  return bitmap
}

// Building blocks ---------------------------------------------------------------------------------------------------

@Composable
internal fun Card(content: @Composable () -> Unit) {
  val context = LocalContext.current
  Box(
    GlanceModifier.fillMaxSize().cornerRadius(R.dimen.paseo_widget_radius).background(P.surface)
      .clickable(actionStartActivity(PaseoWidgets.openApp(context))),
  ) { content() }
}

@Composable
internal fun Dot(color: GlanceColor, size: Dp = 7.dp) {
  Box(GlanceModifier.size(size).cornerRadius(size / 2).background(color)) {}
}

@Composable
internal fun Divider() {
  Box(GlanceModifier.fillMaxWidth().height(1.dp).background(P.line)) {}
}

@Composable
internal fun ProviderTile(provider: String, size: Dp = 22.dp) {
  Box(
    GlanceModifier.size(size).cornerRadius(if (size > 20.dp) 7.dp else 6.dp).background(P.surface2),
    contentAlignment = Alignment.Center,
  ) {
    Text(provider.take(1).uppercase(), style = style(if (size > 20.dp) 11.sp else 10.sp, P.fg, FontWeight.Bold), maxLines = 1)
  }
}

@Composable
internal fun Tag(text: String, color: GlanceColor, tint: GlanceColor) {
  Box(GlanceModifier.cornerRadius(11.dp).background(tint).padding(horizontal = 9.dp, vertical = 3.dp)) {
    Text(text, style = style(11.5.sp, color, FontWeight.Medium), maxLines = 1)
  }
}

/** "Paseo · <sub>" on the left, liveness on the right. */
@Composable
internal fun Header(s: WSnapshot, sub: String? = null, trailing: (@Composable () -> Unit)? = null) {
  val context = LocalContext.current
  Row(GlanceModifier.fillMaxWidth().height(20.dp), verticalAlignment = Alignment.CenterVertically) {
    Image(ImageProvider(R.drawable.paseo_widget_mark), "Paseo", GlanceModifier.size(20.dp))
    Spacer(GlanceModifier.width(8.dp))
    Text("Paseo", style = style(13.sp, P.fg, FontWeight.Medium), maxLines = 1)
    if (sub != null) Text(" · $sub", style = style(13.sp, P.muted), maxLines = 1, modifier = GlanceModifier.defaultWeight())
    else Spacer(GlanceModifier.defaultWeight())
    if (trailing != null) trailing() else Liveness(s, context)
  }
}

@Composable
internal fun Liveness(s: WSnapshot, context: Context) {
  val age = System.currentTimeMillis() - s.updatedAt
  if (age > STALE_MS) {
    Text(context.s(R.string.paseo_widget_ago, since(context, s.updatedAt)), style = style(12.sp, P.wait), maxLines = 1)
  } else {
    Row(verticalAlignment = Alignment.CenterVertically) {
      Dot(P.run)
      Spacer(GlanceModifier.width(6.dp))
      Text(context.s(R.string.paseo_widget_live), style = style(12.sp, P.muted), maxLines = 1)
    }
  }
}

/** Nothing saved yet: the app has not run since the widget was placed. */
@Composable
internal fun OpenAppHint() {
  val context = LocalContext.current
  Card {
    Column(
      GlanceModifier.fillMaxSize().padding(18.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalAlignment = Alignment.CenterHorizontally,
    ) {
      Image(ImageProvider(R.drawable.paseo_widget_mark), "Paseo", GlanceModifier.size(28.dp))
      Spacer(GlanceModifier.height(10.dp))
      Text(context.s(R.string.paseo_widget_open_app), style = style(13.sp, P.muted), maxLines = 2)
    }
  }
}

/** No agent to show: say whether that is because everything is quiet or because no host answers. */
@Composable
internal fun Quiet(s: WSnapshot) {
  val context = LocalContext.current
  val online = s.hosts.count { it.online }
  Column(
    GlanceModifier.fillMaxSize(),
    verticalAlignment = Alignment.CenterVertically,
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Text(
      context.s(if (online == 0) R.string.paseo_widget_cant_reach else R.string.paseo_widget_nothing_running),
      style = style(14.sp, P.fg, FontWeight.Medium), maxLines = 1,
    )
    Spacer(GlanceModifier.height(4.dp))
    Text(
      if (online == 0) s.hosts.joinToString(" · ") { it.label } else context.s(R.string.paseo_widget_hosts_online, online),
      style = style(12.sp, P.muted), maxLines = 1,
    )
  }
}
