package meat

import (
	"regexp"
	"strings"
)

// addMandatoryPythonSuitePlaceholders preserves a readable suite skeleton when
// removing an import would otherwise leave a visible Python owner with no body.
// The placeholder is the same fixed, source-positioned ellipsis used by folds;
// it contains no model-authored text and never reveals the import.
func addMandatoryPythonSuitePlaceholders(lines []sourceLine, layout diffLayout, state *planState, mandatory []bool) {
	for owner, line := range lines {
		if !layout.python[owner] || state.hidden[owner] || !isHunkSource(layout.kinds[owner]) || len(line.text) < 2 || line.text[0] == '-' {
			continue
		}
		if pythonTripleStateBeforeLine(lines, layout, owner) != pythonTripleNone {
			continue
		}
		body := line.text[1:]
		trimmed := trimPythonCode(body)
		if !isPythonSuiteHeaderStart(trimmed) {
			continue
		}
		headerEnd, ok := pythonSuiteHeaderEnd(lines, layout, nil, owner)
		if !ok {
			continue
		}
		ownerIndent := len(leadingWhitespace(body))
		if !hasPythonBodyAfter(lines, layout, nil, headerEnd, ownerIndent) || hasPythonBodyAfter(lines, layout, state, headerEnd, ownerIndent) {
			continue
		}
		_, hunkEnd := containingHunk(layout, owner)
		for i := headerEnd + 1; i < hunkEnd; i++ {
			if !mandatory[i] || !state.hidden[i] || !isHunkSource(layout.kinds[i]) || len(lines[i].text) < 2 || lines[i].text[0] == '-' {
				continue
			}
			candidateBody := lines[i].text[1:]
			if trimPythonCode(candidateBody) == "" || len(leadingWhitespace(candidateBody)) <= ownerIndent {
				continue
			}
			foldIndex := len(state.folds)
			state.folds = append(state.folds, plannedFold{
				lineFold:  lineFold{StartLine: i + 1, EndLine: i + 1},
				planIndex: -1,
				marker:    lines[i].text[0],
				indent:    leadingWhitespace(candidateBody),
				eol:       lines[i].eol,
			})
			state.foldAt[i] = foldIndex
			state.folded[i] = foldIndex
			break
		}
	}
}

// stateWithMandatoryImportsRepresented isolates model-plan validation from the
// compiler invariant. In partially retained Python hunks, mandatory imports and
// their compiler-owned framing are treated as present while checking suite and
// delimiter safety; the final rendering still uses the import-hidden state.
func stateWithMandatoryImportsRepresented(state planState, mandatory []bool, layout diffLayout) planState {
	validation := state
	validation.hidden = append([]bool(nil), state.hidden...)
	validation.folded = append([]int(nil), state.folded...)
	validation.foldAt = append([]int(nil), state.foldAt...)
	for hunk, kind := range layout.kinds {
		if kind != diffLineHunkHeader {
			continue
		}
		end := nextLayoutLine(layout, hunk+1, func(k diffLineKind) bool {
			return k == diffLineHeader || k == diffLineOldFile || k == diffLineHunkHeader || k == diffLineMailSignature
		})
		haveVisibleNonImport := false
		for i := hunk + 1; i < end; i++ {
			if isHunkSource(layout.kinds[i]) && !mandatory[i] && state.represented(i) {
				haveVisibleNonImport = true
				break
			}
		}
		if !haveVisibleNonImport {
			continue
		}
		for i := hunk + 1; i < end; i++ {
			if !mandatory[i] {
				continue
			}
			validation.hidden[i] = false
			validation.folded[i] = -1
			validation.foldAt[i] = -1
		}
	}
	return validation
}

