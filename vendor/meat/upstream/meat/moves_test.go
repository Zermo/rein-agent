package meat

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

// exactMoveDiff aliases the canonical fixture so move tests and the hashed
// prompt surface stay aligned.
const exactMoveDiff = surfaceFixtureDiff

var exactMove = detectedMove{
	Removed: lineRange{StartLine: 6, EndLine: 9},
	Added:   lineRange{StartLine: 16, EndLine: 19},
}

func TestDetectExactMoves_CrossFileUniformReindent(t *testing.T) {
	moves := detectedMovesInDiff(exactMoveDiff)
	if len(moves) != 1 || moves[0] != exactMove {
		t.Fatalf("detected moves = %+v, want %+v", moves, []detectedMove{exactMove})
	}
}

func TestDetectExactMoves_SameFileCrossHunk(t *testing.T) {
	raw := "diff --git a/a.txt b/a.txt\n" +
		"--- a/a.txt\n" +
		"+++ b/a.txt\n" +
		"@@ -1,4 +1,0 @@\n" +
		"-first_unique_operation(source)\n" +
		"-second_unique_operation(result)\n" +
		"-third_unique_operation(result)\n" +
		"-fourth_unique_operation(result)\n" +
		"@@ -20,0 +17,4 @@\n" +
		"+    first_unique_operation(source)\n" +
		"+    second_unique_operation(result)\n" +
		"+    third_unique_operation(result)\n" +
		"+    fourth_unique_operation(result)\n"
	want := detectedMove{
		Removed: lineRange{StartLine: 5, EndLine: 8},
		Added:   lineRange{StartLine: 10, EndLine: 13},
	}
	moves := detectedMovesInDiff(raw)
	if len(moves) != 1 || moves[0] != want {
		t.Fatalf("detected moves = %+v, want %+v", moves, []detectedMove{want})
	}
}

func TestDetectExactMoves_ExactInteriorOnly(t *testing.T) {
	raw := "diff --git a/a.txt b/a.txt\n" +
		"--- a/a.txt\n" +
		"+++ b/a.txt\n" +
		"@@ -1,6 +1,0 @@\n" +
		"-old_wrapper_begin()\n" +
		"-    alpha := prepare(source)\n" +
		"-    beta := transform(alpha)\n" +
		"-    publish(beta)\n" +
		"-    recordSuccess(beta)\n" +
		"-old_wrapper_end()\n" +
		"@@ -20,0 +14,6 @@\n" +
		"+new_wrapper_begin()\n" +
		"+        alpha := prepare(source)   \n" +
		"+        beta := transform(alpha)\t\n" +
		"+        publish(beta)\n" +
		"+        recordSuccess(beta)\n" +
		"+new_wrapper_end()\n"
	want := detectedMove{
		Removed: lineRange{StartLine: 6, EndLine: 9},
		Added:   lineRange{StartLine: 13, EndLine: 16},
	}
	moves := detectedMovesInDiff(raw)
	if len(moves) != 1 || moves[0] != want {
		t.Fatalf("detected moves = %+v, want exact interior %+v", moves, []detectedMove{want})
	}
}

func TestDetectExactMoves_IgnoresTinyAmbiguousAndSameHunkMatches(t *testing.T) {
	block := []string{
		"first_unique_operation(source)",
		"second_unique_operation(result)",
		"third_unique_operation(result)",
	}
	ambiguous := "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n" +
		deletedOnlyHunk(1, block) + deletedOnlyHunk(20, block) + addedOnlyHunk(40, block)
	tiny := "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n" +
		deletedOnlyHunk(1, []string{"return first", "return second"}) +
		addedOnlyHunk(20, []string{"return first", "return second"})
	sameHunk := "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n" +
		"-first_unique_operation(source)\n-second_unique_operation(result)\n-third_unique_operation(result)\n" +
		"+first_unique_operation(source)\n+second_unique_operation(result)\n+third_unique_operation(result)\n"
	nonConstantIndent := "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n" +
		"@@ -1,3 +1,0 @@\n" +
		"-first_unique_operation(source)\n-second_unique_operation(result)\n-third_unique_operation(result)\n" +
		"@@ -20,0 +17,3 @@\n" +
		"+    first_unique_operation(source)\n+        second_unique_operation(result)\n+    third_unique_operation(result)\n"
	for name, raw := range map[string]string{
		"ambiguous repeated block":      ambiguous,
		"tiny coincidence":              tiny,
		"same hunk replacement":         sameHunk,
		"nonconstant indentation shift": nonConstantIndent,
	} {
		t.Run(name, func(t *testing.T) {
			if moves := detectedMovesInDiff(raw); len(moves) != 0 {
				t.Fatalf("detected moves = %+v, want none", moves)
			}
		})
	}
}

