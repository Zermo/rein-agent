package meat

import (
	"os"
	"strings"
	"testing"
)

// TestSplitDiff_RealWorldSanity is an opt-in check against an arbitrary
// real-world diff supplied via CHUNK_SANITY_DIFF: at the production budget
// and at several shrunken budgets, every chunk must fit, validate
// independently, and jointly preserve every changed row the whole-diff
// compiler would keep (the splitter itself drops rows the mandatory import
// pass hides, and change-free segments). A budget below the diff's longest
// physical line is skipped: single lines are never split, so such budgets
// legitimately refuse.
func TestSplitDiff_RealWorldSanity(t *testing.T) {
	path := os.Getenv("CHUNK_SANITY_DIFF")
	if path == "" {
		t.Skip("set CHUNK_SANITY_DIFF to a large unified diff file")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	raw := string(data)
	if err := validateSupportedDiff(raw); err != nil {
		t.Fatalf("fixture invalid: %v", err)
	}
	longest := 0
	for _, l := range splitSourceLines(raw) {
		if len(l.text) > longest {
			longest = len(l.text)
		}
	}
	wantRows := strings.Join(retainedChangedRows(raw), "\n")
	for _, budget := range []int{maxDiffBytes, 200 << 10, 64 << 10, 16 << 10} {
		if budget < longest*2 {
			t.Logf("budget %dKB skipped: longest line is %d bytes", budget>>10, longest)
			continue
		}
		chunks, err := splitDiffForAbridging(raw, budget)
		if err != nil {
			t.Fatalf("budget %d: %v", budget, err)
		}
		var rows []string
		for i, c := range chunks {
			if !fitsSingleRun(c.text, budget) {
				t.Errorf("budget %d chunk %d exceeds budget", budget, i)
			}
			if err := validateSupportedDiff(c.text); err != nil {
				t.Errorf("budget %d chunk %d invalid: %v", budget, i, err)
			}
			rows = append(rows, retainedChangedRows(c.text)...)
		}
		if strings.Join(rows, "\n") != wantRows {
			t.Errorf("budget %d: chunking lost or reordered changed rows", budget)
		}
		t.Logf("raw %dKB, budget %dKB -> %d chunks", len(raw)>>10, budget>>10, len(chunks))
	}
}

// retainedChangedRows lists the changed rows of a diff that survive the
// whole-diff mandatory pass (imports plus move-precedence extension), in
// order — the rows any edit plan could retain.
func retainedChangedRows(text string) []string {
	lines := splitSourceLines(text)
	layout := analyzeDiff(lines)
	hidden := mandatoryRemovalMask(len(lines), mandatoryImportRemovalPlan(lines, layout))
	applyMandatoryMovePrecedence(detectExactMoves(lines, layout), hidden)
	var rows []string
	for i, l := range lines {
		if layout.kinds[i] == diffLineHunkChange && !hidden[i] && !isFixedFoldLine(l.text) {
			rows = append(rows, l.text)
		}
	}
	return rows
}