// completeMandatoryImportFraming closes hunk/file shells after mandatory import
// removal is merged with model removals. It only acts on sections that actually
// contained compiler-classified imports.
func completeMandatoryImportFraming(layout diffLayout, state *planState, mandatory []bool) {
	for hunk, kind := range layout.kinds {
		if kind != diffLineHunkHeader {
			continue
		}
		end := nextLayoutLine(layout, hunk+1, func(k diffLineKind) bool {
			return k == diffLineHeader || k == diffLineOldFile || k == diffLineHunkHeader || k == diffLineMailSignature
		})
		hasMandatoryImport := false
		for i := hunk + 1; i < end; i++ {
			if mandatory[i] && isHunkSource(layout.kinds[i]) {
				hasMandatoryImport = true
				break
			}
		}
		if !hasMandatoryImport || anyRetainedHunkChange(layout, *state, hunk+1, end) {
			continue
		}
		for i := hunk; i < end; i++ {
			state.hidden[i] = true
		}
	}

	for _, section := range importFileSections(layout) {
		hasMandatoryImport := false
		for i := section.start; i < section.end; i++ {
			if mandatory[i] && isHunkSource(layout.kinds[i]) {
				hasMandatoryImport = true
				break
			}
		}
		if !hasMandatoryImport {
			continue
		}
		sawHunk := false
		allHunksHidden := true
		for i := section.start; i < section.end; i++ {
			if layout.kinds[i] != diffLineHunkHeader {
				continue
			}
			sawHunk = true
			if state.represented(i) {
				allHunksHidden = false
			}
		}
		if sawHunk && allHunksHidden {
			for i := section.start; i < section.end; i++ {
				state.hidden[i] = true
			}
		}
	}
}

// mandatoryImportRemovalPlan is the compiler-owned half of every edit plan.
// It is derived only from the immutable source diff and is merged with model
// edits during compilation. The classifier is intentionally conservative: it
// recognizes common import declaration shapes without trying to parse every
// supported language.
func mandatoryImportRemovalPlan(lines []sourceLine, layout diffLayout) []lineRange {
	hidden := make([]bool, len(lines))

	for hunk, kind := range layout.kinds {
		if kind != diffLineHunkHeader {
			continue
		}
		end := nextLayoutLine(layout, hunk+1, func(k diffLineKind) bool {
			return k == diffLineHeader || k == diffLineOldFile || k == diffLineHunkHeader || k == diffLineMailSignature
		})
		language := layout.language[hunk]
		continuation := hunkStartsImportContinuation(lines[hunk].text, language)
		sideMasks := make(map[byte]map[int]bool, 2)
		for _, side := range []byte{'-', '+'} {
			sideLines := importLinesForSide(lines, layout, hunk+1, end, side)
			sideHidden := classifySideImports(sideLines, language, continuation)
			expandPythonImportOnlySuites(sideLines, sideHidden)
			fillImportGroupGaps(sideLines, sideHidden, embeddedSourceLines(sideLines, language))
			mask := make(map[int]bool)
			for i, line := range sideLines {
				if sideHidden[i] {
					mask[line.index] = true
				}
			}
			sideMasks[side] = mask
		}
		for i := hunk + 1; i < end; i++ {
			if !isHunkSource(layout.kinds[i]) || len(lines[i].text) == 0 {
				continue
			}
			switch lines[i].text[0] {
			case '-':
				hidden[i] = sideMasks['-'][i]
			case '+':
				hidden[i] = sideMasks['+'][i]
			case ' ':
				hidden[i] = sideMasks['-'][i] && sideMasks['+'][i]
			}
		}

		// If every changed row is import scaffolding (apart from blank framing),
		// remove the complete hunk, including its stale header and context.
		haveImportChange := false
		importOnly := true
		oneSidedChange := hunkChangesOnlyOneSide(lines, layout, hunk+1, end)
		for i := hunk + 1; i < end; i++ {
			if layout.kinds[i] != diffLineHunkChange {
				continue
			}
			if hidden[i] {
				haveImportChange = true
				continue
			}
			if isImportOnlyFramingRow(lines[i].text[1:], language, oneSidedChange) {
				continue
			}
			importOnly = false
		}
		if haveImportChange && importOnly {
			for i := hunk; i < end; i++ {
				hidden[i] = true
			}
		}
	}

	// A no-newline marker is source framing and cannot outlive an import row.
	for i, kind := range layout.kinds {
		if kind == diffLineNoNewline && layout.markerOwner[i] >= 0 && hidden[layout.markerOwner[i]] {
			hidden[i] = true
		}
	}

	// When every hunk in a file is import-only, remove the complete file shell
	// (diff/index/---/+++ metadata included).
	for _, section := range importFileSections(layout) {
		sawHunk := false
		allHunksHidden := true
		for i := section.start; i < section.end; i++ {
			if layout.kinds[i] != diffLineHunkHeader {
				continue
			}
			sawHunk = true
			if !hidden[i] {
				allHunksHidden = false
			}
		}
		if sawHunk && allHunksHidden {
			for i := section.start; i < section.end; i++ {
				hidden[i] = true
			}
		}
	}

	return hiddenLineRanges(hidden)
}

