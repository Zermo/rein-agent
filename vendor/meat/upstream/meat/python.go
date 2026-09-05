// python.go holds the Python-aware plan validators.
//
// These checks keep an abridged Python diff readable and honest: a hidden
// suite owner must not leave a visible body orphaned, delimiter and
// triple-quote balance must survive hidden regions, and local elisions must
// not silently change structural tokens. They are conservative, text-level
// approximations computed per diff side; they reject plans rather than guess.

package meat

import (
	"fmt"
	"strings"
)

func changesPythonBoundaryTokens(old, new string) bool {
	for _, token := range []string{"(", ")", "[", "]", "{", "}", `'''`, `"""`} {
		if strings.Count(old, token) != strings.Count(new, token) {
			return true
		}
	}
	return false
}

func validateHiddenPythonOwners(lines []sourceLine, layout diffLayout, state planState) error {
	var problems []error
	for i, line := range lines {
		if !state.hidden[i] || !layout.python[i] || !isHunkSource(layout.kinds[i]) || len(line.text) < 2 || line.text[0] == '-' {
			continue
		}
		if pythonTripleStateBeforeLine(lines, layout, i) != pythonTripleNone {
			continue
		}
		body := line.text[1:]
		trimmed := trimPythonCode(body)
		indent := len(leadingWhitespace(body))
		switch {
		case strings.HasPrefix(trimmed, "@"):
			if hasPythonDefinitionAfter(lines, layout, nil, i, indent) && hasPythonDefinitionAfter(lines, layout, &state, i, indent) {
				problems = append(problems, fmt.Errorf("remove/fold: hides Python decorator on line %d while its definition remains visible", i+1))
			}
		case isPythonSuiteHeaderStart(trimmed):
			if rawEnd, ok := pythonSuiteHeaderEnd(lines, layout, nil, i); ok && hasPythonBodyAfter(lines, layout, nil, rawEnd, indent) && hasPythonBodyAfter(lines, layout, &state, rawEnd, indent) {
				problems = append(problems, fmt.Errorf("remove/fold: hides Python suite owner on line %d while its body remains visible", i+1))
			}
		}
	}
	if len(problems) > 0 {
		return joinEditPlanErrors(problems)
	}
	return nil
}

func hunkHasVisibleChange(layout diffLayout, state planState, start, end int) bool {
	for i := start; i < end; i++ {
		if layout.kinds[i] == diffLineHunkChange && state.represented(i) {
			return true
		}
	}
	return false
}

func validateHiddenPythonBoundaries(lines []sourceLine, layout diffLayout, state planState) error {
	var problems []error
	for hunk, kind := range layout.kinds {
		if kind != diffLineHunkHeader || !layout.python[hunk] {
			continue
		}
		end := nextLayoutLine(layout, hunk+1, func(k diffLineKind) bool {
			return k == diffLineHeader || k == diffLineOldFile || k == diffLineHunkHeader || k == diffLineMailSignature
		})
		if !hunkHasVisibleChange(layout, state, hunk+1, end) {
			continue
		}
		for i := hunk + 1; i < end; {
			if !state.hidden[i] || !isHunkSource(layout.kinds[i]) {
				i++
				continue
			}
			start := i
			for i < end && state.hidden[i] && isHunkSource(layout.kinds[i]) {
				i++
			}
			for _, side := range []byte{'-', '+'} {
				if !hiddenPythonRegionBalanced(lines, layout, hunk+1, start, i, side) {
					sideName := "old"
					if side == '+' {
						sideName = "new"
					}
					problems = append(problems, fmt.Errorf("remove/fold: hidden Python region %d-%d crosses %s-side expression or string boundaries; keep the boundaries and compress only their interior", start+1, i, sideName))
				}
			}
		}
	}
	if len(problems) > 0 {
		return joinEditPlanErrors(problems)
	}
	return nil
}

