# METRIC.md — how success is measured

The command in the fenced block below runs after each iteration. Its output
must contain exactly one line: METRIC=<number> (higher is better; for
lower-is-better metrics, print the negated value).

```bash
node test/bench/search-bench.js
```

The bench script should print a final line like:

    METRIC=-118

(p95 ms, lower is better — the script negates it so the loop's
"higher is better" rule works. Pick a convention and keep it stable.)
