// chunk.go splits an oversized unified diff into independently abridgeable
// chunks and merges the per-chunk reading diffs back into one result.
//
// A single agent run re-sends the whole numbered diff every turn, so its size
// is bounded by maxDiffBytes. A larger diff is split at structural boundaries
// — between file sections when possible, between hunks of one oversized file
// otherwise, and between synthesized sub-hunks of one oversized hunk as a
// last resort — into chunks that each fit the single-run budget. Every chunk
// is a well-formed unified diff: a chunk that continues a split file section
// replicates its file-metadata block, and a chunk that begins mid-hunk gets a
// synthesized @@ header whose counts match exactly the lines it carries.
//
// Each chunk is abridged by its own agent run with the same rubric and its
// own 1-based numbering; nothing on the model-visible prompt surface changes.
// Whole-diff analyses that a fragment cannot reproduce are pre-resolved by
// the splitter and mirrored into each chunk: the mandatory import mask
// (including move-precedence extension and Python suite placeholders) is
// applied to segment bodies up front, string interiors and no-newline
// markers are never cut, and per-chunk agent runs skip move detection
// entirely — fragment-local occurrence counts would invent moves the whole
// diff rejects as ambiguous, so the splitter maps the whole-diff moves whose
// sides share a chunk into that chunk's coordinates for enforcement. The
// remaining cost of chunking is judgment locality: the model reasons over
// one chunk at a time; cross-chunk Python reference validation is per-chunk
// only; a move or Python suite whose parts land in different chunks cannot
// be enforced or kept atomic beyond the owner's first body row. Splitting
// prefers file boundaries, then hunk boundaries, to keep those costs rare.

package meat

import (
	"context"
	"fmt"
	"strconv"
	"strings"
)

// maxTotalDiffBytes bounds the raw diff accepted for chunked abridging.
// Chunking makes huge diffs feasible, not free: each chunk is a full agent
// run, so cost and wall clock grow linearly with size. Past this cap a
// change should be reviewed in narrower pieces anyway.
const maxTotalDiffBytes = 4 << 20

// maxChunks bounds how many chunks one diff may split into. A diff under
// maxTotalDiffBytes needs roughly maxTotalDiffBytes/maxDiffBytes chunks plus
// splitting overhead; far more than that means pathological amplification
// (e.g. an enormous replicated metadata block leaving almost no body budget
// per piece), where memory and per-chunk agent runs would grow without
// useful output.
const maxChunks = 32

// diffChunk is one independently abridgeable slice of the original diff.
type diffChunk struct {
	// text is a well-formed unified diff for this slice.
	text string
	// metaPrefix is the file-metadata block (diff --git/index/---/+++ etc.)
	// at the start of the chunk, set for every piece of a split file section.
	// Empty for chunks made of whole sections.
	metaPrefix string
	// sectionID identifies the split file section the chunk belongs to, or -1
	// for a chunk made of whole sections. Pieces of the same section share an
	// ID so the merge step can dedupe their replicated metadata.
	sectionID int
	// continuation marks a chunk that begins mid-file-section: its metaPrefix
	// duplicates metadata already carried by the previous piece, and the merge
	// step drops the duplicate once the file has surfaced in the output.
	continuation bool
	// passthrough marks a chunk with no hunk content (a format-patch trailer
	// or preamble stranded by an import-only section). It is copied verbatim
	// into the merged reading diff without an agent run; whole-diff
	// compilation retains such envelope lines too.
	passthrough bool
	// origins maps each physical line of text (0-based) to its 0-based line
	// index in the original diff, or -1 for synthesized lines (segment @@
	// headers, placeholder rows). abridgeChunked uses it to translate
	// whole-diff move coordinates into chunk coordinates.
	origins []int
}

// numberedLen is the exact size of numberedDiff output for count lines whose
// texts total textLen bytes: each line gains a width-padded number, a '|',
// and a trailing newline.
func numberedLen(textLen, count int) int {
	if count == 0 {
		return 0
	}
	width := len(strconv.Itoa(count))
	return textLen + count*(width+2)
}

// fitsSingleRun reports whether raw and its numbered form both fit within
// budget, i.e. whether one agent run can take the whole diff.
func fitsSingleRun(raw string, budget int) bool {
	if len(raw) > budget {
		return false
	}
	lines := splitSourceLines(raw)
	textLen := 0
	for _, l := range lines {
		textLen += len(l.text)
	}
	return numberedLen(textLen, len(lines)) <= budget
}

// lineSpan is a half-open range [start, end) of physical line indices.
type lineSpan struct {
	start, end int
}

