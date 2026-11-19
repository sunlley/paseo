package sh.paseo.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.LinearProgressIndicator
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.currentState
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.ColumnScope
import androidx.glance.layout.Row
import androidx.glance.layout.RowScope
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxHeight
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextAlign

// Four display-only widgets (design: .dev/design/paseo-pad-widget.html). Xiaomi Pad sizes: 2×2 = 314×314 dp,
// 4×2 = 655×314 dp. Nothing on them acts on an agent; a row opens that agent in the app, anything else opens the app.

/** Every widget draws from the snapshot the app last pushed; none of them fetch. */
abstract class SnapshotWidget : GlanceAppWidget() {
  override val sizeMode = SizeMode.Exact

  override suspend fun provideGlance(context: Context, id: GlanceId) = provideContent {
    val s = WSnapshot.decode(currentState(PaseoWidgets.KEY) ?: PaseoWidgets.read(context))
    if (s == null) OpenAppHint() else Card { Content(s) }
  }

  @Composable
  abstract fun Content(s: WSnapshot)
}

private fun GlanceModifier.openAgent(context: Context, agent: WAgent) =
  clickable(actionStartActivity(PaseoWidgets.openAgent(context, agent)))

// 2×2 A · 状态环 ------------------------------------------------------------------------------------------------------

class StatusWidget : SnapshotWidget() {
  @Composable
  override fun Content(s: WSnapshot) {
    val context = LocalContext.current
    val host = s.hosts.firstOrNull { it.online } ?: s.hosts.firstOrNull()
    Column(GlanceModifier.fillMaxSize().padding(horizontal = 18.dp, vertical = 16.dp)) {
      Header(s, host?.let { "${it.label} ${connection(context, it)}" })
      Row(GlanceModifier.fillMaxWidth().padding(top = 10.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        RingWithCount(s, 128f, 13f, 40)
        Spacer(GlanceModifier.width(18.dp))
        Column(GlanceModifier.defaultWeight()) {
          LegendRow(R.string.paseo_widget_running, P.run, s.running.toString())
          LegendRow(R.string.paseo_widget_failed, P.err, s.failed.toString())
          LegendRow(R.string.paseo_widget_finished, P.done, s.finished.toString())
          LegendRow(R.string.paseo_widget_recent, P.surface2, money(s.costUsd), last = true)
        }
      }
      Divider()
      Row(GlanceModifier.fillMaxWidth().padding(vertical = 10.dp)) {
        for (i in 0 until 6) {
          val agent = s.agents.getOrNull(i)
          Column(GlanceModifier.defaultWeight(), horizontalAlignment = Alignment.CenterHorizontally) {
            if (agent != null) {
              Text(agent.title, style = style(11.5.sp, P.muted, align = TextAlign.Center), maxLines = 1,
                modifier = GlanceModifier.padding(horizontal = 2.dp).openAgent(context, agent))
              Spacer(GlanceModifier.height(4.dp))
              Dot(bucketColor(agent.bucket))
              Spacer(GlanceModifier.height(4.dp))
              Text(
                if (agent.bucket == "running") since(context, agent.turnStartedAt) else bucketWord(context, agent.bucket),
                style = style(13.sp, if (agent.bucket == "running") P.fg else bucketColor(agent.bucket), FontWeight.Bold),
                maxLines = 1,
              )
            }
          }
        }
      }
      Divider()
      Spacer(GlanceModifier.defaultWeight())
      val first = s.agents.firstOrNull()
      if (first == null) {
        Text(context.s(R.string.paseo_widget_nothing_running), style = style(13.sp, P.muted), maxLines = 1)
      } else {
        Row(GlanceModifier.fillMaxWidth().openAgent(context, first), verticalAlignment = Alignment.CenterVertically) {
          ProviderTile(first.provider)
          Spacer(GlanceModifier.width(10.dp))
          Column(GlanceModifier.defaultWeight()) {
            Text(first.title, style = style(13.sp, P.fg), maxLines = 1)
            Text(detail(context, first), style = style(12.sp, if (first.error != null) P.err else P.muted, mono = first.request != null), maxLines = 1)
          }
          Text(
            if (first.bucket == "running") since(context, first.turnStartedAt)
            else "${context.s(R.string.paseo_widget_waited)} ${since(context, first.attentionAt)}",
            style = style(12.sp, bucketColor(first.bucket)), maxLines = 1,
          )
        }
      }
    }
  }
}

@Composable
private fun RingWithCount(s: WSnapshot, sizeDp: Float, strokeDp: Float, bigSp: Int) {
  val context = LocalContext.current
  Box(GlanceModifier.size(sizeDp.dp), contentAlignment = Alignment.Center) {
    Image(ImageProvider(donut(context, s, sizeDp, strokeDp)), null, GlanceModifier.fillMaxSize())
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
      Text(s.needsInput.toString(), style = style(bigSp.sp, if (s.needsInput > 0) P.wait else P.xmuted, FontWeight.Medium), maxLines = 1)
      Text(context.s(R.string.paseo_widget_waiting_for_you), style = style(11.sp, P.muted), maxLines = 1)
    }
  }
}

