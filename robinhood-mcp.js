#!/usr/bin/env node
// Robinhood Trading MCP Client
// Connects to Robinhood's Trading MCP server (https://agent.robinhood.com/mcp/trading)
// for agentic trading. First connection authenticates and opens a dedicated
// Agentic brokerage account.
//
// Usage:
//   node robinhood-mcp.js <command> [args]
//
// Commands:
//   tools              List available tools on the server
//   call <name> [json] Call a specific tool with JSON args
//   resources          List available resources
//   read <uri>         Read a specific resource
//   balance            Get account balance (shortcut)
//   positions          Get current positions (shortcut)
//   watchlist          Get watchlist (shortcut)
//   quote <symbol>     Get price quote (shortcut)
//
// Example:
//   node robinhood-mcp.js quote AAPL

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_URL = "https://agent.robinhood.com/mcp/trading";

let client;
let transport;

async function connect() {
    client = new Client({
        name: "rein-robinhood",
        version: "1.0.0"
    });

    transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
    await client.connect(transport);
    console.log("Connected to Robinhood Trading MCP");
}

async function listTools() {
    const { tools } = await client.listTools();
    console.log("Available tools:");
    for (const tool of tools) {
        console.log(`  - ${tool.name}`);
        if (tool.description) console.log(`    ${tool.description}`);
        console.log();
    }
    return tools;
}

async function callTool(name, args = {}) {
    const result = await client.callTool({ name, arguments: args });
    console.log(`Result from ${name}:`);
    for (const content of result.content) {
        if (content.type === "text") {
            console.log(content.text);
        } else if (content.type === "json") {
            console.log(JSON.stringify(content, null, 2));
        }
    }
    return result;
}

async function listResources() {
    const { resources } = await client.listResources();
    console.log("Available resources:");
    for (const r of resources) {
        console.log(`  - ${r.uri}: ${r.name}`);
    }
}

async function readResource(uri) {
    const result = await client.readResource({ uri });
    for (const content of result.contents) {
        if (content.text) {
            console.log(content.text);
        } else {
            console.log(JSON.stringify(content, null, 2));
        }
    }
    return result;
}

async function main() {
    const cmd = process.argv[2] || "help";
    const arg = process.argv[3] || "";

    try {
        await connect();

        switch (cmd) {
            case "help":
                console.log("Robinhood Trading MCP Client");
                console.log("Commands:");
                console.log("  tools              List available tools");
                console.log("  call <name> [args]  Call a tool (args as JSON)");
                console.log("  resources          List resources");
                console.log("  read <uri>          Read a resource");
                console.log("  balance            Get account balance");
                console.log("  positions          Get current positions");
                console.log("  watchlist          Get watchlist");
                console.log("  quote <symbol>      Get price quote");
                break;

            case "tools":
                await listTools();
                break;

            case "call": {
                const toolName = arg;
                const argsJson = process.argv[4] || "{}";
                let toolArgs = {};
                try {
                    toolArgs = JSON.parse(argsJson);
                } catch {
                    // If not valid JSON, treat as symbol
                    toolArgs = { symbol: argsJson };
                }
                await callTool(toolName, toolArgs);
                break;
            }

            case "resources":
                await listResources();
                break;

            case "read":
                await readResource(arg);
                break;

            case "balance":
                await callTool("get_account_balance");
                break;

            case "positions":
                await callTool("list_positions");
                break;

            case "watchlist":
                await callTool("get_watchlist");
                break;

            case "quote":
                await callTool("get_price_quote", { symbol: arg });
                break;

            default:
                console.log("Unknown command:", cmd);
                console.log("Use 'help' to see available commands");
        }
    } catch (err) {
        console.log("Error:", err.message);
        if (err.stack) {
            console.log(err.stack.split("\n").slice(0, 3).join("\n"));
        }
    } finally {
        if (client) {
            try { await client.close(); } catch { /* ignore */ }
        }
    }
}

main();
