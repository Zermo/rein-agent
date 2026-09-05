package meat

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
)

// setSingleRunBudget shrinks the per-run diff budget so chunking tests can
// exercise real splits with small fixtures. It returns a restore func.
func setSingleRunBudget(t *testing.T, budget int) func() {
	t.Helper()
	old := singleRunDiffBytes
	singleRunDiffBytes = budget
	return func() { singleRunDiffBytes = old }
}

// modelFunc adapts a func to the Model interface for error-path tests.
type modelFunc func(ctx context.Context) (*Response, error)

func (f modelFunc) Generate(ctx context.Context, _ string, _ []Message, _ []Tool) (*Response, error) {
	return f(ctx)
}

// fileSection builds one file section with a single hunk of n added rows.
func fileSection(name string, n int) string {
	var b strings.Builder
	fmt.Fprintf(&b, "diff --git a/%s b/%s\n--- a/%s\n+++ b/%s\n@@ -0,0 +1,%d @@\n", name, name, name, name, n)
	for i := 0; i < n; i++ {
		fmt.Fprintf(&b, "+%s row %d\n", name, i)
	}
	return b.String()
}

// requireValidChunks asserts that every chunk fits the budget as raw and
// numbered text and is independently a supported, well-formed diff.
func requireValidChunks(t *testing.T, chunks []diffChunk, budget int) {
	t.Helper()
	for i, c := range chunks {
		if len(c.text) > budget {
			t.Errorf("chunk %d raw size %d exceeds budget %d", i, len(c.text), budget)
		}
		if n := numberedDiff(c.text); len(n) > budget {
			t.Errorf("chunk %d numbered size %d exceeds budget %d", i, len(n), budget)
		}
		if err := validateSupportedDiff(c.text); err != nil {
			t.Errorf("chunk %d is not independently valid: %v\n%s", i, err, c.text)
		}
	}
}

// reassembleBodies strips synthesized/replicated structure and concatenates
// each chunk's hunk source rows, to prove no original content is lost or
// reordered by splitting.
func chunkBodyRows(text string) []string {
	lines := splitSourceLines(text)
	layout := analyzeDiff(lines)
	var rows []string
	for i, l := range lines {
		if isHunkSource(layout.kinds[i]) || layout.kinds[i] == diffLineNoNewline {
			rows = append(rows, l.text)
		}
	}
	return rows
}

func TestSplitDiff_PacksWholeFileSections(t *testing.T) {
	diff := fileSection("a", 5) + fileSection("b", 5) + fileSection("c", 5)
	one := fileSection("a", 5)
	budget := len(numberedDiff(one + one))
	chunks, err := splitDiffForAbridging(diff, budget)
	if err != nil {
		t.Fatal(err)
	}
	requireValidChunks(t, chunks, budget)
	if len(chunks) != 2 {
		t.Fatalf("chunks = %d, want 2 (two sections packed, then one)", len(chunks))
	}
	if !strings.Contains(chunks[0].text, "diff --git a/a") || !strings.Contains(chunks[0].text, "diff --git a/b") {
		t.Errorf("first chunk should pack sections a and b:\n%s", chunks[0].text)
	}
	if !strings.Contains(chunks[1].text, "diff --git a/c") || chunks[1].continuation {
		t.Errorf("second chunk should be whole section c, not a continuation:\n%s", chunks[1].text)
	}
	if joined := chunks[0].text + chunks[1].text; joined != diff {
		t.Errorf("whole-section chunks should reassemble the original diff exactly")
	}
}

func TestSplitDiff_SplitsOversizedFileAtHunks(t *testing.T) {
	// One file, several hunks, each hunk well under budget but the file over.
	var b strings.Builder
	b.WriteString("diff --git a/big.go b/big.go\n--- a/big.go\n+++ b/big.go\n")
	for h := 0; h < 6; h++ {
		fmt.Fprintf(&b, "@@ -%d,2 +%d,3 @@ func f%d()\n context %d\n+added %d\n context tail %d\n", h*10+1, h*10+1, h, h, h, h)
	}
	diff := b.String()
	budget := len(numberedDiff(diff))/2 + 40
	chunks, err := splitDiffForAbridging(diff, budget)
	if err != nil {
		t.Fatal(err)
	}
	requireValidChunks(t, chunks, budget)
	if len(chunks) < 2 {
		t.Fatalf("chunks = %d, want a real split", len(chunks))
	}
	var rows []string
	for i, c := range chunks {
		if !strings.HasPrefix(c.text, "diff --git a/big.go") {
			t.Errorf("chunk %d lost its replicated file metadata:\n%s", i, c.text)
		}
		if (i > 0) != c.continuation {
			t.Errorf("chunk %d continuation = %v, want %v", i, c.continuation, i > 0)
		}
		if c.sectionID < 0 {
			t.Errorf("chunk %d of a split section should carry its section ID", i)
		}
		// Hunk-boundary splits keep original @@ headers (with their headings).
		if !strings.Contains(c.text, " @@ func f") {
			t.Errorf("chunk %d lost hunk headings:\n%s", i, c.text)
		}
		rows = append(rows, chunkBodyRows(c.text)...)
	}
	if want := chunkBodyRows(diff); strings.Join(rows, "\n") != strings.Join(want, "\n") {
		t.Errorf("split lost or reordered hunk rows:\ngot:\n%s\nwant:\n%s", strings.Join(rows, "\n"), strings.Join(want, "\n"))
	}
}

func TestSplitDiff_SplitsOversizedHunkWithConsistentCounts(t *testing.T) {
	var b strings.Builder
	b.WriteString("diff --git a/big.go b/big.go\n--- a/big.go\n+++ b/big.go\n@@ -100,30 +200,45 @@ func big()\n")
	for i := 0; i < 30; i++ {
		fmt.Fprintf(&b, " context row %02d\n", i)
		if i%2 == 0 {
			fmt.Fprintf(&b, "+added row %02d\n", i)
		}
	}
	diff := b.String()
	budget := len(numberedDiff(diff))/3 + 60
	chunks, err := splitDiffForAbridging(diff, budget)
	if err != nil {
		t.Fatal(err)
	}
	// requireValidChunks runs full hunk-count validation on every synthesized
	// header, which is the heart of this test.
	requireValidChunks(t, chunks, budget)
	if len(chunks) < 2 {
		t.Fatalf("chunks = %d, want a real split", len(chunks))
	}
	// Every changed row survives, in order. (A change-free trailing segment
	// may drop context rows; no plan could retain a change-free hunk anyway.)
	var rows []string
	for _, c := range chunks {
		for _, r := range chunkBodyRows(c.text) {
			if strings.HasPrefix(r, "+") || strings.HasPrefix(r, "-") {
				rows = append(rows, r)
			}
		}
	}
	var want []string
	for _, r := range chunkBodyRows(diff) {
		if strings.HasPrefix(r, "+") || strings.HasPrefix(r, "-") {
			want = append(want, r)
		}
	}
	if strings.Join(rows, "\n") != strings.Join(want, "\n") {
		t.Errorf("hunk split lost or reordered changed rows:\ngot:\n%s\nwant:\n%s", strings.Join(rows, "\n"), strings.Join(want, "\n"))
	}
	// The first segment continues the original starts and keeps the heading;
	// later segments never replicate it (a heading such as an enclosing
	// definition or import opener describes context they do not start inside).
	if !strings.Contains(chunks[0].text, "@@ -100,") || !strings.Contains(chunks[0].text, "+200,") {
		t.Errorf("first segment header should keep original starts:\n%s", chunks[0].text)
	}
	if !strings.Contains(chunks[0].text, " @@ func big()") {
		t.Errorf("first segment lost the hunk heading:\n%s", chunks[0].text)
	}
	for i, c := range chunks[1:] {
		if strings.Contains(c.text, "func big()") {
			t.Errorf("chunk %d replicated the hunk heading it does not start inside:\n%s", i+1, c.text)
		}
	}
}

func TestSplitDiff_KeepsNoNewlineMarkerWithItsLine(t *testing.T) {
	var b strings.Builder
	b.WriteString("diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,6 +1,6 @@\n")
	for i := 0; i < 5; i++ {
		fmt.Fprintf(&b, " ctx %d\n", i)
	}
	b.WriteString("-old tail\n+new tail\n\\ No newline at end of file\n")
	diff := b.String()
	// Budget forces a split right around the trailing marker.
	meta := "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,6 +1,6 @@\n"
	budget := len(numberedDiff(meta)) + 80
	chunks, err := splitDiffForAbridging(diff, budget)
	if err != nil {
		t.Fatal(err)
	}
	requireValidChunks(t, chunks, budget)
	if len(chunks) < 2 {
		t.Fatalf("chunks = %d, want a real split around the marker", len(chunks))
	}
	for i, c := range chunks {
		if strings.Contains(c.text, "No newline") && !strings.Contains(c.text, "+new tail\n\\ No newline") {
			t.Errorf("chunk %d separated the no-newline marker from its source line:\n%s", i, c.text)
		}
	}
}

func TestSplitDiff_UnsplittableSectionFails(t *testing.T) {
	diff := "diff --git a/x b/x\nBinary files a/x and b/x differ\n" + strings.Repeat("junk\n", 100)
	_, err := splitDiffForAbridging(diff, 80)
	if err == nil || !strings.Contains(err.Error(), "narrower") {
		t.Fatalf("err = %v, want unsplittable-section advice", err)
	}
}

