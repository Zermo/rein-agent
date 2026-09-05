import { HTML_TO_MARKDOWN_JS } from "../../../vendor/obscura/markdown.ts";

export function pageExpression(maxChars: number): string {
	return `(() => {
		for (const a of document.querySelectorAll('a[href]')) {
			try { a.setAttribute('href', new URL(a.getAttribute('href'), document.baseURI || location.href).href); } catch {}
		}
		const text = ${HTML_TO_MARKDOWN_JS};
		return { kind: 'page', title: String(document.title || '').slice(0, 1000), url: location.href,
			text: text.slice(0, ${maxChars}), chars: text.length, truncated: text.length > ${maxChars} };
	})()`;
}

export const SEARCH_EXPRESSION = `(() => ({
	kind: 'search', url: location.href, title: String(document.title || '').slice(0, 1000),
	blocked: !!document.querySelector('#challenge-form, .anomaly-modal, form[action*="anomaly"]'),
	noResults: !!document.querySelector('.no-results__message'),
	results: Array.from(document.querySelectorAll('.result')).slice(0, 100).map(r => {
		const a = r.querySelector('.result__a');
		return {title: String(a?.textContent || '').trim().slice(0, 1000),
			url: String(a?.href || '').slice(0, 8192),
			snippet: String(r.querySelector('.result__snippet')?.textContent || '').trim().slice(0, 2000)};
	}).filter(r => r.title && r.url)
}))()`;
