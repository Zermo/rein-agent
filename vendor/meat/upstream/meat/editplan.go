// editplan.go compiles a model-submitted edit plan against the immutable
// original diff.
//
// The model never authors output text: it submits remove/replace/fold
// operations in original line coordinates, and compileEditPlan validates the
// plan (structure, elision projections, move symmetry, language rules) and
// renders the reading diff mechanically.

package meat

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	maxReplacementBytes = 4 << 10
	maxSummaryBytes     = 500
)

// lineRange identifies an inclusive, 1-based range of physical lines in the
// original unified diff.
type lineRange struct {
	StartLine int `json:"start_line"`
	EndLine   int `json:"end_line"`
}

// lineReplacement replaces one exact span of one original hunk line. Old is
// matched against the source text after the diff's leading +, -, or context
// marker. New must be an elision projection of Old: characters may only be
// removed, with ... or … inserted as a reading placeholder.
type lineReplacement struct {
	Line int    `json:"line"`
	Old  string `json:"old"`
	New  string `json:"new"`
}

// lineFold replaces a contiguous range of original hunk source lines with one
// machine-generated, correctly indented ellipsis row.
type lineFold struct {
	StartLine int `json:"start_line"`
	EndLine   int `json:"end_line"`
}

// editPlan contains only source-anchored operations. It has no model-authored
// prose and can be previewed before a summary is available.
type editPlan struct {
	Remove  []lineRange       `json:"remove"`
	Replace []lineReplacement `json:"replace"`
	Fold    []lineFold        `json:"fold"`
}

// submission is a complete edit plan plus its one-line summary.
type submission struct {
	Remove  []lineRange       `json:"remove"`
	Replace []lineReplacement `json:"replace"`
	Fold    []lineFold        `json:"fold"`
	Summary string            `json:"summary"`
}

func (s submission) plan() editPlan {
	return editPlan{Remove: s.Remove, Replace: s.Replace, Fold: s.Fold}
}

type plannedReplacement struct {
	lineReplacement
	planIndex int
	start     int
	end       int
}

type plannedFold struct {
	lineFold
	planIndex int
	marker    byte
	indent    string
	eol       string
}

type planState struct {
	hidden []bool
	folded []int // fold index for every folded source line; -1 otherwise
	foldAt []int // fold index emitted at its first source line; -1 otherwise
	folds  []plannedFold
}

func newPlanState(lines int) planState {
	s := planState{
		hidden: make([]bool, lines),
		folded: make([]int, lines),
		foldAt: make([]int, lines),
	}
	for i := 0; i < lines; i++ {
		s.folded[i] = -1
		s.foldAt[i] = -1
	}
	return s
}

func (s planState) represented(line int) bool {
	return !s.hidden[line] || s.folded[line] >= 0
}

type planStats struct {
	rawChanged     int
	visibleChanged int
	removedChanged int
	foldedChanged  int
	foldCount      int
	rawFiles       int
	visibleFiles   int
}

type compiledPlan struct {
	smartDiff string
	stats     planStats
	moves     []detectedMove
}

// applyEditPlan validates the summary and atomically applies its source-anchored
// plan to raw.
func applyEditPlan(raw string, in submission) (string, error) {
	compiled, err := compileSubmission(raw, in)
	if err != nil {
		return "", err
	}
	return compiled.smartDiff, nil
}

func compileSubmission(raw string, in submission) (compiledPlan, error) {
	return compileSubmissionMoves(raw, in, nil, true)
}

func compileSubmissionMoves(raw string, in submission, provided []detectedMove, detect bool) (compiledPlan, error) {
	var problems []error
	if err := validateSummary(in.Summary); err != nil {
		problems = append(problems, err)
	}
	compiled, err := compileEditPlanMoves(raw, in.plan(), provided, detect)
	if err != nil {
		problems = append(problems, err)
	}
	if len(problems) > 0 {
		return compiledPlan{}, joinEditPlanErrors(problems)
	}
	return compiled, nil
}

