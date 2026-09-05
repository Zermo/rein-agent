package meat

import (
	"fmt"
	"sort"
	"strings"
)

// ElisionLine returns a one-line, machine-computed manifest of how much of the
// raw diff survived abridging, e.g.
//
//	kept 12/240 changed lines in 3/7 files
//
// It is computed locally by counting +/- lines and per-file headers in both
// diffs rather than trusting model-reported counts, so the reviewer can always
// see, at a glance, how much they are NOT reading. When the abridged diff kept
// no per-file headers the file counts are omitted.
func ElisionLine(raw, abridged string) string {
	rawLines, rawFiles := diffStats(raw)
	keptLines, keptFiles := retainedDiffStats(raw, abridged)
	if rawLines == 0 {
		return ""
	}
	if strings.TrimSpace(abridged) == "" {
		return fmt.Sprintf("elided all %d changed lines in %d files", rawLines, rawFiles)
	}
	if keptFiles > 0 && rawFiles > 0 {
		return fmt.Sprintf("kept %d/%d changed lines in %d/%d files", keptLines, rawLines, keptFiles, rawFiles)
	}
	return fmt.Sprintf("kept %d/%d changed lines", keptLines, rawLines)
}

// diffStats counts changed source lines and per-file "diff " headers. It uses
// the same hunk-aware classifier as edit validation so source such as
// "-- counter" / "++ counter" is not mistaken for ---/+++ metadata.
func diffStats(diff string) (changed, files int) {
	layout := analyzeDiff(splitSourceLines(diff))
	for _, kind := range layout.kinds {
		switch kind {
		case diffLineHunkChange:
			changed++
		case diffLineHeader:
			files++
		}
	}
	return changed, files
}

// retainedDiffStats aligns the reading diff back to original physical lines.
// This avoids reparsing deliberately stale @@ counts after lines were removed.
// Exact lines use an indexed lookup; locally elided source lines match through
// one precompiled source-projection validator per kept line.
func retainedDiffStats(raw, abridged string) (changed, files int) {
	rawLines := splitSourceLines(raw)
	keptLines := splitSourceLines(abridged)
	rawLayout := analyzeDiff(rawLines)
	keptLayout := analyzeDiff(keptLines)

	// Most reading-diff rows are exact source rows. Index them once so a
	// malformed or divergent abridgement cannot turn alignment into a full
	// forward scan for every kept line.
	exactPositions := make(map[readingLineKey][]int, len(rawLines))
	for i, line := range rawLines {
		key := readingLineKey{kind: rawLayout.kinds[i], text: line.text}
		exactPositions[key] = append(exactPositions[key], i)
	}

	rawPos := 0
	for keptIndex, kept := range keptLines {
		if isFixedFoldLine(kept.text) {
			if kept.text[0] == '+' || kept.text[0] == '-' {
				changed++
			}
			continue
		}

		keptKind := keptLayout.kinds[keptIndex]
		exactAt := nextReadingLineAtOrAfter(exactPositions[readingLineKey{kind: keptKind, text: kept.text}], rawPos)
		matchedAt := exactAt

		// A locally elided line may project from an earlier raw row than an
		// identical literal line later in the diff. Preserve the old greedy
		// alignment semantics, but compile its matcher only once and stop at
		// the indexed exact match when one exists.
		if isHunkSource(keptKind) && len(kept.text) > 1 && containsElisionPlaceholder(kept.text[1:]) {
			if re, ok := compileElisionProjection(kept.text[1:], false); ok {
				end := len(rawLines)
				if exactAt >= 0 {
					end = exactAt
				}
				for i := rawPos; i < end; i++ {
					if rawLayout.kinds[i] != keptKind || len(rawLines[i].text) < 1 || rawLines[i].text[0] != kept.text[0] {
						continue
					}
					if re.MatchString(rawLines[i].text[1:]) {
						matchedAt = i
						break
					}
				}
			}
		}
		if matchedAt < 0 {
			continue
		}
		switch rawLayout.kinds[matchedAt] {
		case diffLineHunkChange:
			changed++
		case diffLineHeader:
			files++
		}
		rawPos = matchedAt + 1
	}
	return changed, files
}

type readingLineKey struct {
	kind diffLineKind
	text string
}

func nextReadingLineAtOrAfter(positions []int, min int) int {
	i := sort.SearchInts(positions, min)
	if i == len(positions) {
		return -1
	}
	return positions[i]
}

func containsElisionPlaceholder(text string) bool {
	return strings.Contains(text, "...") || strings.ContainsRune(text, '…')
}

func isFixedFoldLine(line string) bool {
	if len(line) < 2 || (line[0] != '+' && line[0] != '-' && line[0] != ' ') {
		return false
	}
	return strings.TrimSpace(line[1:]) == "..."
}
