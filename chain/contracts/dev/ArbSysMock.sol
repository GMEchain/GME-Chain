// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice FORK REHEARSAL ONLY. Anvil does not implement Arbitrum precompiles, so this
///         stand-in is placed at 0x...64 on the local fork with anvil_setCode.
///         Values mirror Robinhood Chain mainnet (ArbOS 61 reports 55 + 61 = 116).
///         Never deployed to a real network.
contract ArbSysMock {
    function arbOSVersion() external pure returns (uint256) {
        return 116;
    }

    function arbChainID() external view returns (uint256) {
        return block.chainid;
    }

    function arbBlockNumber() external view returns (uint256) {
        return block.number;
    }

    function arbBlockHash(uint256 n) external view returns (bytes32) {
        return blockhash(n);
    }

    function isTopLevelCall() external view returns (bool) {
        return msg.sender == tx.origin;
    }

    function wasMyCallersAddressAliased() external pure returns (bool) {
        return false;
    }

    function myCallersAddressWithoutAliasing() external view returns (address) {
        return msg.sender;
    }
}
