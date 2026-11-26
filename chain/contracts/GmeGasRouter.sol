// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Uniswap v3 SwapRouter02 (IV3SwapRouter), as deployed on Robinhood Chain.
interface IV3SwapRouter {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

interface IWETH9 {
    function deposit() external payable;
    function withdraw(uint256) external;
}

/// @notice Arbitrum Nitro ERC20Inbox of a custom-gas-token chain (GME CHAIN on Robinhood Chain).
interface IERC20Inbox {
    function createRetryableTicket(
        address to,
        uint256 l2CallValue,
        uint256 maxSubmissionCost,
        address excessFeeRefundAddress,
        address callValueRefundAddress,
        uint256 gasLimit,
        uint256 maxFeePerGas,
        uint256 tokenTotalFeeAmount,
        bytes calldata data
    ) external returns (uint256);
}

/// @title GmeGasRouter
/// @notice Bridge with ETH: ETH on Robinhood Chain in, GME gas on GME CHAIN out, in one transaction.
///         And the way back: GME (claimed from a GME CHAIN withdrawal) in, ETH on Robinhood Chain out.
/// @dev    depositEth: wraps ETH, swaps WETH -> GME on Uniswap v3 along `path`, then opens a retryable
///         ticket on the GME CHAIN inbox addressed to `to`, exactly like the bridge page does for a plain
///         GME deposit (no submission fee on a custom-gas-token chain; `to` is both refund address and
///         call-value refund address, so the GME can only ever end up with `to`).
///         swapGmeToEth: pulls GME, swaps GME -> WETH along `path`, unwraps and sends ETH to `to`.
///
///         No owner, no admin, no fee, no upgrade. The contract holds nothing between transactions:
///         every swap spends the whole input and every output leaves in the same call.
contract GmeGasRouter {
    using SafeERC20 for IERC20;

    IV3SwapRouter public immutable router;
    IWETH9 public immutable weth;
    IERC20 public immutable gme;
    IERC20Inbox public immutable inbox;

    event EthDeposited(address indexed sender, address indexed to, uint256 ethIn, uint256 gmeOut, uint256 gasFee, uint256 ticketId);
    event GmeSwappedToEth(address indexed sender, address indexed to, uint256 gmeIn, uint256 ethOut);

    error ZeroAmount();
    error ZeroAddress();
    error BadPath();
    error FeeAboveDeposit();
    error EthSendFailed();
    error OnlyWeth();

    constructor(IV3SwapRouter router_, IWETH9 weth_, IERC20 gme_, IERC20Inbox inbox_) {
        if (address(router_) == address(0) || address(weth_) == address(0) || address(gme_) == address(0) || address(inbox_) == address(0)) {
            revert ZeroAddress();
        }
        router = router_;
        weth = weth_;
        gme = gme_;
        inbox = inbox_;
        IERC20(address(weth_)).forceApprove(address(router_), type(uint256).max);
        gme_.forceApprove(address(router_), type(uint256).max);
        gme_.forceApprove(address(inbox_), type(uint256).max);
    }

    /// @notice Swap the ETH sent for GME and deposit it to `to` on GME CHAIN as gas.
    /// @param path        Uniswap v3 path, starting with WETH and ending with GME.
    /// @param minGmeOut   Slippage floor for the swap (whole GME output, before the GME CHAIN gas fee).
    /// @param to          Receiver on GME CHAIN (usually the sender).
    /// @param gasLimit    Gas for the ticket's automatic redeem on GME CHAIN.
    /// @param maxFeePerGas Price per gas on GME CHAIN, in GME.
    /// @return gmeOut     GME bought; `gmeOut - gasLimit * maxFeePerGas` arrives at `to`.
    function depositEth(bytes calldata path, uint256 minGmeOut, address to, uint256 gasLimit, uint256 maxFeePerGas)
        external
        payable
        returns (uint256 gmeOut)
    {
        if (msg.value == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        _checkPath(path, address(weth), address(gme));

        weth.deposit{value: msg.value}();
        gmeOut = router.exactInput(
            IV3SwapRouter.ExactInputParams({path: path, recipient: address(this), amountIn: msg.value, amountOutMinimum: minGmeOut})
        );

        uint256 gasFee = gasLimit * maxFeePerGas;
        if (gasFee >= gmeOut) revert FeeAboveDeposit();
        uint256 ticket = inbox.createRetryableTicket(to, gmeOut - gasFee, 0, to, to, gasLimit, maxFeePerGas, gmeOut, "");
        emit EthDeposited(msg.sender, to, msg.value, gmeOut, gasFee, ticket);
    }

    /// @notice Swap GME (for example GME just claimed from a GME CHAIN withdrawal) for ETH on Robinhood Chain.
    /// @dev    Needs a GME allowance for this contract of at least `amountIn`.
    /// @param path      Uniswap v3 path, starting with GME and ending with WETH.
    function swapGmeToEth(uint256 amountIn, bytes calldata path, uint256 minEthOut, address to) external returns (uint256 ethOut) {
        if (amountIn == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        _checkPath(path, address(gme), address(weth));

        gme.safeTransferFrom(msg.sender, address(this), amountIn);
        ethOut = router.exactInput(
            IV3SwapRouter.ExactInputParams({path: path, recipient: address(this), amountIn: amountIn, amountOutMinimum: minEthOut})
        );
        weth.withdraw(ethOut);
        (bool ok,) = to.call{value: ethOut}("");
        if (!ok) revert EthSendFailed();
        emit GmeSwappedToEth(msg.sender, to, amountIn, ethOut);
    }

    /// @dev A v3 path is token (20 bytes) followed by (fee (3 bytes), token (20 bytes)) for every hop.
    function _checkPath(bytes calldata path, address first, address last) private pure {
        if (path.length < 43 || (path.length - 20) % 23 != 0) revert BadPath();
        if (address(bytes20(path[:20])) != first || address(bytes20(path[path.length - 20:])) != last) revert BadPath();
    }

    /// @dev Only WETH unwrapping may send ETH here; anything else would be stranded.
    receive() external payable {
        if (msg.sender != address(weth)) revert OnlyWeth();
    }
}