type chunkBuilder struct {
	lines  []sourceLine
	layout diffLayout
	budget int
	// prefixText[i] / prefixRaw[i] are byte totals of lines[:i] without/with
	// line endings, so any span's single-run size is O(1) to check.
	prefixText []int
	prefixRaw  []int
	// hidden marks lines the whole-diff mandatory pass removes: the import
	// pass plus move-precedence extension (an exact move pairing an import
	// row hides both sides). splitHunk drops them from segment bodies: a
	// segment's own compiler could not classify a severed block or see a
	// cross-chunk move counterpart, and dropped rows could never appear in a
	// result anyway.
	hidden []bool
	// extraHidden marks the subset of hidden that a chunk-local compiler
	// would NOT re-derive (rows hidden only through a move whose counterpart
	// may land in another chunk). Sections and hunks containing such rows are
	// never copied verbatim; they go through row-dropping segmentation.
	extraHidden []bool
	// foldAt/folds carry the whole-diff mandatory Python suite placeholders:
	// a hidden import row whose removal would leave a visible suite owner
	// with no body is emitted as its fixed `...` placeholder row rather than
	// dropped, matching whole-diff rendering.
	foldAt []int
	folds  []plannedFold
	// inString marks lines whose lexical position (on either diff side) is
	// inside a multiline continuation — a Go/JS backtick string, a
	// Python/Java triple-quoted string, an open Python bracket expression, or
	// a Python backslash continuation. Mid-hunk cuts never land on such a
	// line: a segment starting there would make the chunk-local compiler
	// misread delimiters (a closing quote as an opener) or lose the
	// continuation relationship its validators enforce.
	inString []bool
	chunks   []diffChunk
}

// splitDiffForAbridging cuts raw into chunks that each fit budget both as raw
// text and in numbered form. raw must already have passed
// validateSupportedDiff; every returned chunk passes it too.
func splitDiffForAbridging(raw string, budget int) ([]diffChunk, error) {
	lines := splitSourceLines(raw)
	layout := analyzeDiff(lines)
	if len(layout.problems) > 0 {
		return nil, joinEditPlanErrors(layout.problems)
	}
	b := &chunkBuilder{
		lines:      lines,
		layout:     layout,
		budget:     budget,
		prefixText: make([]int, len(lines)+1),
		prefixRaw:  make([]int, len(lines)+1),
		inString:   stringInteriorMask(lines, layout),
	}
	// The whole-diff mandatory mask: the import pass plus move-precedence
	// extension. extraHidden isolates rows a chunk-local compiler could not
	// re-derive (hidden only through a move whose counterpart may land in
	// another chunk); sections containing them are never copied verbatim.
	importMask := mandatoryRemovalMask(len(lines), mandatoryImportRemovalPlan(lines, layout))
	b.hidden = append([]bool(nil), importMask...)
	applyMandatoryMovePrecedence(detectExactMoves(lines, layout), b.hidden)
	b.extraHidden = make([]bool, len(lines))
	for i := range b.hidden {
		b.extraHidden[i] = b.hidden[i] && !importMask[i]
	}
	// The whole-diff mandatory Python suite placeholders, so a dropped import
	// row that props up a visible suite owner is emitted as its fixed `...`
	// row exactly as whole-diff rendering would.
	placeholderState := newPlanState(len(lines))
	copy(placeholderState.hidden, b.hidden)
	addMandatoryPythonSuitePlaceholders(lines, layout, &placeholderState, b.hidden)
	b.foldAt = placeholderState.foldAt
	b.folds = placeholderState.folds
	for i, l := range lines {
		b.prefixText[i+1] = b.prefixText[i] + len(l.text)
		b.prefixRaw[i+1] = b.prefixRaw[i] + len(l.text) + len(l.eol)
	}

	sections := b.sections()
	if len(sections) == 0 {
		return nil, fmt.Errorf("diff is %dKB with no file sections to split into abridgeable chunks — try a narrower range", len(raw)>>10)
	}

	open := -1 // start line of the accumulating whole-section chunk
	openEnd := 0
	flush := func() error {
		if open >= 0 {
			if err := b.add(diffChunk{text: b.rangeText(open, openEnd), sectionID: -1, origins: b.rangeOrigins(open, openEnd)}); err != nil {
				return err
			}
			open = -1
		}
		return nil
	}
	for id, s := range sections {
		if b.spanFullyHidden(s) {
			// The whole-diff compiler removes this section entirely (an
			// import-only file shell); no chunk or model run is needed.
			if err := flush(); err != nil {
				return nil, err
			}
			continue
		}
		if b.spanHasExtraHidden(s) {
			// Rows only a whole-diff pass hides (cross-file move counterparts)
			// must be dropped from the chunk text; splitSection's segmenting
			// path owns that, so such a section is never packed verbatim.
			if err := flush(); err != nil {
				return nil, err
			}
			if err := b.splitSection(id, s); err != nil {
				return nil, err
			}
			continue
		}
		if open >= 0 && b.spanFits(open, s.end) {
			openEnd = s.end
			continue
		}
		if err := flush(); err != nil {
			return nil, err
		}
		if b.spanFits(s.start, s.end) {
			open, openEnd = s.start, s.end
			continue
		}
		if err := b.splitSection(id, s); err != nil {
			return nil, err
		}
	}
	if err := flush(); err != nil {
		return nil, err
	}
	return b.chunks, nil
}

