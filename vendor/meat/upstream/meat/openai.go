package meat

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"
)

// DefaultOpenAIModel is meat's default OpenAI Responses API model.
const DefaultOpenAIModel = "gpt-5.6-sol"

// DefaultReasoningEffort is the thinking level used by OpenAIModel when no
// explicit effort is configured.
const DefaultReasoningEffort = "medium"

// maxOpenAIOutputTokens includes both hidden reasoning tokens and visible
// response/tool-call tokens in the Responses API.
const maxOpenAIOutputTokens = 32768

// OpenAIModel is a built-in Model backed by the OpenAI Responses API. It uses
// streaming responses because ChatGPT-backed exe.dev integrations require
// streaming, but Generate still returns one complete provider-agnostic reply.
type OpenAIModel struct {
	APIKey          string       // optional for an exe.dev integration or a keyless custom base URL
	Model           string       // defaults to DefaultOpenAIModel
	BaseURL         string       // bare origin/prefix or .../v1; defaults to https://api.openai.com
	ReasoningEffort string       // defaults to DefaultReasoningEffort
	HTTPC           *http.Client // defaults to a client with a 5m timeout
}

// NewOpenAIFromEnv builds an OpenAIModel, preferring explicit OpenAI settings
// and otherwise discovering the exe.dev managed LLM integration.
//
// Resolution order:
//  1. If OPENAI_API_KEY (or OPENAI_BASE_URL) is set, use it directly.
//  2. Otherwise, on an exe.dev VM with an attached "llm" integration, route
//     through its provider-specific /openai prefix with edge-managed creds.
//  3. Otherwise, error.
//
// model falls back to $MEAT_MODEL, then DefaultOpenAIModel. Thinking defaults
// to medium; embedders may override OpenAIModel.ReasoningEffort.
func NewOpenAIFromEnv(ctx context.Context, model string) (*OpenAIModel, error) {
	model = resolveModel(model, DefaultOpenAIModel)

	key := os.Getenv("OPENAI_API_KEY")
	baseURL := os.Getenv("OPENAI_BASE_URL")
	if key != "" || baseURL != "" {
		return &OpenAIModel{
			APIKey:          key,
			Model:           model,
			BaseURL:         baseURL,
			ReasoningEffort: DefaultReasoningEffort,
		}, nil
	}

	if base := discoverExeGatewayBase(ctx, nil); base != "" {
		return &OpenAIModel{
			Model:           model,
			BaseURL:         base + "/openai",
			ReasoningEffort: DefaultReasoningEffort,
		}, nil
	}

	return nil, fmt.Errorf("no OpenAI credentials: set OPENAI_API_KEY, OPENAI_BASE_URL, or run on an exe.dev VM with an attached 'llm' integration")
}

// --- wire types ---

type openAIReq struct {
	Model           string            `json:"model"`
	Instructions    string            `json:"instructions,omitempty"`
	Input           []json.RawMessage `json:"input"`
	Tools           []openAITool      `json:"tools,omitempty"`
	Reasoning       openAIReasoning   `json:"reasoning"`
	Include         []string          `json:"include"`
	Store           bool              `json:"store"`
	Stream          bool              `json:"stream"`
	MaxOutputTokens int               `json:"max_output_tokens"`
}

type openAIReasoning struct {
	Effort string `json:"effort"`
}

