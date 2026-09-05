package meat

import (
	"fmt"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	minMoveSubstantiveRows = 3
	minMoveNonspaceBytes   = 48
	maxMoveHints           = 12
)

// detectedMove is an exact source-evidenced relocation between change runs in
// different hunks. Coordinates are inclusive physical lines in the immutable
// input diff.
type detectedMove struct {
	Removed lineRange
	Added   lineRange
}

type moveRun struct {
	start  int // zero-based, inclusive
	end    int // zero-based, inclusive
	hunkID int
}

type moveLineInfo struct {
	normalized  string
	indent      int
	substantive bool
}

type moveOccurrence struct {
	index  int
	marker byte
}

type moveAnchor struct {
	removed int
	added   int
}

type moveAlignment struct {
	removedRun int
	addedRun   int
	delta      int
}

// detectExactMoves conservatively pairs exact changed runs across hunks. A
// globally unique substantive line anchors each candidate; extension requires
// byte-exact bodies after leading/trailing indentation normalization and one
// constant indentation offset for every nonblank row. Small or overlapping
// candidates are discarded rather than guessed.
func detectExactMoves(lines []sourceLine, layout diffLayout) []detectedMove {
	if len(lines) == 0 || len(layout.kinds) != len(lines) {
		return nil
	}

	infos := make([]moveLineInfo, len(lines))
	occurrences := make(map[string][]moveOccurrence)
	for i, line := range lines {
		if !isHunkSource(layout.kinds[i]) || len(line.text) < 1 {
			continue
		}
		info := normalizeMoveLine(line.text[1:])
		infos[i] = info
		if info.substantive {
			occurrences[info.normalized] = append(occurrences[info.normalized], moveOccurrence{index: i, marker: line.text[0]})
		}
	}

	var runs []moveRun
	runAt := make([]int, len(lines))
	for i := range runAt {
		runAt[i] = -1
	}
	for i := 0; i < len(lines); {
		if layout.kinds[i] != diffLineHunkChange || len(lines[i].text) == 0 || lines[i].text[0] != '-' && lines[i].text[0] != '+' {
			i++
			continue
		}
		marker := lines[i].text[0]
		hunkID := layout.hunkID[i]
		start := i
		for i+1 < len(lines) && layout.kinds[i+1] == diffLineHunkChange && len(lines[i+1].text) > 0 && lines[i+1].text[0] == marker && layout.hunkID[i+1] == hunkID {
			i++
		}
		runIndex := len(runs)
		runs = append(runs, moveRun{start: start, end: i, hunkID: hunkID})
		for j := start; j <= i; j++ {
			runAt[j] = runIndex
		}
		i++
	}

	var anchors []moveAnchor
	for _, found := range occurrences {
		if len(found) != 2 {
			continue
		}
		anchor := moveAnchor{removed: -1, added: -1}
		for _, occurrence := range found {
			switch occurrence.marker {
			case '-':
				anchor.removed = occurrence.index
			case '+':
				anchor.added = occurrence.index
			}
		}
		if anchor.removed >= 0 && anchor.added >= 0 {
			anchors = append(anchors, anchor)
		}
	}
	sort.Slice(anchors, func(i, j int) bool {
		if anchors[i].removed != anchors[j].removed {
			return anchors[i].removed < anchors[j].removed
		}
		return anchors[i].added < anchors[j].added
	})

	candidateSet := make(map[detectedMove]struct{})
	lastSegment := make(map[moveAlignment]detectedMove)
	for _, anchor := range anchors {
		removed, added := anchor.removed, anchor.added
		if runAt[removed] < 0 || runAt[added] < 0 {
			continue
		}
		removedRunIndex := runAt[removed]
		addedRunIndex := runAt[added]
		removedRun := runs[removedRunIndex]
		addedRun := runs[addedRunIndex]
		if removedRun.hunkID < 0 || removedRun.hunkID == addedRun.hunkID {
			continue
		}
		alignment := moveAlignment{removedRun: removedRunIndex, addedRun: addedRunIndex, delta: removed - added}
		if previous, ok := lastSegment[alignment]; ok &&
			removed+1 >= previous.Removed.StartLine && removed+1 <= previous.Removed.EndLine &&
			added+1 >= previous.Added.StartLine && added+1 <= previous.Added.EndLine {
			continue
		}

		indentOffset := infos[added].indent - infos[removed].indent
		removedStart, removedEnd := removed, removed
		addedStart, addedEnd := added, added
		for removedStart > removedRun.start && addedStart > addedRun.start && moveRowsMatch(infos[removedStart-1], infos[addedStart-1], indentOffset) {
			removedStart--
			addedStart--
		}
		for removedEnd < removedRun.end && addedEnd < addedRun.end && moveRowsMatch(infos[removedEnd+1], infos[addedEnd+1], indentOffset) {
			removedEnd++
			addedEnd++
		}

		candidate := detectedMove{
			Removed: lineRange{StartLine: removedStart + 1, EndLine: removedEnd + 1},
			Added:   lineRange{StartLine: addedStart + 1, EndLine: addedEnd + 1},
		}
		lastSegment[alignment] = candidate
		if substantialMove(infos, removedStart, removedEnd) {
			candidateSet[candidate] = struct{}{}
		}
	}

	candidates := make([]detectedMove, 0, len(candidateSet))
	for candidate := range candidateSet {
		candidates = append(candidates, candidate)
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].Removed.StartLine != candidates[j].Removed.StartLine {
			return candidates[i].Removed.StartLine < candidates[j].Removed.StartLine
		}
		if candidates[i].Added.StartLine != candidates[j].Added.StartLine {
			return candidates[i].Added.StartLine < candidates[j].Added.StartLine
		}
		return candidates[i].Removed.EndLine < candidates[j].Removed.EndLine
	})

	ambiguous := make([]bool, len(candidates))
	for i := range candidates {
		for j := i + 1; j < len(candidates); j++ {
			if rangesOverlap(candidates[i].Removed, candidates[j].Removed) || rangesOverlap(candidates[i].Added, candidates[j].Added) {
				ambiguous[i] = true
				ambiguous[j] = true
			}
		}
	}
	moves := make([]detectedMove, 0, len(candidates))
	for i, candidate := range candidates {
		if !ambiguous[i] {
			moves = append(moves, candidate)
		}
	}
	return moves
}