func hiddenPythonRegionBalanced(lines []sourceLine, layout diffLayout, hunkStart, start, end int, side byte) bool {
	var beforeTriple pythonTripleState
	for i := hunkStart; i < start; i++ {
		if pythonLineOnSide(lines, layout, i, side) {
			scanPythonTripleLine(lines[i].text[1:], &beforeTriple)
		}
	}
	enteredTriple := beforeTriple != pythonTripleNone
	actualTriple := beforeTriple
	localTriple := pythonTripleNone
	tripleTransitions := 0
	var bodies []string
	for i := start; i < end; i++ {
		if !pythonLineOnSide(lines, layout, i, side) {
			continue
		}
		body := lines[i].text[1:]
		bodies = append(bodies, body)
		scanPythonTripleLine(body, &localTriple)
		if enteredTriple {
			tripleTransitions += scanPythonTripleLine(body, &actualTriple)
		}
	}
	if len(bodies) == 0 {
		return true
	}
	trimmedFirst := strings.TrimSpace(bodies[0])
	startsWithBareTriple := trimmedFirst == `"""` || trimmedFirst == `'''`
	if enteredTriple && tripleTransitions > 0 && (localTriple != pythonTripleNone || startsWithBareTriple) {
		return false
	}
	if !enteredTriple && localTriple != pythonTripleNone {
		return false
	}

	delimiterTriple := pythonTripleNone
	if enteredTriple && tripleTransitions == 0 {
		delimiterTriple = beforeTriple
	}
	var balance pythonDelimiters
	for _, body := range bodies {
		balance = balance.add(pythonDelimiterBalanceWithState(body, &delimiterTriple))
		if balance.round < 0 || balance.square < 0 || balance.curly < 0 {
			return false
		}
	}
	return balance == (pythonDelimiters{})
}

func pythonLineOnSide(lines []sourceLine, layout diffLayout, line int, side byte) bool {
	if !isHunkSource(layout.kinds[line]) || len(lines[line].text) < 2 {
		return false
	}
	return lines[line].text[0] == ' ' || lines[line].text[0] == side
}

func pythonNewSideStates(lines []sourceLine, layout diffLayout) (insideTriple []bool, depthBefore []int) {
	insideTriple = make([]bool, len(lines))
	depthBefore = make([]int, len(lines))
	for hunk, kind := range layout.kinds {
		if kind != diffLineHunkHeader || !layout.python[hunk] {
			continue
		}
		end := nextLayoutLine(layout, hunk+1, func(k diffLineKind) bool {
			return k == diffLineHeader || k == diffLineOldFile || k == diffLineHunkHeader || k == diffLineMailSignature
		})
		var triple pythonTripleState
		var delimiters pythonDelimiters
		for i := hunk + 1; i < end; i++ {
			if !isHunkSource(layout.kinds[i]) || len(lines[i].text) < 2 || lines[i].text[0] == '-' {
				continue
			}
			insideTriple[i] = triple != pythonTripleNone
			depthBefore[i] = delimiters.round + delimiters.square + delimiters.curly
			delimiters = delimiters.add(pythonDelimiterBalanceWithState(lines[i].text[1:], &triple))
			// A hunk can start in the middle of an expression, with context
			// that closes delimiters opened above the hunk. Those unmatched
			// closers describe invisible source, not negative nesting for the
			// rest of this hunk. Clamp each delimiter kind independently so a
			// later top-level assignment still receives reference protection.
			if delimiters.round < 0 {
				delimiters.round = 0
			}
			if delimiters.square < 0 {
				delimiters.square = 0
			}
			if delimiters.curly < 0 {
				delimiters.curly = 0
			}
		}
	}
	return insideTriple, depthBefore
}

