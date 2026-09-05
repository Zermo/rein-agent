package meat

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestRubric_ImportsAlwaysHidden is an opt-in, end-to-end smoke test that the
// compiler invariant strips imports around a real model-authored behavioral
// plan. It is gated behind MEAT_E2E=1 because it makes live, costed, stochastic
// model calls; the default `go test` run stays hermetic. Run it with:
//
//	MEAT_E2E=1 go test ./meat -run TestRubric_ImportsAlwaysHidden
//
// It encodes the invariant we want: every import block is hidden, including
// security-relevant package substitutions, while the model still retains the
// body lines that reveal the actual behavior.
func TestRubric_ImportsAlwaysHidden(t *testing.T) {
	if os.Getenv("MEAT_E2E") != "1" {
		t.Skip("set MEAT_E2E=1 to run the live-LLM rubric test")
	}
	ctx := context.Background()
	m, err := NewModelFromEnv(ctx, "")
	if err != nil {
		t.Skipf("no LLM available: %v", err)
	}

	t.Run("security package swap hidden, behavior kept", func(t *testing.T) {
		const diff = `diff --git a/token.go b/token.go
--- a/token.go
+++ b/token.go
@@ -1,14 +1,15 @@
 package auth
 
 import (
-	"math/rand"
+	"crypto/rand"
+	"encoding/hex"
     "fmt"
 )
 
 func NewToken() string {
 	b := make([]byte, 16)
-	for i := range b {
-		b[i] = byte(rand.Intn(256))
-	}
-	return fmt.Sprintf("%x", b)
+	if _, err := rand.Read(b); err != nil {
+		panic(err)
+	}
+	return fmt.Sprintf("%s", hex.EncodeToString(b))
 }
`
		res, err := Abridge(ctx, m, Request{UnifiedDiff: diff})
		if err != nil {
			t.Fatal(err)
		}
		// Every import row and its framing block must disappear, even though the
		// package swap is security-relevant. The body is the evidence we want.
		for _, unwanted := range []string{`import (`, `"math/rand"`, `"crypto/rand"`, `"encoding/hex"`, `"fmt"`} {
			if strings.Contains(res.SmartDiff, unwanted) {
				t.Errorf("import scaffolding %q was kept:\n%s", unwanted, res.SmartDiff)
			}
		}
		if !strings.Contains(res.SmartDiff, "rand.Read") {
			t.Errorf("behavioral body change (rand.Read) was lost:\n%s", res.SmartDiff)
		}
	})

	t.Run("boring stdlib churn dropped", func(t *testing.T) {
		const diff = `diff --git a/util.go b/util.go
--- a/util.go
+++ b/util.go
@@ -1,9 +1,12 @@
 package util
 
 import (
     "fmt"
+	"sort"
+	"strings"
 )
 
 func Join(parts []string) string {
-	return fmt.Sprint(parts)
+	sort.Strings(parts)
+	return fmt.Sprintf("%s", strings.Join(parts, ","))
 }
`
		res, err := Abridge(ctx, m, Request{UnifiedDiff: diff})
		if err != nil {
			t.Fatal(err)
		}
		// The complete import block should be gone; the behavioral body stays.
		for _, unwanted := range []string{`import (`, `"fmt"`, `"sort"`, `"strings"`} {
			if strings.Contains(res.SmartDiff, unwanted) {
				t.Errorf("import scaffolding %q was kept:\n%s", unwanted, res.SmartDiff)
			}
		}
		// Both halves of the behavioral change must survive: the new sort and
		// the new join. (Require both, not either.)
		if !strings.Contains(res.SmartDiff, "sort.Strings") {
			t.Errorf("behavioral change sort.Strings was lost:\n%s", res.SmartDiff)
		}
		if !strings.Contains(res.SmartDiff, "strings.Join") {
			t.Errorf("behavioral change strings.Join was lost:\n%s", res.SmartDiff)
		}
	})
	t.Run("embedded source imports hidden", func(t *testing.T) {
		const diff = `diff --git a/test_plugin.py b/test_plugin.py
--- a/test_plugin.py
+++ b/test_plugin.py
@@ -0,0 +1,13 @@
+def test_plugin(pytester):
+    pytester.makeconftest(
+        """
+        import warnings
+        import pytest
+
+        @pytest.hookimpl(tryfirst=True)
+        def pytest_configure():
+            warnings.warn("boom", UserWarning)
+        """
+    )
+    result = pytester.runpytest()
+    assert result.ret == 0
`
		res, err := Abridge(ctx, m, Request{UnifiedDiff: diff})
		if err != nil {
			t.Fatal(err)
		}
		for _, unwanted := range []string{"import warnings", "import pytest"} {
			if strings.Contains(res.SmartDiff, unwanted) {
				t.Errorf("embedded import %q was kept:\n%s", unwanted, res.SmartDiff)
			}
		}
		// Warning prose and category arguments are fair local-elision targets.
		// Keep the hook/control shape and the warning action itself, rather than
		// requiring the model to reproduce this hand-authored call byte-for-byte.
		for _, want := range []string{"@pytest.hookimpl", "def pytest_configure", "warnings.warn(", "pytester.runpytest", "assert result.ret == 0"} {
			if !strings.Contains(res.SmartDiff, want) {
				t.Errorf("embedded behavior %q was lost:\n%s", want, res.SmartDiff)
			}
		}
	})
}