type importFileSection struct {
	start int
	end   int
}

func hunkChangesOnlyOneSide(lines []sourceLine, layout diffLayout, start, end int) bool {
	haveOld := false
	haveNew := false
	for i := start; i < end; i++ {
		if layout.kinds[i] != diffLineHunkChange || len(lines[i].text) == 0 {
			continue
		}
		switch lines[i].text[0] {
		case '-':
			haveOld = true
		case '+':
			haveNew = true
		}
	}
	return haveOld != haveNew
}

func isImportOnlyFramingRow(body string, language sourceLanguage, oneSidedChange bool) bool {
	trimmed := strings.TrimSpace(body)
	if trimmed == "" {
		return true
	}
	if !oneSidedChange || language != sourceLanguageGo && language != sourceLanguageJava {
		return false
	}
	if !strings.HasPrefix(trimmed, "package ") {
		return false
	}
	name := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(trimmed, "package "), ";"))
	if name == "" {
		return false
	}
	for _, segment := range strings.Split(name, ".") {
		if segment == "" || !isIdentifierStart(segment[0]) {
			return false
		}
		for i := 1; i < len(segment); i++ {
			if !isIdentifierContinue(segment[i]) {
				return false
			}
		}
	}
	return true
}

func importFileSections(layout diffLayout) []importFileSection {
	var sections []importFileSection
	for i, kind := range layout.kinds {
		if kind != diffLineHeader && kind != diffLineOldFile {
			continue
		}
		if kind == diffLineOldFile && i > 0 && layout.fileID[i-1] == layout.fileID[i] && layout.kinds[i-1] != diffLineMailSignature {
			// A Git file section starts at diff --git, not its --- row.
			continue
		}
		end := len(layout.kinds)
		for j := i + 1; j < len(layout.kinds); j++ {
			if layout.kinds[j] == diffLineMailSignature || layout.fileID[j] != layout.fileID[i] {
				end = j
				break
			}
		}
		sections = append(sections, importFileSection{start: i, end: end})
	}
	return sections
}

func hiddenLineRanges(hidden []bool) []lineRange {
	var ranges []lineRange
	for i := 0; i < len(hidden); {
		if !hidden[i] {
			i++
			continue
		}
		start := i
		for i+1 < len(hidden) && hidden[i+1] {
			i++
		}
		ranges = append(ranges, lineRange{StartLine: start + 1, EndLine: i + 1})
		i++
	}
	return ranges
}

func mandatoryRemovalMask(lines int, ranges []lineRange) []bool {
	hidden := make([]bool, lines)
	for _, r := range ranges {
		for line := r.StartLine; line <= r.EndLine; line++ {
			hidden[line-1] = true
		}
	}
	return hidden
}

type importSideLine struct {
	index int
	text  string
}

func importLinesForSide(lines []sourceLine, layout diffLayout, start, end int, side byte) []importSideLine {
	var result []importSideLine
	for i := start; i < end; i++ {
		if !isHunkSource(layout.kinds[i]) || len(lines[i].text) == 0 {
			continue
		}
		marker := lines[i].text[0]
		if marker == ' ' || marker == side {
			result = append(result, importSideLine{index: i, text: lines[i].text[1:]})
		}
	}
	return result
}

func hunkStartsImportContinuation(header string, language sourceLanguage) bool {
	section := hunkSectionText(header)
	if section == "" {
		return false
	}
	switch language {
	case sourceLanguageGo:
		return goImportBlockStartRE.MatchString(section)
	case sourceLanguagePython:
		match := pythonFromStartRE.FindStringSubmatch(stripPythonImportComment(section))
		return match != nil && strings.HasPrefix(strings.TrimSpace(match[1]), "(")
	case sourceLanguageJavaScript:
		if !strings.HasPrefix(section, "import ") || javascriptSideEffectImportRE.MatchString(section) || javascriptFromImportRE.MatchString(section) || javascriptTSRequireImportRE.MatchString(section) {
			return false
		}
		return strings.Count(section, "{") > strings.Count(section, "}") ||
			strings.Count(section, "[") > strings.Count(section, "]") ||
			strings.Count(section, "(") > strings.Count(section, ")")
	case sourceLanguageRust:
		return rustUseStartRE.MatchString(section) && strings.Contains(section, "{") && !strings.HasSuffix(strings.TrimSpace(section), ";")
	default:
		return false
	}
}

