// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title Test USD (tUSD), GME CHAIN testnet only
/// @notice Valueless dollar stand-in so testers have something to swap tGME against.
contract TestUSD is ERC20, Ownable {
    uint256 public constant DRIP_AMOUNT = 10_000 ether;
    uint256 public constant DRIP_COOLDOWN = 1 days;
    mapping(address => uint256) public lastDrip;

    error DripCooldown(uint256 availableAt);

    constructor(address initialOwner) ERC20("Test USD", "tUSD") Ownable(initialOwner) {}

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice Public faucet: 10,000 tUSD per address per day.
    function drip() external {
        uint256 next = lastDrip[msg.sender] + DRIP_COOLDOWN;
        if (lastDrip[msg.sender] != 0 && block.timestamp < next) revert DripCooldown(next);
        lastDrip[msg.sender] = block.timestamp;
        _mint(msg.sender, DRIP_AMOUNT);
    }
}