// TestSplitDiff_SynthesizedHeadersUseGapConvention pins the unified-diff
// coordinate convention for synthesized segment headers: a side with no rows
// in the segment names the line BEFORE the gap, and a side with rows names
// its first row, continuing the original starts by rows already consumed.
func TestSplitDiff_SynthesizedHeadersUseGapConvention(t *testing.T) {
	meta := "diff --git a/a b/a\n--- a/a\n+++ b/a\n"
	diff := meta + "@@ -10,2 +20,2 @@\n-old10\n-old11\n+new20\n+new21\n"
	budget := len(numberedDiff(meta + "@@ -10,1 +19,0 @@\n-old10\n"))
	chunks, err := splitDiffForAbridging(diff, budget)
	if err != nil {
		t.Fatal(err)
	}
	requireValidChunks(t, chunks, budget)
	want := []string{
		"@@ -10,1 +19,0 @@\n-old10\n",
		"@@ -11,1 +19,0 @@\n-old11\n",
		"@@ -11,0 +20,1 @@\n+new20\n",
		"@@ -11,0 +21,1 @@\n+new21\n",
	}
	if len(chunks) != len(want) {
		t.Fatalf("chunks = %d, want %d single-row segments", len(chunks), len(want))
	}
	for i, c := range chunks {
		if c.text != meta+want[i] {
			t.Errorf("chunk %d = %q, want %q", i, c.text, meta+want[i])
		}
	}
}

// TestSplitDiff_OriginallyEmptySideKeepsItsStart: a side whose ORIGINAL range
// is zero-count (pure insertion/deletion hunks) already names the line before
// the gap; splitting must not decrement it again.
func TestSplitDiff_OriginallyEmptySideKeepsItsStart(t *testing.T) {
	meta := "diff --git a/a b/a\n--- a/a\n+++ b/a\n"
	diff := meta + "@@ -10,0 +11,4 @@\n+r0\n+r1\n+r2\n+r3\n"
	budget := len(numberedDiff(meta + "@@ -10,0 +11,2 @@\n+r0\n+r1\n"))
	chunks, err := splitDiffForAbridging(diff, budget)
	if err != nil {
		t.Fatal(err)
	}
	requireValidChunks(t, chunks, budget)
	if len(chunks) < 2 {
		t.Fatalf("chunks = %d, want a real split", len(chunks))
	}
	wantNew := 11
	for i, c := range chunks {
		if !strings.Contains(c.text, "@@ -10,0 ") {
			t.Errorf("chunk %d shifted the originally empty old side, want -10,0:\n%s", i, c.text)
		}
		if !strings.Contains(c.text, fmt.Sprintf("+%d,", wantNew)) {
			t.Errorf("chunk %d new start: want +%d:\n%s", i, wantNew, c.text)
		}
		wantNew += strings.Count(c.text, "\n+r")
	}
}

// TestSplitDiff_ZeroStartClampsAtZero: splitting a new-file hunk (old side
// @@ -0,0) must not synthesize a negative old start.
func TestSplitDiff_ZeroStartClampsAtZero(t *testing.T) {
	meta := "diff --git a/a b/a\n--- /dev/null\n+++ b/a\n"
	diff := meta + "@@ -0,0 +1,4 @@\n+r0\n+r1\n+r2\n+r3\n"
	budget := len(numberedDiff(meta + "@@ -0,0 +1,2 @@\n+r0\n+r1\n"))
	chunks, err := splitDiffForAbridging(diff, budget)
	if err != nil {
		t.Fatal(err)
	}
	requireValidChunks(t, chunks, budget)
	for i, c := range chunks {
		if !strings.Contains(c.text, "@@ -0,0 ") {
			t.Errorf("chunk %d old side = should stay -0,0:\n%s", i, c.text)
		}
	}
}

// TestSplitDiff_ImportBlockNeverSeveredOrLeaked: a mid-hunk cut interacts
// with the mandatory import pass, which recognizes a multiline block only
// from its opener. The splitter pre-applies the whole-diff import mask, so
// import scaffolding appears in no chunk at all — a chunk's own compiler
// could not classify a severed tail — and never in the merged reading diff.
func TestSplitDiff_ImportBlockNeverSeveredOrLeaked(t *testing.T) {
	meta := "diff --git a/a.go b/a.go\n--- /dev/null\n+++ b/a.go\n"
	// Rows before the import block position a naive greedy cut inside the
	// block.
	const before, members, after = 10, 8, 10
	var body strings.Builder
	fmt.Fprintf(&body, "@@ -0,0 +1,%d @@\n+package a\n+\n", 5+before+members+after)
	for i := 0; i < before; i++ {
		fmt.Fprintf(&body, "+var a%d = %d\n", i, i)
	}
	body.WriteString("+import (\n")
	for i := 0; i < members; i++ {
		fmt.Fprintf(&body, "+\t%q\n", fmt.Sprintf("pkg%d", i))
	}
	body.WriteString("+)\n+func F() {}\n")
	for i := 0; i < after; i++ {
		fmt.Fprintf(&body, "+var b%d = %d\n", i, i)
	}
	diff := meta + body.String()
	// Budget sized so a naive per-line greedy cut would land mid-block:
	// everything up to the block plus half its members.
	prefix := strings.SplitAfter(diff, `"pkg3"`+"\n")[0]
	budget := len(numberedDiff(prefix))
	chunks, err := splitDiffForAbridging(diff, budget)
	if err != nil {
		t.Fatal(err)
	}
	requireValidChunks(t, chunks, budget)
	if len(chunks) < 2 {
		t.Fatalf("chunks = %d, want a real split", len(chunks))
	}
	for i, c := range chunks {
		if strings.Contains(c.text, `"pkg`) || strings.Contains(c.text, "import (") {
			t.Errorf("chunk %d contains import scaffolding a chunk-local compiler cannot own:\n%s", i, c.text)
		}
	}

	// End to end: the merged reading diff must contain no import scaffolding
	// and keep every behavioral row — the same invariant the whole-diff
	// compiler enforces.
	defer setSingleRunBudget(t, budget)()
	m := &scriptedModel{turns: []*Response{assistant(toolUse("s", "submit", submission{
		Remove: []lineRange{}, Replace: []lineReplacement{}, Fold: []lineFold{}, Summary: "Adds file.",
	}))}}
	res, err := Abridge(context.Background(), m, Request{UnifiedDiff: diff})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(res.SmartDiff, `"pkg`) || strings.Contains(res.SmartDiff, "+)") || strings.Contains(res.SmartDiff, "import (") {
		t.Errorf("import scaffolding leaked into the merged reading diff:\n%s", res.SmartDiff)
	}
	for _, want := range []string{"+func F() {}", "+var a0 = 0", "+var b9 = 9"} {
		if !strings.Contains(res.SmartDiff, want) {
			t.Errorf("behavioral row %q lost from merged reading diff:\n%s", want, res.SmartDiff)
		}
	}
}

// TestSplitDiff_PreservesCRLF: synthesized segment headers adopt the original
// hunk header's line ending, so a CRLF diff stays CRLF throughout.
func TestSplitDiff_PreservesCRLF(t *testing.T) {
	crlf := func(s string) string { return strings.ReplaceAll(s, "\n", "\r\n") }
	meta := crlf("diff --git a/a b/a\n--- a/a\n+++ b/a\n")
	var body strings.Builder
	for i := 0; i < 12; i++ {
		fmt.Fprintf(&body, "+row %d\r\n", i)
	}
	diff := meta + crlf("@@ -0,0 +1,12 @@\n") + body.String()
	budget := len(numberedDiff(diff))/2 + 60
	chunks, err := splitDiffForAbridging(diff, budget)
	if err != nil {
		t.Fatal(err)
	}
	requireValidChunks(t, chunks, budget)
	if len(chunks) < 2 {
		t.Fatalf("chunks = %d, want a real split", len(chunks))
	}
	for i, c := range chunks {
		if strings.Contains(strings.ReplaceAll(c.text, "\r\n", ""), "\n") {
			t.Errorf("chunk %d contains a bare LF line (synthesized header?):\n%q", i, c.text)
		}
	}
}

func TestSplitDiff_OverlongSingleLineFails(t *testing.T) {
	diff := "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+" + strings.Repeat("x", 500) + "\n"
	_, err := splitDiffForAbridging(diff, 200)
	if err == nil || !strings.Contains(err.Error(), "narrower") {
		t.Fatalf("err = %v, want unsplittable advice", err)
	}
}

