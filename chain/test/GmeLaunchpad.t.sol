// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {GmeLaunchpad, IUniswapV2FactoryLike, IWGME} from "../contracts/GmeLaunchpad.sol";
import {LaunchToken} from "../contracts/LaunchToken.sol";
import {WrappedGME} from "../contracts/WrappedGME.sol";

interface IPair {
    function getReserves() external view returns (uint112, uint112, uint32);
    function token0() external view returns (address);
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function mint(address) external returns (uint256);
    function sync() external;
}

/// A seller whose receive() tries to trade again on the launchpad (reentrancy).
contract Reenterer {
    GmeLaunchpad pad;
    address token;
    bool public tried;
    bool public reentered;
    constructor(GmeLaunchpad p) { pad = p; }
    function buy(address t) external payable { token = t; pad.buyWithGme{value: msg.value}(t, 0, block.timestamp); }
    function sellAll() external {
        uint256 bal = IERC20(token).balanceOf(address(this));
        IERC20(token).approve(address(pad), bal);
        pad.sellForGme(token, bal, 0, block.timestamp);
    }
    receive() external payable {
        if (tried) return;
        tried = true;
        try pad.buyWithGme{value: msg.value / 2}(token, 0, block.timestamp) { reentered = true; } catch {}
    }
}

/// A buyer that cannot receive GME, so any refund to it must make its trade revert (not vanish).
contract NoReceive {
    function buy(GmeLaunchpad pad, address t) external payable { pad.buyWithGme{value: msg.value}(t, 0, block.timestamp); }
}

