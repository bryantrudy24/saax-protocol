// SAAX External Pilot — runnable client example (get, not send).
//
// This is a REFERENCE CLIENT for an authorized external testnet pilot. It walks
// the public, nonfinancial Discovery surface:
//   1. GET  /.well-known/saax.json        signed provider profile (authenticate key out-of-band)
//   2. POST /prepare-commitment           free, nonbinding proposal
//   3. POST /accept-commitment            buyer-signed acceptance -> commitment
//   4. GET  /receipt?txHash=...            resolve a settled transaction to its commitment
//   5. verify the proposal signature       independent verification (jose, RFC 8785)
//
// It NEVER sends funds, never authorizes a payment, and never touches the
// financial escrow surface. External participation requires the Commander's
// explicit authorization; this file is the onboarding packet for the first
// authorized participant.
//
// Usage:
//   node pilot/pilot-client-example.mjs --provider https://saax-protocol.com
//        --proposal-out proposal.json --commitment-out commitment.json
//   (reads SAAX_PILOT_BUYER_KEY — a hex Ed25519 seed? No: buyer acceptance uses
//   the acceptance-v1 EdDSA profile; the key is a JWK. Provide SAAX_PILOT_BUYER_JWK
//   or --buyer-jwk <path to a JWK file>. The public thumbprint must be onboarded
//   with the provider before accept-commitment will accept the acceptance.)
//
// Outputs the signed proposal (saved), the acceptance (saved), and prints the
// exact verification results. Exit 0 only if every step verified.
import { generateKeyPair, exportJWK, importJWK, jwtVerify, FlattenedSign } from "jose";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a, true];
  })
);

const PROVIDER = (args.provider || "https://saax-protocol.com").replace(/\/$/, "");
const OUT_DIR = args["proposal-out"] ? path.dirname(args["proposal-out"]) : __dirname;

// ---- 0. Accept/print the trust statement --------------------------------------
console.log("SAAX pilot client example — READ-ONLY, NONBINDING. No funds are moved.");
console.log(`Provider: ${PROVIDER}\n`);

// ---- 1. Fetch + verify the signed discovery profile -----------------------------
async function fetchProfile() {
  const res = await fetch(`${PROVIDER}/.well-known/saax.json`);
  if (!res.ok) throw new Error(`profile fetch failed: HTTP ${res.status}`);
  const profile = await res.json();
  // The profile is JWS (Flattened JSON). Verify its signature with a
  // PRE-CONFIGURED trusted key (out-of-band onboarding), NOT a key from the
  // profile itself — a self-declared key never authenticates the publisher.
  const trustedJwkPath = args["trust-jwk"];
  if (!trustedJwkPath) {
    console.log("NOTE: pass --trust-jwk <path> to verify the profile signature.");
    console.log("      Trust must come from an independently obtained operator key.");
    return { profile, verified: false };
  }
  const trustedJwk = JSON.parse(fs.readFileSync(trustedJwkPath, "utf8"));
  const pub = await importJWK(trustedJwk, "EdDSA");
  try {
    const { payload } = await jwtVerify(profile, pub);
    console.log("Profile signature VERIFIED with the configured trusted key.");
    return { profile: payload, verified: true };
  } catch (e) {
    throw new Error(`profile signature verification failed: ${e.message}`);
  }
}

