package meat

import (
	"strings"
	"testing"
	"time"
)

const rawTwoFiles = `diff --git a/a.go b/a.go
--- a/a.go
+++ b/a.go
@@ -1,3 +1,4 @@
 package a
-old1
+new1
+new2
diff --git a/b.pb.go b/b.pb.go
--- a/b.pb.go
+++ b/b.pb.go
@@ -1,2 +1,3 @@
+gen1
+gen2
`

func TestElisionLine(t *testing.T) {
	abridged := `diff --git a/a.go b/a.go
@@ -1,3 +1,4 @@
+new1
`
	got := ElisionLine(rawTwoFiles, abridged)
	// raw: 5 changed lines (old1,new1,new2,gen1,gen2) in 2 files; kept 1 line in 1 file.
	want := "kept 1/5 changed lines in 1/2 files"
	if got != want {
		t.Errorf("ElisionLine = %q, want %q", got, want)
	}
}

func TestElisionLine_AllElided(t *testing.T) {
	got := ElisionLine(rawTwoFiles, "")
	if !strings.Contains(got, "elided all 5 changed lines") {
		t.Errorf("ElisionLine(empty) = %q, want 'elided all 5 changed lines...'", got)
	}
}

func TestElisionLine_NoFileHeadersInAbridged(t *testing.T) {
	// The model kept hunks but dropped the per-file headers: fall back to
	// line counts only, rather than claiming "0 files".
	got := ElisionLine(rawTwoFiles, "@@ -1 +1 @@\n+new1\n")
	want := "kept 1/5 changed lines"
	if got != want {
		t.Errorf("ElisionLine = %q, want %q", got, want)
	}
}

func TestElisionLine_DoesNotMatchSourceAsLaterFileHeaders(t *testing.T) {
	raw := `--- a/one.go
+++ b/one.go
@@ -1 +1 @@
--- a/two.go
+++ b/two.go
--- a/two.go
+++ b/two.go
@@ -1 +1 @@
-old
+new
`
	abridged := `--- a/two.go
+++ b/two.go
@@ -1 +1 @@
-old
+new
`
	if got, want := ElisionLine(raw, abridged), "kept 2/4 changed lines"; got != want {
		t.Fatalf("ElisionLine = %q, want %q", got, want)
	}
}

func TestElisionLine_ComposedAdjacentReplacements(t *testing.T) {
	raw := "diff --git a/a b/a\n@@ -0,0 +1 @@\n+abcdef\n"
	abridged, err := applyEditPlan(raw, submission{
		Summary: "Elides adjacent details.",
		Replace: []lineReplacement{
			{Line: 3, Old: "ab", New: "..."},
			{Line: 3, Old: "cd", New: "..."},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(abridged, "+......ef") {
		t.Fatalf("adjacent replacements =\n%s", abridged)
	}
	if got, want := ElisionLine(raw, abridged), "kept 1/1 changed lines in 1/1 files"; got != want {
		t.Fatalf("ElisionLine = %q, want %q", got, want)
	}
}

func TestElisionLine_ProjectionBeforeLaterExactLineKeepsGreedyOrder(t *testing.T) {
	raw := "diff --git a/a b/a\n@@ -0,0 +1,4 @@\n+aSECRETz\n+after-first\n+a...z\n+after-exact\n"
	abridged := "diff --git a/a b/a\n@@ -0,0 +1,4 @@\n+a...z\n+after-first\n"
	if got, want := ElisionLine(raw, abridged), "kept 2/4 changed lines in 1/1 files"; got != want {
		t.Fatalf("ElisionLine = %q, want %q", got, want)
	}
}

func TestElisionLine_DivergentProjectionLinesDoNotRescanWholeDiff(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping scalability regression in short mode")
	}
	var raw, abridged strings.Builder
	raw.WriteString("diff --git a/a b/a\n@@ -0,0 +1,1000 @@\n")
	abridged.WriteString("diff --git a/a b/a\n@@ -0,0 +1,1000 @@\n")
	for range 1000 {
		raw.WriteString("+raw\n")
		abridged.WriteString("+missing...zzz\n")
	}
	start := time.Now()
	got := ElisionLine(raw.String(), abridged.String())
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("ElisionLine took %s for 1000 divergent projection lines", elapsed)
	}
	if want := "kept 0/1000 changed lines in 1/1 files"; got != want {
		t.Fatalf("ElisionLine = %q, want %q", got, want)
	}
}

func TestElisionLine_CountsSyntheticChangedFold(t *testing.T) {
	raw := "diff --git a/a.py b/a.py\n@@ -0,0 +1,3 @@\n+first()\n+second()\n+third()\n"
	abridged, err := applyEditPlan(raw, submission{
		Summary: "Folds repeated calls.",
		Fold:    []lineFold{{StartLine: 3, EndLine: 5}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := ElisionLine(raw, abridged), "kept 1/3 changed lines in 1/1 files"; got != want {
		t.Fatalf("ElisionLine = %q, want %q\n%s", got, want, abridged)
	}
}

func TestElisionLine_FoldDoesNotConsumeLaterLiteralEllipsis(t *testing.T) {
	raw := "diff --git a/a.py b/a.py\n@@ -0,0 +1,5 @@\n+first()\n+second()\n+middle()\n+...\n+last()\n"
	abridged, err := applyEditPlan(raw, submission{Summary: "Folds calls.", Fold: []lineFold{{StartLine: 3, EndLine: 4}}})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := ElisionLine(raw, abridged), "kept 4/5 changed lines in 1/1 files"; got != want {
		t.Fatalf("ElisionLine = %q, want %q\n%s", got, want, abridged)
	}
}

func TestElisionLine_ConcatenatedDiffWithStaleHunkCounts(t *testing.T) {
	raw := `--- a/one.go
+++ b/one.go
@@ -1,2 +1,2 @@
 one
-a
+b
--- a/two.go
+++ b/two.go
@@ -1,2 +1,2 @@
 two
-c
+d
`
	abridged := `--- a/one.go
+++ b/one.go
@@ -1,2 +1,2 @@
 one
+b
--- a/two.go
+++ b/two.go
@@ -1,2 +1,2 @@
 two
-c
+d
`
	if got, want := ElisionLine(raw, abridged), "kept 3/4 changed lines"; got != want {
		t.Fatalf("ElisionLine = %q, want %q", got, want)
	}
}

func TestElisionLine_FileHeadersNotCounted(t *testing.T) {
	// +++/--- headers must not count as changed lines.
	changed, files := diffStats(rawTwoFiles)
	if changed != 5 || files != 2 {
		t.Errorf("diffStats = (%d, %d), want (5, 2)", changed, files)
	}
}
