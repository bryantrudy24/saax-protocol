# Agentic Commerce Disputes: The Complete FAQ

*October 10, 2026* 

*Last updated: 2026-10-17*

---

When AI agents transact on behalf of humans, the disputes that follow don't fit the frameworks built for human buyers. This FAQ answers the questions that come up most often.

## What are the risks of agentic commerce?

The primary risk is not fraud. It's the gap between what the principal authorized and what the agent actually did.

Four specific failure modes cause most of the problems:

**Misauthorized purchases.** The agent acts inside its configuration but outside the principal's actual intent. The credentials were valid. The authorization was real. The purchase still wasn't what the human wanted.

**Double-purchasing on retry.** The agent's first attempt times out, it retries, and the merchant processes both. The agent's ledger records one transaction. The buyer's statement shows two.

**Fulfillment mismatch.** The merchant ships something. The agent records the transaction as complete. But whether the deliverable matched the original agreement is a separate question that no layer in the current stack answers.

**Irreversible settlement on crypto rails.** Stablecoin rails settle instantly and finally. There is no chargeback mechanism. If the agent buys wrong and the merchant ships, the value has moved and nothing in the system will move it back.

The common thread across all four is that the record of what was actually committed doesn't exist in a structured form. Without it, every dispute becomes a reconstruction from fragmentary logs held by different parties.

## What problem does agentic commerce solve?

Agentic commerce solves the problem of agent-mediated transactions at scale.

A human using a shopping agent is not trying to replace their own judgment. They're trying to delegate the operational work — searching, comparing, negotiating, ordering — while keeping the decision authority. The agent handles the friction. The human handles the intent.

The practical problems this solves:

- **Reducing the cost of transactions.** An agent can compare twenty vendors, negotiate terms, and place an order in the time it takes a human to open three tabs.
- **Handling high-frequency, low-value activity.** Humans can't reasonably pay for a $0.02 API call or a $0.50 data lookup. Agents can, if the rails support micropayments — which is what x402 and similar protocols exist to solve.
- **Extending operational reach.** A small team can deploy agents that handle procurement, research, and routine purchases across multiple vendors simultaneously.

What agentic commerce does not solve is the accountability problem. The infrastructure being built today handles authorization and settlement. It does not handle what was actually committed, whether it was fulfilled, and what happens when it wasn't. That's the layer SAAX adds.

## What is the future of agentic commerce?

The infrastructure is being built. The demand is still catching up.

Three things are converging:

**Payment rails are maturing.** x402, MPP, AP2, and the card networks all now have agent-specific payment flows. The technical barrier to agent-mediated transactions is largely gone.

**Agent frameworks are expanding.** LangChain, CrewAI, and the MCP ecosystem have made it straightforward to build agents that call external tools — including paid ones.

**Buyer trust is not keeping pace.** Most humans have not delegated purchase authority to an agent, and the ones who have are doing so in narrow, low-stakes contexts. The reason is not technological. It's that there's no structured way to hold an agent accountable when something goes wrong.

The future that most analysts project — trillions of dollars in agent-mediated commerce by 2028 to 2030 — assumes that trust problem gets solved. The commitment layer is what solves it. Whether that layer emerges as a single protocol or as a set of interoperating standards is still open.

The most likely near-term path: agent commerce grows first in B2B contexts where the parties already have contractual relationships and the agent is executing known workflows. Consumer-facing agent commerce grows more slowly because the trust threshold is higher and the dispute surface is wider.

## What is the best way to resolve a dispute?

The best way is the one where the disputed facts are already documented. Everything else is a workaround for missing evidence.

A dispute is a claim that a commitment wasn't fulfilled according to its terms. Resolving it requires answering five questions:

- What was authorized?
- What was committed?
- What was executed?
- What proves fulfillment?
- What recovery policy applies?

If those answers exist in a structured record, the dispute is decidable. If they don't, the dispute becomes a negotiation between parties with incomplete and incompatible stories. The party with better documentation usually wins, regardless of who was right.

The standard sequence for resolution runs from cheapest to most expensive:

