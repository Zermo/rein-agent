package meat

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const editableDiff = "diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@ -1,2 +1,4 @@\n package a\n-old := fmt.Errorf(\"old %s\", name)\n+new := fmt.Errorf(\"new %s for %s\", name, user)\n+copy.UserID = row.userID\n+copy.BoxID = int64(row.boxID)\n"

func validSubmission() submission {
	return submission{Summary: "Updates error handling and copied fields."}
}

func TestCompileEditPlan_PythonFold(t *testing.T) {
	raw := "diff --git a/a.py b/a.py\n@@ -0,0 +1,5 @@\n+def rebuild():\n+    setup()\n+    work()\n+    more()\n+    assert done\n"
	compiled, err := compileEditPlan(raw, editPlan{
		Remove:  []lineRange{},
		Replace: []lineReplacement{},
		Fold:    []lineFold{{StartLine: 4, EndLine: 6}},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := "diff --git a/a.py b/a.py\n@@ -0,0 +1,5 @@\n+def rebuild():\n+    ...\n+    assert done\n"
	if compiled.smartDiff != want {
		t.Fatalf("folded diff =\n%q\nwant\n%q", compiled.smartDiff, want)
	}
	if compiled.stats.rawChanged != 5 || compiled.stats.visibleChanged != 3 || compiled.stats.foldedChanged != 3 || compiled.stats.foldCount != 1 {
		t.Fatalf("fold stats = %+v", compiled.stats)
	}
}

func TestCompileEditPlan_FoldPreservesMarkerIndentAndEOL(t *testing.T) {
	raw := "diff --git a/a.py b/a.py\r\n@@ -1,3 +0,0 @@\r\n-\tdef old():\r\n-\t\tfirst()\r\n-\t\tsecond()"
	compiled, err := compileEditPlan(raw, editPlan{
		Remove:  []lineRange{},
		Replace: []lineReplacement{},
		Fold:    []lineFold{{StartLine: 3, EndLine: 5}},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := "diff --git a/a.py b/a.py\r\n@@ -1,3 +0,0 @@\r\n-\t..."
	if compiled.smartDiff != want {
		t.Fatalf("folded CRLF diff = %q, want %q", compiled.smartDiff, want)
	}
}

func TestCompileEditPlan_RejectsFoldedDefinitionWithRetainedConsumer(t *testing.T) {
	raw := "diff --git a/a.py b/a.py\n@@ -0,0 +1,6 @@\n+tests = [\n+    (1, True),\n+    (2, False),\n+]\n+for value, expected in tests:\n+    assert check(value) is expected\n"
	_, err := compileEditPlan(raw, editPlan{
		Remove:  []lineRange{},
		Replace: []lineReplacement{},
		Fold:    []lineFold{{StartLine: 3, EndLine: 6}},
	})
	if err == nil || !strings.Contains(err.Error(), `hides definition "tests"`) {
		t.Fatalf("compileEditPlan error = %v", err)
	}
	_, err = compileEditPlan(raw, editPlan{Remove: []lineRange{{StartLine: 3, EndLine: 6}}})
	if err == nil || !strings.Contains(err.Error(), `remove: hides definition "tests"`) {
		t.Fatalf("remove definition error = %v", err)
	}

	compiled, err := compileEditPlan(raw, editPlan{
		Remove:  []lineRange{},
		Replace: []lineReplacement{},
		Fold:    []lineFold{{StartLine: 4, EndLine: 5}},
	})
	if err != nil {
		t.Fatalf("interior-only fold: %v", err)
	}
	if !strings.Contains(compiled.smartDiff, "+tests = [\n+    ...\n+]\n+for value, expected in tests:") {
		t.Fatalf("interior-only reading skeleton =\n%s", compiled.smartDiff)
	}
}

func TestCompileEditPlan_RequiresBodyForRetainedPythonSuite(t *testing.T) {
	raw := "diff --git a/a.py b/a.py\n@@ -0,0 +1,5 @@\n+def test_one():\n+    setup()\n+    assert result\n+def test_two():\n+    assert other\n"
	_, err := compileEditPlan(raw, editPlan{
		Remove: []lineRange{{StartLine: 4, EndLine: 5}},
	})
	if err == nil || !strings.Contains(err.Error(), "suite owner on line 3 has no indented body") {
		t.Fatalf("bare suite error = %v", err)
	}

	compiled, err := compileEditPlan(raw, editPlan{
		Fold: []lineFold{{StartLine: 4, EndLine: 5}},
	})
	if err != nil {
		t.Fatalf("suite body fold: %v", err)
	}
	if !strings.Contains(compiled.smartDiff, "+def test_one():\n+    ...\n") {
		t.Fatalf("suite fold =\n%s", compiled.smartDiff)
	}
}

func TestCompileEditPlan_OverlappingPythonReplacementsReturnError(t *testing.T) {
	raw := "diff --git a/a.py b/a.py\n@@ -0,0 +1 @@\n+result = format(name, user)\n"
	_, err := compileEditPlan(raw, editPlan{Replace: []lineReplacement{
		{Line: 3, Old: "name, user", New: "..."},
		{Line: 3, Old: "user", New: "..."},
	}})
	if err == nil || !strings.Contains(err.Error(), "overlaps") {
		t.Fatalf("overlapping Python replacements error = %v", err)
	}
}

func TestCompileEditPlan_RejectsPythonStructuralReplacements(t *testing.T) {
	raw := "diff --git a/a.py b/a.py\n@@ -0,0 +1,3 @@\n+@decorator\n+def f():\n+    work()\n"
	for _, replacement := range []lineReplacement{
		{Line: 3, Old: "@decorator", New: "..."},
		{Line: 4, Old: "def f():", New: "..."},
	} {
		_, err := compileEditPlan(raw, editPlan{Replace: []lineReplacement{replacement}})
		if err == nil || !strings.Contains(err.Error(), "structural anchors intact") {
			t.Fatalf("structural replacement %+v error = %v", replacement, err)
		}
	}
}

func TestCompileEditPlan_PreservesPythonSuiteAnchorsAndTripleQuotes(t *testing.T) {
	decorated := "diff --git a/a.py b/a.py\n@@ -0,0 +1,3 @@\n+@pytest.mark.slow\n+def test_it():\n+    assert result\n"
	_, err := compileEditPlan(decorated, editPlan{Fold: []lineFold{{StartLine: 3, EndLine: 4}}})
	if err == nil || !strings.Contains(err.Error(), "decorator or suite owner") {
		t.Fatalf("anchor fold error = %v", err)
	}
	_, err = compileEditPlan(decorated, editPlan{Remove: []lineRange{{StartLine: 4, EndLine: 5}}})
	if err == nil || !strings.Contains(err.Error(), "decorator on line 3 has no attached definition") {
		t.Fatalf("detached decorator error = %v", err)
	}

	quoted := "diff --git a/a.py b/a.py\n@@ -0,0 +1,5 @@\n+def test_it():\n+    \"\"\"scenario\n+    stimulus\n+    \"\"\"\n+    assert result\n"
	_, err = compileEditPlan(quoted, editPlan{Remove: []lineRange{{StartLine: 6, EndLine: 6}}})
	if err == nil || !strings.Contains(err.Error(), "balanced Python") {
		t.Fatalf("unbalanced string error = %v", err)
	}
	if _, err := compileEditPlan(quoted, editPlan{Remove: []lineRange{{StartLine: 4, EndLine: 6}}}); err != nil {
		t.Fatalf("complete docstring removal: %v", err)
	}

	_, err = compileEditPlan(quoted, editPlan{Replace: []lineReplacement{{Line: 4, Old: `"""scenario`, New: "..."}}})
	if err == nil || !strings.Contains(err.Error(), "boundary tokens") {
		t.Fatalf("triple-quote replacement error = %v", err)
	}
}

func TestCompileEditPlan_PythonChecksAreFileScoped(t *testing.T) {
	objc := "diff --git a/Foo.m b/Foo.m\n@@ -0,0 +1,2 @@\n+@interface Foo\n+@end\n"
	if _, err := compileEditPlan(objc, editPlan{}); err != nil {
		t.Fatalf("Objective-C identity plan was treated as Python: %v", err)
	}
}

func TestCompileEditPlan_RejectsHiddenOwnerWithVisibleBody(t *testing.T) {
	raw := "diff --git a/a.py b/a.py\n@@ -1,2 +1,2 @@\n def f():\n-    old()\n+    new()\n"
	_, err := compileEditPlan(raw, editPlan{Remove: []lineRange{{StartLine: 3, EndLine: 3}}})
	if err == nil || !strings.Contains(err.Error(), "hides Python suite owner on line 3") {
		t.Fatalf("hidden owner error = %v", err)
	}
}

func TestCompileEditPlan_FoldsMultilineDefinitionArgumentsButNotOwner(t *testing.T) {
	raw := "diff --git a/a.py b/a.py\n@@ -0,0 +1,5 @@\n+def build(\n+    first,\n+    second,\n+):\n+    return first\n"
	compiled, err := compileEditPlan(raw, editPlan{Fold: []lineFold{{StartLine: 4, EndLine: 5}}})
	if err != nil {
		t.Fatalf("multiline argument fold: %v", err)
	}
	if !strings.Contains(compiled.smartDiff, "+def build(\n+    ...\n+):\n+    return first") {
		t.Fatalf("multiline argument fold =\n%s", compiled.smartDiff)
	}
	_, err = compileEditPlan(raw, editPlan{Fold: []lineFold{{StartLine: 3, EndLine: 6}}})
	if err == nil || !strings.Contains(err.Error(), "decorator or suite owner") {
		t.Fatalf("whole signature fold error = %v", err)
	}
}

func TestCompileEditPlan_DocstringDelimiterTextDoesNotAffectBalance(t *testing.T) {
	raw := "diff --git a/a.py b/a.py\n@@ -0,0 +1,6 @@\n+def explain():\n+    \"\"\"Example:\n+    foo(\n+    [value]\n+    \"\"\"\n+    return value\n"
	compiled, err := compileEditPlan(raw, editPlan{Fold: []lineFold{{StartLine: 4, EndLine: 7}}})
	if err != nil {
		t.Fatalf("docstring delimiter fold: %v", err)
	}
	if !strings.Contains(compiled.smartDiff, "+    ...\n+    return value") {
		t.Fatalf("docstring fold =\n%s", compiled.smartDiff)
	}
}

func TestCompileEditPlan_ProtectsBackslashContinuations(t *testing.T) {
	raw := "diff --git a/a.py b/a.py\n@@ -0,0 +1,3 @@\n+value = first + \\\n+    second\n+done = True\n"
	_, err := compileEditPlan(raw, editPlan{Remove: []lineRange{{StartLine: 4, EndLine: 4}}})
	if err == nil || !strings.Contains(err.Error(), "backslash continuation") {
		t.Fatalf("backslash continuation error = %v", err)
	}
}

func TestCompileEditPlan_ProtectsContextDecoratorsAndCrossHunkDefinitions(t *testing.T) {
	contextDecorator := "diff --git a/a.py b/a.py\n@@ -1,4 +1,4 @@\n @decorator\n def test_it():\n-    old()\n+    new()\n-OLD = 1\n+OLD = 2\n"
	_, err := compileEditPlan(contextDecorator, editPlan{Remove: []lineRange{{StartLine: 4, EndLine: 6}}})
	if err == nil || !strings.Contains(err.Error(), "decorator on line 3 has no attached definition") {
		t.Fatalf("detached context decorator error = %v", err)
	}

	crossHunk := "diff --git a/a.py b/a.py\n@@ -0,0 +1,3 @@\n+tests = [\n+    1,\n+]\n@@ -10,0 +14,2 @@\n+for case in tests:\n+    assert case\n"
	_, err = compileEditPlan(crossHunk, editPlan{Remove: []lineRange{{StartLine: 2, EndLine: 5}}})
	if err == nil || !strings.Contains(err.Error(), `hides definition "tests"`) {
		t.Fatalf("cross-hunk definition error = %v", err)
	}
}

func TestCompileEditPlan_LeadingContextCloserDoesNotDisableReferenceGuard(t *testing.T) {
	raw := "diff --git a/a.py b/a.py\n@@ -1,2 +1,5 @@\n" +
		"     )\n" + // closes a call opened above the hunk
		" \n" +
		"+    request_a = factory.get(path)\n" +
		"+    learn(request_a)\n" +
		"+    assert request_a\n"
	_, err := compileEditPlan(raw, editPlan{Remove: []lineRange{{StartLine: 5, EndLine: 5}}})
	if err == nil || !strings.Contains(err.Error(), `hides definition "request_a"`) {
		t.Fatalf("reference guard after leading context closer error = %v", err)
	}
}

func TestCompileEditPlan_TripleQuoteTokensInsideOrdinaryStringsAreNotBoundaries(t *testing.T) {
	raw := "diff --git a/a.py b/a.py\n@@ -0,0 +1,2 @@\n+value = '\"\"\"'\n+keep = 1\n"
	if _, err := compileEditPlan(raw, editPlan{Remove: []lineRange{{StartLine: 3, EndLine: 3}}}); err != nil {
		t.Fatalf("ordinary string containing triple-quote token: %v", err)
	}
}

func TestCompileEditPlan_AllowsMultilineDecoratorAndZeroContextSignature(t *testing.T) {
	decorator := "diff --git a/test_a.py b/test_a.py\n@@ -0,0 +1,6 @@\n+@pytest.mark.parametrize(\n+    \"x\",\n+    [1, 2],\n+)\n+def test_x(x):\n+    assert x\n"
	if _, err := compileEditPlan(decorator, editPlan{}); err != nil {
		t.Fatalf("multiline decorator identity plan: %v", err)
	}
	_, err := compileEditPlan(decorator, editPlan{Remove: []lineRange{{StartLine: 7, EndLine: 8}}})
	if err == nil || !strings.Contains(err.Error(), "decorator on line 3 has no attached definition") {
		t.Fatalf("detached multiline decorator error = %v", err)
	}

	zeroContext := "diff --git a/a.py b/a.py\n@@ -10 +10 @@\n-def parse(old):\n+def parse(new):\n"
	if _, err := compileEditPlan(zeroContext, editPlan{}); err != nil {
		t.Fatalf("zero-context signature-only hunk: %v", err)
	}
}

func TestCompileEditPlan_PreservesPythonDelimiterBalanceAndDottedDefinitions(t *testing.T) {
	multiline := "diff --git a/a.py b/a.py\n@@ -0,0 +1,4 @@\n+def build(\n+    value,\n+):\n+    return value\n"
	_, err := compileEditPlan(multiline, editPlan{Fold: []lineFold{{StartLine: 4, EndLine: 5}}})
	if err == nil || !strings.Contains(err.Error(), "delimiter balance") {
		t.Fatalf("unbalanced multiline fold error = %v", err)
	}
	_, err = compileEditPlan(multiline, editPlan{Remove: []lineRange{{StartLine: 6, EndLine: 6}}})
	if err == nil || !strings.Contains(err.Error(), "suite owner on line 3 has no indented body") {
		t.Fatalf("multiline definition without body error = %v", err)
	}

	dotted := "diff --git a/a.py b/a.py\n@@ -0,0 +1,6 @@\n+self.tests = [\n+    1,\n+]\n+for case in self.tests:\n+    assert case\n+done = True\n"
	_, err = compileEditPlan(dotted, editPlan{Fold: []lineFold{{StartLine: 3, EndLine: 5}}})
	if err == nil || !strings.Contains(err.Error(), `hides definition "self.tests"`) {
		t.Fatalf("dotted definition fold error = %v", err)
	}
}

func TestCompileEditPlan_ProtectsPythonSuiteOwnersWithTrailingComments(t *testing.T) {
	raw := "diff --git a/a.py b/a.py\n@@ -0,0 +1,3 @@\n+def helper():  # setup helper\n+    return 1\n+result = 1\n"
	_, err := compileEditPlan(raw, editPlan{Fold: []lineFold{{StartLine: 3, EndLine: 4}}})
	if err == nil || !strings.Contains(err.Error(), "suite owner") {
		t.Fatalf("commented owner fold error = %v", err)
	}
	_, err = compileEditPlan(raw, editPlan{Remove: []lineRange{{StartLine: 4, EndLine: 4}}})
	if err == nil || !strings.Contains(err.Error(), "suite owner on line 3 has no indented body") {
		t.Fatalf("commented owner body removal error = %v", err)
	}
}

func TestCompileEditPlan_AllowsKeywordArgumentInteriorFold(t *testing.T) {
	raw := "diff --git a/a.py b/a.py\n@@ -0,0 +1,6 @@\n+def fetch(timeout):\n+    return request(\n+        timeout=timeout,\n+        retries=3,\n+    )\n+done = True\n"
	compiled, err := compileEditPlan(raw, editPlan{Fold: []lineFold{{StartLine: 5, EndLine: 6}}})
	if err != nil {
		t.Fatalf("keyword argument fold: %v", err)
	}
	if !strings.Contains(compiled.smartDiff, "+        ...") {
		t.Fatalf("keyword argument fold =\n%s", compiled.smartDiff)
	}
}

func TestCompileEditPlan_HiddenRegionsCannotCrossAdjacentBoundaries(t *testing.T) {
	calls := "diff --git a/a.py b/a.py\n@@ -0,0 +1,6 @@\n+x = first(\n+    1,\n+)\n+y = second(\n+    2,\n+)\n"
	_, err := compileEditPlan(calls, editPlan{Fold: []lineFold{{StartLine: 5, EndLine: 6}}})
	if err == nil || !strings.Contains(err.Error(), "crosses new-side expression") {
		t.Fatalf("cross-call boundary error = %v", err)
	}

	stringsDiff := "diff --git a/a.py b/a.py\n@@ -0,0 +1,6 @@\n+x = \"\"\"\n+first\n+\"\"\"\n+y = \"\"\"\n+second\n+\"\"\"\n"
	_, err = compileEditPlan(stringsDiff, editPlan{Fold: []lineFold{{StartLine: 5, EndLine: 6}}})
	if err == nil || !strings.Contains(err.Error(), "crosses new-side expression or string boundaries") {
		t.Fatalf("cross-string boundary error = %v", err)
	}
}

func TestCompileEditPlan_ProtectsMultilineAndExceptStarOwners(t *testing.T) {
	multilineIf := "diff --git a/a.py b/a.py\n@@ -0,0 +1,4 @@\n+if (\n+    condition\n+):\n+    work()\n"
	_, err := compileEditPlan(multilineIf, editPlan{Fold: []lineFold{{StartLine: 3, EndLine: 5}}})
	if err == nil || !strings.Contains(err.Error(), "suite owner") {
		t.Fatalf("multiline if fold error = %v", err)
	}

	exceptStar := "diff --git a/a.py b/a.py\n@@ -0,0 +1,2 @@\n+except* ValueError:\n+    recover()\n"
	_, err = compileEditPlan(exceptStar, editPlan{Remove: []lineRange{{StartLine: 3, EndLine: 3}}})
	if err == nil || !strings.Contains(err.Error(), "hides Python suite owner") {
		t.Fatalf("except* owner error = %v", err)
	}
}

func TestCompileEditPlan_FoldAwareOwnerScanning(t *testing.T) {
	contextDef := "diff --git a/a.py b/a.py\n@@ -1,3 +1,2 @@\n def f():\n-    old_one()\n-    old_two()\n+    new()\n"
	plan := editPlan{Fold: []lineFold{{StartLine: 4, EndLine: 5}}}
	if _, err := compileEditPlan(contextDef, plan); err != nil {
		t.Fatalf("deleted-side fold under context owner: %v", err)
	}
	plan.Remove = []lineRange{{StartLine: 3, EndLine: 3}}
	_, err := compileEditPlan(contextDef, plan)
	if err == nil || !strings.Contains(err.Error(), "hides Python suite owner") {
		t.Fatalf("hidden context owner with deleted fold error = %v", err)
	}

	decorator := "diff --git a/a.py b/a.py\n@@ -0,0 +1,6 @@\n+@mark(\n+    first,\n+    second,\n+)\n+def f():\n+    work()\n"
	if _, err := compileEditPlan(decorator, editPlan{Fold: []lineFold{{StartLine: 4, EndLine: 5}}}); err != nil {
		t.Fatalf("multiline decorator argument fold: %v", err)
	}
}

func TestCompileEditPlan_PythonClassificationIgnoresStringContent(t *testing.T) {
	docstring := "diff --git a/a.py b/a.py\n@@ -0,0 +1,6 @@\n+def f():\n+    \"\"\"Notes:\n+    if flag:\n+    @decorator\n+    \"\"\"\n+    return 1\n"
	if _, err := compileEditPlan(docstring, editPlan{Fold: []lineFold{{StartLine: 5, EndLine: 6}}}); err != nil {
		t.Fatalf("docstring code-like prose fold: %v", err)
	}

	stringConsumer := "diff --git a/a.py b/a.py\n@@ -0,0 +1,5 @@\n+tests = [\n+    1,\n+]\n+print(\"tests completed\")\n+done = True\n"
	if _, err := compileEditPlan(stringConsumer, editPlan{Fold: []lineFold{{StartLine: 3, EndLine: 5}}}); err != nil {
		t.Fatalf("string-only assignment name mention: %v", err)
	}
}

func TestCompileEditPlan_CommentOnlySuiteBodyIsNotSemantic(t *testing.T) {
	raw := "diff --git a/a.py b/a.py\n@@ -0,0 +1,4 @@\n+def f():\n+    # explanation\n+    work()\n+done = True\n"
	_, err := compileEditPlan(raw, editPlan{Remove: []lineRange{{StartLine: 5, EndLine: 5}}})
	if err == nil || !strings.Contains(err.Error(), "no indented body") {
		t.Fatalf("comment-only body error = %v", err)
	}
}

func TestCompileEditPlan_RejectsInvalidFolds(t *testing.T) {
	raw := "diff --git a/a.py b/a.py\n@@ -1,2 +1,4 @@\n-old()\n+new()\n+other()\n+third()\n context\n"
	cases := []struct {
		name   string
		plan   editPlan
		needle string
	}{
		{"one line", editPlan{Fold: []lineFold{{StartLine: 3, EndLine: 3}}}, "at least two"},
		{"mixed polarity", editPlan{Fold: []lineFold{{StartLine: 3, EndLine: 4}}}, "mixed diff markers"},
		{"metadata", editPlan{Fold: []lineFold{{StartLine: 2, EndLine: 3}}}, "not source"},
		{"remove overlap", editPlan{Remove: []lineRange{{StartLine: 4, EndLine: 4}}, Fold: []lineFold{{StartLine: 4, EndLine: 5}}}, "overlaps remove"},
		{"fold overlap", editPlan{Fold: []lineFold{{StartLine: 4, EndLine: 5}, {StartLine: 5, EndLine: 6}}}, "overlaps fold"},
		{"replace overlap", editPlan{Replace: []lineReplacement{{Line: 4, Old: "new", New: "..."}}, Fold: []lineFold{{StartLine: 4, EndLine: 5}}}, "also folded"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.plan.Remove == nil {
				tc.plan.Remove = []lineRange{}
			}
			if tc.plan.Replace == nil {
				tc.plan.Replace = []lineReplacement{}
			}
			if tc.plan.Fold == nil {
				tc.plan.Fold = []lineFold{}
			}
			_, err := compileEditPlan(raw, tc.plan)
			if err == nil || !strings.Contains(err.Error(), tc.needle) {
				t.Fatalf("compileEditPlan error = %v, want %q", err, tc.needle)
			}
		})
	}
}

func TestElisionProjection(t *testing.T) {
	for _, tc := range []struct {
		old, new string
		want     bool
	}{
		{".sshKeyID", "...", true},
		{"new", "n...", true},
		{"prefix middle suffix", "prefix ... suffix", true},
		{"if !allowed", "if allowed", false},
		{"safe()", "dangerousCall()", false},
		{"user", "user...", false}, // ellipsis must hide something
		{"x", "....", false},       // only exactly ... or … is a placeholder
		{"xy", "...…", false},      // adjacent placeholders are meaningless
		{"same", "same", false},
	} {
		if got := isElisionProjection(tc.old, tc.new); got != tc.want {
			t.Errorf("isElisionProjection(%q, %q) = %v, want %v", tc.old, tc.new, got, tc.want)
		}
	}
}

func TestApplyEditPlan_RubricFieldProjection(t *testing.T) {
	raw := "diff --git a/a.go b/a.go\n@@ -0,0 +1 @@\n+resp.SSHKeyID = rd.sshKeyID\n"
	in := submission{
		Summary: "Copies route metadata.",
		Replace: []lineReplacement{{Line: 3, Old: ".sshKeyID", New: "..."}},
	}
	got, err := applyEditPlan(raw, in)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "+resp.SSHKeyID = rd...\n") {
		t.Fatalf("rubric projection =\n%s", got)
	}
}

func TestApplyEditPlan_RemovalAndLocalReplacement(t *testing.T) {
	in := validSubmission()
	in.Remove = []lineRange{{StartLine: 9, EndLine: 9}}
	in.Replace = []lineReplacement{{
		Line: 7,
		Old:  `"new %s for %s", name, user`,
		New:  `...`,
	}}
	got, err := applyEditPlan(editableDiff, in)
	if err != nil {
		t.Fatal(err)
	}
	want := "diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@ -1,2 +1,4 @@\n package a\n-old := fmt.Errorf(\"old %s\", name)\n+new := fmt.Errorf(...)\n+copy.UserID = row.userID\n"
	if got != want {
		t.Fatalf("applyEditPlan =\n%q\nwant\n%q", got, want)
	}
}

func TestApplyEditPlan_IdentityAndAllRemoved(t *testing.T) {
	in := validSubmission()
	got, err := applyEditPlan(editableDiff, in)
	if err != nil {
		t.Fatal(err)
	}
	if got != editableDiff {
		t.Fatalf("empty plan changed input:\n%q", got)
	}

	in.Remove = []lineRange{{StartLine: 1, EndLine: 9}}
	got, err = applyEditPlan(editableDiff, in)
	if err != nil {
		t.Fatal(err)
	}
	if got != "" {
		t.Fatalf("all-removed diff = %q, want empty", got)
	}
}

func TestApplyEditPlan_CoordinatesReferToOriginal(t *testing.T) {
	in := validSubmission()
	in.Remove = []lineRange{{StartLine: 6, EndLine: 6}, {StartLine: 8, EndLine: 9}}
	in.Replace = []lineReplacement{{Line: 7, Old: "name, user", New: "..."}}
	got, err := applyEditPlan(editableDiff, in)
	if err != nil {
		t.Fatal(err)
	}
	want := "diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@ -1,2 +1,4 @@\n package a\n+new := fmt.Errorf(\"new %s for %s\", ...)\n"
	if got != want {
		t.Fatalf("applyEditPlan =\n%q\nwant\n%q", got, want)
	}
}

func TestApplyEditPlan_PreservesLineEndings(t *testing.T) {
	raw := "diff --git a/a b/a\r\n@@ -1 +1 @@\r\n-old\r\n+new" // no final newline
	in := submission{
		Summary: "Changes the value.",
		Remove:  []lineRange{{StartLine: 3, EndLine: 3}},
		Replace: []lineReplacement{{Line: 4, Old: "new", New: "n..."}},
	}
	got, err := applyEditPlan(raw, in)
	if err != nil {
		t.Fatal(err)
	}
	want := "diff --git a/a b/a\r\n@@ -1 +1 @@\r\n+n..."
	if got != want {
		t.Fatalf("line endings changed:\n%q\nwant\n%q", got, want)
	}
}

func TestApplyEditPlan_RejectsInvalidRemovals(t *testing.T) {
	cases := []struct {
		name   string
		remove []lineRange
	}{
		{"zero", []lineRange{{StartLine: 0, EndLine: 1}}},
		{"reversed", []lineRange{{StartLine: 3, EndLine: 2}}},
		{"past end", []lineRange{{StartLine: 9, EndLine: 10}}},
		{"overlap", []lineRange{{StartLine: 2, EndLine: 4}, {StartLine: 4, EndLine: 5}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := validSubmission()
			in.Remove = tc.remove
			if _, err := applyEditPlan(editableDiff, in); err == nil {
				t.Fatal("want invalid removal error")
			}
		})
	}
}

func TestApplyEditPlan_ReportsOverlapOncePerRange(t *testing.T) {
	raw := strings.Repeat("line\n", 1000)
	in := submission{
		Summary: "Elides repeated text.",
		Remove: []lineRange{
			{StartLine: 1, EndLine: 900},
			{StartLine: 100, EndLine: 800},
		},
	}
	_, err := applyEditPlan(raw, in)
	if err == nil {
		t.Fatal("want overlapping range error")
	}
	if got := strings.Count(err.Error(), "overlaps an earlier range"); got != 1 {
		t.Fatalf("overlap diagnostics = %d, want one per range: %v", got, err)
	}
}

func TestApplyEditPlan_AggregatesStructuralErrors(t *testing.T) {
	raw := "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -1 +1 @@\n-old2\n+new2\n"
	in := submission{
		Summary: "Changes two values.",
		Remove: []lineRange{
			{StartLine: 1, EndLine: 1},
			{StartLine: 7, EndLine: 7},
		},
	}
	_, err := applyEditPlan(raw, in)
	if err == nil {
		t.Fatal("want structural errors")
	}
	if got := strings.Count(err.Error(), "diff header"); got != 2 {
		t.Fatalf("aggregated diff-header errors = %d, want 2:\n%v", got, err)
	}
}

func TestApplyEditPlan_RejectsOneSidedRenameOrCopyMetadata(t *testing.T) {
	for _, tc := range []struct {
		name string
		raw  string
	}{
		{"rename", "diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new\n"},
		{"copy", "diff --git a/old b/new\nsimilarity index 100%\ncopy from old\ncopy to new\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := submission{
				Summary: "Moves the file.",
				Remove:  []lineRange{{StartLine: 3, EndLine: 3}},
			}
			_, err := applyEditPlan(tc.raw, in)
			if err == nil || !strings.Contains(err.Error(), "must be removed or retained together") {
				t.Fatalf("applyEditPlan error = %v, want paired-metadata rejection", err)
			}
		})
	}
}