func validateHiddenReferences(lines []sourceLine, layout diffLayout, state planState) error {
	insideTriple, depthBefore := pythonNewSideStates(lines, layout)
	var problems []error
	for i, line := range lines {
		if !state.hidden[i] || !layout.python[i] || !isHunkSource(layout.kinds[i]) || len(line.text) < 2 || line.text[0] == '-' {
			continue
		}
		if insideTriple[i] || depthBefore[i] != 0 {
			continue
		}
		name, ok := simpleAssignedReference(pythonCodeWithoutStrings(line.text[1:]))
		if !ok {
			continue
		}
		fileID := layout.fileID[i]
		for j := 0; j < len(lines); j++ {
			if layout.fileID[j] != fileID || state.hidden[j] || !isHunkSource(layout.kinds[j]) || len(lines[j].text) < 2 {
				continue
			}
			if line.text[0] == '+' && lines[j].text[0] == '-' {
				continue
			}
			if insideTriple[j] {
				continue
			}
			body := pythonCodeWithoutStrings(lines[j].text[1:])
			if !containsIdentifier(body, name) {
				continue
			}
			if foldIndex := state.folded[i]; foldIndex >= 0 {
				problems = append(problems, fmt.Errorf("fold[%d]: hides definition %q on line %d while retained line %d still references it; keep the definition and fold only its interior", foldIndex, name, i+1, j+1))
			} else {
				problems = append(problems, fmt.Errorf("remove: hides definition %q on line %d while retained line %d still references it; keep the definition and compress only its interior", name, i+1, j+1))
			}
			break
		}
	}
	if len(problems) > 0 {
		return joinEditPlanErrors(problems)
	}
	return nil
}

func validatePythonSuiteSkeleton(lines []sourceLine, layout diffLayout, state planState) error {
	var problems []error
	for i, line := range lines {
		if !layout.python[i] || state.hidden[i] || !isHunkSource(layout.kinds[i]) || len(line.text) < 2 || line.text[0] == '-' {
			continue
		}
		if pythonTripleStateBeforeLine(lines, layout, i) != pythonTripleNone {
			continue
		}
		body := line.text[1:]
		trimmed := trimPythonCode(body)
		if strings.HasPrefix(trimmed, "@") {
			indent := len(leadingWhitespace(body))
			if hasPythonDefinitionAfter(lines, layout, nil, i, indent) && !hasPythonDefinitionAfter(lines, layout, &state, i, indent) {
				problems = append(problems, fmt.Errorf("remove/fold: retained Python decorator on line %d has no attached definition", i+1))
			}
			continue
		}
		if !isPythonSuiteHeaderStart(trimmed) {
			continue
		}
		rawEnd, rawOK := pythonSuiteHeaderEnd(lines, layout, nil, i)
		if !rawOK {
			continue
		}
		ownerIndent := len(leadingWhitespace(body))
		if hasPythonBodyAfter(lines, layout, nil, rawEnd, ownerIndent) {
			retainedEnd, retainedOK := pythonSuiteHeaderEnd(lines, layout, &state, i)
			if !retainedOK || !hasPythonBodyAfter(lines, layout, &state, retainedEnd, ownerIndent) {
				problems = append(problems, fmt.Errorf("remove/fold: retained Python suite owner on line %d has no indented body; keep a semantic body line or an interior fold", i+1))
			}
		}
	}
	if len(problems) > 0 {
		return joinEditPlanErrors(problems)
	}
	return nil
}

func pythonSuiteHeaderEnd(lines []sourceLine, layout diffLayout, state *planState, start int) (int, bool) {
	_, hunkEnd := containingHunk(layout, start)
	depth := 0
	for i := start; i < hunkEnd; i++ {
		if state != nil {
			if state.foldAt[i] >= 0 {
				continue
			}
			if state.hidden[i] {
				continue
			}
		}
		if !isHunkSource(layout.kinds[i]) || len(lines[i].text) < 2 || lines[i].text[0] == '-' {
			continue
		}
		body := lines[i].text[1:]
		trimmed := trimPythonCode(body)
		if trimmed == "" {
			continue
		}
		depth += pythonDelimiterDepth(body)
		if depth < 0 {
			return 0, false
		}
		if depth == 0 && strings.HasSuffix(trimmed, ":") {
			return i, true
		}
	}
	return 0, false
}