func deletedOnlyHunk(start int, rows []string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "@@ -%d,%d +%d,0 @@\n", start, len(rows), start)
	for _, row := range rows {
		fmt.Fprintf(&b, "-%s\n", row)
	}
	return b.String()
}

func addedOnlyHunk(start int, rows []string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "@@ -%d,0 +%d,%d @@\n", start, start, len(rows))
	for _, row := range rows {
		fmt.Fprintf(&b, "+    %s\n", row)
	}
	return b.String()
}

func TestCompileEditPlan_MoveSymmetry(t *testing.T) {
	passing := []struct {
		name string
		plan editPlan
	}{
		{"keep both", editPlan{}},
		{"remove both", editPlan{Remove: []lineRange{{StartLine: 6, EndLine: 9}, {StartLine: 16, EndLine: 19}}}},
		{"fold both", editPlan{Fold: []lineFold{{StartLine: 6, EndLine: 9}, {StartLine: 16, EndLine: 19}}}},
		{"remove complete diff", editPlan{Remove: []lineRange{{StartLine: 1, EndLine: 20}}}},
	}
	for _, tc := range passing {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := compileEditPlan(exactMoveDiff, tc.plan); err != nil {
				t.Fatalf("compileEditPlan: %v", err)
			}
		})
	}

	failing := []struct {
		name   string
		plan   editPlan
		needle string
	}{
		{"keep versus remove", editPlan{Remove: []lineRange{{StartLine: 6, EndLine: 9}}}, "removed lines 6-9 are removed while added lines 16-19 are kept"},
		{"fold versus remove", editPlan{Remove: []lineRange{{StartLine: 16, EndLine: 19}}, Fold: []lineFold{{StartLine: 6, EndLine: 9}}}, "removed lines 6-9 are folded while added lines 16-19 are removed"},
		{"keep versus fold", editPlan{Fold: []lineFold{{StartLine: 16, EndLine: 19}}}, "removed lines 6-9 are kept while added lines 16-19 are folded"},
		{"different fold partitions", editPlan{Fold: []lineFold{{StartLine: 6, EndLine: 7}, {StartLine: 8, EndLine: 9}, {StartLine: 16, EndLine: 19}}}, "folded with different boundaries"},
	}
	for _, tc := range failing {
		t.Run(tc.name, func(t *testing.T) {
			_, err := compileEditPlan(exactMoveDiff, tc.plan)
			if err == nil || !strings.Contains(err.Error(), "removed lines 6-9 match added lines 16-19") || !strings.Contains(err.Error(), tc.needle) {
				t.Fatalf("compileEditPlan error = %v, want precise move symmetry error containing %q", err, tc.needle)
			}
		})
	}
}

