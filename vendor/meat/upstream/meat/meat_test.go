package meat

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// scriptedModel returns a pre-baked response per turn, letting tests drive the
// agent loop deterministically. It records the requests it received.
type scriptedModel struct {
	turns        []*Response
	seen         int
	lastTools    []Tool
	seenMessages [][]Message
}

func (m *scriptedModel) Generate(_ context.Context, _ string, messages []Message, tools []Tool) (*Response, error) {
	m.lastTools = tools
	m.seenMessages = append(m.seenMessages, append([]Message(nil), messages...))
	m.seen++
	if m.seen > len(m.turns) {
		return m.turns[len(m.turns)-1], nil
	}
	return m.turns[m.seen-1], nil
}

type deadlineFallbackModel struct {
	seen int
}

func (m *deadlineFallbackModel) Generate(ctx context.Context, _ string, _ []Message, _ []Tool) (*Response, error) {
	m.seen++
	if m.seen == 1 {
		return assistant(toolUse("draft", "submit", submission{
			Remove: []lineRange{}, Replace: []lineReplacement{}, Fold: []lineFold{}, Summary: "Changes calls.",
		})), nil
	}
	<-ctx.Done()
	return nil, ctx.Err()
}

type callerCancelFallbackModel struct {
	seen   int
	cancel context.CancelFunc
}

func (m *callerCancelFallbackModel) Generate(ctx context.Context, _ string, _ []Message, _ []Tool) (*Response, error) {
	m.seen++
	if m.seen == 1 {
		return assistant(toolUse("draft", "submit", submission{
			Remove: []lineRange{}, Replace: []lineReplacement{}, Fold: []lineFold{}, Summary: "Changes calls.",
		})), nil
	}
	m.cancel()
	<-ctx.Done()
	return nil, ctx.Err()
}

func toolUse(id, name string, input any) Block {
	raw, _ := json.Marshal(input)
	return Block{Type: "tool_use", ID: id, ToolName: name, ToolInput: raw}
}

func assistant(content ...Block) *Response {
	return &Response{Content: content, InputTokens: 100, OutputTokens: 20}
}

// gitRepo creates a throwaway git repo so the grep tool (git grep) works.
func gitRepo(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
	}
	run("init", "-q")
	run("config", "user.email", "t@t.test")
	run("config", "user.name", "t")
	for name, content := range files {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	run("add", "-A")
	run("commit", "-qm", "init")
	return dir
}