func hasPythonBodyAfter(lines []sourceLine, layout diffLayout, state *planState, ownerLine, indent int) bool {
	_, hunkEnd := containingHunk(layout, ownerLine)
	for i := ownerLine + 1; i < hunkEnd; i++ {
		if state != nil {
			if foldIndex := state.foldAt[i]; foldIndex >= 0 {
				fold := state.folds[foldIndex]
				if fold.marker == '-' {
					continue
				}
				return (fold.marker == '+' || fold.marker == ' ') && len(fold.indent) > indent
			}
			if state.hidden[i] {
				continue
			}
		}
		if !isHunkSource(layout.kinds[i]) || len(lines[i].text) < 2 || lines[i].text[0] == '-' {
			continue
		}
		body := lines[i].text[1:]
		if trimPythonCode(body) == "" {
			continue
		}
		return len(leadingWhitespace(body)) > indent
	}
	return false
}

func hasPythonDefinitionAfter(lines []sourceLine, layout diffLayout, state *planState, decoratorLine, indent int) bool {
	_, hunkEnd := containingHunk(layout, decoratorLine)
	depth := pythonDelimiterDepth(lines[decoratorLine].text[1:])
	for i := decoratorLine + 1; i < hunkEnd; i++ {
		if state != nil {
			if state.foldAt[i] >= 0 {
				continue
			}
			if state.hidden[i] {
				continue
			}
		}
		if !isHunkSource(layout.kinds[i]) || len(lines[i].text) < 2 || lines[i].text[0] == '-' {
			continue
		}
		body := lines[i].text[1:]
		trimmed := trimPythonCode(body)
		if trimmed == "" {
			continue
		}
		if depth > 0 {
			depth += pythonDelimiterDepth(body)
			if depth < 0 {
				return false
			}
			continue
		}
		if len(leadingWhitespace(body)) != indent {
			return false
		}
		if strings.HasPrefix(trimmed, "@") {
			depth = pythonDelimiterDepth(body)
			continue
		}
		return isPythonDefinition(trimmed)
	}
	return false
}

func isPythonDefinition(trimmed string) bool {
	trimmed = trimPythonCode(trimmed)
	return strings.HasPrefix(trimmed, "def ") || strings.HasPrefix(trimmed, "async def ") || strings.HasPrefix(trimmed, "class ")
}

type pythonDelimiters struct {
	round  int
	square int
	curly  int
}

func (d pythonDelimiters) add(other pythonDelimiters) pythonDelimiters {
	return pythonDelimiters{d.round + other.round, d.square + other.square, d.curly + other.curly}
}

func (d pythonDelimiters) equal(other pythonDelimiters) bool {
	return d == other
}

func pythonDelimiterDepth(text string) int {
	d := pythonDelimiterBalance(text)
	return d.round + d.square + d.curly
}

func pythonDelimiterBalance(text string) pythonDelimiters {
	state := pythonTripleNone
	return pythonDelimiterBalanceWithState(text, &state)
}

func pythonDelimiterBalanceWithState(text string, state *pythonTripleState) pythonDelimiters {
	var balance pythonDelimiters
	for i := 0; i < len(text); {
		if *state != pythonTripleNone {
			delim := `'''`
			if *state == pythonTripleDouble {
				delim = `"""`
			}
			at := strings.Index(text[i:], delim)
			if at < 0 {
				return balance
			}
			i += at + len(delim)
			*state = pythonTripleNone
			continue
		}
		b := text[i]
		if b == '#' {
			break
		}
		if strings.HasPrefix(text[i:], `'''`) {
			*state = pythonTripleSingle
			i += 3
			continue
		}
		if strings.HasPrefix(text[i:], `"""`) {
			*state = pythonTripleDouble
			i += 3
			continue
		}
		if b == '\'' || b == '"' {
			quote := b
			i++
			for i < len(text) {
				if text[i] == '\\' {
					i += 2
					continue
				}
				if text[i] == quote {
					i++
					break
				}
				i++
			}
			continue
		}
		switch b {
		case '(':
			balance.round++
		case ')':
			balance.round--
		case '[':
			balance.square++
		case ']':
			balance.square--
		case '{':
			balance.curly++
		case '}':
			balance.curly--
		}
		i++
	}
	return balance
}

