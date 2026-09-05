// diff.go parses unified diffs into an immutable line-oriented layout.
//
// analyzeDiff classifies every physical line (headers, hunk boundaries, hunk
// source) and tags each with its file, hunk, and source language. Everything
// downstream — the edit-plan compiler, the mandatory import pass, move
// detection, and the Python validators — consumes this layout and never
// re-parses the diff text.

package meat

import (
	"fmt"
	"strconv"
	"strings"
)

type sourceLine struct {
	text string
	eol  string
}

type diffLineKind uint8

const (
	diffLineOther diffLineKind = iota
	diffLineHeader
	diffLineIndex
	diffLineRenameFrom
	diffLineRenameTo
	diffLineCopyFrom
	diffLineCopyTo
	diffLineMailSignature
	diffLineOldFile
	diffLineNewFile
	diffLineHunkHeader
	diffLineHunkContext
	diffLineHunkChange
	diffLineNoNewline
)

type sourceLanguage uint8

const (
	sourceLanguageUnknown sourceLanguage = iota
	sourceLanguageGo
	sourceLanguagePython
	sourceLanguageJavaScript
	sourceLanguageRust
	sourceLanguageC
	sourceLanguageJava
)

type diffLayout struct {
	kinds       []diffLineKind
	markerOwner []int
	python      []bool
	language    []sourceLanguage
	fileID      []int
	hunkID      []int
	problems    []error
}

// splitSourceLines splits text into physical lines while retaining each line's
// exact ending. A final newline belongs to the preceding line and does not
// create a phantom empty line.
func splitSourceLines(text string) []sourceLine {
	if text == "" {
		return nil
	}
	var lines []sourceLine
	for len(text) > 0 {
		i := strings.IndexByte(text, '\n')
		if i < 0 {
			lines = append(lines, sourceLine{text: text})
			break
		}
		line, eol := text[:i], "\n"
		if strings.HasSuffix(line, "\r") {
			line = strings.TrimSuffix(line, "\r")
			eol = "\r\n"
		}
		lines = append(lines, sourceLine{text: line, eol: eol})
		text = text[i+1:]
	}
	return lines
}

func validateSupportedDiff(diff string) error {
	lines := splitSourceLines(diff)
	if err := validateSupportedDiffLines(lines); err != nil {
		return err
	}
	layout := analyzeDiff(lines)
	if len(layout.problems) > 0 {
		return joinEditPlanErrors(layout.problems)
	}
	return nil
}

func isGitDiffHeader(line string) bool {
	return strings.HasPrefix(line, "diff --git ")
}

func validateSupportedDiffLines(lines []sourceLine) error {
	inPatch := false
	for i, line := range lines {
		switch {
		case isFormatPatchSignature(line.text):
			inPatch = false
		case strings.HasPrefix(line.text, "diff --cc "), strings.HasPrefix(line.text, "diff --combined "):
			return fmt.Errorf("combined diff on line %d is unsupported; use a normal first-parent or two-tree diff", i+1)
		case isGitDiffHeader(line.text):
			inPatch = true
		case isRawOldFileHeader(lines, i):
			inPatch = true
		}
		if inPatch && strings.HasPrefix(line.text, "@@@") {
			return fmt.Errorf("combined diff hunk on line %d is unsupported; use a normal first-parent or two-tree diff", i+1)
		}
	}
	return nil
}

// numberedDiff adds a display-only 1-based line-number gutter for the model.
// The gutter is not part of the source and is never copied into the result.
func numberedDiff(diff string) string {
	lines := splitSourceLines(diff)
	if len(lines) == 0 {
		return ""
	}
	width := len(strconv.Itoa(len(lines)))
	var b strings.Builder
	for i, line := range lines {
		fmt.Fprintf(&b, "%*d|%s\n", width, i+1, line.text)
	}
	return b.String()
}

func containingHunk(layout diffLayout, line int) (start, end int) {
	start = line
	for start > 0 && layout.kinds[start] != diffLineHunkHeader {
		start--
	}
	if layout.kinds[start] == diffLineHunkHeader {
		start++
	}
	end = line + 1
	for end < len(layout.kinds) {
		kind := layout.kinds[end]
		if kind == diffLineHunkHeader || kind == diffLineHeader || kind == diffLineOldFile || kind == diffLineMailSignature {
			break
		}
		end++
	}
	return start, end
}

func isHunkSource(kind diffLineKind) bool {
	return kind == diffLineHunkContext || kind == diffLineHunkChange
}