func TestCompileEditPlan_MoveReplacementSymmetry(t *testing.T) {
	t.Run("equivalent local elisions", func(t *testing.T) {
		compiled, err := compileEditPlan(exactMoveDiff, editPlan{Replace: []lineReplacement{
			{Line: 8, Old: "beta", New: "..."},
			{Line: 18, Old: "beta", New: "..."},
		}})
		if err != nil {
			t.Fatalf("compileEditPlan: %v", err)
		}
		if strings.Count(compiled.smartDiff, "publish(...)") != 2 {
			t.Fatalf("symmetric replacements not applied to both move endpoints:\n%s", compiled.smartDiff)
		}
	})

	t.Run("one-sided local elision", func(t *testing.T) {
		_, err := compileEditPlan(exactMoveDiff, editPlan{Replace: []lineReplacement{
			{Line: 8, Old: "beta", New: "..."},
		}})
		for _, want := range []string{
			"move symmetry",
			"removed lines 6-9 match added lines 16-19",
			"corresponding kept lines 8 and 18 have different model-authored local elisions",
		} {
			if err == nil || !strings.Contains(err.Error(), want) {
				t.Fatalf("compileEditPlan error = %v, want %q", err, want)
			}
		}
	})

	t.Run("different local elisions", func(t *testing.T) {
		_, err := compileEditPlan(exactMoveDiff, editPlan{Replace: []lineReplacement{
			{Line: 8, Old: "beta", New: "..."},
			{Line: 18, Old: "beta", New: "b..."},
		}})
		if err == nil || !strings.Contains(err.Error(), "different model-authored local elisions") {
			t.Fatalf("compileEditPlan error = %v, want local-elision move symmetry rejection", err)
		}
	})

	t.Run("replacement outside move", func(t *testing.T) {
		if _, err := compileEditPlan(exactMoveDiff, editPlan{Replace: []lineReplacement{
			{Line: 20, Old: "location_ready", New: "location_..."},
		}}); err != nil {
			t.Fatalf("replacement outside detected move: %v", err)
		}
	})
}

const importOnlyPythonMoveDiff = "diff --git a/moved.py b/moved.py\n" +
	"--- a/moved.py\n" +
	"+++ b/moved.py\n" +
	"@@ old location @@\n" +
	"-old_location_marker = \"legacy\"\n" +
	"-class RuntimeDependencies:\n" +
	"-    import alpha_package_for_runtime\n" +
	"-    import beta_package_for_runtime\n" +
	"-    import gamma_package_for_runtime\n" +
	"@@ new location @@\n" +
	"+new_location_marker = \"current\"\n" +
	"+class RuntimeDependencies:\n" +
	"+    import alpha_package_for_runtime\n" +
	"+    import beta_package_for_runtime\n" +
	"+    import gamma_package_for_runtime\n"

const mixedPythonMoveDiff = "diff --git a/moved.py b/moved.py\n" +
	"--- a/moved.py\n" +
	"+++ b/moved.py\n" +
	"@@ old location @@\n" +
	"-def register_runtime(source):\n" +
	"-    import alpha_package_for_runtime\n" +
	"-    configure_alpha_runtime(source)\n" +
	"-    configure_beta_runtime(source)\n" +
	"-    publish_runtime_registry(source)\n" +
	"@@ new location @@\n" +
	"+def register_runtime(source):\n" +
	"+    import alpha_package_for_runtime\n" +
	"+    configure_alpha_runtime(source)\n" +
	"+    configure_beta_runtime(source)\n" +
	"+    publish_runtime_registry(source)\n"

const crossLanguageImportMoveDiff = "diff --git a/old.js b/old.js\n" +
	"--- a/old.js\n" +
	"+++ b/old.js\n" +
	"@@ old location @@\n" +
	"-const alphaRuntime = require(\"alpha-runtime-package\");\n" +
	"-const betaRuntime = require(\"beta-runtime-package\");\n" +
	"-const gammaRuntime = require(\"gamma-runtime-package\");\n" +
	"diff --git a/new.py b/new.py\n" +
	"--- a/new.py\n" +
	"+++ b/new.py\n" +
	"@@ new location @@\n" +
	"+const alphaRuntime = require(\"alpha-runtime-package\");\n" +
	"+const betaRuntime = require(\"beta-runtime-package\");\n" +
	"+const gammaRuntime = require(\"gamma-runtime-package\");\n"

