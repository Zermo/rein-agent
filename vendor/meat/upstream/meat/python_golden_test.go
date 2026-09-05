package meat

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type pythonGoldenCase struct {
	name              string
	base              string
	folds             int
	rawChanged        int
	rawPhysicalRows   int
	rawBytes          int
	maxVisibleChanged int
	maxPhysicalRows   int
	maxBytes          int
	expectedMoves     []detectedMove
	mustContain       []string
	mustNotContain    []string
}

const (
	pythonCorpusRawChanged      = 411
	pythonCorpusRawPhysicalRows = 722
	pythonCorpusRawBytes        = 29739
	pythonCorpusMaxChanged      = 194
	pythonCorpusMaxPhysicalRows = 340
	pythonCorpusMaxBytes        = 14337
)

// TestPythonGoldenCommits applies checked-in, source-coordinate plans to three
// real Python commits that exposed distinct abridging failures. The exact
// reading diffs are snapshots, while the semantic assertions explain what the
// snapshots are protecting.
func TestPythonGoldenCommits(t *testing.T) {
	cases := []pythonGoldenCase{
		{
			name:              "django keeps the header contract, caveats, transformations, and representative outcomes",
			base:              "django-526b1b414d8e",
			folds:             1,
			rawChanged:        178,
			rawPhysicalRows:   329,
			rawBytes:          14468,
			maxVisibleChanged: 89,
			maxPhysicalRows:   155,
			maxBytes:          6685,
			mustContain: []string{
				`+def split_header_value(value, sep=","):`,
				`+    Use only with headers whose values are token lists (e.g. Vary,`,
				`+    (e.g. Set-Cookie), as commas inside values will be used as separators.`,
				`+        if stripped := part.strip():`,
				`+            yield stripped`,
				`+    newheaders = [newheader.strip() for newheader in newheaders]`,
				`+                ("Accept-Encoding\t", "\tcookie"),`,
				`+            ("* ", ("Accept-Language",), "*"),`,
				`+            ("no-cache,\tmax-age=600", 600),`,
				`+        response.headers["Vary"] = " Cookie "`,
				`+        self.assertNotEqual(key_a, key_b)`,
				`+        for cc in (" no-store", "\tno-store", "no-cache, no-store"):`,
				`+            ("text/html; charset=utf-8", ["text/html; charset=utf-8"]),`,
				`+            ("text/html; charset=utf-8", ["text/html", "charset=utf-8"]),`,
			},
			mustNotContain: []string{
				"deduplication so that adding a header", `("Cookie ", ("Cookie",), "Cookie")`,
				`-        for field in cc_delim_re.split`, `-        _to_tuple(el) for el in cc_delim_re.split`,
				`-        for header in cc_delim_re.split`, "A max-age directive with surrounding whitespace",
				"Requests with different Cookie values", "self.assertIsNotNone", `("text/html;", ["text/html"])`,
				"from django.utils.cache import", "from django.utils.http import", `-    cc_delim_re,`, `+    get_max_age,`, `+    split_header_value,`,
			},
		},
		{
			name:              "flask keeps access tracking contracts while collapsing backing-field churn and test batches",
			base:              "flask-c17f37939073",
			folds:             1,
			rawChanged:        124,
			rawPhysicalRows:   234,
			rawBytes:          8803,
			maxVisibleChanged: 63,
			maxPhysicalRows:   120,
			maxBytes:          5037,
			mustContain: []string{
				`-        if not self.session_interface.is_null_session(ctx.session):`,
				`+        if not self.session_interface.is_null_session(ctx._session):`,
				`+    @property`,
				`+    def session(self) -> SessionMixin:`,
				`+        assert self._session is not None`,
				`+        self._session.accessed = True`,
				`+        return self._session`,
				`-    accessed = True`,
				`+    accessed = False`,
				`-        initial: c.Mapping[str, t.Any] | c.Iterable[tuple[str, t.Any]] | None = None,`,
				`+        initial: c.Mapping[str, t.Any] | None = None,`,
				`-            self.accessed = True`,
				`-    ...`,
				`+        # The session proxy cannot be replaced, accessing it gets`,
				`+        assert "cookie" not in rv.vary`,
				`+        assert request_ctx._session.modified`,
				`+        assert not request_ctx._session.modified`,
			},
			mustNotContain: []string{
				`-    def __getitem__`, `-    def get(`, `-    def setdefault`, "Not available until",
				"Indicates if the session was accessed", ".. versionchanged::", `+        assert rv.text == "value set"`,
				`+        assert rv.text == ""`, "from flask.globals import", "from flask.testing import",
			},
		},
		{
			name:              "pytest keeps warning-filter lifecycle, symmetric move evidence, stimulus, and outcome",
			base:              "pytest-b4e846616cbb",
			folds:             2,
			rawChanged:        109,
			rawPhysicalRows:   159,
			rawBytes:          6468,
			maxVisibleChanged: 42,
			maxPhysicalRows:   65,
			maxBytes:          2615,
			expectedMoves: []detectedMove{{
				Removed: lineRange{StartLine: 72, EndLine: 81},
				Added:   lineRange{StartLine: 23, EndLine: 32},
			}},
			mustContain: []string{
				`+    @contextlib.contextmanager`,
				`+    def _catch_configured_warnings(`,
				`+        config_filters = self.getini("filterwarnings")`,
				`+        with warnings.catch_warnings(record=record) as log:`,
				`-    with warnings.catch_warnings(record=record) as log:`,
				`+            if not sys.warnoptions:`,
				`-        if not sys.warnoptions:`,
				`+            apply_warning_filters(config_filters, cmdline_filters)`,
				`-        apply_warning_filters(config_filters, cmdline_filters)`,
				`+        if self.pluginmanager.hasplugin("warnings"):`,
				`+                stack.enter_context(self._catch_configured_warnings(record=False))`,
				`+                self.add_cleanup(stack.pop_all().close)`,
				`+    with config._catch_configured_warnings(record=record) as log:`,
				`+        filterwarnings =`,
				`+            ignore::UserWarning`,
				`+        @pytest.hookimpl(tryfirst={tryfirst})`,
				`+            warnings.warn("from pytest_configure", UserWarning)`,
				`+    pytester.makepyfile("def test_it(): pass")`,
				`+    result.assert_outcomes(passed=1)`,
				`+    result.stdout.no_fnmatch_line("*from pytest_configure*")`,
			},
			mustNotContain: []string{
				"Defined here instead of _pytest.warnings", "Parametrize over ``tryfirst``",
				"this disables recording because the terminalreporter", "filterwarnings(warning): add a warning filter",
				`+    result.stderr.no_fnmatch_line("*from pytest_configure*")`,
				"from contextlib import ExitStack", "import sys", "from _pytest.config import apply_warning_filters",
				"        import warnings", "        import pytest",
			},
		},
	}

	var corpus struct {
		rawChanged, rawPhysicalRows, rawBytes      int
		visibleChanged, visiblePhysicalRows, bytes int
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := filepath.Join("testdata", "python")
			raw := mustReadTestFile(t, filepath.Join(dir, tc.base+".diff"))
			rawPhysicalRows := len(splitSourceLines(raw))
			rawChanged, _ := diffStats(raw)
			if rawChanged != tc.rawChanged || rawPhysicalRows != tc.rawPhysicalRows || len(raw) != tc.rawBytes {
				t.Fatalf("raw corpus metrics = changed %d, physical rows %d, bytes %d; want %d, %d, %d", rawChanged, rawPhysicalRows, len(raw), tc.rawChanged, tc.rawPhysicalRows, tc.rawBytes)
			}
			corpus.rawChanged += rawChanged
			corpus.rawPhysicalRows += rawPhysicalRows
			corpus.rawBytes += len(raw)
			detectedMoves := detectedMovesInDiff(raw)
			for _, expected := range tc.expectedMoves {
				if !containsDetectedMove(detectedMoves, expected) {
					t.Fatalf("expected exact move %+v, detected %+v", expected, detectedMoves)
				}
			}
			if allHidden, err := compileEditPlan(raw, editPlan{Remove: []lineRange{{StartLine: 1, EndLine: len(splitSourceLines(raw))}}}); err != nil || allHidden.smartDiff != "" {
				t.Fatalf("complete fixture removal = (%q, %v)", allHidden.smartDiff, err)
			}
			var plan editPlan
			if err := json.Unmarshal([]byte(mustReadTestFile(t, filepath.Join(dir, tc.base+".plan.json"))), &plan); err != nil {
				t.Fatalf("decode golden plan: %v", err)
			}
			if plan.Remove == nil || plan.Replace == nil || plan.Fold == nil {
				t.Fatal("golden plan arrays must be non-null")
			}
			assertGoldenPlanLeavesImportsAutomatic(t, raw, plan)
			compiled, err := compileEditPlan(raw, plan)
			if err != nil {
				t.Fatalf("compile golden plan: %v", err)
			}
			if compiled.stats.foldCount != tc.folds {
				t.Fatalf("fold count = %d, want %d", compiled.stats.foldCount, tc.folds)
			}
			if compiled.stats.visibleChanged > tc.maxVisibleChanged {
				t.Fatalf("visible changed rows = %d, budget %d: %+v", compiled.stats.visibleChanged, tc.maxVisibleChanged, compiled.stats)
			}
			visiblePhysicalRows := len(splitSourceLines(compiled.smartDiff))
			if visiblePhysicalRows > tc.maxPhysicalRows {
				t.Fatalf("visible physical rows = %d, budget %d", visiblePhysicalRows, tc.maxPhysicalRows)
			}
			if len(compiled.smartDiff) > tc.maxBytes {
				t.Fatalf("visible bytes = %d, budget %d", len(compiled.smartDiff), tc.maxBytes)
			}
			corpus.visibleChanged += compiled.stats.visibleChanged
			corpus.visiblePhysicalRows += visiblePhysicalRows
			corpus.bytes += len(compiled.smartDiff)
			for _, expected := range tc.expectedMoves {
				mutated := plan
				mutated.Remove = append(append([]lineRange(nil), plan.Remove...), lineRange{
					StartLine: expected.Removed.StartLine,
					EndLine:   expected.Removed.StartLine,
				})
				_, err := compileEditPlan(raw, mutated)
				pair := fmt.Sprintf("removed lines %d-%d match added lines %d-%d", expected.Removed.StartLine, expected.Removed.EndLine, expected.Added.StartLine, expected.Added.EndLine)
				if err == nil || !strings.Contains(err.Error(), "move symmetry") || !strings.Contains(err.Error(), pair) {
					t.Fatalf("asymmetric move mutation error = %v, want precise pair %q", err, pair)
				}
			}
			for _, want := range tc.mustContain {
				if !strings.Contains(compiled.smartDiff, want) {
					t.Errorf("golden missing semantic anchor %q", want)
				}
			}
			for _, unwanted := range tc.mustNotContain {
				if strings.Contains(compiled.smartDiff, unwanted) {
					t.Errorf("golden retained folded noise %q", unwanted)
				}
			}

			goldenPath := filepath.Join(dir, tc.base+".golden.diff")
			if os.Getenv("UPDATE_GOLDEN") == "1" {
				if err := os.WriteFile(goldenPath, []byte(compiled.smartDiff), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			want := mustReadTestFile(t, goldenPath)
			if compiled.smartDiff != want {
				t.Fatalf("reading diff does not match %s; run UPDATE_GOLDEN=1 go test ./meat -run TestPythonGoldenCommits", goldenPath)
			}
		})
	}
	if corpus.rawChanged != pythonCorpusRawChanged || corpus.rawPhysicalRows != pythonCorpusRawPhysicalRows || corpus.rawBytes != pythonCorpusRawBytes {
		t.Fatalf("raw corpus totals = changed %d, physical rows %d, bytes %d; want %d, %d, %d", corpus.rawChanged, corpus.rawPhysicalRows, corpus.rawBytes, pythonCorpusRawChanged, pythonCorpusRawPhysicalRows, pythonCorpusRawBytes)
	}
	if corpus.visibleChanged > pythonCorpusMaxChanged || corpus.visiblePhysicalRows > pythonCorpusMaxPhysicalRows || corpus.bytes > pythonCorpusMaxBytes {
		t.Fatalf("visible corpus totals = changed %d/%d, physical rows %d/%d, bytes %d/%d", corpus.visibleChanged, pythonCorpusMaxChanged, corpus.visiblePhysicalRows, pythonCorpusMaxPhysicalRows, corpus.bytes, pythonCorpusMaxBytes)
	}
}

func assertGoldenPlanLeavesImportsAutomatic(t *testing.T, raw string, plan editPlan) {
	t.Helper()
	lines := splitSourceLines(raw)
	layout := analyzeDiff(lines)
	mandatory := make([]bool, len(lines))
	for _, r := range mandatoryImportRemovalPlan(lines, layout) {
		for line := r.StartLine; line <= r.EndLine; line++ {
			mandatory[line-1] = true
		}
	}
	check := func(kind string, index, start, end int) {
		for line := start; line <= end; line++ {
			if mandatory[line-1] {
				t.Fatalf("%s[%d] explicitly targets compiler-owned import line %d; leave import hiding automatic", kind, index, line)
			}
		}
	}
	for i, r := range plan.Remove {
		check("remove", i, r.StartLine, r.EndLine)
	}
	for i, f := range plan.Fold {
		check("fold", i, f.StartLine, f.EndLine)
	}
	for i, r := range plan.Replace {
		check("replace", i, r.Line, r.Line)
	}
}

func containsDetectedMove(moves []detectedMove, want detectedMove) bool {
	for _, move := range moves {
		if move == want {
			return true
		}
	}
	return false
}

func mustReadTestFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