// compileEditPlan validates and applies a plan without requiring a summary, so
// the exact reading diff can be previewed before final submission.
func compileEditPlan(raw string, in editPlan) (compiledPlan, error) {
	return compileEditPlanMoves(raw, in, nil, true)
}

// compileEditPlanMoves is compileEditPlan with the move set controllable.
// Move uniqueness is a whole-diff property: a block appearing three times
// globally is deliberately ambiguous, but a chunk of a split diff seeing only
// two occurrences would invent a move. Chunk compilation therefore disables
// detection (detect=false) and instead enforces the moves the splitter
// resolved against the whole diff and mapped into chunk coordinates.
func compileEditPlanMoves(raw string, in editPlan, provided []detectedMove, detect bool) (compiledPlan, error) {
	var problems []error

	lines := splitSourceLines(raw)
	if err := validateSupportedDiffLines(lines); err != nil {
		return compiledPlan{}, err
	}
	layout := analyzeDiff(lines)
	if len(layout.problems) > 0 {
		return compiledPlan{}, joinEditPlanErrors(layout.problems)
	}
	moves := provided
	if detect {
		moves = detectExactMoves(lines, layout)
	}
	mandatoryRemovals := mandatoryImportRemovalPlan(lines, layout)
	mandatoryHidden := mandatoryRemovalMask(len(lines), mandatoryRemovals)
	applyMandatoryMovePrecedence(moves, mandatoryHidden)
	state := newPlanState(len(lines))
	copy(state.hidden, mandatoryHidden)
	modelRemoved := make([]bool, len(lines))
	removalsValid := true
	for i, r := range in.Remove {
		if r.StartLine < 1 || r.EndLine < 1 || r.StartLine > r.EndLine {
			problems = append(problems, fmt.Errorf("remove[%d]: invalid inclusive range %d-%d", i, r.StartLine, r.EndLine))
			removalsValid = false
			continue
		}
		if r.EndLine > len(lines) {
			problems = append(problems, fmt.Errorf("remove[%d]: line %d is past end of diff (%d lines)", i, r.EndLine, len(lines)))
			removalsValid = false
			continue
		}
		firstOverlap := 0
		for n := r.StartLine; n <= r.EndLine; n++ {
			if modelRemoved[n-1] {
				if firstOverlap == 0 {
					firstOverlap = n
				}
				removalsValid = false
				continue
			}
			modelRemoved[n-1] = true
			state.hidden[n-1] = true
		}
		if firstOverlap != 0 {
			problems = append(problems, fmt.Errorf("remove[%d]: overlaps an earlier range at line %d", i, firstOverlap))
		}
	}
	foldsValid := true
	for i, f := range in.Fold {
		fold, err := prepareFold(lines, layout, f, i)
		if err != nil {
			problems = append(problems, err)
			foldsValid = false
			continue
		}
		mandatoryLines := 0
		for n := f.StartLine; n <= f.EndLine; n++ {
			if mandatoryHidden[n-1] {
				mandatoryLines++
			}
		}
		if mandatoryLines > 0 {
			if mandatoryLines != f.EndLine-f.StartLine+1 {
				problems = append(problems, fmt.Errorf("fold[%d]: crosses automatically removed import rows and behavioral rows in range %d-%d; fold only the behavioral rows", i, f.StartLine, f.EndLine))
				foldsValid = false
			}
			// An import-only fold is redundant: mandatory removal wins and no
			// ellipsis placeholder is emitted for import scaffolding.
			continue
		}
		conflictLine := 0
		for n := f.StartLine; n <= f.EndLine; n++ {
			if state.hidden[n-1] {
				conflictLine = n
				break
			}
		}
		if conflictLine != 0 {
			kind := "remove"
			if state.folded[conflictLine-1] >= 0 {
				kind = "fold"
			}
			problems = append(problems, fmt.Errorf("fold[%d]: overlaps %s at line %d", i, kind, conflictLine))
			foldsValid = false
			continue
		}
		foldIndex := len(state.folds)
		state.folds = append(state.folds, fold)
		state.foldAt[f.StartLine-1] = foldIndex
		for n := f.StartLine; n <= f.EndLine; n++ {
			state.hidden[n-1] = true
			state.folded[n-1] = foldIndex
		}
	}
	if removalsValid && foldsValid {
		addMandatoryPythonSuitePlaceholders(lines, layout, &state, mandatoryHidden)
		if err := validateMoveSymmetry(moves, state, mandatoryHidden); err != nil {
			problems = append(problems, err)
		}
	}
	pythonValidationState := state
	if removalsValid && foldsValid {
		pythonValidationState = stateWithMandatoryImportsRepresented(state, mandatoryHidden, layout)
		if err := validateHiddenPythonOwners(lines, layout, pythonValidationState); err != nil {
			problems = append(problems, err)
		}
		if err := validateHiddenPythonBoundaries(lines, layout, pythonValidationState); err != nil {
			problems = append(problems, err)
		}
		if err := validateHiddenReferences(lines, layout, pythonValidationState); err != nil {
			problems = append(problems, err)
		}
		if err := validatePythonSuiteSkeleton(lines, layout, pythonValidationState); err != nil {
			problems = append(problems, err)
		}
	}

	replacements := make(map[int][]plannedReplacement)
	replacementsValid := true
	for i, r := range in.Replace {
		if r.Line < 1 || r.Line > len(lines) {
			problems = append(problems, fmt.Errorf("replace[%d]: line %d is outside the diff (1-%d)", i, r.Line, len(lines)))
			continue
		}
		if mandatoryHidden[r.Line-1] {
			// A replacement on compiler-hidden import scaffolding is redundant.
			// Ignore it so older cached/model plans that explicitly abridged an
			// import still merge cleanly with the mandatory plan.
			continue
		}
		if state.hidden[r.Line-1] {
			stateName := "removed"
			if state.folded[r.Line-1] >= 0 {
				stateName = "folded"
			}
			problems = append(problems, fmt.Errorf("replace[%d]: line %d is also %s", i, r.Line, stateName))
			continue
		}
		if r.Old == "" {
			problems = append(problems, fmt.Errorf("replace[%d]: old must not be empty", i))
			continue
		}
		if err := validateSingleLineText("old", r.Old, maxReplacementBytes); err != nil {
			problems = append(problems, fmt.Errorf("replace[%d]: %w", i, err))
			continue
		}
		if err := validateSingleLineText("new", r.New, maxReplacementBytes); err != nil {
			problems = append(problems, fmt.Errorf("replace[%d]: %w", i, err))
			continue
		}
		if r.New == r.Old {
			problems = append(problems, fmt.Errorf("replace[%d]: new must elide some part of old", i))
			continue
		}
		if !isElisionProjection(r.Old, r.New) {
			problems = append(problems, fmt.Errorf("replace[%d]: new must match all of old, with every omitted span represented by ... or …", i))
			continue
		}
		if !isHunkSource(layout.kinds[r.Line-1]) {
			problems = append(problems, fmt.Errorf("replace[%d]: line %d is not a source line inside a diff hunk", i, r.Line))
			continue
		}
		body := lines[r.Line-1].text[1:]
		if layout.python[r.Line-1] && pythonTripleStateBeforeLine(lines, layout, r.Line-1) == pythonTripleNone {
			code := trimPythonCode(body)
			if strings.HasPrefix(code, "@") || isPythonSuiteHeaderStart(code) {
				problems = append(problems, fmt.Errorf("replace[%d]: line %d is a Python decorator or suite header; keep structural anchors intact", i, r.Line))
				continue
			}
		}
		if layout.python[r.Line-1] && changesPythonBoundaryTokens(r.Old, r.New) {
			problems = append(problems, fmt.Errorf("replace[%d]: must preserve Python string and expression boundary tokens", i))
			continue
		}
		start, unique := uniqueSubstringIndex(body, r.Old)
		if !unique {
			problems = append(problems, fmt.Errorf("replace[%d]: old must occur exactly once after the diff marker on line %d", i, r.Line))
			continue
		}
		replacements[r.Line] = append(replacements[r.Line], plannedReplacement{
			lineReplacement: r,
			planIndex:       i,
			start:           start,
			end:             start + len(r.Old),
		})
	}
	for lineNo, edits := range replacements {
		sort.Slice(edits, func(i, j int) bool { return edits[i].start < edits[j].start })
		for i := 1; i < len(edits); i++ {
			if edits[i].start < edits[i-1].end {
				problems = append(problems, fmt.Errorf("replace[%d]: span overlaps replace[%d] on line %d", edits[i].planIndex, edits[i-1].planIndex, lineNo))
				replacementsValid = false
			}
		}
		replacements[lineNo] = edits
	}
	if removalsValid && foldsValid && replacementsValid && len(problems) == 0 {
		if err := validateMoveReplacementSymmetry(moves, lines, state, mandatoryHidden, replacements); err != nil {
			problems = append(problems, err)
		}
	}
	if removalsValid && foldsValid && replacementsValid {
		if err := validateTripleQuoteParity(lines, layout, pythonValidationState, replacements); err != nil {
			problems = append(problems, err)
		}
		if err := validatePythonDelimiterBalance(lines, layout, pythonValidationState, replacements); err != nil {
			problems = append(problems, err)
		}
		if err := validatePythonBackslashContinuations(lines, layout, pythonValidationState, replacements); err != nil {
			problems = append(problems, err)
		}
		completeMandatoryImportFraming(layout, &state, mandatoryHidden)
		if err := validateRetainedStructure(layout, state); err != nil {
			problems = append(problems, err)
		}
	}
	if len(problems) > 0 {
		return compiledPlan{}, joinEditPlanErrors(problems)
	}

	var b strings.Builder
	b.Grow(len(raw))
	for i, line := range lines {
		lineNo := i + 1
		if foldIndex := state.foldAt[i]; foldIndex >= 0 {
			fold := state.folds[foldIndex]
			b.WriteByte(fold.marker)
			b.WriteString(fold.indent)
			b.WriteString("...")
			b.WriteString(fold.eol)
			continue
		}
		if state.hidden[i] {
			continue
		}
		text := line.text
		if edits := replacements[lineNo]; len(edits) > 0 {
			text = text[:1] + applyPlannedReplacements(text[1:], edits)
		}
		b.WriteString(text)
		b.WriteString(line.eol)
	}
	stats := computePlanStats(layout, state)
	return compiledPlan{smartDiff: b.String(), stats: stats, moves: moves}, nil
}

