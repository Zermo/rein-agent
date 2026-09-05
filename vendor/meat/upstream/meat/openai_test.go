package meat

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func writeOpenAIEvent(w http.ResponseWriter, event any) {
	raw, err := json.Marshal(event)
	if err != nil {
		panic(err)
	}
	fmt.Fprintf(w, "data: %s\n\n", raw)
}

func openAICompleted(id string, inputTokens, outputTokens int) map[string]any {
	return map[string]any{
		"type": "response.completed",
		"response": map[string]any{
			"id":     id,
			"status": "completed",
			"output": []any{},
			"usage": map[string]int{
				"input_tokens":  inputTokens,
				"output_tokens": outputTokens,
			},
		},
	}
}

func outputItemDone(index int, item any) map[string]any {
	return map[string]any{
		"type":         "response.output_item.done",
		"output_index": index,
		"item":         item,
	}
}

func TestAbridge_OpenAIEditPlanEndToEndPreservesReasoning(t *testing.T) {
	const diff = "diff --git a/a.go b/a.go\n@@ -1 +1 @@\n-old\n+new\n"
	var calls int32

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		call := atomic.AddInt32(&calls, 1)
		if r.URL.Path != "/v1/responses" {
			t.Errorf("request path = %q, want /v1/responses", r.URL.Path)
		}
		if got := r.Header.Get("authorization"); got != "Bearer test-key" {
			t.Errorf("authorization = %q", got)
		}

		var req openAIReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("decode request: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if req.Model != DefaultOpenAIModel {
			t.Errorf("model = %q, want %q", req.Model, DefaultOpenAIModel)
		}
		if req.Reasoning.Effort != DefaultReasoningEffort {
			t.Errorf("reasoning effort = %q, want %q", req.Reasoning.Effort, DefaultReasoningEffort)
		}
		if !req.Stream || req.Store {
			t.Errorf("stream/store = %v/%v, want true/false", req.Stream, req.Store)
		}
		if req.MaxOutputTokens != maxOpenAIOutputTokens {
			t.Errorf("max_output_tokens = %d, want %d", req.MaxOutputTokens, maxOpenAIOutputTokens)
		}
		if len(req.Include) != 1 || req.Include[0] != "reasoning.encrypted_content" {
			t.Errorf("include = %#v", req.Include)
		}
		if !strings.Contains(req.Instructions, "edit plan") {
			t.Errorf("instructions do not describe edit plans")
		}
		if len(req.Tools) != 2 || req.Tools[0].Type != "function" || req.Tools[0].Name != "preview_plan" || req.Tools[1].Name != "submit" {
			t.Errorf("unexpected tools: %+v", req.Tools)
		}

		if call == 1 {
			if len(req.Input) != 1 || !strings.Contains(string(req.Input[0]), "1|diff --git") {
				t.Errorf("first input is not the numbered user prompt: %s", req.Input)
			}
		} else if call == 2 {
			if len(req.Input) != 4 {
				t.Errorf("second input has %d items, want user + reasoning + call + output: %s", len(req.Input), req.Input)
			} else {
				var reasoning, functionCall, functionOutput map[string]any
				if err := json.Unmarshal(req.Input[1], &reasoning); err != nil {
					t.Errorf("decode replayed reasoning: %v", err)
					return
				}
				if err := json.Unmarshal(req.Input[2], &functionCall); err != nil {
					t.Errorf("decode replayed function call: %v", err)
					return
				}
				if err := json.Unmarshal(req.Input[3], &functionOutput); err != nil {
					t.Errorf("decode function output: %v", err)
					return
				}
				if reasoning["type"] != "reasoning" || reasoning["encrypted_content"] != "encrypted-turn-1" || reasoning["id"] != "rs_1" {
					t.Errorf("reasoning item was not replayed intact: %s", req.Input[1])
				}
				if functionCall["type"] != "function_call" || functionCall["call_id"] != "call_1" || functionCall["id"] != "fc_1" {
					t.Errorf("function call was not replayed intact: %s", req.Input[2])
				}
				if functionOutput["type"] != "function_call_output" || functionOutput["call_id"] != "call_1" || !strings.Contains(fmt.Sprint(functionOutput["output"]), "outside the diff") {
					t.Errorf("function output does not answer call_1: %s", req.Input[3])
				}
			}
		}

		w.Header().Set("content-type", "text/event-stream")
		if call == 1 {
			writeOpenAIEvent(w, outputItemDone(0, map[string]any{
				"id":                "rs_1",
				"type":              "reasoning",
				"encrypted_content": "encrypted-turn-1",
				"summary":           []any{},
			}))
			writeOpenAIEvent(w, outputItemDone(1, map[string]any{
				"id":        "fc_1",
				"type":      "function_call",
				"status":    "completed",
				"call_id":   "call_1",
				"name":      "submit",
				"arguments": `{"remove":[],"replace":[{"line":99,"old":"new","new":"..."}],"fold":[],"summary":"Changes the value."}`,
			}))
			writeOpenAIEvent(w, openAICompleted("resp_1", 10, 5))
			return
		}

		writeOpenAIEvent(w, outputItemDone(0, map[string]any{
			"id":        "fc_2",
			"type":      "function_call",
			"status":    "completed",
			"call_id":   "call_2",
			"name":      "submit",
			"arguments": `{"remove":[{"start_line":3,"end_line":3}],"replace":[{"line":4,"old":"new","new":"n..."}],"fold":[],"summary":"Changes the value."}`,
		}))
		writeOpenAIEvent(w, openAICompleted("resp_2", 10, 5))
	}))
	defer srv.Close()

	m := &OpenAIModel{APIKey: "test-key", BaseURL: srv.URL, HTTPC: srv.Client()}
	res, err := Abridge(context.Background(), m, Request{UnifiedDiff: diff})
	if err != nil {
		t.Fatal(err)
	}
	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Fatalf("HTTP model calls = %d, want invalid plan plus corrected plan", got)
	}
	if strings.Contains(res.SmartDiff, "-old") || !strings.Contains(res.SmartDiff, "+n...") {
		t.Fatalf("derived reading diff =\n%s", res.SmartDiff)
	}
	if res.InputTokens != 20 || res.OutputTokens != 10 {
		t.Errorf("tokens = %d/%d, want 20/10", res.InputTokens, res.OutputTokens)
	}
}

