'use client';

import { McpHistory } from './mcp-history';
import { PageHeader } from './page-header';

/** Cross-Workspace MCP call history under Global. Global has no MCP server: this only reads recorded calls. */
export function McpHistoryView() {
  return (
    <section className="flex min-w-0 flex-col gap-4">
      <PageHeader title="MCP call history" description="Calls made through MCP with any Workspace key. Global has no MCP server of its own; configure connections per Workspace." />
      <McpHistory scope={{ kind: 'global' }} />
    </section>
  );
}