func applyPlannedReplacements(body string, edits []plannedReplacement) string {
	for i := len(edits) - 1; i >= 0; i-- {
		e := edits[i]
		body = body[:e.start] + e.New + body[e.end:]
	}
	return body
}

func prepareFold(lines []sourceLine, layout diffLayout, in lineFold, planIndex int) (plannedFold, error) {
	if in.StartLine < 1 || in.EndLine < 1 || in.StartLine >= in.EndLine {
		return plannedFold{}, fmt.Errorf("fold[%d]: want at least two lines in an inclusive range, got %d-%d", planIndex, in.StartLine, in.EndLine)
	}
	if in.EndLine > len(lines) {
		return plannedFold{}, fmt.Errorf("fold[%d]: line %d is past end of diff (%d lines)", planIndex, in.EndLine, len(lines))
	}

	marker := byte(0)
	indent := ""
	haveIndent := false
	for n := in.StartLine; n <= in.EndLine; n++ {
		index := n - 1
		if !isHunkSource(layout.kinds[index]) || len(lines[index].text) == 0 {
			return plannedFold{}, fmt.Errorf("fold[%d]: line %d is not source inside one diff hunk", planIndex, n)
		}
		lineMarker := lines[index].text[0]
		if marker == 0 {
			marker = lineMarker
		} else if marker != lineMarker {
			return plannedFold{}, fmt.Errorf("fold[%d]: mixed diff markers %q and %q in range %d-%d", planIndex, marker, lineMarker, in.StartLine, in.EndLine)
		}
		body := lines[index].text[1:]
		trimmedBody := strings.TrimSpace(body)
		pythonCodeLine := layout.python[index] && pythonTripleStateBeforeLine(lines, layout, index) == pythonTripleNone
		if pythonCodeLine && lineMarker != '-' && (strings.HasPrefix(trimmedBody, "@") || isPythonSuiteHeaderStart(trimmedBody)) {
			return plannedFold{}, fmt.Errorf("fold[%d]: line %d is a Python decorator or suite owner; keep the anchor and fold only its indented interior", planIndex, n)
		}
		if trimmedBody == "" {
			continue
		}
		lineIndent := leadingWhitespace(body)
		if !haveIndent {
			indent = lineIndent
			haveIndent = true
		} else {
			indent = commonPrefix(indent, lineIndent)
		}
	}
	if !haveIndent {
		return plannedFold{}, fmt.Errorf("fold[%d]: range %d-%d contains only blank source lines", planIndex, in.StartLine, in.EndLine)
	}
	return plannedFold{
		lineFold:  in,
		planIndex: planIndex,
		marker:    marker,
		indent:    indent,
		eol:       lines[in.EndLine-1].eol,
	}, nil
}

