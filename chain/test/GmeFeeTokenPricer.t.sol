// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {GmeFeeTokenPricer, AggregatorV3Interface} from "../contracts/GmeFeeTokenPricer.sol";

contract MockFeed is AggregatorV3Interface {
    int256 public answer = 1756_00000000; // $1756, 8 decimals
    uint256 public updatedAt;
    bool public shouldRevert;
    bool public returnGarbage;

    constructor() { updatedAt = block.timestamp; }
    function set(int256 a, uint256 u) external { answer = a; updatedAt = u; }
    function setRevert(bool r) external { shouldRevert = r; }
    function setGarbage(bool g) external { returnGarbage = g; }
    function decimals() external pure returns (uint8) { return 8; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!shouldRevert, "feed down");
        if (returnGarbage) {
            assembly { return(0, 0) } // malformed return data
        }
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

contract GmeFeeTokenPricerTest is Test {
    MockFeed feed;
    GmeFeeTokenPricer pricer;
    address owner = address(0xA11CE);
    address keeper = address(0xBEEF);

    function setUp() public {
        vm.warp(1_800_000_000);
        feed = new MockFeed();
        pricer = new GmeFeeTokenPricer(owner, keeper, feed, 100e18); // GME = $100
    }

    function test_initialRate() public {
        // 1756 / 100 = 17.56 GME per ETH
        assertEq(pricer.getExchangeRate(), 17.56e18);
    }

    function test_neverRevertsWhenFeedReverts() public {
        feed.setRevert(true);
        assertEq(pricer.getExchangeRate(), 17.56e18);
    }

    function test_neverRevertsOnMalformedFeed() public {
        feed.setGarbage(true);
        assertEq(pricer.getExchangeRate(), 17.56e18);
    }

    function test_ignoresStaleNegativeAndFutureAnswers() public {
        feed.set(-1, block.timestamp);
        assertEq(pricer.getExchangeRate(), 17.56e18);
        feed.set(2000_00000000, block.timestamp - 3 hours);
        assertEq(pricer.getExchangeRate(), 17.56e18);
        feed.set(2000_00000000, block.timestamp + 1);
        assertEq(pricer.getExchangeRate(), 17.56e18);
    }

    function test_picksUpFreshEthPrice() public {
        vm.warp(block.timestamp + 10);
        feed.set(2000_00000000, block.timestamp);
        assertEq(pricer.getExchangeRate(), 20e18);
    }

    function test_keeperBoundedUpdate() public {
        vm.warp(block.timestamp + 61);
        vm.prank(keeper);
        pricer.submitGmePrice(105e18); // +5%
        assertEq(pricer.gmeUsd(), 105e18);

        vm.warp(block.timestamp + 61);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(GmeFeeTokenPricer.DeviationTooLarge.selector, 105e18, 130e18));
        pricer.submitGmePrice(130e18);
    }

    function test_keeperRateLimitedAndAuthorised() public {
        vm.prank(keeper);
        vm.expectRevert();
        pricer.submitGmePrice(101e18); // too soon after deploy

        vm.warp(block.timestamp + 61);
        vm.prank(address(0xBAD));
        vm.expectRevert(GmeFeeTokenPricer.NotKeeper.selector);
        pricer.submitGmePrice(101e18);
    }

    function test_ownerOverrides() public {
        vm.prank(owner);
        pricer.ownerSetGmePrice(50e18);
        assertEq(pricer.getExchangeRate(), 35.12e18);
        vm.prank(keeper);
        vm.expectRevert();
        pricer.ownerSetGmePrice(1e18);
    }

    function testFuzz_getExchangeRateNeverReverts(int256 answer, uint256 age, uint256 gmePrice) public {
        gmePrice = bound(gmePrice, pricer.MIN_GME_USD(), pricer.MAX_GME_USD());
        vm.prank(owner);
        pricer.ownerSetGmePrice(gmePrice);
        age = bound(age, 0, 30 days);
        feed.set(answer, block.timestamp - age);
        pricer.getExchangeRate(); // must not revert for any input
    }

    function testFuzz_rateAlwaysPositiveWithValidPrices(uint256 eth, uint256 gme) public {
        eth = bound(eth, 1e8, 1e14); // $1 .. $1,000,000 at 8 decimals
        gme = bound(gme, pricer.MIN_GME_USD(), pricer.MAX_GME_USD());
        vm.warp(block.timestamp + 1);
        feed.set(int256(eth), block.timestamp);
        vm.prank(owner);
        pricer.ownerSetGmePrice(gme);
        uint256 r = pricer.getExchangeRate();
        assertEq(r, (eth * 1e10 * 1e18) / gme);
    }

    function test_rejectsOutOfRangeOwnerPrices() public {
        vm.startPrank(owner);
        vm.expectRevert(GmeFeeTokenPricer.PriceOutOfRange.selector);
        pricer.ownerSetGmePrice(0);
        vm.expectRevert(GmeFeeTokenPricer.PriceOutOfRange.selector);
        pricer.ownerSetEthPrice(1e30);
        vm.stopPrank();
    }
}