// add appends a chunk, refusing pathological amplification (e.g. an enormous
// replicated metadata block leaving almost no body budget per piece) before
// the full expansion is allocated.
func (b *chunkBuilder) add(c diffChunk) error {
	if len(b.chunks) >= maxChunks {
		return fmt.Errorf("diff splits into more than %d chunks — try a narrower range (a single commit, or per-file with `git diff -- <path> | meat`)", maxChunks)
	}
	b.chunks = append(b.chunks, c)
	return nil
}

// stringInteriorMask marks hunk-body lines that begin while EITHER diff
// side's lexical position is inside a multiline string literal — a Go/JS
// backtick string or a Python/Java triple-quoted string. Both side scanners
// advance in physical line order (a context row feeds both), so an
// interleaved +/- row between one side's opener and interior is marked too.
// The per-side transitions match embeddedSourceLines, which the chunk-local
// import pass uses, so the splitter and each chunk's compiler agree about
// what is embedded source.
func stringInteriorMask(lines []sourceLine, layout diffLayout) []bool {
	mask := make([]bool, len(lines))
	var old, new stringScanState
	language := sourceLanguageUnknown
	for i, kind := range layout.kinds {
		if kind == diffLineHunkHeader {
			language = layout.language[i]
			old, new = stringScanState{}, stringScanState{}
			continue
		}
		if language == sourceLanguageUnknown || !isHunkSource(kind) || len(lines[i].text) == 0 {
			continue
		}
		mask[i] = old.inString() || new.inString()
		body := lines[i].text[1:]
		switch lines[i].text[0] {
		case '-':
			old.scan(body, language)
		case '+':
			new.scan(body, language)
		case ' ':
			old.scan(body, language)
			new.scan(body, language)
		}
	}
	return mask
}

// stringScanState tracks one diff side's multiline continuation position:
// string transitions match embeddedSourceLines, bracket depth and backslash
// continuations match the Python delimiter/continuation validators.
type stringScanState struct {
	triple    pythonTripleState
	backtick  bool
	brackets  pythonDelimiters
	backslash bool
}

func (s *stringScanState) inString() bool {
	return s.triple != pythonTripleNone || s.backtick || s.backslash ||
		s.brackets.round > 0 || s.brackets.square > 0 || s.brackets.curly > 0
}

func (s *stringScanState) scan(text string, language sourceLanguage) {
	if language == sourceLanguagePython || language == sourceLanguageJava {
		inTriple := s.triple != pythonTripleNone
		if language == sourceLanguagePython {
			// Bracket depth and backslash continuations matter only where the
			// Python validators enforce them.
			tripleForBalance := s.triple
			s.brackets = s.brackets.add(pythonDelimiterBalanceWithState(text, &tripleForBalance))
			if s.brackets.round < 0 {
				s.brackets.round = 0
			}
			if s.brackets.square < 0 {
				s.brackets.square = 0
			}
			if s.brackets.curly < 0 {
				s.brackets.curly = 0
			}
		}
		scanPythonTripleLine(text, &s.triple)
		if language == sourceLanguagePython {
			s.backslash = !inTriple && s.triple == pythonTripleNone && endsPythonBackslash(text)
		}
	}
	if language == sourceLanguageGo || language == sourceLanguageJavaScript {
		if countCodeBackticks(text)%2 == 1 {
			s.backtick = !s.backtick
		}
	}
}

// sections partitions the diff into per-file spans. Any preamble before the
// first file header (e.g. a git show commit message) joins the first section.
func (b *chunkBuilder) sections() []lineSpan {
	var spans []lineSpan
	for i := range b.lines {
		id := b.layout.fileID[i]
		if id < 0 {
			continue
		}
		if len(spans) == 0 {
			spans = append(spans, lineSpan{start: 0, end: len(b.lines)})
		} else if b.layout.fileID[i-1] != id {
			spans[len(spans)-1].end = i
			spans = append(spans, lineSpan{start: i, end: len(b.lines)})
		}
	}
	return spans
}

func (b *chunkBuilder) rangeText(start, end int) string {
	var sb strings.Builder
	sb.Grow(b.prefixRaw[end] - b.prefixRaw[start])
	for i := start; i < end; i++ {
		sb.WriteString(b.lines[i].text)
		sb.WriteString(b.lines[i].eol)
	}
	return sb.String()
}

// rangeOrigins returns the 0-based original line indices for [start, end),
// one per physical line of rangeText(start, end).
func (b *chunkBuilder) rangeOrigins(start, end int) []int {
	origins := make([]int, 0, end-start)
	for i := start; i < end; i++ {
		origins = append(origins, i)
	}
	return origins
}

func (b *chunkBuilder) spanSizes(start, end int) (textLen, rawLen, count int) {
	return b.prefixText[end] - b.prefixText[start], b.prefixRaw[end] - b.prefixRaw[start], end - start
}

func (b *chunkBuilder) fits(textLen, rawLen, count int) bool {
	return rawLen <= b.budget && numberedLen(textLen, count) <= b.budget
}

