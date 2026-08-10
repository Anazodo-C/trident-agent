// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/TridentGatewayReceiver.sol";

/// @dev Minimal USDC stand-in. 6 decimals, and — like USDC — reverts on a
///      `transferFrom` beyond the allowance, which is the behaviour the
///      receiver's approve step exists to satisfy.
contract MockUSDC {
    string public name = "USD Coin";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 v) external {
        balanceOf[to] += v;
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        return true;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        require(balanceOf[msg.sender] >= v, "ERC20: transfer amount exceeds balance");
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }

    function transferFrom(address f, address t, uint256 v) external returns (bool) {
        require(allowance[f][msg.sender] >= v, "ERC20: transfer amount exceeds allowance");
        require(balanceOf[f] >= v, "ERC20: transfer amount exceeds balance");
        allowance[f][msg.sender] -= v;
        balanceOf[f] -= v;
        balanceOf[t] += v;
        return true;
    }
}

/// @dev Stands in for Circle's GatewayWallet: pulls with `transferFrom` and
///      keeps a per-depositor ledger, which is the pair of behaviours the real
///      contract was observed to have.
contract MockGatewayWallet is IGatewayWallet {
    mapping(address => uint256) public ledger;
    bool public failing;

    function setFailing(bool v) external {
        failing = v;
    }

    function depositFor(address token, address depositor, uint256 value) external override {
        require(!failing, "gateway down");
        MockUSDC(token).transferFrom(msg.sender, address(this), value);
        ledger[depositor] += value;
    }
}