func hunkSectionText(header string) string {
	if !strings.HasPrefix(header, "@@") {
		return ""
	}
	if end := strings.Index(header[2:], "@@"); end >= 0 {
		return strings.TrimSpace(header[2+end+2:])
	}
	return ""
}

func importContinuationEnd(lines []importSideLine, language sourceLanguage) int {
	if len(lines) == 0 {
		return 0
	}
	switch language {
	case sourceLanguageGo:
		for i, line := range lines {
			trimmed := strings.TrimSpace(line.text)
			if trimmed == "" || strings.HasPrefix(trimmed, "//") {
				continue
			}
			if goImportBlockEndRE.MatchString(trimmed) {
				return i + 1
			}
			if !goImportMemberRE.MatchString(trimmed) {
				return 0
			}
		}
		return len(lines)
	case sourceLanguagePython:
		balance := 1
		for i, line := range lines {
			part := stripPythonImportComment(strings.TrimSpace(line.text))
			if part == "" {
				continue
			}
			balance += strings.Count(part, "(") - strings.Count(part, ")")
			member := strings.TrimSpace(strings.TrimSuffix(strings.ReplaceAll(strings.ReplaceAll(part, "(", ""), ")", ""), ","))
			if member != "" && !pythonFromListRE.MatchString(member) {
				return 0
			}
			if balance <= 0 {
				return i + 1
			}
		}
		return len(lines)
	case sourceLanguageJavaScript:
		balance := 1
		for i, line := range lines {
			trimmed := strings.TrimSpace(line.text)
			if trimmed == "" || strings.HasPrefix(trimmed, "//") {
				continue
			}
			balance += strings.Count(trimmed, "{") - strings.Count(trimmed, "}")
			if balance <= 0 && javascriptImportContinuationEndRE.MatchString(trimmed) {
				return i + 1
			}
			if !javascriptImportContinuationMemberRE.MatchString(trimmed) {
				return 0
			}
		}
		return len(lines)
	case sourceLanguageRust:
		for i, line := range lines {
			trimmed := strings.TrimSpace(line.text)
			if trimmed == "" || strings.HasPrefix(trimmed, "//") {
				continue
			}
			if !rustUseContinuationMemberRE.MatchString(trimmed) {
				return 0
			}
			if strings.HasSuffix(trimmed, ";") {
				return i + 1
			}
		}
		return len(lines)
	default:
		return 0
	}
}

func classifySideImports(lines []importSideLine, language sourceLanguage, continuation bool) []bool {
	hidden := make([]bool, len(lines))
	if continuation {
		end := importContinuationEnd(lines, language)
		for i := 0; i < end; i++ {
			hidden[i] = true
		}
	}
	embedded := embeddedSourceLines(lines, language)
	for i := 0; i < len(lines); {
		scanLines := lines
		if embedded[i] {
			limit := embeddedSourceEnd(embedded, i)
			if limit <= i {
				i++
				continue
			}
			scanLines = lines[:limit]
		}
		end := importStatementEnd(scanLines, i, language, embedded[i])
		if end <= i {
			i++
			continue
		}
		for j := i; j < end; j++ {
			hidden[j] = true
		}
		i = end
	}
	return hidden
}

func expandPythonImportOnlySuites(lines []importSideLine, hidden []bool) {
	for i := 0; i < len(lines); {
		if hidden[i] {
			i++
			continue
		}
		body := lines[i].text
		trimmed := trimPythonCode(body)
		if !isPythonImportGuard(trimmed) {
			i++
			continue
		}
		ownerIndent := len(leadingWhitespace(body))
		end := i + 1
		haveImport := false
		importOnly := true
		for end < len(lines) {
			candidate := lines[end].text
			candidateTrimmed := trimPythonCode(candidate)
			if candidateTrimmed == "" {
				end++
				continue
			}
			indent := len(leadingWhitespace(candidate))
			if indent < ownerIndent || indent == ownerIndent && !isPythonImportGuardClause(candidateTrimmed) {
				break
			}
			if indent == ownerIndent {
				end++
				continue
			}
			if hidden[end] {
				haveImport = true
				end++
				continue
			}
			importOnly = false
			break
		}
		if haveImport && importOnly {
			for j := i; j < end; j++ {
				hidden[j] = true
			}
			i = end
			continue
		}
		i++
	}
}