type openAITool struct {
	Type        string          `json:"type"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
}

type openAIResp struct {
	ID                string            `json:"id"`
	Status            string            `json:"status"`
	Output            []json.RawMessage `json:"output"`
	Error             *openAIError      `json:"error"`
	IncompleteDetails *struct {
		Reason string `json:"reason"`
	} `json:"incomplete_details"`
	Usage openAIUsage `json:"usage"`
}

type openAIUsage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
}

type openAIError struct {
	Type    string `json:"type"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type openAIStreamEvent struct {
	Type        string          `json:"type"`
	OutputIndex int             `json:"output_index"`
	Item        json.RawMessage `json:"item"`
	Response    *openAIResp     `json:"response"`
	Code        string          `json:"code"`
	Message     string          `json:"message"`
}

type openAIOutputItem struct {
	Type             string `json:"type"`
	ID               string `json:"id"`
	CallID           string `json:"call_id"`
	Name             string `json:"name"`
	Arguments        string `json:"arguments"`
	EncryptedContent string `json:"encrypted_content"`
	Content          []struct {
		Type    string `json:"type"`
		Text    string `json:"text"`
		Refusal string `json:"refusal"`
	} `json:"content"`
}

// Generate implements Model using the OpenAI Responses API. Every output item
// is retained as opaque ProviderData. In particular, encrypted reasoning items
// are replayed byte-for-byte on later tool turns while normalized tool_use and
// text fields remain available to the provider-agnostic agent loop.
func (m *OpenAIModel) Generate(ctx context.Context, system string, messages []Message, tools []Tool) (*Response, error) {
	if m.APIKey == "" && m.BaseURL == "" {
		return nil, fmt.Errorf("meat: OpenAIModel needs APIKey or BaseURL")
	}

	input, err := toOpenAIInput(messages)
	if err != nil {
		return nil, err
	}
	reqBody := openAIReq{
		Model:           cmpOr(m.Model, DefaultOpenAIModel),
		Instructions:    system,
		Input:           input,
		Tools:           toOpenAITools(tools),
		Reasoning:       openAIReasoning{Effort: cmpOr(m.ReasoningEffort, DefaultReasoningEffort)},
		Include:         []string{"reasoning.encrypted_content"},
		Store:           false,
		Stream:          true,
		MaxOutputTokens: maxOpenAIOutputTokens,
	}
	body, err := json.Marshal(reqBody)
	if err != nil {
		return nil, err
	}

	url := openAIResponsesURL(cmpOr(m.BaseURL, "https://api.openai.com"))
	client := m.HTTPC
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Minute}
	}
	raw, err := postJSONWithRetry(ctx, client, url, body, "openai", func(req *http.Request) {
		if m.APIKey != "" {
			req.Header.Set("authorization", "Bearer "+m.APIKey)
		}
	})
	if err != nil {
		return nil, err
	}

	resp, err := decodeOpenAIResponse(raw)
	if err != nil {
		return nil, err
	}
	if resp.Error != nil {
		return nil, fmt.Errorf("openai error: %s: %s", cmpOr(resp.Error.Code, resp.Error.Type), resp.Error.Message)
	}
	if resp.Status == "incomplete" {
		reason := "unknown"
		if resp.IncompleteDetails != nil && resp.IncompleteDetails.Reason != "" {
			reason = resp.IncompleteDetails.Reason
		}
		return nil, fmt.Errorf("openai response incomplete (%s); max_output_tokens=%d", reason, maxOpenAIOutputTokens)
	}
	if resp.Status != "" && resp.Status != "completed" {
		return nil, fmt.Errorf("openai response ended with status %q", resp.Status)
	}

	out := &Response{
		InputTokens:  resp.Usage.InputTokens,
		OutputTokens: resp.Usage.OutputTokens,
	}
	for _, rawItem := range resp.Output {
		blocks, err := blocksFromOpenAIItem(rawItem)
		if err != nil {
			return nil, err
		}
		out.Content = append(out.Content, blocks...)
	}
	return out, nil
}

func openAIResponsesURL(base string) string {
	base = strings.TrimRight(base, "/")
	if strings.HasSuffix(base, "/v1") {
		return base + "/responses"
	}
	return base + "/v1/responses"
}

func toOpenAITools(tools []Tool) []openAITool {
	out := make([]openAITool, 0, len(tools))
	for _, t := range tools {
		out = append(out, openAITool{
			Type:        "function",
			Name:        t.Name,
			Description: t.Description,
			Parameters:  t.InputSchema,
		})
	}
	return out
}

