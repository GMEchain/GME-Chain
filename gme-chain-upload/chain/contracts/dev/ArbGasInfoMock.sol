// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice FORK REHEARSAL ONLY. Stand-in for the ArbGasInfo precompile (0x...6C), placed on
///         the local fork with anvil_setCode. Values mirror Robinhood Chain mainnet as read
///         on 2026-11-20. Never deployed to a real network.
contract ArbGasInfoMock {
    function getL1BaseFeeEstimate() external pure returns (uint256) {
        return 0;
    }

    function getL1GasPriceEstimate() external pure returns (uint256) {
        return 0;
    }

    function getMinimumGasPrice() external pure returns (uint256) {
        return 20_000_000; // 0.02 gwei
    }

    function getPricesInWei() external pure returns (uint256, uint256, uint256, uint256, uint256, uint256) {
        return (0, 0, 0, 20_000_000, 0, 20_000_000);
    }

    function getCurrentTxL1GasFees() external pure returns (uint256) {
        return 0;
    }
}