func isPythonImportGuard(trimmed string) bool {
	if !strings.HasSuffix(trimmed, ":") {
		return false
	}
	return trimmed == "try:" || strings.HasPrefix(trimmed, "if ") ||
		strings.HasPrefix(trimmed, "with ") || strings.HasPrefix(trimmed, "async with ") ||
		strings.HasPrefix(trimmed, "except")
}

func isPythonImportGuardClause(trimmed string) bool {
	if !strings.HasSuffix(trimmed, ":") {
		return false
	}
	return trimmed == "else:" || trimmed == "finally:" ||
		strings.HasPrefix(trimmed, "elif ") || strings.HasPrefix(trimmed, "except")
}

func fillImportGroupGaps(lines []importSideLine, hidden, embedded []bool) {
	previous := -1
	for i := range lines {
		if !hidden[i] {
			continue
		}
		if previous >= 0 {
			blankGap := true
			for j := previous + 1; j < i; j++ {
				if strings.TrimSpace(lines[j].text) != "" {
					blankGap = false
					break
				}
			}
			if blankGap {
				for j := previous + 1; j < i; j++ {
					hidden[j] = true
				}
			}
		}
		previous = i
	}

	// Blank rows immediately after imports inside an embedded source literal
	// only frame that fixture's import group. Hide them so the outer string does
	// not retain empty debris; ordinary source blanks remain available to folds.
	for i := 0; i < len(lines); {
		if !hidden[i] {
			i++
			continue
		}
		for i < len(lines) && hidden[i] {
			i++
		}
		for i < len(lines) && embedded[i] && strings.TrimSpace(lines[i].text) == "" {
			hidden[i] = true
			i++
		}
	}
}

func embeddedSourceEnd(embedded []bool, start int) int {
	for i := start; i+1 < len(embedded); i++ {
		if embedded[i] && !embedded[i+1] {
			return i
		}
	}
	return len(embedded)
}

func embeddedSourceLines(lines []importSideLine, language sourceLanguage) []bool {
	flags := make([]bool, len(lines))
	var triple pythonTripleState
	backtick := false
	for i, line := range lines {
		flags[i] = triple != pythonTripleNone || backtick
		if language == sourceLanguagePython || language == sourceLanguageJava {
			scanPythonTripleLine(line.text, &triple)
		}
		if language == sourceLanguageGo || language == sourceLanguageJavaScript {
			if countCodeBackticks(line.text)%2 == 1 {
				backtick = !backtick
			}
		}
	}
	return flags
}

func countCodeBackticks(text string) int {
	count := 0
	var quote byte
	escaped := false
	for i := 0; i < len(text); i++ {
		b := text[i]
		if quote != 0 {
			if escaped {
				escaped = false
				continue
			}
			if b == '\\' {
				escaped = true
				continue
			}
			if b == quote {
				quote = 0
			}
			continue
		}
		if b == '/' && i+1 < len(text) && text[i+1] == '/' {
			break
		}
		if b == '\'' || b == '"' {
			quote = b
			continue
		}
		if b == '`' {
			backslashes := 0
			for j := i - 1; j >= 0 && text[j] == '\\'; j-- {
				backslashes++
			}
			if backslashes%2 == 0 {
				count++
			}
		}
	}
	return count
}

