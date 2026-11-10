# TEST-ONLY KEYS — DO NOT USE ON MAINNET

Every key in this directory is a **test-only key** generated for the SAAX conformance suite.

- They are random test keypairs created for this repository.
- They hold **no funds** on any network.
- They are **not** the Router's signer, seller, buyer, or vault keys.
- They must **never** be used to sign real transactions, hold real value, or authorise real settlements.
- If any tool, script, or integration attempts to use these keys on a mainnet, it is a bug — stop and report.

Test vectors reference these keys by name (e.g. `test-buyer-01`) purely as deterministic signing material for the fixtures. Treat them as disposable: regenerate them freely when creating new vectors.

## Files

- `test-buyer-01/` — test buyer keypair (fixtures only)
- `test-issuer-01/` — test evidence issuer keypair (fixtures only)
- `test-authority-01/` — test authority issuer keypair (fixtures only)