func normalizeMoveLine(body string) moveLineInfo {
	body = strings.TrimRight(body, " \t")
	indentText := leadingWhitespace(body)
	normalized := body[len(indentText):]
	substantive := false
	for _, r := range normalized {
		if unicode.IsLetter(r) || unicode.IsNumber(r) {
			substantive = true
			break
		}
	}
	return moveLineInfo{
		normalized:  normalized,
		indent:      indentationColumns(indentText),
		substantive: substantive,
	}
}

func indentationColumns(indent string) int {
	columns := 0
	for _, r := range indent {
		if r == '\t' {
			columns += 8 - columns%8
		} else {
			columns++
		}
	}
	return columns
}

func moveRowsMatch(removed, added moveLineInfo, indentOffset int) bool {
	if removed.normalized != added.normalized {
		return false
	}
	if removed.normalized == "" {
		return true
	}
	return added.indent-removed.indent == indentOffset
}

func substantialMove(infos []moveLineInfo, start, end int) bool {
	substantiveRows := 0
	nonspaceBytes := 0
	for i := start; i <= end; i++ {
		if infos[i].substantive {
			substantiveRows++
		}
		for _, r := range infos[i].normalized {
			if !unicode.IsSpace(r) {
				nonspaceBytes += utf8.RuneLen(r)
			}
		}
	}
	return substantiveRows >= minMoveSubstantiveRows && nonspaceBytes >= minMoveNonspaceBytes
}

func rangesOverlap(a, b lineRange) bool {
	return a.StartLine <= b.EndLine && b.StartLine <= a.EndLine
}

