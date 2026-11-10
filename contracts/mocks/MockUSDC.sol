// SPDX-License-Identifier: MIT
// SAAX Phase 3A — MockUSDC (local test double, SYNTHETIC).
// 6-decimal ERC-20 matching Base Sepolia test USDC semantics used by the
// V1/V2 custody contracts (standard bool-returning + exact-amount
// balance-delta checks). Testnet-only; never deployed.
pragma solidity 0.8.26;

contract MockUSDC {
    string public name = "Mock USDC";
    string public symbol = "mUSDC";
    uint8 public decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 v) external { balanceOf[to] += v; totalSupply += v; emit Transfer(address(0), to, v); }
    function approve(address sp, uint256 v) external returns (bool) { allowance[msg.sender][sp] = v; emit Approval(msg.sender, sp, v); return true; }
    function transfer(address to, uint256 v) external returns (bool) { return _transfer(msg.sender, to, v); }
    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        uint256 a = allowance[f][msg.sender];
        if (a != type(uint256).max) { require(a >= v, "allowance"); allowance[f][msg.sender] = a - v; }
        return _transfer(f, to, v);
    }
    function _transfer(address f, address to, uint256 v) internal returns (bool) {
        require(balanceOf[f] >= v, "balance");
        balanceOf[f] -= v; balanceOf[to] += v; emit Transfer(f, to, v); return true;
    }
}