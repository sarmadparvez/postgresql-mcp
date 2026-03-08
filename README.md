# postgresql-mcp

A reusable [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for PostgreSQL with full read-write support.

## Why this exists

There are two other PostgreSQL MCP servers worth knowing about, and neither fully covers the general-purpose use case:

**Anthropic's official [`@modelcontextprotocol/server-postgres`](https://github.com/modelcontextprotocol/servers-archived/tree/main/src/postgres)** is strictly read-only — it exposes only a single `query` tool that runs inside a `READ ONLY` transaction. No writes, no DDL, no transactions. It was also deprecated and archived in July 2025.

**Microsoft's [`azure-postgresql-mcp`](https://github.com/Azure-Samples/azure-postgresql-mcp)** does support writes and DDL, but it is built specifically for Azure Database for PostgreSQL Flexible Server. While it technically accepts standard `PG*` environment variables (so a local connection may work), local use is untested and unsupported. Several tools require Microsoft Entra authentication and Azure-specific APIs that won't function outside Azure. It also pulls in Azure SDK dependencies you don't need for a non-Azure setup. It is currently in Preview.

This server is the alternative for everything else: local PostgreSQL, self-hosted, Supabase, RDS, or any standard PostgreSQL instance. It is a single dependency-light file with no cloud lock-in, full read-write support, atomic multi-statement transactions, and an optional `?mode=readonly` flag when you want to restrict access.

## Requirements

- Node.js 18+
- A running PostgreSQL database

## Installation

```bash
npm install -g @sarmadparvez/postgresql-mcp
```

Or run directly without installing (requires npm 7+ / Node.js 18+):

```bash
npx @sarmadparvez/postgresql-mcp <postgresql-connection-string>
```

## Usage

```bash
postgresql-mcp <postgresql-connection-string>
```

**Examples:**

```bash
# Read-write access
postgresql-mcp postgresql://user:pass@localhost:5432/mydb

# Read-only mode (disables execute and transaction tools)
postgresql-mcp postgresql://user:pass@localhost:5432/mydb?mode=readonly
```

Or with `npx` (requires npm 7+ / Node.js 18+):

```bash
npx @sarmadparvez/postgresql-mcp postgresql://user:pass@localhost:5432/mydb
npx @sarmadparvez/postgresql-mcp postgresql://user:pass@localhost:5432/mydb?mode=readonly
```

## Tools

| Tool | Available in | Description |
|------|-------------|-------------|
| `query` | Always | Execute a read-only `SELECT` query. Runs inside a `READ ONLY` transaction. Returns rows as JSON. |
| `execute` | Read-write mode | Execute a write SQL statement (`INSERT`, `UPDATE`, `DELETE`, `CREATE`, `DROP`, etc.). Returns rows affected. |
| `schema` | Always | List columns, types, nullability, defaults, and primary keys for tables in a given schema. Optionally filter to a specific table. |
| `list_tables` | Always | List all base tables in a schema with their disk size. |
| `transaction` | Read-write mode | Execute multiple SQL statements atomically. Rolls back all statements if any one fails. |

## Read-Only Mode

Append `?mode=readonly` to the connection string to start the server in read-only mode. This disables the `execute` and `transaction` tools, leaving only `query`, `schema`, and `list_tables`.

## Claude Desktop Configuration

First, install the package globally:

```bash
npm install -g @sarmadparvez/postgresql-mcp
```

Then find the paths to `node` and the installed script:

```bash
which node
# e.g. /usr/local/bin/node
# nvm users: /Users/yourname/.nvm/versions/node/v22.12.0/bin/node

npm root -g
# e.g. /usr/local/lib/node_modules
# nvm users: /Users/yourname/.nvm/versions/node/v22.12.0/lib/node_modules
```

Add this to your `claude_desktop_config.json`:

- Replace `command` with the output of `which node`
- Replace the prefix of the script path with the output of `npm root -g` — the suffix `/@sarmadparvez/postgresql-mcp/index.js` stays the same

```json
{
  "mcpServers": {
    "postgres": {
      "command": "/usr/local/bin/node",
      "args": [
        "/usr/local/lib/node_modules/@sarmadparvez/postgresql-mcp/index.js",
        "postgresql://user:pass@localhost:5432/mydb"
      ]
    }
  }
}
```

For read-only access, append `?mode=readonly` to the connection string:

```json
{
  "mcpServers": {
    "postgres-readonly": {
      "command": "/usr/local/bin/node",
      "args": [
        "/usr/local/lib/node_modules/@sarmadparvez/postgresql-mcp/index.js",
        "postgresql://user:pass@localhost:5432/mydb?mode=readonly"
      ]
    }
  }
}
```

## Dependencies

- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) — MCP server framework
- [`pg`](https://node-postgres.com) — PostgreSQL client
- [`zod`](https://zod.dev) — Schema validation for tool inputs