func TestApplyEditPlan_RejectsIndexOnlyFileShell(t *testing.T) {
	raw := "diff --git a/a b/a\nindex 123..456 100644\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n"
	in := submission{
		Summary: "Elides the file change.",
		Remove:  []lineRange{{StartLine: 3, EndLine: 7}},
	}
	_, err := applyEditPlan(raw, in)
	if err == nil || !strings.Contains(err.Error(), "retains only metadata") {
		t.Fatalf("applyEditPlan error = %v, want metadata-shell rejection", err)
	}
}

func TestApplyEditPlan_RejectsOrphanedStructure(t *testing.T) {
	cases := []struct {
		name   string
		remove []lineRange
	}{
		{"diff header", []lineRange{{StartLine: 1, EndLine: 1}}},
		{"old file header", []lineRange{{StartLine: 2, EndLine: 2}}},
		{"new file header", []lineRange{{StartLine: 3, EndLine: 3}}},
		{"hunk header", []lineRange{{StartLine: 4, EndLine: 4}}},
		{"orphaned context", []lineRange{{StartLine: 4, EndLine: 4}, {StartLine: 6, EndLine: 9}}},
		{"empty hunk header", []lineRange{{StartLine: 5, EndLine: 9}}},
		{"context-only hunk", []lineRange{{StartLine: 6, EndLine: 9}}},
		{"empty file headers", []lineRange{{StartLine: 4, EndLine: 9}}},
		{"empty diff header", []lineRange{{StartLine: 2, EndLine: 9}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := validSubmission()
			in.Remove = tc.remove
			if _, err := applyEditPlan(editableDiff, in); err == nil {
				t.Fatal("want retained-structure error")
			}
		})
	}
}

