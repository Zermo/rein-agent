package meat

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

// maxToolOutput bounds the size of any single tool result fed back to the model,
// so a giant file or a broad grep can't blow the context window.
const maxToolOutput = 16 * 1024

// toolbox holds per-run state the read-only tools need: the repo root they are
// confined to, the immutable raw diff, and the validated submission captured by
// the submit tool.
type toolbox struct {
	root           string
	rawDiff        string
	smartDiff      string
	submitted      *submission
	submittedPlan  *compiledPlan
	submitFeedback string
	submitSeen     bool
	// noMoves disables per-plan move DETECTION for chunk runs, where move
	// uniqueness computed over a fragment would be wrong; moves carries the
	// whole-diff moves the splitter mapped into this chunk's coordinates,
	// which are enforced instead.
	noMoves bool
	moves   []detectedMove
}

func editPlanToolSchema(withSummary bool) json.RawMessage {
	properties := `
		"remove":{
			"type":"array",
			"description":"Inclusive 1-based ranges of original diff lines to omit. Coordinates never shift.",
			"items":{"type":"object","additionalProperties":false,"properties":{"start_line":{"type":"integer","minimum":1},"end_line":{"type":"integer","minimum":1}},"required":["start_line","end_line"]}
		},
		"replace":{
			"type":"array",
			"description":"Single-line source elisions. new must match old with each omitted span visibly replaced by ... or … .",
			"items":{"type":"object","additionalProperties":false,"properties":{"line":{"type":"integer","minimum":1},"old":{"type":"string","minLength":1},"new":{"type":"string"}},"required":["line","old","new"]}
		},
		"fold":{
			"type":"array",
			"description":"Ranges of two or more same-polarity hunk source lines to replace with one machine-generated, indentation-preserving ... row.",
			"items":{"type":"object","additionalProperties":false,"properties":{"start_line":{"type":"integer","minimum":1},"end_line":{"type":"integer","minimum":1}},"required":["start_line","end_line"]}
		}`
	required := `"remove","replace","fold"`
	if withSummary {
		properties += `,"summary":{"type":"string","description":"One-line, high-level description of what the change does."}`
		required += `,"summary"`
	}
	return json.RawMessage(fmt.Sprintf(`{"type":"object","additionalProperties":false,"properties":{%s},"required":[%s]}`, properties, required))
}

func (tb *toolbox) previewPlanTool() Tool {
	return Tool{
		Name:        "preview_plan",
		Description: "Validate a complete remove/replace/fold plan against the numbered ORIGINAL diff and preview the resulting reading diff with retention statistics. Imports are removed automatically and moved code must be treated symmetrically; the feedback reports anything that needs fixing. Large previews are explicitly truncated. Plans are never incremental.",
		InputSchema: editPlanToolSchema(false),
	}
}

// submitTool is always advertised; read_file/grep are only offered when the
// toolbox is confined to a repo root.
func (tb *toolbox) submitTool() Tool {
	return Tool{
		Name:        "submit",
		Description: "Submit a final complete remove/replace/fold plan against the numbered ORIGINAL diff plus a one-line summary. Meat applies the plan locally (removing imports automatically and rejecting asymmetric treatment of moved code); do not submit a rewritten diff.",
		InputSchema: editPlanToolSchema(true),
	}
}

// tools returns the tool schemas advertised to the model.
func (tb *toolbox) tools() []Tool {
	if tb.root == "" {
		return []Tool{tb.previewPlanTool(), tb.submitTool()}
	}
	return []Tool{
		{
			Name:        "read_file",
			Description: "Read a UTF-8 text file from the repository to gather clues about whether a diff line is load-bearing (or whether a file is generated). Paths are relative to the repo root. Optionally restrict to an inclusive 1-based line range with start_line/end_line.",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"path":{"type":"string","description":"File path relative to the repo root."},"start_line":{"type":"integer","description":"1-based first line (optional)."},"end_line":{"type":"integer","description":"1-based last line (optional)."}},"required":["path"]}`),
		},
		{
			Name:        "grep",
			Description: "Search the repository for a regular expression (git grep). Use it to find call sites, type definitions, generator directives, or whether a symbol is used elsewhere. Optionally scope to a path prefix.",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"pattern":{"type":"string","description":"Regular expression to search for."},"path":{"type":"string","description":"Optional path prefix (relative to repo root)."}},"required":["pattern"]}`),
		},
		tb.previewPlanTool(),
		tb.submitTool(),
	}
}

