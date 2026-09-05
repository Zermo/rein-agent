package meat

import "testing"

// TestResolveModel pins the precedence the cache key depends on: an explicit
// model wins, then $MEAT_MODEL, then the built-in default — with no network or
// credentials involved.
func TestResolveModel(t *testing.T) {
	t.Run("explicit wins over env", func(t *testing.T) {
		t.Setenv("MEAT_MODEL", "env-model")
		if got := ResolveModel("explicit"); got != "explicit" {
			t.Errorf("ResolveModel(explicit) = %q, want explicit", got)
		}
	})
	t.Run("env used when no explicit", func(t *testing.T) {
		t.Setenv("MEAT_MODEL", "env-model")
		if got := ResolveModel(""); got != "env-model" {
			t.Errorf("ResolveModel(\"\") = %q, want env-model", got)
		}
	})
	t.Run("default when nothing set", func(t *testing.T) {
		t.Setenv("MEAT_MODEL", "")
		if got := ResolveModel(""); got != DefaultModel {
			t.Errorf("ResolveModel(\"\") = %q, want %q", got, DefaultModel)
		}
	})
}