@Composable
private fun LegendRow(label: Int, color: androidx.glance.unit.ColorProvider, value: String, last: Boolean = false) {
  val context = LocalContext.current
  Row(GlanceModifier.fillMaxWidth().padding(bottom = if (last) 0.dp else 8.dp), verticalAlignment = Alignment.CenterVertically) {
    Box(GlanceModifier.size(8.dp).cornerRadius(3.dp).background(color)) {}
    Spacer(GlanceModifier.width(7.dp))
    Text(context.s(label), style = style(13.sp, P.muted), maxLines = 1, modifier = GlanceModifier.defaultWeight())
    Text(value, style = style(13.sp, P.fg, FontWeight.Bold), maxLines = 1)
  }
}

// 2×2 B · 焦点卡 ------------------------------------------------------------------------------------------------------

class FocusWidget : SnapshotWidget() {
  @Composable
  override fun Content(s: WSnapshot) {
    val first = s.agents.firstOrNull()
    Column(GlanceModifier.fillMaxSize().padding(horizontal = 18.dp, vertical = 16.dp)) {
      when {
        first == null -> {
          Header(s)
          Quiet(s)
        }
        first.bucket == "running" -> RunningFocus(s, first)
        else -> AttentionFocus(s, first)
      }
    }
  }
}

@Composable
private fun FocusTop(tag: String, color: androidx.glance.unit.ColorProvider, tint: androidx.glance.unit.ColorProvider, right: String) {
  Row(GlanceModifier.fillMaxWidth().height(22.dp), verticalAlignment = Alignment.CenterVertically) {
    Tag(tag, color, tint)
    Spacer(GlanceModifier.defaultWeight())
    Text(right, style = style(12.sp, P.muted), maxLines = 1)
  }
}

@Composable
private fun FocusTitle(agent: WAgent, meta: String) {
  val context = LocalContext.current
  Column(GlanceModifier.fillMaxWidth().openAgent(context, agent)) {
    Text(agent.title, style = style(18.sp, P.fg, FontWeight.Medium), maxLines = 1, modifier = GlanceModifier.padding(top = 10.dp))
    Row(GlanceModifier.padding(top = 3.dp), verticalAlignment = Alignment.CenterVertically) {
      ProviderTile(agent.provider, 18.dp)
      Spacer(GlanceModifier.width(6.dp))
      Text(meta, style = style(12.sp, P.muted), maxLines = 1)
    }
  }
}

@Composable
private fun ColumnScope.AttentionFocus(s: WSnapshot, agent: WAgent) {
  val context = LocalContext.current
  val waiting = agent.bucket == "needs_input"
  val (tag, color, tint) = when (agent.bucket) {
    "needs_input" -> Triple(R.string.paseo_widget_tag_permission, P.wait, P.waitTint)
    "failed" -> Triple(R.string.paseo_widget_tag_failed, P.err, P.errTint)
    else -> Triple(R.string.paseo_widget_tag_finished, P.done, P.doneTint)
  }
  val queue = if (waiting) s.needsInput else s.agents.count { it.bucket == agent.bucket }
  FocusTop(context.s(tag), color, tint, "1 / $queue")
  FocusTitle(agent, providerLine(agent))
  val request = agent.request
  if (request != null) {
    Column(GlanceModifier.fillMaxWidth().padding(top = 10.dp).cornerRadius(R.dimen.paseo_widget_radius).background(P.surface2).padding(horizontal = 11.dp, vertical = 8.dp)) {
      Row(GlanceModifier.fillMaxWidth()) {
        Text(request.tool, style = style(11.5.sp, P.muted), maxLines = 1, modifier = GlanceModifier.defaultWeight())
        request.cwd?.let { Text(it, style = style(11.5.sp, P.muted), maxLines = 1) }
      }
      Text(request.command ?: request.title ?: request.tool, style = style(12.sp, P.fg, mono = request.command != null), maxLines = 2,
        modifier = GlanceModifier.padding(top = 3.dp))
    }
    request.description?.let {
      Text(it, style = style(12.5.sp, P.fg), maxLines = 2, modifier = GlanceModifier.padding(top = 10.dp))
    }
  } else if (agent.error != null) {
    Text(agent.error, style = style(12.5.sp, P.err), maxLines = 4, modifier = GlanceModifier.padding(top = 12.dp))
  }
  Spacer(GlanceModifier.defaultWeight())
  Divider()
  val next = s.agents.getOrNull(1)
  Row(GlanceModifier.fillMaxWidth().padding(top = 12.dp)) {
    Stat(R.string.paseo_widget_waited, since(context, agent.attentionAt), color)
    Stat(
      R.string.paseo_widget_queue,
      if (queue > 1) context.s(R.string.paseo_widget_queue_more, queue - 1) else context.s(R.string.paseo_widget_queue_none),
    )
    Stat(R.string.paseo_widget_next, next?.title ?: "—")
  }
}