// run dispatches a tool call by name and returns the textual result plus whether
// it was an error.
func (tb *toolbox) run(ctx context.Context, name string, input json.RawMessage) (string, bool) {
	switch name {
	case "read_file":
		return tb.readFile(input)
	case "grep":
		return tb.grep(ctx, input)
	case "preview_plan":
		return tb.previewPlan(input)
	case "submit":
		return tb.submit(input)
	default:
		return fmt.Sprintf("unknown tool %q", name), true
	}
}

// resolveInRoot joins rel to the repo root and verifies the result stays inside
// it, defeating path traversal via .. or absolute paths.
func (tb *toolbox) resolveInRoot(rel string) (string, error) {
	clean := filepath.Clean(rel)
	if filepath.IsAbs(clean) {
		return "", fmt.Errorf("path must be relative to the repo root")
	}
	rootAbs, err := filepath.Abs(tb.root)
	if err != nil {
		return "", err
	}
	absAbs, err := filepath.Abs(filepath.Join(tb.root, clean))
	if err != nil {
		return "", err
	}
	if absAbs != rootAbs && !strings.HasPrefix(absAbs, rootAbs+string(os.PathSeparator)) {
		return "", fmt.Errorf("path escapes the repo root")
	}
	return absAbs, nil
}

type readFileInput struct {
	Path      string `json:"path"`
	StartLine int    `json:"start_line"`
	EndLine   int    `json:"end_line"`
}

func (tb *toolbox) readFile(raw json.RawMessage) (string, bool) {
	var in readFileInput
	if err := json.Unmarshal(raw, &in); err != nil {
		return fmt.Sprintf("invalid input: %v", err), true
	}
	abs, err := tb.resolveInRoot(in.Path)
	if err != nil {
		return err.Error(), true
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return fmt.Sprintf("read %s: %v", in.Path, err), true
	}
	text := string(data)
	if in.StartLine > 0 || in.EndLine > 0 {
		text = sliceLines(text, in.StartLine, in.EndLine)
	}
	return truncateForTool(text), false
}

type grepInput struct {
	Pattern string `json:"pattern"`
	Path    string `json:"path"`
}

func (tb *toolbox) grep(ctx context.Context, raw json.RawMessage) (string, bool) {
	var in grepInput
	if err := json.Unmarshal(raw, &in); err != nil {
		return fmt.Sprintf("invalid input: %v", err), true
	}
	if strings.TrimSpace(in.Pattern) == "" {
		return "pattern is required", true
	}
	args := []string{"grep", "-n", "-I", "--no-color", "-e", in.Pattern}
	if in.Path != "" {
		if _, err := tb.resolveInRoot(in.Path); err != nil {
			return err.Error(), true
		}
		args = append(args, "--", in.Path)
	}
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = tb.root
	out, err := cmd.Output()
	if len(out) == 0 {
		if ee, ok := err.(*exec.ExitError); ok && ee.ExitCode() == 1 {
			return "(no matches)", false
		}
		if err != nil {
			return fmt.Sprintf("git grep: %v", err), true
		}
		return "(no matches)", false
	}
	return truncateForTool(capLines(string(out), 200)), false
}

func requirePlanArrays(remove []lineRange, replace []lineReplacement, fold []lineFold) error {
	if remove == nil || replace == nil || fold == nil {
		return fmt.Errorf("remove, replace, and fold must all be JSON arrays (use [] when empty)")
	}
	return nil
}

func (tb *toolbox) previewPlan(raw json.RawMessage) (string, bool) {
	var in editPlan
	if err := decodeStrict(raw, &in); err != nil {
		return fmt.Sprintf("invalid input: %v", err), true
	}
	if err := requirePlanArrays(in.Remove, in.Replace, in.Fold); err != nil {
		return "invalid input: " + err.Error(), true
	}
	compiled, err := compileEditPlanMoves(tb.rawDiff, in, tb.moves, !tb.noMoves)
	if err != nil {
		return truncateForTool(fmt.Sprintf("invalid edit plan: %v", err)), true
	}
	return truncateForTool(planFeedback(compiled)), false
}