func TestOpenAIGenerate_StreamingText(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		writeOpenAIEvent(w, outputItemDone(0, map[string]any{
			"id":     "msg_1",
			"type":   "message",
			"status": "completed",
			"role":   "assistant",
			"content": []any{map[string]any{
				"type": "output_text",
				"text": "hello",
			}},
		}))
		writeOpenAIEvent(w, openAICompleted("resp_text", 7, 3))
	}))
	defer srv.Close()

	m := &OpenAIModel{BaseURL: srv.URL, HTTPC: srv.Client()}
	resp, err := m.Generate(context.Background(), "sys", []Message{{Role: RoleUser, Content: []Block{textBlock("hi")}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Content) != 1 || resp.Content[0].Type != "text" || resp.Content[0].Text != "hello" {
		t.Fatalf("content = %+v", resp.Content)
	}
	if resp.Content[0].Provider != "openai" || !strings.Contains(string(resp.Content[0].ProviderData), `"id":"msg_1"`) {
		t.Errorf("message output item was not preserved: %+v", resp.Content[0])
	}
}

func TestOpenAIGenerate_IncompleteIsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		writeOpenAIEvent(w, map[string]any{
			"type": "response.incomplete",
			"response": map[string]any{
				"id":                 "resp_cut",
				"status":             "incomplete",
				"output":             []any{},
				"incomplete_details": map[string]string{"reason": "max_output_tokens"},
			},
		})
	}))
	defer srv.Close()

	m := &OpenAIModel{BaseURL: srv.URL, HTTPC: srv.Client()}
	_, err := m.Generate(context.Background(), "sys", []Message{{Role: RoleUser, Content: []Block{textBlock("hi")}}}, nil)
	if err == nil || !strings.Contains(err.Error(), "max_output_tokens") {
		t.Fatalf("error = %v, want max_output_tokens truncation", err)
	}
}

func TestOpenAIResponsesURL(t *testing.T) {
	for base, want := range map[string]string{
		"https://api.openai.com":    "https://api.openai.com/v1/responses",
		"https://proxy.example/v1/": "https://proxy.example/v1/responses",
	} {
		if got := openAIResponsesURL(base); got != want {
			t.Errorf("openAIResponsesURL(%q) = %q, want %q", base, got, want)
		}
	}
}
