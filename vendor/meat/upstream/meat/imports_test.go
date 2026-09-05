package meat

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestCompileEditPlan_MandatoryImportsByLanguage(t *testing.T) {
	tests := []struct {
		name     string
		diff     string
		want     []string
		unwanted []string
	}{
		{
			name:     "Go import block",
			diff:     "diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@\n+package a\n+\n+import (\n+\t\"fmt\"\n+\talias \"example.com/a\"\n+)\n+\n+func run() { fmt.Println(alias.Value) }\n",
			want:     []string{"+package a", "+func run()"},
			unwanted: []string{"import (", `"fmt"`, `"example.com/a"`, "+)"},
		},
		{
			name:     "Python import and multiline from import",
			diff:     "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@\n+from package.tools import (\n+    first,\n+    second as renamed,\n+)\n+import os, sys\n+\n+value = first(renamed, os.name, sys.version)\n",
			want:     []string{"+value = first"},
			unwanted: []string{"from package.tools import", "second as renamed", "import os, sys"},
		},
		{
			name:     "JavaScript static import and multiline require",
			diff:     "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@\n+import {\n+  first,\n+  second,\n+} from \"./tools\";\n+const {\n+  third,\n+} = require(\"./more\");\n+\n+export const value = first(second, third);\n",
			want:     []string{"+export const value"},
			unwanted: []string{"import {", `from "./tools"`, "const {", `require("./more")`},
		},
		{
			name:     "Rust use declarations",
			diff:     "diff --git a/a.rs b/a.rs\n--- a/a.rs\n+++ b/a.rs\n@@\n+use crate::{\n+    first,\n+    second,\n+};\n+pub(crate) use other::Third;\n+\n+fn run() { first(second(), Third); }\n",
			want:     []string{"+fn run()"},
			unwanted: []string{"use crate", "pub(crate) use", "+};"},
		},
		{
			name:     "C and C++ includes",
			diff:     "diff --git a/a.cpp b/a.cpp\n--- a/a.cpp\n+++ b/a.cpp\n@@\n+#include <vector>\n+# include \"local.h\"\n+\n+int run() { return local_value(); }\n",
			want:     []string{"+int run()"},
			unwanted: []string{"#include", `# include "local.h"`},
		},
		{
			name:     "Java imports",
			diff:     "diff --git a/A.java b/A.java\n--- a/A.java\n+++ b/A.java\n@@\n+package example;\n+import java.util.List;\n+import static java.util.Collections.emptyList;\n+class A { List<String> run() { return emptyList(); } }\n",
			want:     []string{"+package example", "+class A"},
			unwanted: []string{"import java.util", "import static"},
		},
		{
			name:     "Kotlin imports",
			diff:     "diff --git a/A.kt b/A.kt\n--- a/A.kt\n+++ b/A.kt\n@@\n+package example\n+import tools.first\n+import tools.second as renamed\n+fun run() = first(renamed)\n",
			want:     []string{"+package example", "+fun run()"},
			unwanted: []string{"import tools.first", "import tools.second"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			lines := splitSourceLines(tc.diff)
			layout := analyzeDiff(lines)
			first := mandatoryImportRemovalPlan(lines, layout)
			second := mandatoryImportRemovalPlan(lines, layout)
			if len(first) == 0 || !reflect.DeepEqual(first, second) {
				t.Fatalf("mandatory plan is empty or nondeterministic: first=%+v second=%+v", first, second)
			}
			compiled, err := compileEditPlan(tc.diff, editPlan{})
			if err != nil {
				t.Fatal(err)
			}
			for _, want := range tc.want {
				if !strings.Contains(compiled.smartDiff, want) {
					t.Errorf("reading diff missing %q:\n%s", want, compiled.smartDiff)
				}
			}
			for _, unwanted := range tc.unwanted {
				if strings.Contains(compiled.smartDiff, unwanted) {
					t.Errorf("reading diff retained import scaffolding %q:\n%s", unwanted, compiled.smartDiff)
				}
			}
		})
	}
}