func isIdentifierStart(b byte) bool {
	return b == '_' || b >= 'A' && b <= 'Z' || b >= 'a' && b <= 'z'
}

func isIdentifierContinue(b byte) bool {
	return isIdentifierStart(b) || b >= '0' && b <= '9'
}

func leadingWhitespace(s string) string {
	for i, r := range s {
		if r != ' ' && r != '\t' {
			return s[:i]
		}
	}
	return s
}

func commonPrefix(a, b string) string {
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	i := 0
	for i < n && a[i] == b[i] {
		i++
	}
	return a[:i]
}

func computePlanStats(layout diffLayout, state planState) planStats {
	var stats planStats
	for i, kind := range layout.kinds {
		switch kind {
		case diffLineHeader:
			stats.rawFiles++
			if state.represented(i) {
				stats.visibleFiles++
			}
		case diffLineHunkChange:
			stats.rawChanged++
			switch {
			case state.folded[i] >= 0:
				stats.foldedChanged++
			case state.hidden[i]:
				stats.removedChanged++
			default:
				stats.visibleChanged++
			}
		}
	}
	stats.foldCount = len(state.folds)
	for _, fold := range state.folds {
		if fold.marker == '+' || fold.marker == '-' {
			stats.visibleChanged++
		}
	}
	return stats
}