func TestCompileEditPlan_MandatoryImportsPrecedeMoveSymmetry(t *testing.T) {
	identity := editPlan{Remove: []lineRange{}, Replace: []lineReplacement{}, Fold: []lineFold{}}

	t.Run("identity import-only Python suite", func(t *testing.T) {
		compiled, err := compileEditPlan(importOnlyPythonMoveDiff, identity)
		if err != nil {
			t.Fatalf("identity plan: %v", err)
		}
		if strings.Contains(compiled.smartDiff, "import ") {
			t.Fatalf("identity plan leaked imports:\n%s", compiled.smartDiff)
		}
		if strings.Count(compiled.smartDiff, "    ...") != 1 ||
			!strings.Contains(compiled.smartDiff, "-class RuntimeDependencies:") ||
			!strings.Contains(compiled.smartDiff, "+class RuntimeDependencies:") {
			t.Fatalf("identity plan lost the source-derived suite skeleton:\n%s", compiled.smartDiff)
		}
	})

	t.Run("partial plan around import-only Python suite", func(t *testing.T) {
		compiled, err := compileEditPlan(importOnlyPythonMoveDiff, editPlan{Remove: []lineRange{
			{StartLine: 5, EndLine: 5},
			{StartLine: 11, EndLine: 11},
		}})
		if err != nil {
			t.Fatalf("partial plan: %v", err)
		}
		if strings.Contains(compiled.smartDiff, "location_marker") || strings.Contains(compiled.smartDiff, "import ") {
			t.Fatalf("partial plan leaked removed or mandatory rows:\n%s", compiled.smartDiff)
		}
		if strings.Count(compiled.smartDiff, "    ...") != 1 {
			t.Fatalf("partial plan lost the source-derived suite placeholder:\n%s", compiled.smartDiff)
		}
	})

	t.Run("symmetric partial behavioral removal", func(t *testing.T) {
		compiled, err := compileEditPlan(mixedPythonMoveDiff, editPlan{Remove: []lineRange{
			{StartLine: 7, EndLine: 9},
			{StartLine: 13, EndLine: 15},
		}})
		if err != nil {
			t.Fatalf("symmetric partial plan: %v", err)
		}
		if strings.Contains(compiled.smartDiff, "import ") || strings.Contains(compiled.smartDiff, "configure_") || strings.Contains(compiled.smartDiff, "publish_") {
			t.Fatalf("partial plan leaked hidden rows:\n%s", compiled.smartDiff)
		}
		if strings.Count(compiled.smartDiff, "    ...") != 1 {
			t.Fatalf("partial plan lost the compiler-owned suite placeholder:\n%s", compiled.smartDiff)
		}
	})

	t.Run("cross-language classifier disagreement", func(t *testing.T) {
		lines := splitSourceLines(crossLanguageImportMoveDiff)
		layout := analyzeDiff(lines)
		moves := detectExactMoves(lines, layout)
		if len(moves) != 1 {
			t.Fatalf("detected moves = %+v, want one", moves)
		}
		classified := mandatoryRemovalMask(len(lines), mandatoryImportRemovalPlan(lines, layout))
		for offset := 0; offset < 3; offset++ {
			if !classified[moves[0].Removed.StartLine+offset-1] || classified[moves[0].Added.StartLine+offset-1] {
				t.Fatalf("extension-specific import classification at offset %d = removed %t, added %t; want true, false", offset,
					classified[moves[0].Removed.StartLine+offset-1], classified[moves[0].Added.StartLine+offset-1])
			}
		}

		compiled, err := compileEditPlan(crossLanguageImportMoveDiff, identity)
		if err != nil {
			t.Fatalf("cross-language identity plan: %v", err)
		}
		if compiled.smartDiff != "" {
			t.Fatalf("cross-language move leaked exact import counterparts:\n%s", compiled.smartDiff)
		}
	})
}

func TestCompileEditPlan_MandatoryImportsPreserveBehavioralMoveEnforcement(t *testing.T) {
	_, err := compileEditPlan(mixedPythonMoveDiff, editPlan{Remove: []lineRange{{StartLine: 7, EndLine: 9}}})
	if err == nil || !strings.Contains(err.Error(), "move symmetry") ||
		!strings.Contains(err.Error(), "removed lines 7-9 are removed while added lines 13-15 are kept") {
		t.Fatalf("asymmetric behavioral plan error = %v", err)
	}
}

func TestPlanFeedback_ReportsSymmetricMoves(t *testing.T) {
	compiled, err := compileEditPlan(exactMoveDiff, editPlan{Fold: []lineFold{{StartLine: 6, EndLine: 9}, {StartLine: 16, EndLine: 19}}})
	if err != nil {
		t.Fatal(err)
	}
	feedback := planFeedback(compiled)
	for _, want := range []string{"Moves: 1 exact cross-hunk/cross-file", "treated symmetrically", "-6..9 ↔ +16..19"} {
		if !strings.Contains(feedback, want) {
			t.Errorf("feedback missing %q:\n%s", want, feedback)
		}
	}
}

