import {
  type PluginButtonContentProps,
  useSubscription,
  useTranslation,
} from "@getpaseo/plugin/client";
import type React from "react";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { type WorkItem, type WorkItemStatus, watchWorkItems } from "../shared/work-items.js";
import { messages } from "./messages.js";

type Colors = PluginButtonContentProps["theme"]["colors"];

export function statusColor(colors: Colors, status: WorkItemStatus): string {
  if (status === "in_progress") return colors.statusSuccess;
  if (status === "needs_review") return colors.statusWarning;
  if (status === "blocked") return colors.statusDanger;
  return colors.foregroundMuted;
}

/** Current session's open item first, then its most recent finished one. */
export function sessionItem(items: readonly WorkItem[], agentId: string): WorkItem | null {
  const rank = (entry: WorkItem) => (entry.status === "done" ? 1 : 0);
  const own = items.filter((entry) => entry.agentId === agentId);
  own.sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt));
  return own[0] ?? null;
}

function useStyles(colors: Colors) {
  return useMemo(
    () => ({
      root: { width: 440, maxWidth: "100%" as const, gap: 10, paddingVertical: 4 },
      header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      title: { color: colors.foreground, fontSize: 13.5, fontWeight: "500" as const },
      scope: {
        color: colors.foregroundMuted,
        fontSize: 11.5,
        backgroundColor: colors.surface2,
        borderRadius: 999,
        paddingHorizontal: 9,
        paddingVertical: 2,
      },
      live: { marginLeft: "auto" as const, color: colors.foregroundMuted, fontSize: 12 },
      card: { borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12, gap: 8 },
      line: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      itemTitle: { flex: 1, color: colors.foreground, fontSize: 14, fontWeight: "500" as const },
      muted: { color: colors.foregroundMuted, fontSize: 12 },
      body: { color: colors.foreground, fontSize: 12.5 },
      track: {
        flex: 1,
        height: 4,
        borderRadius: 2,
        backgroundColor: colors.surface2,
        overflow: "hidden" as const,
      },
      section: { color: colors.foregroundMuted, fontSize: 12, marginTop: 2 },
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingVertical: 6,
      },
      rowTitle: { flex: 1, color: colors.foreground, fontSize: 13 },
    }),
    [colors],
  );
}

function Badge({ text, color, background }: { text: string; color: string; background: string }) {
  const style = useMemo(
    () => ({
      color,
      backgroundColor: background,
      fontSize: 11,
      fontWeight: "500" as const,
      borderRadius: 999,
      paddingHorizontal: 8,
      paddingVertical: 2,
      overflow: "hidden" as const,
    }),
    [color, background],
  );
  return <Text style={style}>{text}</Text>;
}

type Styles = ReturnType<typeof useStyles>;
function CurrentCard({
  item,
  colors,
  styles,
  kindBadge,
  statusBadge,
}: {
  item: WorkItem;
  colors: Colors;
  styles: Styles;
  kindBadge: React.ReactNode;
  statusBadge: React.ReactNode;
}) {
  const { t } = useTranslation(messages);
  const accent = statusColor(colors, item.status);
  const percent = item.progress?.total
    ? Math.round((item.progress.done / item.progress.total) * 100)
    : 0;
  const fill = useMemo(
    () => ({ width: `${percent}%` as const, height: "100%" as const, backgroundColor: accent }),
    [percent, accent],
  );
  const note = useMemo(() => ({ ...styles.body, color: accent }), [styles.body, accent]);
  return (
    <View style={styles.card}>
      <View style={styles.line}>
        {kindBadge}
        <Text style={styles.itemTitle} numberOfLines={1}>
          {item.title}
        </Text>
        {statusBadge}
      </View>
      {item.progress && item.progress.total > 0 ? (
        <View style={styles.line}>
          <View style={styles.track}>
            <View style={fill} />
          </View>
          <Text style={styles.muted}>
            {t("steps", { done: item.progress.done, total: item.progress.total })}
          </Text>
        </View>
      ) : null}
      {item.currentStep ? (
        <Text style={styles.body} numberOfLines={1}>
          {item.currentStep}
        </Text>
      ) : null}
      {item.note ? (
        <Text style={note} numberOfLines={2}>
          {item.note}
        </Text>
      ) : null}
      {item.pr?.number != null ? (
        <Text style={styles.muted}>
          {t(item.pr.merged ? "prMerged" : "prOpen", { number: item.pr.number })}
        </Text>
      ) : null}
    </View>
  );
}

export function WorkItemsPanel(props: PluginButtonContentProps) {
  // Pills always open in an agent context; the header-button shape is never used here.
  if (props.context !== "agent") return null;
  return <SessionPanel {...props} />;
}

function SessionPanel({
  theme,
  agentId,
  workspaceId,
}: Extract<PluginButtonContentProps, { context: "agent" }>) {
  const { colors } = theme;
  const styles = useStyles(colors);
  const { t } = useTranslation(messages);
  const [items, setItems] = useState<readonly WorkItem[] | null>(null);
  useSubscription(watchWorkItems, {}, (event) => setItems(event.items));

  if (!items) return <Text style={styles.muted}>{t("loading")}</Text>;

  const current = sessionItem(items, agentId);
  const others = items
    .filter((entry) => entry.workspaceId === workspaceId && entry.id !== current?.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 6);
  const kindBadge = (entry: WorkItem) => (
    <Badge
      text={t(`kind.${entry.kind}`)}
      color={entry.kind === "bug" ? colors.statusDanger : colors.accent}
      background={colors.surface2}
    />
  );
  const statusBadge = (entry: WorkItem) => (
    <Badge
      text={t(`status.${entry.status}`)}
      color={statusColor(colors, entry.status)}
      background={colors.surface2}
    />
  );

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>{t("title")}</Text>
        <Text style={styles.scope}>{t("following")}</Text>
        <Text style={styles.live}>{t("live")}</Text>
      </View>

      {current ? (
        <CurrentCard
          item={current}
          colors={colors}
          styles={styles}
          kindBadge={kindBadge(current)}
          statusBadge={statusBadge(current)}
        />
      ) : (
        <View style={styles.card}>
          <Text style={styles.itemTitle}>{t("noItem")}</Text>
          <Text style={styles.muted}>{t("noItemHint")}</Text>
        </View>
      )}

      <Text style={styles.section}>{t("others")}</Text>
      {others.length === 0 ? (
        <Text style={styles.muted}>{t("empty")}</Text>
      ) : (
        others.map((entry) => (
          <View key={entry.id} style={styles.row}>
            {kindBadge(entry)}
            <Text style={styles.rowTitle} numberOfLines={1}>
              {entry.title}
            </Text>
            {entry.pr?.number != null ? <Text style={styles.muted}>#{entry.pr.number}</Text> : null}
            {statusBadge(entry)}
          </View>
        ))
      )}
    </View>
  );
}
