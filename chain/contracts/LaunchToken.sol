// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title LaunchToken
/// @notice A token created on the GME CHAIN launchpad. Fixed supply, minted once to the launchpad,
/// no owner, no mint, no fees, no blacklist.
///
/// One rule until the token graduates: nobody but the launchpad can send it to its exchange pool.
/// That stops anyone from seeding the pool at a wrong price before the launchpad adds the real
/// liquidity. After graduation the token is a plain ERC-20.
contract LaunchToken is ERC20 {
    /// @notice The launchpad that created this token and runs its bonding curve.
    address public immutable launchpad;
    /// @notice The token's Uniswap V2 pool against the quote token (set once, at launch).
    address public pair;
    /// @notice True once the bonding curve sold out and liquidity moved to the pool.
    bool public graduated;

    error OnlyLaunchpad();
    error PoolOpensAtGraduation();

    constructor(string memory name_, string memory symbol_, uint256 supply) ERC20(name_, symbol_) {
        launchpad = msg.sender;
        _mint(msg.sender, supply);
    }

    function setPair(address pair_) external {
        if (msg.sender != launchpad || pair != address(0)) revert OnlyLaunchpad();
        pair = pair_;
    }

    function markGraduated() external {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        graduated = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (!graduated && to == pair && to != address(0) && from != launchpad) revert PoolOpensAtGraduation();
        super._update(from, to, value);
    }
}