func (b *chunkBuilder) spanFits(start, end int) bool {
	return b.fits(b.spanSizes(start, end))
}

// splitSection cuts one oversized file section into pieces at hunk
// boundaries, replicating the file-metadata block on every piece; a hunk
// that is itself oversized is split further by splitHunk. Preamble lines
// before the file's metadata (e.g. a git show commit message) travel with the
// first piece only and are never replicated.
func (b *chunkBuilder) splitSection(sectionID int, s lineSpan) error {
	firstHunk := s.end
	for i := s.start; i < s.end; i++ {
		if b.layout.kinds[i] == diffLineHunkHeader {
			firstHunk = i
			break
		}
	}
	if firstHunk == s.end {
		return fmt.Errorf("file section at line %d is %dKB with no hunks to split — try a narrower diff (per-file with `git diff -- <path> | meat`)",
			s.start+1, (b.prefixRaw[s.end]-b.prefixRaw[s.start])>>10)
	}
	metaStart := firstHunk
	for i := s.start; i < firstHunk; i++ {
		if b.layout.fileID[i] >= 0 {
			metaStart = i
			break
		}
	}
	preamble := lineSpan{start: s.start, end: metaStart}
	preambleText := b.rangeText(preamble.start, preamble.end)
	meta := lineSpan{start: metaStart, end: firstHunk}
	metaText := b.rangeText(meta.start, meta.end)

	// The section tail: lines after the last hunk-body line (a format-patch
	// mail signature, version trailer, or stray prose). It is not part of any
	// hunk's split accounting; it is re-attached to the section's final piece
	// so identity abridgement preserves it byte-for-byte.
	tailStart := s.end
	for tailStart > firstHunk {
		kind := b.layout.kinds[tailStart-1]
		if isHunkSource(kind) || kind == diffLineNoNewline || kind == diffLineHunkHeader {
			break
		}
		tailStart--
	}

	var hunks []lineSpan
	for i := firstHunk; i < tailStart; {
		j := i + 1
		for j < tailStart && b.layout.kinds[j] != diffLineHunkHeader {
			j++
		}
		hunks = append(hunks, lineSpan{start: i, end: j})
		i = j
	}

	piece := 0
	emit := func(body string, bodyOrigins []int) error {
		prefix := metaText
		prefixOrigins := b.rangeOrigins(meta.start, meta.end)
		if piece == 0 {
			prefix = preambleText + metaText
			prefixOrigins = append(b.rangeOrigins(preamble.start, preamble.end), prefixOrigins...)
		}
		if err := b.add(diffChunk{
			text:         prefix + body,
			metaPrefix:   metaText,
			sectionID:    sectionID,
			continuation: piece > 0,
			origins:      append(prefixOrigins, bodyOrigins...),
		}); err != nil {
			return err
		}
		piece++
		return nil
	}
	// prefixSizes is the byte/line cost every piece pays before its body: the
	// replicated metadata, plus the preamble on the first piece.
	prefixSizes := func() (textLen, rawLen, count int) {
		textLen, rawLen, count = b.spanSizes(meta.start, meta.end)
		if piece == 0 {
			pt, pr, pc := b.spanSizes(preamble.start, preamble.end)
			textLen += pt
			rawLen += pr
			count += pc
		}
		return
	}
	runFits := func(start, end int) bool {
		pt, pr, pc := prefixSizes()
		t, r, c := b.spanSizes(start, end)
		return b.fits(pt+t, pr+r, pc+c)
	}

	open := -1 // start line of the accumulating hunk run
	openEnd := 0
	flush := func() error {
		if open >= 0 {
			if err := emit(b.rangeText(open, openEnd), b.rangeOrigins(open, openEnd)); err != nil {
				return err
			}
			open = -1
		}
		return nil
	}
	for _, h := range hunks {
		if b.spanFullyHidden(h) {
			// An import-only hunk: the whole-diff compiler removes it
			// entirely, header included. Skip it; the surrounding pieces
			// concatenate across the gap.
			continue
		}
		if b.spanHasExtraHidden(h) {
			// Rows hidden only by whole-diff move analysis must be dropped
			// from the emitted text; the segmenting path owns that.
			if err := flush(); err != nil {
				return err
			}
			if err := b.splitHunk(h, prefixSizes, emit); err != nil {
				return err
			}
			continue
		}
		if open >= 0 && runFits(open, h.end) {
			openEnd = h.end
			continue
		}
		if err := flush(); err != nil {
			return err
		}
		if runFits(h.start, h.end) {
			open, openEnd = h.start, h.end
			continue
		}
		if err := b.splitHunk(h, prefixSizes, emit); err != nil {
			return err
		}
	}
	if err := flush(); err != nil {
		return err
	}

	// Preserve the section envelope. The tail (a format-patch mail signature,
	// version trailer, or trailing prose) attaches to the section's final
	// piece when it fits, or becomes its own prose piece; if no piece was
	// emitted (an import-only section whose body the compiler drops), any
	// preamble and tail still survive as prose — whole-diff compilation
	// retains them too.
	tailText := b.rangeText(tailStart, s.end)
	if tailText != "" && piece > 0 {
		last := &b.chunks[len(b.chunks)-1]
		if candidate := last.text + tailText; fitsSingleRun(candidate, b.budget) {
			last.text = candidate
			last.origins = append(last.origins, b.rangeOrigins(tailStart, s.end)...)
			tailText = ""
		}
	}
	prose := tailText
	if piece == 0 {
		prose = preambleText + tailText
	}
	if prose != "" {
		if !fitsSingleRun(prose, b.budget) {
			return fmt.Errorf("cannot fit the diff trailer at line %d into a chunk under the size limit — try a narrower diff (per-file with `git diff -- <path> | meat`)", tailStart+1)
		}
		if err := b.add(diffChunk{text: prose, sectionID: -1, passthrough: true}); err != nil {
			return err
		}
	}
	return nil
}