func importStatementEnd(lines []importSideLine, start int, language sourceLanguage, embedded bool) int {
	try := func(language sourceLanguage) int {
		switch language {
		case sourceLanguageGo:
			return goImportEnd(lines, start)
		case sourceLanguagePython:
			return pythonImportEnd(lines, start)
		case sourceLanguageJavaScript:
			if end := javascriptImportEnd(lines, start); end > start {
				return end
			}
			return javascriptRequireEnd(lines, start)
		case sourceLanguageRust:
			return rustUseEnd(lines, start)
		case sourceLanguageC:
			return cIncludeEnd(lines, start)
		case sourceLanguageJava:
			return javaImportEnd(lines, start)
		default:
			return start
		}
	}
	if end := try(language); end > start {
		return end
	}
	if !embedded {
		return start
	}
	for _, candidate := range []sourceLanguage{
		sourceLanguageGo,
		sourceLanguagePython,
		sourceLanguageJavaScript,
		sourceLanguageRust,
		sourceLanguageC,
		sourceLanguageJava,
	} {
		if candidate == language || !strongEmbeddedImportCandidate(lines[start].text, candidate) {
			continue
		}
		if end := try(candidate); end > start {
			return end
		}
	}
	return start
}

func strongEmbeddedImportCandidate(text string, language sourceLanguage) bool {
	trimmed := strings.TrimSpace(text)
	switch language {
	case sourceLanguageRust:
		return strings.Contains(trimmed, "::") || strings.Contains(trimmed, "{") || strings.HasPrefix(trimmed, "pub use ")
	case sourceLanguageC:
		return strings.Contains(trimmed, "<") || strings.Contains(trimmed, `"`)
	default:
		return true
	}
}

var (
	goImportBlockStartRE = regexp.MustCompile(`^import\s*\(\s*(?://.*)?$`)
	goImportBlockEndRE   = regexp.MustCompile(`^\)\s*(?://.*)?$`)
	goImportMemberRE     = regexp.MustCompile("^(?:(?:[._]|[A-Za-z_][A-Za-z0-9_]*)\\s+)?(?:\"(?:[^\"\\\\]|\\\\.)*\"|`[^`]*`)\\s*(?://.*)?$")
	goImportSingleRE     = regexp.MustCompile("^import\\s+(?:(?:[._]|[A-Za-z_][A-Za-z0-9_]*)\\s+)?(?:\"(?:[^\"\\\\]|\\\\.)*\"|`[^`]*`)\\s*(?://.*)?$")

	pythonImportListRE = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?:\s+as\s+[A-Za-z_][A-Za-z0-9_]*)?(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?:\s+as\s+[A-Za-z_][A-Za-z0-9_]*)?)*$`)
	pythonFromStartRE  = regexp.MustCompile(`^from\s+(?:\.*(?:[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)?)\s+import\s+(.+)$`)
	pythonFromListRE   = regexp.MustCompile(`^(?:\*|[A-Za-z_][A-Za-z0-9_]*(?:\s+as\s+[A-Za-z_][A-Za-z0-9_]*)?(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*(?:\s+as\s+[A-Za-z_][A-Za-z0-9_]*)?)*)$`)

	javascriptSideEffectImportRE         = regexp.MustCompile("(?s)^import\\s+[\"'`][^\"'`]+[\"'`]\\s*;?\\s*(?://.*)?$")
	javascriptFromImportRE               = regexp.MustCompile("(?s)^import\\s+.+\\s+from\\s+[\"'`][^\"'`]+[\"'`](?:\\s+(?:with|assert)\\s*\\{.*\\})?\\s*;?\\s*(?://.*)?$")
	javascriptTSRequireImportRE          = regexp.MustCompile("(?s)^import\\s+[A-Za-z_$][A-Za-z0-9_$]*\\s*=\\s*require\\s*\\(\\s*[\"'`][^\"'`]+[\"'`]\\s*\\)\\s*;?\\s*(?://.*)?$")
	javascriptRequireRE                  = regexp.MustCompile("(?s)^(?:require\\s*\\(\\s*[\"'`][^\"'`]+[\"'`]\\s*\\)|(?:const|let|var)\\s+(?:[A-Za-z_$][A-Za-z0-9_$]*|\\{[^;]*\\}|\\[[^;]*\\])\\s*=\\s*require\\s*\\(\\s*[\"'`][^\"'`]+[\"'`]\\s*\\)(?:\\.[A-Za-z_$][A-Za-z0-9_$]*)*)\\s*;?\\s*(?://.*)?$")
	javascriptRequireStartRE             = regexp.MustCompile(`^(?:const|let|var)\s+(?:[A-Za-z_$][A-Za-z0-9_$]*|\{[^;]*|\[[^;]*)\s*=\s*require\s*\(`)
	javascriptImportContinuationMemberRE = regexp.MustCompile(`^[A-Za-z0-9_$,*{}\s]+(?:\s+as\s+[A-Za-z_$][A-Za-z0-9_$]*)?[,]?$`)
	javascriptImportContinuationEndRE    = regexp.MustCompile("^}\\s+from\\s+[\"'`][^\"'`]+[\"'`]\\s*;?$")

	rustUseStartRE              = regexp.MustCompile(`^(?:pub(?:\s*\([^)]*\))?\s+)?use\s+`)
	rustUseContinuationMemberRE = regexp.MustCompile(`^[A-Za-z0-9_:,*{}\s]+(?:\s+as\s+[A-Za-z_][A-Za-z0-9_]*)?[,;]?$`)
	cIncludeStartRE             = regexp.MustCompile(`^#\s*include(?:_next)?(?:\s|[<"])`)
	javaImportRE                = regexp.MustCompile(`^import\s+(?:static\s+)?[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$*][A-Za-z0-9_$*]*)*(?:\s+as\s+[A-Za-z_$][A-Za-z0-9_$]*)?\s*;?\s*(?://.*)?$`)
)

