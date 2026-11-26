// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IFeeBurnerFactory {
    function getPair(address, address) external view returns (address);
}

interface IFeeBurnerPair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function burn(address to) external returns (uint256 amount0, uint256 amount1);
}

interface IFeeBurnerRouter {
    function factory() external view returns (address);
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

/// @title FeeBurner
/// @notice Turns the GME CHAIN exchange's protocol fee into burned $GMEC.
///
/// The exchange is Uniswap V2. Every swap pays 0.3% to the pool. With the factory's `feeTo` set to
/// this contract, 1/6 of that (0.05% of volume) is minted to this contract as pool shares; the
/// other 0.25% stays with liquidity providers. Traders pay the same 0.3% as before.
///
/// Nothing can be taken out of this contract. Pool shares are unwound into their two tokens and
/// stay here; $GMEC held here can only be sent to the dead address; any other token can only be
/// swapped to $GMEC on the exchange, with the $GMEC sent straight to the dead address.
///
/// Unwinding and burning $GMEC are open to anyone. Swapping is limited to the operator (the
/// keeper) or the owner, because an open swap with a caller-chosen minimum could be sandwiched
/// inside one transaction. The owner can only change the operator.
contract FeeBurner is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant MAX_PATH = 4;

    /// @notice $GMEC on GME CHAIN, the token every fee is turned into and burned.
    IERC20 public immutable gmec;
    /// @notice Uniswap V2 Router02 of the GME CHAIN exchange.
    IFeeBurnerRouter public immutable router;
    /// @notice Uniswap V2 factory of the GME CHAIN exchange (whose `feeTo` points here).
    IFeeBurnerFactory public immutable factory;

    /// @notice Address allowed to swap fees to $GMEC (besides the owner).
    address public operator;
    /// @notice Total $GMEC this contract has sent to the dead address.
    uint256 public totalBurned;

    event OperatorSet(address indexed operator);
    event Unwound(address indexed pair, uint256 liquidity, uint256 amount0, uint256 amount1);
    event SwappedAndBurned(address indexed tokenIn, uint256 amountIn, uint256 gmecBurned);
    event Burned(uint256 amount);

    error ZeroAddress();
    error NotOperator();
    error NotAnExchangePair();
    error NothingToUnwind();
    error NothingToBurn();
    error BadPath();

    constructor(IERC20 gmec_, IFeeBurnerRouter router_, address owner_, address operator_) Ownable(owner_) {
        if (address(gmec_) == address(0) || address(router_) == address(0) || operator_ == address(0)) revert ZeroAddress();
        gmec = gmec_;
        router = router_;
        factory = IFeeBurnerFactory(router_.factory());
        operator = operator_;
        emit OperatorSet(operator_);
    }

    modifier onlyOperator() {
        if (msg.sender != operator && msg.sender != owner()) revert NotOperator();
        _;
    }

    /// @notice Change the operator. The operator can only swap tokens held here into burned $GMEC.
    function setOperator(address operator_) external onlyOwner {
        if (operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
        emit OperatorSet(operator_);
    }

    /// @notice Unwind all of this contract's shares of an exchange pool into the pool's two tokens,
    /// which stay in this contract. Anyone can call it.
    function unwind(address pair) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        address t0 = IFeeBurnerPair(pair).token0();
        address t1 = IFeeBurnerPair(pair).token1();
        if (factory.getPair(t0, t1) != pair) revert NotAnExchangePair();
        uint256 liquidity = IERC20(pair).balanceOf(address(this));
        if (liquidity == 0) revert NothingToUnwind();
        IERC20(pair).safeTransfer(pair, liquidity);
        (amount0, amount1) = IFeeBurnerPair(pair).burn(address(this));
        emit Unwound(pair, liquidity, amount0, amount1);
    }

    /// @notice Swap `amountIn` of `path[0]` held here to $GMEC along `path`; the $GMEC goes straight
    /// to the dead address. `path` must end in $GMEC and must not start with it.
    function swapAndBurn(address[] calldata path, uint256 amountIn, uint256 minGmecOut, uint256 deadline)
        external
        onlyOperator
        nonReentrant
        returns (uint256 burned)
    {
        uint256 n = path.length;
        if (n < 2 || n > MAX_PATH || path[n - 1] != address(gmec) || path[0] == address(gmec)) revert BadPath();
        IERC20 tokenIn = IERC20(path[0]);
        uint256 before = gmec.balanceOf(DEAD);
        tokenIn.forceApprove(address(router), amountIn);
        router.swapExactTokensForTokensSupportingFeeOnTransferTokens(amountIn, minGmecOut, path, DEAD, deadline);
        tokenIn.forceApprove(address(router), 0);
        burned = gmec.balanceOf(DEAD) - before;
        totalBurned += burned;
        emit SwappedAndBurned(address(tokenIn), amountIn, burned);
    }

    /// @notice Send all $GMEC held here to the dead address. Anyone can call it.
    function burnGmec() external nonReentrant returns (uint256 amount) {
        amount = gmec.balanceOf(address(this));
        if (amount == 0) revert NothingToBurn();
        totalBurned += amount;
        gmec.safeTransfer(DEAD, amount);
        emit Burned(amount);
    }
}
