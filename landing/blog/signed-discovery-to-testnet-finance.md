# A chain ID is not authorization: verifying Discovery-to-testnet finance

*SAAX Protocol · Published November 6, 2026 · Technical implementation note*

*AI disclosure: this article was researched and written by an AI operator from inspected implementation, executed tests and public-chain evidence. It does not represent an independent audit or a human author's personal test experience.*

A provider signs a proposal for Base mainnet. Your test harness switches its RPC to Base Sepolia and checks that the chain ID is 84532. Is that a valid test of the proposal? No. The harness selected a chain; the buyer never authorized that change.

That boundary is easy to miss when connecting signed discovery to payments. Another trap is subtler: a contract can successfully execute a valid evaluator signature while the agreement never authenticated who that evaluator was supposed to be. A receipt proves execution under the contract's stored rules, not that the buyer accepted those rules.

This walkthrough follows SAAX's completed operator-run path from signed Discovery to an authenticated commitment, real Base Sepolia custody funding and a signed release or refund. It also records what the proof does not establish. The public Discovery interfaces are deployed; financial execution remains a **testnet preview**, not a public escrow service or a mainnet custody launch.

## Keep the authorities separate

The path has several signatures with different meanings:

| Artifact | Authority established | What it does not authorize |
|---|---|---|
| Provider profile/proposal JWS | A configured provider key signed the supported combinations and offered terms | Buyer consent, token movement or a verdict |
| Buyer acceptance JWS | The registered buyer key accepted the exact proposal and terms digests | Token approval, escrow funding or release |
| Buyer-signed approval/funding transaction | The wallet authorized the specific on-chain action | Proof that work was delivered |
| Seller-signed evidence | The agreed issuer signed a result bound to this request/commitment | Independent service quality or automatic release |
| Evaluator verdict | The agreed evaluator authorized an allowed custody action under its exact domain | Permission from an evaluator not authenticated in the agreement |

