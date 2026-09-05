// Package meat abridges a code diff down to the parts a senior reviewer
// actually needs to read.
//
// Reviewing good code in diff form is mostly about understanding the high-level
// change to the program, not sweating mechanical details: the code compiles and
// its tests pass. A reviewer does not need to read the exact spelling of an
// error message, an obvious zero value added to a return, the type conversions
// threaded through a field copy — or generated code. They need to know "what
// changed, where did it come from, where did it go".
//
// meat takes a whole unified diff (spanning as many files as it touches) and
// asks an LLM agent for an edit plan that removes noise while retaining what
// carries meaning. Meat applies the plan to the immutable input itself, so the
// model never authors the displayed diff wholesale. The agent has read-only
// access to the surrounding source tree so it can use clues to decide what is
// load-bearing. A diff too large for one agent context is split at file and
// hunk boundaries into independently valid chunks, abridged chunk by chunk,
// and merged (see chunk.go).
//
// The package is provider-agnostic: callers supply a Model. The command
// meat.dev ships built-in OpenAI Responses and Anthropic Messages models;
// embedders such as Shelley can still adapt their own LLM client.
package meat

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// defaultMaxTurns bounds how many model round-trips a single abridgement may
// take. A whole-diff run may explore several files before submitting, so this
// allows a good deal of tool use while still terminating a runaway loop.
const defaultMaxTurns = 24

// defaultBudget bounds total wall-clock time for one agent run (the whole
// diff, or one chunk of a split diff) so a stuck run can't hang forever.
const defaultBudget = 4 * time.Minute

// abridgeBudget is a variable so deadline/fallback behavior can be tested
// without waiting for the production budget.
var abridgeBudget = defaultBudget

// maxDiffBytes bounds both the raw diff and its numbered form sent to one
// agent run. The numbered whole diff is sent up front (and re-sent every
// turn), so a bigger input would blow the context window. Diffs over this
// limit are split into chunks at structural boundaries (see chunk.go) and
// abridged one chunk per run.
const maxDiffBytes = 400 << 10 // ~400 KB ≈ 100k+ tokens of code

// singleRunDiffBytes is a variable so chunked-abridging tests can exercise
// real splits with small fixtures instead of 400KB inputs.
var singleRunDiffBytes = maxDiffBytes

// Request is a whole-diff abridgement request. The diff may span many files;
// abridging the whole change at once (rather than file by file) lets the model
// reason across files and gives it maximum context to decide what is
// load-bearing. A diff too large for one model context is split at structural
// boundaries and abridged chunk by chunk (see chunk.go).
type Request struct {
	// RepoRoot is the directory the read-only tools are confined to. If empty,
	// the tools are disabled (the model abridges from the diff text alone).
	RepoRoot string
	// UnifiedDiff is the raw unified diff to abridge (e.g. the full output of
	// `git diff` or `git show`). Required.
	UnifiedDiff string
	// MaxTurns overrides defaultMaxTurns when > 0.
	MaxTurns int
	// Progress, when non-nil, receives short human-readable status updates as
	// the run proceeds (one per model turn and per tool call; chunked runs
	// prefix each update with its chunk). Callers use it for interactive
	// feedback; it must not block.
	Progress func(msg string)
}

// runOptions carries chunk-internal state for one agent run, kept out of the
// exported Request so embedders' struct literals stay source-compatible.
type runOptions struct {
	// chunkRun marks a per-chunk agent run of a split diff. Move detection is
	// a whole-diff property (a block appearing three times globally is
	// deliberately ambiguous, but a chunk seeing two occurrences would invent
	// a move), so chunk runs never detect moves themselves; chunkMoves carries
	// the whole-diff moves whose sides both landed in this chunk, mapped to
	// chunk coordinates, and those are hinted and enforced instead. A move
	// split across chunks cannot be enforced — a documented cost of chunking.
	chunkRun   bool
	chunkMoves []detectedMove
}

// Result is the abridged reading diff. The json tags give embedders and the
// CLI's -json output a stable snake_case wire form.
type Result struct {
	// SmartDiff is the abridged reading diff. It preserves unified-diff shape
	// for navigation and coloring, but is not intended to be an applicable
	// patch: removed lines may leave original hunk counts stale. Empty when no
	// meaningful change remains after abridging.
	SmartDiff string `json:"smart_diff"`
	// Summary is a one-line, high-level description of the change.
	Summary string `json:"summary"`
	// InputTokens and OutputTokens are the cumulative token usage across the run.
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
}

