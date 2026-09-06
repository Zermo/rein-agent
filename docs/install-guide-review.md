# Installation guide review

Artifact: [install.html](install.html), release 0.9.3.

## Review method

Applied [write-docs](https://github.com/dzhng/skills/tree/c7957020f9fcb7321dbc339428b41cdff67c9637/skills/engineering/write-docs)
and [screenshot-critique](https://github.com/dzhng/skills/tree/c7957020f9fcb7321dbc339428b41cdff67c9637/skills/visual/screenshot-critique)
from dzhng/skills at commit `c7957020f9fcb7321dbc339428b41cdff67c9637`.
A fresh reviewer received only the current screenshot set, the critique skill,
and the task description. Source correctness and interactions were checked
separately.

## Findings and corrections

The first review identified cramped line wrapping in the installation command
at 320 pixels. The command now uses two source lines and wraps continuously
without an extra blank visual line. Early cover captures also retained a prior
scroll position; they were discarded. A back-to-top link and explicit navigation
made the final capture positions verifiable.

The final fresh review reported no actionable visual findings, with high
confidence within the reviewed frames. It checked containment, command blocks,
control labels, selected tabs, text legibility, and diagram structure. Viewport
boundaries were treated as screenshot cutoffs rather than page defects.

## Final visual coverage

- Desktop, 1135 x 931: cover, installation, model-host setup, cloud login, first run,
  and updates.
- Mobile, 390 x 844: cover, installation, model-host setup and its command, cloud API
  setup, first run, and updates.
- Narrow, 320 x 780: cover, installation, and the full wrapped install command.
- Four 2x crops: desktop cover, desktop model-host, mobile model-host command, and narrow
  install command.

The checked cover is retained as [install-guide-preview.png](assets/install-guide-preview.png).
Screenshots cannot prove clipboard contents, shell execution, or print output.

## Functional checks

The in-app browser showed no horizontal overflow at the checked widths and no
console warnings or errors. Connection tabs responded to pointer and keyboard
selection, the checklist reflected all four steps, and troubleshooting sections
opened normally. Copy controls reported success with the intended command text;
actual clipboard access depends on the browser's permissions. The print control
uses the browser's print dialog and a dedicated stylesheet; a printed PDF was
not part of the screenshot review.

All eleven shell snippets passed `bash -n` without execution. The SSH config
example was excluded from that shell check. The inline JavaScript passed
`node --check`. An independent code review confirmed that installation, SSH,
status, and update commands match the harness implementation. A live model-host setup
probe passed through the existing SSH configuration.
