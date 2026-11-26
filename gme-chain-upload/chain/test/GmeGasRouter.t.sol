// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {GmeGasRouter, IV3SwapRouter, IWETH9, IERC20Inbox} from "../contracts/GmeGasRouter.sol";

/// Stands in for the GME CHAIN ERC20Inbox: pulls tokenTotalFeeAmount from the caller (like the real inbox does
/// into the bridge) and records the ticket.
contract MockInbox is IERC20Inbox {
    IERC20 public immutable token;
    address public to; uint256 public l2CallValue; uint256 public maxSubmissionCost; address public excessRefund;
    address public valueRefund; uint256 public gasLimit; uint256 public maxFeePerGas; uint256 public total; uint256 public tickets;
    constructor(IERC20 t) { token = t; }
    function createRetryableTicket(address to_, uint256 v, uint256 s, address e, address c, uint256 g, uint256 f, uint256 t, bytes calldata) external returns (uint256) {
        require(t >= v + s + g * f, "insufficient fee");
        require(token.transferFrom(msg.sender, address(this), t), "pull");
        to = to_; l2CallValue = v; maxSubmissionCost = s; excessRefund = e;
        valueRefund = c; gasLimit = g; maxFeePerGas = f; total = t;
        return ++tickets;
    }
}

/// Runs against a fork of Robinhood Chain mainnet (4663): the real GME Stock Token, WETH, Uniswap v3 pools and
/// SwapRouter02. Skipped when ROBINHOOD_RPC is not set (for example ROBINHOOD_RPC=https://robinhood.drpc.org).
contract GmeGasRouterForkTest is Test {
    address constant GME = 0x1b0E319c6A659F002271B69dB8A7df2F911c153E; // GameStop • Robinhood Token
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2; // Uniswap SwapRouter02
    address constant GME_USDG_POOL = 0xE9713f453aDB9245B19559790c96F470a18F2fDF; // holds GME, used as a donor

    GmeGasRouter zap;
    MockInbox inbox;
    address user = makeAddr("user");
    bytes direct = abi.encodePacked(WETH, uint24(500), GME);
    bytes viaUsdg = abi.encodePacked(WETH, uint24(500), USDG, uint24(10000), GME);
    bool forked;

    function setUp() public {
        string memory rpc = vm.envOr("ROBINHOOD_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
        inbox = new MockInbox(IERC20(GME));
        zap = new GmeGasRouter(IV3SwapRouter(ROUTER), IWETH9(WETH), IERC20(GME), inbox);
        vm.deal(user, 10 ether);
    }

    modifier onFork() { if (!forked) { vm.skip(true); return; } _; }

    function _assertEmpty() internal view {
        assertEq(IERC20(GME).balanceOf(address(zap)), 0, "GME left");
        assertEq(IERC20(WETH).balanceOf(address(zap)), 0, "WETH left");
        assertEq(address(zap).balance, 0, "ETH left");
    }

    function test_depositEthBuysGmeAndOpensTicketToReceiver() public onFork {
        uint256 gasLimit = 300_000; uint256 fee = 0.01 gwei;
        vm.prank(user);
        uint256 out = zap.depositEth{value: 0.01 ether}(direct, 0.5 ether, user, gasLimit, fee);
        // ~0.63 GME for 0.01 ETH at ~$27 GME / ~$1,690 ETH
        assertGt(out, 0.5 ether);
        assertEq(IERC20(GME).balanceOf(address(inbox)), out);
        assertEq(inbox.total(), out);
        assertEq(inbox.to(), user);
        assertEq(inbox.l2CallValue(), out - gasLimit * fee);
        assertEq(inbox.maxSubmissionCost(), 0);
        assertEq(inbox.excessRefund(), user);
        assertEq(inbox.valueRefund(), user);
        _assertEmpty();
    }

    function test_depositToAnotherAddress() public onFork {
        address friend = makeAddr("friend");
        vm.prank(user);
        zap.depositEth{value: 0.01 ether}(direct, 0, friend, 100_000, 0.01 gwei);
        assertEq(inbox.to(), friend);
        assertEq(inbox.excessRefund(), friend);
        assertEq(inbox.valueRefund(), friend);
    }

    function test_multiHopThroughUsdg() public onFork {
        vm.prank(user);
        uint256 out = zap.depositEth{value: 0.01 ether}(viaUsdg, 0.5 ether, user, 100_000, 0.01 gwei);
        assertGt(out, 0.5 ether);
        _assertEmpty();
    }

    function test_slippageFloorIsEnforced() public onFork {
        vm.prank(user);
        vm.expectRevert(); // Uniswap: "Too little received"
        zap.depositEth{value: 0.01 ether}(direct, 100 ether, user, 100_000, 0.01 gwei);
    }

    function test_rejectsBadPaths() public onFork {
        vm.startPrank(user);
        vm.expectRevert(GmeGasRouter.BadPath.selector);
        zap.depositEth{value: 0.01 ether}(abi.encodePacked(WETH, uint24(500), USDG), 0, user, 100_000, 1);
        vm.expectRevert(GmeGasRouter.BadPath.selector);
        zap.depositEth{value: 0.01 ether}(abi.encodePacked(GME, uint24(500), WETH), 0, user, 100_000, 1);
        vm.expectRevert(GmeGasRouter.BadPath.selector);
        zap.depositEth{value: 0.01 ether}(abi.encodePacked(WETH, uint16(500), GME), 0, user, 100_000, 1);
        vm.stopPrank();
    }

    function test_rejectsZeroValueZeroReceiverAndFeeAboveDeposit() public onFork {
        vm.startPrank(user);
        vm.expectRevert(GmeGasRouter.ZeroAmount.selector);
        zap.depositEth(direct, 0, user, 100_000, 1);
        vm.expectRevert(GmeGasRouter.ZeroAddress.selector);
        zap.depositEth{value: 0.01 ether}(direct, 0, address(0), 100_000, 1);
        vm.expectRevert(GmeGasRouter.FeeAboveDeposit.selector);
        zap.depositEth{value: 0.01 ether}(direct, 0, user, 1_000_000, 1 ether);
        vm.stopPrank();
    }

    function test_swapGmeToEthPaysEthToReceiver() public onFork {
        vm.prank(GME_USDG_POOL);
        IERC20(GME).transfer(user, 2 ether);
        address payable dest = payable(makeAddr("dest"));
        vm.startPrank(user);
        IERC20(GME).approve(address(zap), 2 ether);
        uint256 out = zap.swapGmeToEth(2 ether, abi.encodePacked(GME, uint24(500), WETH), 0.01 ether, dest);
        vm.stopPrank();
        // ~0.0317 ETH for 2 GME
        assertGt(out, 0.01 ether);
        assertEq(dest.balance, out);
        assertEq(IERC20(GME).balanceOf(user), 0);
        _assertEmpty();
    }

    function test_swapGmeToEthRejectsBadPathAndSlippage() public onFork {
        vm.prank(GME_USDG_POOL);
        IERC20(GME).transfer(user, 1 ether);
        vm.startPrank(user);
        IERC20(GME).approve(address(zap), 1 ether);
        vm.expectRevert(GmeGasRouter.BadPath.selector);
        zap.swapGmeToEth(1 ether, abi.encodePacked(WETH, uint24(500), GME), 0, user);
        vm.expectRevert();
        zap.swapGmeToEth(1 ether, abi.encodePacked(GME, uint24(500), WETH), 1 ether, user);
        vm.stopPrank();
    }

    function test_plainEthIsRefused() public onFork {
        vm.prank(user);
        (bool ok,) = address(zap).call{value: 1 ether}("");
        assertFalse(ok);
    }
}