// analyzeDiff classifies structural and source lines. Parsed hunk counts are
// important: source such as "-- counter" appears in a diff as "--- counter"
// and must not be mistaken for a file header while the hunk still has lines.
func analyzeDiff(lines []sourceLine) diffLayout {
	layout := diffLayout{
		kinds:       make([]diffLineKind, len(lines)),
		markerOwner: make([]int, len(lines)),
		python:      make([]bool, len(lines)),
		language:    make([]sourceLanguage, len(lines)),
		fileID:      make([]int, len(lines)),
		hunkID:      make([]int, len(lines)),
	}
	for i := range layout.markerOwner {
		layout.markerOwner[i] = -1
		layout.fileID[i] = -1
		layout.hunkID[i] = -1
	}

	var inHunk, countsKnown, hunkProblemReported bool
	var oldRemain, newRemain, hunkHeaderLine int
	var currentLanguage sourceLanguage
	currentFileID := -1
	currentHunkID := -1
	gitFileSection := false
	inFileSection := false
	reportHunkProblem := func(atLine int) {
		if hunkProblemReported {
			return
		}
		layout.problems = append(layout.problems, fmt.Errorf(
			"hunk header on line %d has counts inconsistent with its body near line %d",
			hunkHeaderLine+1, atLine+1,
		))
		hunkProblemReported = true
	}

	for i := 0; i < len(lines); {
		text := lines[i].text
		if !inHunk {
			switch {
			case isGitDiffHeader(text):
				currentFileID++
				gitFileSection = true
				inFileSection = true
				currentLanguage = diffHeaderLanguage(text)
			case isRawOldFileHeader(lines, i):
				if !gitFileSection {
					currentFileID++
				}
				inFileSection = true
				if oldLanguage := fileMarkerLanguage(lines[i].text); oldLanguage != sourceLanguageUnknown {
					currentLanguage = oldLanguage
				}
				if newLanguage := fileMarkerLanguage(lines[i+1].text); newLanguage != sourceLanguageUnknown {
					currentLanguage = newLanguage
				}
			}
		}
		layout.language[i] = currentLanguage
		layout.python[i] = currentLanguage == sourceLanguagePython
		layout.fileID[i] = currentFileID
		if inHunk {
			if !countsKnown && isRawOldFileHeader(lines, i) {
				// A bare/otherwise unparseable @@ header has no counts. Recover at
				// an explicit paired file header rather than making it editable.
				inHunk = false
				continue
			}
			if countsKnown && oldRemain == 0 && newRemain == 0 {
				if isNoNewlineMarker(text) {
					layout.kinds[i] = diffLineNoNewline
					layout.hunkID[i] = currentHunkID
					if i > 0 && isHunkSource(layout.kinds[i-1]) {
						layout.markerOwner[i] = i - 1
					}
					i++
					continue
				}
				if isRawOldFileHeader(lines, i) || isGitDiffHeader(text) || strings.HasPrefix(text, "@@") || isFormatPatchSignature(text) {
					inHunk = false
					continue
				}
				if kind := hunkSourceKind(text); kind != diffLineOther {
					reportHunkProblem(i)
					layout.kinds[i] = kind
					layout.hunkID[i] = currentHunkID
					i++
					continue
				}
				inHunk = false
				continue
			}
			if isNoNewlineMarker(text) {
				layout.kinds[i] = diffLineNoNewline
				layout.hunkID[i] = currentHunkID
				if i > 0 && isHunkSource(layout.kinds[i-1]) {
					layout.markerOwner[i] = i - 1
				}
				i++
				continue
			}

			kind := hunkSourceKind(text)
			if kind != diffLineOther {
				if countsKnown {
					valid := false
					switch text[0] {
					case ' ':
						valid = oldRemain > 0 && newRemain > 0
						if valid {
							oldRemain--
							newRemain--
						}
					case '-':
						valid = oldRemain > 0
						if valid {
							oldRemain--
						}
					case '+':
						valid = newRemain > 0
						if valid {
							newRemain--
						}
					}
					if !valid {
						reportHunkProblem(i)
					}
				}
				layout.kinds[i] = kind
				layout.hunkID[i] = currentHunkID
				i++
				continue
			}

			if countsKnown && (oldRemain != 0 || newRemain != 0) {
				reportHunkProblem(i)
			}
			// Re-run this line through the outer structural classifier.
			inHunk = false
			continue
		}

		switch {
		case isFormatPatchSignature(text):
			layout.kinds[i] = diffLineMailSignature
			inFileSection = false
			gitFileSection = false
			i++
		case isGitDiffHeader(text):
			layout.kinds[i] = diffLineHeader
			i++
		case inFileSection && (strings.HasPrefix(text, "index ") || strings.HasPrefix(text, "similarity index ") || strings.HasPrefix(text, "dissimilarity index ")):
			layout.kinds[i] = diffLineIndex
			i++
		case inFileSection && strings.HasPrefix(text, "rename from "):
			layout.kinds[i] = diffLineRenameFrom
			i++
		case inFileSection && strings.HasPrefix(text, "rename to "):
			layout.kinds[i] = diffLineRenameTo
			i++
		case inFileSection && strings.HasPrefix(text, "copy from "):
			layout.kinds[i] = diffLineCopyFrom
			i++
		case inFileSection && strings.HasPrefix(text, "copy to "):
			layout.kinds[i] = diffLineCopyTo
			i++
		case isRawOldFileHeader(lines, i):
			layout.kinds[i] = diffLineOldFile
			layout.kinds[i+1] = diffLineNewFile
			layout.language[i+1] = currentLanguage
			layout.python[i+1] = currentLanguage == sourceLanguagePython
			layout.fileID[i+1] = currentFileID
			i += 2
		case (inFileSection || text == "@@" || strings.HasPrefix(text, "@@ ")) && strings.HasPrefix(text, "@@"):
			layout.kinds[i] = diffLineHunkHeader
			currentHunkID++
			layout.hunkID[i] = currentHunkID
			oldRemain, newRemain, countsKnown = parseHunkCounts(text)
			inHunk = true
			hunkHeaderLine = i
			hunkProblemReported = false
			i++
		default:
			i++
		}
	}
	if inHunk && countsKnown && (oldRemain != 0 || newRemain != 0) {
		reportHunkProblem(len(lines) - 1)
	}
	return layout
}