// applyMandatoryMovePrecedence gives compiler-mandatory import hiding priority
// over model move enforcement. Exact aligned counterparts of a mandatory row
// become compiler-owned too: this keeps imports hidden when file extensions
// classify the two sides differently and leaves symmetry validation to judge
// only model-authored compression of the remaining behavioral rows.
func applyMandatoryMovePrecedence(moves []detectedMove, mandatory []bool) {
	for _, move := range moves {
		rows := move.Removed.EndLine - move.Removed.StartLine + 1
		for offset := 0; offset < rows; offset++ {
			removed := move.Removed.StartLine + offset - 1
			added := move.Added.StartLine + offset - 1
			if removed < 0 || removed >= len(mandatory) || added < 0 || added >= len(mandatory) {
				continue
			}
			if mandatory[removed] || mandatory[added] {
				mandatory[removed] = true
				mandatory[added] = true
			}
		}
	}
}

type moveCompression uint8

const (
	moveKept moveCompression = iota
	moveRemoved
	moveFoldStart
	moveFoldMiddle
	moveFoldEnd
)

func compressionAt(state planState, mandatory []bool, line int) moveCompression {
	index := line - 1
	// A compiler-owned suite placeholder may represent a mandatory import row,
	// but it is not model-authored folding. Canonicalize every mandatory row as
	// removed before comparing move treatment.
	if index >= 0 && index < len(mandatory) && mandatory[index] {
		return moveRemoved
	}
	if !state.hidden[index] {
		return moveKept
	}
	foldIndex := state.folded[index]
	if foldIndex < 0 {
		return moveRemoved
	}
	fold := state.folds[foldIndex]
	switch line {
	case fold.StartLine:
		return moveFoldStart
	case fold.EndLine:
		return moveFoldEnd
	default:
		return moveFoldMiddle
	}
}

type moveCompressionKind uint8

const (
	moveKindKept moveCompressionKind = iota
	moveKindRemoved
	moveKindFolded
)

func (c moveCompression) kind() moveCompressionKind {
	switch c {
	case moveKept:
		return moveKindKept
	case moveRemoved:
		return moveKindRemoved
	default:
		return moveKindFolded
	}
}

func (k moveCompressionKind) String() string {
	switch k {
	case moveKindKept:
		return "kept"
	case moveKindRemoved:
		return "removed"
	default:
		return "folded"
	}
}

// validateMoveSymmetry requires every aligned behavioral move row to receive
// the same model-authored keep/remove/fold treatment, including matching fold
// boundaries. Compiler-mandatory rows have already won precedence and compare
// as removed even when a compiler-owned Python placeholder represents one.
func validateMoveSymmetry(moves []detectedMove, state planState, mandatory []bool) error {
	var problems []error
	for _, move := range moves {
		rows := move.Removed.EndLine - move.Removed.StartLine + 1
		for offset := 0; offset < rows; {
			removedCompression := compressionAt(state, mandatory, move.Removed.StartLine+offset)
			addedCompression := compressionAt(state, mandatory, move.Added.StartLine+offset)
			if removedCompression == addedCompression {
				offset++
				continue
			}

			start := offset
			removedKind := removedCompression.kind()
			addedKind := addedCompression.kind()
			for offset+1 < rows {
				nextRemoved := compressionAt(state, mandatory, move.Removed.StartLine+offset+1)
				nextAdded := compressionAt(state, mandatory, move.Added.StartLine+offset+1)
				if nextRemoved == nextAdded || nextRemoved.kind() != removedKind || nextAdded.kind() != addedKind {
					break
				}
				offset++
			}
			end := offset

			removedMismatch := lineRange{StartLine: move.Removed.StartLine + start, EndLine: move.Removed.StartLine + end}
			addedMismatch := lineRange{StartLine: move.Added.StartLine + start, EndLine: move.Added.StartLine + end}
			detail := fmt.Sprintf("removed %s %s %s while added %s %s %s", formatLineRange(removedMismatch), lineRangeVerb(removedMismatch), removedKind, formatLineRange(addedMismatch), lineRangeVerb(addedMismatch), addedKind)
			if removedKind == moveKindFolded && addedKind == moveKindFolded {
				detail = fmt.Sprintf("removed %s and added %s are folded with different boundaries", formatLineRange(removedMismatch), formatLineRange(addedMismatch))
			}
			problems = append(problems, fmt.Errorf(
				"move symmetry: removed lines %d-%d match added lines %d-%d after indentation normalization; %s. Keep, remove, or fold corresponding move rows identically, including fold boundaries",
				move.Removed.StartLine, move.Removed.EndLine, move.Added.StartLine, move.Added.EndLine, detail,
			))
			offset++
		}
	}
	if len(problems) > 0 {
		return joinEditPlanErrors(problems)
	}
	return nil
}