// TestRubric_PythonGoldenCommits is the live-model companion to the checked-in
// Python golden suite. It is deliberately a stochastic rubric smoke test: it
// checks a small set of load-bearing semantic minima, unconditional import
// absence, and broad retention ceilings calibrated from recorded/review runs.
// It does not require the model to reproduce the hand-authored golden plans.
// TestPythonGoldenCommits is the hermetic hard gate for exact output, anchors,
// folds, move symmetry, and deterministic row/line/byte budgets.
func TestRubric_PythonGoldenCommits(t *testing.T) {
	if os.Getenv("MEAT_E2E") != "1" {
		t.Skip("set MEAT_E2E=1 to run the live-LLM rubric test")
	}
	ctx := context.Background()
	m, err := NewModelFromEnv(ctx, "")
	if err != nil {
		t.Skipf("no LLM available: %v", err)
	}

	type semanticMinimum struct {
		name string
		any  []string
	}
	cases := []struct {
		name              string
		fixture           string
		maxRetention      int
		mustContain       []string
		semanticMinimums  []semanticMinimum
		importsMustBeGone []string
	}{
		{
			name:         "django 526b1b414d8e",
			fixture:      "django-526b1b414d8e.diff",
			maxRetention: 80, // observed live range: about 62-75%.
			mustContain: []string{
				"def split_header_value", "value.split(sep)", "part.strip()", "yield stripped",
			},
			semanticMinimums: []semanticMinimum{
				{
					name: "a migrated production call site",
					any: []string{
						`split_header_value(response.get("Cache-Control"`,
						`split_header_value(response.headers["Cache-Control"]`,
						"newheaders = [newheader.strip() for newheader in newheaders]",
					},
				},
				{
					name: "a representative executable outcome",
					any: []string{
						"self.assertNotEqual(key_a, key_b)",
						`split_header_value(value, sep=";")`,
						`header.lower() != "no-store"`,
					},
				},
			},
			importsMustBeGone: []string{
				"from django.utils.cache import", "from django.utils.http import", `-    cc_delim_re,`, `+    get_max_age,`, `+    split_header_value,`,
			},
		},
		{
			name:         "flask c17f37939073",
			fixture:      "flask-c17f37939073.diff",
			maxRetention: 90, // recorded/review runs naturally retain about 75-86%.
			mustContain: []string{
				"def session(self) -> SessionMixin", "self._session.accessed = True", "return self._session", "accessed = False",
			},
			semanticMinimums: []semanticMinimum{
				{
					name: "an internal path that bypasses access tracking",
					any:  []string{"ctx._session", "session=self._session", "if self._session is None"},
				},
				{
					name: "access-tracking effect or outcome",
					any:  []string{"request_ctx._session.accessed", `"cookie" in rv.vary`, "sets session.accessed"},
				},
			},
			importsMustBeGone: []string{"from flask.globals import", "from flask.testing import"},
		},
		{
			name:         "pytest b4e846616cbb",
			fixture:      "pytest-b4e846616cbb.diff",
			maxRetention: 90, // observed live range: about 66-84%.
			mustContain: []string{
				"def _catch_configured_warnings", `self.getini("filterwarnings")`,
				`self._catch_configured_warnings(record=False)`, `config._catch_configured_warnings(record=record)`,
				"filterwarnings =", "warnings.warn(",
			},
			semanticMinimums: []semanticMinimum{
				{
					name: "the warnings-plugin lifecycle guard",
					any:  []string{`pluginmanager.hasplugin("warnings")`, "pytest_configure.call_historic"},
				},
				{
					name: "a passing no-warning outcome",
					any:  []string{"assert_outcomes(passed=1)", "no_fnmatch_line"},
				},
			},
			importsMustBeGone: []string{
				"from contextlib import ExitStack", "import sys", "from _pytest.config import apply_warning_filters",
				"        import warnings", "        import pytest",
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rawBytes, err := os.ReadFile(filepath.Join("testdata", "python", tc.fixture))
			if err != nil {
				t.Fatal(err)
			}
			raw := string(rawBytes)
			res, err := Abridge(ctx, m, Request{UnifiedDiff: raw})
			if err != nil {
				t.Fatal(err)
			}
			for _, want := range tc.mustContain {
				if !strings.Contains(res.SmartDiff, want) {
					t.Errorf("missing semantic minimum %q:\n%s", want, res.SmartDiff)
				}
			}
			for _, minimum := range tc.semanticMinimums {
				found := false
				for _, alternative := range minimum.any {
					if strings.Contains(res.SmartDiff, alternative) {
						found = true
						break
					}
				}
				if !found {
					t.Errorf("missing semantic minimum %q (want any of %q):\n%s", minimum.name, minimum.any, res.SmartDiff)
				}
			}
			for _, unwanted := range tc.importsMustBeGone {
				if strings.Contains(res.SmartDiff, unwanted) {
					t.Errorf("compiler-owned import scaffolding %q survived:\n%s", unwanted, res.SmartDiff)
				}
			}
			rawChanged, _ := diffStats(raw)
			if rawChanged == 0 {
				t.Fatal("live fixture has no changed rows")
			}
			keptChanged, _ := retainedDiffStats(raw, res.SmartDiff)
			retention := keptChanged * 100 / rawChanged
			t.Logf("live retention: %d/%d changed rows (%d%%; ceiling %d%%)", keptChanged, rawChanged, retention, tc.maxRetention)
			if keptChanged*100 > rawChanged*tc.maxRetention {
				t.Errorf("retained %d/%d changed rows (%d%%), want at most %d%%", keptChanged, rawChanged, retention, tc.maxRetention)
			}
		})
	}
}