@Composable
private fun ColumnScope.RunningFocus(s: WSnapshot, agent: WAgent) {
  val context = LocalContext.current
  FocusTop(context.s(R.string.paseo_widget_tag_running), P.run, P.runTint, context.s(R.string.paseo_widget_n_running, s.running))
  FocusTitle(agent, "${agent.provider} · ${agent.workspace}")
  Row(GlanceModifier.padding(top = 12.dp), verticalAlignment = Alignment.Bottom) {
    Text(since(context, agent.turnStartedAt), style = style(40.sp, P.fg), maxLines = 1)
    Spacer(GlanceModifier.width(8.dp))
    Text(context.s(R.string.paseo_widget_this_turn), style = style(12.sp, P.muted), maxLines = 1, modifier = GlanceModifier.padding(bottom = 6.dp))
  }
  val percent = agent.usage?.contextPercent
  if (percent != null) {
    Row(GlanceModifier.fillMaxWidth().padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
      Text(context.s(R.string.paseo_widget_context), style = style(12.sp, P.muted), maxLines = 1)
      Spacer(GlanceModifier.width(8.dp))
      LinearProgressIndicator(
        progress = percent.coerceIn(0, 100) / 100f,
        modifier = GlanceModifier.defaultWeight().height(5.dp),
        color = if (percent >= 80) P.wait else P.fg,
        backgroundColor = P.surface2,
      )
      Spacer(GlanceModifier.width(8.dp))
      Text("$percent%", style = style(12.sp, P.muted), maxLines = 1)
    }
  }
  Spacer(GlanceModifier.defaultWeight())
  Divider()
  Row(GlanceModifier.fillMaxWidth().padding(top = 12.dp)) {
    Stat(R.string.paseo_widget_model, agent.model ?: "—")
    Stat(R.string.paseo_widget_thinking, agent.thinking ?: "—")
    Stat(R.string.paseo_widget_host, agent.hostLabel)
  }
  Row(GlanceModifier.fillMaxWidth().padding(top = 8.dp)) {
    Stat(R.string.paseo_widget_input, count(agent.usage?.inputTokens))
    Stat(R.string.paseo_widget_output, count(agent.usage?.outputTokens))
    Stat(R.string.paseo_widget_cost, money(agent.usage?.costUsd))
  }
}

@Composable
private fun RowScope.Stat(label: Int, value: String, color: androidx.glance.unit.ColorProvider = P.fg) {
  val context = LocalContext.current
  Column(GlanceModifier.defaultWeight()) {
    Text(context.s(label), style = style(11.5.sp, P.muted), maxLines = 1)
    Text(value, style = style(14.sp, color, FontWeight.Bold), maxLines = 1, modifier = GlanceModifier.padding(top = 1.dp))
  }
}

// 2×2 C · 列表 --------------------------------------------------------------------------------------------------------