1. **Direct resolution** — the buyer and seller work it out. Possible when both sides agree on what happened.
2. **Platform mediation** — an intermediary evaluates the claim against evidence.
3. **Arbitration** — a third party makes a binding decision based on submitted evidence.
4. **Court or on-chain arbitration** — formal adjudication. Highest cost, slowest, final.

Every one of these stages depends on the same thing: a record of what was agreed and what was delivered. Without it, resolution at any level degrades into he-said-she-said.

SAAX approaches this by defining the commitment record at the moment of authorization — before execution begins. The record is what the dispute resolution process works from. See the lifecycle and recovery model at [saax-protocol.com/spec](/spec).

## What are the five methods of dispute resolution?

The traditional five — taught in law schools, used in commercial contracts — are:

**1. Negotiation.** The parties work it out directly. Fastest, cheapest, requires no third party. Works when both sides have a shared understanding of what happened.

**2. Mediation.** A neutral third party helps the parties reach agreement. Non-binding. Useful when the parties disagree on the facts but want to preserve the relationship.

**3. Arbitration.** A neutral third party hears both sides and issues a binding decision. Faster and cheaper than litigation. Enforceable under the New York Convention in most jurisdictions.

**4. Litigation.** Formal court process. Slowest, most expensive, most final. Used when the stakes justify it and the parties can't resolve it any other way.

**5. Conciliation.** Similar to mediation but the neutral party takes a more active role, proposing solutions rather than just facilitating. Common in international commercial disputes.

Agentic commerce adds a sixth method that's emerging alongside these:

**6. Automated or on-chain arbitration.** A programmatic process evaluates evidence against pre-defined criteria and issues an outcome. The commitment record defines the criteria. The evidence is what was submitted during fulfillment. This is a described model, not a guaranteed mechanism. In SAAX's current escrow implementation on Base Sepolia, a disputed escrow can be resolved only by the evaluator whose address is bound in the agreement — the evaluator signs a release or refund verdict. There is no automated arbitrator, no operator override, and no guaranteed outcome. If the evaluator disappears, the disputed funds remain locked. General arbitration (negotiation, mediation, binding arbitration, litigation) is a separate process that can happen off-chain between the parties; SAAX does not perform arbitration.

The first five methods still apply in agent commerce. The sixth is what the infrastructure is adding — and it depends entirely on having a commitment record that both sides accept as authoritative.

## What are the chances of winning a dispute?

Winning a dispute depends almost entirely on what evidence exists and on the rules of the forum that decides it. The merits matter less than people expect, because disputes are usually decided on records, not on intentions. SAAX does not decide disputes and does not guarantee any particular outcome.

Three factors determine the outcome:

**Whether a structured record exists.** If there's a signed commitment that shows what was agreed, what was delivered, and what evidence was submitted, the dispute is decidable on facts. If there isn't, the case is decided on testimony — and testimony favors whoever presents it more persuasively.

**Whether the acceptance criteria were explicit.** A commitment that says "deliver a working security scan" is harder to dispute than one that says "deliver a PDF with at least three findings." The more specific the criteria, the clearer the outcome.

**Whether the evidence is verifiable.** A merchant who says "we shipped it" and a merchant who provides a signed delivery receipt with a timestamp and hash are in different positions. The first is an assertion. The second is evidence.

In card network chargebacks, merchants win a meaningful fraction of disputes — somewhere around 20-30% historically — and the win rate is strongly correlated with how much evidence they submit. Disputes that come with signed delivery confirmations, tracking numbers, and communication records are won far more often than disputes that come with just an order record.

Agentic commerce follows the same pattern. The commitment layer exists to make the record stronger before the dispute happens, so that resolution is decidable whether the parties are human or automated.

Without that record, the outcome is essentially a coin flip weighted by whoever has the better story. With it, the outcome is determined by what the evidence shows.

## What is a good dispute reason?

A good dispute reason is one where the commitment record shows a clear gap between what was agreed and what was delivered.

The four reasons that hold up under scrutiny:

**Non-delivery.** The commitment required the seller to deliver something by a deadline. The deadline passed and nothing arrived. This is the cleanest dispute — the evidence is a timestamp and the absence of a delivery record.

**Mismatch with acceptance criteria.** The commitment defined specific acceptance criteria. The delivery arrived but doesn't meet them. The criteria must be objectively verifiable — "the report must include at least three identified vulnerabilities" is disputable. "The report must be good" is not.

**Unauthorized transaction.** The agent acted outside its delegated scope. This requires the commitment to record the authority scope — what the agent was permitted to do, under what value limits, with what counterparty restrictions. If the record shows the agent exceeded the scope, the dispute is decidable.

**Duplicate charge.** The same commitment was settled twice. This is the double-purchase case — the commitment ID should have prevented it, but if it didn't, the duplicate settlement is the evidence.

Weak dispute reasons — the ones that get rejected — are vague claims that don't reference the commitment terms. "I didn't like it" is not a dispute reason in the sense that matters here. "It didn't match the acceptance criteria the commitment specified" is.

The principle: a good dispute reason is one that can be evaluated against the record, not against opinions.

## Do merchants ever win chargeback disputes?

Yes. Merchants win a meaningful fraction of chargebacks — historically around 20 to 30 percent — and the win rate is driven almost entirely by the quality of the evidence they submit.

The pattern across card networks is consistent. Disputes where the merchant provides a signed delivery confirmation, a tracking number, a communication record, and a copy of the terms the buyer agreed to are won far more often than disputes where the merchant provides only an order record. The card network doesn't evaluate who is right. It evaluates whether the merchant can demonstrate that the transaction was legitimate and fulfilled.

The reasons merchants lose:

- **No proof of delivery.** The order record shows the sale but not the fulfillment.
- **No proof of authorization.** The transaction went through but the merchant can't show that the buyer agreed to the specific terms.
- **No proof of communication.** The buyer claims they tried to resolve it; the merchant has no record of responding or not responding.
- **Terms that weren't disclosed.** The buyer disputes a fee or a renewal they say they weren't told about. Without a signed record of the terms, the merchant loses by default.

The pattern matters for agentic commerce because it's the same problem. A merchant who sells to an agent has no way to prove the fulfillment matched the commitment unless the commitment record captures the terms and the evidence. Without it, the merchant is in the position of the card-accepting merchant who shipped the goods but can't prove they arrived.

The commitment layer doesn't change who wins disputes. It changes what evidence both sides have to work with. See the evidence interface at [saax-protocol.com/spec](/spec).

## Which companies are using agentic commerce?

The honest answer is that the infrastructure exists and the adoption is early. Some companies are running real agent commerce at scale. Most are experimenting, piloting, or watching.

The players who are furthest along split into three groups:

**Payment networks and processors.** Stripe, Coinbase, Visa, Mastercard, and Google have all shipped agent-specific payment infrastructure — x402, AP2, Agentic Commerce Experience, and related protocols. Their bet is that agent commerce becomes the dominant transaction type within the decade, and they want the rails in place before it does.

**Agent platforms and frameworks.** LangChain, CrewAI, Mastra, and the MCP ecosystem have made it straightforward to build agents that call paid external services. The tools exist. The agents are being built. Whether the agents are being used for real transactions is the open question.

**Enterprise adopters.** Large companies are deploying agents for internal workflows — procurement, research, data processing — and some are beginning to allow agents to transact with external vendors. This is where real volume exists today. Consumer-facing agent commerce is still small.

The field data from the seller side is sobering: one agent marketplace has over 2,000 active listings and very few completed transactions. Supply is overbuilt. Demand hasn't arrived at the projected scale. The $1.57 trillion market forecast for 2028 assumes the trust problem gets solved. Until it does, most agent commerce runs in narrow B2B contexts where the parties already have contractual relationships and the agents are executing known workflows.

The practical read: anyone claiming large-scale consumer agent commerce today is overstating it. The infrastructure is real. The transactions are real. The scale is not yet what the projections assume. SAAX is being built for the market that's coming, not the market that's here.