// splitHunk cuts one oversized hunk into segments, each emitted as its own
// piece body: a synthesized @@ header plus the segment's hunk lines. Header
// starts continue the original ranges by the rows consumed before the segment
// (a zero-count side names the line before the gap, per unified-diff
// convention) and counts match the emitted body exactly, so every piece
// passes hunk-count validation.
//
// Cut placement respects atomic units: a source line travels with its
// no-newline markers and with every following line that begins inside a
// multiline string literal, so a segment never starts inside an embedded
// string whose closing delimiter a chunk-local compiler would misread as an
// opener. Segments pre-apply the whole-diff mandatory import mask: rows the
// import pass hides are dropped from the emitted text (with header counts
// covering exactly the emitted rows and start offsets accounting for dropped
// ones). A segment's own compiler cannot re-derive those removals — a cut
// can sever an import block from the rows that identify it — and dropped
// rows could never appear in a result anyway. For the same reason the
// original hunk heading is carried only by a segment that starts at the true
// top of the hunk body: replicated elsewhere, a heading such as an import
// opener would describe context the segment does not start inside. Segments
// left with no changed rows (context-only, or import-only after the drop)
// are not emitted; no plan could retain a change-free hunk either.
func (b *chunkBuilder) splitHunk(h lineSpan, prefixSizes func() (textLen, rawLen, count int), emit func(string, []int) error) error {
	oldStart, oldZero, newStart, newZero, heading := parseHunkHeaderForSplit(b.lines[h.start].text)
	headerEOL := b.lines[h.start].eol
	if headerEOL == "" {
		headerEOL = "\n"
	}
	bodyStart, bodyEnd := h.start+1, h.end

	// unitEnd returns the end of the atomic unit starting at line i.
	unitEnd := func(i int) int {
		j := i + 1
		for j < bodyEnd && (b.layout.kinds[j] == diffLineNoNewline || b.inString[j]) {
			j++
		}
		// A Python decorator or suite header absorbs following rows through
		// its first row that will actually EMIT as semantic body on the
		// kept/added side (recursively for nested owners): a cut directly
		// after an owner would let one chunk's plan hide it while the body,
		// invisible to that chunk's validator, survives in the next.
		// Removed-side rows, dropped import rows (unless they emit a
		// placeholder), comments, and blank rows do not satisfy the owner —
		// the chunk-local validators would not count them as a body either.
		last := i
		for b.pythonOwnerLine(last) {
			advanced := false
			for j < bodyEnd && isHunkSource(b.layout.kinds[j]) && len(b.lines[j].text) > 0 {
				row := j
				j++
				for j < bodyEnd && (b.layout.kinds[j] == diffLineNoNewline || b.inString[j]) {
					j++
				}
				last = row
				advanced = true
				if b.emitsPythonBody(row) {
					break
				}
			}
			if !advanced {
				break
			}
		}
		return j
	}

	oldOff, newOff := 0, 0
	atBodyStart := true
	i := bodyStart
	for i < bodyEnd {
		segStarted := false
		segHeading := ""
		var segOldStart, segNewStart int
		segVisOld, segVisNew := 0, 0
		segTextLen, segRawLen, segCount := 0, 0, 0
		var body strings.Builder
		var bodyOrigins []int
		hasChange := false
		for i < bodyEnd {
			next := unitEnd(i)
			u := b.unitStats(i, next)
			if u.count == 0 {
				// Fully dropped unit: advances original coordinates only.
				oldOff += u.dropOld
				newOff += u.dropNew
				atBodyStart = false
				i = next
				continue
			}
			if !segStarted {
				segOldStart, segNewStart = oldStart+oldOff, newStart+newOff
				if atBodyStart {
					segHeading = heading
				}
				segStarted = true
			}
			header := synthHunkHeader(segOldStart, segVisOld+u.visOld, oldZero, segNewStart, segVisNew+u.visNew, newZero, segHeading)
			pt, pr, pc := prefixSizes()
			if !b.fits(pt+len(header)+segTextLen+u.textLen, pr+len(header)+len(headerEOL)+segRawLen+u.rawLen, pc+1+segCount+u.count) {
				break
			}
			segVisOld += u.visOld
			segVisNew += u.visNew
			segTextLen += u.textLen
			segRawLen += u.rawLen
			segCount += u.count
			oldOff += u.visOld + u.dropOld
			newOff += u.visNew + u.dropNew
			hasChange = hasChange || u.hasChange
			bodyOrigins = b.appendUnit(&body, bodyOrigins, i, next)
			atBodyStart = false
			i = next
		}
		if !segStarted {
			// Only dropped units remained; nothing more to emit.
			break
		}
		if segCount == 0 {
			return fmt.Errorf("cannot split the diff near line %d into a chunk under the size limit — try a narrower diff (per-file with `git diff -- <path> | meat`)", i+1)
		}
		if !hasChange {
			continue
		}
		var sb strings.Builder
		sb.WriteString(synthHunkHeader(segOldStart, segVisOld, oldZero, segNewStart, segVisNew, newZero, segHeading))
		sb.WriteString(headerEOL)
		sb.WriteString(body.String())
		if err := emit(sb.String(), append([]int{-1}, bodyOrigins...)); err != nil {
			return err
		}
	}
	return nil
}

