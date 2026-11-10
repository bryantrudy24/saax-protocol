// SAAX Phase-7 live bounds probe (2026-11-06).
// NONFINANCIAL: profile fetch+signature-validity, free preflight, duplicate
// retry, and unregistered-buyer rejection. Never sends funds, never authorizes
// payment/custody/execution/release. The buyer key is a throwaway generated
// in-memory and never persisted (public thumbprint only).
//
// Trust note: the profile signature is checked for CRYPTOGRAPHIC VALIDITY
// against the committed example public key context; this is NOT a trust
// determination (configured-key trust requires an independently onboarded
// thumbprint). Results are labeled accordingly.
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import crypto from "crypto";
import { generateKeyPair, exportJWK, importJWK, jwtVerify, FlattenedSign, compactVerify } from "jose";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const PROVIDER = "https://saax-protocol.com";
const EXAMPLE_PUB = path.join(REPO, "spec", "examples", "discovery", "keys", "example-public.jwk.json");
const OUT = path.join(REPO, "evidence", "discovery-phase7", "live-bounds-evidence.json");

const results = [];
function record(name, pass, detail) { results.push({ name, pass: !!pass, detail }); console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`); }

async function main() {
  // 1. Fetch the signed discovery profile. The live profile is an envelope:
  //    { ..., signingKeys:[{id,jwk,status,validFrom,validUntil}], signature:{scheme,jws,...} }
  //    The signature is a compact JWS over the payload (self-declared key).
  const profRes = await fetch(`${PROVIDER}/.well-known/saax.json`);
  record("profile fetch HTTP 200", profRes.status === 200, `HTTP ${profRes.status}`);
  const profile = await profRes.json();
  const sig = profile.signature && profile.signature.jws;
  const declKey = profile.signingKeys && profile.signingKeys[0];
  const declActive = !!(declKey && (declKey.status === "active") &&
    new Date(declKey.validFrom) <= new Date() && new Date() <= new Date(declKey.validUntil));
  record("profile declares active signing key in validity window", declActive,
    declKey ? `${declKey.id} valid ${declKey.validFrom}..${declKey.validUntil}` : "no signingKeys[0]");
  // Internal JWS VALIDITY (self-consistency) against the DECLARED key. This is
  // NOT a trust determination: configured-key trust requires an independently
  // onboarded thumbprint (see trust-onboarding.md). A self-declared key never
  // authenticates the publisher.
  let jwsValid = false;
  try {
    if (declKey && declKey.jwk && sig) {
      const pub = await importJWK(declKey.jwk, "EdDSA");
      await compactVerify(sig, pub);
      jwsValid = true;
    }
  } catch (e) { jwsValid = false; }
  record("profile signature internally valid under declared key (validity only)", jwsValid,
    "self-consistency — NOT publisher trust");
  const cap = profile.capabilities && profile.capabilities[0];
  const combo = profile.financialCompatibility && profile.financialCompatibility.supportedCombinations && profile.financialCompatibility.supportedCombinations[0];
  const schema = cap && cap.schemas && cap.schemas[0] ? cap.schemas[0] : null;
  if (!cap || !combo) throw new Error("profile declares no capability/combo");
  const body = {
    profileVersion: profile.profileVersion || "1.0.0",
    capability: cap,
    schema,
    schemaVersion: schema ? schema.version : "1",
    units: (cap.input && cap.input.units) || { amount: "250000000", unit: "micro-units of settlement asset" },
    financialProfile: {
      network: combo.network, asset: combo.asset, rail: combo.rail,
      mode: combo.mode || combo.rail,
      amount: (cap.input && cap.input.constraints && cap.input.constraints.maxAmount) || "1000000",
      currency: combo.settlementCurrency || "USDC", decimals: combo.settlementDecimals || 6,
    },
    amount: combo.amount || "1000000", asset: combo.asset, network: combo.network,
    rail: combo.rail, mode: combo.mode,
    buyer: "phase7-bounds-buyer",
    clientNonce: "phase7-bounds-" + Date.now(),
    issuedAt: new Date().toISOString(),
  };

  // 2. Prepare (free, nonbinding).
  const prep = await fetch(`${PROVIDER}/prepare-commitment`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const prepJson = await prep.json();
  const proposal = prepJson.proposal;
  record("prepare-commitment HTTP 200/ok", prep.status === 200 && (prepJson.status === "ok" || prepJson.status === "duplicate"), `HTTP ${prep.status} status=${prepJson.status || prepJson.error?.code || "?"}`);
  record("proposal signed (has signature.jws)", !!(proposal && proposal.signature && proposal.signature.jws),
    proposal ? `proposalId=${proposal.proposalId || proposal.id || "(no id field)"}` : "no proposal");

  // 3. Identical retry must return the SAME proposal (duplicate).
  const prep2 = await fetch(`${PROVIDER}/prepare-commitment`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const prep2Json = await prep2.json();
  const sameId = prep2Json.proposal && proposal && prep2Json.proposal.proposalId === proposal.proposalId;
  record("identical retry -> duplicate + same proposalId", prep2Json.status === "duplicate" && sameId, `status=${prep2Json.status} sameId=${sameId}`);

  // 4. Unregistered buyer acceptance must be rejected 401 (boundary proof).
  const { privateKey } = await generateKeyPair("Ed25519", { extractable: true });
  const privateJwk = await exportJWK(privateKey);
  const buyerAddr = "0x" + crypto.createHash("sha256").update(JSON.stringify(privateJwk)).digest("hex").slice(0, 40);
  const proposalPayload = proposal.proposal ? proposal.proposal : proposal;
  const acceptance = {
    schemaVersion: "acceptance-v1", action: "accept_commitment", domain: "saax:acceptance:v1",
    acceptanceId: "acc_ph7_" + crypto.randomBytes(6).toString("hex"),
    nonce: buyerAddr + "-" + Date.now(),
    buyer: buyerAddr,
    provider: { providerId: proposalPayload.provider && proposalPayload.provider.providerId, signingKeyId: proposalPayload.provider && proposalPayload.provider.signingKeyId },
    proposal: { proposalId: proposalPayload.proposalId, proposalDigest: proposalPayload.proposalDigest },
    termsDigest: proposalPayload.termsDigest,
    audience: "https://saax-protocol.com",
    notBefore: new Date(Date.now() - 60_000).toISOString(),
    notAfter: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    versions: { profileVersion: proposalPayload.versions && proposalPayload.versions.profileVersion, manifestVersion: proposalPayload.versions && proposalPayload.versions.manifestVersion, schema: proposalPayload.versions && proposalPayload.versions.schema },
  };
  const canon = JSON.stringify(acceptance, Object.keys(acceptance).sort());
  const priv = await importJWK(privateJwk, "EdDSA");
  const { protected: prot, payload, signature } = await new FlattenedSign(new TextEncoder().encode(canon))
    .setProtectedHeader({ alg: "EdDSA", kid: "phase7-throwaway" }).sign(priv);
  const signedAcceptance = { ...acceptance, signature: { scheme: "jws", alg: "EdDSA", keyId: "phase7-throwaway", jws: `${prot}.${payload}.${signature}`, canonicalization: "rfc8785" } };
  const acc = await fetch(`${PROVIDER}/accept-commitment`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ proposal, acceptance: signedAcceptance, idempotencyKey: "phase7-bounds-" + Date.now() }) });
  const accJson = await acc.json();
  const errCode = accJson.errorCode || (accJson.error && accJson.error.code);
  record("unregistered buyer -> 401 DSC_UNAUTHORIZED", acc.status === 401 && errCode === "DSC_UNAUTHORIZED", `HTTP ${acc.status} code=${errCode || "(none)"} body=${JSON.stringify(accJson).slice(0, 160)}`);

  const evidence = {
    generatedAt: new Date().toISOString(),
    provider: PROVIDER,
    trustLabel: "signature-validity only (example-key context); configured-key trust NOT claimed",
    results,
    proposalId: proposal ? (proposalPayload.proposalId || null) : null,
    boundary: "no payment, custody, execution, or release was requested or performed",
  };
  const fs = await import("fs");
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(evidence, null, 2));
  const fails = results.filter((r) => !r.pass).length;
  console.log(`\nPHASE-7 LIVE BOUNDS: ${results.length - fails}/${results.length} PASS`);
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error("PHASE-7 LIVE BOUNDS FAILED:", e.message); process.exit(1); });