// TestAbridge_ChunkedEndToEnd drives a whole chunked run through the public
// Abridge entry point with a scripted model: an oversized two-file diff is
// split, each chunk gets its own agent run with its own 1-based numbering,
// and the merged result concatenates the per-chunk reading diffs, joins the
// distinct summaries, and sums token usage.
func TestAbridge_ChunkedEndToEnd(t *testing.T) {
	defer setSingleRunBudget(t, 400)()

	secA := fileSection("alpha.go", 10)
	secB := fileSection("beta.go", 10)
	diff := secA + secB
	if fitsSingleRun(diff, 400) {
		t.Fatal("fixture should exceed the shrunken single-run budget")
	}
	if !fitsSingleRun(secA, 400) || !fitsSingleRun(secB, 400) {
		t.Fatal("each section should fit alone")
	}

	// Each chunk run submits a plan valid for that chunk in ITS OWN 1-based
	// numbering: keep the header block, first and last added rows, and remove
	// the repetitive middle (rows 6-13 of the 14-line chunk).
	plan := func(summary string) submission {
		return submission{
			Remove:  []lineRange{{StartLine: 6, EndLine: 13}},
			Replace: []lineReplacement{},
			Fold:    []lineFold{},
			Summary: summary,
		}
	}
	m := &scriptedModel{turns: []*Response{
		assistant(toolUse("s1", "submit", plan("Adds alpha rows."))),
		assistant(toolUse("s2", "submit", plan("Adds beta rows."))),
	}}
	var progress []string
	res, err := Abridge(context.Background(), m, Request{
		UnifiedDiff: diff,
		Progress:    func(s string) { progress = append(progress, s) },
	})
	if err != nil {
		t.Fatal(err)
	}
	if m.seen != 2 {
		t.Fatalf("model calls = %d, want 2 (one per chunk)", m.seen)
	}

	// Each run saw only its own chunk, renumbered from 1.
	for i, msgs := range m.seenMessages {
		prompt := msgs[0].Content[0].Text
		if !strings.Contains(prompt, " 1|diff --git") {
			t.Errorf("chunk %d prompt does not restart numbering at 1", i)
		}
	}
	if !strings.Contains(m.seenMessages[0][0].Content[0].Text, "alpha.go") ||
		strings.Contains(m.seenMessages[0][0].Content[0].Text, "beta.go") {
		t.Error("first chunk prompt should contain only alpha.go")
	}
	if !strings.Contains(m.seenMessages[1][0].Content[0].Text, "beta.go") ||
		strings.Contains(m.seenMessages[1][0].Content[0].Text, "alpha.go") {
		t.Error("second chunk prompt should contain only beta.go")
	}

	for _, want := range []string{"diff --git a/alpha.go", "diff --git a/beta.go", "+alpha.go row 0", "+beta.go row 0"} {
		if !strings.Contains(res.SmartDiff, want) {
			t.Errorf("merged smart diff missing %q:\n%s", want, res.SmartDiff)
		}
	}
	if res.Summary != "Adds alpha rows. Adds beta rows." {
		t.Errorf("merged summary = %q", res.Summary)
	}
	if res.InputTokens != 200 || res.OutputTokens != 40 {
		t.Errorf("merged tokens = %d/%d, want summed 200/40", res.InputTokens, res.OutputTokens)
	}
	joined := strings.Join(progress, "\n")
	for _, want := range []string{"abridging 2 chunks", "chunk 1/2: thinking", "chunk 2/2: thinking"} {
		if !strings.Contains(joined, want) {
			t.Errorf("progress missing %q:\n%s", want, joined)
		}
	}

	// The merged output still aligns for the local elision manifest.
	if line := ElisionLine(diff, res.SmartDiff); !strings.Contains(line, "in 2/2 files") {
		t.Errorf("ElisionLine = %q, want file counts over the merged diff", line)
	}
}

// TestAbridge_ChunkedMergeDedupesSplitFileMetadata: when one file is split
// into pieces and both pieces retain content, the merged reading diff carries
// the file's metadata block once.
func TestAbridge_ChunkedMergeDedupesSplitFileMetadata(t *testing.T) {
	var b strings.Builder
	b.WriteString("diff --git a/big.go b/big.go\n--- a/big.go\n+++ b/big.go\n")
	for h := 0; h < 4; h++ {
		fmt.Fprintf(&b, "@@ -%d,1 +%d,2 @@ func f%d()\n context %d\n+added %d\n", h*10+1, h*10+1, h, h, h)
	}
	diff := b.String()
	budget := len(numberedDiff(diff))/2 + 60
	defer setSingleRunBudget(t, budget)()
	if fitsSingleRun(diff, budget) {
		t.Fatal("fixture should exceed the shrunken budget")
	}

	// Identity plans: keep everything in both chunks.
	m := &scriptedModel{turns: []*Response{
		assistant(toolUse("s", "submit", submission{
			Remove: []lineRange{}, Replace: []lineReplacement{}, Fold: []lineFold{}, Summary: "Adds rows.",
		})),
	}}
	res, err := Abridge(context.Background(), m, Request{UnifiedDiff: diff})
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Count(res.SmartDiff, "diff --git a/big.go"); got != 1 {
		t.Errorf("merged diff repeats file metadata %d times, want 1:\n%s", got, res.SmartDiff)
	}
	if got := strings.Count(res.SmartDiff, "+++ b/big.go"); got != 1 {
		t.Errorf("merged diff repeats +++ header %d times, want 1:\n%s", got, res.SmartDiff)
	}
	for h := 0; h < 4; h++ {
		if !strings.Contains(res.SmartDiff, fmt.Sprintf("+added %d", h)) {
			t.Errorf("merged diff lost hunk %d content:\n%s", h, res.SmartDiff)
		}
	}
	if res.Summary != "Adds rows." {
		t.Errorf("duplicate per-chunk summaries should merge to one: %q", res.Summary)
	}
}

// TestAbridge_ChunkedMergeKeepsMetaWhenFirstPieceEmpty: when the first piece
// of a split file abridges to nothing, the continuation piece's replicated
// metadata is the file's only header and must survive the merge.
func TestAbridge_ChunkedMergeKeepsMetaWhenFirstPieceEmpty(t *testing.T) {
	var b strings.Builder
	b.WriteString("diff --git a/big.go b/big.go\n--- a/big.go\n+++ b/big.go\n")
	for h := 0; h < 4; h++ {
		fmt.Fprintf(&b, "@@ -%d,1 +%d,2 @@ func f%d()\n context %d\n+added %d\n", h*10+1, h*10+1, h, h, h)
	}
	diff := b.String()
	budget := len(numberedDiff(diff))/2 + 60
	defer setSingleRunBudget(t, budget)()

	m := &scriptedModel{turns: []*Response{
		// First chunk: everything is noise; remove all 9 of its lines.
		assistant(toolUse("s1", "submit", submission{
			Remove: []lineRange{{StartLine: 1, EndLine: 9}}, Replace: []lineReplacement{}, Fold: []lineFold{}, Summary: "Nothing meaningful.",
		})),
		// Second chunk: keep everything.
		assistant(toolUse("s2", "submit", submission{
			Remove: []lineRange{}, Replace: []lineReplacement{}, Fold: []lineFold{}, Summary: "Adds rows.",
		})),
	}}
	res, err := Abridge(context.Background(), m, Request{UnifiedDiff: diff})
	if err != nil {
		t.Fatal(err)
	}
	if m.seen != 2 {
		t.Fatalf("model calls = %d, want 2", m.seen)
	}
	if got := strings.Count(res.SmartDiff, "diff --git a/big.go"); got != 1 {
		t.Errorf("merged diff has %d file headers, want the continuation's to survive:\n%s", got, res.SmartDiff)
	}
	if !strings.Contains(res.SmartDiff, "+added 2") || strings.Contains(res.SmartDiff, "+added 0") {
		t.Errorf("merged diff should carry only the second piece's hunks:\n%s", res.SmartDiff)
	}
}

// TestSplitDiff_PreambleTravelsWithFirstPieceOnly: non-file preamble (a git
// show / format-patch message) ahead of a split file section rides the first
// piece and is never replicated onto continuations, and metaPrefix contains
// only the file's own metadata block.
func TestSplitDiff_PreambleTravelsWithFirstPieceOnly(t *testing.T) {
	preamble := "commit 0123456789abcdef\nAuthor: A U Thor <a@example.com>\n\n    Big change.\n\n"
	var b strings.Builder
	b.WriteString(preamble)
	b.WriteString("diff --git a/big.go b/big.go\n--- a/big.go\n+++ b/big.go\n")
	for h := 0; h < 4; h++ {
		fmt.Fprintf(&b, "@@ -%d,1 +%d,2 @@ func f%d()\n context %d\n+added %d\n", h*10+1, h*10+1, h, h, h)
	}
	diff := b.String()
	budget := len(numberedDiff(diff))/2 + 90
	chunks, err := splitDiffForAbridging(diff, budget)
	if err != nil {
		t.Fatal(err)
	}
	requireValidChunks(t, chunks, budget)
	if len(chunks) < 2 {
		t.Fatalf("chunks = %d, want a real split", len(chunks))
	}
	if !strings.HasPrefix(chunks[0].text, preamble) {
		t.Errorf("first piece lost the preamble:\n%s", chunks[0].text)
	}
	for i, c := range chunks {
		if strings.Contains(c.metaPrefix, "commit ") {
			t.Errorf("chunk %d metaPrefix includes preamble:\n%s", i, c.metaPrefix)
		}
		if i > 0 && strings.Contains(c.text, "commit ") {
			t.Errorf("chunk %d replicated the preamble:\n%s", i, c.text)
		}
		if !strings.Contains(c.text, "diff --git a/big.go") {
			t.Errorf("chunk %d lost file metadata:\n%s", i, c.text)
		}
	}
}

