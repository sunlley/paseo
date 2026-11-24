package sh.paseo.widget

import org.json.JSONArray
import org.json.JSONObject

// Mirrors packages/app/src/widget/pad-widget-snapshot.ts. The JS side owns what goes in; this file only reads it.

data class WRequest(val tool: String, val title: String?, val command: String?, val cwd: String?, val description: String?)

data class WUsage(val contextPercent: Int?, val inputTokens: Long?, val outputTokens: Long?, val costUsd: Double?)

data class WAgent(
  val serverId: String,
  val id: String,
  /** needs_input / failed / attention / running */
  val bucket: String,
  val title: String,
  val provider: String,
  val model: String?,
  val hostLabel: String,
  val workspace: String,
  val attentionAt: Long?,
  val request: WRequest?,
  val error: String?,
  val turnStartedAt: Long?,
  val thinking: String?,
  val usage: WUsage?,
  /** Provider subagents (Claude Task and the like) still running / failed under this agent. */
  val subagentsRunning: Int,
  val subagentsFailed: Int,
)

data class WHost(val serverId: String, val label: String, val online: Boolean, val connection: String?, val latencyMs: Int?)

data class WSnapshot(
  val updatedAt: Long,
  val needsInput: Int,
  val failed: Int,
  val running: Int,
  val finished: Int,
  val totalAgents: Int,
  val tokens: Long,
  val costUsd: Double,
  val hosts: List<WHost>,
  val agents: List<WAgent>,
) {
  companion object {
    private const val VERSION = 1

    /** Null when there is nothing usable: never written, unreadable, or written by a newer app. */
    fun decode(text: String?): WSnapshot? {
      val o = runCatching { JSONObject(text ?: return null) }.getOrNull() ?: return null
      if (o.optInt("v") != VERSION) return null
      return runCatching {
        val counts = o.getJSONObject("counts")
        val usage = o.optJSONObject("usage")
        WSnapshot(
          updatedAt = o.getLong("updatedAt"),
          needsInput = counts.optInt("needsInput"),
          failed = counts.optInt("failed"),
          running = counts.optInt("running"),
          finished = counts.optInt("finished"),
          totalAgents = o.optInt("totalAgents"),
          tokens = usage?.optLong("tokens") ?: 0L,
          costUsd = usage?.optDouble("costUsd") ?: 0.0,
          hosts = o.optJSONArray("hosts").objects().map { h ->
            WHost(h.getString("serverId"), h.getString("label"), h.optBoolean("online"), h.str("connection"), h.int("latencyMs"))
          },
          agents = o.optJSONArray("agents").objects().map { a ->
            WAgent(
              serverId = a.getString("serverId"),
              id = a.getString("id"),
              bucket = a.getString("bucket"),
              title = a.getString("title"),
              provider = a.getString("provider"),
              model = a.str("model"),
              hostLabel = a.getString("hostLabel"),
              workspace = a.getString("workspace"),
              attentionAt = a.long("attentionAt"),
              request = a.optJSONObject("request")?.let { r ->
                WRequest(r.getString("tool"), r.str("title"), r.str("command"), r.str("cwd"), r.str("description"))
              },
              error = a.str("error"),
              turnStartedAt = a.long("turnStartedAt"),
              thinking = a.str("thinking"),
              usage = a.optJSONObject("usage")?.let { u ->
                WUsage(u.int("contextPercent"), u.long("inputTokens"), u.long("outputTokens"), u.double("costUsd"))
              },
              subagentsRunning = a.optJSONObject("subagents")?.optInt("running") ?: 0,
              subagentsFailed = a.optJSONObject("subagents")?.optInt("failed") ?: 0,
            )
          },
        )
      }.getOrNull()
    }
  }
}

private fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else (0 until length()).map { getJSONObject(it) }
private fun JSONObject.str(k: String): String? = if (!has(k) || isNull(k)) null else getString(k)
private fun JSONObject.long(k: String): Long? = if (!has(k) || isNull(k)) null else getLong(k)
private fun JSONObject.int(k: String): Int? = if (!has(k) || isNull(k)) null else getInt(k)
private fun JSONObject.double(k: String): Double? = if (!has(k) || isNull(k)) null else getDouble(k)