func TestCompileEditPlan_MandatoryImportsCoverBothDiffSides(t *testing.T) {
	raw := "diff --git a/token.go b/token.go\n--- a/token.go\n+++ b/token.go\n@@\n package token\n import (\n \t\"fmt\"\n-\t\"math/rand\"\n+\t\"crypto/rand\"\n+\t\"encoding/hex\"\n )\n-old := fmt.Sprintf(\"%x\", value)\n+new := hex.EncodeToString(value)\n"
	compiled, err := compileEditPlan(raw, editPlan{})
	if err != nil {
		t.Fatal(err)
	}
	for _, unwanted := range []string{"import (", `"fmt"`, `"math/rand"`, `"crypto/rand"`, `"encoding/hex"`, " )"} {
		if strings.Contains(compiled.smartDiff, unwanted) {
			t.Errorf("old/new import scaffolding %q survived:\n%s", unwanted, compiled.smartDiff)
		}
	}
	for _, want := range []string{"-old := fmt.Sprintf", "+new := hex.EncodeToString"} {
		if !strings.Contains(compiled.smartDiff, want) {
			t.Errorf("behavior %q was lost:\n%s", want, compiled.smartDiff)
		}
	}
}

func TestCompileEditPlan_MandatoryEmbeddedSourceImports(t *testing.T) {
	raw := "diff --git a/test_plugin.py b/test_plugin.py\n--- a/test_plugin.py\n+++ b/test_plugin.py\n@@\n+def test_plugin(pytester):\n+    pytester.makeconftest(\n+        \"\"\"\n+        from plugin import (\n+            hook,\n+            option,\n+        )\n+        import warnings\n+        import pytest\n+\n+        @pytest.hookimpl(tryfirst=True)\n+        def pytest_configure():\n+            warnings.warn(option, UserWarning)\n+        \"\"\"\n+    )\n+    result = pytester.runpytest()\n+    assert result.ret == 0\n"
	compiled, err := compileEditPlan(raw, editPlan{})
	if err != nil {
		t.Fatal(err)
	}
	for _, unwanted := range []string{"from plugin import", "+            hook,", "+            option,", "import warnings", "import pytest"} {
		if strings.Contains(compiled.smartDiff, unwanted) {
			t.Errorf("embedded import %q survived:\n%s", unwanted, compiled.smartDiff)
		}
	}
	for _, want := range []string{"+        @pytest.hookimpl", "+        def pytest_configure", "+            warnings.warn", "+    result = pytester.runpytest"} {
		if !strings.Contains(compiled.smartDiff, want) {
			t.Errorf("embedded behavior %q was lost:\n%s", want, compiled.smartDiff)
		}
	}

	goFixture := "diff --git a/plugin_test.go b/plugin_test.go\n--- a/plugin_test.go\n+++ b/plugin_test.go\n@@\n+const fixture = `\n+import pytest\n+const helper = require(\"./helper\").default;\n+use analytics;\n+#include examples\n+run(helper)\n+`\n+func TestFixture() { execute(fixture) }\n"
	compiled, err = compileEditPlan(goFixture, editPlan{})
	if err != nil {
		t.Fatal(err)
	}
	for _, unwanted := range []string{"import pytest", `require("./helper")`} {
		if strings.Contains(compiled.smartDiff, unwanted) {
			t.Errorf("cross-language embedded import %q survived:\n%s", unwanted, compiled.smartDiff)
		}
	}
	for _, want := range []string{"+use analytics;", "+#include examples", "+run(helper)", "+func TestFixture"} {
		if !strings.Contains(compiled.smartDiff, want) {
			t.Errorf("cross-language embedded behavior %q was lost:\n%s", want, compiled.smartDiff)
		}
	}

	truncatedFixture := "diff --git a/generated_test.go b/generated_test.go\n--- a/generated_test.go\n+++ b/generated_test.go\n@@\n+const source = `\n+import (\n+    \"fmt\"\n+`\n+func TestGenerated() { check(source, behavior()) }\n"
	compiled, err = compileEditPlan(truncatedFixture, editPlan{})
	if err != nil {
		t.Fatal(err)
	}
	for _, unwanted := range []string{"import (", `"fmt"`} {
		if strings.Contains(compiled.smartDiff, unwanted) {
			t.Errorf("truncated embedded import %q survived:\n%s", unwanted, compiled.smartDiff)
		}
	}
	for _, want := range []string{"+`", "+func TestGenerated()"} {
		if !strings.Contains(compiled.smartDiff, want) {
			t.Errorf("truncated embedded fixture lost %q:\n%s", want, compiled.smartDiff)
		}
	}
}