func goImportEnd(lines []importSideLine, start int) int {
	trimmed := strings.TrimSpace(lines[start].text)
	if goImportSingleRE.MatchString(trimmed) {
		return start + 1
	}
	if !goImportBlockStartRE.MatchString(trimmed) {
		return start
	}
	for i := start + 1; i < len(lines) && i <= start+200; i++ {
		trimmed := strings.TrimSpace(lines[i].text)
		if goImportBlockEndRE.MatchString(trimmed) {
			return i + 1
		}
		if trimmed == "" || strings.HasPrefix(trimmed, "//") || goImportMemberRE.MatchString(trimmed) {
			continue
		}
		return i
	}
	return len(lines)
}

func pythonImportEnd(lines []importSideLine, start int) int {
	code := stripPythonImportComment(strings.TrimSpace(lines[start].text))
	if strings.HasPrefix(code, "import ") {
		rest := strings.TrimSpace(strings.TrimPrefix(code, "import "))
		return pythonContinuedImportEnd(lines, start, rest, pythonImportListRE)
	}
	match := pythonFromStartRE.FindStringSubmatch(code)
	if match == nil {
		return start
	}
	return pythonContinuedImportEnd(lines, start, strings.TrimSpace(match[1]), pythonFromListRE)
}

func pythonContinuedImportEnd(lines []importSideLine, start int, rest string, final *regexp.Regexp) int {
	if strings.HasPrefix(rest, "(") {
		balance := strings.Count(rest, "(") - strings.Count(rest, ")")
		if balance <= 0 {
			inside := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(rest, "("), ")"))
			if final.MatchString(strings.TrimSuffix(strings.TrimSpace(inside), ",")) {
				return start + 1
			}
			return start
		}
		var contents strings.Builder
		contents.WriteString(strings.TrimPrefix(rest, "("))
		for i := start + 1; i < len(lines) && i <= start+200; i++ {
			part := stripPythonImportComment(strings.TrimSpace(lines[i].text))
			member := strings.TrimSpace(strings.TrimSuffix(strings.ReplaceAll(strings.ReplaceAll(part, "(", ""), ")", ""), ","))
			if member != "" && !final.MatchString(member) {
				return i
			}
			balance += strings.Count(part, "(") - strings.Count(part, ")")
			contents.WriteByte(' ')
			contents.WriteString(strings.ReplaceAll(strings.ReplaceAll(part, "(", ""), ")", ""))
			if balance == 0 {
				inside := strings.TrimSuffix(strings.TrimSpace(contents.String()), ",")
				if final.MatchString(inside) {
					return i + 1
				}
				return i
			}
		}
		return len(lines)
	}
	if strings.HasSuffix(rest, "\\") {
		var joined strings.Builder
		joined.WriteString(strings.TrimSpace(strings.TrimSuffix(rest, "\\")))
		for i := start + 1; i < len(lines) && i <= start+50; i++ {
			part := stripPythonImportComment(strings.TrimSpace(lines[i].text))
			continued := strings.HasSuffix(part, "\\")
			part = strings.TrimSpace(strings.TrimSuffix(part, "\\"))
			joined.WriteByte(' ')
			joined.WriteString(part)
			if !continued {
				if final.MatchString(strings.TrimSpace(joined.String())) {
					return i + 1
				}
				return start
			}
		}
		return len(lines)
	}
	if final.MatchString(rest) {
		return start + 1
	}
	return start
}

