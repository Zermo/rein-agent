# Publish the field guide

The public guide lives at [zermo.github.io/rein-agent](https://zermo.github.io/rein-agent/). Its source is `docs/install.html`.

`scripts/build-guide-site.mjs` copies that page to `index.html` and `install.html`, copies `docs/assets/`, and adds `.nojekyll`. It does not publish the other files under `docs/`. Keep that asset directory limited to public files.

The build requires these nonempty files:

- `docs/assets/rein-logo.png`
- `docs/assets/rein-repo-card.png`
- `docs/assets/rein-field-guide-card.png`
- Both card JPEG exports for social previews
- `docs/assets/rein-logo.svg` and `docs/assets/rein-icon.svg`

## Preview a change

Run from the repository root with Node.js installed. No package install is needed.

```sh
guide_site="$(mktemp -d "${TMPDIR:-/tmp}/rein-guide-site.XXXXXX")"
node scripts/build-guide-site.mjs "$guide_site"
python3 -m http.server 8000 --bind 127.0.0.1 --directory "$guide_site"
```

Open `http://127.0.0.1:8000/` and `http://127.0.0.1:8000/install.html`. Check the logo, cards, navigation, model route selector, and copy buttons. The build accepts an empty output directory and never clears an existing one. With no argument, it creates and prints a temporary directory.

## Deploy with GitHub Actions

For the first deployment, a repository admin selects **GitHub Actions** under Settings > Pages > Build and deployment > Source. The workflow uses the built-in GitHub token; it needs no deployment secret. GitHub documents this setup in [Using custom workflows with GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

Commit the changed guide, assets, and deployment files, then push to `main`. The `Publish field guide` workflow runs when those paths change. To publish the current `main` again:

```sh
gh workflow run guide-pages.yml --repo Zermo/rein-agent --ref main
gh run list --repo Zermo/rein-agent --workflow guide-pages.yml --branch main --limit 3 --json databaseId,headSha,status,conclusion,url
```

Find the run for the intended commit, then wait for it with `gh run watch RUN_ID --repo Zermo/rein-agent --exit-status`. Manual runs on other branches do not deploy. The workflow queues deployments so a later push does not interrupt a deployment already running.

## Verify the published result

Confirm that both workflow jobs succeeded for the intended commit. Check the Pages URL and branding assets:

```sh
for page in '' install.html assets/rein-logo.png assets/rein-repo-card.png assets/rein-field-guide-card.png; do
  curl --fail --silent --show-error --output /dev/null "https://zermo.github.io/rein-agent/$page" || exit 1
done
```

Open the live guide on desktop and at a narrow mobile width. Repeat the navigation, route selector, and copy-button checks. Compare the live page with the committed source if an older page appears; a successful HTTP response alone does not confirm which version is live.

The workflow uses [checkout@v7](https://github.com/actions/checkout/releases/tag/v7.0.1), [setup-node@v7](https://github.com/actions/setup-node/releases/tag/v7.0.0), [configure-pages@v6](https://github.com/actions/configure-pages/releases/tag/v6.0.0), [upload-pages-artifact@v5](https://github.com/actions/upload-pages-artifact/releases/tag/v5.0.0), and [deploy-pages@v5](https://github.com/actions/deploy-pages/releases/tag/v5.0.1), checked against the official releases on September 5, 2026. Their JavaScript actions use Node 24. The guide build follows the latest Node.js release through `node-version: node`.
