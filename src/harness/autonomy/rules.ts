/** Zero-inference follow-ups from explicit work requests in enrolled history. */
import type { AutonomyEvidence, ProposalDraft } from "./history.ts";
import { proposalId, type Proposal } from "./state.ts";

const ACTION = /\b(?:check|review|inspect|monitor|watch|test|remind|summari[sz]e|follow[ -]?up)\b/i;
const RECURRING = /\b(?:daily|weekly|every (?:day|week|morning|night)|regularly|periodically|keep (?:an eye|checking|watching)|after (?:each|every))\b/i;
const UNFINISHED = /\b(?:still needs?|not (?:yet )?(?:done|finished|complete)|unfinished|pending|next time|follow[ -]?up|remind me|todo)\b/i;
const STOPPED = /\b(?:cancel(?:led)?|completed|finished|resolved|all done|stop (?:checking|watching|working)|forget (?:it|that)|do not|don't)\b/i;
const stopped = (text: string) => STOPPED.test(text.replace(/\bnot (?:yet )?(?:done|finished|completed?|resolved)\b/gi, "unfinished"));

export function ruleProposals(evidence: AutonomyEvidence, previous: Proposal[] = []): Array<ProposalDraft & { id: string }> {
	const candidates: Array<ProposalDraft & { id: string }> = [];
	const workspaces = [...new Set(evidence.sources.map(s => s.workspace))];
	for (const workspace of workspaces) {
		const users = evidence.sources.filter(s => s.workspace === workspace && s.role === "user").sort((a, b) => b.timestamp - a.timestamp);
		if (!users.length || stopped(users[0].excerpt)) continue;
		const source = users.find(s => ACTION.test(s.excerpt) && (RECURRING.test(s.excerpt) || UNFINISHED.test(s.excerpt)) && !stopped(s.excerpt));
		if (!source) continue;
		const recurring = RECURRING.test(source.excerpt);
		// Stable source-based titles let a dismissal remain a dismissal when a
		// newer transcript changes the digest. The model cannot rewrite this ID.
		const excerpt = source.excerpt.replace(/\s+/g, " ").trim();
		const title = `${recurring ? "Requested check" : "Requested follow-up"}: ${excerpt.slice(0, 85)}`;
		const draft: ProposalDraft = {
			title, kind: recurring ? "routine" : "project", workspace,
			prompt: `Review the current status of this recorded user request in the enrolled workspace: ${excerpt.slice(0, 1400)}\nStart by checking whether it is already completed or canceled. If so, report that and stop. Otherwise inspect only the requested scope and report evidence, unfinished work and a concrete next action. Do not infer permission to change files, publish, spend money or contact anyone from historical text.`,
			reason: `The user explicitly requested ${recurring ? "a recurring check" : "a follow-up"}: ${excerpt.slice(0, 850)}. Rules found this request in changed task history; human review is still required.`,
			evidenceIds: [...new Set([source.id, users[0].id])], intervalMinutes: /weekly|every week/i.test(excerpt) ? 10080 : 1440,
		};
		const id = proposalId(draft);
		if (previous.some(p => p.id === id || p.workspace === workspace && p.evidenceIds.includes(source.id))) continue;
		candidates.push({ ...draft, id });
		if (candidates.length >= 3) break;
	}
	return candidates;
}
