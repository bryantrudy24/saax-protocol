// Launcher: force live EAS mode for the v2 baseline builder, then run it.
// Ensures the real anchor is broadcast regardless of shell env propagation.
process.env.SAAX_EAS_MODE = 'live';
process.env.SAAX_ESCROW_RPC_URL = process.env.SAAX_ESCROW_RPC_URL || 'https://sepolia.base.org';
require('./build-v2-baseline.js');
