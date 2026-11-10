// SAAX Protocol — Day 9, Item 1: Generate the seller wallet (viem)
// Creates a fresh private key via viem's privateKeyToAccount, derives the
// address, and prints both for storage in saax-protocol/.env.
// Usage: node scripts/gen-seller-wallet.js
const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts');

const pk = generatePrivateKey();
const account = privateKeyToAccount(pk);
console.log('SAAX_SELLER_PRIVATE_KEY=' + pk);
console.log('SAAX_SELLER_ADDRESS=' + account.address.toLowerCase());