func toOpenAIInput(messages []Message) ([]json.RawMessage, error) {
	var out []json.RawMessage
	for _, message := range messages {
		var text []string
		flushText := func() error {
			if len(text) == 0 {
				return nil
			}
			raw, err := json.Marshal(struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			}{Role: string(message.Role), Content: strings.Join(text, "\n")})
			if err != nil {
				return err
			}
			out = append(out, raw)
			text = nil
			return nil
		}

		for _, block := range message.Content {
			if block.Provider == "openai" && len(block.ProviderData) > 0 {
				if err := flushText(); err != nil {
					return nil, err
				}
				if !json.Valid(block.ProviderData) {
					return nil, fmt.Errorf("openai provider state is not valid JSON")
				}
				out = append(out, bytes.Clone(block.ProviderData))
				continue
			}

			switch block.Type {
			case "text":
				text = append(text, block.Text)
			case "tool_use":
				if err := flushText(); err != nil {
					return nil, err
				}
				arguments := strings.TrimSpace(string(block.ToolInput))
				if arguments == "" {
					arguments = "{}"
				}
				raw, err := json.Marshal(struct {
					Type      string `json:"type"`
					CallID    string `json:"call_id"`
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				}{Type: "function_call", CallID: block.ID, Name: block.ToolName, Arguments: arguments})
				if err != nil {
					return nil, err
				}
				out = append(out, raw)
			case "tool_result":
				if err := flushText(); err != nil {
					return nil, err
				}
				raw, err := json.Marshal(struct {
					Type   string `json:"type"`
					CallID string `json:"call_id"`
					Output string `json:"output"`
				}{Type: "function_call_output", CallID: block.ToolUseID, Output: block.ToolResult})
				if err != nil {
					return nil, err
				}
				out = append(out, raw)
			case "provider_state":
				return nil, fmt.Errorf("openai provider state is missing opaque response data")
			default:
				return nil, fmt.Errorf("openai: unsupported message block type %q", block.Type)
			}
		}
		if err := flushText(); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func blocksFromOpenAIItem(raw json.RawMessage) ([]Block, error) {
	var item openAIOutputItem
	if err := json.Unmarshal(raw, &item); err != nil {
		return nil, fmt.Errorf("decode openai output item: %w", err)
	}
	state := bytes.Clone(raw)
	switch item.Type {
	case "reasoning":
		return []Block{{Type: "provider_state", Provider: "openai", ProviderData: state}}, nil
	case "function_call":
		input := json.RawMessage(item.Arguments)
		if strings.TrimSpace(item.Arguments) == "" {
			input = json.RawMessage(`{}`)
		}
		return []Block{{
			Type:         "tool_use",
			ID:           item.CallID,
			ToolName:     item.Name,
			ToolInput:    input,
			Provider:     "openai",
			ProviderData: state,
		}}, nil
	case "message":
		var parts []string
		for _, content := range item.Content {
			switch content.Type {
			case "output_text":
				parts = append(parts, content.Text)
			case "refusal":
				parts = append(parts, content.Refusal)
			}
		}
		if len(parts) == 0 {
			return []Block{{Type: "provider_state", Provider: "openai", ProviderData: state}}, nil
		}
		return []Block{{
			Type:         "text",
			Text:         strings.Join(parts, "\n"),
			Provider:     "openai",
			ProviderData: state,
		}}, nil
	default:
		// Preserve unfamiliar output items rather than silently dropping state
		// that a newer Responses API model may require on the next turn.
		return []Block{{Type: "provider_state", Provider: "openai", ProviderData: state}}, nil
	}
}

// decodeOpenAIResponse accepts both ordinary JSON Responses API replies and
// SSE streams. For streams it collects each response.output_item.done item in
// output order because some compatible gateways omit output from the final
// response.completed snapshot.
func decodeOpenAIResponse(raw []byte) (openAIResp, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return openAIResp{}, fmt.Errorf("decode openai response: empty body")
	}
	if trimmed[0] == '{' {
		var resp openAIResp
		if err := json.Unmarshal(trimmed, &resp); err != nil {
			return openAIResp{}, fmt.Errorf("decode openai response: %w", err)
		}
		return resp, nil
	}

	items := make(map[int]json.RawMessage)
	var final *openAIResp
	var streamErr error
	var data []string

	consume := func() error {
		if len(data) == 0 {
			return nil
		}
		joined := strings.Join(data, "\n")
		data = nil
		if joined == "[DONE]" {
			return nil
		}
		var event openAIStreamEvent
		if err := json.Unmarshal([]byte(joined), &event); err != nil {
			return fmt.Errorf("decode openai stream event: %w", err)
		}
		switch event.Type {
		case "response.output_item.done":
			if len(event.Item) > 0 {
				items[event.OutputIndex] = bytes.Clone(event.Item)
			}
		case "response.completed", "response.incomplete", "response.failed":
			if event.Response != nil {
				copyResp := *event.Response
				final = &copyResp
			}
		case "error":
			streamErr = fmt.Errorf("openai stream error %s: %s", event.Code, event.Message)
		}
		return nil
	}

	scanner := bufio.NewScanner(bytes.NewReader(raw))
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if line == "" {
			if err := consume(); err != nil {
				return openAIResp{}, err
			}
			continue
		}
		if strings.HasPrefix(line, "data:") {
			data = append(data, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	if err := scanner.Err(); err != nil {
		return openAIResp{}, fmt.Errorf("read openai stream: %w", err)
	}
	if err := consume(); err != nil {
		return openAIResp{}, err
	}
	if streamErr != nil {
		return openAIResp{}, streamErr
	}
	if final == nil {
		return openAIResp{}, fmt.Errorf("openai stream ended without a final response event")
	}
	if len(items) > 0 {
		indices := make([]int, 0, len(items))
		for index := range items {
			indices = append(indices, index)
		}
		sort.Ints(indices)
		final.Output = final.Output[:0]
		for _, index := range indices {
			final.Output = append(final.Output, items[index])
		}
	}
	return *final, nil
}