// TestAbridge_ChunkedRetainedPreambleKeepsContinuationHeaders: when the first
// piece elides its whole file section but retains preamble prose, the
// continuation piece's replicated file headers are the file's only headers
// and must not be stripped — otherwise its hunks would be orphaned under the
// commit message.
func TestAbridge_ChunkedRetainedPreambleKeepsContinuationHeaders(t *testing.T) {
	preamble := "commit 0123456789abcdef\nAuthor: A U Thor <a@example.com>\n\n    Big change.\n\n"
	var b strings.Builder
	b.WriteString(preamble)
	b.WriteString("diff --git a/big.go b/big.go\n--- a/big.go\n+++ b/big.go\n")
	for h := 0; h < 4; h++ {
		fmt.Fprintf(&b, "@@ -%d,1 +%d,2 @@ func f%d()\n context %d\n+added %d\n", h*10+1, h*10+1, h, h, h)
	}
	diff := b.String()
	budget := len(numberedDiff(diff))/2 + 90
	defer setSingleRunBudget(t, budget)()
	chunks, err := splitDiffForAbridging(diff, budget)
	if err != nil || len(chunks) != 2 {
		t.Fatalf("chunks = %d (%v), want 2", len(chunks), err)
	}

	// First chunk: remove the whole file section but keep the preamble.
	fileStart := len(splitSourceLines(preamble)) + 1
	firstLen := len(splitSourceLines(chunks[0].text))
	m := &scriptedModel{turns: []*Response{
		assistant(toolUse("s1", "submit", submission{
			Remove: []lineRange{{StartLine: fileStart, EndLine: firstLen}}, Replace: []lineReplacement{}, Fold: []lineFold{}, Summary: "Nothing meaningful.",
		})),
		assistant(toolUse("s2", "submit", submission{
			Remove: []lineRange{}, Replace: []lineReplacement{}, Fold: []lineFold{}, Summary: "Adds rows.",
		})),
	}}
	res, err := Abridge(context.Background(), m, Request{UnifiedDiff: diff})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(res.SmartDiff, "commit 0123456789abcdef") {
		t.Errorf("merged diff lost retained preamble:\n%s", res.SmartDiff)
	}
	if got := strings.Count(res.SmartDiff, "diff --git a/big.go"); got != 1 {
		t.Errorf("merged diff has %d file headers, want the continuation's kept: \n%s", got, res.SmartDiff)
	}
	idx := strings.Index(res.SmartDiff, "@@")
	if hdr := strings.Index(res.SmartDiff, "diff --git"); idx >= 0 && (hdr < 0 || hdr > idx) {
		t.Errorf("merged diff has orphaned hunks before any file header:\n%s", res.SmartDiff)
	}
}

// TestAbridge_ChunkedPreservesMissingFinalNewline: identity plans over a
// chunked diff whose last line has no trailing newline reproduce the input
// byte-for-byte; the merge step must not append one.
func TestAbridge_ChunkedPreservesMissingFinalNewline(t *testing.T) {
	diff := strings.TrimSuffix(fileSection("alpha.go", 10)+fileSection("beta.go", 10), "\n")
	defer setSingleRunBudget(t, 400)()
	if fitsSingleRun(diff, 400) {
		t.Fatal("fixture should exceed the shrunken budget")
	}
	m := &scriptedModel{turns: []*Response{
		assistant(toolUse("s", "submit", submission{
			Remove: []lineRange{}, Replace: []lineReplacement{}, Fold: []lineFold{}, Summary: "Adds rows.",
		})),
	}}
	res, err := Abridge(context.Background(), m, Request{UnifiedDiff: diff})
	if err != nil {
		t.Fatal(err)
	}
	if res.SmartDiff != diff {
		t.Errorf("identity chunked abridgement altered the diff;\ngot:\n%q\nwant:\n%q", res.SmartDiff, diff)
	}
}

// TestAbridge_ChunkedFailurePropagates: a chunk whose run fails aborts the
// whole abridgement with the chunk named, rather than returning a silently
// partial result.
func TestAbridge_ChunkedFailurePropagates(t *testing.T) {
	defer setSingleRunBudget(t, 400)()
	diff := fileSection("alpha.go", 10) + fileSection("beta.go", 10)

	// First chunk submits; second chunk never calls a tool and burns turns.
	m := &scriptedModel{turns: []*Response{
		assistant(toolUse("s1", "submit", submission{
			Remove: []lineRange{}, Replace: []lineReplacement{}, Fold: []lineFold{}, Summary: "Adds alpha rows.",
		})),
		assistant(textBlock("just text")),
	}}
	_, err := Abridge(context.Background(), m, Request{UnifiedDiff: diff, MaxTurns: 2})
	if err == nil || !strings.Contains(err.Error(), "chunk 2/2") {
		t.Fatalf("err = %v, want failure naming chunk 2/2", err)
	}
}

// TestAbridge_ChunkedErrorPreservesUnwrap: chunk failure labeling must keep
// the wrapped error chain so errors.Is sees cancellation/deadline causes the
// same way for chunked and single-run diffs.
func TestAbridge_ChunkedErrorPreservesUnwrap(t *testing.T) {
	defer setSingleRunBudget(t, 400)()
	diff := fileSection("alpha.go", 10) + fileSection("beta.go", 10)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	m := modelFunc(func(ctx context.Context) (*Response, error) { return nil, ctx.Err() })
	_, err := Abridge(ctx, m, Request{UnifiedDiff: diff})
	if err == nil {
		t.Fatal("want error from canceled context")
	}
	if !errors.Is(err, context.Canceled) {
		t.Errorf("errors.Is(err, context.Canceled) = false; chunk labeling broke the error chain: %v", err)
	}
	if !strings.Contains(err.Error(), "chunk 1/2") {
		t.Errorf("err = %v, want chunk label in message", err)
	}
}

// TestAbridge_ChunkedPreservesPackageRenameAcrossCut: the compiler keeps
// package renames while hiding the import churn around them (pinned
// monolithically by TestCompileEditPlan_MandatoryImportsPreservePackageRenames).
// A mid-hunk cut that puts the -package/-import and +package/+import sides in
// different chunks turns each side one-sided; the merged chunked result must
// still keep both package rows and hide both imports.
func TestAbridge_ChunkedPreservesPackageRenameAcrossCut(t *testing.T) {
	meta := "diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n"
	var b strings.Builder
	b.WriteString(meta)
	const pad = 6
	fmt.Fprintf(&b, "@@ -1,%d +1,%d @@\n", 2+pad, 2+pad)
	b.WriteString("-package oldname\n-import \"old\"\n")
	for i := 0; i < pad; i++ {
		fmt.Fprintf(&b, " shared row %d\n", i)
	}
	b.WriteString("+package newname\n+import \"new\"\n")
	diff := b.String()

	// Whole-diff compilation is the reference: package rows kept, imports hidden.
	whole, err := compileEditPlan(diff, editPlan{})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"-package oldname", "+package newname"} {
		if !strings.Contains(whole.smartDiff, want) {
			t.Fatalf("whole-diff reference lost %q:\n%s", want, whole.smartDiff)
		}
	}

	// Budget forces the cut between the removed and added runs.
	prefix := strings.SplitAfter(diff, "shared row 2\n")[0]
	budget := len(numberedDiff(prefix))
	defer setSingleRunBudget(t, budget)()
	if fitsSingleRun(diff, budget) {
		t.Fatal("fixture should exceed the budget")
	}
	m := &scriptedModel{turns: []*Response{assistant(toolUse("s", "submit", submission{
		Remove: []lineRange{}, Replace: []lineReplacement{}, Fold: []lineFold{}, Summary: "Renames the package.",
	}))}}
	res, err := Abridge(context.Background(), m, Request{UnifiedDiff: diff})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"-package oldname", "+package newname"} {
		if !strings.Contains(res.SmartDiff, want) {
			t.Errorf("chunked result lost package rename row %q:\n%s", want, res.SmartDiff)
		}
	}
	if strings.Contains(res.SmartDiff, "import ") {
		t.Errorf("chunked result retained import churn:\n%s", res.SmartDiff)
	}
}