func joinEditPlanErrors(problems []error) error {
	if len(problems) == 1 {
		return problems[0]
	}
	var b strings.Builder
	for _, err := range problems {
		fmt.Fprintf(&b, "\n- %v", err)
	}
	return fmt.Errorf("edit plan has %d errors:%s", len(problems), b.String())
}

func uniqueSubstringIndex(text, sub string) (int, bool) {
	first := strings.Index(text, sub)
	if first < 0 {
		return 0, false
	}
	// Search one byte after the first start, rather than after its end, so
	// overlapping matches ("aa" in "aaa") are also considered ambiguous.
	if strings.Index(text[first+1:], sub) >= 0 {
		return 0, false
	}
	return first, true
}

func isElisionProjection(old, new string) bool {
	return matchesElisionProjection(old, new, true)
}

// isComposedElisionProjection recognizes the result after multiple individually
// validated replacements were applied to one line. Adjacent placeholders (or a
// placeholder next to source dots) may form a run longer than three dots.
func isComposedElisionProjection(old, new string) bool {
	return matchesElisionProjection(old, new, false)
}

func matchesElisionProjection(old, new string, strict bool) bool {
	re, ok := compileElisionProjection(new, strict)
	return ok && re.MatchString(old)
}

func compileElisionProjection(new string, strict bool) (*regexp.Regexp, bool) {
	newRunes := []rune(new)
	var pattern strings.Builder
	pattern.WriteByte('^')
	var literal strings.Builder
	wildcards := 0
	lastWasWildcard := false
	flushLiteral := func() {
		if literal.Len() == 0 {
			return
		}
		pattern.WriteString(regexp.QuoteMeta(literal.String()))
		literal.Reset()
	}

	for i := 0; i < len(newRunes); {
		wildcard := false
		switch {
		case newRunes[i] == '…':
			wildcard = true
			i++
		case newRunes[i] == '.':
			j := i
			for j < len(newRunes) && newRunes[j] == '.' {
				j++
			}
			run := j - i
			if run >= 3 {
				if strict && run != 3 {
					return nil, false
				}
				wildcard = true
				i = j
			}
		}
		if wildcard {
			if lastWasWildcard {
				if strict {
					return nil, false
				}
				continue
			}
			flushLiteral()
			// Every visible ellipsis must stand for at least one omitted
			// character. This prevents silent changes such as !allowed → allowed.
			pattern.WriteString(".+")
			wildcards++
			lastWasWildcard = true
			continue
		}
		literal.WriteRune(newRunes[i])
		lastWasWildcard = false
		i++
	}
	flushLiteral()
	pattern.WriteByte('$')
	if wildcards == 0 {
		return nil, false
	}
	re, err := regexp.Compile(pattern.String())
	return re, err == nil
}