contract GmeLaunchpadTest is Test {
    WrappedGME wgme;
    GmeLaunchpad pad;
    IUniswapV2FactoryLike factory;
    address owner = address(0xA11CE);
    address treasury = address(0x7EA5);
    address sink = address(0xB0A5); // stands in for the FeeBurner
    address alice = address(0xA1);
    address bob = address(0xB0B);
    address carol = address(0xCA201);
    uint256 constant TARGET = 300_000 ether; // GME raised before graduation (large, to stress the math)
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    function setUp() public {
        wgme = new WrappedGME();
        bytes memory code = vm.parseJsonBytes(vm.readFile("node_modules/@uniswap/v2-core/build/UniswapV2Factory.json"), ".bytecode");
        bytes memory init = abi.encodePacked(code, abi.encode(address(0)));
        address f;
        assembly { f := create(0, add(init, 0x20), mload(init)) }
        require(f != address(0), "factory deploy failed");
        factory = IUniswapV2FactoryLike(f);
        pad = new GmeLaunchpad(IWGME(address(wgme)), factory, treasury, sink, TARGET, owner);
        for (uint256 i; i < 3; i++) {
            address u = [alice, bob, carol][i];
            vm.deal(u, 20_000_000 ether);
            vm.startPrank(u);
            wgme.deposit{value: 10_000_000 ether}();
            wgme.approve(address(pad), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _launch(address who) internal returns (address token) {
        vm.prank(who);
        (token,) = pad.create("Test Token", "TEST", '{"description":"hi"}', 0, 0, block.timestamp);
    }

    function _buy(address who, address token, uint256 q) internal returns (uint256 out) {
        vm.prank(who);
        out = pad.buy(token, q, 0, block.timestamp);
    }

    function _sell(address who, address token, uint256 t) internal returns (uint256 out) {
        vm.startPrank(who);
        IERC20(token).approve(address(pad), t);
        out = pad.sell(token, t, 0, block.timestamp);
        vm.stopPrank();
    }

    function _launchView(address token) internal view returns (uint256 vQ, uint256 vT, uint256 realQ, uint256 sold, address pair, bool grad) {
        (, , vQ, vT, realQ, sold, , pair, grad) = pad.launches(token);
    }

    // ------------------------------------------------------------ create

    function test_createMintsSupplyToPadAndMakesPair() public {
        address token = _launch(alice);
        assertEq(IERC20(token).totalSupply(), 1_000_000_000 ether);
        assertEq(IERC20(token).balanceOf(address(pad)), 1_000_000_000 ether);
        (, , , , address pair,) = _launchView(token);
        assertEq(pair, factory.getPair(token, address(wgme)));
        assertEq(LaunchToken(token).pair(), pair);
        assertEq(pad.tokenCount(), 1);
    }

    function test_createWithInitialBuy() public {
        vm.prank(alice);
        (address token, uint256 out) = pad.create("A", "A", "", 1_000 ether, 1, block.timestamp);
        assertGt(out, 0);
        assertEq(IERC20(token).balanceOf(alice), out);
    }

    function test_createRejectsBadNames() public {
        vm.prank(alice);
        vm.expectRevert(GmeLaunchpad.NameRequired.selector);
        pad.create("", "A", "", 0, 0, block.timestamp);
        vm.prank(alice);
        vm.expectRevert(GmeLaunchpad.NameRequired.selector);
        pad.create("A", "SEVENTEENCHARSXXX", "", 0, 0, block.timestamp);
    }

    function test_createFeeIsCharged() public {
        vm.prank(owner);
        pad.setParams(100, 5000, 100 ether, TARGET, treasury);
        uint256 before = wgme.balanceOf(alice);
        _launch(alice);
        assertEq(before - wgme.balanceOf(alice), 100 ether);
        assertEq(wgme.balanceOf(sink), 50 ether);
        assertEq(wgme.balanceOf(treasury), 50 ether);
    }

    function test_launchesCanBeClosedButTradingContinues() public {
        address token = _launch(alice);
        _buy(bob, token, 1_000 ether);
        vm.prank(owner);
        pad.setLaunchesOpen(false);
        vm.prank(alice);
        vm.expectRevert(GmeLaunchpad.LaunchesClosed.selector);
        pad.create("B", "B", "", 0, 0, block.timestamp);
        uint256 t = IERC20(token).balanceOf(bob);
        assertGt(_sell(bob, token, t), 0);
    }

    // ------------------------------------------------------------ trading

    function test_buyThenSellLosesOnlyFees() public {
        address token = _launch(alice);
        uint256 q = 10_000 ether;
        uint256 out = _buy(bob, token, q);
        uint256 back = _sell(bob, token, out);
        assertLt(back, q);
        assertApproxEqRel(back, (q * 99 / 100) * 99 / 100, 1e12);
    }

    function test_priceRisesWithBuys() public {
        address token = _launch(alice);
        uint256 p0 = pad.priceOf(token);
        _buy(bob, token, 5_000 ether);
        assertGt(pad.priceOf(token), p0);
    }

    function test_feesSplitSinkAndTreasury() public {
        address token = _launch(alice);
        _buy(bob, token, 10_000 ether);
        assertEq(wgme.balanceOf(sink), 50 ether);
        assertEq(wgme.balanceOf(treasury), 50 ether);
        assertEq(wgme.balanceOf(DEAD), 0, "no GME is destroyed");
    }

    function test_slippageAndDeadline() public {
        address token = _launch(alice);
        (uint256 expected,) = pad.quoteBuy(token, 1_000 ether);
        vm.prank(bob);
        vm.expectRevert(GmeLaunchpad.Slippage.selector);
        pad.buy(token, 1_000 ether, expected + 1, block.timestamp);
        vm.prank(bob);
        vm.expectRevert(GmeLaunchpad.Expired.selector);
        pad.buy(token, 1_000 ether, 0, block.timestamp - 1);
        vm.prank(bob);
        uint256 got = pad.buy(token, 1_000 ether, expected, block.timestamp);
        assertEq(got, expected);
    }

    function test_quoteSellMatchesSell() public {
        address token = _launch(alice);
        uint256 out = _buy(bob, token, 20_000 ether);
        uint256 q = pad.quoteSell(token, out / 2);
        assertEq(_sell(bob, token, out / 2), q);
    }

    function test_unknownToken() public {
        vm.prank(bob);
        vm.expectRevert(GmeLaunchpad.UnknownToken.selector);
        pad.buy(address(0x1234), 1 ether, 0, block.timestamp);
    }

    // ------------------------------------------------------------ native GME

    function test_buyWithGmeMatchesQuoteAndKeepsBooks() public {
        address token = _launch(alice);
        (uint256 expected,) = pad.quoteBuy(token, 1_000 ether);
        uint256 eth0 = bob.balance;
        vm.prank(bob);
        uint256 got = pad.buyWithGme{value: 1_000 ether}(token, expected, block.timestamp);
        assertEq(got, expected);
        assertEq(eth0 - bob.balance, 1_000 ether, "exactly the GME sent");
        (, , uint256 realQ, , ,) = _launchView(token);
        assertEq(wgme.balanceOf(address(pad)), realQ, "pad holds exactly what it owes");
        assertEq(address(pad).balance, 0, "no loose GME left in the pad");
    }

    function test_sellForGmePaysNativeGme() public {
        address token = _launch(alice);
        vm.prank(bob);
        uint256 out = pad.buyWithGme{value: 5_000 ether}(token, 0, block.timestamp);
        uint256 q = pad.quoteSell(token, out);
        uint256 eth0 = bob.balance;
        vm.startPrank(bob);
        IERC20(token).approve(address(pad), out);
        uint256 got = pad.sellForGme(token, out, q, block.timestamp);
        vm.stopPrank();
        assertEq(got, q);
        assertEq(bob.balance - eth0, q, "paid in native GME");
        (, , uint256 realQ, uint256 sold, ,) = _launchView(token);
        assertEq(sold, 0);
        assertEq(wgme.balanceOf(address(pad)), realQ);
    }

    function test_createWithGmePaysFeeAndBuys() public {
        vm.prank(owner);
        pad.setParams(100, 5000, 2 ether, TARGET, treasury);
        uint256 eth0 = alice.balance;
        vm.prank(alice);
        (address token, uint256 out) = pad.createWithGme{value: 102 ether}("Native", "NAT", "", 1, block.timestamp);
        assertGt(out, 0);
        assertEq(IERC20(token).balanceOf(alice), out);
        assertEq(eth0 - alice.balance, 102 ether);
        assertEq(wgme.balanceOf(sink), 1 ether + 0.5 ether, "half the create fee and half the trade fee");
        vm.prank(alice);
        vm.expectRevert(GmeLaunchpad.NotEnoughForFee.selector);
        pad.createWithGme{value: 1 ether}("X", "X", "", 0, block.timestamp);
    }

    function test_nativeSelloutRefundsTheRest() public {
        address token = _launch(alice);
        (, uint256 needed) = pad.quoteBuy(token, 5_000_000 ether);
        uint256 eth0 = carol.balance;
        vm.prank(carol);
        pad.buyWithGme{value: 5_000_000 ether}(token, 0, block.timestamp);
        assertEq(eth0 - carol.balance, needed, "only what the remaining tokens cost");
        (, , , , address pair, bool grad) = _launchView(token);
        assertTrue(grad);
        assertEq(IPair(pair).balanceOf(DEAD), IPair(pair).totalSupply() - 1000);
        assertEq(wgme.balanceOf(address(pad)), 0);
        assertEq(address(pad).balance, 0);
    }

    function test_onlyWgmeCanSendGme() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(pad).call{value: 1 ether}("");
        assertFalse(ok);
    }

    function test_reentrancyFromSellerIsBlocked() public {
        address token = _launch(alice);
        Reenterer r = new Reenterer(pad);
        vm.deal(address(r), 0);
        r.buy{value: 1_000 ether}(token);
        r.sellAll();
        assertTrue(r.tried(), "the seller's receive ran");
        assertFalse(r.reentered(), "the nested trade was refused");
        (, , uint256 realQ, , ,) = _launchView(token);
        assertEq(wgme.balanceOf(address(pad)), realQ);
    }

    function test_refundToAContractThatCannotReceiveReverts() public {
        address token = _launch(alice);
        NoReceive n = new NoReceive();
        vm.expectRevert(GmeLaunchpad.SendFailed.selector);
        n.buy{value: 5_000_000 ether}(pad, token); // sells out: a refund is due and cannot be delivered
    }

    // ------------------------------------------------------------ pool protection before graduation

    function test_cannotSendTokenToPoolBeforeGraduation() public {
        address token = _launch(alice);
        uint256 out = _buy(bob, token, 10_000 ether);
        address pair = LaunchToken(token).pair();
        vm.prank(bob);
        vm.expectRevert(LaunchToken.PoolOpensAtGraduation.selector);
        IERC20(token).transfer(pair, out);
        vm.prank(bob);
        IERC20(token).transfer(carol, out);
        assertEq(IERC20(token).balanceOf(carol), out);
    }

    function test_onlyLaunchpadControlsToken() public {
        address token = _launch(alice);
        vm.expectRevert(LaunchToken.OnlyLaunchpad.selector);
        LaunchToken(token).markGraduated();
        vm.expectRevert(LaunchToken.OnlyLaunchpad.selector);
        LaunchToken(token).setPair(address(1));
    }

    // ------------------------------------------------------------ graduation

    function _sellOut(address token) internal {
        _buy(carol, token, 5_000_000 ether); // far more than needed: only the remaining tokens' cost is charged
    }

    function test_graduatesAtCurveEndPrice() public {
        address token = _launch(alice);
        _buy(bob, token, 50_000 ether);
        uint256 carolBefore = wgme.balanceOf(carol);
        _sellOut(token);
        uint256 spent = carolBefore - wgme.balanceOf(carol);
        assertLt(spent, 5_000_000 ether, "excess must not be charged");

        (uint256 vQ, uint256 vT, uint256 realQ, uint256 sold, address pair, bool grad) = _launchView(token);
        assertTrue(grad);
        assertTrue(LaunchToken(token).graduated());
        assertEq(sold, 800_000_000 ether);
        assertEq(realQ, 0);

        (uint112 r0, uint112 r1,) = IPair(pair).getReserves();
        (uint256 rToken, uint256 rQuote) = IPair(pair).token0() == token ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        assertEq(rToken, 200_000_000 ether);
        assertApproxEqRel(rQuote, TARGET, 1e15, "raises about the target");
        assertApproxEqRel((rQuote * 1e18) / rToken, (vQ * 1e18) / vT, 1e12);
        assertEq(IPair(pair).balanceOf(DEAD), IPair(pair).totalSupply() - 1000);
        assertEq(IERC20(token).balanceOf(address(pad)), 0);
        assertEq(wgme.balanceOf(address(pad)), 0);
    }

    function test_noTradingOnCurveAfterGraduation() public {
        address token = _launch(alice);
        _sellOut(token);
        vm.prank(bob);
        vm.expectRevert(GmeLaunchpad.AlreadyGraduated.selector);
        pad.buy(token, 1 ether, 0, block.timestamp);
        vm.prank(bob);
        vm.expectRevert(GmeLaunchpad.AlreadyGraduated.selector);
        pad.buyWithGme{value: 1 ether}(token, 0, block.timestamp);
        uint256 t = IERC20(token).balanceOf(carol);
        vm.startPrank(carol);
        IERC20(token).approve(address(pad), t);
        vm.expectRevert(GmeLaunchpad.AlreadyGraduated.selector);
        pad.sell(token, t, 0, block.timestamp);
        IERC20(token).transfer(LaunchToken(token).pair(), 1 ether);
        vm.stopPrank();
    }

    function test_donationToPairCannotBlockGraduation() public {
        address token = _launch(alice);
        address pair = LaunchToken(token).pair();
        vm.startPrank(bob);
        wgme.transfer(pair, 1_000 ether);
        IPair(pair).sync();
        vm.stopPrank();
        _sellOut(token);
        (, , , , , bool grad) = _launchView(token);
        assertTrue(grad);
        assertGt(IPair(pair).balanceOf(DEAD), 0);
    }

    function test_pairCreatedByOthersFirstStillWorks() public {
        address predicted = vm.computeCreateAddress(address(pad), vm.getNonce(address(pad)));
        factory.createPair(predicted, address(wgme));
        address token = _launch(alice);
        assertEq(token, predicted);
        _sellOut(token);
        (, , , , , bool grad) = _launchView(token);
        assertTrue(grad);
    }

    // ------------------------------------------------------------ owner limits

    function test_ownerParamBounds() public {
        vm.startPrank(owner);
        vm.expectRevert(GmeLaunchpad.BadParam.selector);
        pad.setParams(201, 5000, 0, TARGET, treasury);
        vm.expectRevert(GmeLaunchpad.BadParam.selector);
        pad.setParams(100, 10_001, 0, TARGET, treasury);
        vm.expectRevert(GmeLaunchpad.BadParam.selector);
        pad.setParams(100, 5000, 0, TARGET, address(0));
        vm.expectRevert(GmeLaunchpad.BadParam.selector);
        pad.setBurnSink(address(0));
        vm.stopPrank();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        pad.setParams(100, 5000, 0, TARGET, treasury);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        pad.setBurnSink(bob);
    }

    function test_newTargetOnlyAffectsNewLaunches() public {
        address a = _launch(alice);
        vm.prank(owner);
        pad.setParams(100, 5000, 0, TARGET * 2, treasury);
        address b = _launch(alice);
        (, , , , , , uint256 ta, ,) = pad.launches(a);
        (, , , , , , uint256 tb, ,) = pad.launches(b);
        assertEq(ta, TARGET);
        assertEq(tb, TARGET * 2);
    }

    function test_productionTargetOf100Gme() public {
        GmeLaunchpad real = new GmeLaunchpad(IWGME(address(wgme)), factory, treasury, sink, 100 ether, owner);
        vm.prank(alice);
        (address token,) = real.createWithGme{value: 0}("Hundred", "HUND", "", 0, block.timestamp);
        assertApproxEqRel(real.priceOf(token), 31_250_000_000, 1e15, "start price 3.125e-8 GME per token");
        (, uint256 needed) = real.quoteBuy(token, 1_000 ether);
        vm.prank(bob);
        real.buyWithGme{value: 1_000 ether}(token, 0, block.timestamp);
        (, , , , , , , address pair, bool grad) = real.launches(token);
        assertTrue(grad);
        assertApproxEqRel(needed, 101 ether, 2e15, "100 GME raised plus the 1% fee");
        (uint112 r0, uint112 r1,) = IPair(pair).getReserves();
        (uint256 rToken, uint256 rQuote) = IPair(pair).token0() == token ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        assertApproxEqRel((rQuote * 1e18) / rToken, 500_000_000_000, 1e15, "pool opens at 5e-7 GME per token");
    }

    // ------------------------------------------------------------ fuzz

    /// The pad always holds exactly the GME it owes to live curves, whatever mix of native and WGME trades.
    function testFuzz_solvency(uint256 seed, uint8 steps) public {
        address token = _launch(alice);
        address[3] memory users = [alice, bob, carol];
        uint256 n = bound(steps, 1, 40);
        for (uint256 i; i < n; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            address u = users[seed % 3];
            (, , , , , bool grad) = _launchView(token);
            if (grad) break;
            uint256 kind = (seed >> 8) % 4;
            if (kind == 0) {
                _buy(u, token, bound(seed >> 16, 1 ether, 60_000 ether));
            } else if (kind == 1) {
                vm.prank(u);
                pad.buyWithGme{value: bound(seed >> 16, 1 ether, 60_000 ether)}(token, 0, block.timestamp);
            } else {
                uint256 bal = IERC20(token).balanceOf(u);
                if (bal == 0) continue;
                uint256 amt = bound(seed >> 16, 1, bal);
                if (pad.quoteSell(token, amt) == 0) continue;
                if (kind == 2) {
                    _sell(u, token, amt);
                } else {
                    vm.startPrank(u);
                    IERC20(token).approve(address(pad), amt);
                    pad.sellForGme(token, amt, 0, block.timestamp);
                    vm.stopPrank();
                }
            }
            (, , uint256 realQ, uint256 sold, , bool g) = _launchView(token);
            if (!g) {
                assertEq(wgme.balanceOf(address(pad)), realQ, "pad holds exactly what it owes");
                assertEq(IERC20(token).balanceOf(address(pad)), 1_000_000_000 ether - sold);
            }
            assertEq(address(pad).balance, 0, "no loose GME");
        }
    }

    /// Buying and selling back right away never makes money.
    function testFuzz_noFreeProfit(uint256 pre, uint256 q) public {
        address token = _launch(alice);
        pre = bound(pre, 0, 200_000 ether);
        if (pre > 0) _buy(carol, token, pre);
        (, , , , , bool grad) = _launchView(token);
        vm.assume(!grad);
        q = bound(q, 1 ether, 100_000 ether);
        uint256 out = _buy(bob, token, q);
        (, , , , , grad) = _launchView(token);
        vm.assume(!grad);
        uint256 back = _sell(bob, token, out);
        assertLt(back, q);
    }

    /// Selling everything that was bought always succeeds and the curve returns to its start.
    function testFuzz_everyoneCanExit(uint256 a, uint256 b) public {
        address token = _launch(alice);
        a = bound(a, 1 ether, 120_000 ether);
        b = bound(b, 1 ether, 120_000 ether);
        uint256 ta = _buy(bob, token, a);
        vm.prank(carol);
        uint256 tb = pad.buyWithGme{value: b}(token, 0, block.timestamp);
        _sell(bob, token, ta);
        vm.startPrank(carol);
        IERC20(token).approve(address(pad), tb);
        pad.sellForGme(token, tb, 0, block.timestamp);
        vm.stopPrank();
        (, , uint256 realQ, uint256 sold, , ) = _launchView(token);
        assertEq(sold, 0);
        assertEq(wgme.balanceOf(address(pad)), realQ);
    }
}