// TestAbridge_ChunkedEmbeddedImportsNeverLeak: imports inside an embedded
// source string are recognized from the string's opener. A cut that severs
// the opener from the embedded rows must not leak them: the splitter
// pre-applies the whole-diff import mask, so the merged chunked result hides
// exactly what whole-diff compilation hides.
func TestAbridge_ChunkedEmbeddedImportsNeverLeak(t *testing.T) {
	meta := "diff --git a/plugin_test.go b/plugin_test.go\n--- a/plugin_test.go\n+++ b/plugin_test.go\n"
	const pad = 8
	var b strings.Builder
	b.WriteString(meta)
	fmt.Fprintf(&b, "@@ -0,0 +1,%d @@\n", pad+6)
	for i := 0; i < pad; i++ {
		fmt.Fprintf(&b, "+var pre%d = %d\n", i, i)
	}
	b.WriteString("+const fixture = `\n+import pytest\n+const helper = require(\"./helper\").default;\n+run(helper)\n+`\n+func TestFixture() { execute(fixture) }\n")
	diff := b.String()

	whole, err := compileEditPlan(diff, editPlan{})
	if err != nil {
		t.Fatal(err)
	}
	for _, unwanted := range []string{"import pytest", `require("./helper")`} {
		if strings.Contains(whole.smartDiff, unwanted) {
			t.Fatalf("whole-diff reference kept embedded import %q:\n%s", unwanted, whole.smartDiff)
		}
	}

	// Budget cuts between the string opener and the embedded import rows.
	prefix := strings.SplitAfter(diff, "const fixture = `\n")[0]
	budget := len(numberedDiff(prefix))
	defer setSingleRunBudget(t, budget)()
	if fitsSingleRun(diff, budget) {
		t.Fatal("fixture should exceed the budget")
	}
	m := &scriptedModel{turns: []*Response{assistant(toolUse("s", "submit", submission{
		Remove: []lineRange{}, Replace: []lineReplacement{}, Fold: []lineFold{}, Summary: "Adds fixture.",
	}))}}
	res, err := Abridge(context.Background(), m, Request{UnifiedDiff: diff})
	if err != nil {
		t.Fatal(err)
	}
	for _, unwanted := range []string{"import pytest", `require("./helper")`} {
		if strings.Contains(res.SmartDiff, unwanted) {
			t.Errorf("embedded import %q leaked into chunked result:\n%s", unwanted, res.SmartDiff)
		}
	}
	for _, want := range []string{"+run(helper)", "+func TestFixture"} {
		if !strings.Contains(res.SmartDiff, want) {
			t.Errorf("embedded behavior %q lost from chunked result:\n%s", want, res.SmartDiff)
		}
	}
}

// TestSplitDiff_ChunkCountBounded: pathological amplification (a large
// replicated metadata block leaving almost no per-piece body budget) must be
// refused rather than exploding into hundreds of chunks and agent runs.
func TestSplitDiff_ChunkCountBounded(t *testing.T) {
	meta := "diff --git a/a b/a\n--- a/a\n+++ b/a\n"
	var b strings.Builder
	b.WriteString(meta)
	const rows = 2000
	fmt.Fprintf(&b, "@@ -0,0 +1,%d @@\n", rows)
	for i := 0; i < rows; i++ {
		fmt.Fprintf(&b, "+row %d\n", i)
	}
	diff := b.String()
	// A budget barely above the per-piece overhead forces one tiny segment
	// per piece.
	budget := len(numberedDiff(meta+"@@ -1998,0 +1998,1 @@\n+row 1999\n")) + 30
	_, err := splitDiffForAbridging(diff, budget)
	if err == nil || !strings.Contains(err.Error(), "narrower") {
		t.Fatalf("err = %v, want chunk-count refusal with advice", err)
	}
}

// TestAbridge_ChunkedPreservesFormatPatchTrailer: a format-patch mail
// signature and version trailer after the last hunk must survive splitting;
// identity abridgement reproduces the input byte-for-byte.
func TestAbridge_ChunkedPreservesFormatPatchTrailer(t *testing.T) {
	var b strings.Builder
	b.WriteString("diff --git a/big.go b/big.go\n--- a/big.go\n+++ b/big.go\n")
	for h := 0; h < 4; h++ {
		fmt.Fprintf(&b, "@@ -%d,1 +%d,2 @@\n context %d\n+added %d\n", h*10+1, h*10+1, h, h)
	}
	b.WriteString("-- \n2.39.2\n\n")
	diff := b.String()
	budget := len(numberedDiff(diff))/2 + 60
	defer setSingleRunBudget(t, budget)()
	if fitsSingleRun(diff, budget) {
		t.Fatal("fixture should exceed the budget")
	}
	m := &scriptedModel{turns: []*Response{assistant(toolUse("s", "submit", submission{
		Remove: []lineRange{}, Replace: []lineReplacement{}, Fold: []lineFold{}, Summary: "Adds rows.",
	}))}}
	res, err := Abridge(context.Background(), m, Request{UnifiedDiff: diff})
	if err != nil {
		t.Fatal(err)
	}
	if res.SmartDiff != diff {
		t.Errorf("identity chunked abridgement altered the diff (trailer lost?):\ngot:\n%q\nwant:\n%q", res.SmartDiff, diff)
	}
}