contract TridentGatewayReceiverTest is Test {
    MockUSDC usdc;
    MockGatewayWallet gateway;
    TridentGatewayReceiverFactory factory;

    address user = address(0xA11CE);
    address keeper = address(0xBEEF);
    address stranger = address(0xBAD);

    function setUp() public {
        usdc = new MockUSDC();
        gateway = new MockGatewayWallet();
        factory = new TridentGatewayReceiverFactory(IERC20(address(usdc)), gateway);
    }

    /* ------------------------------------------------ the flow it exists for */

    /// Funds arrive before any contract exists, which is the whole point of a
    /// counterfactual address — CCTP mints to it while it is still empty code.
    function test_sweepsFundsThatArrivedBeforeDeployment() public {
        address predicted = factory.receiverOf(user);
        assertEq(predicted.code.length, 0, "should not exist yet");

        usdc.mint(predicted, 30_000);

        vm.prank(keeper);
        uint256 swept = factory.sweep(user);

        assertEq(swept, 30_000);
        assertEq(gateway.ledger(user), 30_000, "credited to the user");
        assertEq(usdc.balanceOf(predicted), 0, "receiver drained");
    }

    /// A keeper pays the gas and receives nothing for it.
    function test_keeperGainsNothing() public {
        address predicted = factory.receiverOf(user);
        usdc.mint(predicted, 10_000);

        vm.prank(keeper);
        factory.sweep(user);

        assertEq(gateway.ledger(keeper), 0, "keeper credited nothing");
        assertEq(usdc.balanceOf(keeper), 0, "keeper holds nothing");
        assertEq(gateway.ledger(user), 10_000);
    }

    /// The address must be predictable off-chain, or the transfer cannot be aimed.
    function test_addressIsDeterministicAndPerUser() public {
        address a = factory.receiverOf(user);
        address b = factory.receiverOf(stranger);
        assertTrue(a != b, "distinct users, distinct receivers");
        assertEq(a, factory.receiverOf(user), "stable across calls");

        usdc.mint(a, 1);
        factory.sweep(user);
        assertEq(address(factory.deploy(user)), a, "deployed where predicted");
    }

    /* ---------------------------------------------------- safety properties */

    /// The core claim: there is no way to send one user's funds to another.
    function test_cannotRedirectAnotherUsersFunds() public {
        address victim = factory.receiverOf(user);
        usdc.mint(victim, 50_000);

        // The attacker can call sweep for the victim — and it credits the victim.
        vm.prank(stranger);
        factory.sweep(user);

        assertEq(gateway.ledger(user), 50_000);
        assertEq(gateway.ledger(stranger), 0);
    }

    /// Sweeping a different user does not touch this user's receiver.
    function test_sweepingAnotherUserLeavesThisBalanceAlone() public {
        address mine = factory.receiverOf(user);
        usdc.mint(mine, 7_000);

        vm.prank(stranger);
        vm.expectRevert(TridentGatewayReceiver.NothingToSweep.selector);
        factory.sweep(stranger);

        assertEq(usdc.balanceOf(mine), 7_000, "untouched");
    }

    /// Only the user can pull funds back out to a wallet.
    function test_rescueIsRestrictedToTheDepositor() public {
        TridentGatewayReceiver receiver = factory.deploy(user);
        usdc.mint(address(receiver), 20_000);

        vm.prank(stranger);
        vm.expectRevert(TridentGatewayReceiver.NotDepositor.selector);
        receiver.rescue();

        vm.prank(user);
        uint256 out = receiver.rescue();

        assertEq(out, 20_000);
        assertEq(usdc.balanceOf(user), 20_000, "returned to the user, nobody else");
    }

    /// A fault in Gateway must not strand funds here permanently.
    function test_fundsRecoverableWhenGatewayRejects() public {
        TridentGatewayReceiver receiver = factory.deploy(user);
        usdc.mint(address(receiver), 15_000);

        gateway.setFailing(true);
        vm.prank(keeper);
        vm.expectRevert("gateway down");
        receiver.sweep();

        assertEq(usdc.balanceOf(address(receiver)), 15_000, "still here, not lost");

        // Either retry once Gateway recovers...
        gateway.setFailing(false);
        vm.prank(keeper);
        receiver.sweep();
        assertEq(gateway.ledger(user), 15_000);
    }

    /// A stale allowance from a reverted attempt must not block the retry.
    function test_retryAfterFailedDepositSucceeds() public {
        TridentGatewayReceiver receiver = factory.deploy(user);
        usdc.mint(address(receiver), 5_000);

        gateway.setFailing(true);
        vm.expectRevert("gateway down");
        receiver.sweep();

        // More arrives in the meantime, so the second sweep is a larger amount
        // than the allowance left behind by the first.
        usdc.mint(address(receiver), 5_000);
        gateway.setFailing(false);

        uint256 swept = receiver.sweep();
        assertEq(swept, 10_000, "sweeps the full balance, not the stale amount");
        assertEq(gateway.ledger(user), 10_000);
    }

    /* ------------------------------------------------------------- edges */

    function test_sweepWithNothingArrivedReverts() public {
        vm.expectRevert(TridentGatewayReceiver.NothingToSweep.selector);
        factory.sweep(user);
    }

    /// Two keepers racing must not revert each other.
    function test_deployIsIdempotent() public {
        address first = address(factory.deploy(user));
        address second = address(factory.deploy(user));
        assertEq(first, second);
        assertTrue(factory.isDeployed(user));
    }

    /// Arrivals after a sweep are handled by sweeping again — the flow repeats
    /// for every payment, not just the first.
    function test_receiverIsReusable() public {
        address predicted = factory.receiverOf(user);

        usdc.mint(predicted, 3_000);
        factory.sweep(user);

        usdc.mint(predicted, 4_000);
        factory.sweep(user);

        assertEq(gateway.ledger(user), 7_000);
    }

    function test_beneficiaryIsFixedAtConstruction() public {
        TridentGatewayReceiver receiver = factory.deploy(user);
        assertEq(receiver.depositor(), user);
        assertEq(address(receiver.token()), address(usdc));
        assertEq(address(receiver.gateway()), address(gateway));
    }

    function testFuzz_anyCallerCreditsOnlyTheNamedUser(address caller, uint96 amount) public {
        vm.assume(caller != address(0) && amount > 0);
        address predicted = factory.receiverOf(user);
        usdc.mint(predicted, amount);

        vm.prank(caller);
        factory.sweep(user);

        assertEq(gateway.ledger(user), amount);
        if (caller != user) assertEq(gateway.ledger(caller), 0);
    }
}