func TestCompileEditPlan_MandatoryImportRemovalAvoidsFalsePositives(t *testing.T) {
	tests := []struct {
		name string
		diff string
		want []string
	}{
		{
			name: "JavaScript calls",
			diff: "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@\n+require.NoError(t, err);\n+useFeature();\n+using(resource);\n+const middleware = wrap(require(\"morgan\"));\n+app.use(middleware);\n+const {\n+  value,\n+} = source;\n+consume(value);\n+const note = \"we import data from upstream\";\n",
			want: []string{"require.NoError", "useFeature", "using(resource)", "wrap(require", "app.use", "} = source", "consume(value)", "we import data from upstream"},
		},
		{
			name: "Rust identifiers",
			diff: "diff --git a/a.rs b/a.rs\n--- a/a.rs\n+++ b/a.rs\n@@\n+useFeature();\n+using(value);\n+let prose = \"use the imported value\";\n",
			want: []string{"useFeature", "using(value)", "use the imported value"},
		},
		{
			name: "Prose file",
			diff: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@\n+import data from the upstream service before rendering.\n+use feature flags for rollout.\n+#include examples in the guide.\n",
			want: []string{"import data", "use feature", "#include examples"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			compiled, err := compileEditPlan(tc.diff, editPlan{})
			if err != nil {
				t.Fatal(err)
			}
			for _, want := range tc.want {
				if !strings.Contains(compiled.smartDiff, want) {
					t.Errorf("false positive removed %q:\n%s", want, compiled.smartDiff)
				}
			}
		})
	}
}

func TestCompileEditPlan_JavaScriptRequireDoesNotConsumePreviousStatement(t *testing.T) {
	raw := "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@\n+const {\n+  timeout,\n+} = options;\n+const {\n+  readFile,\n+} = require(\"fs\");\n+consume(timeout, readFile);\n"
	compiled, err := compileEditPlan(raw, editPlan{})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"+const {\n+  timeout,\n+} = options;", "+consume(timeout, readFile);"} {
		if !strings.Contains(compiled.smartDiff, want) {
			t.Errorf("behavior before require was consumed, missing %q:\n%s", want, compiled.smartDiff)
		}
	}
	for _, unwanted := range []string{"readFile,", `require("fs")`} {
		if strings.Contains(compiled.smartDiff, unwanted) {
			t.Errorf("require scaffolding %q survived:\n%s", unwanted, compiled.smartDiff)
		}
	}
}

func TestCompileEditPlan_MandatoryImportsPreservePackageRenames(t *testing.T) {
	for _, raw := range []string{
		"diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@\n-package oldname\n+package newname\n-import \"old\"\n+import \"new\"\n",
		"diff --git a/A.java b/A.java\n--- a/A.java\n+++ b/A.java\n@@\n-package old.name;\n+package new.name;\n-import old.Value;\n+import new.Value;\n",
	} {
		compiled, err := compileEditPlan(raw, editPlan{})
		if err != nil {
			t.Fatal(err)
		}
		for _, want := range []string{"-package old", "+package new"} {
			if !strings.Contains(compiled.smartDiff, want) {
				t.Errorf("package rename %q was lost:\n%s", want, compiled.smartDiff)
			}
		}
		if strings.Contains(compiled.smartDiff, "import ") {
			t.Errorf("package rename retained imports:\n%s", compiled.smartDiff)
		}
	}
}

func TestCompileEditPlan_HunkSectionImportHintIsNotAuthority(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want []string
	}{
		{
			name: "Go incomplete-looking section",
			raw:  "diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@ -10,0 +11,2 @@ import (\n+work()\n+done()\n",
			want: []string{"+work()", "+done()"},
		},
		{
			name: "JavaScript complete import section",
			raw:  "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -10,1 +10,2 @@ import { render } from \"./render\";\n const root = document.body;\n+render(root);\n",
			want: []string{" const root", "+render(root)"},
		},
		{
			name: "Rust complete use section",
			raw:  "diff --git a/a.rs b/a.rs\n--- a/a.rs\n+++ b/a.rs\n@@ -10,1 +10,2 @@ use crate::{Bar, Baz};\n let value = compute();\n+consume(value);\n",
			want: []string{" let value", "+consume(value)"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			compiled, err := compileEditPlan(tc.raw, editPlan{})
			if err != nil {
				t.Fatal(err)
			}
			for _, want := range tc.want {
				if !strings.Contains(compiled.smartDiff, want) {
					t.Errorf("hunk section false positive removed %q:\n%s", want, compiled.smartDiff)
				}
			}
		})
	}
}

