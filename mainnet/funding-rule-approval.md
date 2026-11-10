# Funding Rule Approval Record

**Status:** APPROVED
**Date:** 2026-10-19
**Rule:** Funding is permitted only while the evaluator/mutual decision window is open — **T_fund < resolutionDeadline** (strictly before the signed resolution deadline).
**Alternative considered and rejected:** Option B — `T_fund < finalCutoff` (funding allowed up to the final cutoff).

## Decision

The Commander approved **Option A: keep the implemented funding rule `T_fund < resolutionDeadline`** for the V3 custody candidate.

## Rationale (from the F3C decision brief, `mainnet/f3c-status.md` §9)

- Option A is the implemented rule and is conservative: after `resolutionDeadline`, no new funds may enter a position whose evaluator/mutual decision window has closed.
- During `[resolutionDeadline, finalCutoff)`, only timeout refund exits an already-funded position; funding into that gap is rejected, so no funds are committed into a window where only timeout recovery remains.
- Option B would permit a class of escrow that can never reach the seller (fund into the gap where only timeout refund remains) — a silent economic change with no compensating buyer/seller benefit.

## Scope and constraints

- This is an authoritative approval record for the funding-time economic boundary ONLY.
- It does NOT change contract economics, code, or any other policy.
- No deployment, public-chain write, spending, mainnet activation, or candidate freeze is authorized by this record.

## Evidence

- F3A spec: `f3a-custody-v3-spec.md` line 32 — `Fund | fundingEnabled must be true | T_fund < resolutionDeadline | block.timestamp < resolutionDeadline | AfterResolutionDeadline, FundingDisabled`.
- F3C decision brief: `mainnet/f3c-status.md` §9 (prepared for owner approval; this record resolves it as APPROVED).