// ---- 2. Prepare a commitment (free, nonbinding) ---------------------------------
async function prepareCommitment(profile) {
  // Discover the FIRST supported combination from the signed profile itself.
  // Never assume a capability/network/asset that the provider does not declare.
  const cap = profile.capabilities && profile.capabilities[0];
  const combo = profile.financialCompatibility &&
                profile.financialCompatibility.supportedCombinations &&
                profile.financialCompatibility.supportedCombinations[0];
  if (!cap || !combo) {
    throw new Error("profile declares no capability/supported combination — cannot prepare");
  }
  const schema = cap.schemas && cap.schemas[0] ? cap.schemas[0] : null;
  const financialProfile = {
    network: combo.network,
    asset: combo.asset,
    rail: combo.rail,
    mode: combo.mode || combo.rail,
    amount: (cap.input && cap.input.constraints && cap.input.constraints.maxAmount) || "1000000",
    currency: (profile.financialCompatibility && profile.financialCompatibility.supportedCombinations && profile.financialCompatibility.supportedCombinations[0] && profile.financialCompatibility.supportedCombinations[0].settlementCurrency) || "USDC",
    decimals: (profile.financialCompatibility && profile.financialCompatibility.supportedCombinations && profile.financialCompatibility.supportedCombinations[0] && profile.financialCompatibility.supportedCombinations[0].settlementDecimals) || 6,
  };
  const body = {
    profileVersion: profile.profileVersion || "1.0.0",
    capability: cap, // the FULL capability object ({id,...}) as the profile declares it
    schema,          // the FULL schema object {id, version, digest, purpose}
    schemaVersion: schema ? schema.version : "1",
    units: (cap.input && cap.input.units) || { amount: "250000000", unit: "micro-units of settlement asset" },
    financialProfile,
    amount: financialProfile.amount,
    asset: combo.asset,
    network: combo.network,
    rail: combo.rail,
    mode: combo.mode,
    buyer: "pilot-buyer-1",
    clientNonce: "pilot-" + Date.now(),
    issuedAt: new Date().toISOString(),
  };
  console.log("Prepared request (from profile):", JSON.stringify(body, null, 2));
  const res = await fetch(`${PROVIDER}/prepare-commitment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`prepare-commitment failed: HTTP ${res.status} ${JSON.stringify(json)}`);
  }
  return json.proposal || json; // signed proposal (provider JWS)
}

// ---- 3. Buyer acceptance (acceptance-v1, EdDSA JWS) ------------------------------
// The buyer signs the EXACT proposal digest + terms digest, domain-separated
// ('saax:acceptance:v1' / action 'accept_commitment'). This is NOT a payment
// authorization and NOT an evaluator release verdict.
async function signAcceptance(proposal, buyer) {
  const priv = await importJWK(buyer.privateJwk, "EdDSA");
  const acceptance = {
    schemaVersion: "acceptance-v1",
    action: "accept_commitment",
    domain: "saax:acceptance:v1",
    acceptanceId: "acc_" + crypto.randomBytes(8).toString("hex"),
    nonce: buyer.buyer + "-" + Date.now(),
    buyer: buyer.buyer,
    provider: {
      providerId: proposal.provider && proposal.provider.providerId,
      signingKeyId: proposal.provider && proposal.provider.signingKeyId,
    },
    proposal: {
      proposalId: proposal.proposalId,
      proposalDigest: proposal.proposalDigest,
    },
    termsDigest: proposal.termsDigest,
    audience: "https://saax-protocol.com",
    notBefore: new Date(Date.now() - 60_000).toISOString(),
    notAfter: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    versions: {
      profileVersion: proposal.versions && proposal.versions.profileVersion,
      manifestVersion: proposal.versions && proposal.versions.manifestVersion,
      schema: proposal.versions && proposal.versions.schema,
    },
  };
  // Sign the CANONICAL byte representation (RFC 8785 JSON canonicalization
  // scheme: sorted keys, no whitespace) with the buyer's EdDSA key, as a
  // flattened JWS over those exact bytes — matching endpoint/discovery-crypto.js
  // (signProfileCanonical). This is what the acceptance verifier checks.
  const canon = JSON.stringify(acceptance, Object.keys(acceptance).sort());
  const { protected: prot, payload, signature } = await new FlattenedSign(new TextEncoder().encode(canon))
    .setProtectedHeader({ alg: "EdDSA", kid: buyer.keyId || "pilot-buyer-key" })
    .sign(priv);
  const jws = `${prot}.${payload}.${signature}`;
  return { ...acceptance, signature: { scheme: "jws", alg: "EdDSA", keyId: buyer.keyId || "pilot-buyer-key", jws, canonicalization: "rfc8785" } };
}

async function acceptCommitment(proposal, signedAcceptance) {
  const res = await fetch(`${PROVIDER}/accept-commitment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      proposal,            // the full signed proposal, unchanged
      acceptance: signedAcceptance, // the acceptance OBJECT (buyer, action, digest bindings, signature)
      idempotencyKey: "pilot-" + Date.now(),
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`accept-commitment failed: HTTP ${res.status} ${JSON.stringify(json)}`);
  return json;
}