class ListWidget : SnapshotWidget() {
  @Composable
  override fun Content(s: WSnapshot) {
    val context = LocalContext.current
    val shown = s.agents.take(4)
    Column(GlanceModifier.fillMaxSize().padding(horizontal = 18.dp, vertical = 16.dp)) {
      Header(s, trailing = if (System.currentTimeMillis() - s.updatedAt > STALE_MS) null else ({ CountChips(s) }))
      if (shown.isEmpty()) {
        Quiet(s)
        return@Column
      }
      Column(GlanceModifier.fillMaxWidth().defaultWeight().padding(top = 10.dp)) {
        for (agent in shown) {
          ListRow(agent, GlanceModifier.defaultWeight())
          Spacer(GlanceModifier.height(4.dp))
        }
        for (i in shown.size until 4) Spacer(GlanceModifier.defaultWeight())
      }
      Row(GlanceModifier.fillMaxWidth().padding(top = 4.dp)) {
        Text(rest(context, s, shown), style = style(11.5.sp, P.muted), maxLines = 1, modifier = GlanceModifier.defaultWeight())
        Text(context.s(R.string.paseo_widget_total, s.totalAgents), style = style(11.5.sp, P.muted), maxLines = 1)
      }
    }
  }
}

@Composable
private fun CountChips(s: WSnapshot) {
  Row(verticalAlignment = Alignment.CenterVertically) {
    for ((n, color) in listOf(s.needsInput to P.wait, s.running to P.run, s.failed to P.err)) {
      Row(
        GlanceModifier.cornerRadius(10.dp).background(P.surface2).padding(horizontal = 8.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Dot(color, 6.dp)
        Spacer(GlanceModifier.width(5.dp))
        Text(n.toString(), style = style(11.5.sp, P.muted), maxLines = 1)
      }
      Spacer(GlanceModifier.width(4.dp))
    }
  }
}

@Composable
private fun ListRow(agent: WAgent, modifier: GlanceModifier) {
  val context = LocalContext.current
  val tint = bucketTint(agent.bucket)
  Row(
    modifier.fillMaxWidth().cornerRadius(R.dimen.paseo_widget_radius)
      .then(if (tint != null) GlanceModifier.background(tint) else GlanceModifier)
      .padding(horizontal = 8.dp).openAgent(context, agent),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    ProviderTile(agent.provider)
    Spacer(GlanceModifier.width(10.dp))
    Column(GlanceModifier.defaultWeight()) {
      Text(agent.title, style = style(14.sp, P.fg, FontWeight.Medium), maxLines = 1)
      Text(detail(context, agent), style = style(11.5.sp, if (agent.error != null) P.err else P.muted, mono = agent.request?.command != null), maxLines = 1)
    }
    Column(horizontalAlignment = Alignment.End) {
      if (agent.bucket == "running") {
        Text(since(context, agent.turnStartedAt), style = style(12.sp, P.fg, FontWeight.Bold), maxLines = 1)
        agent.usage?.contextPercent?.let { Text("$it%", style = style(12.sp, P.muted), maxLines = 1) }
      } else {
        Text(bucketWord(context, agent.bucket), style = style(12.sp, bucketColor(agent.bucket), FontWeight.Medium), maxLines = 1)
        Text(since(context, agent.attentionAt), style = style(12.sp, P.muted), maxLines = 1)
      }
    }
  }
}

/** "1 more waiting, 2 running" for what did not fit. */
private fun rest(context: Context, s: WSnapshot, shown: List<WAgent>): String {
  val waiting = (s.needsInput - shown.count { it.bucket == "needs_input" }).coerceAtLeast(0)
  val running = (s.running - shown.count { it.bucket == "running" }).coerceAtLeast(0)
  return if (waiting + running == 0) "" else context.s(R.string.paseo_widget_more_footer, waiting, running)
}

// 4×2 A · 摘要 + 列表 -------------------------------------------------------------------------------------------------

class SummaryWidget : SnapshotWidget() {
  @Composable
  override fun Content(s: WSnapshot) {
    val context = LocalContext.current
    val shown = s.agents.take(3)
    Row(GlanceModifier.fillMaxSize()) {
      Column(GlanceModifier.width(232.dp).fillMaxHeight().padding(horizontal = 18.dp, vertical = 16.dp)) {
        Header(s)
        Row(GlanceModifier.fillMaxWidth().padding(top = 12.dp), verticalAlignment = Alignment.CenterVertically) {
          RingWithCount(s, 96f, 10f, 30)
          Spacer(GlanceModifier.width(14.dp))
          Column(GlanceModifier.defaultWeight()) {
            LegendRow(R.string.paseo_widget_running, P.run, s.running.toString())
            LegendRow(R.string.paseo_widget_failed, P.err, s.failed.toString())
            LegendRow(R.string.paseo_widget_finished, P.done, s.finished.toString(), last = true)
          }
        }
        Row(GlanceModifier.fillMaxWidth().padding(top = 12.dp)) {
          Stat(R.string.paseo_widget_recent, money(s.costUsd))
          Stat(R.string.paseo_widget_tokens, count(s.tokens))
          Stat(R.string.paseo_widget_agents, s.totalAgents.toString())
        }
        Spacer(GlanceModifier.defaultWeight())
        for (host in s.hosts.take(2)) {
          Row(GlanceModifier.fillMaxWidth().padding(top = 5.dp), verticalAlignment = Alignment.CenterVertically) {
            Dot(if (host.online) P.run else P.xmuted, 6.dp)
            Spacer(GlanceModifier.width(6.dp))
            Text("${host.label} · ${connection(context, host)}", style = style(12.sp, P.muted), maxLines = 1, modifier = GlanceModifier.defaultWeight())
            Text(host.latencyMs?.let { "$it ms" } ?: "", style = style(12.sp, P.fg, FontWeight.Medium), maxLines = 1)
          }
        }
      }
      Box(GlanceModifier.width(1.dp).fillMaxHeight().background(P.line)) {}
      Column(GlanceModifier.defaultWeight().fillMaxHeight().padding(start = 8.dp, end = 10.dp, top = 10.dp, bottom = 8.dp)) {
        if (shown.isEmpty()) {
          Quiet(s)
          return@Column
        }
        for (agent in shown) {
          SummaryItem(agent, GlanceModifier.defaultWeight())
          Spacer(GlanceModifier.height(4.dp))
        }
        for (i in shown.size until 3) Spacer(GlanceModifier.defaultWeight())
        Row(GlanceModifier.fillMaxWidth().padding(horizontal = 10.dp)) {
          Text(rest(context, s, shown), style = style(12.sp, P.muted), maxLines = 1, modifier = GlanceModifier.defaultWeight())
          Text(context.s(R.string.paseo_widget_total, s.totalAgents), style = style(12.sp, P.muted), maxLines = 1)
        }
      }
    }
  }
}

@Composable
private fun SummaryItem(agent: WAgent, modifier: GlanceModifier) {
  val context = LocalContext.current
  val tint = bucketTint(agent.bucket)
  Row(
    modifier.fillMaxWidth().cornerRadius(R.dimen.paseo_widget_radius)
      .then(if (tint != null) GlanceModifier.background(tint) else GlanceModifier)
      .padding(horizontal = 10.dp, vertical = 8.dp).openAgent(context, agent),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    ProviderTile(agent.provider)
    Spacer(GlanceModifier.width(10.dp))
    Column(GlanceModifier.defaultWeight()) {
      Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(agent.title, style = style(14.5.sp, P.fg, FontWeight.Medium), maxLines = 1, modifier = GlanceModifier.defaultWeight())
        when (agent.bucket) {
          "needs_input" -> Tag(context.s(R.string.paseo_widget_tag_waiting), P.wait, P.waitTint)
          "failed" -> Tag(context.s(R.string.paseo_widget_tag_failed), P.err, P.errTint)
          "attention" -> Tag(context.s(R.string.paseo_widget_tag_finished), P.done, P.doneTint)
          else -> agent.usage?.contextPercent?.let { percent ->
            Image(ImageProvider(contextRing(context, percent, 18f, 3f)), null, GlanceModifier.size(18.dp))
            Spacer(GlanceModifier.width(6.dp))
            Text("$percent%", style = style(12.sp, P.muted), maxLines = 1)
          }
        }
      }
      Text(
        if (agent.bucket == "running" && agent.subagentsRunning == 0) "${bucketWord(context, agent.bucket)} · ${agent.workspace}" else detail(context, agent),
        style = style(12.5.sp, if (agent.error != null) P.err else P.fg, mono = agent.request?.command != null),
        maxLines = 1, modifier = GlanceModifier.padding(top = 2.dp),
      )
      Row(GlanceModifier.fillMaxWidth().padding(top = 2.dp)) {
        Text(providerLine(agent), style = style(11.5.sp, P.muted), maxLines = 1, modifier = GlanceModifier.defaultWeight())
        Text(
          when (agent.bucket) {
            "running" -> listOfNotNull(since(context, agent.turnStartedAt), agent.usage?.costUsd?.let { money(it) }).joinToString(" · ")
            "needs_input" -> "${context.s(R.string.paseo_widget_waited)} ${since(context, agent.attentionAt)}"
            else -> context.s(R.string.paseo_widget_ago, since(context, agent.attentionAt))
          },
          style = style(11.5.sp, if (agent.bucket == "needs_input") P.wait else P.muted), maxLines = 1,
        )
      }
    }
  }
}
