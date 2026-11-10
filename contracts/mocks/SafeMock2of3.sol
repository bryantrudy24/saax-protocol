// SPDX-License-Identifier: MIT
// SAAX Phase 3A — SafeMock2of3 (Safe-behavior TEST DOUBLE, LOCAL ONLY).
//
// Reproduces the Safe{Wallet} signature model that the Phase 3A mandate
// requires testing: a contract wallet whose isValidSignature enforces a
// configured OWNER SET + THRESHOLD (here 2-of-3) over an EIP-191-encoded
// hash, following Safe's `checkNSignatures` conventions:
//   - owner signatures are packed n * (r(32) || s(32) || v(1));
//   - each recovered signer must be an owner;
//   - owners must appear in ascending address order (Safe's dedup/order rule);
//   - the number of distinct valid signers must meet the threshold.
//
// This is NOT the Safe singleton. It is the minimal on-chain reproduction of
// Safe's 2-of-3 enforcement so the custody contract's ERC-1271 hook is tested
// with GENUINE cryptographic signatures (real secp256k1 EIP-712 verdict
// signatures from three distinct keys). The real Safe singleton deployment +
// its owner/threshold governance is a Phase 3/4 integration item.
pragma solidity 0.8.26;

contract SafeMock2of3 {
    address[] public owners;
    uint256 public threshold;
    mapping(address => bool) public isOwner;
    bytes4 internal constant MAGIC = 0x1626ba7e;

    error NotSorted();
    error InvalidOwner();
    error InvalidSignature();
    error ThresholdNotMet();

    constructor(address[] memory _owners, uint256 _threshold) {
        for (uint256 i = 0; i < _owners.length; i++) { owners.push(_owners[i]); isOwner[_owners[i]] = true; }
        threshold = _threshold;
    }

    function addOwner(address o) external { require(o != address(0) && !isOwner[o]); isOwner[o] = true; owners.push(o); }
    function removeOwner(address o) external { require(isOwner[o]); isOwner[o] = false; for (uint256 i = 0; i < owners.length; i++) if (owners[i] == o) { owners[i] = owners[owners.length - 1]; owners.pop(); break; } }
    function changeThreshold(uint256 t) external { require(t > 0 && t <= owners.length); threshold = t; }

    function getOwners() external view returns (address[] memory) { return owners; }
    function getThreshold() external view returns (uint256) { return threshold; }

    function isValidSignature(bytes32 _hash, bytes memory _signature) external view returns (bytes4) {
        uint256 n = _signature.length / 65;
        if (_signature.length % 65 != 0) revert InvalidSignature();
        if (_signature.length == 0) revert InvalidSignature();
        if (n < threshold) revert ThresholdNotMet();
        address prevOwner = address(0);
        for (uint256 i = 0; i < n; i++) {
            bytes32 r; bytes32 s; uint8 v;
            assembly {
                r := mload(add(_signature, add(32, mul(i, 65))))
                s := mload(add(_signature, add(64, mul(i, 65))))
                v := byte(0, mload(add(_signature, add(96, mul(i, 65)))))
            }
            if (v < 27) v += 27;
            address owner = ecrecover(_hash, v, r, s);
            if (owner == address(0) || !isOwner[owner]) revert InvalidOwner();
            if (owner <= prevOwner) revert NotSorted();
            prevOwner = owner;
        }
        return MAGIC;
    }
}