func TestAbridge_RejectsAsymmetricMoveThenAcceptsCorrection(t *testing.T) {
	m := &scriptedModel{turns: []*Response{
		assistant(toolUse("asymmetric", "submit", submission{
			Remove: []lineRange{}, Replace: []lineReplacement{},
			Fold: []lineFold{{StartLine: 16, EndLine: 19}}, Summary: "Moves processing to the new location.",
		})),
		assistant(toolUse("symmetric", "submit", submission{
			Remove: []lineRange{}, Replace: []lineReplacement{},
			Fold: []lineFold{{StartLine: 6, EndLine: 9}, {StartLine: 16, EndLine: 19}}, Summary: "Moves processing to the new location.",
		})),
	}}

	res, err := Abridge(context.Background(), m, Request{UnifiedDiff: exactMoveDiff})
	if err != nil {
		t.Fatal(err)
	}
	if m.seen != 2 || strings.Count(res.SmartDiff, "...") != 2 {
		t.Fatalf("corrected result turns=%d:\n%s", m.seen, res.SmartDiff)
	}

	initialPrompt := m.seenMessages[0][0].Content[0].Text
	if !strings.Contains(initialPrompt, "-6..9 ↔ +16..19") ||
		!strings.Contains(initialPrompt, "keep/remove/fold/replace treatment") ||
		!strings.Contains(initialPrompt, "equivalent local elisions") ||
		!strings.Contains(initialPrompt, "Asymmetric plans are rejected") {
		t.Fatalf("initial prompt missing move hint:\n%s", initialPrompt)
	}
	var sawPreciseError bool
	for _, message := range m.seenMessages[1] {
		for _, block := range message.Content {
			if block.Type == "tool_result" && block.ToolError &&
				strings.Contains(block.ToolResult, "removed lines 6-9 match added lines 16-19") &&
				strings.Contains(block.ToolResult, "removed lines 6-9 are kept while added lines 16-19 are folded") {
				sawPreciseError = true
			}
		}
	}
	if !sawPreciseError {
		t.Fatalf("corrective turn did not receive precise paired coordinates: %+v", m.seenMessages[1])
	}
}

func TestAbridge_RejectsAsymmetricMoveReplacementThenAcceptsCorrection(t *testing.T) {
	m := &scriptedModel{turns: []*Response{
		assistant(toolUse("asymmetric-replace", "submit", submission{
			Remove: []lineRange{},
			Replace: []lineReplacement{
				{Line: 8, Old: "beta", New: "..."},
			},
			Fold: []lineFold{}, Summary: "Moves processing to the new location.",
		})),
		assistant(toolUse("symmetric-replace", "submit", submission{
			Remove: []lineRange{},
			Replace: []lineReplacement{
				{Line: 8, Old: "beta", New: "..."},
				{Line: 18, Old: "beta", New: "..."},
			},
			Fold: []lineFold{}, Summary: "Moves processing to the new location.",
		})),
	}}

	res, err := Abridge(context.Background(), m, Request{UnifiedDiff: exactMoveDiff})
	if err != nil {
		t.Fatal(err)
	}
	if m.seen != 2 || strings.Count(res.SmartDiff, "publish(...)") != 2 {
		t.Fatalf("corrected replacement result turns=%d:\n%s", m.seen, res.SmartDiff)
	}

	var sawPreciseError bool
	for _, message := range m.seenMessages[1] {
		for _, block := range message.Content {
			if block.Type == "tool_result" && block.ToolError &&
				strings.Contains(block.ToolResult, "removed lines 6-9 match added lines 16-19") &&
				strings.Contains(block.ToolResult, "corresponding kept lines 8 and 18 have different model-authored local elisions") {
				sawPreciseError = true
			}
		}
	}
	if !sawPreciseError {
		t.Fatalf("corrective turn did not receive precise local-elision coordinates: %+v", m.seenMessages[1])
	}
}
