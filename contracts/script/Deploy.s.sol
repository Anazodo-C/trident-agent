// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/TridentToken.sol";
import "../src/TridentFaucet.sol";
import "../src/AgentRegistry.sol";
import "../src/TridentEscrow.sol";
import "../src/ReputationBond.sol";

contract DeployTrident is Script {
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("=== TRIDENT PROTOCOL DEPLOYMENT ===");
        console.log("Deployer:", deployer);
        console.log("Chain ID:", block.chainid);

        vm.startBroadcast(deployerPrivateKey);

        TridentToken tridToken = new TridentToken(deployer);
        console.log("TridentToken:", address(tridToken));

        TridentFaucet faucet = new TridentFaucet(deployer, address(tridToken), ARC_USDC);
        console.log("TridentFaucet:", address(faucet));

        tridToken.addMinter(address(faucet));

        AgentRegistry registry = new AgentRegistry(deployer);
        console.log("AgentRegistry:", address(registry));

        TridentEscrow escrow = new TridentEscrow(
            deployer, address(tridToken), address(registry), deployer
        );
        console.log("TridentEscrow:", address(escrow));

        ReputationBond bond = new ReputationBond(deployer, address(tridToken), address(registry));
        console.log("ReputationBond:", address(bond));

        registry.addSlasher(address(escrow));
        registry.addSlasher(address(bond));
        bond.setEscrow(address(escrow));

        vm.stopBroadcast();

        console.log("\n=== COPY THESE TO .env ===");
        console.log("TRIDENT_TOKEN_ADDRESS=", address(tridToken));
        console.log("TRIDENT_FAUCET_ADDRESS=", address(faucet));
        console.log("AGENT_REGISTRY_ADDRESS=", address(registry));
        console.log("TRIDENT_ESCROW_ADDRESS=", address(escrow));
        console.log("REPUTATION_BOND_ADDRESS=", address(bond));
    }
}
