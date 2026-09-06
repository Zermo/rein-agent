#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<'USAGE'
Usage: bash scripts/publish-wiki.sh [wiki-remote]

Publish docs/wiki/*.md using existing Git credentials and author configuration.
Default remote: git@github.com:Zermo/rein-agent.wiki.git

Create an initial wiki page on GitHub before the first publish.
GITHUB_TOKEN is not assumed to have wiki write access.
USAGE
}

if [[ $# -gt 1 ]]; then
    usage >&2
    exit 2
fi
case "${1:-}" in
    -h|--help) usage; exit 0 ;;
    -*) usage >&2; exit 2 ;;
esac

fail() {
    printf '%s\n' "$*" >&2
    exit 1
}

command -v git >/dev/null 2>&1 || fail 'Git is required.'
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
wiki_source="$repo_root/docs/wiki"
wiki_remote="${1:-git@github.com:Zermo/rein-agent.wiki.git}"

shopt -s nullglob
wiki_files=("$wiki_source"/*.md)
[[ ${#wiki_files[@]} -gt 0 ]] || fail 'No Markdown pages found in docs/wiki.'
for wiki_file in "${wiki_files[@]}"; do
    [[ -f "$wiki_file" && ! -L "$wiki_file" ]] || fail 'Wiki sources must be regular Markdown files, not symlinks.'
done

umask 077
wiki_tmp="$(mktemp -d "${TMPDIR:-/tmp}/rein-wiki.XXXXXX")"
cleanup() {
    rm -rf -- "$wiki_tmp"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
wiki_checkout="$wiki_tmp/wiki"

if ! git clone --quiet --depth 1 -- "$wiki_remote" "$wiki_checkout"; then
    fail 'Could not clone the wiki. Create its initial page on GitHub and check your existing Git access.'
fi
git -C "$wiki_checkout" rev-parse --verify HEAD >/dev/null 2>&1 ||
    fail 'The wiki has no initial commit. Create its first page on GitHub, then retry.'
wiki_branch="$(git -C "$wiki_checkout" symbolic-ref --quiet --short HEAD)"

wiki_names=()
for wiki_file in "${wiki_files[@]}"; do
    wiki_name="${wiki_file##*/}"
    wiki_target="$wiki_checkout/$wiki_name"
    [[ ! -L "$wiki_target" && ! -d "$wiki_target" ]] ||
        fail "Refusing to replace a symlink or directory at wiki page $wiki_name."
    cp -- "$wiki_file" "$wiki_target"
    wiki_names+=("$wiki_name")
done

git -C "$wiki_checkout" add -- "${wiki_names[@]}"
if git -C "$wiki_checkout" diff --cached --quiet -- "${wiki_names[@]}"; then
    printf '%s\n' 'Wiki is already up to date.'
    exit 0
fi

git -C "$wiki_checkout" commit --quiet -m 'Update Rein installation wiki'
git -C "$wiki_checkout" push origin "HEAD:refs/heads/$wiki_branch"
printf '%s\n' 'Published wiki pages from docs/wiki.'
