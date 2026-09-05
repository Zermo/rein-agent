package meat

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// withMarker creates a fake exe.dev marker file and points exeDevMarkerPath at
// it for the duration of the test.
func withMarker(t *testing.T) {
	t.Helper()
	old := exeDevMarkerPath
	p := filepath.Join(t.TempDir(), "exe.dev")
	if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	exeDevMarkerPath = p
	t.Cleanup(func() { exeDevMarkerPath = old })
}

func withReflection(t *testing.T, body string) {
	t.Helper()
	old := reflectionIntegrationsURL
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.Write([]byte(body))
	}))
	reflectionIntegrationsURL = srv.URL
	t.Cleanup(func() {
		reflectionIntegrationsURL = old
		srv.Close()
	})
}

func TestDiscoverExeGatewayBase(t *testing.T) {
	withMarker(t)
	withReflection(t, `{"integrations":[{"name":"discord","type":"discord"},{"name":"llm","type":"llm"}]}`)

	got := discoverExeGatewayBase(context.Background(), nil)
	if got != "https://llm.int.exe.xyz" {
		t.Errorf("gateway base = %q, want https://llm.int.exe.xyz", got)
	}
}

func TestDiscoverExeGatewayBase_NoMarker(t *testing.T) {
	old := exeDevMarkerPath
	exeDevMarkerPath = filepath.Join(t.TempDir(), "does-not-exist")
	t.Cleanup(func() { exeDevMarkerPath = old })
	if got := discoverExeGatewayBase(context.Background(), nil); got != "" {
		t.Errorf("want empty off exe.dev, got %q", got)
	}
}

func TestDiscoverExeGatewayBase_NoLLMIntegration(t *testing.T) {
	withMarker(t)
	withReflection(t, `{"integrations":[{"name":"discord","type":"discord"}]}`)
	if got := discoverExeGatewayBase(context.Background(), nil); got != "" {
		t.Errorf("want empty without an llm integration, got %q", got)
	}
}

func TestDiscoverExeGatewayBase_Team(t *testing.T) {
	withMarker(t)
	withReflection(t, `{"integrations":[{"name":"acme","type":"llm","team":true}]}`)
	if got := discoverExeGatewayBase(context.Background(), nil); got != "https://acme.team.exe.xyz" {
		t.Errorf("team gateway base = %q, want https://acme.team.exe.xyz", got)
	}
}

func TestNewAnthropicFromEnv_PrefersExplicitKey(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "sk-explicit")
	t.Setenv("ANTHROPIC_BASE_URL", "")
	// Even on an exe.dev VM with an llm integration, an explicit key wins.
	withMarker(t)
	withReflection(t, `{"integrations":[{"name":"llm","type":"llm"}]}`)

	m, err := NewAnthropicFromEnv(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	if m.APIKey != "sk-explicit" {
		t.Errorf("APIKey = %q, want sk-explicit", m.APIKey)
	}
	if m.BaseURL != "" {
		t.Errorf("BaseURL = %q, want empty (default api.anthropic.com)", m.BaseURL)
	}
	if m.Model != DefaultAnthropicModel {
		t.Errorf("Model = %q, want default %q", m.Model, DefaultAnthropicModel)
	}
}

func TestNewAnthropicFromEnv_FallsBackToGateway(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("ANTHROPIC_BASE_URL", "")
	t.Setenv("MEAT_MODEL", "")
	withMarker(t)
	withReflection(t, `{"integrations":[{"name":"llm","type":"llm"}]}`)

	m, err := NewAnthropicFromEnv(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	if m.APIKey != implicitGatewayKey {
		t.Errorf("APIKey = %q, want %q (edge-injected)", m.APIKey, implicitGatewayKey)
	}
	if m.BaseURL != "https://llm.int.exe.xyz/anthropic" {
		t.Errorf("BaseURL = %q, want gateway anthropic prefix", m.BaseURL)
	}
	if m.Model != DefaultAnthropicModel {
		t.Errorf("Model = %q, want default %q", m.Model, DefaultAnthropicModel)
	}
}

func TestNewAnthropicFromEnv_NoCredentials(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("ANTHROPIC_BASE_URL", "")
	old := exeDevMarkerPath
	exeDevMarkerPath = filepath.Join(t.TempDir(), "nope")
	t.Cleanup(func() { exeDevMarkerPath = old })

	if _, err := NewAnthropicFromEnv(context.Background(), ""); err == nil {
		t.Errorf("want error when no credentials and not on exe.dev")
	}
}

func TestNewOpenAIFromEnv_PrefersExplicitKey(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "sk-openai-explicit")
	t.Setenv("OPENAI_BASE_URL", "")
	t.Setenv("MEAT_MODEL", "")
	withMarker(t)
	withReflection(t, `{"integrations":[{"name":"llm","type":"llm"}]}`)

	m, err := NewOpenAIFromEnv(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	if m.APIKey != "sk-openai-explicit" {
		t.Errorf("APIKey = %q, want sk-openai-explicit", m.APIKey)
	}
	if m.BaseURL != "" {
		t.Errorf("BaseURL = %q, want empty (default api.openai.com)", m.BaseURL)
	}
	if m.Model != DefaultOpenAIModel {
		t.Errorf("Model = %q, want %q", m.Model, DefaultOpenAIModel)
	}
	if m.ReasoningEffort != DefaultReasoningEffort {
		t.Errorf("ReasoningEffort = %q, want %q", m.ReasoningEffort, DefaultReasoningEffort)
	}
}

func TestNewModelFromEnv_DefaultsToOpenAIThroughGateway(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "")
	t.Setenv("OPENAI_BASE_URL", "")
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("ANTHROPIC_BASE_URL", "")
	t.Setenv("MEAT_MODEL", "")
	withMarker(t)
	withReflection(t, `{"integrations":[{"name":"llm","type":"llm"}]}`)

	model, err := NewModelFromEnv(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	m, ok := model.(*OpenAIModel)
	if !ok {
		t.Fatalf("default backend = %T, want *OpenAIModel", model)
	}
	if m.Model != "gpt-5.6-sol" {
		t.Errorf("Model = %q, want gpt-5.6-sol", m.Model)
	}
	if m.BaseURL != "https://llm.int.exe.xyz/openai" {
		t.Errorf("BaseURL = %q, want gateway OpenAI prefix", m.BaseURL)
	}
	if m.ReasoningEffort != "medium" {
		t.Errorf("ReasoningEffort = %q, want medium", m.ReasoningEffort)
	}
}

func TestNewModelFromEnv_ClaudeUsesAnthropic(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "sk-anthropic")
	t.Setenv("ANTHROPIC_BASE_URL", "")

	model, err := NewModelFromEnv(context.Background(), "claude-sonnet-4-6")
	if err != nil {
		t.Fatal(err)
	}
	m, ok := model.(*AnthropicModel)
	if !ok {
		t.Fatalf("Claude backend = %T, want *AnthropicModel", model)
	}
	if m.Model != "claude-sonnet-4-6" {
		t.Errorf("Model = %q", m.Model)
	}
}

func TestNewOpenAIFromEnv_NoCredentials(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "")
	t.Setenv("OPENAI_BASE_URL", "")
	old := exeDevMarkerPath
	exeDevMarkerPath = filepath.Join(t.TempDir(), "nope")
	t.Cleanup(func() { exeDevMarkerPath = old })

	if _, err := NewOpenAIFromEnv(context.Background(), ""); err == nil {
		t.Errorf("want error when no credentials and not on exe.dev")
	}
}