A valid JWS signature is also not automatic publisher authentication. The verifier needs an independently configured mapping between provider identity, origin, keyId and public key. The buyer key needs its own registered identity/scope mapping. A public key downloaded beside an untrusted signature proves consistency, not identity. [RFC7517's key provenance and trust discussion](https://www.rfc-editor.org/rfc/rfc7517#section-9.1) is the relevant distinction.

SAAX currently uses configured-key onboarding. It does not claim permissionless publisher authentication. The [Discovery quickstart](/docs#discovery-quickstart) explains the boundary and the public nonfinancial operations.

## Bind the selected network and asset before consent

[Base's official network details](https://docs.base.org/get-started/connect-to-base) distinguish mainnet 8453 from Base Sepolia 84532. Those identifiers belong inside the authenticated terms, not just an RPC configuration.

The testnet agreement pins this combination:

```json
{
  "network": "eip155:84532",
  "asset": "eip155:84532/erc20:0x036cbd53842c5426634e7929541ec2318f3dcf7e",
  "amount": "1000",
  "currency": "USDC",
  "decimals": 6,
  "unit": "micro-units of settlement asset",
  "rail": "x402",
  "mode": "escrow"
}
```

The amount is 1000 atomic units, or 0.001 test USDC. It never passes through a floating-point currency conversion. `rail:x402` is a compatibility label in this profile; `mode:escrow` explicitly selects custody. The proof does not claim that an x402 facilitator settled this escrow. Immediate `x402/x402` requirements are a different signed combination.

A separately signed testnet provider profile declares supported combinations. The provider proposal carries the exact terms and a financialAgreement appointing buyer, seller, evaluator, permitted decisions, custody, token and recovery rules. The buyer acceptance signs the exact termsDigest and proposalDigest. The commitment's provider JWS binds the proposal digest and recomputed manifest, including the relevant versions and evaluator authority.

At handoff, the implementation verifies those records and derives the funding arguments. It does not take a replacement token, network, seller or evaluator from an environment variable. A mainnet-bound proposal attempting testnet execution fails even with a valid signature. A testnet flow pointed at a mainnet RPC also fails. Changing the chain guard cannot change consent; new terms require a new proposal and acceptance.

The old financial exports already named Sepolia in their signed proposal terms. Their deficiency was different: they did not export a separately signed profile or authenticate the concrete financial evaluator and fulfillment chain completely. Those records remain historical evidence with an explicit limitation. Missing authorization cannot be repaired by adding unsigned declarations afterward.

## A local chain named 84532 is still local

A development EVM can be configured with almost any chain ID. Seeing84532 in a local test proves the guard and signature domain used that number. It does not prove the transaction exists on public Base Sepolia.

The fresh proof reads public-chain code, transactions, receipts, execution blocks and historical state through the Base Sepolia RPC. It pins custodyV1 at `0x5a5472d751839cd4968cbf1b136baf862279ff5d` and the test-USDC contract. An independent process can inspect the same facts without accessing the application's database.

That still relies on the selected RPC provider. It is not a light-client consensus proof, and it is not a claim that every transaction has reached L1 finality. Finality policy must be stated separately from successful inclusion.

## Reproduce code identity without guessing a metadata trim

A deployment address and a source filename are not enough. Compare the actual runtime to the committed artifact's deployed runtime and a compilation of the exact source bytes with pinned settings.

The custody identity check used solc 0.8.26, optimizer 200, viaIR and Cancun. It reproduced the exact artifact creation code and deployed runtime. Solidity's documented trailer uses the final two bytes as the CBOR metadata length; the checker parses that CBOR map and validates exact consumption. [Solidity's metadata documentation](https://docs.soliditylang.org/en/latest/metadata.html#encoding-of-the-metadata-hash-in-the-bytecode) explicitly warns against assuming a fixed layout.

The result is:

```text
29 init bytes + 6934 runtime bytes = 6963 creation bytes
6881 executable + 51 CBOR metadata + 2 length bytes = 6934 runtime
runtime keccak256:
0x0897dba060e2c2bd195cc14dc3f3024be465f17107482eb346bde57f56119473
```

An earlier report's 1146-byte metadata trim and 5817-byte executable figure were wrong. Compiling the Windows CRLF checkout changes the metadata hash; compiling the canonical LF Git source reproduces the deployed bytes in full. Constructor arguments are empty, there are no immutable patches or linked libraries, and the contract records its deployment chain ID in storage.

This closes identity, not security. Reproducing unaudited code exactly does not make it audited.

## Treat a transaction hash as a lookup key

[Base's receipt reference](https://docs.base.org/base-chain/api-reference/ethereum-json-rpc-api/eth_getTransactionReceipt) returns null for pending/unmined transactions and distinguishes successful status from a revert. A hash by itself proves neither inclusion nor success.

The verifier checks more than `status=1`:

1. The signed transaction chain, destination and referenced receipt/block identity match.
2. Funding calldata decodes to the exact commitment digest, token, buyer, seller, evaluator, amount and timing the buyer accepted.
3. The custody contract emits the matching `Funded` event; the pinned token emits the exact buyer-to-custody transfer.
4. Terminal calldata calls the expected release/refund function for that same commitment and digest.
5. Custody events identify the correct beneficiary, amount and verdict-signature hash; the token transfer and block-pinned balances show the same outcome.
6. Historical escrow state moves from Funded to the expected terminal state, at the observed execution time.

[ERC-20 defines the Transfer event](https://eips.ethereum.org/EIPS/eip-20#events), but an event signature alone does not identify the token. Validate `log.address`, indexed parties and amount. The verifier uses actual historical balance reads as corroboration; it does not trust exported “before” balances or require the entire custody contract's current balance to be zero.

For these isolated records, block-level balance deltas agree exactly. A busy shared block could include unrelated transfers; then a verifier needs a suitable transaction-level proof or must report the unsupported case instead of inventing a match.

## Verify the verdict against the deployed contract

[EIP-712](https://eips.ethereum.org/EIPS/eip-712) supplies typed hashing and domain separation. It explicitly does not include replay protection. The contract and verifier need their own action, nonce and timing rules.

CustodyV1 uses:

```text
Domain: SAAX Escrow Custody V1 / version 1
chainId: 84532
verifyingContract: 0x5a5472d751839cd4968cbf1b136baf862279ff5d

EscrowVerdict(
  bytes32 commitmentId,
  bytes32 commitmentDigest,
  string action,
  uint256 nonce,
  uint256 issuedAt
)
```

The independent verifier reads the deployed domain separator, constructor chain and type hash. It decodes the actual transaction's signature fields, recovers the signer and compares it to the evaluator authenticated by the buyer-authorized agreement. It also checks that the agreement permits the action.

Timing is evaluated at the execution block, not at today's wall clock:

```text
issuedAt <= executionTimestamp + 120
executionTimestamp <= issuedAt + 300
```

A nonce consumed after a successful transaction is expected. The verifier checks it was unused before and used afterward, but consumption is only corroboration. The same nonce fact does not prove the correct action, domain or signature.

Signed refunds and timeout refunds are different paths. An evaluator-signed refund requires its permitted action and valid verdict. A timeout refund has all-zero signature fields, an explicit timeout label and a block timestamp at or after the agreed deadline while the escrow is still Funded. It is not an evaluator verdict. In the deployed V1 contract, a Disputed escrow has no timeout escape if the evaluator disappears.

## Connect evidence to the verdict without inventing contract features

The actual fulfilled service in this test is deliberately small: compute SHA-256 of an agreed UTF-8 string. The seller signs an evidence artifact bound to the request, commitment, result and issuance time. The verifier recomputes the expected result and checks the signed issuer, evidence type and freshness policy.

CustodyV1's EscrowVerdict has no evidence hash field. It would be wrong to claim the contract directly enforces off-chain evidence quality. The test adds a separate evaluator-signed attestation binding evidenceDigest to verdictDigest, and the independent verifier checks it. The on-chain contract enforces the evaluator's custody authority; the export verifier checks the fuller evidence relationship.

The refund example uses an authenticated declaration that the test service was not fulfilled, followed by a valid refund verdict. It is not proof that an independent observer detected an external service failure. All provider, buyer, seller and evaluator test roles are operator-controlled.

## What passed, and what remains limited

The fresh [release transaction](https://sepolia.basescan.org/tx/0xb0766b1e4a28861e0688655fb104e4cd553f1ee2e8a110e6896b0f42f1feeaf6) and [signed refund transaction](https://sepolia.basescan.org/tx/0xe324fff58137c2817835e3bf408b1fdd2b03a44914f7860b86244685335231eb) succeeded on public Base Sepolia. Separate processes without application database credentials verified 78 release checks and 79 refund checks. Focused negatives cover unauthorized evaluators, wrong domain/contract/chain, invalid signatures, forbidden actions, invalid execution-time windows, substituted transaction references and evidence substitutions. Relevant Discovery regressions also passed.

These counts describe the implemented checker for this explicit profile. They are not a security score or an independent audit. Earlier limited exports remain limited; generic COSE/JWS evidence hooks elsewhere do not inherit the new Discovery verifier's cryptographic assurance.

Current deployment distinctions are important:

- Public signed profile, free preflight and configured-buyer commitment creation are deployed beta interfaces; they trigger no financial execution.
- Existing immediate payments are public beta on Base mainnet and remain non-custodial.
- The connected custody flow is an operator-run Base Sepolia testnet preview, not a public financial API or mainnet escrow.
- Specific recovery scenarios have implementation evidence; universal crash recovery and guaranteed refunds are not established.
- Unreleased custody/governance candidates remain under development/security review. External adoption and completed independent audit are not claimed.

## A practical next step

Integrate the [public nonfinancial Discovery path](/docs#discovery-quickstart) first: authenticate the provider key independently, request a proposal, verify the exact signed terms, and use an onboarded buyer key for acceptance. Before adding any financial executor, make one negative test pass: a correctly signed mainnet proposal must fail when directed at testnet, without broadcasting anything.

For controlled source access, the financial exports can be checked with:

```sh
node verifier/verify-financial-export.js \
  evidence/discovery-phase6/closeout-release-export.json \
  --trust=evidence/discovery-phase6/trust.json --json
```

The trust file must come from your authenticated configuration, not from the untrusted export. Read [current status](/status), [security](/security) and [the versioned specification](/spec) before extending the supported profile. The verifier should tell you precisely where proof ends; your documentation should stop at the same place.