func TestCompileEditPlan_MandatoryGuardedPythonImports(t *testing.T) {
	raw := "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@\n+try:\n+    import ujson as json\n+except ImportError:\n+    import json\n+if TYPE_CHECKING:\n+    from models import Payload\n+value: Payload = json.loads(data)\n"
	compiled, err := compileEditPlan(raw, editPlan{})
	if err != nil {
		t.Fatal(err)
	}
	for _, unwanted := range []string{"try:", "except ImportError", "TYPE_CHECKING", "import ujson", "import json", "from models import"} {
		if strings.Contains(compiled.smartDiff, unwanted) {
			t.Errorf("guarded import framing %q survived:\n%s", unwanted, compiled.smartDiff)
		}
	}
	if !strings.Contains(compiled.smartDiff, "+value: Payload = json.loads(data)") {
		t.Fatalf("guarded-import consumer was lost:\n%s", compiled.smartDiff)
	}

	mixed := "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@\n+try:\n+    import fast_json\n+except ImportError:\n+    fast_json = None\n+value = fast_json\n"
	compiled, err = compileEditPlan(mixed, editPlan{})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(compiled.smartDiff, "import fast_json") {
		t.Fatalf("mixed guarded import survived:\n%s", compiled.smartDiff)
	}
	for _, want := range []string{"+try:\n+    ...\n+except ImportError:", "+    fast_json = None", "+value = fast_json"} {
		if !strings.Contains(compiled.smartDiff, want) {
			t.Errorf("mixed guarded import skeleton missing %q:\n%s", want, compiled.smartDiff)
		}
	}
}

func TestCompileEditPlan_MandatoryImportsRemoveCompleteHunksAndFiles(t *testing.T) {
	raw := "diff --git a/a.py b/a.py\nindex 111..222 100644\n--- a/a.py\n+++ b/a.py\n@@ imports @@\n-import old_package\n+from new_package import value\n@@ behavior @@\n-old = run_old()\n+new = run_new()\n"
	compiled, err := compileEditPlan(raw, editPlan{})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(compiled.smartDiff, "@@ imports @@") || strings.Contains(compiled.smartDiff, "package import") || strings.Contains(compiled.smartDiff, "new_package") {
		t.Fatalf("import-only hunk survived:\n%s", compiled.smartDiff)
	}
	for _, want := range []string{"diff --git a/a.py", "@@ behavior @@", "-old = run_old()", "+new = run_new()"} {
		if !strings.Contains(compiled.smartDiff, want) {
			t.Errorf("partial file lost %q:\n%s", want, compiled.smartDiff)
		}
	}

	importsOnly := "diff --git a/a.py b/a.py\nindex 111..222 100644\n--- a/a.py\n+++ b/a.py\n@@\n-import old_package\n+import new_package\n"
	compiled, err = compileEditPlan(importsOnly, editPlan{})
	if err != nil {
		t.Fatal(err)
	}
	if compiled.smartDiff != "" {
		t.Fatalf("import-only file left framing:\n%s", compiled.smartDiff)
	}

	goImportsOnly := "diff --git a/a.go b/a.go\nnew file mode 100644\n--- /dev/null\n+++ b/a.go\n@@\n+package a\n+\n+import (\n+    \"fmt\"\n+)\n"
	compiled, err = compileEditPlan(goImportsOnly, editPlan{})
	if err != nil {
		t.Fatal(err)
	}
	if compiled.smartDiff != "" {
		t.Fatalf("package/import-only file left framing:\n%s", compiled.smartDiff)
	}
}

func TestCompileEditPlan_MergesMandatoryImportsWithModelEdits(t *testing.T) {
	raw := "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@\n+from package import (\n+    first,\n+    second,\n+)\n+value = first(second)\n"

	// Explicit legacy removal, replacement, and an import-only fold are all
	// redundant with the mandatory plan and merge without overlap errors.
	compiled, err := compileEditPlan(raw, editPlan{
		Remove:  []lineRange{{StartLine: 6, EndLine: 6}},
		Replace: []lineReplacement{{Line: 7, Old: "first", New: "..."}},
		Fold:    []lineFold{{StartLine: 5, EndLine: 8}},
	})
	if err != nil {
		t.Fatalf("redundant import edits did not merge: %v", err)
	}
	if strings.Contains(compiled.smartDiff, "package import") || strings.Contains(compiled.smartDiff, "from package") || strings.Contains(compiled.smartDiff, "+    ...") {
		t.Fatalf("redundant model edits leaked import scaffolding:\n%s", compiled.smartDiff)
	}
	if !strings.Contains(compiled.smartDiff, "+value = first(second)") {
		t.Fatalf("behavior was lost:\n%s", compiled.smartDiff)
	}

	_, err = compileEditPlan(raw, editPlan{Fold: []lineFold{{StartLine: 8, EndLine: 9}}})
	if err == nil || !strings.Contains(err.Error(), "crosses automatically removed import rows") {
		t.Fatalf("cross-import/behavior fold error = %v", err)
	}
}

