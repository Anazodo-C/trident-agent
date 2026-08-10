// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice The part of Circle's GatewayWallet this contract needs.
/// @dev `depositFor` pulls with `transferFrom`, so the caller must approve
///      first. Verified against the live contract on Base: calling it without
///      an allowance reverts with "ERC20: transfer amount exceeds allowance",
///      and it carries no access control — anyone may credit anyone.
interface IGatewayWallet {
    function depositFor(address token, address depositor, uint256 value) external;
}

/**
 * @title TridentGatewayReceiver
 * @notice Lands cross-chain USDC in a user's Gateway balance without anyone
 *         having to custody it.
 *
 * @dev Why this exists.
 *
 * An x402 payment settled through Circle Gateway is a TransferWithAuthorization
 * signed against the GatewayWallet contract on the chain the invoice names. It
 * carries no source domain, so it can only draw the depositor's balance on that
 * one chain. A wallet funded on Base therefore cannot pay a Polygon invoice,
 * however much it holds — observed as SETTLEMENT_FAILED / insufficient_balance.
 *
 * Moving the money is the easy half: CCTP mints on the destination and Circle's
 * relayer submits that transaction, so it costs the user no gas. The hard half
 * is the last inch. Minted USDC arrives as a plain ERC-20 balance, and crediting
 * the Gateway ledger needs an on-chain call from someone holding native gas on a
 * chain the user has never touched.
 *
 * The obvious fix — route it through an address the operator controls — turns a
 * self-custody product into a custodial one for the duration. This contract is
 * the alternative. One instance per user, at an address derived from that user,
 * with the beneficiary fixed at construction:
 *
 *   - `sweep()` is permissionless, so anyone (Trident, a keeper, the user) can
 *     pay the gas, and takes no destination argument. It can only ever credit
 *     `depositor`.
 *   - `rescue()` returns funds to `depositor` and nowhere else, so a fault in
 *     Gateway cannot strand them here.
 *
 * There is no owner, no upgrade path, no admin, and no function that can send
 * USDC anywhere except `depositor`'s Gateway ledger or `depositor` itself.
 * Whoever pays the gas gains nothing by it.
 *
 * Funds may arrive before this contract is deployed — an ERC-20 transfer to a
 * counterfactual address is just a balance — so the factory deploys on demand
 * at sweep time.
 */
contract TridentGatewayReceiver {
    using SafeERC20 for IERC20;

    /// @notice The token this receiver forwards. USDC on this chain.
    IERC20 public immutable token;

    /// @notice Circle's GatewayWallet on this chain.
    IGatewayWallet public immutable gateway;

    /// @notice The only account this contract can ever credit or refund.
    address public immutable depositor;

    event Swept(address indexed depositor, uint256 amount);
    event Rescued(address indexed depositor, uint256 amount);

    error NothingToSweep();
    error NotDepositor();
    error ZeroAddress();

    constructor(IERC20 _token, IGatewayWallet _gateway, address _depositor) {
        if (
            address(_token) == address(0) || address(_gateway) == address(0)
                || _depositor == address(0)
        ) {
            revert ZeroAddress();
        }
        token = _token;
        gateway = _gateway;
        depositor = _depositor;
    }

    /**
     * @notice Move everything held here into `depositor`'s Gateway balance.
     * @dev Deliberately callable by anyone. The destination is immutable, so an
     *      unrelated caller can only pay gas on the user's behalf — which is the
     *      point, since the user has no native token on this chain.
     *
     *      The whole balance is swept rather than a caller-supplied amount: the
     *      arriving amount is net of CCTP's relay fee and is not known ahead of
     *      time, and a partial sweep would leave a remainder needing a second
     *      transaction.
     *
     *      `forceApprove` rather than `approve` because the allowance may be
     *      non-zero if a previous `depositFor` reverted after approving.
     * @return amount The USDC credited, in atomic units.
     */
    function sweep() external returns (uint256 amount) {
        amount = token.balanceOf(address(this));
        if (amount == 0) revert NothingToSweep();

        token.forceApprove(address(gateway), amount);
        gateway.depositFor(address(token), depositor, amount);

        emit Swept(depositor, amount);
    }

    /**
     * @notice Send everything held here back to `depositor`'s own wallet.
     * @dev An escape hatch for the case where Gateway will not accept the
     *      deposit, so a fault upstream cannot leave funds unreachable.
     *
     *      Restricted to `depositor`, unlike `sweep()`. Not because sending to
     *      the user could steal anything, but because a third party could
     *      otherwise repeatedly divert arrivals to the wallet and stop payments
     *      from ever settling.
     * @return amount The USDC returned, in atomic units.
     */
    function rescue() external returns (uint256 amount) {
        if (msg.sender != depositor) revert NotDepositor();

        amount = token.balanceOf(address(this));
        if (amount == 0) revert NothingToSweep();

        token.safeTransfer(depositor, amount);
        emit Rescued(depositor, amount);
    }
}