func TestApplyEditPlan_AllowsCompleteHunkOrFileRemoval(t *testing.T) {
	raw := "diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@ -1 +1 @@\n-old\n+new\n@@ -5 +5 @@\n-old2\n+new2\n"
	in := submission{
		Summary: "Changes the second value.",
		Remove:  []lineRange{{StartLine: 4, EndLine: 6}},
	}
	got, err := applyEditPlan(raw, in)
	if err != nil {
		t.Fatal(err)
	}
	want := "diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@ -5 +5 @@\n-old2\n+new2\n"
	if got != want {
		t.Fatalf("whole-hunk removal = %q, want %q", got, want)
	}

	in.Remove = []lineRange{{StartLine: 1, EndLine: 9}}
	got, err = applyEditPlan(raw, in)
	if err != nil {
		t.Fatal(err)
	}
	if got != "" {
		t.Fatalf("whole-file removal = %q", got)
	}
}

func TestAbridge_AcceptsGitFormatPatch(t *testing.T) {
	repo := gitRepo(t, map[string]string{"a.go": "package a\n\nconst Value = 1\n"})
	if err := os.WriteFile(filepath.Join(repo, "a.go"), []byte("package a\n\nconst Value = 2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"add", "a.go"}, {"commit", "-q", "-m", "change value", "-m", "@@@ this is commit prose", "-m", "rename from old behavior", "-m", "diff behavior notes"}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = repo
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
	}
	cmd := exec.Command("git", "format-patch", "-1", "--stdout")
	cmd.Dir = repo
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	raw := string(out)
	if !strings.Contains(raw, "@@@ this is commit prose") || !strings.Contains(raw, "rename from old behavior") || !strings.Contains(raw, "diff behavior notes") {
		t.Fatalf("format-patch fixture lost metadata-looking commit prose:\n%s", raw)
	}
	if !strings.Contains(raw, "\n-- \n") {
		t.Fatalf("format-patch fixture has no mail signature:\n%s", raw)
	}

	m := &scriptedModel{turns: []*Response{
		assistant(toolUse("submit", "submit", submission{
			Remove:  []lineRange{},
			Replace: []lineReplacement{},
			Fold:    []lineFold{},
			Summary: "Changes Value from 1 to 2.",
		})),
	}}
	res, err := Abridge(context.Background(), m, Request{UnifiedDiff: raw})
	if err != nil {
		t.Fatalf("Abridge(format-patch): %v", err)
	}
	if res.SmartDiff != raw {
		t.Fatal("identity plan changed format-patch input")
	}

	lines := splitSourceLines(raw)
	var diffStart, signature int
	for i, line := range lines {
		if diffStart == 0 && strings.HasPrefix(line.text, "diff ") {
			diffStart = i + 1
		}
		if isFormatPatchSignature(line.text) {
			signature = i + 1
			break
		}
	}
	if diffStart == 0 || signature <= diffStart {
		t.Fatalf("could not locate format-patch diff/footer boundaries")
	}
	m = &scriptedModel{turns: []*Response{
		assistant(toolUse("submit", "submit", submission{
			Remove:  []lineRange{{StartLine: diffStart, EndLine: signature - 1}},
			Replace: []lineReplacement{},
			Fold:    []lineFold{},
			Summary: "Omits the complete file change.",
		})),
	}}
	res, err = Abridge(context.Background(), m, Request{UnifiedDiff: raw})
	if err != nil {
		t.Fatalf("Abridge(format-patch file elision): %v", err)
	}
	if strings.Contains(res.SmartDiff, "diff --git") || !strings.Contains(res.SmartDiff, "\n-- \n") {
		t.Fatalf("file elision did not preserve the mail footer:\n%s", res.SmartDiff)
	}
}

func TestApplyEditPlan_GitHunkLinesThatResembleFileHeaders(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git not found: %v", err)
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "old.go"), []byte("-- a/foo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "new.go"), []byte("++ b/foo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("git", "diff", "--no-index", "--", "old.go", "new.go")
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if ee, ok := err.(*exec.ExitError); !ok || ee.ExitCode() != 1 {
		t.Fatalf("git diff --no-index: %v\n%s", err, out)
	}
	raw := string(out)
	if !strings.Contains(raw, "\n--- a/foo\n+++ b/foo\n") {
		t.Fatalf("git did not produce the ambiguous-looking hunk fixture:\n%s", raw)
	}
	got, err := applyEditPlan(raw, submission{Summary: "Changes decrement to increment."})
	if err != nil {
		t.Fatalf("identity plan rejected valid Git diff: %v\n%s", err, raw)
	}
	if got != raw {
		t.Fatal("identity plan changed Git-generated diff")
	}
	if manifest := ElisionLine(raw, raw); manifest != "kept 2/2 changed lines in 1/1 files" {
		t.Fatalf("ambiguous-looking source manifest = %q", manifest)
	}

	var oldLine, newLine int
	for i, line := range splitSourceLines(raw) {
		switch line.text {
		case "--- a/foo":
			oldLine = i + 1
		case "+++ b/foo":
			newLine = i + 1
		}
	}
	if oldLine == 0 || newLine == 0 {
		t.Fatal("ambiguous-looking hunk lines not found")
	}
	got, err = applyEditPlan(raw, submission{
		Summary: "Changes decrement to increment.",
		Remove:  []lineRange{{StartLine: oldLine, EndLine: oldLine}},
		Replace: []lineReplacement{{Line: newLine, Old: "b/foo", New: "..."}},
	})
	if err != nil {
		t.Fatalf("real edit plan rejected Git diff: %v", err)
	}
	if strings.Contains(got, "--- a/foo") || !strings.Contains(got, "+++ ...") {
		t.Fatalf("real edit plan not applied to Git-generated hunk:\n%s", got)
	}
}

func TestApplyEditPlan_NoNewlineMarkerRequiresSourceLine(t *testing.T) {
	raw := "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n"
	in := submission{
		Summary: "Changes the value.",
		Remove:  []lineRange{{StartLine: 5, EndLine: 5}},
	}
	if _, err := applyEditPlan(raw, in); err == nil {
		t.Fatal("want orphaned no-newline marker rejected")
	}

	in.Remove = []lineRange{{StartLine: 5, EndLine: 6}}
	got, err := applyEditPlan(raw, in)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(got, "No newline") || !strings.Contains(got, "+new") {
		t.Fatalf("source plus marker removal failed:\n%s", got)
	}
}

func TestApplyEditPlan_ProtectsConcatenatedUnifiedDiffHeaders(t *testing.T) {
	raw := "--- a/one.go\n+++ b/one.go\n@@ -1 +1 @@\n-old\n+new\n--- a/two.go\n+++ b/two.go\n@@ -1 +1 @@\n-old2\n+new2\n"
	for _, candidate := range []string{
		raw,
		strings.Replace(raw, "@@ -1 +1 @@", "@@", 1),
		strings.Replace(raw, "@@ -1 +1 @@", "@@ -1,3 +1,3 @@", 1),
	} {
		in := submission{
			Summary: "Changes two values.",
			Replace: []lineReplacement{{Line: 6, Old: "a/two.go", New: "a/..."}},
		}
		if _, err := applyEditPlan(candidate, in); err == nil {
			t.Fatal("want second file header replacement rejected")
		}
	}

	in := submission{
		Summary: "Changes one value.",
		Remove:  []lineRange{{StartLine: 6, EndLine: 10}},
	}
	got, err := applyEditPlan(raw, in)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(got, "two.go") || !strings.Contains(got, "+new") {
		t.Fatalf("complete second-file removal failed:\n%s", got)
	}
}

func TestApplyEditPlan_RejectsInvalidReplacements(t *testing.T) {
	cases := []struct {
		name    string
		replace lineReplacement
		remove  []lineRange
	}{
		{"outside diff", lineReplacement{Line: 10, Old: "x", New: "..."}, nil},
		{"empty old", lineReplacement{Line: 7, Old: "", New: "..."}, nil},
		{"metadata", lineReplacement{Line: 1, Old: "a/a.go", New: "..."}, nil},
		{"hunk header", lineReplacement{Line: 4, Old: "-1,4", New: "..."}, nil},
		{"removed line", lineReplacement{Line: 7, Old: "name", New: "..."}, []lineRange{{StartLine: 7, EndLine: 7}}},
		{"missing old", lineReplacement{Line: 7, Old: "not present", New: "..."}, nil},
		{"ambiguous old", lineReplacement{Line: 7, Old: "%s", New: "..."}, nil},
		{"newline old", lineReplacement{Line: 7, Old: "name\n", New: "..."}, nil},
		{"newline new", lineReplacement{Line: 7, Old: "name, user", New: "x\ny"}, nil},
		{"invented new", lineReplacement{Line: 7, Old: "name, user", New: "dangerousCall()"}, nil},
		{"no-op new", lineReplacement{Line: 7, Old: "name", New: "name"}, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := validSubmission()
			in.Remove = tc.remove
			in.Replace = []lineReplacement{tc.replace}
			if _, err := applyEditPlan(editableDiff, in); err == nil {
				t.Fatal("want invalid replacement error")
			}
		})
	}
}