// unitInfo aggregates one atomic unit for splitHunk: sizes and per-side row
// counts of its emitted lines, per-side counts of its dropped lines, and
// whether any emitted row is a change. A hidden row carrying a mandatory
// Python suite placeholder is emitted as that fixed placeholder row (exactly
// as whole-diff rendering emits it) rather than dropped.
type unitInfo struct {
	textLen, rawLen, count int
	visOld, visNew         int
	dropOld, dropNew       int
	hasChange              bool
}

func (b *chunkBuilder) unitStats(start, end int) unitInfo {
	var u unitInfo
	for i := start; i < end; i++ {
		uo, un := 0, 0
		if isHunkSource(b.layout.kinds[i]) && len(b.lines[i].text) > 0 {
			switch b.lines[i].text[0] {
			case ' ':
				uo, un = 1, 1
			case '-':
				uo = 1
			case '+':
				un = 1
			}
		}
		if b.hidden[i] {
			if text, eol, ok := b.placeholderRow(i); ok {
				u.visOld += uo
				u.visNew += un
				u.textLen += len(text)
				u.rawLen += len(text) + len(eol)
				u.count++
				if b.layout.kinds[i] == diffLineHunkChange {
					u.hasChange = true
				}
				continue
			}
			u.dropOld += uo
			u.dropNew += un
			continue
		}
		u.visOld += uo
		u.visNew += un
		u.textLen += len(b.lines[i].text)
		u.rawLen += len(b.lines[i].text) + len(b.lines[i].eol)
		u.count++
		if b.layout.kinds[i] == diffLineHunkChange {
			u.hasChange = true
		}
	}
	return u
}

// appendUnit writes the emitted text of one atomic unit: visible lines
// verbatim, hidden lines dropped, placeholder-carrying hidden lines as their
// fixed `...` row. It returns origins extended with each emitted line's
// original index (-1 for synthesized placeholder rows).
func (b *chunkBuilder) appendUnit(sb *strings.Builder, origins []int, start, end int) []int {
	for i := start; i < end; i++ {
		if b.hidden[i] {
			if text, eol, ok := b.placeholderRow(i); ok {
				sb.WriteString(text)
				sb.WriteString(eol)
				origins = append(origins, -1)
			}
			continue
		}
		sb.WriteString(b.lines[i].text)
		sb.WriteString(b.lines[i].eol)
		origins = append(origins, i)
	}
	return origins
}

// placeholderRow returns the fixed mandatory-placeholder row for hidden line
// i, when the whole-diff compiler would emit one there.
func (b *chunkBuilder) placeholderRow(i int) (text, eol string, ok bool) {
	fi := b.foldAt[i]
	if fi < 0 {
		return "", "", false
	}
	f := b.folds[fi]
	return string(f.marker) + f.indent + "...", f.eol, true
}

// pythonOwnerLine reports whether line i is a visible Python decorator or
// suite header on the kept/added side — an anchor whose body must not be
// severed into a different chunk.
func (b *chunkBuilder) pythonOwnerLine(i int) bool {
	if !b.layout.python[i] || b.hidden[i] || !isHunkSource(b.layout.kinds[i]) || len(b.lines[i].text) < 2 || b.lines[i].text[0] == '-' {
		return false
	}
	if b.inString[i] {
		return false
	}
	trimmed := trimPythonCode(b.lines[i].text[1:])
	return strings.HasPrefix(trimmed, "@") || isPythonSuiteHeaderStart(trimmed)
}

// emitsPythonBody reports whether line i will emit as a semantic body row on
// the kept/added side of a chunk: kept rows with real code (not comments or
// blanks), or hidden rows that emit a mandatory suite placeholder.
func (b *chunkBuilder) emitsPythonBody(i int) bool {
	if len(b.lines[i].text) == 0 || b.lines[i].text[0] == '-' {
		return false
	}
	if b.hidden[i] {
		_, _, ok := b.placeholderRow(i)
		return ok
	}
	return trimPythonCode(b.lines[i].text[1:]) != ""
}