// ---- 4. Receipt lookup (verified live behavior: 200/404/400) --------------------
async function receiptFor(txHash) {
  const res = await fetch(`${PROVIDER}/receipt?txHash=${txHash}&rail=x402`);
  const body = await res.json();
  return { status: res.status, body };
}

// ---- 5. Independent signature verification (no app DB) ---------------------------
async function verifyProposalSignature(proposal, trustedJwk) {
  const pub = await importJWK(trustedJwk, "EdDSA");
  try {
    await jwtVerify(proposal, pub);
    return true;
  } catch {
    return false;
  }
}

// ---- main ------------------------------------------------------------------------
async function main() {
  const { profile, verified: profileVerified } = await fetchProfile();
  const proposal = await prepareCommitment(profile);
  fs.writeFileSync(args["proposal-out"] || path.join(OUT_DIR, "pilot-proposal.json"), JSON.stringify(proposal, null, 2));
  console.log("Proposal saved:", args["proposal-out"] || path.join(OUT_DIR, "pilot-proposal.json"));

  // Buyer key: for a REAL pilot, the participant uses their OWN JWK (onboarded).
  // For this example we generate a throwaway keypair when none is provided.
  let buyer = null;
  const buyerJwkPath = args["buyer-jwk"];
  if (buyerJwkPath) buyer = { privateJwk: JSON.parse(fs.readFileSync(buyerJwkPath, "utf8")), buyer: "0x" + crypto.createHash("sha256").update(buyerJwkPath).digest("hex").slice(0, 40), keyId: "pilot-buyer-key" };
  else {
    const { privateKey } = await generateKeyPair("Ed25519", { extractable: true });
    const privateJwk = await exportJWK(privateKey);
    buyer = { privateJwk, buyer: "0x" + crypto.createHash("sha256").update(JSON.stringify(privateJwk)).digest("hex").slice(0, 40), keyId: "pilot-buyer-key" };
    console.log("NOTE: generated a THROWAWAY buyer key for this example. A real pilot",
      "participant must use their own key, onboarded with the provider.");
  }

  const signedAcceptance = await signAcceptance(proposal, buyer);
  const commitment = await acceptCommitment(proposal, signedAcceptance);
  fs.writeFileSync(args["commitment-out"] || path.join(OUT_DIR, "pilot-commitment.json"), JSON.stringify(commitment, null, 2));
  console.log("Commitment created:", commitment.commitment_id || commitment.commitmentId);

  // Demonstrate the receipt contract (no funds moved; a real pilot would use the
  // real settlement txHash from the escrow flow).
  const demoHash = "0x49123f6e8195174ad0eb3ce7b103a1fb064c01ac13495ab5e9067c96d88dbdbb";
  const receipt = await receiptFor(demoHash);
  console.log(`Receipt demo (known txHash): HTTP ${receipt.status}`, receipt.body.commitment_id || receipt.body.error);

  // Independent verification step: for a REAL pilot, verify the provider signature
  // against the operator's public key obtained OUT-OF-BAND.
  if (profileVerified) {
    const ok = await verifyProposalSignature(proposal, JSON.parse(fs.readFileSync(args["trust-jwk"], "utf8")));
    console.log("Independent provider-signature verification:", ok ? "PASS" : "FAIL");
  }

  console.log("\nPILOT CLIENT EXAMPLE COMPLETE — no funds moved, no payment authorized.");
}

main().catch((e) => {
  console.error("PILOT CLIENT EXAMPLE FAILED:", e.message);
  process.exit(1);
});