func TestApplyEditPlan_RejectsOverlappingOldOccurrences(t *testing.T) {
	raw := "diff --git a/a b/a\n@@ -1 +1 @@\n+aaa\n"
	in := submission{
		Summary: "Adds repeated text.",
		Replace: []lineReplacement{{Line: 3, Old: "aa", New: "..."}},
	}
	if _, err := applyEditPlan(raw, in); err == nil {
		t.Fatal("want overlapping old occurrences to be ambiguous")
	}
}

func TestApplyEditPlan_AllowsMultipleDisjointReplacementsOnLine(t *testing.T) {
	in := validSubmission()
	in.Replace = []lineReplacement{
		{Line: 7, Old: "name", New: "..."},
		{Line: 7, Old: "user", New: "u..."},
	}
	got, err := applyEditPlan(editableDiff, in)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, `+new := fmt.Errorf("new %s for %s", ..., u...)`) {
		t.Fatalf("disjoint replacements not applied against original line:\n%s", got)
	}
}

func TestApplyEditPlan_RejectsOverlappingReplacements(t *testing.T) {
	in := validSubmission()
	in.Replace = []lineReplacement{
		{Line: 7, Old: "name, user", New: "..."},
		{Line: 7, Old: "user", New: "..."},
	}
	if _, err := applyEditPlan(editableDiff, in); err == nil {
		t.Fatal("want overlapping replacement error")
	}
}

