package meat

import (
	"context"
	"encoding/json"
)

// Role is a message author in a model conversation.
type Role string

const (
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
)

// Block is one piece of message content. Its meaningful fields depend on Type:
//
//	"text"           -> Text
//	"tool_use"       -> ID, ToolName, ToolInput
//	"tool_result"    -> ToolUseID, ToolResult, ToolError
//	"provider_state" -> Provider, ProviderData
//
// It is deliberately a flat struct (rather than an interface) so the small set
// of Model implementations can translate to/from it without type switches.
type Block struct {
	Type string

	// text
	Text string

	// tool_use
	ID        string
	ToolName  string
	ToolInput json.RawMessage

	// tool_result
	ToolUseID  string
	ToolResult string
	ToolError  bool

	// Opaque provider response state that must be replayed exactly on a later
	// turn. OpenAI reasoning models use this for encrypted reasoning items and
	// other Responses API output items. Generic agent code may inspect the
	// normalized fields above, but must leave ProviderData untouched.
	Provider     string
	ProviderData json.RawMessage
}

// Message is a single turn in the conversation.
type Message struct {
	Role    Role
	Content []Block
}

// Tool describes a function the model may call. InputSchema is a JSON Schema
// object describing the tool's arguments.
type Tool struct {
	Name        string
	Description string
	InputSchema json.RawMessage
}

// Response is a single model reply.
type Response struct {
	Content      []Block
	InputTokens  int
	OutputTokens int
}

// Model is the minimal LLM interface meat needs. It is provider-agnostic: the
// CLI uses the built-in OpenAI or Anthropic implementation, while embedders
// such as Shelley supply their own by adapting an existing LLM client.
//
// Generate sends the system prompt, the conversation so far, and the available
// tools, and returns the model's next message. Implementations should surface
// tool calls as Blocks of type "tool_use".
type Model interface {
	Generate(ctx context.Context, system string, messages []Message, tools []Tool) (*Response, error)
}

// textBlock is a small constructor for a user/assistant text block.
func textBlock(s string) Block { return Block{Type: "text", Text: s} }
