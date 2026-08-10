// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/TridentCctpRouter.sol";

/**
 * @notice Deploys the CCTP burn router for one chain.
 *
 * @dev Unlike the receiver factory, this address is not load-bearing: nothing
 *      is derived from it, so it can be redeployed without stranding funds.
 *
 *      TokenMessengerV2 is the same proxy address on every chain checked so far
 *      (Base and Polygon both resolve to implementation 0x555e2725…3ec8), but it
 *      is asserted rather than assumed — Circle's published address list names a
 *      different contract that carries no CCTP selector at all.
 *
 *      Usage:
 *        USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
 *        forge script script/DeployCctpRouter.s.sol --rpc-url $RPC --broadcast
 */
contract DeployCctpRouter is Script {
    /// Circle's TokenMessengerV2 proxy. Verified on-chain, not from the docs.
    address constant TOKEN_MESSENGER_V2 = 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d;

    function run() external {
        address usdc = vm.envAddress("USDC");
        require(usdc != address(0), "USDC not set");
        require(usdc.code.length > 0, "USDC address has no code on this chain");
        require(TOKEN_MESSENGER_V2.code.length > 0, "no TokenMessengerV2 on this chain");

        vm.startBroadcast();
        TridentCctpRouter router =
            new TridentCctpRouter(IERC20(usdc), ITokenMessengerV2(TOKEN_MESSENGER_V2));
        vm.stopBroadcast();

        console.log("chainId          ", block.chainid);
        console.log("usdc             ", usdc);
        console.log("tokenMessengerV2 ", TOKEN_MESSENGER_V2);
        console.log("cctpRouter       ", address(router));
    }
}