// TestRubric_NoSemicolonPacking checks the readability rule: when eliding
// uninteresting plumbing, the rubric must drop lines, not cram several
// statements onto one with semicolons. Output should read like gofmt'd Go.
func TestRubric_NoSemicolonPacking(t *testing.T) {
	if os.Getenv("MEAT_E2E") != "1" {
		t.Skip("set MEAT_E2E=1 to run the live-LLM rubric test")
	}
	ctx := context.Background()
	m, err := NewModelFromEnv(ctx, "")
	if err != nil {
		t.Skipf("no LLM available: %v", err)
	}

	const diff = `diff --git a/serve.go b/serve.go
--- a/serve.go
+++ b/serve.go
@@ -10,3 +10,16 @@
 func Serve(cfg Config, override string) error {
+	host := cfg.Host
+	if override != "" {
+		host = override
+	}
+	port := cfg.Port
+	if port == 0 {
+		port = 8080
+	}
+	addr := fmt.Sprintf("%s:%d", host, port)
+	ln, err := net.Listen("tcp", addr)
+	if err != nil {
+		return fmt.Errorf("listen on %q from configured host %q with override %q: %w", addr, cfg.Host, override, err)
+	}
 	return http.Serve(ln, cfg.Handler)
 }
`
	res, err := Abridge(ctx, m, Request{UnifiedDiff: diff})
	if err != nil {
		t.Fatal(err)
	}
	// The action and newly introduced fallback/override behavior are all
	// meaningful. Diagnostic arguments may stay verbatim or be locally elided;
	// this smoke test only requires the error path and forbids statement packing.
	for _, want := range []string{"net.Listen", `override != ""`, "port = 8080", "fmt.Errorf"} {
		if !strings.Contains(res.SmartDiff, want) {
			t.Errorf("meaningful line %q was lost:\n%s", want, res.SmartDiff)
		}
	}
	// No line should pack multiple statements with an inner semicolon. (Go
	// for-statement "for a; b; c" semicolons live on the same line as "for";
	// flag any other added line carrying a ';'.)
	for _, ln := range strings.Split(res.SmartDiff, "\n") {
		if !strings.HasPrefix(ln, "+") {
			continue
		}
		body := strings.TrimSpace(strings.TrimPrefix(ln, "+"))
		if strings.HasPrefix(body, "for ") {
			continue
		}
		// Ignore semicolons inside a trailing // comment.
		if i := strings.Index(body, "//"); i >= 0 {
			body = body[:i]
		}
		if strings.Contains(body, ";") {
			t.Errorf("semicolon-packed line (should drop lines, not cram them):\n%s\nfull:\n%s", ln, res.SmartDiff)
		}
	}
}
