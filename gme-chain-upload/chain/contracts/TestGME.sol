// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title Test GME (tGME)
/// @notice Valueless stand-in for the GME Stock Token, used as the gas token
///         of the GME CHAIN testnet. Plain ERC-20 with 18 decimals and no
///         transfer hooks, fees or rebasing, as Arbitrum custom gas tokens require.
contract TestGME is ERC20, Ownable {
    uint256 public constant DRIP_AMOUNT = 100 ether; // 100 tGME
    uint256 public constant DRIP_COOLDOWN = 1 days;

    mapping(address => uint256) public lastDrip;

    error DripCooldown(uint256 availableAt);

    constructor(address initialOwner) ERC20("Test GME", "tGME") Ownable(initialOwner) {}

    /// @notice Owner can mint for faucets, bridges seeding and tests.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice Public faucet: 100 tGME per address per day.
    function drip() external {
        uint256 next = lastDrip[msg.sender] + DRIP_COOLDOWN;
        if (lastDrip[msg.sender] != 0 && block.timestamp < next) revert DripCooldown(next);
        lastDrip[msg.sender] = block.timestamp;
        _mint(msg.sender, DRIP_AMOUNT);
    }
}
