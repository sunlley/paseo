import { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import {
  withOutput,
  type CommandOptions,
  type ListResult,
  type OutputSchema,
} from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import type { DaemonClientInfo } from "@getpaseo/protocol/messages";

const CLIENT_TYPES: Record<string, string> = {
  browser: "桌面/浏览器",
  cli: "CLI",
  mobile: "手机",
  mcp: "MCP",
  hub: "Hub",
};

const schema: OutputSchema<DaemonClientInfo> = {
  idField: "clientId",
  columns: [
    { header: "CLIENT ID", field: (row) => row.clientId },
    { header: "TYPE", field: (row) => CLIENT_TYPES[row.clientType] ?? row.clientType },
    { header: "VERSION", field: (row) => row.appVersion ?? "-" },
  ],
};

export function daemonClientsCommand(): Command {
  return addJsonAndDaemonHostOptions(
    new Command("clients").description("List clients currently connected to the daemon"),
  ).action(withOutput(runDaemonClientsCommand));
}

export async function runDaemonClientsCommand(
  options: CommandOptions,
  _command: Command,
): Promise<ListResult<DaemonClientInfo>> {
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const { clients } = await client.listDaemonClients();
    return {
      type: "list",
      data: clients,
      schema,
    };
  } finally {
    await client.close();
  }
}
