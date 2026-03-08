#!/usr/bin/env node

/**
 * Reusable PostgreSQL MCP Server
 * Supports any PostgreSQL database via connection string argument
 *
 * Usage:
 *   node index.js <connection-string>
 *
 * Example:
 *   node index.js postgresql://user:pass@localhost:5432/mydb
 *   node index.js postgresql://user:pass@localhost:5432/mydb?mode=readonly
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pg from "pg";

// ── Config from CLI args ──────────────────────────────────────────────────────

const connectionString = process.argv[2];

if (!connectionString) {
    console.error("Usage: node index.js <postgresql-connection-string>");
    console.error("Example: node index.js postgresql://user:pass@localhost:5432/mydb");
    process.exit(1);
}

// Parse optional ?mode=readonly from connection string
const url = new URL(connectionString);
const isReadOnly = url.searchParams.get("mode") === "readonly";
url.searchParams.delete("mode");
const cleanConnectionString = url.toString();

// ── Database pool ─────────────────────────────────────────────────────────────

const pool = new pg.Pool({
    connectionString: cleanConnectionString,
    max: 5,
    idleTimeoutMillis: 30000,
});

pool.on("error", (err) => {
    console.error("Unexpected DB error:", err.message);
});

// ── MCP Server ────────────────────────────────────────────────────────────────

const dbName = url.pathname.replace("/", "") || "postgres";

const server = new McpServer({
    name: `postgres-mcp-server-${dbName}`,
    version: "1.0.0",
});

// ── Tool: query (read-only SELECT) ────────────────────────────────────────────

server.registerTool(
    "query",
    {
        title: "Run SQL Query",
        description: "Execute a read-only SQL SELECT query and return results as JSON",
        inputSchema: {
            sql: z.string().describe("The SQL SELECT query to execute"),
        },
    },
    async ({ sql }) => {
        const client = await pool.connect();
        try {
            await client.query("BEGIN TRANSACTION READ ONLY");
            const result = await client.query(sql);
            await client.query("COMMIT");
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(result.rows, null, 2),
                    },
                ],
            };
        } catch (err) {
            try { await client.query("ROLLBACK"); } catch (_) {}
            return {
                content: [{ type: "text", text: `Query error: ${err.message}` }],
                isError: true,
            };
        } finally {
            client.release();
        }
    }
);

// ── Tool: execute (write operations) ─────────────────────────────────────────

if (!isReadOnly) {
    server.registerTool(
        "execute",
        {
            title: "Execute SQL",
            description:
                "Execute a write SQL statement (INSERT, UPDATE, DELETE, TRUNCATE, CREATE, DROP). Returns rows affected.",
            inputSchema: {
                sql: z.string().describe("The SQL statement to execute"),
            },
        },
        async ({ sql }) => {
            const client = await pool.connect();
            try {
                const result = await client.query(sql);
                const message =
                    result.rows && result.rows.length > 0
                        ? `Success. ${result.rowCount} row(s) affected.\nReturned: ${JSON.stringify(result.rows, null, 2)}`
                        : `Success. ${result.rowCount ?? 0} row(s) affected.`;
                return {
                    content: [{ type: "text", text: message }],
                };
            } catch (err) {
                return {
                    content: [{ type: "text", text: `Execute error: ${err.message}` }],
                    isError: true,
                };
            } finally {
                client.release();
            }
        }
    );
}

// ── Tool: schema ──────────────────────────────────────────────────────────────

server.registerTool(
    "schema",
    {
        title: "Get Database Schema",
        description:
            "List all tables with their columns, types, and constraints for a given schema (default: public)",
        inputSchema: {
            schema_name: z
                .string()
                .optional()
                .default("public")
                .describe("PostgreSQL schema name (default: public)"),
            table_name: z
                .string()
                .optional()
                .describe("Optional: filter to a specific table"),
        },
    },
    async ({ schema_name = "public", table_name }) => {
        const client = await pool.connect();
        try {
            const tableFilter = table_name ? `AND c.table_name = $2` : "";
            const params = table_name ? [schema_name, table_name] : [schema_name];

            const result = await client.query(
                `SELECT
          c.table_name,
          c.column_name,
          c.data_type,
          c.is_nullable,
          c.column_default,
          tc.constraint_type
        FROM information_schema.columns c
        LEFT JOIN information_schema.key_column_usage kcu
          ON c.table_name = kcu.table_name
          AND c.column_name = kcu.column_name
          AND c.table_schema = kcu.table_schema
        LEFT JOIN information_schema.table_constraints tc
          ON kcu.constraint_name = tc.constraint_name
          AND tc.table_schema = kcu.table_schema
          AND tc.constraint_type = 'PRIMARY KEY'
        WHERE c.table_schema = $1
          AND c.table_name NOT IN (SELECT table_name FROM information_schema.views)
          ${tableFilter}
        ORDER BY c.table_name, c.ordinal_position`,
                params
            );

            // Group by table
            const tables = {};
            for (const row of result.rows) {
                if (!tables[row.table_name]) tables[row.table_name] = [];
                tables[row.table_name].push({
                    column: row.column_name,
                    type: row.data_type,
                    nullable: row.is_nullable === "YES",
                    default: row.column_default,
                    primaryKey: row.constraint_type === "PRIMARY KEY",
                });
            }

            return {
                content: [{ type: "text", text: JSON.stringify(tables, null, 2) }],
            };
        } catch (err) {
            return {
                content: [{ type: "text", text: `Schema error: ${err.message}` }],
                isError: true,
            };
        } finally {
            client.release();
        }
    }
);

// ── Tool: list_tables ─────────────────────────────────────────────────────────

server.registerTool(
    "list_tables",
    {
        title: "List Tables",
        description: "List all tables in the database with row counts",
        inputSchema: {
            schema_name: z
                .string()
                .optional()
                .default("public")
                .describe("PostgreSQL schema name (default: public)"),
        },
    },
    async ({ schema_name = "public" }) => {
        const client = await pool.connect();
        try {
            const result = await client.query(
                `SELECT
          t.table_name,
          t.table_schema,
          pg_size_pretty(pg_total_relation_size(quote_ident(t.table_schema)||'.'||quote_ident(t.table_name))) AS size
        FROM information_schema.tables t
        WHERE t.table_schema = $1
          AND t.table_type = 'BASE TABLE'
        ORDER BY t.table_name`,
                [schema_name]
            );
            return {
                content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
            };
        } catch (err) {
            return {
                content: [{ type: "text", text: `Error: ${err.message}` }],
                isError: true,
            };
        } finally {
            client.release();
        }
    }
);

// ── Tool: transaction (multi-statement) ───────────────────────────────────────

if (!isReadOnly) {
    server.registerTool(
        "transaction",
        {
            title: "Run SQL Transaction",
            description:
                "Execute multiple SQL statements as a single atomic transaction. Rolls back all on any error.",
            inputSchema: {
                statements: z
                    .array(z.string())
                    .describe("Array of SQL statements to execute in order, atomically"),
            },
        },
        async ({ statements }) => {
            const client = await pool.connect();
            try {
                await client.query("BEGIN");
                const results = [];
                for (const sql of statements) {
                    const result = await client.query(sql);
                    results.push({
                        sql: sql.slice(0, 80) + (sql.length > 80 ? "..." : ""),
                        rowsAffected: result.rowCount ?? 0,
                        returned: result.rows?.length > 0 ? result.rows : undefined,
                    });
                }
                await client.query("COMMIT");
                return {
                    content: [
                        {
                            type: "text",
                            text: `Transaction committed successfully.\n${JSON.stringify(results, null, 2)}`,
                        },
                    ],
                };
            } catch (err) {
                await client.query("ROLLBACK");
                return {
                    content: [
                        {
                            type: "text",
                            text: `Transaction rolled back due to error: ${err.message}`,
                        },
                    ],
                    isError: true,
                };
            } finally {
                client.release();
            }
        }
    );
}

// ── Start server ──────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);