func TestCompileEditPlan_CompletesImportFramingAfterModelRemoval(t *testing.T) {
	raw := "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@\n-import old_package\n+import new_package\n-old = run_old()\n+new = run_new()\n context = explain_behavior_in_detail()\n"
	compiled, err := compileEditPlan(raw, editPlan{
		Remove: []lineRange{{StartLine: 7, EndLine: 8}},
		Replace: []lineReplacement{{
			Line: 9,
			Old:  "explain_behavior_in_detail",
			New:  "explain_...",
		}},
	})
	if err != nil {
		t.Fatalf("merged framing rejected a redundant context replacement: %v", err)
	}
	if compiled.smartDiff != "" {
		t.Fatalf("merged import/model removal left hunk or file framing:\n%s", compiled.smartDiff)
	}
}

func TestAbridge_MandatoryImportsApplyToIdentityPreviewAndSubmit(t *testing.T) {
	raw := "diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@\n+package a\n+import \"fmt\"\n+func run() { fmt.Println(1) }\n"
	identity := editPlan{Remove: []lineRange{}, Replace: []lineReplacement{}, Fold: []lineFold{}}
	model := &scriptedModel{turns: []*Response{
		assistant(toolUse("preview", "preview_plan", identity)),
		assistant(toolUse("submit", "submit", submission{Remove: identity.Remove, Replace: identity.Replace, Fold: identity.Fold, Summary: "Adds run."})),
	}}
	result, err := Abridge(context.Background(), model, Request{UnifiedDiff: raw})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(result.SmartDiff, `import "fmt"`) || !strings.Contains(result.SmartDiff, "+func run()") {
		t.Fatalf("identity submission was not import-free:\n%s", result.SmartDiff)
	}
	preview := ""
	for _, message := range model.seenMessages[1] {
		for _, block := range message.Content {
			if block.Type == "tool_result" {
				preview += block.ToolResult
			}
		}
	}
	if strings.Contains(preview, `import "fmt"`) || !strings.Contains(preview, "+func run()") {
		t.Fatalf("identity preview was not import-free:\n%s", preview)
	}
	if !strings.Contains(preview, "Retention: 2/3") {
		t.Fatalf("preview statistics were not computed from merged plan:\n%s", preview)
	}
}

func TestAbridge_MandatoryImportsApplyToRefinementFallback(t *testing.T) {
	var raw strings.Builder
	raw.WriteString("diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@\n+import { call } from \"./calls.js\";\n")
	for i := 0; i < 50; i++ {
		raw.WriteString("+call();\n")
	}
	identity := submission{Remove: []lineRange{}, Replace: []lineReplacement{}, Fold: []lineFold{}, Summary: "Adds calls."}
	model := &scriptedModel{turns: []*Response{
		assistant(toolUse("draft", "submit", identity)),
		assistant(textBlock("The calls are all behaviorally distinct.")),
	}}
	result, err := Abridge(context.Background(), model, Request{UnifiedDiff: raw.String(), MaxTurns: 2})
	if err != nil {
		t.Fatal(err)
	}
	if model.seen != 2 {
		t.Fatalf("turns = %d, want refinement then fallback", model.seen)
	}
	if strings.Contains(result.SmartDiff, "import { call }") || !strings.Contains(result.SmartDiff, "+call();") {
		t.Fatalf("fallback was not import-free:\n%s", result.SmartDiff)
	}
	for _, message := range model.seenMessages[1] {
		for _, block := range message.Content {
			if block.Type == "tool_result" && strings.Contains(block.ToolResult, "import { call }") {
				t.Fatalf("refinement feedback leaked imports:\n%s", block.ToolResult)
			}
		}
	}
}

func TestMandatoryImportPlanJSONCoordinatesRemainSourceDerived(t *testing.T) {
	raw := "diff --git a/a.py b/a.py\n@@\n+import os\n+value = os.name\n"
	plan := mandatoryImportRemovalPlan(splitSourceLines(raw), analyzeDiff(splitSourceLines(raw)))
	encoded, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `[{"start_line":3,"end_line":3}]` {
		t.Fatalf("mandatory source-coordinate plan = %s", encoded)
	}
}
