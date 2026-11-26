// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AggregatorV3Interface} from "../GmeFeeTokenPricer.sol";

/// @title Mock ETH/USD feed (testnet only)
/// @notice Chainlink AggregatorV3-shaped feed for the GME CHAIN testnet fee pricer.
///         Always reports the current block time, so the pricer never sees it as stale.
///         The owner can move the answer. Never use on mainnet.
contract MockEthUsdFeed is AggregatorV3Interface {
    address public immutable owner;
    int256 public answer;
    uint80 public round = 1;

    event AnswerUpdated(int256 answer, uint80 round);

    constructor(int256 initialAnswer) {
        owner = msg.sender;
        answer = initialAnswer;
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function description() external pure returns (string memory) {
        return "ETH / USD (GME CHAIN testnet mock)";
    }

    function setAnswer(int256 newAnswer) external {
        require(msg.sender == owner, "not owner");
        require(newAnswer > 0, "bad answer");
        answer = newAnswer;
        round += 1;
        emit AnswerUpdated(newAnswer, round);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (round, answer, block.timestamp, block.timestamp, round);
    }
}
