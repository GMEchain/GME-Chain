// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title GmecStaking
/// @notice Stake $GMEC on Robinhood Chain to earn gas credits for GME CHAIN.
///
/// Credits are measured in token-days: staking 100 $GMEC for 3 days earns 300 token-days
/// (stored with 18 decimals, like the token). Credits are not tokens: they cannot be
/// transferred or sold, and they pay no yield. They can only be spent as gas on GME CHAIN,
/// through a redeemer address that records every use on chain.
///
/// Guarantees for stakers:
///  - unstake any time, no lock, no fee;
///  - nobody, including the owner, can move staked tokens;
///  - credits already earned stay earned after unstaking;
///  - the owner can only pause NEW stakes and choose the redeemer; it can never pause unstaking.
contract GmecStaking is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The $GMEC token.
    IERC20 public immutable token;

    /// @notice Total $GMEC currently staked (only tokens that arrived through stake()).
    uint256 public totalStaked;

    /// @notice Address allowed to spend credits when users redeem them for gas.
    address public redeemer;

    /// @notice New stakes are accepted while true. Unstaking is never blocked.
    bool public stakingOpen = true;

    struct Account {
        uint256 staked; // $GMEC staked, in token wei
        uint256 tokenSeconds; // credits earned so far, in token wei x seconds
        uint256 spent; // credits spent, in token-days (18 decimals)
        uint64 updatedAt; // last time tokenSeconds was brought up to date
    }

    mapping(address => Account) private accounts;

    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event CreditsSpent(address indexed user, uint256 amount, bytes32 indexed ref);
    event RedeemerSet(address indexed redeemer);
    event StakingOpenSet(bool open);
    event Recovered(address indexed token, address indexed to, uint256 amount);

    error ZeroAmount();
    error StakingClosed();
    error InsufficientStake(uint256 staked, uint256 requested);
    error InsufficientCredits(uint256 available, uint256 requested);
    error NotRedeemer();
    error NothingToRecover();

    constructor(IERC20 token_, address owner_) Ownable(owner_) {
        token = token_;
    }

    // ---------------------------------------------------------------- stakers

    /// @notice Stake `amount` $GMEC. Approve this contract first.
    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (!stakingOpen) revert StakingClosed();
        Account storage a = _sync(msg.sender);
        // count what actually arrived, in case the token ever takes a transfer fee
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();
        a.staked += received;
        totalStaked += received;
        emit Staked(msg.sender, received);
    }

    /// @notice Unstake `amount` $GMEC. Always allowed. Earned credits are kept.
    function unstake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Account storage a = _sync(msg.sender);
        if (amount > a.staked) revert InsufficientStake(a.staked, amount);
        a.staked -= amount;
        totalStaked -= amount;
        token.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    // ---------------------------------------------------------------- views

    /// @notice $GMEC staked by `user`.
    function stakedOf(address user) external view returns (uint256) {
        return accounts[user].staked;
    }

    /// @notice Credits ever earned by `user`, in token-days (18 decimals).
    function earnedOf(address user) public view returns (uint256) {
        Account storage a = accounts[user];
        uint256 tokenSeconds = a.tokenSeconds + a.staked * (block.timestamp - a.updatedAt);
        return tokenSeconds / 1 days;
    }

    /// @notice Credits `user` can still spend, in token-days (18 decimals).
    function creditsOf(address user) public view returns (uint256) {
        uint256 earned = earnedOf(user);
        uint256 spent = accounts[user].spent;
        return earned > spent ? earned - spent : 0;
    }

    /// @notice Credits already spent by `user`, in token-days (18 decimals).
    function spentOf(address user) external view returns (uint256) {
        return accounts[user].spent;
    }

    // ---------------------------------------------------------------- redeemer

    /// @notice Spend `amount` of `user`'s credits for gas on GME CHAIN. `ref` links the
    ///         spend to the GME CHAIN transaction or batch it paid for.
    function spendCredits(address user, uint256 amount, bytes32 ref) external {
        if (msg.sender != redeemer) revert NotRedeemer();
        if (amount == 0) revert ZeroAmount();
        uint256 available = creditsOf(user);
        if (amount > available) revert InsufficientCredits(available, amount);
        accounts[user].spent += amount;
        emit CreditsSpent(user, amount, ref);
    }

    // ---------------------------------------------------------------- owner

    function setRedeemer(address redeemer_) external onlyOwner {
        redeemer = redeemer_;
        emit RedeemerSet(redeemer_);
    }

    /// @notice Open or close NEW stakes. Unstaking always stays open.
    function setStakingOpen(bool open) external onlyOwner {
        stakingOpen = open;
        emit StakingOpenSet(open);
    }

    /// @notice Return tokens sent here by mistake. For $GMEC, only the surplus above
    ///         totalStaked can leave, so staked tokens are never touched.
    function recover(IERC20 other, address to) external onlyOwner nonReentrant {
        uint256 amount = other.balanceOf(address(this));
        if (address(other) == address(token)) amount = amount > totalStaked ? amount - totalStaked : 0;
        if (amount == 0) revert NothingToRecover();
        other.safeTransfer(to, amount);
        emit Recovered(address(other), to, amount);
    }

    // ---------------------------------------------------------------- internal

    function _sync(address user) private returns (Account storage a) {
        a = accounts[user];
        if (a.updatedAt != 0) a.tokenSeconds += a.staked * (block.timestamp - a.updatedAt);
        a.updatedAt = uint64(block.timestamp);
    }
}
