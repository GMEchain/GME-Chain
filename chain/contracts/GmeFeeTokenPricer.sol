// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @dev Arbitrum Nitro's pricer interface (nitro-contracts v3.2, ISequencerInbox.sol).
interface IFeeTokenPricer {
    /// @return child chain fee tokens per 1 parent chain fee token (ETH), 18 decimals.
    function getExchangeRate() external returns (uint256);
}

/// @title GME CHAIN fee token pricer
/// @notice Tells the SequencerInbox how many raw GME equal 1 ETH, so the batch poster
///         is reimbursed in GME for the ETH it spends posting batches.
///
///         rate = ETH/USD (Chainlink, read onchain) / GME/USD (submitted by the keeper)
///
/// Safety rules:
///  - getExchangeRate() NEVER reverts. It is called for every batch spending report;
///    a revert would stop batch posting. Any bad input falls back to the last good value.
///  - GME/USD is per RAW token (uiMultiplier already applied), matching raw onchain balances.
///  - The keeper can move GME/USD at most `maxDeviationBps` per update and at most once
///    per `minUpdateInterval`. Only the owner (a Safe multisig after launch) can set it freely,
///    e.g. after a corporate action.
contract GmeFeeTokenPricer is IFeeTokenPricer, Ownable2Step {
    AggregatorV3Interface public immutable ETH_USD_FEED;
    uint8 private immutable FEED_DECIMALS;

    // Sanity ranges (18 decimals). Anything outside is treated as a broken input.
    uint256 public constant MIN_ETH_USD = 1e18; // $1
    uint256 public constant MAX_ETH_USD = 1e24; // $1,000,000
    uint256 public constant MIN_GME_USD = 1e12; // $0.000001 per raw token
    uint256 public constant MAX_GME_USD = 1e24; // $1,000,000 per raw token
    uint256 private constant FEED_CALL_GAS = 100_000;

    address public keeper;
    uint256 public maxDeviationBps = 1_000; // 10% per keeper update
    uint256 public minUpdateInterval = 60; // seconds
    uint256 public ethFeedMaxAge = 2 hours; // Chainlink ETH/USD heartbeat plus margin

    uint256 public gmeUsd; // USD per raw GME, 18 decimals
    uint256 public gmeUsdUpdatedAt;
    uint256 public ethUsd; // last good USD per ETH, 18 decimals
    uint256 public ethUsdUpdatedAt;

    event KeeperSet(address keeper);
    event GmePriceUpdated(uint256 gmeUsd, address by);
    event EthPriceRefreshed(uint256 ethUsd, uint256 feedUpdatedAt);
    event EthFeedIgnored(uint8 reason); // 1 call failed, 2 non-positive, 3 stale, 4 future timestamp
    event ParamsSet(uint256 maxDeviationBps, uint256 minUpdateInterval, uint256 ethFeedMaxAge);

    error NotKeeper();
    error TooSoon(uint256 nextAllowedAt);
    error DeviationTooLarge(uint256 current, uint256 proposed);
    error ZeroPrice();
    error BadParams();
    error NoEthPrice();
    error PriceOutOfRange();

    constructor(address owner_, address keeper_, AggregatorV3Interface ethUsdFeed, uint256 initialGmeUsd) Ownable(owner_) {
        if (initialGmeUsd < MIN_GME_USD || initialGmeUsd > MAX_GME_USD) revert PriceOutOfRange();
        ETH_USD_FEED = ethUsdFeed;
        FEED_DECIMALS = ethUsdFeed.decimals();
        keeper = keeper_;
        gmeUsd = initialGmeUsd;
        gmeUsdUpdatedAt = block.timestamp;
        emit KeeperSet(keeper_);
        emit GmePriceUpdated(initialGmeUsd, msg.sender);
        // Deployment must start from a valid ETH price.
        if (!_refreshEth()) revert NoEthPrice();
    }

    // ------------------------------------------------------------------ pricer

    /// @inheritdoc IFeeTokenPricer
    function getExchangeRate() external returns (uint256) {
        _refreshEth();
        return _rate();
    }

    /// @notice Same value as getExchangeRate() without refreshing, for monitoring.
    function currentRate() external view returns (uint256) {
        return _rate();
    }

    function _rate() internal view returns (uint256) {
        // Ranges guarantee no overflow (max 1e24 * 1e18) and no division by zero.
        return (ethUsd * 1e18) / gmeUsd;
    }

    /// @dev Reads Chainlink without ever reverting. Returns true if a fresh valid price was stored.
    ///      Uses a raw staticcall: Solidity try/catch does not catch malformed return data.
    function _refreshEth() internal returns (bool) {
        (bool ok, bytes memory data) = address(ETH_USD_FEED).staticcall{gas: FEED_CALL_GAS}(
            abi.encodeWithSelector(AggregatorV3Interface.latestRoundData.selector)
        );
        if (!ok || data.length < 160) {
            emit EthFeedIgnored(1);
            return false;
        }
        (, int256 answer,, uint256 updatedAt,) = abi.decode(data, (uint80, int256, uint256, uint256, uint80));
        if (answer <= 0) {
            emit EthFeedIgnored(2);
            return false;
        }
        if (updatedAt > block.timestamp) {
            emit EthFeedIgnored(4);
            return false;
        }
        if (block.timestamp - updatedAt > ethFeedMaxAge) {
            emit EthFeedIgnored(3);
            return false;
        }
        uint256 scaled = _scale(uint256(answer));
        if (scaled < MIN_ETH_USD || scaled > MAX_ETH_USD) {
            emit EthFeedIgnored(5);
            return false;
        }
        if (updatedAt == ethUsdUpdatedAt) return true; // nothing new
        ethUsd = scaled;
        ethUsdUpdatedAt = updatedAt;
        emit EthPriceRefreshed(scaled, updatedAt);
        return true;
    }

    /// @dev Overflow-safe for any int256 answer: values that would overflow are capped
    ///      above MAX_ETH_USD and then rejected by the range check.
    function _scale(uint256 v) internal view returns (uint256) {
        if (FEED_DECIMALS == 18) return v;
        if (FEED_DECIMALS < 18) {
            uint256 f = 10 ** (18 - FEED_DECIMALS);
            if (v > type(uint256).max / f) return type(uint256).max;
            return v * f;
        }
        return v / 10 ** (FEED_DECIMALS - 18);
    }

    // ------------------------------------------------------------------ keeper

    /// @notice Keeper submits the GME/USD price per raw token, 18 decimals.
    function submitGmePrice(uint256 newGmeUsd) external {
        if (msg.sender != keeper) revert NotKeeper();
        if (newGmeUsd < MIN_GME_USD || newGmeUsd > MAX_GME_USD) revert PriceOutOfRange();
        uint256 next = gmeUsdUpdatedAt + minUpdateInterval;
        if (block.timestamp < next) revert TooSoon(next);
        uint256 cur = gmeUsd;
        uint256 diff = newGmeUsd > cur ? newGmeUsd - cur : cur - newGmeUsd;
        if (diff * 10_000 > cur * maxDeviationBps) revert DeviationTooLarge(cur, newGmeUsd);
        gmeUsd = newGmeUsd;
        gmeUsdUpdatedAt = block.timestamp;
        emit GmePriceUpdated(newGmeUsd, msg.sender);
        _refreshEth();
    }

    // ------------------------------------------------------------------ owner

    /// @notice Unbounded update for emergencies and corporate actions.
    function ownerSetGmePrice(uint256 newGmeUsd) external onlyOwner {
        if (newGmeUsd < MIN_GME_USD || newGmeUsd > MAX_GME_USD) revert PriceOutOfRange();
        gmeUsd = newGmeUsd;
        gmeUsdUpdatedAt = block.timestamp;
        emit GmePriceUpdated(newGmeUsd, msg.sender);
    }

    /// @notice Manual ETH/USD override if the Chainlink feed is down for long.
    function ownerSetEthPrice(uint256 newEthUsd) external onlyOwner {
        if (newEthUsd < MIN_ETH_USD || newEthUsd > MAX_ETH_USD) revert PriceOutOfRange();
        ethUsd = newEthUsd;
        ethUsdUpdatedAt = block.timestamp;
        emit EthPriceRefreshed(newEthUsd, block.timestamp);
    }

    function setKeeper(address k) external onlyOwner {
        keeper = k;
        emit KeeperSet(k);
    }

    function setParams(uint256 maxDevBps, uint256 minInterval, uint256 feedMaxAge) external onlyOwner {
        if (maxDevBps == 0 || maxDevBps > 5_000 || minInterval > 1 days || feedMaxAge < 5 minutes) revert BadParams();
        maxDeviationBps = maxDevBps;
        minUpdateInterval = minInterval;
        ethFeedMaxAge = feedMaxAge;
        emit ParamsSet(maxDevBps, minInterval, feedMaxAge);
    }
}