// spanHasExtraHidden reports whether the span contains rows hidden only by
// whole-diff analysis (move-precedence extension), which a chunk-local
// compiler could not re-derive.
func (b *chunkBuilder) spanHasExtraHidden(s lineSpan) bool {
	for i := s.start; i < s.end; i++ {
		if b.extraHidden[i] {
			return true
		}
	}
	return false
}

// spanFullyHidden reports whether the whole-diff mandatory pass hides every
// line of the span (an import-only hunk or file shell), meaning whole-diff
// compilation removes it completely regardless of any model plan.
func (b *chunkBuilder) spanFullyHidden(s lineSpan) bool {
	for i := s.start; i < s.end; i++ {
		if !b.hidden[i] {
			return false
		}
	}
	return s.end > s.start
}

// synthHunkHeader renders a segment's @@ header from its side starts and
// emitted-row counts. When the segment has no rows on a side whose original
// range was nonempty, unified-diff convention names the line before the gap
// (an originally empty side already does).
func synthHunkHeader(oldStart, oldCount int, oldZero bool, newStart, newCount int, newZero bool, heading string) string {
	o := gapAdjustedStart(oldStart, oldCount, oldZero)
	n := gapAdjustedStart(newStart, newCount, newZero)
	return fmt.Sprintf("@@ -%d,%d +%d,%d @@%s", o, oldCount, n, newCount, heading)
}

func gapAdjustedStart(start, count int, originallyZero bool) int {
	if count == 0 && !originallyZero {
		start--
		if start < 0 {
			start = 0
		}
	}
	return start
}

// parseHunkHeaderForSplit extracts the range starts, whether each side's
// original count is zero, and the trailing section heading from an @@ header.
// An unparseable header (e.g. a bare @@) yields starts of 1 and no heading;
// only reachable for hunks so large they must be split, where approximate
// starts still beat refusing the diff.
func parseHunkHeaderForSplit(text string) (oldStart int, oldZero bool, newStart int, newZero bool, heading string) {
	oldStart, newStart = 1, 1
	rest, ok := strings.CutPrefix(text, "@@ ")
	if !ok {
		return
	}
	closer := strings.Index(rest, " @@")
	if closer < 0 {
		return
	}
	heading = rest[closer+3:]
	fields := strings.Fields(rest[:closer])
	if len(fields) != 2 {
		return
	}
	if v, zero, ok := parseHunkStart(fields[0], '-'); ok {
		oldStart, oldZero = v, zero
	}
	if v, zero, ok := parseHunkStart(fields[1], '+'); ok {
		newStart, newZero = v, zero
	}
	return
}

func parseHunkStart(field string, sign byte) (start int, zeroCount, ok bool) {
	if len(field) < 2 || field[0] != sign {
		return 0, false, false
	}
	s := field[1:]
	if comma := strings.IndexByte(s, ','); comma >= 0 {
		zeroCount = s[comma+1:] == "0"
		s = s[:comma]
	}
	v, err := strconv.Atoi(s)
	if err != nil || v < 0 {
		return 0, false, false
	}
	return v, zeroCount, true
}

// chunkError names the chunk whose agent run failed while preserving the
// wrapped error chain, so errors.Is/As (cancellation, deadline, typed model
// errors) behave the same for chunked and single-run diffs.
type chunkError struct {
	label string
	err   error
}

func (e *chunkError) Error() string {
	// abridgeOne errors already carry the "meat:" prefix; splice the chunk
	// label in rather than stacking prefixes.
	return "meat: " + e.label + ": " + strings.TrimPrefix(e.err.Error(), "meat: ")
}

func (e *chunkError) Unwrap() error { return e.err }

