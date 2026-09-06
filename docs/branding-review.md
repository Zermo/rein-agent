# Branding and publishing review

The final cards use the supplied 1280 x 640 GitHub template's proportions.
Important content stays within an 80-pixel inset. PNG and JPEG cards were
reviewed at native size, alongside the 1024-pixel logo and guide captures at
1280 x 720, 390 x 844, and 320 x 780. Four enlarged crops covered the card
lettering, logo, and guide masthead.

The first independent visual review found two issues. The standalone mark had
a wider silhouette and square upper-left corner than the cards. The logo was
aligned to the cards and given a matching SVG version. Small labels in the
mobile illustration were enlarged and shortened to TERMINAL and MODEL.

A fresh final reviewer inspected the complete current capture set and reported
no actionable findings. Card text remained within the safe area, the logo family
was consistent, and mobile headers and captions fit without overlap. JPEGs
showed no conspicuous compression damage. Screenshots do not verify clipboard
contents or every social platform's crop.

Browser checks verified route selection by pointer and keyboard, copy-button
feedback, no horizontal overflow at the checked widths, and no console warnings
or errors. Thirty guide/wiki shell snippets and the guide JavaScript passed
syntax checks.

A separate code review found no actionable issues in the Pages workflow, site
builder, wiki publisher, or links. Build fixtures covered expected export
contents, missing assets, and nonempty-output rejection. The actual builder
copies only the guide, its assets, and `.nojekyll`; both HTML entry points match
the source. The workflow uses current official Pages actions. Runtime harness
code is unchanged.

The public GitHub wiki was initialized and the six source Markdown files were
published through the helper. Repository-card upload was left to the user, as
requested after Chrome reported that file uploads were disabled. The public
guide uses its own card through Open Graph metadata.
