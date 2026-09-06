# Deploy the field guide

The public guide lives at [zermo.github.io/rein-agent](https://zermo.github.io/rein-agent/). Its source is [docs/install.html](https://github.com/Zermo/rein-agent/blob/main/docs/install.html), with images in [docs/assets](https://github.com/Zermo/rein-agent/tree/main/docs/assets).

The guide is a static page. It copies commands for the reader to run in a terminal; it does not execute installation commands in the browser.

## Publish through GitHub Pages

In the repository's **Settings > Pages**, select **GitHub Actions** as the build source. The [guide-pages.yml workflow](https://github.com/Zermo/rein-agent/blob/main/.github/workflows/guide-pages.yml) builds and deploys the guide when relevant changes reach `main`. You can also run it manually from the repository's Actions tab.

1. Edit `docs/install.html` and any required images in `docs/assets`.
2. Build and preview the site with the commands below.
3. Commit and push the changes to `main`.
4. Open the workflow run and wait for the deployment to succeed.
5. Check the [live guide](https://zermo.github.io/rein-agent/), including copy buttons, connection tabs, images, and print view.

From the repository root, use Node.js and Python 3 to build and serve a temporary copy. No npm install is needed for the guide:

```sh
guide_site="$(mktemp -d "${TMPDIR:-/tmp}/rein-guide-site.XXXXXX")"
node scripts/build-guide-site.mjs "$guide_site"
python3 -m http.server 8000 --bind 127.0.0.1 --directory "$guide_site"
```

Open [localhost:8000](http://localhost:8000) to review it. Stop the preview server with Ctrl-C. The builder produces `index.html`, `install.html`, `assets/`, and `.nojekyll` in the temporary directory. Running it without an output argument creates and prints a new temporary directory.

To deploy the current `main` manually with an authenticated GitHub CLI:

```sh
gh workflow run guide-pages.yml --repo Zermo/rein-agent --ref main
```

The builder publishes the guide and its assets. The wiki has its own Git repository and publishing step.

## Publish wiki edits

Edit the Markdown files in [docs/wiki](https://github.com/Zermo/rein-agent/tree/main/docs/wiki). The same-named pages in the public wiki are maintained from those files, so edits made only through GitHub can be overwritten by the next publish.

Before the first publish, enable the repository's wiki and create an initial page in the [GitHub wiki](https://github.com/Zermo/rein-agent/wiki). GitHub must create the wiki repository before it can be cloned.

Review and commit your source changes, then run this command from the main repository checkout:

```sh
bash scripts/publish-wiki.sh
```

The helper uses `git@github.com:Zermo/rein-agent.wiki.git` by default. It clones into a private temporary directory, copies only `docs/wiki/*.md`, commits when those pages changed, and pushes without force. Other wiki pages remain in place. The temporary clone is removed when the script exits.

Use your existing SSH access and Git author configuration. For HTTPS with an existing Git credential helper:

```sh
bash scripts/publish-wiki.sh https://github.com/Zermo/rein-agent.wiki.git
```

The publisher does not create or store credentials. Do not assume a workflow's `GITHUB_TOKEN` has wiki write access. A successful Pages deployment does not publish the wiki.

If another wiki edit lands before your push, Git may reject the push. Review the remote edit and update the matching source page before running the publisher again. To remove a wiki page, remove its source file and delete the published page separately; the helper does not delete remote pages.
