// Phase D2 — MOCK RPC for network/finality scenarios (LABELED MOCK).
//
// This is NOT a local EVM and makes no real chain interaction. It simulates a
// minimal ethers-compatible JSON-RPC surface so the D2 worker's broadcast +
// reconcile paths can be exercised for:
//   - broadcast timeout / response discarded (send accepted, response lost)
//   - mining before reconciliation (receipt appears after send)
//   - reorg / receipt disappearance (included block hash changes)
//   - unexpected account-nonce consumption
//   - dropped/pending transactions (receipt absent)
//   - persistence failure after chain execution
//   - repeated reconciliation
//
// Every test using this RPC is labeled "MOCK" in its test name per the Phase D2
// mandate ("For network/finality scenarios simulated by mocks, label them
// distinctly from real local-chain tests").

'use strict';

const { EventEmitter } = require('node:events');

class MockRPCProvider extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.chainId default '0x7a69' (31337)
   * @param {Array}  opts.reservations known reservations [{nonce, status}]
   * @param {object} opts.transactions map txHash -> {nonce, status, blockNumber, blockHash} | null
   * @param {object} opts.accountNonce map account -> {latest, pending}
   * @param {Array}  opts.blocks [{number, hash, parentHash, timestamp}]
   */
  constructor(opts = {}) {
    super();
    this.chainId = opts.chainId || '0x7a69';
    this.transactions = opts.transactions || new Map();
    this.accountNonce = opts.accountNonce || new Map();
    this.blocks = opts.blocks || [
      { number: 100, hash: '0x' + 'aa'.repeat(32), parentHash: '0x' + '00'.repeat(32), timestamp: 1000 },
      { number: 101, hash: '0x' + 'bb'.repeat(32), parentHash: '0x' + 'aa'.repeat(32), timestamp: 1001 },
    ];
    this._broadcasts = [];
    this._sendCount = 0;
    this._failNextSend = false;
    this._dropResponse = false;   // simulate send accepted but response discarded
    this._mineAfterSend = false;  // simulate mining before reconciliation
    this._revertedAfterSend = false;
    this._reorgDepth = 0;         // simulate included block hash change
  }

  get _chainIdNum() { return parseInt(this.chainId, 16); }

  // Broadcast: records the raw tx, optionally "drops" the response.
  async broadcastTransaction(signedBytes) {
    this._sendCount += 1;
    if (this._failNextSend) { this._failNextSend = false; throw new Error('MOCK_SEND_FAILURE'); }
    const tx = this._decodeTx(signedBytes);
    this._broadcasts.push(tx);
    if (this._dropResponse) { this._dropResponse = false; throw new Error('MOCK_CONNECTION_DROP_AFTER_SEND'); }
    // Mimic: return a "pending" tx object (hash + nonce) WITHOUT a receipt yet.
    if (this._mineAfterSend) { this._mineAfterSend = false; this._mine(tx); }
    return { hash: tx.hash, nonce: tx.nonce, from: tx.from, to: tx.to };
  }

  _decodeTx(signedBytes) {
    // Minimal decode: hash = keccak of bytes (ethers Transaction.from) — we use
    // ethers to parse properly in the worker; here we only need hash+nonce.
    const { Transaction } = require('ethers');
    const t = Transaction.from(signedBytes);
    return { hash: t.hash, nonce: Number(t.nonce), from: t.from, to: t.to, data: t.data, type: 2 };
  }

  _mine(tx) {
    // Mine the tx at a block that is `_mineIntoDepth` blocks BELOW the head,
    // so finality (depth >= confirmations) holds. The head is extended first.
    const depth = Math.max(this._mineIntoDepth || 1, 1);
    for (let i = 0; i < depth; i += 1) {
      const last = this.blocks[this.blocks.length - 1];
      this.blocks.push({ number: last.number + 1, hash: '0x' + (last.number + 1).toString(16).padStart(2, '0').repeat(32), parentHash: last.hash, timestamp: last.timestamp + 1 });
    }
    const b = this.blocks[this.blocks.length - 1];
    const txBlockIndex = this.blocks.length - 1 - depth + 1; // tx sits `depth-1` under the head
    const txBlock = this.blocks[txBlockIndex];
    // Synthetic MOCK event log for the custody Released event so the worker's
    // outcome check (expected event present) is exercised — the mock has no
    // real contract, so this is the mock's representation of a genuine event.
    // Keccak("Released(bytes32,address,uint256,bytes32)") — see the contract ABI.
    const { id, ZeroAddress, ZeroHash } = require('ethers');
    const releasedTopic = id('Released(bytes32,address,uint256,bytes32)');
    // data = abi.encode(seller (address), amount (uint256), verdictHash (bytes32))
    const mockLogData = require('ethers').AbiCoder.defaultAbiCoder().encode(['address', 'uint256', 'bytes32'], [tx.from || ZeroAddress, 1000, ZeroHash]);
    const mockLog = {
      address: tx.to,
      // Released has TWO indexed args: commitmentId (topic1), seller (topic2)
      topics: [releasedTopic, '0x' + '00'.repeat(31) + '01', tx.from ? '0x' + tx.from.slice(2).toLowerCase().padStart(64, '0') : '0x' + '00'.repeat(31) + '07'],
      data: mockLogData,
      blockNumber: txBlock.number, blockHash: txBlock.hash, transactionHash: tx.hash, transactionIndex: 0, logIndex: 0, removed: false,
    };
    this.transactions.set(tx.hash, { nonce: tx.nonce, status: this._revertedAfterSend ? 0 : 1, blockNumber: txBlock.number, blockHash: txBlock.hash, to: tx.to, from: tx.from, logs: [mockLog] });
  }

  async getTransactionReceipt(hash) {
    const t = this.transactions.get(hash);
    if (!t) return null;
    return { hash, status: t.status, blockNumber: t.blockNumber, blockHash: t.blockHash, to: t.to, logs: t.logs || [], from: t.from };
  }

  async getTransaction(hash) {
    const t = this.transactions.get(hash);
    if (!t) return null;
    return { hash, nonce: t.nonce, from: t.from, to: t.to, blockNumber: t.blockNumber, blockHash: t.blockHash };
  }

  async getBlock(tag) {
    if (tag === 'latest' || tag === undefined) return this.blocks[this.blocks.length - 1];
    const n = Number(tag);
    const b = this.blocks.find((x) => x.number === n);
    if (!b) return null;
    return { ...b };
  }

  async getTransactionCount(account, tag) {
    const m = this.accountNonce.get(account) || { latest: 0, pending: 0 };
    if (tag === 'pending') return m.pending;
    return m.latest;
  }

  // ---- test controls (labeled MOCK helpers) ---------------------------------

  setFailNextSend() { this._failNextSend = true; }
  setDropResponse() { this._dropResponse = true; }
  setMineAfterSend(blocks = 1) {
    this._mineAfterSend = true;
    this._mineIntoDepth = blocks;
  }
  setRevertedAfterSend() { this._revertedAfterSend = true; }

  /** Simulate a reorg: the included block hash changes to a different block. */
  causeReorg(txHash, newBlockHash) {
    const t = this.transactions.get(txHash);
    if (!t) return;
    t.blockHash = newBlockHash;
  }

  setAccountNonce(account, latest, pending) {
    this.accountNonce.set(account, { latest, pending });
  }

  dropPendingTx(txHash) {
    this.transactions.delete(txHash);
  }

  /** Mine the last broadcast tx at `depth` blocks under head (reconcile-time). */
  mineLastBroadcast(depth = 1) {
    const last = this._broadcasts[this._broadcasts.length - 1];
    if (!last) return null;
    this._mineIntoDepth = depth;
    this._mine(last);
    return this.transactions.get(last.hash) || null;
  }

  assertBroadcastCount() { return this._broadcasts.length; }
  getBroadcasts() { return this._broadcasts; }
  get sendCount() { return this._sendCount; }
}

module.exports = { MockRPCProvider };