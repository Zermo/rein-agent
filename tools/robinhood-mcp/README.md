# Robinhood Trading MCP Client

A Node.js client for [Robinhood's Trading MCP server](https://agent.robinhood.com/mcp/trading) that enables agentic trading.

## Setup

Install dependencies:
```bash
npm install @modelcontextprotocol/sdk
```

## Usage

```bash
node robinhood-mcp.js <command> [args]
```

### Commands

| Command | Description |
|---------|-------------|
| `tools` | List all available tools on the server |
| `call <name> [json]` | Call a specific tool with JSON arguments |
| `resources` | List available resources |
| `read <uri>` | Read a specific resource |
| `balance` | Get account balance (shortcut) |
| `positions` | Get current positions (shortcut) |
| `watchlist` | Get watchlist (shortcut) |
| `quote <symbol>` | Get price quote (shortcut) |

### Examples

```bash
# List available tools
node robinhood-mcp.js tools

# Get Apple quote
node robinhood-mcp.js quote AAPL

# Get current positions
node robinhood-mcp.js positions

# Call a tool with arguments
node robinhood-mcp.js call place_order '{"symbol":"AAPL","quantity":1,"side":"buy"}'
```

## How It Works

- Uses the official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- Connects to Robinhood's Trading MCP server via Streamable HTTP transport
- First connection requires authentication and opens a dedicated Agentic brokerage account
- Agent has read access to all accounts but can only trade in the Agentic account

## Note

This connects to Robinhood's live MCP endpoint. On first connection, you'll be prompted to authenticate your Robinhood account.
