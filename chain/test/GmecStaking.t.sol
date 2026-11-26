// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {GmecStaking} from "../contracts/GmecStaking.sol";

contract MockToken is ERC20 {
    constructor() ERC20("Mock GMEC", "GMEC") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// takes 1% on every transfer, to prove stake() counts what actually arrives
contract FeeToken is ERC20 {
    constructor() ERC20("Fee", "FEE") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0xFEE), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

/// tries to re-enter the staking contract while being transferred
contract ReentrantToken is ERC20 {
    GmecStaking public target;
    bool public attack;
    constructor() ERC20("Re", "RE") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function arm(GmecStaking t) external { target = t; attack = true; }
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (attack && from == address(target)) { attack = false; target.unstake(1); }
    }
}

contract GmecStakingTest is Test {
    MockToken token;
    GmecStaking staking;
    address owner = address(0xA11CE);
    address alice = address(0xA);
    address bob = address(0xB);
    address redeemer = address(0xBEEF);
    uint256 constant E = 1e18;

    function setUp() public {
        vm.warp(1_800_000_000);
        token = new MockToken();
        staking = new GmecStaking(IERC20(address(token)), owner);
        vm.prank(owner);
        staking.setRedeemer(redeemer);
        for (uint256 i; i < 2; i++) {
            address u = i == 0 ? alice : bob;
            token.mint(u, 1_000_000 * E);
            vm.prank(u);
            token.approve(address(staking), type(uint256).max);
        }
    }

    function _stake(address u, uint256 amt) internal { vm.prank(u); staking.stake(amt); }
    function _unstake(address u, uint256 amt) internal { vm.prank(u); staking.unstake(amt); }

    // ------------------------------------------------------------ credits math

    function test_credits_are_token_days() public {
        _stake(alice, 100 * E);
        vm.warp(block.timestamp + 3 days);
        assertEq(staking.creditsOf(alice), 300 * E, "100 tokens x 3 days = 300 token-days");
    }

    function test_credits_accumulate_across_changes() public {
        _stake(alice, 100 * E);
        vm.warp(block.timestamp + 1 days); // 100
        _stake(alice, 100 * E);
        vm.warp(block.timestamp + 1 days); // +200
        _unstake(alice, 150 * E);
        vm.warp(block.timestamp + 2 days); // +100
        assertEq(staking.earnedOf(alice), 400 * E);
        assertEq(staking.stakedOf(alice), 50 * E);
    }

    function test_credits_kept_after_full_unstake_and_stop_growing() public {
        _stake(alice, 10 * E);
        vm.warp(block.timestamp + 5 days);
        _unstake(alice, 10 * E);
        assertEq(staking.creditsOf(alice), 50 * E);
        vm.warp(block.timestamp + 30 days);
        assertEq(staking.creditsOf(alice), 50 * E, "no growth without stake");
    }

    function test_partial_day_rounds_down() public {
        _stake(alice, 1 * E);
        vm.warp(block.timestamp + 12 hours);
        assertEq(staking.creditsOf(alice), E / 2);
    }

    function test_users_are_independent() public {
        _stake(alice, 100 * E);
        vm.warp(block.timestamp + 1 days);
        _stake(bob, 300 * E);
        vm.warp(block.timestamp + 1 days);
        assertEq(staking.creditsOf(alice), 200 * E);
        assertEq(staking.creditsOf(bob), 300 * E);
        assertEq(staking.totalStaked(), 400 * E);
    }

    // ------------------------------------------------------------ unstake guarantees

    function test_unstake_returns_tokens() public {
        uint256 before = token.balanceOf(alice);
        _stake(alice, 42 * E);
        _unstake(alice, 42 * E);
        assertEq(token.balanceOf(alice), before);
        assertEq(staking.totalStaked(), 0);
    }

    function test_cannot_unstake_more_than_staked() public {
        _stake(alice, 5 * E);
        vm.expectRevert(abi.encodeWithSelector(GmecStaking.InsufficientStake.selector, 5 * E, 6 * E));
        _unstake(alice, 6 * E);
    }

    function test_cannot_unstake_someone_elses_tokens() public {
        _stake(alice, 5 * E);
        vm.expectRevert(abi.encodeWithSelector(GmecStaking.InsufficientStake.selector, 0, 1));
        _unstake(bob, 1);
    }

    function test_closing_staking_never_blocks_unstake() public {
        _stake(alice, 5 * E);
        vm.prank(owner);
        staking.setStakingOpen(false);
        vm.expectRevert(GmecStaking.StakingClosed.selector);
        _stake(alice, 1 * E);
        _unstake(alice, 5 * E); // still works
        assertEq(staking.stakedOf(alice), 0);
    }

    function test_zero_amounts_revert() public {
        vm.expectRevert(GmecStaking.ZeroAmount.selector);
        _stake(alice, 0);
        vm.expectRevert(GmecStaking.ZeroAmount.selector);
        _unstake(alice, 0);
    }

    // ------------------------------------------------------------ owner powers are limited

    function test_owner_cannot_take_staked_tokens() public {
        _stake(alice, 1000 * E);
        vm.prank(owner);
        vm.expectRevert(GmecStaking.NothingToRecover.selector);
        staking.recover(IERC20(address(token)), owner);
        assertEq(token.balanceOf(address(staking)), 1000 * E);
    }

    function test_owner_can_only_recover_surplus_sent_by_mistake() public {
        _stake(alice, 1000 * E);
        vm.prank(bob);
        token.transfer(address(staking), 7 * E); // sent directly, not staked
        vm.prank(owner);
        staking.recover(IERC20(address(token)), bob);
        assertEq(token.balanceOf(address(staking)), 1000 * E, "staked tokens untouched");
        _unstake(alice, 1000 * E); // alice can still leave in full
    }

    function test_owner_can_recover_other_tokens() public {
        MockToken other = new MockToken();
        other.mint(address(staking), 3 * E);
        vm.prank(owner);
        staking.recover(IERC20(address(other)), owner);
        assertEq(other.balanceOf(owner), 3 * E);
    }

    function test_only_owner_admin() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        staking.setRedeemer(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        staking.setStakingOpen(false);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        staking.recover(IERC20(address(token)), alice);
        vm.stopPrank();
    }

    function test_ownership_transfer_is_two_step() public {
        vm.prank(owner);
        staking.transferOwnership(bob);
        assertEq(staking.owner(), owner, "not moved until accepted");
        vm.prank(bob);
        staking.acceptOwnership();
        assertEq(staking.owner(), bob);
    }

    // ------------------------------------------------------------ spending credits

    function test_only_redeemer_spends() public {
        _stake(alice, 10 * E);
        vm.warp(block.timestamp + 1 days);
        vm.prank(alice);
        vm.expectRevert(GmecStaking.NotRedeemer.selector);
        staking.spendCredits(alice, 1 * E, bytes32(0));
        vm.prank(owner);
        vm.expectRevert(GmecStaking.NotRedeemer.selector);
        staking.spendCredits(alice, 1 * E, bytes32(0));
    }

    function test_spend_reduces_credits_not_stake() public {
        _stake(alice, 10 * E);
        vm.warp(block.timestamp + 2 days); // 20 credits
        vm.prank(redeemer);
        staking.spendCredits(alice, 15 * E, keccak256("tx1"));
        assertEq(staking.creditsOf(alice), 5 * E);
        assertEq(staking.spentOf(alice), 15 * E);
        assertEq(staking.stakedOf(alice), 10 * E);
        vm.prank(redeemer);
        vm.expectRevert(abi.encodeWithSelector(GmecStaking.InsufficientCredits.selector, 5 * E, 6 * E));
        staking.spendCredits(alice, 6 * E, bytes32(0));
    }

    function test_credits_keep_growing_after_spend() public {
        _stake(alice, 10 * E);
        vm.warp(block.timestamp + 1 days);
        vm.prank(redeemer);
        staking.spendCredits(alice, 10 * E, bytes32(0));
        vm.warp(block.timestamp + 1 days);
        assertEq(staking.creditsOf(alice), 10 * E);
    }

    function test_no_redeemer_means_nobody_spends() public {
        vm.prank(owner);
        staking.setRedeemer(address(0));
        _stake(alice, 10 * E);
        vm.warp(block.timestamp + 1 days);
        vm.prank(address(0xBEEF));
        vm.expectRevert(GmecStaking.NotRedeemer.selector);
        staking.spendCredits(alice, 1, bytes32(0));
    }

    // ------------------------------------------------------------ odd tokens and attacks

    function test_fee_on_transfer_token_counts_what_arrived() public {
        FeeToken ft = new FeeToken();
        GmecStaking s = new GmecStaking(IERC20(address(ft)), owner);
        ft.mint(alice, 100 * E);
        vm.startPrank(alice);
        ft.approve(address(s), type(uint256).max);
        s.stake(100 * E);
        assertEq(s.stakedOf(alice), 99 * E, "1% fee taken in transit");
        assertEq(s.totalStaked(), ft.balanceOf(address(s)));
        s.unstake(99 * E);
        vm.stopPrank();
    }

    function test_reentrancy_is_blocked() public {
        ReentrantToken rt = new ReentrantToken();
        GmecStaking s = new GmecStaking(IERC20(address(rt)), owner);
        rt.mint(alice, 10 * E);
        vm.startPrank(alice);
        rt.approve(address(s), type(uint256).max);
        s.stake(10 * E);
        vm.stopPrank();
        rt.arm(s);
        vm.prank(alice);
        vm.expectRevert(); // nested unstake hits the guard
        s.unstake(1 * E);
        assertEq(s.stakedOf(alice), 10 * E);
    }

    // ------------------------------------------------------------ fuzz

    /// credits always equal the integral of stake over time, whatever the sequence
    function testFuzz_credits_match_reference(uint96[6] memory amts, uint32[6] memory gaps, bool[6] memory isStake) public {
        uint256 staked;
        uint256 tokenSeconds;
        for (uint256 i; i < 6; i++) {
            uint256 gap = bound(gaps[i], 0, 400 days);
            vm.warp(block.timestamp + gap);
            tokenSeconds += staked * gap;
            uint256 amt = bound(amts[i], 1, 100_000 * E);
            if (isStake[i] || staked == 0) {
                _stake(alice, amt);
                staked += amt;
            } else {
                amt = bound(amt, 1, staked);
                _unstake(alice, amt);
                staked -= amt;
            }
        }
        assertEq(staking.stakedOf(alice), staked);
        assertEq(staking.earnedOf(alice), tokenSeconds / 1 days);
        assertEq(staking.totalStaked(), staked);
        assertEq(token.balanceOf(address(staking)), staked, "contract holds exactly the stake");
    }

    /// whatever happens, a staker can always get every staked token back
    function testFuzz_always_withdrawable(uint96 a, uint96 b, uint32 wait, bool close) public {
        uint256 amtA = bound(a, 1, 500_000 * E);
        uint256 amtB = bound(b, 1, 500_000 * E);
        _stake(alice, amtA);
        _stake(bob, amtB);
        vm.warp(block.timestamp + bound(wait, 0, 3650 days));
        if (close) { vm.prank(owner); staking.setStakingOpen(false); }
        _unstake(alice, amtA);
        _unstake(bob, amtB);
        assertEq(token.balanceOf(alice), 1_000_000 * E);
        assertEq(token.balanceOf(bob), 1_000_000 * E);
        assertEq(token.balanceOf(address(staking)), 0);
    }
}