// noToolCallNudge is sent when the model produced text but no tool call. Like
// every model-visible string, it describes only what the model must do next.
const noToolCallNudge = "Call preview_plan or submit with a complete remove/replace/fold plan against the numbered ORIGINAL diff. Prefer removals and fixed multiline folds; use replace only for a local single-line elision. If nothing meaningful changed, remove every original line."

// Abridge turns req.UnifiedDiff into a reading diff, using the supplied Model
// for all generation. A diff that fits one agent run is abridged whole; a
// larger diff (up to maxTotalDiffBytes) is split at structural boundaries and
// abridged chunk by chunk, and the per-chunk results are merged.
func Abridge(ctx context.Context, model Model, req Request) (*Result, error) {
	if model == nil {
		return nil, fmt.Errorf("meat: nil model")
	}
	if strings.TrimSpace(req.UnifiedDiff) == "" {
		return &Result{Summary: "No changes."}, nil
	}
	if len(req.UnifiedDiff) > maxTotalDiffBytes {
		return nil, fmt.Errorf("meat: diff is %dMB, over the %dMB limit — try a narrower range (a single commit, or per-file with `git diff -- <path> | meat`)", len(req.UnifiedDiff)>>20, maxTotalDiffBytes>>20)
	}
	if err := validateSupportedDiff(req.UnifiedDiff); err != nil {
		return nil, fmt.Errorf("meat: %w", err)
	}
	if !fitsSingleRun(req.UnifiedDiff, singleRunDiffBytes) {
		return abridgeChunked(ctx, model, req)
	}
	return abridgeOne(ctx, model, req, runOptions{})
}

// abridgeOne runs the agent loop on one single-run-sized diff: the whole
// input when it fits, or one chunk of a split diff.
func abridgeOne(ctx context.Context, model Model, req Request, opts runOptions) (*Result, error) {
	numbered := numberedDiff(req.UnifiedDiff)

	maxTurns := req.MaxTurns
	if maxTurns <= 0 {
		maxTurns = defaultMaxTurns
	}

	callerCtx := ctx
	ctx, cancel := context.WithTimeout(ctx, abridgeBudget)
	defer cancel()

	tb := &toolbox{root: req.RepoRoot, rawDiff: req.UnifiedDiff, noMoves: opts.chunkRun, moves: opts.chunkMoves}
	tools := tb.tools()

	messages := []Message{{
		Role:    RoleUser,
		Content: []Block{textBlock(buildUserPrompt(req, opts, numbered))},
	}}

	progress := req.Progress
	if progress == nil {
		progress = func(string) {}
	}

	var inTok, outTok int
	var retentionNudged bool
	var fallback *Result

	for turn := 0; turn < maxTurns; turn++ {
		progress(fmt.Sprintf("thinking (turn %d)", turn+1))
		resp, err := model.Generate(ctx, systemPrompt, messages, tools)
		if err != nil {
			if fallback != nil && callerCtx.Err() == nil {
				fallback.InputTokens = inTok
				fallback.OutputTokens = outTok
				return fallback, nil
			}
			return nil, fmt.Errorf("meat: model generate: %w", err)
		}
		inTok += resp.InputTokens
		outTok += resp.OutputTokens

		messages = append(messages, Message{Role: RoleAssistant, Content: resp.Content})

		var results []Block
		for _, b := range resp.Content {
			if b.Type != "tool_use" {
				continue
			}
			progress(describeToolCall(b))
			out, isErr := tb.run(ctx, b.ToolName, b.ToolInput)
			results = append(results, Block{
				Type:       "tool_result",
				ToolUseID:  b.ID,
				ToolResult: out,
				ToolError:  isErr,
			})
		}

		if tb.submitSeen {
			candidate := &Result{
				SmartDiff:    tb.smartDiff,
				Summary:      tb.submitted.Summary,
				InputTokens:  inTok,
				OutputTokens: outTok,
			}
			canRefine := !retentionNudged && turn+1 < maxTurns &&
				tb.submittedPlan != nil && retentionPressure(tb.submittedPlan.stats)
			if canRefine {
				fallback = candidate
				retentionNudged = true
				tb.clearSubmission()
				messages = append(messages, Message{Role: RoleUser, Content: results})
				continue
			}
			return candidate, nil
		}

		if len(results) == 0 {
			// The model produced text but no tool call. Nudge it once toward
			// submitting; the loop bound prevents this from running away.
			messages = append(messages, Message{
				Role:    RoleUser,
				Content: []Block{textBlock(noToolCallNudge)},
			})
			continue
		}
		messages = append(messages, Message{Role: RoleUser, Content: results})
	}

	if fallback != nil {
		if err := callerCtx.Err(); err != nil {
			return nil, fmt.Errorf("meat: caller context: %w", err)
		}
		fallback.InputTokens = inTok
		fallback.OutputTokens = outTok
		return fallback, nil
	}
	return nil, fmt.Errorf("meat: agent did not submit within %d turns", maxTurns)
}

