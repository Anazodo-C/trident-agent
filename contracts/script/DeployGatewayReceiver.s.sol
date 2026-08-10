// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/TridentGatewayReceiver.sol";

/**
 * @notice Deploys the receiver factory for one chain.
 *
 * @dev One factory per destination chain. Circle's GatewayWallet is at the same
 *      address everywhere (a deterministic minimal proxy), but USDC is not, so
 *      the token has to be passed in rather than hardcoded.
 *
 *      The factory address is what the backend needs: every user's receiver is
 *      derived from it, so it must be recorded per chain and never redeployed.
 *      Redeploying moves every counterfactual address, and any USDC already in
 *      flight to an old one would land at a contract the new factory cannot
 *      sweep — recoverable only via `rescue()` from the old receiver.
 *
 *      Usage:
 *        USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
 *        forge script script/DeployGatewayReceiver.s.sol \
 *          --rpc-url $RPC --broadcast
 */
contract DeployGatewayReceiver is Script {
    /// Circle's GatewayWallet. Same address on every supported chain.
    address constant GATEWAY_WALLET = 0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE;

    function run() external {
        address usdc = vm.envAddress("USDC");
        require(usdc != address(0), "USDC not set");
        require(GATEWAY_WALLET.code.length > 0, "no GatewayWallet on this chain");
        require(usdc.code.length > 0, "USDC address has no code on this chain");

        vm.startBroadcast();
        TridentGatewayReceiverFactory factory =
            new TridentGatewayReceiverFactory(IERC20(usdc), IGatewayWallet(GATEWAY_WALLET));
        vm.stopBroadcast();

        console.log("chainId          ", block.chainid);
        console.log("usdc             ", usdc);
        console.log("gatewayWallet    ", GATEWAY_WALLET);
        console.log("receiverFactory  ", address(factory));
    }
}