func TestAbridge_PreviewThenSubmit(t *testing.T) {
	diff := "diff --git a/a.py b/a.py\n@@ -0,0 +1,4 @@\n+def test_it():\n+    setup()\n+    exercise()\n+    assert result\n"
	plan := editPlan{Remove: []lineRange{}, Replace: []lineReplacement{}, Fold: []lineFold{{StartLine: 4, EndLine: 5}}}
	m := &scriptedModel{turns: []*Response{
		assistant(toolUse("preview", "preview_plan", plan)),
		assistant(toolUse("submit", "submit", submission{
			Remove: plan.Remove, Replace: plan.Replace, Fold: plan.Fold, Summary: "Tests the result.",
		})),
	}}
	var progress []string
	res, err := Abridge(context.Background(), m, Request{
		UnifiedDiff: diff,
		Progress:    func(s string) { progress = append(progress, s) },
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(res.SmartDiff, "+    ...") || m.seen != 2 {
		t.Fatalf("preview/submit result turns=%d:\n%s", m.seen, res.SmartDiff)
	}
	var sawPreviewResult bool
	for _, msg := range m.seenMessages[1] {
		for _, block := range msg.Content {
			sawPreviewResult = sawPreviewResult || strings.Contains(block.ToolResult, "Valid source-derived plan")
		}
	}
	if !sawPreviewResult || !slices.Contains(progress, "previewing") {
		t.Fatalf("preview plumbing missing: result=%v progress=%v", sawPreviewResult, progress)
	}
}

func TestAbridge_ReadThenSubmit(t *testing.T) {
	repo := gitRepo(t, map[string]string{
		"route.go": "package route\n\ntype routeData struct{ boxID int }\n",
	})

	m := &scriptedModel{turns: []*Response{
		assistant(toolUse("t1", "read_file", readFileInput{Path: "route.go"})),
		assistant(toolUse("t2", "submit", submission{
			Remove: []lineRange{},
			Replace: []lineReplacement{{
				Line: 3,
				Old:  "resp.BoxID = int64(rd.boxID)",
				New:  "resp.BoxID = ...",
			}},
			Fold:    []lineFold{},
			Summary: "Copies cache fields from rd to resp.",
		})),
	}}

	res, err := Abridge(context.Background(), m, Request{
		RepoRoot:    repo,
		UnifiedDiff: "diff --git a/route.go b/route.go\n@@\n+    resp.BoxID = int64(rd.boxID)\n",
	})
	if err != nil {
		t.Fatalf("Abridge: %v", err)
	}
	if !strings.Contains(res.SmartDiff, "resp.BoxID = ...") {
		t.Errorf("smart diff = %q, want collapsed form", res.SmartDiff)
	}
	if res.Summary == "" {
		t.Errorf("want non-empty summary")
	}
	if res.InputTokens == 0 || res.OutputTokens == 0 {
		t.Errorf("want token usage accumulated, got in=%d out=%d", res.InputTokens, res.OutputTokens)
	}
	if m.seen != 2 {
		t.Errorf("want 2 model calls, got %d", m.seen)
	}
}

func TestAbridge_EmptyDiffShortCircuits(t *testing.T) {
	m := &scriptedModel{turns: []*Response{assistant()}}
	res, err := Abridge(context.Background(), m, Request{RepoRoot: t.TempDir(), UnifiedDiff: "  "})
	if err != nil {
		t.Fatal(err)
	}
	if res.SmartDiff != "" {
		t.Errorf("want empty smart diff")
	}
	if m.seen != 0 {
		t.Errorf("want no model calls for empty diff, got %d", m.seen)
	}
}

func TestRetentionPressure(t *testing.T) {
	cases := []struct {
		stats planStats
		want  bool
	}{
		{planStats{rawChanged: 39, visibleChanged: 39}, false},
		{planStats{rawChanged: 100, visibleChanged: 19}, false},
		{planStats{rawChanged: 100, visibleChanged: 44}, false},
		{planStats{rawChanged: 100, visibleChanged: 45}, true},
		{planStats{rawChanged: 200, visibleChanged: 80}, true},
	}
	for _, tc := range cases {
		if got := retentionPressure(tc.stats); got != tc.want {
			t.Errorf("retentionPressure(%+v) = %v, want %v", tc.stats, got, tc.want)
		}
	}
}

func retentionFixtureDiff() string {
	var b strings.Builder
	b.WriteString("diff --git a/a.py b/a.py\n@@ -1,25 +1,25 @@\n")
	for i := 0; i < 25; i++ {
		b.WriteString("-old_call()\n")
	}
	for i := 0; i < 25; i++ {
		b.WriteString("+new_call()\n")
	}
	return b.String()
}

func TestAbridge_HighRetentionGetsOneRefinementTurn(t *testing.T) {
	diff := retentionFixtureDiff()
	m := &scriptedModel{turns: []*Response{
		assistant(toolUse("draft", "submit", submission{
			Remove: []lineRange{}, Replace: []lineReplacement{}, Fold: []lineFold{}, Summary: "Changes calls.",
		})),
		assistant(toolUse("final", "submit", submission{
			Remove: []lineRange{}, Replace: []lineReplacement{},
			Fold:    []lineFold{{StartLine: 3, EndLine: 27}, {StartLine: 28, EndLine: 52}},
			Summary: "Changes calls.",
		})),
	}}

	res, err := Abridge(context.Background(), m, Request{UnifiedDiff: diff})
	if err != nil {
		t.Fatal(err)
	}
	if m.seen != 2 {
		t.Fatalf("model turns = %d, want one refinement turn", m.seen)
	}
	if strings.Count(res.SmartDiff, "...") != 2 || strings.Contains(res.SmartDiff, "old_call") || strings.Contains(res.SmartDiff, "new_call") {
		t.Fatalf("refined diff =\n%s", res.SmartDiff)
	}
	var sawPressure, sawPreview bool
	for _, msg := range m.seenMessages[1] {
		for _, block := range msg.Content {
			if block.Type == "tool_result" {
				sawPressure = sawPressure || strings.Contains(block.ToolResult, "Pressure: high retention")
				sawPreview = sawPreview || strings.Contains(block.ToolResult, "Preview") && strings.Contains(block.ToolResult, "+new_call()")
			}
		}
	}
	if !sawPressure || !sawPreview {
		t.Fatalf("refinement turn did not receive pressure and exact preview: %+v", m.seenMessages[1])
	}
}

func TestAbridge_OversizedHighRetentionStillGetsRefinementTurn(t *testing.T) {
	var b strings.Builder
	b.WriteString("diff --git a/a.py b/a.py\n@@ -0,0 +1,100 @@\n")
	for i := 0; i < 100; i++ {
		b.WriteString("+call_")
		b.WriteString(strings.Repeat("x", 220))
		b.WriteString("()\n")
	}
	diff := b.String()
	m := &scriptedModel{turns: []*Response{
		assistant(toolUse("draft", "submit", submission{
			Remove: []lineRange{}, Replace: []lineReplacement{}, Fold: []lineFold{}, Summary: "Adds calls.",
		})),
		assistant(toolUse("final", "submit", submission{
			Remove: []lineRange{}, Replace: []lineReplacement{}, Fold: []lineFold{{StartLine: 3, EndLine: 102}}, Summary: "Adds calls.",
		})),
	}}
	res, err := Abridge(context.Background(), m, Request{UnifiedDiff: diff})
	if err != nil {
		t.Fatal(err)
	}
	if m.seen != 2 || !strings.Contains(res.SmartDiff, "+...") {
		t.Fatalf("oversized refinement turns=%d diff=\n%s", m.seen, res.SmartDiff)
	}
	var truncated bool
	for _, msg := range m.seenMessages[1] {
		for _, block := range msg.Content {
			truncated = truncated || strings.Contains(block.ToolResult, "truncated")
		}
	}
	if !truncated {
		t.Fatal("oversized refinement feedback was neither complete nor explicitly truncated")
	}
}

func TestAbridge_InternalDeadlineReturnsValidFallback(t *testing.T) {
	oldBudget := abridgeBudget
	abridgeBudget = 20 * time.Millisecond
	defer func() { abridgeBudget = oldBudget }()

	diff := retentionFixtureDiff()
	m := &deadlineFallbackModel{}
	res, err := Abridge(context.Background(), m, Request{UnifiedDiff: diff})
	if err != nil {
		t.Fatal(err)
	}
	if m.seen != 2 || res.SmartDiff != diff {
		t.Fatalf("deadline fallback turns=%d diff changed=%v", m.seen, res.SmartDiff != diff)
	}
}

func TestAbridge_CallerCancellationStillWinsOverFallback(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	m := &callerCancelFallbackModel{cancel: cancel}
	if _, err := Abridge(ctx, m, Request{UnifiedDiff: retentionFixtureDiff()}); err == nil {
		t.Fatal("caller cancellation returned fallback instead of an error")
	}
}

func TestAbridge_HighRetentionDraftIsFallback(t *testing.T) {
	diff := retentionFixtureDiff()
	m := &scriptedModel{turns: []*Response{
		assistant(toolUse("draft", "submit", submission{
			Remove: []lineRange{}, Replace: []lineReplacement{}, Fold: []lineFold{}, Summary: "Changes calls.",
		})),
		assistant(textBlock("I cannot safely compress it further.")),
	}}
	res, err := Abridge(context.Background(), m, Request{UnifiedDiff: diff, MaxTurns: 2})
	if err != nil {
		t.Fatal(err)
	}
	if res.SmartDiff != diff {
		t.Fatalf("fallback diff changed:\n%s", res.SmartDiff)
	}
}

func TestAbridge_NoRepoOffersPlanTools(t *testing.T) {
	m := &scriptedModel{turns: []*Response{
		assistant(toolUse("t1", "submit", submission{Remove: []lineRange{}, Replace: []lineReplacement{}, Fold: []lineFold{}, Summary: "noop"})),
	}}
	_, err := Abridge(context.Background(), m, Request{UnifiedDiff: "diff --git a/x b/x\n@@\n+x\n"})
	if err != nil {
		t.Fatal(err)
	}
	// With no RepoRoot, only the plan preview and submit tools are advertised.
	if len(m.lastTools) != 2 || m.lastTools[0].Name != "preview_plan" || m.lastTools[1].Name != "submit" {
		t.Errorf("want preview_plan and submit, got %+v", m.lastTools)
	}
}

func TestToolboxGrepAndPathConfinement(t *testing.T) {
	repo := gitRepo(t, map[string]string{"a.go": "package a\nfunc Foo() {}\n"})
	tb := &toolbox{root: repo}

	in, _ := json.Marshal(grepInput{Pattern: "func Foo"})
	out, isErr := tb.grep(context.Background(), in)
	if isErr {
		t.Fatalf("grep error: %s", out)
	}
	if !strings.Contains(out, "a.go") {
		t.Errorf("grep result = %q, want a.go match", out)
	}

	bad, _ := json.Marshal(readFileInput{Path: "../../../etc/passwd"})
	if _, isErr := tb.readFile(bad); !isErr {
		t.Errorf("want path traversal rejected")
	}
}

// TestAbridge_RejectsOversizeDiff: a diff over the total cap must be refused
// up front with actionable advice, never sent to the model — chunking makes
// large diffs feasible, not unbounded.
func TestAbridge_RejectsOversizeDiff(t *testing.T) {
	m := &scriptedModel{turns: []*Response{assistant()}}
	big := "diff --git a/x b/x\n+" + strings.Repeat("x", maxTotalDiffBytes)
	_, err := Abridge(context.Background(), m, Request{UnifiedDiff: big})
	if err == nil {
		t.Fatal("want error for oversize diff")
	}
	if !strings.Contains(err.Error(), "narrower") {
		t.Errorf("error should advise narrowing the range: %v", err)
	}
	if m.seen != 0 {
		t.Errorf("oversize diff must not reach the model; got %d calls", m.seen)
	}
}

// TestAbridge_RejectsUnsplittableOversizeDiff: a diff over the single-run
// budget with no structural boundaries to split at must be refused with
// actionable advice, never sent to the model.
func TestAbridge_RejectsUnsplittableOversizeDiff(t *testing.T) {
	m := &scriptedModel{turns: []*Response{assistant()}}
	// One file section, no hunks: nothing to split at.
	big := "diff --git a/x b/x\n+" + strings.Repeat("x", maxDiffBytes)
	_, err := Abridge(context.Background(), m, Request{UnifiedDiff: big})
	if err == nil {
		t.Fatal("want error for unsplittable oversize diff")
	}
	if !strings.Contains(err.Error(), "narrower") {
		t.Errorf("error should advise narrowing the diff: %v", err)
	}
	if m.seen != 0 {
		t.Errorf("unsplittable diff must not reach the model; got %d calls", m.seen)
	}
}

func TestAbridge_RejectsInconsistentHunkCounts(t *testing.T) {
	m := &scriptedModel{turns: []*Response{assistant()}}
	diff := "diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new\n+extra\n"
	_, err := Abridge(context.Background(), m, Request{UnifiedDiff: diff})
	if err == nil || !strings.Contains(err.Error(), "counts inconsistent") {
		t.Fatalf("Abridge error = %v, want hunk-count rejection", err)
	}
	if m.seen != 0 {
		t.Fatalf("malformed diff must not reach model; got %d calls", m.seen)
	}
}

func TestAbridge_RejectsCombinedDiff(t *testing.T) {
	m := &scriptedModel{turns: []*Response{assistant()}}
	diff := "diff --cc a.go\n@@@ -1,1 -1,1 +1,1 @@@\n++resolved\n"
	_, err := Abridge(context.Background(), m, Request{UnifiedDiff: diff})
	if err == nil || !strings.Contains(err.Error(), "combined diff") {
		t.Fatalf("Abridge error = %v, want combined-diff rejection", err)
	}
	if m.seen != 0 {
		t.Fatalf("combined diff must not reach model; got %d calls", m.seen)
	}
}

// TestAbridge_NumberedDiffExpansionTriggersChunking: many tiny lines fit
// under the raw byte budget but acquire a substantial line-number gutter. The
// per-run model prompt must stay bounded, so such a diff is chunked rather
// than sent whole.
func TestAbridge_NumberedDiffExpansionTriggersChunking(t *testing.T) {
	restore := setSingleRunBudget(t, 400)
	defer restore()
	// Two file sections of 40 three-byte lines each: raw ≈ 360 bytes fits the
	// budget, but the numbered form (3 extra bytes per line) does not.
	var b strings.Builder
	for _, name := range []string{"a", "b"} {
		fmt.Fprintf(&b, "diff --git a/%s b/%s\n@@ -0,0 +1,40 @@\n", name, name)
		for i := 0; i < 40; i++ {
			b.WriteString("+x\n")
		}
	}
	diff := b.String()
	if len(diff) > 400 {
		t.Fatalf("fixture raw size = %d, want under the raw budget", len(diff))
	}
	if fitsSingleRun(diff, 400) {
		t.Fatal("fixture numbered form should exceed the budget")
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
	if m.seen < 2 {
		t.Errorf("model calls = %d, want one per chunk (>= 2)", m.seen)
	}
	for _, msgs := range m.seenMessages {
		prompt := msgs[0].Content[0].Text
		if len(prompt) > 400+len(userPromptIntro)+len(userPromptImports)+len(userPromptNoTools)+len(userPromptProtocol)+8 {
			t.Errorf("per-chunk prompt is %d bytes; numbered chunk must stay within budget", len(prompt))
		}
	}
	if res == nil || !strings.Contains(res.SmartDiff, "+x") {
		t.Fatalf("merged result missing retained rows: %+v", res)
	}
}

// TestAbridge_ProgressCallbacks: the Progress hook receives a turn update and a
// message per tool call, so an interactive caller can show liveness.
func TestAbridge_ProgressCallbacks(t *testing.T) {
	repo := gitRepo(t, map[string]string{"a.go": "package a\n"})
	m := &scriptedModel{turns: []*Response{
		assistant(toolUse("t1", "read_file", readFileInput{Path: "a.go"})),
		assistant(toolUse("t2", "grep", grepInput{Pattern: "package"})),
		assistant(toolUse("t3", "submit", submission{Remove: []lineRange{}, Replace: []lineReplacement{}, Fold: []lineFold{}, Summary: "s"})),
	}}
	var msgs []string
	_, err := Abridge(context.Background(), m, Request{
		RepoRoot:    repo,
		UnifiedDiff: "diff --git a/a.go b/a.go\n@@\n+x\n",
		Progress:    func(msg string) { msgs = append(msgs, msg) },
	})
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(msgs, "\n")
	for _, want := range []string{"turn 1", "read_file a.go", `grep "package"`, "submitting"} {
		if !strings.Contains(joined, want) {
			t.Errorf("progress messages missing %q:\n%s", want, joined)
		}
	}
}

func TestAbridge_InvalidEditPlanRetries(t *testing.T) {
	const diff = "diff --git a/a.go b/a.go\n@@ -1 +1 @@\n-old\n+new\n"
	m := &scriptedModel{turns: []*Response{
		assistant(toolUse("bad", "submit", submission{
			Remove:  []lineRange{{StartLine: 99, EndLine: 99}},
			Replace: []lineReplacement{{Line: 98, Old: "new", New: "..."}},
			Fold:    []lineFold{},
			Summary: "Changes the value.",
		})),
		assistant(toolUse("good", "submit", submission{
			Remove:  []lineRange{{StartLine: 3, EndLine: 3}},
			Replace: []lineReplacement{{Line: 4, Old: "new", New: "n..."}},
			Fold:    []lineFold{},
			Summary: "Changes the value.",
		})),
	}}

	res, err := Abridge(context.Background(), m, Request{UnifiedDiff: diff})
	if err != nil {
		t.Fatal(err)
	}
	if m.seen != 2 {
		t.Fatalf("model calls = %d, want 2", m.seen)
	}
	if strings.Contains(res.SmartDiff, "-old") || !strings.Contains(res.SmartDiff, "+n...") {
		t.Fatalf("derived smart diff did not apply corrected plan:\n%s", res.SmartDiff)
	}

	var sawAggregatedToolError bool
	for _, msg := range m.seenMessages[1] {
		for _, b := range msg.Content {
			if b.Type == "tool_result" && b.ToolError &&
				strings.Contains(b.ToolResult, "remove[0]") &&
				strings.Contains(b.ToolResult, "replace[0]") {
				sawAggregatedToolError = true
			}
		}
	}
	if !sawAggregatedToolError {
		t.Fatal("corrective turn did not receive all independently detectable plan errors")
	}
}

func TestAbridge_IgnoresAssistantAuthoredDiffText(t *testing.T) {
	const diff = "diff --git a/a.go b/a.go\n@@ -1 +1 @@\n-old\n+new\n"
	m := &scriptedModel{turns: []*Response{
		assistant(
			textBlock("diff --git a/invented.go b/invented.go\n+dangerousCall()"),
			toolUse("submit", "submit", submission{
				Remove:  []lineRange{{StartLine: 3, EndLine: 3}},
				Replace: []lineReplacement{},
				Fold:    []lineFold{},
				Summary: "Changes the value.",
			}),
		),
	}}
	res, err := Abridge(context.Background(), m, Request{UnifiedDiff: diff})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(res.SmartDiff, "invented") || strings.Contains(res.SmartDiff, "dangerousCall") {
		t.Fatalf("assistant prose leaked into smart diff:\n%s", res.SmartDiff)
	}
	if !strings.Contains(res.SmartDiff, "+new") {
		t.Fatalf("original retained line missing:\n%s", res.SmartDiff)
	}
}

func TestPreviewPlanShowsExactFoldAndDoesNotSubmit(t *testing.T) {
	tb := &toolbox{rawDiff: "diff --git a/a.py b/a.py\n@@ -0,0 +1,4 @@\n+def test_it():\n+    setup()\n+    exercise()\n+    assert result\n"}
	out, isErr := tb.previewPlan(json.RawMessage(`{"remove":[],"replace":[],"fold":[{"start_line":4,"end_line":5}]}`))
	if isErr {
		t.Fatalf("preview_plan = %q", out)
	}
	for _, want := range []string{"Retention: 3/4", "hidden by 1 folds", "+    ...", "+    assert result"} {
		if !strings.Contains(out, want) {
			t.Errorf("preview missing %q:\n%s", want, out)
		}
	}
	if tb.submitSeen || tb.submitted != nil || tb.smartDiff != "" {
		t.Fatal("preview_plan mutated final submission state")
	}
}

func TestSubmitToolUsesEditPlanSchema(t *testing.T) {
	tb := &toolbox{}
	tool := tb.submitTool()
	if strings.Contains(string(tool.InputSchema), "smart_diff") {
		t.Fatalf("submit schema still accepts a model-authored smart diff: %s", tool.InputSchema)
	}
	for _, want := range []string{`"remove"`, `"replace"`, `"fold"`, `"start_line"`, `"old"`, `"new"`} {
		if !strings.Contains(string(tool.InputSchema), want) {
			t.Errorf("submit schema missing %s: %s", want, tool.InputSchema)
		}
	}
}

func TestSubmitRejectsLegacySmartDiff(t *testing.T) {
	tb := &toolbox{rawDiff: "diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new\n"}
	out, isErr := tb.submit(json.RawMessage(`{"smart_diff":"+invented\n","summary":"Changes it.","remove":[],"replace":[]}`))
	if !isErr || !strings.Contains(out, "unknown field") {
		t.Fatalf("legacy smart_diff = (%q, %v), want unknown-field error", out, isErr)
	}
	if tb.submitSeen {
		t.Fatal("invalid legacy submission was accepted")
	}
}

func TestSubmitRequiresEditArrays(t *testing.T) {
	tb := &toolbox{rawDiff: "diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new\n"}
	for _, raw := range []string{
		`{"summary":"Changes it."}`,
		`{"remove":null,"replace":[],"fold":[],"summary":"Changes it."}`,
		`{"remove":[],"replace":null,"fold":[],"summary":"Changes it."}`,
		`{"remove":[],"replace":[],"fold":null,"summary":"Changes it."}`,
	} {
		out, isErr := tb.submit(json.RawMessage(raw))
		if !isErr || !strings.Contains(out, "must all be JSON arrays") {
			t.Errorf("submit(%s) = (%q, %v), want array error", raw, out, isErr)
		}
	}
}

func TestSubmitTruncatesValidationErrors(t *testing.T) {
	tb := &toolbox{rawDiff: "diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new\n"}
	in := submission{Remove: []lineRange{}, Fold: []lineFold{}, Summary: "Changes the value."}
	for i := 0; i < 2000; i++ {
		in.Replace = append(in.Replace, lineReplacement{Line: 100 + i, Old: "x", New: "..."})
	}
	raw, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	out, isErr := tb.submit(raw)
	if !isErr {
		t.Fatal("want invalid submission error")
	}
	if len(out) > maxToolOutput+100 || !strings.Contains(out, "truncated") {
		t.Fatalf("submit error was not bounded: %d bytes\n%s", len(out), out)
	}
}

// TestPromptSurfaceStaysFrozen enforces the frozen prompt surface documented
// on systemPrompt: compiler arbitration vocabulary (who owns an edit, which
// pass wins, how derived plans are merged) must not leak into the system
// prompt, the per-request user prompt, or tool descriptions. The model only
// needs to know what to act on; conflict resolution is explained solely by
// plan feedback when a specific plan hits a specific conflict.
func TestPromptSurfaceStaysFrozen(t *testing.T) {
	banned := []string{
		"mandatory",
		"compiler",
		"precedence over",
		"import precedence",
		"hiding wins",
		"wins before",
		"counterpart",
		"compiler-owned",
		"arbitrat",
	}

	moveDiff := exactMoveDiff
	surfaces := map[string]string{
		"systemPrompt":         systemPrompt,
		"userPrompt":           buildUserPrompt(Request{UnifiedDiff: moveDiff, RepoRoot: "/repo"}, runOptions{}, numberedDiff(moveDiff)),
		"userPrompt (no root)": buildUserPrompt(Request{UnifiedDiff: moveDiff}, runOptions{}, numberedDiff(moveDiff)),
		"userPrompt (no move)": buildUserPrompt(Request{UnifiedDiff: surfaceFixtureNoMoveDiff, RepoRoot: "/repo"}, runOptions{}, numberedDiff(surfaceFixtureNoMoveDiff)),
	}
	tb := &toolbox{root: "/repo", rawDiff: moveDiff}
	for _, tool := range tb.tools() {
		surfaces["tool "+tool.Name] = tool.Description + string(tool.InputSchema)
	}
	surfaces["nudge"] = noToolCallNudge
	compiled, err := compileEditPlan(moveDiff, editPlan{
		Fold: []lineFold{{StartLine: 6, EndLine: 9}, {StartLine: 16, EndLine: 19}},
	})
	if err != nil {
		t.Fatal(err)
	}
	surfaces["planFeedback moves"] = planFeedback(compiled)
	// Cover the other feedback branches: no moves, and high retention
	// pressure (stats synthesized to trip retentionPressure).
	surfaces["planFeedback plain"] = planFeedback(compiledPlan{stats: planStats{rawChanged: 10, visibleChanged: 4, rawFiles: 1, visibleFiles: 1}})
	surfaces["planFeedback pressure"] = planFeedback(compiledPlan{stats: planStats{rawChanged: 100, visibleChanged: 90, rawFiles: 2, visibleFiles: 2}})

	for name, text := range surfaces {
		lower := strings.ToLower(text)
		for _, word := range banned {
			if strings.Contains(lower, word) {
				t.Errorf("%s leaks compiler-internal vocabulary %q", name, word)
			}
		}
	}

	// The freeze is not just an absence: the surfaces must still tell the
	// model everything it acts on. Guard the load-bearing guidance so a
	// rewording cannot silently drop it.
	required := map[string][]string{
		"systemPrompt": {
			"IMPORTS ARE REMOVED AUTOMATICALLY",
			"TREAT BEHAVIORAL MOVES SYMMETRICALLY",
			"NEVER invent or alter program logic",
		},
		"userPrompt": {
			"removed automatically",
			"-6..9 \u2194 +16..19", // detected move pair for exactMoveDiff
			"identical keep/remove/fold/replace treatment",
		},
	}
	for name, wants := range required {
		for _, want := range wants {
			if !strings.Contains(surfaces[name], want) {
				t.Errorf("%s lost required guidance %q", name, want)
			}
		}
	}
}

func TestBuildUserPromptNumbersOriginalDiff(t *testing.T) {
	diff := "diff --git a/a b/a\n@@ -1 +1 @@\n+x"
	prompt := buildUserPrompt(Request{UnifiedDiff: diff}, runOptions{}, numberedDiff(diff))
	for _, want := range []string{"1|diff --git a/a b/a", "2|@@ -1 +1 @@", "3|+x"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("numbered prompt missing %q:\n%s", want, prompt)
		}
	}
	if strings.Contains(prompt, "4|") {
		t.Errorf("numbered prompt contains phantom final line:\n%s", prompt)
	}
}

// TestRubricHash is stable within a build and mixes the rubric content.
func TestRubricHash(t *testing.T) {
	h := RubricHash()
	if len(h) != 16 {
		t.Errorf("RubricHash() = %q, want 16 hex chars", h)
	}
	if h != RubricHash() {
		t.Error("RubricHash is not deterministic")
	}
}

// TestRubricHashPinned is the approved-snapshot half of the prompt freeze:
// TestPromptSurfaceStaysFrozen catches known-bad vocabulary, and this pin makes
// EVERY change to a static model-visible string (system prompt, user-prompt
// fragments, tool descriptions and schemas, nudge, plan-feedback fragments) a
// deliberate, reviewable act. If this fails, re-read the frozen-surface policy
// on systemPrompt, confirm the change tells the model only what it acts on,
// then update the pinned hash (and bump abridgeProtocolVersion when edit
// semantics changed).
// TestSurfaceFixturesCoverBothMoveBranches keeps the canonical hashing
// fixtures honest: one must trigger move detection and the other must not,
// or promptSurface silently stops rendering a user-prompt branch.
func TestSurfaceFixturesCoverBothMoveBranches(t *testing.T) {
	if len(detectedMovesInDiff(surfaceFixtureDiff)) == 0 {
		t.Error("surfaceFixtureDiff no longer triggers move detection")
	}
	if n := len(detectedMovesInDiff(surfaceFixtureNoMoveDiff)); n != 0 {
		t.Errorf("surfaceFixtureNoMoveDiff detects %d moves, want 0", n)
	}
	if n := len(detectedMovesInDiff(surfaceOverflowDiff())); n <= maxMoveHints {
		t.Errorf("surfaceOverflowDiff detects %d moves, want more than maxMoveHints (%d) so the overflow hint renders", n, maxMoveHints)
	}
}

func TestRubricHashPinned(t *testing.T) {
	const pinned = "441f5e6e28ad3add"
	if h := RubricHash(); h != pinned {
		t.Errorf("RubricHash() = %q, pinned %q; the model-visible prompt surface changed — review it against the freeze policy on systemPrompt, then update the pin", h, pinned)
	}
}