func TestApplyEditPlan_AllowsContextLineReplacementInsideHunk(t *testing.T) {
	in := validSubmission()
	in.Replace = []lineReplacement{{Line: 5, Old: "package a", New: "package ..."}}
	got, err := applyEditPlan(editableDiff, in)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, " package ...\n") {
		t.Fatalf("context replacement not applied:\n%s", got)
	}
}

func TestNumberedDiff(t *testing.T) {
	raw := "α\n\n+β" // no final newline
	got := numberedDiff(raw)
	want := "1|α\n2|\n3|+β\n"
	if got != want {
		t.Fatalf("numberedDiff = %q, want %q", got, want)
	}
	if strings.Contains(got, "4|") {
		t.Fatal("numberedDiff added a phantom trailing line")
	}
}

func TestCompileSubmission_AggregatesSummaryAndPlanErrors(t *testing.T) {
	_, err := compileSubmission(editableDiff, submission{
		Summary: "",
		Replace: []lineReplacement{{Line: 999, Old: "x", New: "..."}},
	})
	if err == nil || !strings.Contains(err.Error(), "summary must not be empty") || !strings.Contains(err.Error(), "outside the diff") {
		t.Fatalf("compileSubmission error = %v, want summary and plan errors", err)
	}
}

func TestValidateSummary(t *testing.T) {
	for _, bad := range []string{"", "   ", "two\nlines", "two\rlines", "escape\x1b[31m", "line\u2028break"} {
		in := submission{Summary: bad}
		if _, err := applyEditPlan(editableDiff, in); err == nil {
			t.Errorf("summary %q: want error", bad)
		}
	}
}