func stripPythonImportComment(text string) string {
	if hash := strings.IndexByte(text, '#'); hash >= 0 {
		text = text[:hash]
	}
	return strings.TrimSpace(text)
}

func javascriptImportEnd(lines []importSideLine, start int) int {
	trimmed := strings.TrimSpace(lines[start].text)
	if !strings.HasPrefix(trimmed, "import ") || strings.HasPrefix(strings.TrimSpace(strings.TrimPrefix(trimmed, "import")), "(") {
		return start
	}
	var joined strings.Builder
	for i := start; i < len(lines) && i <= start+80; i++ {
		trimmedLine := strings.TrimSpace(lines[i].text)
		if joined.Len() > 0 {
			joined.WriteByte(' ')
		}
		joined.WriteString(trimmedLine)
		statement := joined.String()
		if javascriptSideEffectImportRE.MatchString(statement) || javascriptFromImportRE.MatchString(statement) || javascriptTSRequireImportRE.MatchString(statement) {
			return i + 1
		}
		if i == start {
			if strings.Contains(trimmed, "{") || strings.Contains(trimmed, "[") || strings.HasSuffix(trimmed, ",") {
				continue
			}
			return start
		}
		if trimmedLine == "" || strings.HasPrefix(trimmedLine, "//") || javascriptImportContinuationMemberRE.MatchString(trimmedLine) {
			continue
		}
		return i
	}
	return len(lines)
}

func javascriptRequireEnd(lines []importSideLine, start int) int {
	trimmed := strings.TrimSpace(lines[start].text)
	bareRequire := strings.HasPrefix(trimmed, "require(") || strings.HasPrefix(trimmed, "require (")
	directRequire := bareRequire || javascriptRequireStartRE.MatchString(trimmed)
	candidate := directRequire
	for _, keyword := range []string{"const ", "let ", "var "} {
		if !strings.HasPrefix(trimmed, keyword) {
			continue
		}
		unclosedDestructure := strings.Count(trimmed, "{") > strings.Count(trimmed, "}") ||
			strings.Count(trimmed, "[") > strings.Count(trimmed, "]")
		if unclosedDestructure {
			candidate = true
		}
	}
	if !candidate {
		return start
	}
	var joined strings.Builder
	for i := start; i < len(lines) && i <= start+80; i++ {
		if joined.Len() > 0 {
			joined.WriteByte(' ')
		}
		joined.WriteString(strings.TrimSpace(lines[i].text))
		if javascriptRequireRE.MatchString(joined.String()) {
			return i + 1
		}
	}
	return start
}

func rustUseEnd(lines []importSideLine, start int) int {
	trimmed := strings.TrimSpace(lines[start].text)
	if !rustUseStartRE.MatchString(trimmed) {
		return start
	}
	if strings.HasSuffix(trimmed, ";") {
		return start + 1
	}
	if !strings.Contains(trimmed, "{") && !strings.HasSuffix(trimmed, "::") {
		return start
	}
	for i := start + 1; i < len(lines) && i <= start+200; i++ {
		candidate := strings.TrimSpace(lines[i].text)
		if candidate == "" || strings.HasPrefix(candidate, "//") {
			continue
		}
		if !rustUseContinuationMemberRE.MatchString(candidate) {
			return i
		}
		if strings.HasSuffix(candidate, ";") {
			return i + 1
		}
	}
	return len(lines)
}

func cIncludeEnd(lines []importSideLine, start int) int {
	trimmed := strings.TrimSpace(lines[start].text)
	if !cIncludeStartRE.MatchString(trimmed) {
		return start
	}
	for i := start; i < len(lines) && i <= start+50; i++ {
		if !strings.HasSuffix(strings.TrimSpace(lines[i].text), "\\") {
			return i + 1
		}
	}
	return len(lines)
}

func javaImportEnd(lines []importSideLine, start int) int {
	if javaImportRE.MatchString(strings.TrimSpace(lines[start].text)) {
		return start + 1
	}
	return start
}