func (tb *toolbox) submit(raw json.RawMessage) (string, bool) {
	if tb.submitSeen {
		return "a submission has already been accepted", true
	}
	var in submission
	if err := decodeStrict(raw, &in); err != nil {
		return fmt.Sprintf("invalid input: %v", err), true
	}
	if err := requirePlanArrays(in.Remove, in.Replace, in.Fold); err != nil {
		return "invalid input: " + err.Error(), true
	}
	compiled, err := compileSubmissionMoves(tb.rawDiff, in, tb.moves, !tb.noMoves)
	if err != nil {
		return truncateForTool(fmt.Sprintf("invalid edit plan: %v", err)), true
	}
	tb.submitted = &in
	tb.submittedPlan = &compiled
	tb.smartDiff = compiled.smartDiff
	tb.submitFeedback = planFeedback(compiled)
	tb.submitSeen = true
	return truncateForTool(tb.submitFeedback), false
}

func retentionPressure(stats planStats) bool {
	if stats.rawChanged < 40 || stats.visibleChanged < 20 {
		return false
	}
	return stats.visibleChanged >= 80 || stats.visibleChanged*100 >= stats.rawChanged*45
}

// The static model-visible plan-feedback fragments, named so promptSurface can
// hash the complete frozen surface.
const (
	feedbackRetention    = "Valid source-derived plan.\nRetention: %d/%d visible changed rows (%d%%); %d removed, %d hidden by %d folds"
	feedbackMoves        = "Moves: %d exact cross-hunk/cross-file span(s) treated symmetrically (%s).\n"
	feedbackPressureHigh = "Pressure: high retention. Reconsider repeated rename/call-site hunks after one representative anchor, default git context, mechanical prose, duplicate setup/cases, and assertion batches or suites that can become fixed ... folds. Imports are already removed mechanically. For Python, keep each suite owner, required setup, and decisive stimulus/outcome: never hide a table assignment used by a retained loop, or an entire pytester.makeini/makeconftest configuration that defines the scenario. Move folds inside those boundaries. This is advisory: preserve every distinct contract, security or compatibility caveat, condition, lifecycle edge, transformation, effect, stimulus, and outcome.\n"
	feedbackPressureOK   = "Pressure: acceptable. Preserve uncertain behavior.\n"
)

func planFeedback(compiled compiledPlan) string {
	stats := compiled.stats
	percent := 0
	if stats.rawChanged > 0 {
		percent = stats.visibleChanged * 100 / stats.rawChanged
	}
	var b strings.Builder
	fmt.Fprintf(&b, feedbackRetention,
		stats.visibleChanged, stats.rawChanged, percent,
		stats.removedChanged, stats.foldedChanged, stats.foldCount,
	)
	if stats.rawFiles > 0 {
		fmt.Fprintf(&b, "; files %d/%d", stats.visibleFiles, stats.rawFiles)
	}
	b.WriteString(".\n")
	if len(compiled.moves) > 0 {
		fmt.Fprintf(&b, feedbackMoves, len(compiled.moves), formatMovePairs(compiled.moves, maxMoveHints))
	}
	if retentionPressure(stats) {
		b.WriteString(feedbackPressureHigh)
	} else {
		b.WriteString(feedbackPressureOK)
	}
	b.WriteString("Preview (revised plans still use ORIGINAL line coordinates):\n")
	b.WriteString(compiled.smartDiff)
	return b.String()
}

func (tb *toolbox) clearSubmission() {
	tb.smartDiff = ""
	tb.submitted = nil
	tb.submittedPlan = nil
	tb.submitFeedback = ""
	tb.submitSeen = false
}

func decodeStrict(raw json.RawMessage, dst any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		if err == nil {
			return fmt.Errorf("multiple JSON values")
		}
		return err
	}
	return nil
}

func sliceLines(text string, start, end int) string {
	lines := strings.Split(text, "\n")
	if start < 1 {
		start = 1
	}
	if end < 1 || end > len(lines) {
		end = len(lines)
	}
	if start > len(lines) {
		return ""
	}
	var b strings.Builder
	for i := start; i <= end; i++ {
		fmt.Fprintf(&b, "%d\t%s\n", i, lines[i-1])
	}
	return b.String()
}

func capLines(s string, max int) string {
	sc := bufio.NewScanner(strings.NewReader(s))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	var b strings.Builder
	n := 0
	for sc.Scan() {
		if n >= max {
			fmt.Fprintf(&b, "... (truncated, more than %d lines)\n", max)
			break
		}
		b.WriteString(sc.Text())
		b.WriteByte('\n')
		n++
	}
	return b.String()
}

func truncateForTool(s string) string {
	if len(s) <= maxToolOutput {
		return s
	}
	cut := maxToolOutput
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + fmt.Sprintf("\n... (truncated, %d total bytes)", len(s))
}