func validatePythonDelimiterBalance(lines []sourceLine, layout diffLayout, state planState, replacements map[int][]plannedReplacement) error {
	var problems []error
	for i, kind := range layout.kinds {
		if kind != diffLineHunkHeader || !layout.python[i] {
			continue
		}
		end := nextLayoutLine(layout, i+1, func(k diffLineKind) bool {
			return k == diffLineHeader || k == diffLineOldFile || k == diffLineHunkHeader || k == diffLineMailSignature
		})
		if !hunkHasVisibleChange(layout, state, i+1, end) {
			continue
		}
		var rawOld, rawNew, keptOld, keptNew pythonDelimiters
		var rawOldTriple, rawNewTriple, keptOldTriple, keptNewTriple pythonTripleState
		for j := i + 1; j < end; j++ {
			if !isHunkSource(layout.kinds[j]) || len(lines[j].text) < 1 {
				continue
			}
			body := lines[j].text[1:]
			keptBody := body
			if edits := replacements[j+1]; len(edits) > 0 {
				keptBody = applyPlannedReplacements(body, edits)
			}
			switch lines[j].text[0] {
			case ' ':
				rawOld = rawOld.add(pythonDelimiterBalanceWithState(body, &rawOldTriple))
				rawNew = rawNew.add(pythonDelimiterBalanceWithState(body, &rawNewTriple))
				if !state.hidden[j] {
					keptOld = keptOld.add(pythonDelimiterBalanceWithState(keptBody, &keptOldTriple))
					keptNew = keptNew.add(pythonDelimiterBalanceWithState(keptBody, &keptNewTriple))
				}
			case '-':
				rawOld = rawOld.add(pythonDelimiterBalanceWithState(body, &rawOldTriple))
				if !state.hidden[j] {
					keptOld = keptOld.add(pythonDelimiterBalanceWithState(keptBody, &keptOldTriple))
				}
			case '+':
				rawNew = rawNew.add(pythonDelimiterBalanceWithState(body, &rawNewTriple))
				if !state.hidden[j] {
					keptNew = keptNew.add(pythonDelimiterBalanceWithState(keptBody, &keptNewTriple))
				}
			}
		}
		if !rawOld.equal(keptOld) || !rawNew.equal(keptNew) {
			problems = append(problems, fmt.Errorf("remove/fold: hunk on line %d must preserve Python (), [], and {} delimiter balance; keep both boundaries or fold/remove the complete balanced expression", i+1))
		}
	}
	if len(problems) > 0 {
		return joinEditPlanErrors(problems)
	}
	return nil
}

func validatePythonBackslashContinuations(lines []sourceLine, layout diffLayout, state planState, replacements map[int][]plannedReplacement) error {
	var problems []error
	for hunk, kind := range layout.kinds {
		if kind != diffLineHunkHeader || !layout.python[hunk] {
			continue
		}
		end := nextLayoutLine(layout, hunk+1, func(k diffLineKind) bool {
			return k == diffLineHeader || k == diffLineOldFile || k == diffLineHunkHeader || k == diffLineMailSignature
		})
		if !hunkHasVisibleChange(layout, state, hunk+1, end) {
			continue
		}
		for _, side := range []byte{'-', '+'} {
			var sideLines []int
			for i := hunk + 1; i < end; i++ {
				if pythonLineOnSide(lines, layout, i, side) {
					sideLines = append(sideLines, i)
				}
			}
			var triple pythonTripleState
			for i := 0; i+1 < len(sideLines); i++ {
				line := sideLines[i]
				next := sideLines[i+1]
				body := lines[line].text[1:]
				insideTriple := triple != pythonTripleNone
				scanPythonTripleLine(body, &triple)
				if insideTriple || !endsPythonBackslash(body) {
					continue
				}
				lineHidden := state.hidden[line]
				nextHidden := state.hidden[next]
				if !lineHidden {
					keptBody := body
					if edits := replacements[line+1]; len(edits) > 0 {
						keptBody = applyPlannedReplacements(body, edits)
					}
					if !endsPythonBackslash(keptBody) {
						continue
					}
				}
				if lineHidden != nextHidden {
					problems = append(problems, fmt.Errorf("remove/fold: Python backslash continuation on lines %d-%d must be retained or hidden together", line+1, next+1))
				}
			}
		}
	}
	if len(problems) > 0 {
		return joinEditPlanErrors(problems)
	}
	return nil
}

