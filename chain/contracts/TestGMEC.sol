// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title Test GMEC (tGMEC), GME CHAIN testnet only
/// @notice Valueless stand-in for $GMEC so the launchpad can be tried on testnet. No owner.
contract TestGMEC is ERC20 {
    uint256 public constant DRIP_AMOUNT = 100_000 ether;
    uint256 public constant DRIP_COOLDOWN = 1 days;
    mapping(address => uint256) public lastDrip;

    error DripCooldown(uint256 availableAt);

    constructor() ERC20("Test GMEC", "tGMEC") {}

    /// @notice Public faucet: 100,000 tGMEC per address per day.
    function drip() external {
        uint256 next = lastDrip[msg.sender] + DRIP_COOLDOWN;
        if (lastDrip[msg.sender] != 0 && block.timestamp < next) revert DripCooldown(next);
        lastDrip[msg.sender] = block.timestamp;
        _mint(msg.sender, DRIP_AMOUNT);
    }
}
