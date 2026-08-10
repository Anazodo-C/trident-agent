// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

/// @notice The part of Circle's TokenMessengerV2 this contract calls.
/// @dev Signature verified against the deployed implementation on Base
///      (proxy 0x28b5a0e9…cf5d → impl 0x555e2725…3ec8), whose runtime contains
///      selector 0x779b432d. Circle's published address list gave a different
///      contract that carries neither CCTP selector, so this was taken from the
///      chain rather than the documentation.
interface ITokenMessengerV2 {
    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external;

    /// @dev The hookless form. Selector 0x8e0250ee, present in the same
    ///      implementation as its withHook sibling.
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external;
}

/**
 * @title TridentCctpRouter
 * @notice Burns USDC on this chain so Circle mints it on the chain a seller
 *         actually wants paying on.
 *
 * @dev The source half of cross-chain settlement. Its counterpart is
 *      {TridentGatewayReceiver}, which catches the mint on the far side and
 *      credits the user's Gateway ledger.
 *
 * Why a contract at all, when an EOA can call TokenMessengerV2 directly: to make
 * it one transaction. USDC must be approved before it can be burned, and asking
 * a user to sign approve-then-burn doubles the gas and leaves a live allowance
 * behind if the second half fails. `bridgeWithPermit` collapses both into a
 * single call using USDC's EIP-2612 permit, and the allowance it creates is
 * consumed in the same transaction.
 *
 * Chain-agnostic by construction. Nothing about a chain is compiled in: the
 * token and the messenger are constructor arguments, and the destination is a
 * CCTP domain passed per call. The same bytecode is deployed everywhere, and a
 * chain Circle adds needs a deployment rather than a new contract.
 *
 * `hookData` is a parameter and not a constant on purpose. Circle's relayer
 * recognises a specific magic-byte prefix to mean "fetch the attestation and
 * submit the destination mint", and that encoding is not published in any
 * package shipped to us. Guessing it would burn funds that no relayer then
 * moves — recoverable only by submitting the mint by hand on a chain the user
 * has no gas on. The caller supplies exactly what Circle's own tooling
 * produces, so this contract never has to be right about a format it cannot
 * verify.
 *
 * Safety: there is no owner and no privileged caller, and every path moves only
 * `msg.sender`'s own USDC. The contract holds no balance between calls — anything
 * pulled in is burned in the same transaction — so there is nothing here to
 * take.
 */
contract TridentCctpRouter {
    using SafeERC20 for IERC20;

    /// @notice USDC on this chain.
    IERC20 public immutable token;

    /// @notice Circle's TokenMessengerV2 on this chain.
    ITokenMessengerV2 public immutable messenger;

    /// @notice Emitted once the burn is accepted by CCTP.
    /// @param sender The account whose USDC was burned.
    /// @param destinationDomain CCTP domain of the destination chain.
    /// @param mintRecipient Where the mint lands — the user's receiver contract.
    /// @param amount Burned, before CCTP's relay fee is deducted on arrival.
    event BridgeInitiated(
        address indexed sender,
        uint32 indexed destinationDomain,
        bytes32 mintRecipient,
        uint256 amount,
        uint256 maxFee
    );

    error ZeroAddress();
    error ZeroAmount();
    error ZeroRecipient();
    error FeeExceedsAmount();

    constructor(IERC20 _token, ITokenMessengerV2 _messenger) {
        if (address(_token) == address(0) || address(_messenger) == address(0)) {
            revert ZeroAddress();
        }
        token = _token;
        messenger = _messenger;
    }

    /**
     * @notice Burn `amount` of the caller's USDC for minting on another chain.
     * @dev Requires an existing allowance. Prefer {bridgeWithPermit}, which
     *      needs no separate approval.
     *
     * @param destinationDomain CCTP domain of the destination — not a chain id.
     *        Base 6, Polygon 7, Ethereum 0, Avalanche 1, Optimism 2, Arbitrum 3,
     *        Unichain 10. These match Gateway's domain numbering.
     * @param mintRecipient The destination address, left-padded to 32 bytes.
     *        In this system, the caller's {TridentGatewayReceiver} on that chain,
     *        computed off-chain from the destination factory.
     * @param amount USDC to burn, in atomic units.
     * @param maxFee The most of `amount` the caller will let CCTP take as a
     *        relay fee. The mint arrives net of it, so this is also the worst
     *        case shortfall at the destination.
     * @param minFinalityThreshold Lower values settle faster and cost more.
     * @param hookData Circle's forwarding marker. See the note on the contract.
     */
    function bridge(
        uint32 destinationDomain,
        bytes32 mintRecipient,
        uint256 amount,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) public {
        if (amount == 0) revert ZeroAmount();
        if (mintRecipient == bytes32(0)) revert ZeroRecipient();
        // A fee at or above the amount would mint nothing, or revert late and
        // opaquely inside CCTP. Fail here where the reason is legible.
        if (maxFee >= amount) revert FeeExceedsAmount();

        token.safeTransferFrom(msg.sender, address(this), amount);
        token.forceApprove(address(messenger), amount);

        // No destination caller in either branch. Anyone may submit the mint,
        // which is what lets our keeper do it and keeps the user off the hook
        // for gas on a chain they have never used.
        if (hookData.length == 0) {
            /*
             * `depositForBurnWithHook` rejects empty hook data outright — it
             * reverts with "Hook data is empty" before touching the transfer.
             * Passing "0x" was deliberate here, so the keeper could submit the
             * mint rather than Circle's forwarding relayer, and it made every
             * cross-chain settlement fail on the first call. The hookless form
             * is the correct function for that choice.
             */
            messenger.depositForBurn(
                amount,
                destinationDomain,
                mintRecipient,
                address(token),
                bytes32(0),
                maxFee,
                minFinalityThreshold
            );
        } else {
            messenger.depositForBurnWithHook(
                amount,
                destinationDomain,
                mintRecipient,
                address(token),
                bytes32(0),
                maxFee,
                minFinalityThreshold,
                hookData
            );
        }

        emit BridgeInitiated(msg.sender, destinationDomain, mintRecipient, amount, maxFee);
    }

    /**
     * @notice {bridge}, with the approval folded into the same transaction.
     * @dev USDC implements EIP-2612, so the caller signs a permit off-chain and
     *      this consumes it immediately before burning.
     *
     *      The permit is applied in a try/catch. A permit is front-runnable:
     *      anyone can submit the same signature, and if they do first, this call
     *      would revert on a replayed nonce even though the allowance it needed
     *      now exists. Swallowing that and continuing is safe because the
     *      transfer below fails anyway if the allowance is not actually there.
     */
    function bridgeWithPermit(
        uint32 destinationDomain,
        bytes32 mintRecipient,
        uint256 amount,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        try IERC20Permit(address(token)).permit(
            msg.sender, address(this), amount, deadline, v, r, s
        ) { } catch { }

        bridge(destinationDomain, mintRecipient, amount, maxFee, minFinalityThreshold, hookData);
    }
}