func hunkSourceKind(text string) diffLineKind {
	if text == "" {
		return diffLineOther
	}
	switch text[0] {
	case ' ':
		return diffLineHunkContext
	case '+', '-':
		return diffLineHunkChange
	default:
		return diffLineOther
	}
}

func parseHunkCounts(header string) (oldCount, newCount int, ok bool) {
	fields := strings.Fields(header)
	if len(fields) < 4 || fields[0] != "@@" || fields[3] != "@@" {
		return 0, 0, false
	}
	oldCount, ok = parseHunkRange(fields[1], '-')
	if !ok {
		return 0, 0, false
	}
	newCount, ok = parseHunkRange(fields[2], '+')
	return oldCount, newCount, ok
}

func parseHunkRange(field string, sign byte) (int, bool) {
	if len(field) < 2 || field[0] != sign {
		return 0, false
	}
	rangeText := field[1:]
	count := 1
	if comma := strings.IndexByte(rangeText, ','); comma >= 0 {
		var err error
		count, err = strconv.Atoi(rangeText[comma+1:])
		if err != nil || count < 0 {
			return 0, false
		}
		rangeText = rangeText[:comma]
	}
	if _, err := strconv.Atoi(rangeText); err != nil {
		return 0, false
	}
	return count, true
}

func diffHeaderLanguage(line string) sourceLanguage {
	fields := strings.Fields(line)
	if len(fields) < 4 {
		return sourceLanguageUnknown
	}
	var language sourceLanguage
	for _, field := range fields[2:] {
		candidate := pathLanguage(field)
		if candidate != sourceLanguageUnknown {
			language = candidate
		}
	}
	return language
}

func fileMarkerLanguage(line string) sourceLanguage {
	if len(line) < 4 {
		return sourceLanguageUnknown
	}
	path := strings.TrimSpace(line[4:])
	if tab := strings.IndexByte(path, '\t'); tab >= 0 {
		path = path[:tab]
	}
	return pathLanguage(path)
}

func pathLanguage(path string) sourceLanguage {
	path = strings.ToLower(strings.Trim(path, `"`))
	switch {
	case strings.HasSuffix(path, ".go"):
		return sourceLanguageGo
	case strings.HasSuffix(path, ".py"), strings.HasSuffix(path, ".pyi"):
		return sourceLanguagePython
	case strings.HasSuffix(path, ".js"), strings.HasSuffix(path, ".jsx"),
		strings.HasSuffix(path, ".mjs"), strings.HasSuffix(path, ".cjs"),
		strings.HasSuffix(path, ".ts"), strings.HasSuffix(path, ".tsx"),
		strings.HasSuffix(path, ".mts"), strings.HasSuffix(path, ".cts"):
		return sourceLanguageJavaScript
	case strings.HasSuffix(path, ".rs"):
		return sourceLanguageRust
	case strings.HasSuffix(path, ".c"), strings.HasSuffix(path, ".h"),
		strings.HasSuffix(path, ".cc"), strings.HasSuffix(path, ".hh"),
		strings.HasSuffix(path, ".cpp"), strings.HasSuffix(path, ".hpp"),
		strings.HasSuffix(path, ".cxx"), strings.HasSuffix(path, ".hxx"):
		return sourceLanguageC
	case strings.HasSuffix(path, ".java"), strings.HasSuffix(path, ".kt"), strings.HasSuffix(path, ".kts"):
		return sourceLanguageJava
	default:
		return sourceLanguageUnknown
	}
}

func isRawOldFileHeader(lines []sourceLine, index int) bool {
	return index+1 < len(lines) &&
		isFileMarker(lines[index].text, "---") &&
		isFileMarker(lines[index+1].text, "+++")
}

func isFileMarker(line, marker string) bool {
	return strings.HasPrefix(line, marker+" ") || strings.HasPrefix(line, marker+"\t")
}

func isFormatPatchSignature(line string) bool {
	return line == "-- "
}

func isNoNewlineMarker(line string) bool {
	return line == `\ No newline at end of file`
}

// nextLayoutLine returns the first line at or after start whose kind satisfies
// stop, or len(layout.kinds) when none does.
func nextLayoutLine(layout diffLayout, start int, stop func(diffLineKind) bool) int {
	for i := start; i < len(layout.kinds); i++ {
		if stop(layout.kinds[i]) {
			return i
		}
	}
	return len(layout.kinds)
}