// The static model-visible user-prompt fragments. Every string the model can
// see that is not derived from the input diff lives in a named const so
// promptSurface can hash the complete frozen surface.
const (
	userPromptIntro    = "Abridge the following unified diff into a reading diff by submitting a complete remove/replace/fold plan against the numbered original lines. Meat applies your plan to the original diff; you do not write the resulting diff yourself. Coordinates are 1-based and always refer to the original numbering. The `N|` gutter is display-only and is not part of a line's source text. Use preview_plan to inspect sizeable drafts before submit.\n"
	userPromptImports  = "Imports/includes/requires/use declarations are removed automatically, including multiline blocks and recognized imports inside embedded source strings. They may appear in the numbered input but never in a preview or result. Do not spend edit coordinates on them, never fold across them into behavioral rows, and do not mention them in the summary.\n"
	userPromptMoves    = "Meat detected exact source-evidenced moves across hunks/files: %s. Give both sides of each pair identical keep/remove/fold/replace treatment, including matching fold boundaries and equivalent local elisions; automatically removed rows need none. Asymmetric plans are rejected.\n"
	userPromptTools    = "Use read_file/grep on the surrounding source only when it changes your judgment about what is load-bearing (or whether a file is generated), then preview or submit.\n"
	userPromptNoTools  = "Judge from the diff text alone, then preview or submit.\n"
	userPromptProtocol = "Prefer removing whole lines or ranges. Use fold to replace two or more contiguous same-polarity hunk lines with one machine-generated, indentation-preserving `...` row. Use replace only to elide part of one source line; `new` must match all of `old` with every omitted span visibly represented by `...` or `…`. Keep useful per-file and hunk structure unless the entire file or hunk is noise.\n\n```diff\n"
)

func buildUserPrompt(req Request, opts runOptions, numbered string) string {
	var b strings.Builder
	b.WriteString(userPromptIntro)
	b.WriteString(userPromptImports)
	moves := detectedMovesInDiff(req.UnifiedDiff)
	if opts.chunkRun {
		moves = opts.chunkMoves
	}
	if len(moves) > 0 {
		fmt.Fprintf(&b, userPromptMoves, formatMovePairs(moves, maxMoveHints))
	}
	if req.RepoRoot != "" {
		b.WriteString(userPromptTools)
	} else {
		b.WriteString(userPromptNoTools)
	}
	b.WriteString(userPromptProtocol)
	b.WriteString(numbered)
	b.WriteString("```\n")
	return b.String()
}

// describeToolCall renders a tool_use block as a short progress message, e.g.
// "read_file cmd/meat/main.go" or "grep \"func Foo\"".
func describeToolCall(b Block) string {
	switch b.ToolName {
	case "read_file":
		var in struct {
			Path string `json:"path"`
		}
		json.Unmarshal(b.ToolInput, &in)
		return strings.TrimSpace("read_file " + in.Path)
	case "grep":
		var in struct {
			Pattern string `json:"pattern"`
		}
		json.Unmarshal(b.ToolInput, &in)
		return strings.TrimSpace(fmt.Sprintf("grep %q", in.Pattern))
	case "preview_plan":
		return "previewing"
	case "submit":
		return "submitting"
	default:
		return b.ToolName
	}
}