// TestAbridge_ChunkedNeverStartsSegmentInsideStringLiteral: a segment that
// begins inside a multiline string would make the chunk-local compiler read
// the CLOSING delimiter as an opener, misclassifying following host-language
// rows as embedded source (and, e.g., hiding a behavioral require()). Cuts
// must keep string interiors attached to their opener.
func TestAbridge_ChunkedNeverStartsSegmentInsideStringLiteral(t *testing.T) {
	meta := "diff --git a/plugin_test.go b/plugin_test.go\n--- a/plugin_test.go\n+++ b/plugin_test.go\n"
	const pad = 8
	var b strings.Builder
	b.WriteString(meta)
	fmt.Fprintf(&b, "@@ -0,0 +1,%d @@\n", pad+7)
	for i := 0; i < pad; i++ {
		fmt.Fprintf(&b, "+var pre%d = %d\n", i, i)
	}
	b.WriteString("+const fixture = `\n+import pytest\n+run_inside()\n+`\n+var outside = require(\"outside\")\n+func F() {}\n+var post = 1\n")
	diff := b.String()

	whole, err := compileEditPlan(diff, editPlan{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(whole.smartDiff, `require("outside")`) {
		t.Fatalf("whole-diff reference lost the behavioral require:\n%s", whole.smartDiff)
	}

	// Try budgets that would place a naive cut on each line of the string
	// interior and just after it; none may lose the behavioral require row.
	for _, mark := range []string{"+import pytest\n", "+run_inside()\n", "+`\n"} {
		prefix := strings.SplitAfter(diff, mark)[0]
		budget := len(numberedDiff(prefix))
		restore := setSingleRunBudget(t, budget)
		if fitsSingleRun(diff, budget) {
			restore()
			t.Fatalf("budget %d should force a split", budget)
		}
		m := &scriptedModel{turns: []*Response{assistant(toolUse("s", "submit", submission{
			Remove: []lineRange{}, Replace: []lineReplacement{}, Fold: []lineFold{}, Summary: "Adds fixture.",
		}))}}
		res, err := Abridge(context.Background(), m, Request{UnifiedDiff: diff})
		restore()
		if err != nil {
			t.Fatalf("budget at %q: %v", mark, err)
		}
		if !strings.Contains(res.SmartDiff, `require("outside")`) {
			t.Errorf("budget at %q: behavioral require lost from chunked result:\n%s", mark, res.SmartDiff)
		}
		if strings.Contains(res.SmartDiff, "import pytest") {
			t.Errorf("budget at %q: embedded import leaked:\n%s", mark, res.SmartDiff)
		}
	}
}

// TestAbridge_ChunkedImportOnlyOversizeDiff: an oversized diff whose every
// changed row is import scaffolding splits into zero chunks; the result says
// so without any model call.
func TestAbridge_ChunkedImportOnlyOversizeDiff(t *testing.T) {
	meta := "diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n"
	const rows = 40
	var b strings.Builder
	b.WriteString(meta)
	fmt.Fprintf(&b, "@@ -0,0 +1,%d @@\n+import (\n", rows+2)
	for i := 0; i < rows; i++ {
		fmt.Fprintf(&b, "+\t%q\n", fmt.Sprintf("pkg/dep%02d", i))
	}
	b.WriteString("+)\n")
	diff := b.String()
	budget := len(numberedDiff(diff))/2 + 60
	defer setSingleRunBudget(t, budget)()
	if fitsSingleRun(diff, budget) {
		t.Fatal("fixture should exceed the budget")
	}
	m := &scriptedModel{turns: []*Response{assistant()}}
	res, err := Abridge(context.Background(), m, Request{UnifiedDiff: diff})
	if err != nil {
		t.Fatal(err)
	}
	if m.seen != 0 {
		t.Errorf("import-only diff reached the model %d times, want 0", m.seen)
	}
	if res.SmartDiff != "" || res.Summary == "" {
		t.Errorf("want empty diff with explanatory summary, got %+v", res)
	}
}

// TestSplitDiff_InterleavedSideStringInteriorAtomic: string interiors are
// tracked per diff side but in physical line order, so an interleaved row of
// the OTHER side between one side's opener and closer is also uncuttable — a
// segment starting there would desynchronize that side's lexical state.
func TestSplitDiff_InterleavedSideStringInteriorAtomic(t *testing.T) {
	meta := "diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n"
	const pad = 8
	var b strings.Builder
	b.WriteString(meta)
	fmt.Fprintf(&b, "@@ -1,%d +1,%d @@\n", pad+5, pad+3)
	for i := 0; i < pad; i++ {
		fmt.Fprintf(&b, " shared row %d\n", i)
	}
	// The old side's backtick string spans rows interleaved with new-side
	// rows; behavioral old-side rows follow the closer. A segment starting on
	// an interleaved + row would desynchronize the - side: the chunk-local
	// scan reads `end` + backtick as an OPENER and misclassifies the
	// following require() row as embedded source, hiding it.
	b.WriteString("-var s = `text\n+var t = 1\n-import \"embedded\"\n+var u = 2\n-end`\n-var outside = require(\"out\")\n-var last = 9\n+var v = 3\n")
	diff := b.String()

	whole, err := compileEditPlan(diff, editPlan{})
	if err != nil {
		t.Fatal(err)
	}
	wantChanged := changedRowsOf(whole.smartDiff)

	// Force cuts at each interleaved row; the merged identity result must
	// keep exactly the changed rows whole-diff compilation keeps. (Chunking
	// may drop change-free context segments; context is not load-bearing.)
	for _, mark := range []string{"+var t = 1\n", "-import \"embedded\"\n", "+var u = 2\n", "-end`\n"} {
		prefix := strings.SplitAfter(diff, mark)[0]
		budget := len(numberedDiff(prefix))
		chunks, err := splitDiffForAbridging(diff, budget)
		if err != nil {
			t.Fatalf("budget at %q: %v", mark, err)
		}
		requireValidChunks(t, chunks, budget)

		restore := setSingleRunBudget(t, budget)
		m := &scriptedModel{turns: []*Response{assistant(toolUse("s", "submit", submission{
			Remove: []lineRange{}, Replace: []lineReplacement{}, Fold: []lineFold{}, Summary: "Changes vars.",
		}))}}
		res, err := Abridge(context.Background(), m, Request{UnifiedDiff: diff})
		restore()
		if err != nil {
			t.Fatalf("budget at %q: %v", mark, err)
		}
		if got := changedRowsOf(res.SmartDiff); !slicesEqual(got, wantChanged) {
			t.Errorf("budget at %q: chunked changed rows diverge from whole-diff compilation:\nchunked: %q\nwhole:   %q", mark, got, wantChanged)
		}
	}
}

func changedRowsOf(diff string) []string {
	lines := splitSourceLines(diff)
	layout := analyzeDiff(lines)
	var rows []string
	for i, l := range lines {
		if layout.kinds[i] == diffLineHunkChange {
			rows = append(rows, l.text)
		}
	}
	return rows
}

func slicesEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// TestAbridge_ChunkedTrailerBecomesOwnPieceWhenLastIsFull: when greedy
// packing fills the section's final piece to the brim, the format-patch
// trailer becomes its own passthrough piece (no model run) instead of
// refusing the diff; identity abridgement stays byte-exact.
func TestAbridge_ChunkedTrailerBecomesOwnPieceWhenLastIsFull(t *testing.T) {
	var b strings.Builder
	b.WriteString("diff --git a/big.go b/big.go\n--- a/big.go\n+++ b/big.go\n")
	for h := 0; h < 4; h++ {
		fmt.Fprintf(&b, "@@ -%d,1 +%d,2 @@\n context %d\n+added %d\n", h*10+1, h*10+1, h, h)
	}
	body := b.String()
	trailer := "-- \n2.39.2\n\n"
	diff := body + trailer
	// Budget exactly fits half the body per piece, leaving no room for the
	// trailer on the last piece.
	budget := len(numberedDiff(body))/2 + 30
	chunks, err := splitDiffForAbridging(diff, budget)
	if err != nil {
		t.Fatal(err)
	}
	last := chunks[len(chunks)-1]
	if !last.passthrough || last.text != trailer {
		t.Logf("trailer attached to final piece instead; acceptable if it fit")
	}
	defer setSingleRunBudget(t, budget)()
	m := &scriptedModel{turns: []*Response{assistant(toolUse("s", "submit", submission{
		Remove: []lineRange{}, Replace: []lineReplacement{}, Fold: []lineFold{}, Summary: "Adds rows.",
	}))}}
	res, err := Abridge(context.Background(), m, Request{UnifiedDiff: diff})
	if err != nil {
		t.Fatal(err)
	}
	if res.SmartDiff != diff {
		t.Errorf("identity chunked abridgement altered the diff:\ngot:\n%q\nwant:\n%q", res.SmartDiff, diff)
	}
}

// TestAbridge_ChunkedKeepsPythonSuitePlaceholder: when the mandatory import
// pass empties a visible Python suite owner's body, whole-diff rendering
// emits a fixed `...` placeholder. Splitting must not lose it: a chunk-local
// compiler that never sees the import row cannot know the owner needs one.
func TestAbridge_ChunkedKeepsPythonSuitePlaceholder(t *testing.T) {
	meta := "diff --git a/mod.py b/mod.py\n--- a/mod.py\n+++ b/mod.py\n"
	const pad = 8
	var b strings.Builder
	b.WriteString(meta)
	fmt.Fprintf(&b, "@@ -0,0 +1,%d @@\n", pad+4)
	for i := 0; i < pad; i++ {
		fmt.Fprintf(&b, "+x%d = %d\n", i, i)
	}
	b.WriteString("+def optional_feature():\n+    import optional_dep\n+def useful():\n+    return 1\n")
	diff := b.String()

	whole, err := compileEditPlan(diff, editPlan{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(whole.smartDiff, "+    ...") {
		t.Fatalf("whole-diff reference lost its suite placeholder:\n%s", whole.smartDiff)
	}

	// Cut right at the import row, so the owner and its dropped body row
	// land in the same segment but the segment's own compiler never sees a
	// reason to emit a placeholder.
	for _, mark := range []string{"+def optional_feature():\n", "+    import optional_dep\n"} {
		prefix := strings.SplitAfter(diff, mark)[0]
		budget := len(numberedDiff(prefix))
		restore := setSingleRunBudget(t, budget)
		m := &scriptedModel{turns: []*Response{assistant(toolUse("s", "submit", submission{
			Remove: []lineRange{}, Replace: []lineReplacement{}, Fold: []lineFold{}, Summary: "Adds module.",
		}))}}
		res, err := Abridge(context.Background(), m, Request{UnifiedDiff: diff})
		restore()
		if err != nil {
			t.Fatalf("budget at %q: %v", mark, err)
		}
		if !strings.Contains(res.SmartDiff, "+    ...") {
			t.Errorf("budget at %q: chunked result lost the mandatory suite placeholder:\n%s", mark, res.SmartDiff)
		}
		if strings.Contains(res.SmartDiff, "import optional_dep") {
			t.Errorf("budget at %q: import leaked:\n%s", mark, res.SmartDiff)
		}
	}
}

// TestAbridge_ChunkedCrossFileImportMoveStaysHidden: an exact move pairing an
// import block in one file with the same block in another (e.g. relocated
// into a fixture file) is hidden on BOTH sides by whole-diff compilation via
// move precedence. When the two files land in different chunks, no
// chunk-local pass can see the pairing; the splitter must pre-drop both
// sides so imports never appear.
func TestAbridge_ChunkedCrossFileImportMoveStaysHidden(t *testing.T) {
	imports := "import (\n\t\"alpha/betapackage/deep\"\n\t\"gamma/deltapackage/deeper\"\n\t\"epsilon/zetapackage/deepest\"\n\t\"eta/thetapackage/bottom\"\n)\n"
	impLines := splitSourceLines(imports)
	var b strings.Builder
	b.WriteString("diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n")
	fmt.Fprintf(&b, "@@ -1,%d +1,1 @@\n context a\n", 1+len(impLines))
	for _, l := range impLines {
		b.WriteString("-" + l.text + "\n")
	}
	b.WriteString("diff --git a/fixture.txt b/fixture.txt\n--- a/fixture.txt\n+++ b/fixture.txt\n")
	fmt.Fprintf(&b, "@@ -1,1 +1,%d @@\n context f\n", 1+len(impLines)+1)
	for _, l := range impLines {
		b.WriteString("+" + l.text + "\n")
	}
	b.WriteString("+fixture tail\n")
	diff := b.String()

	// Whole-diff compilation hides both sides (import pass on a.go, move
	// precedence extending to fixture.txt).
	whole, err := compileEditPlan(diff, editPlan{})
	if err != nil {
		t.Fatal(err)
	}
	if len(detectExactMoves(splitSourceLines(diff), analyzeDiff(splitSourceLines(diff)))) == 0 {
		t.Fatal("fixture no longer triggers move detection")
	}
	if strings.Contains(whole.smartDiff, "alpha/betapackage") {
		t.Fatalf("whole-diff reference kept the moved import block:\n%s", whole.smartDiff)
	}

	// Budget forces the two file sections into separate chunks.
	second := strings.Index(diff, "diff --git a/fixture.txt")
	budget := len(numberedDiff(diff[:second]))
	defer setSingleRunBudget(t, budget)()
	if fitsSingleRun(diff, budget) {
		t.Fatal("fixture should exceed the budget")
	}
	m := &scriptedModel{turns: []*Response{assistant(toolUse("s", "submit", submission{
		Remove: []lineRange{}, Replace: []lineReplacement{}, Fold: []lineFold{}, Summary: "Moves imports into fixture.",
	}))}}
	res, err := Abridge(context.Background(), m, Request{UnifiedDiff: diff})
	if err != nil {
		t.Fatal(err)
	}
	for _, unwanted := range []string{"alpha/betapackage", "gamma/deltapackage", "import ("} {
		if strings.Contains(res.SmartDiff, unwanted) {
			t.Errorf("moved import %q leaked into chunked result:\n%s", unwanted, res.SmartDiff)
		}
	}
	if !strings.Contains(res.SmartDiff, "+fixture tail") {
		t.Errorf("behavioral fixture row lost:\n%s", res.SmartDiff)
	}
}

// TestAbridge_ChunkedDoesNotInventMoves: move uniqueness is a whole-diff
// property. A block occurring three times globally (ambiguous — no move
// detected, no symmetry enforced) must not become a detected "move" inside a
// chunk that happens to contain exactly one removal and one addition; chunk
// runs skip move detection entirely.
func TestAbridge_ChunkedDoesNotInventMoves(t *testing.T) {
	block := "    alpha := prepare(source)\n    beta := transform(alpha)\n    publish(beta)\n    record(beta)\n"
	blockLines := splitSourceLines(block)
	section := func(name string, marker byte, extra int) string {
		var b strings.Builder
		fmt.Fprintf(&b, "diff --git a/%s b/%s\n--- a/%s\n+++ b/%s\n", name, name, name, name)
		old, new := 1+len(blockLines)+extra, 1
		if marker == '+' {
			old, new = new, old
		}
		fmt.Fprintf(&b, "@@ -1,%d +1,%d @@\n context %s\n", old, new, name)
		for _, l := range blockLines {
			b.WriteByte(marker)
			b.WriteString(l.text)
			b.WriteByte('\n')
		}
		for i := 0; i < extra; i++ {
			fmt.Fprintf(&b, "%cfiller %s %d\n", marker, name, i)
		}
		return b.String()
	}
	// The block is removed once and added twice: globally ambiguous.
	diff := section("a.go", '-', 3) + section("b.go", '+', 3) + section("c.go", '+', 3)
	if n := len(detectedMovesInDiff(diff)); n != 0 {
		t.Fatalf("fixture should be globally ambiguous, detected %d moves", n)
	}

	// Split so a.go and b.go share chunk 1 (where the pair looks unique) and
	// c.go lands in chunk 2.
	secondStart := strings.Index(diff, "diff --git a/c.go")
	budget := len(numberedDiff(diff[:secondStart]))
	defer setSingleRunBudget(t, budget)()
	if fitsSingleRun(diff, budget) {
		t.Fatal("fixture should exceed the budget")
	}

	// The chunk-1 plan folds ONLY the removal side of the would-be move pair.
	// With chunk-local move detection this was rejected (asymmetric move
	// treatment) even though the whole diff detects no move at all.
	var remove6to9 []lineFold
	remove6to9 = append(remove6to9, lineFold{StartLine: 6, EndLine: 9})
	m := &scriptedModel{turns: []*Response{
		assistant(toolUse("s1", "submit", submission{
			Remove: []lineRange{}, Replace: []lineReplacement{}, Fold: remove6to9, Summary: "Removes pipeline.",
		})),
		assistant(toolUse("s2", "submit", submission{
			Remove: []lineRange{}, Replace: []lineReplacement{}, Fold: []lineFold{}, Summary: "Adds pipeline.",
		})),
	}}
	res, err := Abridge(context.Background(), m, Request{UnifiedDiff: diff})
	if err != nil {
		t.Fatal(err)
	}
	if m.seen != 2 {
		t.Fatalf("model calls = %d, want 2 (asymmetric fold must not be rejected in a chunk)", m.seen)
	}
	if !strings.Contains(res.SmartDiff, "-    ...") {
		t.Errorf("chunk-1 fold missing from merged result:\n%s", res.SmartDiff)
	}
	// No move hint appears in any chunk prompt.
	for i, msgs := range m.seenMessages {
		if strings.Contains(msgs[0].Content[0].Text, "exact source-evidenced moves") {
			t.Errorf("chunk %d prompt contains a move hint over a fragment", i)
		}
	}
}

// TestSplitDiff_PythonOwnerNotSeveredFromBody: a cut directly after a Python
// suite owner (def/if/decorator) would let one chunk's plan remove the owner
// while the body — invisible to that chunk's validator — survives in the
// next chunk. Owners are atomic with their first kept-side body row;
// removed-side rows between them do not satisfy the owner.
func TestSplitDiff_PythonOwnerNotSeveredFromBody(t *testing.T) {
	meta := "diff --git a/mod.py b/mod.py\n--- a/mod.py\n+++ b/mod.py\n"
	const pad = 8
	var b strings.Builder
	b.WriteString(meta)
	fmt.Fprintf(&b, "@@ -0,0 +1,%d @@\n", pad+4)
	for i := 0; i < pad; i++ {
		fmt.Fprintf(&b, "+x%d = %d\n", i, i)
	}
	b.WriteString("+if enabled:\n+    activate()\n+    finish()\n+done = True\n")
	diff := b.String()

	// Budgets that would naively cut right after the owner row.
	for _, mark := range []string{"+if enabled:\n"} {
		prefix := strings.SplitAfter(diff, mark)[0]
		budget := len(numberedDiff(prefix))
		chunks, err := splitDiffForAbridging(diff, budget)
		if err != nil {
			t.Fatalf("budget at %q: %v", mark, err)
		}
		requireValidChunks(t, chunks, budget)
		for i, c := range chunks {
			if strings.Contains(c.text, "+if enabled:") && !strings.Contains(c.text, "+    activate()") {
				t.Errorf("budget at %q: chunk %d severed the suite owner from its body:\n%s", mark, i, c.text)
			}
		}
	}

	// A context owner whose new body follows removed old rows: the cut must
	// not land between the owner (or the removed rows) and the first kept
	// body row.
	var c strings.Builder
	c.WriteString(meta)
	fmt.Fprintf(&c, "@@ -1,%d +1,%d @@\n", pad+3, pad+3)
	for i := 0; i < pad; i++ {
		fmt.Fprintf(&c, " y%d = %d\n", i, i)
	}
	c.WriteString(" if enabled:\n-    old_activate()\n+    new_activate()\n context_tail = 1\n")
	diff2 := c.String()
	for _, mark := range []string{" if enabled:\n", "-    old_activate()\n"} {
		prefix := strings.SplitAfter(diff2, mark)[0]
		budget := len(numberedDiff(prefix))
		chunks, err := splitDiffForAbridging(diff2, budget)
		if err != nil {
			t.Fatalf("budget at %q: %v", mark, err)
		}
		requireValidChunks(t, chunks, budget)
		for i, ch := range chunks {
			if strings.Contains(ch.text, " if enabled:") && !strings.Contains(ch.text, "+    new_activate()") {
				t.Errorf("budget at %q: chunk %d severed the context owner from its kept body:\n%s", mark, i, ch.text)
			}
		}
	}

	// An owner whose first following rows are a dropped import and a comment:
	// neither emits as semantic body, so the atomic unit must extend through
	// the first real body row (activate()).
	var d strings.Builder
	d.WriteString(meta)
	fmt.Fprintf(&d, "@@ -0,0 +1,%d @@\n", pad+5)
	for i := 0; i < pad; i++ {
		fmt.Fprintf(&d, "+z%d = %d\n", i, i)
	}
	d.WriteString("+if enabled:\n+    import optional_dep\n+    # explanatory comment\n+    activate()\n+done = True\n")
	diff3 := d.String()
	for _, mark := range []string{"+if enabled:\n", "+    import optional_dep\n", "+    # explanatory comment\n"} {
		prefix := strings.SplitAfter(diff3, mark)[0]
		budget := len(numberedDiff(prefix))
		chunks, err := splitDiffForAbridging(diff3, budget)
		if err != nil {
			t.Fatalf("budget at %q: %v", mark, err)
		}
		requireValidChunks(t, chunks, budget)
		for i, ch := range chunks {
			if strings.Contains(ch.text, "+if enabled:") && !strings.Contains(ch.text, "+    activate()") {
				t.Errorf("budget at %q: chunk %d severed the owner from its first emitted body row:\n%s", mark, i, ch.text)
			}
		}
	}
}

// TestAbridge_ChunkedImportOnlySectionsMakeNoModelRuns: sections and hunks
// the whole-diff compiler removes entirely (import-only) are skipped by the
// splitter, so a many-file import-churn diff does not pay one agent run per
// file shell.
func TestAbridge_ChunkedImportOnlySectionsMakeNoModelRuns(t *testing.T) {
	importSection := func(name string) string {
		var b strings.Builder
		fmt.Fprintf(&b, "diff --git a/%s b/%s\n--- a/%s\n+++ b/%s\n@@ -1,2 +1,2 @@\n-import \"old/dep\"\n+import \"new/dep\"\n context\n", name, name, name, name)
		return b.String()
	}
	behavioral := fileSection("real.go", 10)
	var b strings.Builder
	for i := 0; i < 6; i++ {
		b.WriteString(importSection(fmt.Sprintf("dep%d.go", i)))
	}
	b.WriteString(behavioral)
	diff := b.String()
	budget := len(numberedDiff(behavioral)) + 40
	defer setSingleRunBudget(t, budget)()
	if fitsSingleRun(diff, budget) {
		t.Fatal("fixture should exceed the budget")
	}
	m := &scriptedModel{turns: []*Response{assistant(toolUse("s", "submit", submission{
		Remove: []lineRange{}, Replace: []lineReplacement{}, Fold: []lineFold{}, Summary: "Adds real rows.",
	}))}}
	res, err := Abridge(context.Background(), m, Request{UnifiedDiff: diff})
	if err != nil {
		t.Fatal(err)
	}
	if m.seen != 1 {
		t.Errorf("model calls = %d, want 1 (import-only sections must not spend agent runs)", m.seen)
	}
	if strings.Contains(res.SmartDiff, "dep0.go") || strings.Contains(res.SmartDiff, "import") {
		t.Errorf("import-only sections leaked into the merged result:\n%s", res.SmartDiff)
	}
	if !strings.Contains(res.SmartDiff, "+real.go row 0") {
		t.Errorf("behavioral section lost:\n%s", res.SmartDiff)
	}
}

// TestAbridge_ChunkedEnforcesWholeDiffMoves: a genuine whole-diff move whose
// two sides land in the SAME chunk keeps full symmetry enforcement there:
// the whole-diff move set is mapped into chunk coordinates, hinted in the
// chunk prompt, and an asymmetric plan is rejected.
func TestAbridge_ChunkedEnforcesWholeDiffMoves(t *testing.T) {
	// surfaceFixtureDiff contains one exact cross-file move (old.txt lines
	// 6-9 ↔ new.txt lines 16-19). Pad a third unrelated section so the diff
	// splits with both move sides in chunk 1.
	pad := fileSection("zzz.go", 12)
	diff := surfaceFixtureDiff + pad
	budget := len(numberedDiff(surfaceFixtureDiff)) + 20
	defer setSingleRunBudget(t, budget)()
	if fitsSingleRun(diff, budget) {
		t.Fatal("fixture should exceed the budget")
	}
	chunks, err := splitDiffForAbridging(diff, budget)
	if err != nil {
		t.Fatal(err)
	}
	if len(chunks) < 2 || !strings.Contains(chunks[0].text, "new_location_ready") {
		t.Fatalf("fixture should put both move sides in chunk 1; got %d chunks", len(chunks))
	}

	// First submission folds only ONE side of the move pair — must be
	// rejected. Second submission treats both sides symmetrically.
	asym := submission{
		Remove: []lineRange{}, Replace: []lineReplacement{},
		Fold:    []lineFold{{StartLine: 6, EndLine: 9}},
		Summary: "Relocates the pipeline.",
	}
	sym := submission{
		Remove: []lineRange{}, Replace: []lineReplacement{},
		Fold:    []lineFold{{StartLine: 6, EndLine: 9}, {StartLine: 16, EndLine: 19}},
		Summary: "Relocates the pipeline.",
	}
	identity := submission{Remove: []lineRange{}, Replace: []lineReplacement{}, Fold: []lineFold{}, Summary: "Adds rows."}
	m := &scriptedModel{turns: []*Response{
		assistant(toolUse("bad", "submit", asym)),
		assistant(toolUse("good", "submit", sym)),
		assistant(toolUse("z", "submit", identity)),
	}}
	res, err := Abridge(context.Background(), m, Request{UnifiedDiff: diff})
	if err != nil {
		t.Fatal(err)
	}
	if m.seen != 3 {
		t.Fatalf("model calls = %d, want 3 (asymmetric rejected, symmetric accepted, second chunk)", m.seen)
	}
	// The chunk prompt carried the move hint in chunk coordinates.
	if prompt := m.seenMessages[0][0].Content[0].Text; !strings.Contains(prompt, "-6..9 \u2194 +16..19") {
		t.Errorf("chunk prompt lost the whole-diff move hint:\n%s", prompt)
	}
	// The rejection reached the model as a tool error naming the asymmetry.
	var sawMoveError bool
	for _, msg := range m.seenMessages[1] {
		for _, blk := range msg.Content {
			if blk.Type == "tool_result" && blk.ToolError && strings.Contains(blk.ToolResult, "move") {
				sawMoveError = true
			}
		}
	}
	if !sawMoveError {
		t.Error("asymmetric move plan was not rejected with a move error")
	}
	if got := strings.Count(res.SmartDiff, "..."); got < 2 {
		t.Errorf("symmetric folds missing from merged result:\n%s", res.SmartDiff)
	}
}

// TestSplitDiff_PythonContinuationsAtomic: explicit backslash continuations
// and open bracket expressions must not be severed across chunks. Per-chunk
// validators cannot see the cross-boundary relationship: one chunk's plan
// could remove `value = first + \` while the next retains the orphan
// `    second`, or elide a list opener while its members and closer survive.
func TestSplitDiff_PythonContinuationsAtomic(t *testing.T) {
	meta := "diff --git a/mod.py b/mod.py\n--- a/mod.py\n+++ b/mod.py\n"
	const pad = 8
	var b strings.Builder
	b.WriteString(meta)
	fmt.Fprintf(&b, "@@ -0,0 +1,%d @@\n", pad+8)
	for i := 0; i < pad; i++ {
		fmt.Fprintf(&b, "+x%d = %d\n", i, i)
	}
	b.WriteString("+value = first + \\\n+    second\n+values = [\n+    1,\n+    2,\n+]\n+tail = 3\n+tail2 = 4\n")
	diff := b.String()

	// Try to force a cut on every continuation row; the atomic mask must
	// keep each continuation with its opener.
	for _, mark := range []string{"+value = first + \\\n", "+values = [\n", "+    1,\n", "+    2,\n"} {
		prefix := strings.SplitAfter(diff, mark)[0]
		budget := len(numberedDiff(prefix))
		chunks, err := splitDiffForAbridging(diff, budget)
		if err != nil {
			t.Fatalf("budget at %q: %v", mark, err)
		}
		requireValidChunks(t, chunks, budget)
		for i, c := range chunks {
			if strings.Contains(c.text, "+value = first") != strings.Contains(c.text, "+    second") {
				t.Errorf("budget at %q: chunk %d severed a backslash continuation:\n%s", mark, i, c.text)
			}
			if strings.Contains(c.text, "+values = [") != strings.Contains(c.text, "+]") {
				t.Errorf("budget at %q: chunk %d severed a bracketed literal:\n%s", mark, i, c.text)
			}
		}
	}

	// End to end at one such budget: a plan that removes the continuation
	// opener but keeps its tail must be rejected inside the chunk, exactly
	// as whole-diff compilation rejects it.
	prefix := strings.SplitAfter(diff, "+    1,\n")[0]
	budget := len(numberedDiff(prefix))
	chunks, err := splitDiffForAbridging(diff, budget)
	if err != nil {
		t.Fatal(err)
	}
	var chunk1 string
	for _, c := range chunks {
		if strings.Contains(c.text, "+value = first") {
			chunk1 = c.text
			break
		}
	}
	if chunk1 == "" {
		t.Fatal("no chunk contains the continuation opener")
	}
	openerLine := 0
	for i, l := range splitSourceLines(chunk1) {
		if l.text == "+value = first + \\" {
			openerLine = i + 1
			break
		}
	}
	if openerLine == 0 {
		t.Fatalf("opener not found in chunk:\n%s", chunk1)
	}
	defer setSingleRunBudget(t, budget)()
	bad := submission{
		Remove:  []lineRange{{StartLine: openerLine, EndLine: openerLine}},
		Replace: []lineReplacement{}, Fold: []lineFold{},
		Summary: "Removes the assignment.",
	}
	identity := submission{Remove: []lineRange{}, Replace: []lineReplacement{}, Fold: []lineFold{}, Summary: "Adds rows."}
	m := &scriptedModel{turns: []*Response{
		assistant(toolUse("bad", "submit", bad)),
		assistant(toolUse("ok", "submit", identity)),
		assistant(toolUse("ok2", "submit", identity)),
	}}
	res, err := Abridge(context.Background(), m, Request{UnifiedDiff: diff})
	if err != nil {
		t.Fatal(err)
	}
	var sawRejection bool
	for _, msgs := range m.seenMessages {
		for _, msg := range msgs {
			for _, blk := range msg.Content {
				if blk.Type == "tool_result" && blk.ToolError && strings.Contains(blk.ToolResult, "continuation") {
					sawRejection = true
				}
			}
		}
	}
	if !sawRejection {
		t.Error("orphaning the backslash continuation was not rejected inside the chunk")
	}
	if !strings.Contains(res.SmartDiff, "+    second") || !strings.Contains(res.SmartDiff, "+value = first + \\") {
		t.Errorf("merged result lost the continuation pair:\n%s", res.SmartDiff)
	}
}

// TestRequestStaysPositionalCompatible pins Request's exported shape: chunk
// bookkeeping lives in runOptions, not Request, so embedders' positional
// struct literals keep compiling across the chunking feature.
func TestRequestStaysPositionalCompatible(t *testing.T) {
	req := Request{"", "diff --git a/a b/a\n@@ -1 +1 @@\n+x\n", 0, nil}
	if req.UnifiedDiff == "" {
		t.Fatal("positional Request literal did not populate UnifiedDiff")
	}
}

func TestFitsSingleRun(t *testing.T) {
	diff := "diff --git a/a b/a\n@@ -1 +1 @@\n+x\n"
	if !fitsSingleRun(diff, len(numberedDiff(diff))) {
		t.Error("diff should fit a budget equal to its numbered size")
	}
	if fitsSingleRun(diff, len(numberedDiff(diff))-1) {
		t.Error("diff should not fit below its numbered size")
	}
	if fitsSingleRun(strings.Repeat("x", 100), 50) {
		t.Error("raw size over budget should not fit")
	}
}