/**
 * @title TridentGatewayReceiverFactory
 * @notice Deterministic addresses for {TridentGatewayReceiver}, so a cross-chain
 *         transfer can be aimed at a user's receiver before it exists.
 *
 * @dev The address is a pure function of this factory, the token, the gateway
 *      and the user, which is what makes the flow work: the destination is
 *      computed off-chain, CCTP mints to it, and the contract is deployed later
 *      at sweep time. Nothing is deployed for a user who never needs one.
 *
 *      One receiver per user, rather than one shared contract, is a safety
 *      property and not an optimisation. A shared receiver holding arrivals for
 *      several users would need to be told which user a given balance belonged
 *      to, and getting that wrong — or being lied to — would credit one user's
 *      funds to another. Separating them by address makes the question
 *      unanswerable-by-construction.
 */
contract TridentGatewayReceiverFactory {
    /// @notice USDC on this chain.
    IERC20 public immutable token;

    /// @notice Circle's GatewayWallet on this chain.
    IGatewayWallet public immutable gateway;

    event ReceiverDeployed(address indexed depositor, address receiver);

    error ZeroAddress();

    constructor(IERC20 _token, IGatewayWallet _gateway) {
        if (address(_token) == address(0) || address(_gateway) == address(0)) revert ZeroAddress();
        token = _token;
        gateway = _gateway;
    }

    /// @notice The receiver address for `depositor`, deployed or not.
    function receiverOf(address depositor) public view returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xff),
                            address(this),
                            _salt(depositor),
                            keccak256(_initCode(depositor))
                        )
                    )
                )
            )
        );
    }

    /// @notice True once `depositor`'s receiver has code at its address.
    function isDeployed(address depositor) public view returns (bool) {
        return receiverOf(depositor).code.length > 0;
    }

    /**
     * @notice Deploy `depositor`'s receiver if it does not exist yet.
     * @dev Idempotent, so callers never have to check first and two keepers
     *      racing cannot revert each other.
     */
    function deploy(address depositor) public returns (TridentGatewayReceiver) {
        address predicted = receiverOf(depositor);
        if (predicted.code.length > 0) return TridentGatewayReceiver(predicted);

        TridentGatewayReceiver receiver =
            new TridentGatewayReceiver{ salt: _salt(depositor) }(token, gateway, depositor);

        emit ReceiverDeployed(depositor, address(receiver));
        return receiver;
    }

    /**
     * @notice Deploy if needed, then sweep, in one transaction.
     * @dev The call a keeper makes. Deployment and sweep are separate concerns
     *      but never separately useful.
     */
    function sweep(address depositor) external returns (uint256) {
        return deploy(depositor).sweep();
    }

    function _salt(address depositor) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(depositor)));
    }

    function _initCode(address depositor) internal view returns (bytes memory) {
        return abi.encodePacked(
            type(TridentGatewayReceiver).creationCode, abi.encode(token, gateway, depositor)
        );
    }
}