func validateSummary(summary string) error {
	if strings.TrimSpace(summary) == "" {
		return fmt.Errorf("summary must not be empty")
	}
	if len(summary) > maxSummaryBytes {
		return fmt.Errorf("summary is %d bytes, over the %d-byte limit", len(summary), maxSummaryBytes)
	}
	if err := validateSingleLineText("summary", summary, maxSummaryBytes); err != nil {
		return err
	}
	return nil
}

func validateSingleLineText(name, text string, maxBytes int) error {
	if len(text) > maxBytes {
		return fmt.Errorf("%s is %d bytes, over the %d-byte limit", name, len(text), maxBytes)
	}
	if !utf8.ValidString(text) {
		return fmt.Errorf("%s is not valid UTF-8", name)
	}
	for _, r := range text {
		switch r {
		case '\n', '\r', 0, '\x1b', '\u2028', '\u2029':
			return fmt.Errorf("%s must be a single printable line", name)
		}
		if unicode.IsControl(r) && r != '\t' {
			return fmt.Errorf("%s contains a control character", name)
		}
	}
	return nil
}

// validateRetainedStructure prevents a plan from deleting the metadata that
// identifies retained source. A complete file or hunk may disappear, but a
// surviving line keeps its enclosing diff/file/hunk headers.
func validateRetainedStructure(layout diffLayout, state planState) error {
	var problems []error
	for i, kind := range layout.kinds {
		if kind == diffLineNoNewline && state.represented(i) {
			owner := layout.markerOwner[i]
			if owner < 0 || !state.represented(owner) {
				problems = append(problems, fmt.Errorf("remove: no-newline marker on line %d requires its source line", i+1))
			}
		}

		switch kind {
		case diffLineHeader:
			end := nextLayoutLine(layout, i+1, func(k diffLineKind) bool {
				return k == diffLineHeader || k == diffLineMailSignature
			})
			bodyRetained := anyRetainedMeaningful(layout, state, i+1, end)
			headerRetained := state.represented(i)
			if !bodyRetained && anyRetained(state, i+1, end) {
				problems = append(problems, fmt.Errorf("remove: file beginning on line %d retains only metadata; remove the complete file section", i+1))
			}
			if headerRetained != bodyRetained {
				problems = append(problems, fmt.Errorf("remove: diff header on line %d must be retained exactly when its file body is retained", i+1))
			}
		case diffLineOldFile:
			end := nextLayoutLine(layout, i+2, func(k diffLineKind) bool {
				return k == diffLineHeader || k == diffLineOldFile || k == diffLineMailSignature
			})
			if state.represented(i) != state.represented(i+1) {
				problems = append(problems, fmt.Errorf("remove: ---/+++ headers on lines %d-%d must be removed or retained together", i+1, i+2))
			}
			bodyRetained := anyRetainedMeaningful(layout, state, i+2, end)
			headersRetained := state.represented(i)
			if headersRetained != bodyRetained {
				problems = append(problems, fmt.Errorf("remove: ---/+++ headers on lines %d-%d must be retained exactly when their file body is retained", i+1, i+2))
			}
		case diffLineRenameFrom:
			if i+1 >= len(layout.kinds) || layout.kinds[i+1] != diffLineRenameTo {
				problems = append(problems, fmt.Errorf("rename from metadata on line %d has no matching rename to line", i+1))
			} else if state.represented(i) != state.represented(i+1) {
				problems = append(problems, fmt.Errorf("remove: rename metadata on lines %d-%d must be removed or retained together", i+1, i+2))
			}
		case diffLineCopyFrom:
			if i+1 >= len(layout.kinds) || layout.kinds[i+1] != diffLineCopyTo {
				problems = append(problems, fmt.Errorf("copy from metadata on line %d has no matching copy to line", i+1))
			} else if state.represented(i) != state.represented(i+1) {
				problems = append(problems, fmt.Errorf("remove: copy metadata on lines %d-%d must be removed or retained together", i+1, i+2))
			}
		case diffLineHunkHeader:
			end := nextLayoutLine(layout, i+1, func(k diffLineKind) bool {
				return k == diffLineHeader || k == diffLineOldFile || k == diffLineHunkHeader || k == diffLineMailSignature
			})
			headerRetained := state.represented(i)
			if anyRetainedHunkSource(layout, state, i+1, end) && !headerRetained {
				problems = append(problems, fmt.Errorf("remove: retained context/change lines require hunk header on line %d", i+1))
			}
			changeRetained := anyRetainedHunkChange(layout, state, i+1, end)
			if headerRetained != changeRetained {
				problems = append(problems, fmt.Errorf("remove: hunk header on line %d must be retained exactly when its hunk has a retained change", i+1))
			}
		}
	}
	if len(problems) > 0 {
		return joinEditPlanErrors(problems)
	}
	return nil
}

func anyRetainedMeaningful(layout diffLayout, state planState, start, end int) bool {
	for i := start; i < end; i++ {
		if state.represented(i) && layout.kinds[i] != diffLineNoNewline && layout.kinds[i] != diffLineIndex {
			return true
		}
	}
	return false
}

func anyRetained(state planState, start, end int) bool {
	for i := start; i < end; i++ {
		if state.represented(i) {
			return true
		}
	}
	return false
}

func anyRetainedHunkSource(layout diffLayout, state planState, start, end int) bool {
	for i := start; i < end; i++ {
		if state.represented(i) && isHunkSource(layout.kinds[i]) {
			return true
		}
	}
	return false
}

func anyRetainedHunkChange(layout diffLayout, state planState, start, end int) bool {
	for i := start; i < end; i++ {
		if state.represented(i) && layout.kinds[i] == diffLineHunkChange {
			return true
		}
	}
	return false
}