// abridgeChunked splits an oversized diff, runs the normal agent loop on each
// chunk, and merges the results: reading diffs are concatenated in original
// order (dropping a continuation piece's replicated metadata once its file
// has surfaced), summaries are deduplicated and joined, token usage is
// summed. The per-run wall-clock budget applies to each chunk individually.
func abridgeChunked(ctx context.Context, model Model, req Request) (*Result, error) {
	chunks, err := splitDiffForAbridging(req.UnifiedDiff, singleRunDiffBytes)
	if err != nil {
		return nil, fmt.Errorf("meat: %w", err)
	}
	modelChunks := 0
	for _, c := range chunks {
		if !c.passthrough {
			modelChunks++
		}
	}
	wholeMoves := detectedMovesInDiff(req.UnifiedDiff)
	progress := req.Progress
	if progress == nil {
		progress = func(string) {}
	}
	if modelChunks > 0 {
		progress(fmt.Sprintf("large diff: abridging %d chunks", modelChunks))
	}

	merged := &Result{}
	var parts []string
	var summaries []string
	appendPiece := func(piece string) {
		// Pieces join on line boundaries, but the final piece may keep a
		// missing final newline from the original.
		if len(parts) > 0 && !strings.HasSuffix(parts[len(parts)-1], "\n") {
			parts[len(parts)-1] += "\n"
		}
		parts = append(parts, piece)
	}
	seenSummary := make(map[string]bool)
	emittedMeta := make(map[int]bool)
	run := 0
	for _, chunk := range chunks {
		if chunk.passthrough {
			// Envelope text with no hunk content (format-patch trailer, or a
			// preamble stranded by an import-only section): copied verbatim,
			// no agent run.
			appendPiece(chunk.text)
			continue
		}
		run++
		label := fmt.Sprintf("chunk %d/%d", run, modelChunks)
		sub := req
		sub.UnifiedDiff = chunk.text
		sub.Progress = func(msg string) { progress(label + ": " + msg) }
		opts := runOptions{chunkRun: true, chunkMoves: mapMovesToChunk(wholeMoves, chunk.origins)}
		res, err := abridgeOne(ctx, model, sub, opts)
		if err != nil {
			return nil, &chunkError{label: label, err: err}
		}
		merged.InputTokens += res.InputTokens
		merged.OutputTokens += res.OutputTokens
		if strings.TrimSpace(res.SmartDiff) != "" {
			piece := res.SmartDiff
			if chunk.sectionID >= 0 {
				// Dedupe a split file's replicated metadata, but only once the
				// file header has actually surfaced in the output: a piece may
				// legally elide its whole file section while retaining
				// non-file preamble, and stripping the next piece's headers
				// then would orphan its hunks.
				if emittedMeta[chunk.sectionID] {
					piece = stripReplicatedMeta(piece, chunk.metaPrefix)
				} else if pieceContainsLine(piece, firstLineText(chunk.metaPrefix)) {
					emittedMeta[chunk.sectionID] = true
				}
			}
			if piece != "" {
				appendPiece(piece)
			}
		}
		if s := strings.TrimSpace(res.Summary); s != "" && !seenSummary[s] {
			seenSummary[s] = true
			summaries = append(summaries, s)
		}
	}
	if modelChunks == 0 {
		// Every changed row was import scaffolding — nothing any edit plan
		// could retain. Say so; passthrough envelope text is dropped along
		// with the change it framed.
		return &Result{Summary: "Only imports and unchanged context; nothing to read."}, nil
	}
	merged.SmartDiff = strings.Join(parts, "")
	merged.Summary = strings.Join(summaries, " ")
	return merged, nil
}

// mapMovesToChunk translates whole-diff move coordinates (1-based original
// lines) into a chunk's own 1-based coordinates using the chunk's line
// origins. A move maps only when BOTH complete sides landed contiguously in
// this chunk; a move split across chunks cannot be enforced — a documented
// cost of chunking.
func mapMovesToChunk(moves []detectedMove, origins []int) []detectedMove {
	if len(moves) == 0 || len(origins) == 0 {
		return nil
	}
	// chunkLine[orig] = 1-based chunk line for original 0-based index orig.
	chunkLine := make(map[int]int, len(origins))
	for i, orig := range origins {
		if orig >= 0 {
			chunkLine[orig] = i + 1
		}
	}
	mapRange := func(r lineRange) (lineRange, bool) {
		start, ok := chunkLine[r.StartLine-1]
		if !ok {
			return lineRange{}, false
		}
		for orig := r.StartLine - 1; orig < r.EndLine; orig++ {
			at, ok := chunkLine[orig]
			if !ok || at != start+(orig-(r.StartLine-1)) {
				return lineRange{}, false
			}
		}
		return lineRange{StartLine: start, EndLine: start + (r.EndLine - r.StartLine)}, true
	}
	var mapped []detectedMove
	for _, m := range moves {
		removed, okR := mapRange(m.Removed)
		added, okA := mapRange(m.Added)
		if okR && okA {
			mapped = append(mapped, detectedMove{Removed: removed, Added: added})
		}
	}
	return mapped
}

// firstLineText returns the text of s's first physical line.
func firstLineText(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	return strings.TrimSuffix(s, "\r")
}

// pieceContainsLine reports whether any physical line of piece equals text.
func pieceContainsLine(piece, text string) bool {
	for _, l := range splitSourceLines(piece) {
		if l.text == text {
			return true
		}
	}
	return false
}

// stripReplicatedMeta drops the leading lines of a continuation piece's
// reading diff that replicate its file-metadata block. Matching is in-order
// and stops at the first non-metadata line (the piece's first @@ header, which
// can never appear in the block), so retained hunk content is never touched.
func stripReplicatedMeta(smart, metaPrefix string) string {
	metaLines := splitSourceLines(metaPrefix)
	smartLines := splitSourceLines(smart)
	drop, j := 0, 0
	for _, l := range smartLines {
		k := j
		for k < len(metaLines) && metaLines[k].text != l.text {
			k++
		}
		if k == len(metaLines) {
			break
		}
		j = k + 1
		drop++
	}
	var sb strings.Builder
	for _, l := range smartLines[drop:] {
		sb.WriteString(l.text)
		sb.WriteString(l.eol)
	}
	return sb.String()
}