func validateMoveReplacementSymmetry(moves []detectedMove, lines []sourceLine, state planState, mandatory []bool, replacements map[int][]plannedReplacement) error {
	var problems []error
	for _, move := range moves {
		rows := move.Removed.EndLine - move.Removed.StartLine + 1
		for offset := 0; offset < rows; offset++ {
			removedLine := move.Removed.StartLine + offset
			addedLine := move.Added.StartLine + offset

			// Keep/remove/fold symmetry is validated separately. Local replacements
			// can only target represented rows, so compare them when both aligned
			// rows remain verbatim source lines.
			if compressionAt(state, mandatory, removedLine) != moveKept ||
				compressionAt(state, mandatory, addedLine) != moveKept {
				continue
			}
			removedEdits := replacements[removedLine]
			addedEdits := replacements[addedLine]
			if len(removedEdits) == 0 && len(addedEdits) == 0 {
				continue
			}

			removedBody := lines[removedLine-1].text[1:]
			addedBody := lines[addedLine-1].text[1:]
			if len(removedEdits) > 0 {
				removedBody = applyPlannedReplacements(removedBody, removedEdits)
			}
			if len(addedEdits) > 0 {
				addedBody = applyPlannedReplacements(addedBody, addedEdits)
			}
			if normalizeMoveLine(removedBody).normalized == normalizeMoveLine(addedBody).normalized {
				continue
			}

			problems = append(problems, fmt.Errorf(
				"move symmetry: removed lines %d-%d match added lines %d-%d after indentation normalization; corresponding kept lines %d and %d have different model-authored local elisions. Apply equivalent replacements to both sides or keep both lines verbatim",
				move.Removed.StartLine, move.Removed.EndLine, move.Added.StartLine, move.Added.EndLine, removedLine, addedLine,
			))
		}
	}
	if len(problems) > 0 {
		return joinEditPlanErrors(problems)
	}
	return nil
}

func detectedMovesInDiff(raw string) []detectedMove {
	lines := splitSourceLines(raw)
	layout := analyzeDiff(lines)
	if len(layout.problems) > 0 {
		return nil
	}
	return detectExactMoves(lines, layout)
}

func formatLineRange(r lineRange) string {
	if r.StartLine == r.EndLine {
		return fmt.Sprintf("line %d", r.StartLine)
	}
	return fmt.Sprintf("lines %d-%d", r.StartLine, r.EndLine)
}

func lineRangeVerb(r lineRange) string {
	if r.StartLine == r.EndLine {
		return "is"
	}
	return "are"
}

func formatMovePairs(moves []detectedMove, limit int) string {
	if len(moves) == 0 || limit <= 0 {
		return ""
	}
	shown := len(moves)
	if shown > limit {
		shown = limit
	}
	parts := make([]string, 0, shown+1)
	for _, move := range moves[:shown] {
		parts = append(parts, fmt.Sprintf("-%d..%d ↔ +%d..%d", move.Removed.StartLine, move.Removed.EndLine, move.Added.StartLine, move.Added.EndLine))
	}
	if shown < len(moves) {
		parts = append(parts, fmt.Sprintf("and %d more", len(moves)-shown))
	}
	return strings.Join(parts, ", ")
}