func endsPythonBackslash(body string) bool {
	code := trimPythonCode(body)
	count := 0
	for i := len(code) - 1; i >= 0 && code[i] == '\\'; i-- {
		count++
	}
	return count%2 == 1
}

type pythonTripleState uint8

const (
	pythonTripleNone pythonTripleState = iota
	pythonTripleSingle
	pythonTripleDouble
)

func scanPythonTripleLine(text string, state *pythonTripleState) int {
	transitions := 0
	for i := 0; i < len(text); {
		if *state != pythonTripleNone {
			delim := `'''`
			if *state == pythonTripleDouble {
				delim = `"""`
			}
			at := strings.Index(text[i:], delim)
			if at < 0 {
				return transitions
			}
			i += at + len(delim)
			*state = pythonTripleNone
			transitions++
			continue
		}
		if text[i] == '#' {
			return transitions
		}
		if strings.HasPrefix(text[i:], `'''`) {
			*state = pythonTripleSingle
			transitions++
			i += 3
			continue
		}
		if strings.HasPrefix(text[i:], `"""`) {
			*state = pythonTripleDouble
			transitions++
			i += 3
			continue
		}
		if text[i] == '\'' || text[i] == '"' {
			quote := text[i]
			i++
			for i < len(text) {
				if text[i] == '\\' {
					i += 2
					continue
				}
				if text[i] == quote {
					i++
					break
				}
				i++
			}
			continue
		}
		i++
	}
	return transitions
}

func validateTripleQuoteParity(lines []sourceLine, layout diffLayout, state planState, replacements map[int][]plannedReplacement) error {
	var problems []error
	for i, kind := range layout.kinds {
		if kind != diffLineHunkHeader || !layout.python[i] {
			continue
		}
		end := nextLayoutLine(layout, i+1, func(k diffLineKind) bool {
			return k == diffLineHeader || k == diffLineOldFile || k == diffLineHunkHeader || k == diffLineMailSignature
		})
		if !hunkHasVisibleChange(layout, state, i+1, end) {
			continue
		}
		var rawOld, rawNew, keptOld, keptNew pythonTripleState
		for j := i + 1; j < end; j++ {
			if !isHunkSource(layout.kinds[j]) || len(lines[j].text) < 1 {
				continue
			}
			body := lines[j].text[1:]
			keptBody := body
			if edits := replacements[j+1]; len(edits) > 0 {
				keptBody = applyPlannedReplacements(body, edits)
			}
			switch lines[j].text[0] {
			case ' ':
				scanPythonTripleLine(body, &rawOld)
				scanPythonTripleLine(body, &rawNew)
				if !state.hidden[j] {
					scanPythonTripleLine(keptBody, &keptOld)
					scanPythonTripleLine(keptBody, &keptNew)
				}
			case '-':
				scanPythonTripleLine(body, &rawOld)
				if !state.hidden[j] {
					scanPythonTripleLine(keptBody, &keptOld)
				}
			case '+':
				scanPythonTripleLine(body, &rawNew)
				if !state.hidden[j] {
					scanPythonTripleLine(keptBody, &keptNew)
				}
			}
		}
		if rawOld != keptOld || rawNew != keptNew {
			problems = append(problems, fmt.Errorf("remove/fold: hunk on line %d must preserve balanced Python triple-quote boundaries; fold or remove the complete string, or keep both boundaries", i+1))
		}
	}
	if len(problems) > 0 {
		return joinEditPlanErrors(problems)
	}
	return nil
}

func pythonCodeWithoutStrings(text string) string {
	var b strings.Builder
	for i := 0; i < len(text); {
		if text[i] == '#' {
			break
		}
		if strings.HasPrefix(text[i:], `'''`) || strings.HasPrefix(text[i:], `"""`) {
			break
		}
		if text[i] == '\'' || text[i] == '"' {
			quote := text[i]
			i++
			for i < len(text) {
				if text[i] == '\\' {
					i += 2
					continue
				}
				if text[i] == quote {
					i++
					break
				}
				i++
			}
			continue
		}
		b.WriteByte(text[i])
		i++
	}
	return b.String()
}

func trimPythonCode(text string) string {
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
		if b == '\'' || b == '"' {
			quote = b
			continue
		}
		if b == '#' {
			return strings.TrimSpace(text[:i])
		}
	}
	return strings.TrimSpace(text)
}

func isPythonSuiteHeaderStart(trimmed string) bool {
	trimmed = trimPythonCode(trimmed)
	if isPythonDefinition(trimmed) {
		return true
	}
	for _, keyword := range []string{"if", "elif", "for", "while", "with", "except", "except*", "match", "case"} {
		if hasPythonKeyword(trimmed, keyword) {
			return true
		}
	}
	for _, keyword := range []string{"async for", "async with"} {
		if strings.HasPrefix(trimmed, keyword+" ") || strings.HasPrefix(trimmed, keyword+"(") {
			return true
		}
	}
	switch trimmed {
	case "else:", "try:", "except:", "finally:":
		return true
	default:
		return false
	}
}

func hasPythonKeyword(text, keyword string) bool {
	if !strings.HasPrefix(text, keyword) || len(text) == len(keyword) {
		return false
	}
	next := text[len(keyword)]
	return next == ' ' || next == '\t' || next == '('
}

func isPythonSuiteOwner(trimmed string) bool {
	trimmed = trimPythonCode(trimmed)
	return isPythonSuiteHeaderStart(trimmed) && strings.HasSuffix(trimmed, ":")
}

func pythonTripleStateBeforeLine(lines []sourceLine, layout diffLayout, line int) pythonTripleState {
	hunkStart, _ := containingHunk(layout, line)
	var state pythonTripleState
	for i := hunkStart; i < line; i++ {
		if !isHunkSource(layout.kinds[i]) || len(lines[i].text) < 2 || lines[i].text[0] == '-' {
			continue
		}
		scanPythonTripleLine(lines[i].text[1:], &state)
	}
	return state
}

func simpleAssignedReference(body string) (string, bool) {
	trimmed := strings.TrimSpace(body)
	eq := strings.IndexByte(trimmed, '=')
	if eq <= 0 || eq+1 < len(trimmed) && trimmed[eq+1] == '=' {
		return "", false
	}
	lhs := strings.TrimSpace(trimmed[:eq])
	if colon := strings.IndexByte(lhs, ':'); colon >= 0 {
		lhs = strings.TrimSpace(lhs[:colon])
	}
	if lhs == "" {
		return "", false
	}
	for _, segment := range strings.Split(lhs, ".") {
		if segment == "" || !isIdentifierStart(segment[0]) {
			return "", false
		}
		for i := 1; i < len(segment); i++ {
			if !isIdentifierContinue(segment[i]) {
				return "", false
			}
		}
	}
	return lhs, true
}

func containsIdentifier(text, name string) bool {
	for offset := 0; offset <= len(text)-len(name); {
		at := strings.Index(text[offset:], name)
		if at < 0 {
			return false
		}
		at += offset
		beforeOK := at == 0 || !isIdentifierContinue(text[at-1])
		after := at + len(name)
		afterOK := after == len(text) || !isIdentifierContinue(text[after])
		if beforeOK && afterOK {
			return true
		}
		offset = at + 1
	}
	return false
}
